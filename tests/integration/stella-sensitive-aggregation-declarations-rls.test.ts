// tests/integration/stella-sensitive-aggregation-declarations-rls.test.ts
//
// Etapa A2.3.1 (STL-A231-019, DR-002/DR-003). Verifica contra el stack local
// de Supabase que stella_sensitive_aggregation_declarations:
//   - aísla organizaciones en SELECT (fila completa, sin split por campo —
//     ver la nota de la política 011),
//   - `authenticated` NO puede INSERT/UPDATE/DELETE directamente (privilegio
//     de tabla, no solo RLS — igual patrón que 0045/0046 desde su creación),
//   - las escrituras legítimas (Drizzle sobre DATABASE_URL, rol postgres)
//     siguen funcionando,
//   - el índice único parcial impide una segunda declaración ACTIVA para la
//     misma entidad+categoría, pero permite una nueva tras revocar/superar
//     la anterior.
//
// El cliente de service role (adminClient) sólo crea usuarios de auth y
// siembra filas de negocio vía Drizzle — nunca simula al usuario
// autenticado. Todas las aserciones de RLS usan authClient (signInWithPassword,
// clave anónima real).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { db } from '@/db/client'
import { organizations, organizationMembers, projects, stellaSensitiveAggregationDeclarations } from '@/db/schema'
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
  const email = `test-ssad-rls-${role}-${randomUUID()}@test.local`
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
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, TEST_AUTH_OPTIONS)
  const { error: signInError } = await authClient.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError

  return { id: userData.user.id, client: authClient, email }
}

