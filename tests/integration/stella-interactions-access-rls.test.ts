// tests/integration/stella-interactions-access-rls.test.ts
//
// Etapa A2.2 (STL-A22-015, DR-007 aprobado 2026-07-26). Verifica contra el
// stack local de Supabase la matriz de acceso completa aprobada por el
// propietario para stella_interactions, aplicada por
// db/policies/010_stella_interactions_access_control_rls.sql:
//   1.  el creador autorizado lee su propia interacción,
//   2.  un miembro no autorizado (viewer no-creador) no la lee,
//   3.  viewer no ve el historial general de la organización,
//   4.  analyst ve su alcance real (= toda la organización, sin ACL por proyecto),
//   5.  organization_admin ve toda su organización,
//   6.  un admin de otra organización no ve nada,
//   7.  un usuario sin membresía no ve nada,
//   8.  una membresía que pasa a inactiva pierde el acceso,
//   9.  super_admin SIN membresía explícita no obtiene acceso general,
//   10. authenticated mantiene únicamente SELECT (sin cambio respecto a 0043),
//   11-13. INSERT/UPDATE/DELETE directos siguen denegados,
//   14. el mecanismo servidor autorizado (Drizzle) sigue insertando,
//   15. los listados (sin filtro por ID) no devuelven filas fuera del alcance,
//   16. una consulta por ID cross-org no distingue "no existe" de "no autorizado".
//
// El cliente de service role (adminClient) solo se usa para crear usuarios
// de auth y sembrar filas de negocio vía Drizzle — nunca para simular al
// usuario autenticado. Todas las aserciones de acceso se hacen con
// authClient, obtenido con signInWithPassword usando la clave anónima real.

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
  const email = `test-stella-access-${role}-${randomUUID()}@test.local`
  const password = 'test-password-123'

  const { data: userData, error: userError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Test ${role}` },
  })
  if (userError) throw userError

  await new Promise((resolve) => setTimeout(resolve, 500))

  let membershipId: string | null = null
  if (orgId) {
    const [inserted] = await db
      .insert(organizationMembers)
      .values({
        organizationId: orgId,
        userId: userData.user.id,
        role: role as 'super_admin' | 'organization_admin' | 'impact_manager' | 'analyst' | 'reviewer' | 'viewer',
        status: 'active',
      })
      .returning({ id: organizationMembers.id })
    membershipId = inserted.id
  } else if (role === 'super_admin') {
    await db.execute(`UPDATE public.users SET is_super_admin = true WHERE id = '${userData.user.id}'`)
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, TEST_AUTH_OPTIONS)
  const { error: signInError } = await authClient.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError

  return { id: userData.user.id, client: authClient, email, membershipId }
}

describe('Matriz de acceso: stella_interactions (Etapa A2.2, STL-A22-015)', () => {
  let adminClient: SupabaseClient
  let orgAId: string
  let orgBId: string
  let projectAId: string
  let creatorInteractionId: string
  let otherInteractionId: string

  let creatorViewer: { id: string; client: SupabaseClient; membershipId: string | null }
  let viewerNonCreator: { id: string; client: SupabaseClient; membershipId: string | null }
  let reviewerA: { id: string; client: SupabaseClient; membershipId: string | null }
  let analystA: { id: string; client: SupabaseClient; membershipId: string | null }
  let impactManagerA: { id: string; client: SupabaseClient; membershipId: string | null }
  let orgAdminA: { id: string; client: SupabaseClient; membershipId: string | null }
  let orgAdminB: { id: string; client: SupabaseClient; membershipId: string | null }
  let noOrgUser: { id: string; client: SupabaseClient; membershipId: string | null }
  let superAdminNoMembership: { id: string; client: SupabaseClient; membershipId: string | null }
  let toBeDeactivatedAdmin: { id: string; client: SupabaseClient; membershipId: string | null }

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_AUTH_OPTIONS)

    orgAId = randomUUID()
    orgBId = randomUUID()
    await db.insert(organizations).values([
      { id: orgAId, name: 'Access RLS Org A', slug: `access-rls-org-a-${Date.now()}` },
      { id: orgBId, name: 'Access RLS Org B', slug: `access-rls-org-b-${Date.now()}` },
    ])

    creatorViewer = await createTestUser(adminClient, 'viewer', orgAId)
    viewerNonCreator = await createTestUser(adminClient, 'viewer', orgAId)
    reviewerA = await createTestUser(adminClient, 'reviewer', orgAId)
    analystA = await createTestUser(adminClient, 'analyst', orgAId)
    impactManagerA = await createTestUser(adminClient, 'impact_manager', orgAId)
    orgAdminA = await createTestUser(adminClient, 'organization_admin', orgAId)
    orgAdminB = await createTestUser(adminClient, 'organization_admin', orgBId)
    noOrgUser = await createTestUser(adminClient, 'none', null)
    superAdminNoMembership = await createTestUser(adminClient, 'super_admin', null)
    toBeDeactivatedAdmin = await createTestUser(adminClient, 'organization_admin', orgAId)

    projectAId = randomUUID()
    await db.insert(projects).values({
      id: projectAId,
      organizationId: orgAId,
      name: 'Access RLS Test Project',
      status: 'draft',
      createdBy: orgAdminA.id,
    })

    // Interacción #1: creada por un `viewer` (creatorViewer). Prueba el
    // caso "viewer creador" y sirve de fila que otros roles sí/no deben ver.
    const [inserted1] = await db
      .insert(stellaInteractions)
      .values({
        organizationId: orgAId,
        projectId: projectAId,
        createdBy: creatorViewer.id,
        stellaRole: 'advisor',
        pipelineStep: 'narrative',
        contextHash: 'a'.repeat(64),
        responseJson: { summary: 'interaction by viewer creator' },
        modelUsed: 'gemini-2.5-flash',
      })
      .returning({ id: stellaInteractions.id })
    creatorInteractionId = inserted1.id

    // Interacción #2: creada por orgAdminA — para probar "listados no
    // devuelven filas prohibidas" con más de una fila en juego.
    const [inserted2] = await db
      .insert(stellaInteractions)
      .values({
        organizationId: orgAId,
        projectId: projectAId,
        createdBy: orgAdminA.id,
        stellaRole: 'validator',
        pipelineStep: 'calculation',
        contextHash: 'b'.repeat(64),
        responseJson: { summary: 'interaction by org admin' },
        modelUsed: 'gemini-2.5-flash',
      })
      .returning({ id: stellaInteractions.id })
    otherInteractionId = inserted2.id
  })

  afterAll(async () => {
    if (creatorInteractionId) await db.delete(stellaInteractions).where(eq(stellaInteractions.id, creatorInteractionId))
    if (otherInteractionId) await db.delete(stellaInteractions).where(eq(stellaInteractions.id, otherInteractionId))

    const usersToClean = [
      creatorViewer, viewerNonCreator, reviewerA, analystA, impactManagerA,
      orgAdminA, orgAdminB, noOrgUser, superAdminNoMembership, toBeDeactivatedAdmin,
    ]
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

  describe('1-2. Creador y no-creador', () => {
    it('1. el creador (viewer) lee su propia interacción', async () => {
      const { data, error } = await creatorViewer.client.from('stella_interactions').select('*').eq('id', creatorInteractionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].id).toBe(creatorInteractionId)
    })

    it('2. un viewer que NO es el creador no la lee', async () => {
      const { data, error } = await viewerNonCreator.client.from('stella_interactions').select('*').eq('id', creatorInteractionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })
  })

  describe('3. Viewer sin historial general', () => {
    it('un viewer no ve la interacción creada por otro (org admin)', async () => {
      const { data, error } = await viewerNonCreator.client.from('stella_interactions').select('*').eq('id', otherInteractionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })

    it('reviewer (tratado igual que viewer) tampoco ve el historial general', async () => {
      const { data, error } = await reviewerA.client.from('stella_interactions').select('*').eq('id', otherInteractionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })
  })

  describe('4. Analyst — alcance real (org-wide, sin ACL por proyecto)', () => {
    it('analyst ve ambas interacciones de su organización', async () => {
      const { data, error } = await analystA.client.from('stella_interactions').select('*').eq('organization_id', orgAId)
      expect(error).toBeNull()
      expect(data!.map((r) => r.id).sort()).toEqual([creatorInteractionId, otherInteractionId].sort())
    })

    it('impact_manager recibe el mismo alcance que analyst', async () => {
      const { data, error } = await impactManagerA.client.from('stella_interactions').select('*').eq('organization_id', orgAId)
      expect(error).toBeNull()
      expect(data!.map((r) => r.id).sort()).toEqual([creatorInteractionId, otherInteractionId].sort())
    })
  })

  describe('5-6. Organization admin', () => {
    it('5. organization_admin ve toda su organización', async () => {
      const { data, error } = await orgAdminA.client.from('stella_interactions').select('*').eq('organization_id', orgAId)
      expect(error).toBeNull()
      expect(data!.map((r) => r.id).sort()).toEqual([creatorInteractionId, otherInteractionId].sort())
    })

    it('6. un admin de Org B no ve nada de Org A', async () => {
      const { data, error } = await orgAdminB.client.from('stella_interactions').select('*').eq('organization_id', orgAId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })
  })

  describe('7. Sin membresía', () => {
    it('un usuario sin ninguna membresía no ve nada', async () => {
      const { data, error } = await noOrgUser.client.from('stella_interactions').select('*').eq('id', creatorInteractionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })
  })

  describe('8. Membresía que pasa a inactiva', () => {
    it('un organization_admin activo ve la organización; tras desactivar su membresía, deja de ver', async () => {
      const before = await toBeDeactivatedAdmin.client.from('stella_interactions').select('*').eq('organization_id', orgAId)
      expect(before.error).toBeNull()
      expect(before.data!.length).toBe(2)

      await db
        .update(organizationMembers)
        .set({ status: 'inactive' })
        .where(eq(organizationMembers.id, toBeDeactivatedAdmin.membershipId as string))

      const after = await toBeDeactivatedAdmin.client.from('stella_interactions').select('*').eq('organization_id', orgAId)
      expect(after.error).toBeNull()
      expect(after.data).toHaveLength(0)
    })
  })

  describe('9. Super admin sin membresía explícita', () => {
    it('no obtiene acceso general por la política ordinaria', async () => {
      const { data, error } = await superAdminNoMembership.client.from('stella_interactions').select('*').eq('organization_id', orgAId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })
  })

  describe('10. Privilegios de tabla (sin cambio respecto a 0043)', () => {
    it('authenticated mantiene únicamente SELECT', async () => {
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
  })

  describe('11-13. Mutaciones directas denegadas', () => {
    it('11. INSERT directo vía PostgREST falla', async () => {
      const { data, error } = await orgAdminA.client
        .from('stella_interactions')
        .insert({
          organization_id: orgAId,
          project_id: projectAId,
          created_by: orgAdminA.id,
          stella_role: 'advisor',
          pipeline_step: 'narrative',
          context_hash: 'c'.repeat(64),
          response_json: { summary: 'attempted direct insert' },
          model_used: 'gemini-2.5-flash',
        })
        .select()
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
      expect(data).toBeNull()
    })

    it('12. UPDATE directo falla', async () => {
      const { data, error } = await orgAdminA.client
        .from('stella_interactions')
        .update({ pipeline_step: 'tampered' })
        .eq('id', creatorInteractionId)
        .select()
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
      expect(data).toBeNull()
    })

    it('13. DELETE directo falla', async () => {
      const { data, error } = await orgAdminA.client.from('stella_interactions').delete().eq('id', creatorInteractionId).select()
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
      expect(data).toBeNull()
    })
  })

  describe('14. Inserción legítima del servidor', () => {
    it('recordStellaInteraction (Drizzle sobre DATABASE_URL) sigue funcionando', async () => {
      const [inserted] = await db
        .insert(stellaInteractions)
        .values({
          organizationId: orgAId,
          projectId: projectAId,
          createdBy: orgAdminA.id,
          stellaRole: 'composer',
          pipelineStep: 'executive_summary',
          contextHash: 'd'.repeat(64),
          responseJson: { summary: 'server-side test insert' },
          modelUsed: 'gemini-2.5-flash',
        })
        .returning({ id: stellaInteractions.id })
      expect(inserted.id).toBeTruthy()
      await db.delete(stellaInteractions).where(eq(stellaInteractions.id, inserted.id))
    })
  })

  describe('15. Listados sin filas prohibidas', () => {
    it('un viewer listando "todas las interacciones visibles" solo recibe la suya, nunca la de otro usuario', async () => {
      const { data, error } = await creatorViewer.client.from('stella_interactions').select('*')
      expect(error).toBeNull()
      const ids = data!.map((r) => r.id)
      expect(ids).toContain(creatorInteractionId)
      expect(ids).not.toContain(otherInteractionId)
    })
  })

  describe('16. Consulta por ID no revela existencia cross-org', () => {
    it('un ID real de Org A y un ID inventado producen la misma respuesta vacía para un admin de Org B', async () => {
      const realId = await orgAdminB.client.from('stella_interactions').select('*').eq('id', otherInteractionId)
      const fakeId = await orgAdminB.client.from('stella_interactions').select('*').eq('id', randomUUID())

      expect(realId.error).toBeNull()
      expect(fakeId.error).toBeNull()
      expect(realId.data).toEqual([])
      expect(fakeId.data).toEqual([])
    })
  })
})
