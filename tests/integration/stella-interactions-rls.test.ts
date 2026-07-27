// tests/integration/stella-interactions-rls.test.ts
//
// Etapa A1 (STL-A1-001) + Etapa A1.5 (STL-A15-007). Verifica contra el stack
// local de Supabase que stella_interactions es realmente un rastro de
// auditoría append-only:
//   - una organización no puede leer las interacciones de otra,
//   - un usuario sin membresía no puede leer ninguna,
//   - UPDATE es denegado,
//   - DELETE es denegado,
//   - super_admin SIN membresía explícita en la organización ya NO tiene
//     acceso general (actualizado en Etapa A2.2, STL-A22-004, DR-007
//     aprobado 2026-07-26 — ver tests/integration/stella-interactions-access-rls.test.ts
//     para la matriz de acceso completa por rol),
//   - authenticated ya NO tiene INSERT/UPDATE/DELETE a nivel de GRANT (STL-A15-006,
//     migración 0043) — se verifica con has_table_privilege, no solo por RLS,
//   - la inserción legítima del servidor (Drizzle sobre DATABASE_URL, rol
//     postgres) sigue funcionando tras la migración de privilegios.
//
// Nota de comportamiento (Etapa A1.5): antes de la migración 0043, un intento
// de UPDATE/DELETE como `authenticated` devolvía `error: null, data: []`
// (RLS filtraba la fila sin error, porque el GRANT de tabla aún lo permitía
// a nivel de PostgreSQL). Tras 0043, el GRANT en sí ya no existe, así que
// PostgreSQL deniega el privilegio ANTES de evaluar RLS y devuelve un error
// `42501 permission denied` explícito — una garantía más fuerte, verificada
// abajo. Esto es exactamente la defensa en profundidad que esta etapa añade:
// dos capas independientes (ausencia de GRANT + ausencia de política RLS)
// en vez de una sola.
//
// El cliente de service role (adminClient) sólo se usa para crear los
// usuarios de auth y sembrar filas de negocio vía Drizzle — nunca para
// simular al usuario autenticado. Todas las aserciones de RLS se hacen con
// authClient, obtenido con signInWithPassword usando la clave anónima real,
// exactamente como en tests/integration/rls.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { db } from '@/db/client'
import { organizations, organizationMembers, projects, stellaInteractions } from '@/db/schema'
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
  const email = `test-stella-rls-${role}-${randomUUID()}@test.local`
  const password = 'test-password-123'

  const { data: userData, error: userError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Test ${role}` },
  })
  if (userError) throw userError

  // Espera a que el trigger sincronice public.users.
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

describe('RLS: stella_interactions (Etapa A1, STL-A1-001)', () => {
  let adminClient: SupabaseClient
  let orgAId: string
  let orgBId: string
  let projectAId: string
  let interactionId: string

  let memberA: { id: string; client: SupabaseClient }
  let memberB: { id: string; client: SupabaseClient }
  let noOrgUser: { id: string; client: SupabaseClient }
  let superAdmin: { id: string; client: SupabaseClient }

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_AUTH_OPTIONS)

    orgAId = randomUUID()
    orgBId = randomUUID()
    await db.insert(organizations).values([
      { id: orgAId, name: 'Stella RLS Org A', slug: `stella-rls-org-a-${Date.now()}` },
      { id: orgBId, name: 'Stella RLS Org B', slug: `stella-rls-org-b-${Date.now()}` },
    ])

    memberA = await createTestUser(adminClient, 'organization_admin', orgAId)
    memberB = await createTestUser(adminClient, 'organization_admin', orgBId)
    noOrgUser = await createTestUser(adminClient, 'none', null)
    superAdmin = await createTestUser(adminClient, 'super_admin', null)

    projectAId = randomUUID()
    await db.insert(projects).values({
      id: projectAId,
      organizationId: orgAId,
      name: 'Stella RLS Test Project',
      status: 'draft',
      createdBy: memberA.id,
    })

    // Sembrado vía Drizzle (DATABASE_URL, bypassa RLS por ser el rol
    // `postgres`) — equivalente a como recordStellaInteraction() inserta hoy.
    const [inserted] = await db
      .insert(stellaInteractions)
      .values({
        organizationId: orgAId,
        projectId: projectAId,
        createdBy: memberA.id,
        stellaRole: 'advisor',
        pipelineStep: 'narrative',
        contextHash: 'a'.repeat(64),
        responseJson: { summary: 'test interaction' },
        modelUsed: 'gemini-2.5-flash',
      })
      .returning({ id: stellaInteractions.id })
    interactionId = inserted.id
  })

  afterAll(async () => {
    // Orden inverso a las FKs: la fila de stella_interactions referencia
    // projects y organizations, así que debe borrarse antes que ambos —
    // de lo contrario deleteOrganizationsWithoutAuditTrail fallaría por FK.
    if (interactionId) {
      await db.delete(stellaInteractions).where(eq(stellaInteractions.id, interactionId))
    }

    const usersToClean = [memberA, memberB, noOrgUser, superAdmin]
    for (const u of usersToClean) {
      if (u?.id) await adminClient.auth.admin.deleteUser(u.id)
    }

    const orgIds = [orgAId, orgBId].filter(Boolean)
    if (orgIds.length > 0) {
      await db.delete(projects).where(inArray(projects.organizationId, orgIds))
      await db.delete(organizationMembers).where(inArray(organizationMembers.organizationId, orgIds))
      await deleteOrganizationsWithoutAuditTrail(orgIds)
    }
  })

  describe('SELECT — aislamiento por organización', () => {
    it('un miembro de Org A puede leer la interacción de su propia organización', async () => {
      const { data, error } = await memberA.client.from('stella_interactions').select('*').eq('id', interactionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].id).toBe(interactionId)
    })

    it('un miembro de Org B NO puede leer la interacción de Org A', async () => {
      const { data, error } = await memberB.client.from('stella_interactions').select('*').eq('id', interactionId)
      expect(error).toBeNull() // RLS filtra sin error, igual que en projects/organizations
      expect(data).toHaveLength(0)
    })

    it('un usuario sin membresía no puede leer ninguna interacción', async () => {
      const { data, error } = await noOrgUser.client.from('stella_interactions').select('*').eq('id', interactionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })

    // Actualizado (Etapa A2.2, DR-007 aprobado 2026-07-26): el propietario
    // aprobó eliminar el bypass general de super_admin sobre
    // stella_interactions (política SELECT reemplazada por
    // db/policies/010_stella_interactions_access_control_rls.sql). Este
    // `superAdmin` de prueba se crea sin ninguna membresía de organización
    // (createTestUser(..., 'super_admin', null)) — exactamente el caso
    // "super_admin ordinario sin membresía explícita" que la decisión
    // aprobada exige denegar. La cobertura completa de la nueva matriz de
    // acceso (creador, analyst, organization_admin, viewer, super_admin con
    // membresía explícita) vive en
    // tests/integration/stella-interactions-access-rls.test.ts.
    it('super_admin SIN membresía explícita ya NO tiene acceso general (DR-007)', async () => {
      const { data, error } = await superAdmin.client.from('stella_interactions').select('*').eq('id', interactionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })
  })

  describe('UPDATE — denegado (garantía append-only, Etapa A1.5: por GRANT, no solo por RLS)', () => {
    it('un miembro de Org A no logra modificar ninguna fila vía UPDATE (permission denied)', async () => {
      const { data, error } = await memberA.client
        .from('stella_interactions')
        .update({ pipeline_step: 'tampered' })
        .eq('id', interactionId)
        .select()

      // Post-migración 0043: authenticated ya no tiene el privilegio UPDATE a
      // nivel de GRANT, así que PostgreSQL deniega antes de evaluar RLS.
      expect(error).not.toBeNull()
      expect(error?.code).toBe('42501')
      expect(data).toBeNull()

      const [row] = await db
        .select({ pipelineStep: stellaInteractions.pipelineStep })
        .from(stellaInteractions)
        .where(eq(stellaInteractions.id, interactionId))
      expect(row.pipelineStep).toBe('narrative')
    })
  })

  describe('DELETE — denegado (garantía append-only, Etapa A1.5: por GRANT, no solo por RLS)', () => {
    it('un miembro de Org A no logra borrar la fila vía DELETE (permission denied)', async () => {
      const { data, error } = await memberA.client
        .from('stella_interactions')
        .delete()
        .eq('id', interactionId)
        .select()

      expect(error).not.toBeNull()
      expect(error?.code).toBe('42501')
      expect(data).toBeNull()

      const rows = await db
        .select({ id: stellaInteractions.id })
        .from(stellaInteractions)
        .where(eq(stellaInteractions.id, interactionId))
      expect(rows).toHaveLength(1)
    })
  })

  describe('Privilegios efectivos (Etapa A1.5, STL-A15-006/007)', () => {
    it('authenticated ya no tiene INSERT/UPDATE/DELETE, y conserva SELECT', async () => {
      const [row] = await db.execute<{
        can_select: boolean
        can_insert: boolean
        can_update: boolean
        can_delete: boolean
      }>(sql`
        SELECT
          has_table_privilege('authenticated', 'public.stella_interactions', 'SELECT') as can_select,
          has_table_privilege('authenticated', 'public.stella_interactions', 'INSERT') as can_insert,
          has_table_privilege('authenticated', 'public.stella_interactions', 'UPDATE') as can_update,
          has_table_privilege('authenticated', 'public.stella_interactions', 'DELETE') as can_delete
      `)
      expect(row.can_select).toBe(true)
      expect(row.can_insert).toBe(false)
      expect(row.can_update).toBe(false)
      expect(row.can_delete).toBe(false)
    })

    it('anon has no privileges at all (unchanged, pre-existing from 0033)', async () => {
      const [row] = await db.execute<{ can_select: boolean; can_insert: boolean }>(sql`
        SELECT
          has_table_privilege('anon', 'public.stella_interactions', 'SELECT') as can_select,
          has_table_privilege('anon', 'public.stella_interactions', 'INSERT') as can_insert
      `)
      expect(row.can_select).toBe(false)
      expect(row.can_insert).toBe(false)
    })

    it('service_role and postgres retain full privileges (unchanged — needed for admin/superuser paths)', async () => {
      for (const role of ['service_role', 'postgres']) {
        const [row] = await db.execute<{
          can_select: boolean
          can_insert: boolean
          can_update: boolean
          can_delete: boolean
        }>(sql`
          SELECT
            has_table_privilege(${role}, 'public.stella_interactions', 'SELECT') as can_select,
            has_table_privilege(${role}, 'public.stella_interactions', 'INSERT') as can_insert,
            has_table_privilege(${role}, 'public.stella_interactions', 'UPDATE') as can_update,
            has_table_privilege(${role}, 'public.stella_interactions', 'DELETE') as can_delete
        `)
        expect(row.can_select).toBe(true)
        expect(row.can_insert).toBe(true)
        expect(row.can_update).toBe(true)
        expect(row.can_delete).toBe(true)
      }
    })
  })

  describe('Inserción legítima del servidor (Etapa A1.5): sigue funcionando tras la migración', () => {
    it('un insert vía Drizzle (mismo mecanismo que recordStellaInteraction) sigue funcionando', async () => {
      const [inserted] = await db
        .insert(stellaInteractions)
        .values({
          organizationId: orgAId,
          projectId: projectAId,
          createdBy: memberA.id,
          stellaRole: 'validator',
          pipelineStep: 'Calculation',
          contextHash: 'b'.repeat(64),
          responseJson: { summary: 'post-migration insert check' },
          modelUsed: 'gemini-2.5-flash',
        })
        .returning({ id: stellaInteractions.id })

      expect(inserted.id).toBeDefined()

      const [row] = await db
        .select({ id: stellaInteractions.id })
        .from(stellaInteractions)
        .where(eq(stellaInteractions.id, inserted.id))
      expect(row).toBeDefined()

      // Limpieza inmediata: esta fila es solo para probar el mecanismo de
      // inserción, no forma parte de las aserciones de lectura/RLS de arriba.
      await db.delete(stellaInteractions).where(eq(stellaInteractions.id, inserted.id))
    })
  })
})