describe('RLS + privileges: stella_sensitive_aggregation_declarations (Etapa A2.3.1)', () => {
  let adminClient: SupabaseClient
  let orgAId: string
  let orgBId: string
  let projectAId: string
  let declarationId: string

  let memberA: { id: string; client: SupabaseClient }
  let memberB: { id: string; client: SupabaseClient }
  let noOrgUser: { id: string; client: SupabaseClient }

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_AUTH_OPTIONS)

    orgAId = randomUUID()
    orgBId = randomUUID()
    await db.insert(organizations).values([
      { id: orgAId, name: 'SSAD RLS Org A', slug: `ssad-rls-org-a-${Date.now()}` },
      { id: orgBId, name: 'SSAD RLS Org B', slug: `ssad-rls-org-b-${Date.now()}` },
    ])

    memberA = await createTestUser(adminClient, 'organization_admin', orgAId)
    memberB = await createTestUser(adminClient, 'organization_admin', orgBId)
    noOrgUser = await createTestUser(adminClient, 'none', null)

    projectAId = randomUUID()
    await db.insert(projects).values({
      id: projectAId,
      organizationId: orgAId,
      name: 'SSAD RLS Test Project',
      status: 'draft',
      createdBy: memberA.id,
    })

    const [inserted] = await db
      .insert(stellaSensitiveAggregationDeclarations)
      .values({
        organizationId: orgAId,
        projectId: projectAId,
        entityType: 'outcome',
        entityId: randomUUID(),
        sensitiveCategory: 'minors',
        aggregationLevel: 'aggregate',
        groupSize: 50,
        groupSizeBucket: '50_249',
        dimensions: [],
        countSourceType: 'indicator_measurement',
        verificationStatus: 'pending',
        declaredBy: memberA.id,
        policyVersion: 'v1',
      })
      .returning({ id: stellaSensitiveAggregationDeclarations.id })
    declarationId = inserted.id
  })

  afterAll(async () => {
    if (declarationId) {
      await db.delete(stellaSensitiveAggregationDeclarations).where(eq(stellaSensitiveAggregationDeclarations.projectId, projectAId))
    }
    if (projectAId) {
      await db.delete(projects).where(eq(projects.id, projectAId))
    }

    const usersToClean = [memberA, memberB, noOrgUser]
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
    it('un miembro de Org A puede leer la declaración de su propia organización', async () => {
      const { data, error } = await memberA.client.from('stella_sensitive_aggregation_declarations').select('*').eq('id', declarationId)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].id).toBe(declarationId)
    })

    it('un miembro de Org B NO puede leer la declaración de Org A', async () => {
      const { data, error } = await memberB.client.from('stella_sensitive_aggregation_declarations').select('*').eq('id', declarationId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })

    it('un usuario sin membresía no puede leer ninguna declaración', async () => {
      const { data, error } = await noOrgUser.client.from('stella_sensitive_aggregation_declarations').select('*').eq('id', declarationId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })
  })

  describe('INSERT / UPDATE / DELETE — denegados a authenticated', () => {
    it('un miembro de Org A no logra insertar directamente vía PostgREST', async () => {
      const { data, error } = await memberA.client
        .from('stella_sensitive_aggregation_declarations')
        .insert({
          organization_id: orgAId,
          project_id: projectAId,
          entity_type: 'outcome',
          entity_id: randomUUID(),
          sensitive_category: 'minors',
          aggregation_level: 'aggregate',
          group_size: 50,
          group_size_bucket: '50_249',
          count_source_type: 'indicator_measurement',
          verification_status: 'pending',
          declared_by: memberA.id,
          policy_version: 'v1',
        })
        .select()
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
      expect(data).toBeNull()
    })

    it('un miembro de Org A no logra actualizar la declaración (p. ej. auto-verificarse) vía PostgREST', async () => {
      const { data, error } = await memberA.client
        .from('stella_sensitive_aggregation_declarations')
        .update({ verification_status: 'verified', verified_by: memberA.id })
        .eq('id', declarationId)
        .select()
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
      expect(data).toBeNull()

      const [row] = await db
        .select({ status: stellaSensitiveAggregationDeclarations.verificationStatus })
        .from(stellaSensitiveAggregationDeclarations)
        .where(eq(stellaSensitiveAggregationDeclarations.id, declarationId))
      expect(row.status).toBe('pending')
    })

    it('un miembro de Org A no logra borrar la declaración vía PostgREST', async () => {
      const { data, error } = await memberA.client.from('stella_sensitive_aggregation_declarations').delete().eq('id', declarationId).select()
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
      expect(data).toBeNull()

      const rows = await db
        .select({ id: stellaSensitiveAggregationDeclarations.id })
        .from(stellaSensitiveAggregationDeclarations)
        .where(eq(stellaSensitiveAggregationDeclarations.id, declarationId))
      expect(rows).toHaveLength(1)
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
          has_table_privilege('authenticated', 'public.stella_sensitive_aggregation_declarations', 'SELECT') as can_select,
          has_table_privilege('authenticated', 'public.stella_sensitive_aggregation_declarations', 'INSERT') as can_insert,
          has_table_privilege('authenticated', 'public.stella_sensitive_aggregation_declarations', 'UPDATE') as can_update,
          has_table_privilege('authenticated', 'public.stella_sensitive_aggregation_declarations', 'DELETE') as can_delete
      `)
      expect(row.can_select).toBe(true)
      expect(row.can_insert).toBe(false)
      expect(row.can_update).toBe(false)
      expect(row.can_delete).toBe(false)
    })

    it('anon has no privileges at all', async () => {
      const [row] = await db.execute<{ can_select: boolean; can_insert: boolean }>(sql`
        SELECT
          has_table_privilege('anon', 'public.stella_sensitive_aggregation_declarations', 'SELECT') as can_select,
          has_table_privilege('anon', 'public.stella_sensitive_aggregation_declarations', 'INSERT') as can_insert
      `)
      expect(row.can_select).toBe(false)
      expect(row.can_insert).toBe(false)
    })

    it('service_role and postgres retain full privileges (needed for the server write path)', async () => {
      for (const role of ['service_role', 'postgres']) {
        const [row] = await db.execute<{
          can_select: boolean
          can_insert: boolean
          can_update: boolean
          can_delete: boolean
        }>(sql`
          SELECT
            has_table_privilege(${role}, 'public.stella_sensitive_aggregation_declarations', 'SELECT') as can_select,
            has_table_privilege(${role}, 'public.stella_sensitive_aggregation_declarations', 'INSERT') as can_insert,
            has_table_privilege(${role}, 'public.stella_sensitive_aggregation_declarations', 'UPDATE') as can_update,
            has_table_privilege(${role}, 'public.stella_sensitive_aggregation_declarations', 'DELETE') as can_delete
        `)
        expect(row.can_select).toBe(true)
        expect(row.can_insert).toBe(true)
        expect(row.can_update).toBe(true)
        expect(row.can_delete).toBe(true)
      }
    })
  })

  describe('Índice único parcial — a lo sumo una declaración activa por entidad+categoría', () => {
    it('rechaza una segunda declaración pendiente para la MISMA entidad+categoría', async () => {
      await expect(
        db.insert(stellaSensitiveAggregationDeclarations).values({
          organizationId: orgAId,
          projectId: projectAId,
          entityType: 'outcome',
          // Reuses the same entityId as the seeded declaration on purpose —
          // fetch it first.
          entityId: (
            await db
              .select({ entityId: stellaSensitiveAggregationDeclarations.entityId })
              .from(stellaSensitiveAggregationDeclarations)
              .where(eq(stellaSensitiveAggregationDeclarations.id, declarationId))
          )[0].entityId,
          sensitiveCategory: 'minors',
          aggregationLevel: 'aggregate',
          groupSize: 20,
          groupSizeBucket: '10_49',
          dimensions: [],
          countSourceType: 'indicator_measurement',
          verificationStatus: 'pending',
          declaredBy: memberA.id,
          policyVersion: 'v1',
        }),
      ).rejects.toThrow()
    })

    it('permite una nueva declaración para la misma entidad+categoría una vez que la anterior fue revocada', async () => {
      const [row] = await db
        .select({ entityId: stellaSensitiveAggregationDeclarations.entityId })
        .from(stellaSensitiveAggregationDeclarations)
        .where(eq(stellaSensitiveAggregationDeclarations.id, declarationId))

      await db
        .update(stellaSensitiveAggregationDeclarations)
        .set({ verificationStatus: 'revoked', revokedBy: memberA.id, revokedAt: new Date() })
        .where(eq(stellaSensitiveAggregationDeclarations.id, declarationId))

      const [newDeclaration] = await db
        .insert(stellaSensitiveAggregationDeclarations)
        .values({
          organizationId: orgAId,
          projectId: projectAId,
          entityType: 'outcome',
          entityId: row.entityId,
          sensitiveCategory: 'minors',
          aggregationLevel: 'aggregate',
          groupSize: 30,
          groupSizeBucket: '10_49',
          dimensions: [],
          countSourceType: 'indicator_measurement',
          verificationStatus: 'pending',
          declaredBy: memberA.id,
          policyVersion: 'v1',
        })
        .returning({ id: stellaSensitiveAggregationDeclarations.id })

      expect(newDeclaration.id).toBeTruthy()
      await db.delete(stellaSensitiveAggregationDeclarations).where(eq(stellaSensitiveAggregationDeclarations.id, newDeclaration.id))
    })
  })
})
