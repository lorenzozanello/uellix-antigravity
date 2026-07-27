// tests/integration/stella-ai-consent-rls.test.ts
//
// Etapa A2.1 (STL-A21-009/012, DR-005 aprobado 2026-07-25). Verifica contra
// el stack local de Supabase que stella_ai_consent_events aisla
// organizaciones y es, desde su creación (migración 0045), un rastro
// append-only con privilegios mínimos para `authenticated`:
//   - un miembro de Org A lee los eventos de su organización,
//   - un miembro de Org B no los lee,
//   - un usuario sin membresía no lee ninguno,
//   - super_admin conserva el acceso que la política ya otorga (SELECT),
//   - `authenticated` NO tiene INSERT/UPDATE/DELETE a nivel de GRANT desde
//     el inicio (verificado con has_table_privilege, no solo por RLS —
//     a diferencia de stella_interactions, que necesitó una migración de
//     endurecimiento posterior, esta tabla nace ya restringida),
//   - la inserción legítima del servidor (Drizzle sobre DATABASE_URL, rol
//     postgres) sigue funcionando.
//
// El cliente de service role (adminClient) sólo se usa para crear los
// usuarios de auth y sembrar filas de negocio vía Drizzle — nunca para
// simular al usuario autenticado. Todas las aserciones de RLS se hacen con
// authClient, obtenido con signInWithPassword usando la clave anónima real.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { db } from '@/db/client'
import { organizations, organizationMembers, stellaAiConsentEvents } from '@/db/schema'
import { eq, inArray, sql } from 'drizzle-orm'
import { deleteOrganizationsWithoutAuditTrail } from './cleanup'
import { randomUUID } from 'crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:55321'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test'
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'test'
const TEST_AUTH_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

