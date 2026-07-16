import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { db } from '@/db/client'
import { organizations, organizationMembers, fxRates, projects, projectInvestments, evidenceItems, sroiCalculationRuns, sroiCalculationLineItems, sroiReports, stellaInteractions } from '@/db/schema'
import { randomUUID } from 'crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:55321'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test'
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'test'

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

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  await authClient.auth.signInWithPassword({ email, password })
  
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
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    
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
        .upload(fileName, 'Contenido de prueba', { upsert: true })
      
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
        .upload(fileName, 'Malicious', { upsert: true })
      
      expect(error).not.toBeNull()
      expect(error!.message).toContain('row violates row-level security policy')
    })

    it('Paths inválidos son rechazados (falla en validación foldername)', async () => {
      const fileName = `random-invalid-uuid/evidence1/test.txt`
      const { error } = await analystA.client.storage
        .from('uellix-evidence')
        .upload(fileName, 'Contenido inválido')
      
      expect(error).not.toBeNull()
      expect(error!.message).toContain('row violates row-level security policy')
    })
    
    it('Viewer A NO puede borrar evidencia (DELETE rol insuficiente)', async () => {
      const fileName = `${projectAId}/evidence1/test.txt`
      const { error } = await viewerA.client.storage
        .from('uellix-evidence')
        .remove([fileName])
      
      expect(error).not.toBeNull()
      // Fails due to RLS delete policy restricting to admin/analyst
    })
  })
})
