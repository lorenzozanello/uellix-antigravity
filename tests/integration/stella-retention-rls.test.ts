// tests/integration/stella-retention-rls.test.ts
// Etapa A2.4 (DR-004 aprobado) — RLS + privilegios para las 3 tablas nuevas
// (stella_retention_settings/holds/purge_runs), mismo patrón que
// stella-sensitive-aggregation-declarations-rls.test.ts: `authenticated`
// tiene SELECT (aislado por organización) pero nunca INSERT/UPDATE/DELETE;
// las escrituras legítimas pasan por lib/stella/retention/*.ts vía Drizzle
// sobre DATABASE_URL (rol postgres, bypasea RLS).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { db } from '@/db/client'
import { organizations, organizationMembers, stellaRetentionSettings } from '@/db/schema'
import { eq, inArray, sql } from 'drizzle-orm'
import { deleteOrganizationsWithoutAuditTrail } from './cleanup'
import { randomUUID } from 'crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:55321'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test'
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'test'
const TEST_AUTH_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

async function createTestUser(adminClient: SupabaseClient, role: string, orgId: string | null) {
  const email = `test-retention-rls-${role}-${randomUUID()}@test.local`
  const password = 'test-password-123'
  const { data: userData, error: userError } = await adminClient.auth.admin.createUser({ email, password, email_confirm: true })
  if (userError) throw userError
  await new Promise((resolve) => setTimeout(resolve, 500))
  if (orgId) {
    await db.insert(organizationMembers).values({ organizationId: orgId, userId: userData.user.id, role: role as never, status: 'active' })
  }
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, TEST_AUTH_OPTIONS)
  const { error: signInError } = await authClient.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError
  return { id: userData.user.id, client: authClient }
}