async function createTestUser(adminClient: SupabaseClient, role: string, orgId: string | null) {
  const email = `test-consent-rls-${role}-${randomUUID()}@test.local`
  const password = 'test-password-123'

  const { data: userData, error: userError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Test ${role}` },
  })
  if (userError) throw userError

  await new Promise((resolve) => setTimeout(resolve, 500))

  if (orgId) {
    await db.insert(organizationMembers).values({
      organizationId: orgId,
      userId: userData.user.id,
      role: role as 'super_admin' | 'organization_admin' | 'impact_manager' | 'analyst' | 'reviewer' | 'viewer',
      status: 'active',
    })
  } else if (role === 'super_admin') {
    await db.execute(`UPDATE public.users SET is_super_admin = true WHERE id = '${userData.user.id}'`)
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, TEST_AUTH_OPTIONS)
  const { error: signInError } = await authClient.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError

  return { id: userData.user.id, client: authClient, email }
}

describe('RLS + privileges: stella_ai_consent_events (Etapa A2.1, STL-A21-009)', () => {
  let adminClient: SupabaseClient
  let orgAId: string
  let orgBId: string
  let eventId: string

  let memberA: { id: string; client: SupabaseClient }
  let memberB: { id: string; client: SupabaseClient }
  let noOrgUser: { id: string; client: SupabaseClient }
  let superAdmin: { id: string; client: SupabaseClient }

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_AUTH_OPTIONS)

    orgAId = randomUUID()
    orgBId = randomUUID()
    await db.insert(organizations).values([
      { id: orgAId, name: 'Consent RLS Org A', slug: `consent-rls-org-a-${Date.now()}` },
      { id: orgBId, name: 'Consent RLS Org B', slug: `consent-rls-org-b-${Date.now()}` },
    ])

    memberA = await createTestUser(adminClient, 'organization_admin', orgAId)
    memberB = await createTestUser(adminClient, 'organization_admin', orgBId)
    noOrgUser = await createTestUser(adminClient, 'none', null)
    superAdmin = await createTestUser(adminClient, 'super_admin', null)

    // Sembrado vía Drizzle (DATABASE_URL, bypassa RLS por ser el rol
    // `postgres`) — equivalente a como recordConsentEvent() inserta hoy.
    const [inserted] = await db
      .insert(stellaAiConsentEvents)
      .values({
        organizationId: orgAId,
        eventType: 'accepted',
        aiTermsVersion: 'v1',
        dataPolicyVersion: 'v1',
        capabilityScope: ['all'],
        actorUserId: memberA.id,
      })
      .returning({ id: stellaAiConsentEvents.id })
    eventId = inserted.id
  })

  afterAll(async () => {
    if (eventId) {
      await db.delete(stellaAiConsentEvents).where(eq(stellaAiConsentEvents.id, eventId))
    }

    const usersToClean = [memberA, memberB, noOrgUser, superAdmin]
    for (const u of usersToClean) {
      if (u?.id) await adminClient.auth.admin.deleteUser(u.id)
    }

    const orgIds = [orgAId, orgBId].filter(Boolean)
    if (orgIds.length > 0) {
      await db.delete(organizationMembers).where(inArray(organizationMembers.organizationId, orgIds))
      await deleteOrganizationsWithoutAuditTrail(orgIds)
    }
  })

  describe('SELECT — aislamiento por organización', () => {
    it('un miembro de Org A puede leer el evento de su propia organización', async () => {
      const { data, error } = await memberA.client.from('stella_ai_consent_events').select('*').eq('id', eventId)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].id).toBe(eventId)
    })

    it('un miembro de Org B NO puede leer el evento de Org A', async () => {
      const { data, error } = await memberB.client.from('stella_ai_consent_events').select('*').eq('id', eventId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })

    it('un usuario sin membresía no puede leer ningún evento', async () => {
      const { data, error } = await noOrgUser.client.from('stella_ai_consent_events').select('*').eq('id', eventId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })

    it('super_admin conserva el acceso de lectura que la política ya otorga', async () => {
      const { data, error } = await superAdmin.client.from('stella_ai_consent_events').select('*').eq('id', eventId)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].id).toBe(eventId)
    })
  })

  describe('UPDATE / DELETE — denegados (garantía append-only desde el inicio)', () => {
    it('un miembro de Org A no logra modificar el evento vía UPDATE', async () => {
      const { data, error } = await memberA.client
        .from('stella_ai_consent_events')
        .update({ reason: 'tampered' })
        .eq('id', eventId)
        .select()

      // A diferencia de stella_interactions antes de la migración 0043, aquí
      // el GRANT de tabla nunca existió para authenticated: PostgreSQL
      // deniega el privilegio directamente (42501), no solo RLS.
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
      expect(data).toBeNull()

      const [row] = await db
        .select({ reason: stellaAiConsentEvents.reason })
        .from(stellaAiConsentEvents)
        .where(eq(stellaAiConsentEvents.id, eventId))
      expect(row.reason).toBeNull()
    })

    it('un miembro de Org A no logra borrar el evento vía DELETE', async () => {
      const { data, error } = await memberA.client.from('stella_ai_consent_events').delete().eq('id', eventId).select()

      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
      expect(data).toBeNull()

      const rows = await db
        .select({ id: stellaAiConsentEvents.id })
        .from(stellaAiConsentEvents)
        .where(eq(stellaAiConsentEvents.id, eventId))
      expect(rows).toHaveLength(1)
    })

    it('un miembro de Org A no logra insertar directamente vía PostgREST', async () => {
      const { data, error } = await memberA.client
        .from('stella_ai_consent_events')
        .insert({
          organization_id: orgAId,
          event_type: 'accepted',
          ai_terms_version: 'v1',
          data_policy_version: 'v1',
          capability_scope: ['all'],
          actor_user_id: memberA.id,
        })
        .select()

      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
      expect(data).toBeNull()
    })
  })

  describe('Privilegios efectivos (has_table_privilege)', () => {
    it('authenticated tiene SELECT pero no INSERT/UPDATE/DELETE, desde la creación de la tabla', async () => {
      const [row] = await db.execute<{
        can_select: boolean
        can_insert: boolean
        can_update: boolean
        can_delete: boolean
      }>(sql`
        SELECT
          has_table_privilege('authenticated', 'public.stella_ai_consent_events', 'SELECT') as can_select,
          has_table_privilege('authenticated', 'public.stella_ai_consent_events', 'INSERT') as can_insert,
          has_table_privilege('authenticated', 'public.stella_ai_consent_events', 'UPDATE') as can_update,
          has_table_privilege('authenticated', 'public.stella_ai_consent_events', 'DELETE') as can_delete
      `)
      expect(row.can_select).toBe(true)
      expect(row.can_insert).toBe(false)
      expect(row.can_update).toBe(false)
      expect(row.can_delete).toBe(false)
    })

    it('anon has no privileges at all', async () => {
      const [row] = await db.execute<{ can_select: boolean; can_insert: boolean }>(sql`
        SELECT
          has_table_privilege('anon', 'public.stella_ai_consent_events', 'SELECT') as can_select,
          has_table_privilege('anon', 'public.stella_ai_consent_events', 'INSERT') as can_insert
      `)
      expect(row.can_select).toBe(false)
      expect(row.can_insert).toBe(false)
    })

    it('service_role and postgres retain full privileges (needed for the server insert path)', async () => {
      for (const role of ['service_role', 'postgres']) {
        const [row] = await db.execute<{
          can_select: boolean
          can_insert: boolean
          can_update: boolean
          can_delete: boolean
        }>(sql`
          SELECT
            has_table_privilege(${role}, 'public.stella_ai_consent_events', 'SELECT') as can_select,
            has_table_privilege(${role}, 'public.stella_ai_consent_events', 'INSERT') as can_insert,
            has_table_privilege(${role}, 'public.stella_ai_consent_events', 'UPDATE') as can_update,
            has_table_privilege(${role}, 'public.stella_ai_consent_events', 'DELETE') as can_delete
        `)
        expect(row.can_select).toBe(true)
        expect(row.can_insert).toBe(true)
        expect(row.can_update).toBe(true)
        expect(row.can_delete).toBe(true)
      }
    })
  })

  describe('Inserción legítima del servidor', () => {
    it('recordConsentEvent (Drizzle sobre DATABASE_URL) sigue funcionando tras el endurecimiento de privilegios', async () => {
      const [inserted] = await db
        .insert(stellaAiConsentEvents)
        .values({
          organizationId: orgAId,
          eventType: 'revoked',
          actorUserId: memberA.id,
          reason: 'server-side test insert',
          supersedesEventId: eventId,
        })
        .returning({ id: stellaAiConsentEvents.id })

      expect(inserted.id).toBeTruthy()

      // Verificado: el estado vigente ahora resuelve a "revoked" (el evento
      // mas reciente por organizacion).
      const { data, error } = await memberA.client
        .from('stella_ai_consent_events')
        .select('*')
        .eq('organization_id', orgAId)
        .order('occurred_at', { ascending: false })
        .limit(1)
      expect(error).toBeNull()
      expect(data![0].event_type).toBe('revoked')

      await db.delete(stellaAiConsentEvents).where(eq(stellaAiConsentEvents.id, inserted.id))
    })
  })
})
