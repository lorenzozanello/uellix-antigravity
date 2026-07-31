import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { db } from '@/db/client'
import { organizations, organizationMembers, fxRates, projects, projectInvestments, evidenceItems, sroiCalculationRuns, sroiCalculationLineItems, sroiReports, stellaInteractions } from '@/db/schema'
import { randomUUID } from 'crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:55321'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test'
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'test'
const TEST_AUTH_OPTIONS = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
}

// Helper to create and authenticate a user
async function createTestUser(adminClient: SupabaseClient, role: string, orgId: string | null) {
  const email = `test-rls-${role}-${randomUUID()}@test.local`
  const password = 'test-password-123'
  
  const { data: userData, error: userError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Test ${role}` }
  })
  
  if (userError) throw userError

  // Wait for trigger to sync
  await new Promise(resolve => setTimeout(resolve, 500))

  if (orgId) {
    await db.insert(organizationMembers).values({
      organizationId: orgId,
      userId: userData.user.id,
      role: role as 'super_admin' | 'organization_admin' | 'impact_manager' | 'analyst' | 'reviewer' | 'viewer',
      status: 'active'
    })
  } else if (role === 'super_admin') {
    await db.execute(`UPDATE public.users SET is_super_admin = true WHERE id = '${userData.user.id}'`)
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, TEST_AUTH_OPTIONS)
  const { error: signInError } = await authClient.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError
  
  return { id: userData.user.id, client: authClient, email }
}

describe('RLS Coverage Integration Tests', () => {
  let adminClient: SupabaseClient
  let orgAId: string
  let orgBId: string
  let projectAId: string
  
  // Clients for different roles
  let adminA: { id: string, client: SupabaseClient }
  let analystA: { id: string, client: SupabaseClient }
  let reviewerA: { id: string, client: SupabaseClient }
  let viewerA: { id: string, client: SupabaseClient }
  let adminB: { id: string, client: SupabaseClient }
  let noOrgUser: { id: string, client: SupabaseClient }
  let superAdmin: { id: string, client: SupabaseClient }

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_AUTH_OPTIONS)
    
    // Create Organizations
    orgAId = randomUUID()
    orgBId = randomUUID()
    await db.insert(organizations).values([
      { id: orgAId, name: 'RLS Org A', slug: `org-a-${Date.now()}` },
      { id: orgBId, name: 'RLS Org B', slug: `org-b-${Date.now()}` }
    ])

    // Create Test Project in Org A
    projectAId = randomUUID()
    
    // Create Users
    adminA = await createTestUser(adminClient, 'organization_admin', orgAId)
    analystA = await createTestUser(adminClient, 'analyst', orgAId)
    reviewerA = await createTestUser(adminClient, 'reviewer', orgAId)
    viewerA = await createTestUser(adminClient, 'viewer', orgAId)
    adminB = await createTestUser(adminClient, 'organization_admin', orgBId)
    noOrgUser = await createTestUser(adminClient, 'none', null)
    superAdmin = await createTestUser(adminClient, 'super_admin', null)

    // Set up project via admin
    await db.insert(projects).values({
      id: projectAId,
      organizationId: orgAId,
      name: 'Test Project A',
      status: 'draft',
      createdBy: adminA.id
    })
  })

  afterAll(async () => {
    // Cleanup users
    const usersToClean = [adminA, analystA, reviewerA, viewerA, adminB, noOrgUser, superAdmin]
    for (const u of usersToClean) {
      if (u?.id) await adminClient.auth.admin.deleteUser(u.id)
    }
  })

  describe('Tablas Globales (organizations)', () => {
    it('Admin A puede ver solo su organización', async () => {
      const { data, error } = await adminA.client.from('organizations').select('*')
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].id).toBe(orgAId)
    })

    it('SuperAdmin puede ver todas las organizaciones', async () => {
      const { data, error } = await superAdmin.client.from('organizations').select('*')
      expect(error).toBeNull()
      expect(data!.length).toBeGreaterThanOrEqual(2)
    })

    it('Usuario sin org no puede ver organizaciones', async () => {
      const { data, error } = await noOrgUser.client.from('organizations').select('*')
      expect(error).toBeNull() // RLS usually returns empty data instead of error for SELECT
      expect(data).toHaveLength(0)
    })
  })

  describe('Proyectos (CRUD Cruzado)', () => {
    it('Analyst A puede crear proyectos en Org A', async () => {
      const { data, error } = await analystA.client.from('projects').insert({
        id: randomUUID(),
        organization_id: orgAId,
        name: 'Nuevo Proyecto Analyst',
        status: 'draft',
        created_by: analystA.id
      }).select()
      expect(error).toBeNull()
      expect(data).toBeDefined()
    })

    it('Analyst A NO puede crear proyectos en Org B (Falla de RLS insert)', async () => {
      const { data, error } = await analystA.client.from('projects').insert({
        id: randomUUID(),
        organization_id: orgBId,
        name: 'Proyecto Infiltrado',
        status: 'draft',
        created_by: analystA.id
      })
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501') // RLS violation / permission denied
    })

    it('Viewer A NO puede crear proyectos en Org A', async () => {
      const { data, error } = await viewerA.client.from('projects').insert({
        id: randomUUID(),
        organization_id: orgAId,
        name: 'Proyecto Viewer',
        status: 'draft',
        created_by: viewerA.id
      })
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
    })
  })

  describe('Storage', () => {
    it('Analyst A puede subir archivo (INSERT) y leerlo (SELECT)', async () => {
      const fileName = `${projectAId}/evidence1/test.txt`
      const { error: uploadError } = await analystA.client.storage
        .from('uellix-evidence')
        .upload(fileName, 'Contenido de prueba', { contentType: 'text/plain', upsert: true })
      
      expect(uploadError).toBeNull()

      const { data, error: downloadError } = await analystA.client.storage
        .from('uellix-evidence')
        .download(fileName)
      
      expect(downloadError).toBeNull()
      expect(await data?.text()).toBe('Contenido de prueba')
    })

    it('Admin B NO puede leer archivo de Org A (SELECT cruzado fallido)', async () => {
      const fileName = `${projectAId}/evidence1/test.txt`
      const { data, error } = await adminB.client.storage
        .from('uellix-evidence')
        .download(fileName)
      
      expect(error).not.toBeNull()
      expect(error!.message).toContain('Object not found') // Supabase Storage returns not found for unauthorized RLS reads
    })

    it('Admin B NO puede subir archivo a proyecto de Org A (INSERT cruzado fallido)', async () => {
      const fileName = `${projectAId}/evidence2/malicious.txt`
      const { error } = await adminB.client.storage
        .from('uellix-evidence')
        .upload(fileName, 'Malicious', { contentType: 'text/plain', upsert: true })
      
      expect(error).not.toBeNull()
      expect(error!.message).toContain('row violates row-level security policy')
    })

    it('Paths inválidos son rechazados (falla en validación foldername)', async () => {
      const fileName = `random-invalid-uuid/evidence1/test.txt`
      const { error } = await analystA.client.storage
        .from('uellix-evidence')
        .upload(fileName, 'Contenido inválido', { contentType: 'text/plain' })
      
      expect(error).not.toBeNull()
      expect(error!.message).toContain('row violates row-level security policy')
    })
    
    it('Viewer A NO puede borrar evidencia (DELETE rol insuficiente)', async () => {
      const fileName = `${projectAId}/evidence1/test.txt`
      const { error } = await viewerA.client.storage
        .from('uellix-evidence')
        .remove([fileName])

      // PostgreSQL can report a successful DELETE even when RLS matched no rows.
      expect(error).toBeNull()

      const { data, error: downloadError } = await analystA.client.storage
        .from('uellix-evidence')
        .download(fileName)

      expect(downloadError).toBeNull()
      expect(await data?.text()).toBe('Contenido de prueba')
    })
  })

  // ==========================================================================
  // WS3b U5: stella_interactions — append-only AI audit trail.
  // RLS posture (db/policies/002_stella_interactions_rls.sql): SELECT for org
  // members / super_admin; NO INSERT, UPDATE or DELETE policies. Post-G2
  // (db/prepared/stella_0002_interactions_hardening.sql) the authenticated
  // role also loses the table-level UPDATE/DELETE grants (0033 bug) and the
  // uellix_forbid_mutation() trigger blocks mutation even for service role.
  // ==========================================================================
  describe('Stella Interactions (append-only)', () => {
    let interactionId: string

    beforeAll(async () => {
      // Seed via the service-role Drizzle client — the only legitimate write
      // path (mirrors the server actions in app/actions/stella/*).
      interactionId = randomUUID()
      await db.insert(stellaInteractions).values({
        id: interactionId,
        organizationId: orgAId,
        projectId: projectAId,
        createdBy: adminA.id,
        stellaRole: 'advisor',
        pipelineStep: 'narrative',
        contextHash: 'a'.repeat(64),
        responseJson: { summary: 'seed for RLS tests' },
        modelUsed: 'test-model',
      })
    })

    it('Admin A puede ver las interacciones de su organización', async () => {
      const { data, error } = await adminA.client
        .from('stella_interactions')
        .select('id, organization_id')
        .eq('id', interactionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].organization_id).toBe(orgAId)
    })

    it('Viewer A (mismo org) puede LEER interacciones — el gate de rol solo bloquea invocar', async () => {
      const { data, error } = await viewerA.client
        .from('stella_interactions')
        .select('id')
        .eq('id', interactionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
    })

    it('Admin B NO puede ver interacciones de Org A (SELECT cruzado devuelve vacío)', async () => {
      const { data, error } = await adminB.client
        .from('stella_interactions')
        .select('id')
        .eq('id', interactionId)
      expect(error).toBeNull() // RLS filters silently on SELECT
      expect(data).toHaveLength(0)
    })

    it('SuperAdmin puede ver interacciones de cualquier org', async () => {
      const { data, error } = await superAdmin.client
        .from('stella_interactions')
        .select('id')
        .eq('id', interactionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
    })

    it('INSERT como authenticated es denegado (sin política INSERT — solo service role escribe)', async () => {
      const { error } = await adminA.client.from('stella_interactions').insert({
        id: randomUUID(),
        organization_id: orgAId,
        project_id: projectAId,
        created_by: adminA.id,
        stella_role: 'advisor',
        pipeline_step: 'narrative',
        context_hash: 'b'.repeat(64),
        response_json: { summary: 'client-side insert attempt' },
      })
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
    })

    it('UPDATE como authenticated es denegado (RLS pre-G2; grant revocado + trigger post-G2)', async () => {
      const { data, error } = await adminA.client
        .from('stella_interactions')
        .update({ pipeline_step: 'tampered' })
        .eq('id', interactionId)
        .select()

      // Pre-G2: no UPDATE policy → RLS matches 0 rows (no error, empty data).
      // Post-G2 (stella_0002): the revoked table grant makes this a hard 42501.
      if (error) {
        expect(error.code).toBe('42501')
      } else {
        expect(data).toHaveLength(0)
      }

      // Either way the row is untouched (verified via service client).
      const { data: fresh } = await adminClient
        .from('stella_interactions')
        .select('pipeline_step')
        .eq('id', interactionId)
        .single()
      expect(fresh!.pipeline_step).toBe('narrative')
    })

    it('DELETE como authenticated es denegado (RLS pre-G2; grant revocado + trigger post-G2)', async () => {
      const { error } = await adminA.client
        .from('stella_interactions')
        .delete()
        .eq('id', interactionId)

      // Pre-G2: silent 0-row match; post-G2: 42501 by revoked grant.
      if (error) expect(error.code).toBe('42501')

      const { data: fresh } = await adminClient
        .from('stella_interactions')
        .select('id')
        .eq('id', interactionId)
      expect(fresh).toHaveLength(1)
    })

    // Enable after G2 applies db/prepared/stella_0002_interactions_hardening.sql:
    // the uellix_forbid_mutation() trigger must reject UPDATE/DELETE even for
    // the SERVICE ROLE (RLS-bypassing) client. Running this pre-G2 would
    // actually mutate the audit trail, so it stays skipped until the gate.
    describe.skip('post-G2 (stella_0002): trigger blocks mutation even for service role', () => {
      it('UPDATE via service role falla con insufficient_privilege', async () => {
        await expect(
          db.execute(`UPDATE public.stella_interactions SET pipeline_step = 'x' WHERE id = '${interactionId}'`),
        ).rejects.toThrow(/append-only/)
      })

      it('DELETE via service role falla con insufficient_privilege', async () => {
        await expect(
          db.execute(`DELETE FROM public.stella_interactions WHERE id = '${interactionId}'`),
        ).rejects.toThrow(/append-only/)
      })
    })
  })

  // ==========================================================================
  // WS3b U5: stella_suggestion_decisions — enable after G2 applies
  // db/prepared/stella_0003_suggestion_decisions.sql (the table does not exist
  // before that gate; running these earlier fails on a missing relation).
  // Posture: SELECT-only org-scoped RLS; INSERT/UPDATE/DELETE denied for
  // authenticated (service-role writes only, via recordStellaDecision).
  // ==========================================================================
  describe.skip('Stella Suggestion Decisions (post-G2 stella_0003)', () => {
    let decisionId: string

    beforeAll(async () => {
      decisionId = randomUUID()
      await db.execute(
        `INSERT INTO stella_suggestion_decisions (id, organization_id, project_id, suggestion_key, decision, decided_by)
         VALUES ('${decisionId}', '${orgAId}', '${projectAId}', 'advisor.suggested_next_actions[0]', 'accepted', '${adminA.id}')`,
      )
    })

    it('Admin A puede ver las decisiones de su organización', async () => {
      const { data, error } = await adminA.client
        .from('stella_suggestion_decisions')
        .select('id')
        .eq('id', decisionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
    })

    it('Admin B NO puede ver decisiones de Org A (SELECT cruzado devuelve vacío)', async () => {
      const { data, error } = await adminB.client
        .from('stella_suggestion_decisions')
        .select('id')
        .eq('id', decisionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(0)
    })

    it('INSERT como authenticated es denegado (42501 — sin grant ni política)', async () => {
      const { error } = await adminA.client.from('stella_suggestion_decisions').insert({
        id: randomUUID(),
        organization_id: orgAId,
        project_id: projectAId,
        suggestion_key: 'advisor.suggested_next_actions[1]',
        decision: 'rejected',
        decided_by: adminA.id,
      })
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
    })

    it('UPDATE como authenticated es denegado (42501 — SELECT-only grant)', async () => {
      const { error } = await adminA.client
        .from('stella_suggestion_decisions')
        .update({ decision: 'undone' })
        .eq('id', decisionId)
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
    })

    it('DELETE como authenticated es denegado (42501 — SELECT-only grant)', async () => {
      const { error } = await adminA.client
        .from('stella_suggestion_decisions')
        .delete()
        .eq('id', decisionId)
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
    })
  })
})