describe('RLS + privileges: Stella retention tables (Etapa A2.4)', () => {
  let adminClient: SupabaseClient
  let orgAId: string
  let orgBId: string
  let settingsId: string
  let memberA: { id: string; client: SupabaseClient }
  let memberB: { id: string; client: SupabaseClient }

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_AUTH_OPTIONS)
    orgAId = randomUUID()
    orgBId = randomUUID()
    await db.insert(organizations).values([
      { id: orgAId, name: 'Retention RLS Org A', slug: `retention-rls-org-a-${Date.now()}` },
      { id: orgBId, name: 'Retention RLS Org B', slug: `retention-rls-org-b-${Date.now()}` },
    ])
    memberA = await createTestUser(adminClient, 'organization_admin', orgAId)
    memberB = await createTestUser(adminClient, 'organization_admin', orgBId)

    const [inserted] = await db
      .insert(stellaRetentionSettings)
      .values({ organizationId: orgAId, responseRetentionMonths: 12, policyVersion: 'v1', configuredBy: memberA.id })
      .returning({ id: stellaRetentionSettings.id })
    settingsId = inserted.id
  })

  afterAll(async () => {
    if (settingsId) await db.delete(stellaRetentionSettings).where(eq(stellaRetentionSettings.id, settingsId))
    for (const u of [memberA, memberB]) if (u?.id) await adminClient.auth.admin.deleteUser(u.id)
    const orgIds = [orgAId, orgBId].filter(Boolean)
    if (orgIds.length > 0) {
      await db.delete(organizationMembers).where(inArray(organizationMembers.organizationId, orgIds))
      await deleteOrganizationsWithoutAuditTrail(orgIds)
    }
  })

  describe('SELECT — aislamiento por organización (stella_retention_settings, representativa de las 3 tablas)', () => {
    it('un miembro de Org A lee la configuración de su propia organización', async () => {
      const { data, error } = await memberA.client.from('stella_retention_settings').select('*').eq('id', settingsId)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
    })

    it('un miembro de Org B NO lee la configuración de Org A', async () => {
      const { data, error } = await memberB.client.from('stella_retention_settings').select('*').eq('id', settingsId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })
  })

  describe('INSERT/UPDATE/DELETE — denegados a authenticated', () => {
    it('un miembro de Org A no logra insertar directamente vía PostgREST', async () => {
      const { data, error } = await memberA.client
        .from('stella_retention_settings')
        .insert({ organization_id: orgAId, response_retention_months: 1, policy_version: 'v1', configured_by: memberA.id })
        .select()
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
      expect(data).toBeNull()
    })

    it('un miembro de Org A no logra actualizar su propia configuración vía PostgREST', async () => {
      const { data, error } = await memberA.client.from('stella_retention_settings').update({ response_retention_months: 1 }).eq('id', settingsId).select()
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
      expect(data).toBeNull()

      const [row] = await db.select({ months: stellaRetentionSettings.responseRetentionMonths }).from(stellaRetentionSettings).where(eq(stellaRetentionSettings.id, settingsId))
      expect(row.months).toBe(12) // untouched
    })

    it('un miembro de Org A no logra borrar vía PostgREST', async () => {
      const { data, error } = await memberA.client.from('stella_retention_settings').delete().eq('id', settingsId).select()
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
      expect(data).toBeNull()
    })
  })

  describe('Privilegios efectivos (has_table_privilege) — las 3 tablas', () => {
    it('authenticated tiene SELECT pero no INSERT/UPDATE/DELETE en ninguna de las 3', async () => {
      for (const table of ['stella_retention_settings', 'stella_retention_holds', 'stella_retention_purge_runs']) {
        const [row] = await db.execute<{ can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }>(sql`
          SELECT
            has_table_privilege('authenticated', ${'public.' + table}, 'SELECT') as can_select,
            has_table_privilege('authenticated', ${'public.' + table}, 'INSERT') as can_insert,
            has_table_privilege('authenticated', ${'public.' + table}, 'UPDATE') as can_update,
            has_table_privilege('authenticated', ${'public.' + table}, 'DELETE') as can_delete
        `)
        expect(row.can_select, `${table}.SELECT`).toBe(true)
        expect(row.can_insert, `${table}.INSERT`).toBe(false)
        expect(row.can_update, `${table}.UPDATE`).toBe(false)
        expect(row.can_delete, `${table}.DELETE`).toBe(false)
      }
    })

    it('anon has no privileges on any of the 3 tables', async () => {
      for (const table of ['stella_retention_settings', 'stella_retention_holds', 'stella_retention_purge_runs']) {
        const [row] = await db.execute<{ can_select: boolean }>(sql`
          SELECT has_table_privilege('anon', ${'public.' + table}, 'SELECT') as can_select
        `)
        expect(row.can_select, `${table} anon SELECT`).toBe(false)
      }
    })

    it('service_role and postgres retain full privileges on all 3 tables', async () => {
      for (const table of ['stella_retention_settings', 'stella_retention_holds', 'stella_retention_purge_runs']) {
        for (const role of ['service_role', 'postgres']) {
          const [row] = await db.execute<{ can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }>(sql`
            SELECT
              has_table_privilege(${role}, ${'public.' + table}, 'SELECT') as can_select,
              has_table_privilege(${role}, ${'public.' + table}, 'INSERT') as can_insert,
              has_table_privilege(${role}, ${'public.' + table}, 'UPDATE') as can_update,
              has_table_privilege(${role}, ${'public.' + table}, 'DELETE') as can_delete
          `)
          expect(row.can_select, `${table}.${role}.SELECT`).toBe(true)
          expect(row.can_insert, `${table}.${role}.INSERT`).toBe(true)
          expect(row.can_update, `${table}.${role}.UPDATE`).toBe(true)
          expect(row.can_delete, `${table}.${role}.DELETE`).toBe(true)
        }
      }
    })
  })

  describe('RLS habilitado en las 3 tablas', () => {
    it('relrowsecurity es true para las 3', async () => {
      const rows = await db.execute<{ relname: string; relrowsecurity: boolean }>(sql`
        select relname, relrowsecurity from pg_class
        where relname in ('stella_retention_settings', 'stella_retention_holds', 'stella_retention_purge_runs')
      `)
      const byName = new Map((rows as unknown as { relname: string; relrowsecurity: boolean }[]).map((r) => [r.relname, r.relrowsecurity]))
      expect(byName.get('stella_retention_settings')).toBe(true)
      expect(byName.get('stella_retention_holds')).toBe(true)
      expect(byName.get('stella_retention_purge_runs')).toBe(true)
    })
  })
})
