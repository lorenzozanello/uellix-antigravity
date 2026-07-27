// tests/integration/stella-pilot-confirmations-rls.test.ts
//
// Etapa B0 (modo piloto restringido). Verifica contra el stack local de
// Supabase que stella_pilot_confirmations (migración 0048, política
// db/policies/013_stella_pilot_confirmations_rls.sql) aísla organizaciones y
// nace ya restringida a nivel de privilegios (has_table_privilege), mismo
// patrón que tests/integration/stella-ai-consent-rls.test.ts.
//
// Divergencia deliberada respecto de esa tabla: la política de
// stella_pilot_confirmations NO incluye `OR private.current_user_is_super_admin()`
// — a diferencia de 009_stella_ai_consent_rls.sql. Esto es intencional: el
// encargo de Etapa B0 prohíbe explícitamente cualquier bypass por
// super_admin dentro del piloto, incluida la lectura de confirmaciones
// operativas de organizaciones de las que ese super_admin no es miembro. Este
// archivo prueba esa divergencia explícitamente, no la asume.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { db } from '@/db/client'
import { organizations, organizationMembers, stellaPilotConfirmations } from '@/db/schema'
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
  const email = `test-pilot-confirm-rls-${role}-${randomUUID()}@test.local`
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

describe('RLS + privileges: stella_pilot_confirmations (Etapa B0)', () => {
  let adminClient: SupabaseClient
  let orgAId: string
  let orgBId: string
  let eventId: string

  let memberA: { id: string; client: SupabaseClient }
  let memberB: { id: string; client: SupabaseClient }
  let noOrgUser: { id: string; client: SupabaseClient }
  let superAdminNoMembership: { id: string; client: SupabaseClient }

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_AUTH_OPTIONS)

    orgAId = randomUUID()
    orgBId = randomUUID()
    await db.insert(organizations).values([
      { id: orgAId, name: 'Pilot Confirmation RLS Org A', slug: `pilot-confirm-rls-org-a-${Date.now()}` },
      { id: orgBId, name: 'Pilot Confirmation RLS Org B', slug: `pilot-confirm-rls-org-b-${Date.now()}` },
    ])

    memberA = await createTestUser(adminClient, 'organization_admin', orgAId)
    memberB = await createTestUser(adminClient, 'organization_admin', orgBId)
    noOrgUser = await createTestUser(adminClient, 'none', null)
    superAdminNoMembership = await createTestUser(adminClient, 'super_admin', null)

    // Sembrado vía Drizzle (DATABASE_URL, rol postgres) — equivalente a como
    // recordPilotConfirmationEvent() inserta hoy.
    const [inserted] = await db
      .insert(stellaPilotConfirmations)
      .values({
        organizationId: orgAId,
        userId: memberA.id,
        eventType: 'accepted',
        noticeVersion: 'v1',
      })
      .returning({ id: stellaPilotConfirmations.id })
    eventId = inserted.id
  })

  afterAll(async () => {
    if (eventId) {
      await db.delete(stellaPilotConfirmations).where(eq(stellaPilotConfirmations.id, eventId))
    }

    const usersToClean = [memberA, memberB, noOrgUser, superAdminNoMembership]
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
    it('un miembro de Org A puede leer el evento de confirmación de su propia organización', async () => {
      const { data, error } = await memberA.client.from('stella_pilot_confirmations').select('*').eq('id', eventId)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].id).toBe(eventId)
    })

    it('un miembro de Org B NO puede leer el evento de Org A', async () => {
      const { data, error } = await memberB.client.from('stella_pilot_confirmations').select('*').eq('id', eventId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })

    it('un usuario sin membresía no puede leer ningún evento', async () => {
      const { data, error } = await noOrgUser.client.from('stella_pilot_confirmations').select('*').eq('id', eventId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })

    it('DIVERGENCIA DELIBERADA de DR-005: super_admin SIN membresía en Org A NO puede leer su evento — el piloto no otorga bypass global al rol de plataforma', async () => {
      const { data, error } = await superAdminNoMembership.client.from('stella_pilot_confirmations').select('*').eq('id', eventId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })
  })

  describe('UPDATE / DELETE / INSERT directo — denegados (garantía append-only desde el inicio)', () => {
    it('un miembro de Org A no logra modificar el evento vía UPDATE', async () => {
      const { data, error } = await memberA.client
        .from('stella_pilot_confirmations')
        .update({ notice_version: 'tampered' })
        .eq('id', eventId)
        .select()

      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
      expect(data).toBeNull()

      const [row] = await db
        .select({ noticeVersion: stellaPilotConfirmations.noticeVersion })
        .from(stellaPilotConfirmations)
        .where(eq(stellaPilotConfirmations.id, eventId))
      expect(row.noticeVersion).toBe('v1')
    })

    it('un miembro de Org A no logra borrar el evento vía DELETE', async () => {
      const { data, error } = await memberA.client.from('stella_pilot_confirmations').delete().eq('id', eventId).select()

      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
      expect(data).toBeNull()

      const rows = await db
        .select({ id: stellaPilotConfirmations.id })
        .from(stellaPilotConfirmations)
        .where(eq(stellaPilotConfirmations.id, eventId))
      expect(rows).toHaveLength(1)
    })

    it('un miembro de Org A no logra insertar directamente vía PostgREST (incluso una confirmación propia, legítima en su forma)', async () => {
      const { data, error } = await memberA.client
        .from('stella_pilot_confirmations')
        .insert({
          organization_id: orgAId,
          user_id: memberA.id,
          event_type: 'accepted',
          notice_version: 'v1',
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
          has_table_privilege('authenticated', 'public.stella_pilot_confirmations', 'SELECT') as can_select,
          has_table_privilege('authenticated', 'public.stella_pilot_confirmations', 'INSERT') as can_insert,
          has_table_privilege('authenticated', 'public.stella_pilot_confirmations', 'UPDATE') as can_update,
          has_table_privilege('authenticated', 'public.stella_pilot_confirmations', 'DELETE') as can_delete
      `)
      expect(row.can_select).toBe(true)
      expect(row.can_insert).toBe(false)
      expect(row.can_update).toBe(false)
      expect(row.can_delete).toBe(false)
    })

    it('anon no tiene ningún privilegio', async () => {
      const [row] = await db.execute<{ can_select: boolean; can_insert: boolean }>(sql`
        SELECT
          has_table_privilege('anon', 'public.stella_pilot_confirmations', 'SELECT') as can_select,
          has_table_privilege('anon', 'public.stella_pilot_confirmations', 'INSERT') as can_insert
      `)
      expect(row.can_select).toBe(false)
      expect(row.can_insert).toBe(false)
    })

    it('service_role y postgres conservan privilegios completos (necesarios para la vía de escritura del servidor)', async () => {
      for (const role of ['service_role', 'postgres']) {
        const [row] = await db.execute<{
          can_select: boolean
          can_insert: boolean
          can_update: boolean
          can_delete: boolean
        }>(sql`
          SELECT
            has_table_privilege(${role}, 'public.stella_pilot_confirmations', 'SELECT') as can_select,
            has_table_privilege(${role}, 'public.stella_pilot_confirmations', 'INSERT') as can_insert,
            has_table_privilege(${role}, 'public.stella_pilot_confirmations', 'UPDATE') as can_update,
            has_table_privilege(${role}, 'public.stella_pilot_confirmations', 'DELETE') as can_delete
        `)
        expect(row.can_select).toBe(true)
        expect(row.can_insert).toBe(true)
        expect(row.can_update).toBe(true)
        expect(row.can_delete).toBe(true)
      }
    })
  })

  describe('Inserción legítima del servidor + resolución de estado', () => {
    it('recordPilotConfirmationEvent (Drizzle sobre DATABASE_URL) sigue funcionando tras el endurecimiento de privilegios, y el evento más reciente es visible para el miembro del org', async () => {
      const [inserted] = await db
        .insert(stellaPilotConfirmations)
        .values({
          organizationId: orgAId,
          userId: memberA.id,
          eventType: 'revoked',
          supersedesEventId: eventId,
        })
        .returning({ id: stellaPilotConfirmations.id })

      expect(inserted.id).toBeTruthy()

      const { data, error } = await memberA.client
        .from('stella_pilot_confirmations')
        .select('*')
        .eq('organization_id', orgAId)
        .eq('user_id', memberA.id)
        .order('occurred_at', { ascending: false })
        .limit(1)
      expect(error).toBeNull()
      expect(data![0].event_type).toBe('revoked')

      await db.delete(stellaPilotConfirmations).where(eq(stellaPilotConfirmations.id, inserted.id))
    })

    it('un miembro de Org A ve el evento de otro miembro de la MISMA organización (visibilidad a nivel de organización, no sólo por usuario)', async () => {
      const [otherUserEvent] = await db
        .insert(stellaPilotConfirmations)
        .values({
          organizationId: orgAId,
          userId: memberB.id, // usuario ajeno, insertado directo como fixture — no representa una membresía real de Org A
          eventType: 'accepted',
          noticeVersion: 'v1',
        })
        .returning({ id: stellaPilotConfirmations.id })

      const { data, error } = await memberA.client
        .from('stella_pilot_confirmations')
        .select('*')
        .eq('id', otherUserEvent.id)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)

      await db.delete(stellaPilotConfirmations).where(eq(stellaPilotConfirmations.id, otherUserEvent.id))
    })
  })
})
