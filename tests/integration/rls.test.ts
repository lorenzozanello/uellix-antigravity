// MUST be the first import: fail-closed target gate that does not depend
// on which vitest config selected this file. See tests/integration/_guard.ts.
import './_guard'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { db } from '@/db/client'
import { organizations, organizationMembers, fxRates, projects, projectInvestments, evidenceItems, sroiCalculationRuns, sroiCalculationLineItems, sroiReports, stellaInteractions } from '@/db/schema'
import { randomUUID } from 'crypto'
import { expectAppendOnlyRejection } from '../helpers/append-only-error'

// Clave determinista del residuo append-only del ensayo G3 local. Identifica la
// fila sintética sin depender de su UUID y permite REUTILIZARLA entre corridas
// (ver "Contrato de idempotencia" más abajo).
const G3_LOCAL_SYNTHETIC_KEY = 'g3-local-rehearsal.synthetic.advisor.suggested_next_actions[0]'
const G3_LOCAL_SYNTHETIC_KEY_DENIED = 'g3-local-rehearsal.synthetic.advisor.suggested_next_actions[1]'

/**
 * `db.execute()` devuelve el `RowList` de postgres-js (array-like) según el
 * driver; normalizamos para no depender de esa forma.
 */
function rowsOf(result: unknown): Record<string, string>[] {
  if (Array.isArray(result)) return result as Record<string, string>[]
  if (result && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, string>[] }).rows
  }
  return []
}

// CHANGED for the G2/G3 local rehearsal worktree: the fallback used to be
// 55321, the already-running uellix-antigravity stack's API port on this
// host. NEXT_PUBLIC_SUPABASE_URL should still be set explicitly in
// .env.local; this fallback only changes what happens if it is not.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:56321'
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

  // --- Contrato de idempotencia del residuo append-only (ensayo G3 local) ---
  // Una corrida previa pudo dejar UNA decisión sintética con la clave
  // determinista. Esa fila no se puede borrar (triggers append-only) y sus FK
  // ON DELETE NO ACTION fijan la organización, el proyecto y el usuario que
  // referencia. Reejecutar el gate NO debe multiplicar ese residuo, así que:
  //
  //   REUSED  — existe exactamente una: se reutiliza la fila y se DERIVAN de
  //             ella la organización, el proyecto y la interacción sintética.
  //             No se inserta ninguna fila append-only nueva.
  //   CREATED — no existe: se crea exactamente una, como en la primera corrida.
  //   >1      — se aborta la suite: no se elige una fila arbitrariamente.
  //
  // Nunca se usa ON CONFLICT, UPDATE, DELETE, TRUNCATE, desactivación de
  // triggers, session_replication_role ni DROP.
  let persistentFixtureMode: 'CREATED' | 'REUSED'
  let persistentDecisionId: string | null = null
  let persistentInteractionId: string | null = null

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_AUTH_OPTIONS)

    const existingDecisions = rowsOf(
      await db.execute(
        `SELECT id, organization_id, project_id FROM public.stella_suggestion_decisions
          WHERE suggestion_key = '${G3_LOCAL_SYNTHETIC_KEY}'`,
      ),
    )

    if (existingDecisions.length > 1) {
      throw new Error(
        `G3: residuo duplicado — ${existingDecisions.length} decisiones con la clave determinista ` +
          'del ensayo local. No se selecciona una arbitrariamente; abortar y reauditar.',
      )
    }

    if (existingDecisions.length === 1) {
      persistentFixtureMode = 'REUSED'
      const [decision] = existingDecisions
      persistentDecisionId = decision.id
      orgAId = decision.organization_id
      projectAId = decision.project_id

      // La interacción sintética de la clausura preservada; se reutiliza para
      // no crear otra fila append-only.
      const closureInteractions = rowsOf(
        await db.execute(
          `SELECT id FROM public.stella_interactions
            WHERE organization_id = '${orgAId}' AND project_id = '${projectAId}'`,
        ),
      )
      if (closureInteractions.length !== 1) {
        throw new Error(
          'G3: se esperaba exactamente 1 interacción sintética en la clausura preservada y hay ' +
            `${closureInteractions.length}. Abortar y reauditar.`,
        )
      }
      persistentInteractionId = closureInteractions[0].id
    } else {
      persistentFixtureMode = 'CREATED'
      orgAId = randomUUID()
      projectAId = randomUUID()
    }

    // Org B siempre es un fixture fresco y desechable: nada append-only la fija.
    orgBId = randomUUID()
    const orgsToCreate = [{ id: orgBId, name: 'RLS Org B', slug: `org-b-${Date.now()}` }]
    if (persistentFixtureMode === 'CREATED') {
      orgsToCreate.unshift({ id: orgAId, name: 'RLS Org A', slug: `org-a-${Date.now()}` })
    }
    await db.insert(organizations).values(orgsToCreate)

    // Create Users
    adminA = await createTestUser(adminClient, 'organization_admin', orgAId)
    analystA = await createTestUser(adminClient, 'analyst', orgAId)
    reviewerA = await createTestUser(adminClient, 'reviewer', orgAId)
    viewerA = await createTestUser(adminClient, 'viewer', orgAId)
    adminB = await createTestUser(adminClient, 'organization_admin', orgBId)
    noOrgUser = await createTestUser(adminClient, 'none', null)
    superAdmin = await createTestUser(adminClient, 'super_admin', null)

    // Set up project via admin. En modo REUSED el proyecto ya existe y está
    // fijado por las FK de la decisión persistente: no se recrea.
    if (persistentFixtureMode === 'CREATED') {
      await db.insert(projects).values({
        id: projectAId,
        organizationId: orgAId,
        name: 'Test Project A',
        status: 'draft',
        createdBy: adminA.id
      })
    }

    console.info(`[G3 local] Fixture append-only persistente: ${persistentFixtureMode}`)
  })

  // ---------------------------------------------------------------------------
  // Contrato de limpieza (ensayo G3 local, 2026-08-01)
  //
  // Los bloques post-G2 escriben en dos tablas append-only: `stella_interactions`
  // (fila sembrada) y `stella_suggestion_decisions` (una decisión sintética).
  // Sus triggers `*_append_only` / `*_no_truncate` rechazan UPDATE, DELETE y
  // TRUNCATE para TODOS los roles, incluido el dueño de la tabla, así que esas
  // filas no se pueden retirar una por una. Sus FK son ON DELETE NO ACTION, de
  // modo que la organización, el proyecto y el usuario referenciados quedan
  // pinchados por transitividad y tampoco pueden borrarse.
  //
  // Por eso este afterAll PRESERVA deliberadamente esa clausura y limpia sólo
  // los fixtures sin dependencia append-only. El residuo es admisible ÚNICAMENTE
  // en el stack local desechable; la limpieza autorizada es el reset/rebuild del
  // stack, no un DELETE fila por fila. G3 contra staging remoto exige un diseño
  // no contaminante distinto y NO está autorizado — ver docs/ops/gates/G3_PACKAGE.md.
  //
  // Este afterAll no desactiva triggers, no toca session_replication_role y no
  // ejecuta DROP; cualquier error de FK se propaga en lugar de silenciarse.
  // ---------------------------------------------------------------------------
  afterAll(async () => {
    // En modo CREATED, adminA es `created_by` de la interacción sembrada y
    // `decided_by` de la decisión: hay que preservarlo. En modo REUSED esas
    // filas apuntan al usuario de la corrida original (que ya estaba
    // preservado), así que TODOS los usuarios de esta corrida son desechables.
    const preservedUserIds = new Set(
      persistentFixtureMode === 'CREATED' ? ([adminA?.id].filter(Boolean) as string[]) : [],
    )
    const disposableUsers = [adminA, analystA, reviewerA, viewerA, adminB, noOrgUser, superAdmin]
      .filter((u) => Boolean(u?.id) && !preservedUserIds.has(u.id))

    // Objeto de Storage del bloque Storage: sin dependencia append-only.
    const { error: storageError } = await adminClient.storage
      .from('uellix-evidence')
      .remove([`${projectAId}/evidence1/test.txt`])
    if (storageError) throw new Error(`afterAll: no se pudo limpiar el objeto de Storage: ${storageError.message}`)

    // Proyectos creados dentro de la suite que nada append-only referencia.
    // projectAId queda fuera: lo referencian la interacción y la decisión.
    await db.execute(
      `DELETE FROM public.projects WHERE organization_id = '${orgAId}' AND id <> '${projectAId}'`,
    )

    for (const u of disposableUsers) {
      await db.execute(`DELETE FROM public.organization_members WHERE user_id = '${u.id}'`)
      await db.execute(`DELETE FROM public.users WHERE id = '${u.id}'`)
      const { error } = await adminClient.auth.admin.deleteUser(u.id)
      // No se silencia: un fallo de FK o de permisos aquí es un hallazgo real.
      if (error) throw new Error(`afterAll: no se pudo eliminar el usuario auth de prueba: ${error.message}`)
    }

    // Org B no tiene filas append-only; Org A queda fijada por la decisión.
    await db.execute(`DELETE FROM public.organizations WHERE id = '${orgBId}'`)

    console.info(
      `[G3 local] Fixture append-only ${persistentFixtureMode}. Preservados a propósito ` +
        '(FK NO ACTION + triggers append-only): organización A, proyecto A, el usuario que ' +
        'figura como created_by/decided_by, la interacción Stella sintética y la decisión ' +
        'sintética persistente. Limpieza autorizada: reset/rebuild del stack local desechable.',
    )
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
      // Modo REUSED: se reutiliza la interacción sintética ya existente en la
      // clausura preservada. Insertar otra multiplicaría el residuo append-only.
      if (persistentInteractionId) {
        interactionId = persistentInteractionId
        return
      }

      // Seed via the direct Drizzle connection (db/client.ts over DATABASE_URL,
      // i.e. the table owner) — the only legitimate write path, mirroring the
      // server actions in app/actions/stella/*. Not a service_role client.
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

    // Habilitado en el ensayo G3 local (2026-08-01): stella_0002 ya está
    // aplicado en este stack, así que uellix_forbid_mutation() debe rechazar
    // UPDATE/DELETE incluso para el cliente SERVICE ROLE (que bypassa RLS).
    // Correrlo pre-G2 sí mutaría el audit trail, de ahí el .skip original.
    // Contra un entorno donde stella_0002 no esté aplicado, volver a .skip.
    describe('post-G2 (stella_0002): trigger blocks mutation even for service role', () => {
      // La aserción NO puede apoyarse en `error.message`: drizzle envuelve el
      // fallo en un DrizzleQueryError cuyo message es "Failed query: …" y deja
      // el PostgresError real en `.cause`. expectAppendOnlyRejection desenvuelve
      // la cadena y exige CONJUNTAMENTE SQLSTATE 42501, el texto append-only, la
      // operación y la tabla — estrictamente más fuerte que el /append-only/
      // original, que ni siquiera llegaba a comparar contra el mensaje real.
      it('UPDATE via service role falla con insufficient_privilege', async () => {
        await expectAppendOnlyRejection(
          () => db.execute(`UPDATE public.stella_interactions SET pipeline_step = 'x' WHERE id = '${interactionId}'`),
          { operation: 'UPDATE', table: 'stella_interactions' },
        )

        const { data: fresh } = await adminClient
          .from('stella_interactions')
          .select('pipeline_step')
          .eq('id', interactionId)
          .single()
        expect(fresh!.pipeline_step).toBe('narrative')
      })

      it('DELETE via service role falla con insufficient_privilege', async () => {
        await expectAppendOnlyRejection(
          () => db.execute(`DELETE FROM public.stella_interactions WHERE id = '${interactionId}'`),
          { operation: 'DELETE', table: 'stella_interactions' },
        )

        const { data: fresh } = await adminClient
          .from('stella_interactions')
          .select('id')
          .eq('id', interactionId)
        expect(fresh).toHaveLength(1)
      })
    })
  })

  // ==========================================================================
  // WS3b U5: stella_suggestion_decisions — habilitado en el ensayo G3 local
  // (2026-08-01) porque db/prepared/stella_0003_suggestion_decisions.sql ya está
  // aplicado en este stack; antes de ese gate la relación no existe y el bloque
  // falla por relación inexistente, así que contra un entorno sin stella_0003
  // hay que volver a .skip.
  //
  // AVISO — este bloque deja RESIDUO: su beforeAll inserta una fila en una tabla
  // append-only que no se puede borrar (ver el contrato de limpieza del afterAll
  // principal). Sólo admisible en el stack local desechable.
  // Posture: SELECT-only org-scoped RLS; INSERT/UPDATE/DELETE denied for
  // authenticated. Writes happen ONLY through recordStellaDecision, which uses
  // the direct Drizzle connection (db/client.ts over DATABASE_URL) — i.e. the
  // table OWNER, which bypasses RLS. Corrected 2026-08-01: not "service-role
  // writes" — after stella_0003, `service_role` holds no privilege on this
  // table. Immutability is enforced by two append-only triggers, which fire for
  // every role including the owner.
  // ==========================================================================
  describe('Stella Suggestion Decisions (post-G2 stella_0003)', () => {
    let decisionId: string

    beforeAll(async () => {
      // Modo REUSED: se reutiliza la decisión persistente resuelta en el
      // beforeAll raíz. Sólo el modo CREATED inserta, y exactamente una vez.
      if (persistentDecisionId) {
        decisionId = persistentDecisionId
        return
      }

      decisionId = randomUUID()
      await db.execute(
        `INSERT INTO stella_suggestion_decisions (id, organization_id, project_id, suggestion_key, decision, decided_by)
         VALUES ('${decisionId}', '${orgAId}', '${projectAId}', '${G3_LOCAL_SYNTHETIC_KEY}', 'accepted', '${adminA.id}')`,
      )
    })

    it('Admin A puede ver exactamente la decisión sintética esperada', async () => {
      const { data, error } = await adminA.client
        .from('stella_suggestion_decisions')
        .select('id, organization_id, suggestion_key, decision')
        .eq('id', decisionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].organization_id).toBe(orgAId)
      expect(data![0].suggestion_key).toBe(G3_LOCAL_SYNTHETIC_KEY)
      expect(data![0].decision).toBe('accepted')
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
        suggestion_key: G3_LOCAL_SYNTHETIC_KEY_DENIED,
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

    // ------------------------------------------------------------------------
    // Huecos de cobertura cerrados en el ensayo G3 local (2026-08-01). Todos
    // reutilizan la decisión existente: ninguno inserta filas append-only.
    // ------------------------------------------------------------------------

    it('SuperAdmin puede leer la decisión de cualquier organización', async () => {
      const { data, error } = await superAdmin.client
        .from('stella_suggestion_decisions')
        .select('id, suggestion_key')
        .eq('id', decisionId)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].suggestion_key).toBe(G3_LOCAL_SYNTHETIC_KEY)
    })

    it('SuperAdmin NO puede modificar la decisión (42501 — leer ≠ mutar)', async () => {
      const { error } = await superAdmin.client
        .from('stella_suggestion_decisions')
        .update({ decision: 'undone' })
        .eq('id', decisionId)
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
    })

    it('Usuario sin membresía NO puede leer la decisión (SELECT cruzado vacío)', async () => {
      const { data, error } = await noOrgUser.client
        .from('stella_suggestion_decisions')
        .select('id')
        .eq('id', decisionId)
      expect(error).toBeNull() // RLS filtra en silencio en SELECT
      expect(data).toHaveLength(0)
    })

    it('Usuario sin membresía NO puede insertar (42501)', async () => {
      const { error } = await noOrgUser.client.from('stella_suggestion_decisions').insert({
        id: randomUUID(),
        organization_id: orgAId,
        project_id: projectAId,
        suggestion_key: G3_LOCAL_SYNTHETIC_KEY_DENIED,
        decision: 'rejected',
        decided_by: noOrgUser.id,
      })
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
    })

    // `service_role` es BYPASSRLS, pero stella_0003 no le otorga ningún
    // privilegio de tabla: saltarse RLS no sustituye a la ACL. Confundir ambas
    // cosas es exactamente el error que este par de casos vigila.
    it('service_role NO puede leer la decisión (sin grant de tabla, pese a BYPASSRLS)', async () => {
      const { error } = await adminClient
        .from('stella_suggestion_decisions')
        .select('id')
        .eq('id', decisionId)
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
    })

    it('service_role NO puede insertar en la tabla (sin grant de tabla)', async () => {
      const { error } = await adminClient.from('stella_suggestion_decisions').insert({
        id: randomUUID(),
        organization_id: orgAId,
        project_id: projectAId,
        suggestion_key: G3_LOCAL_SYNTHETIC_KEY_DENIED,
        decision: 'rejected',
        decided_by: adminA.id,
      })
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501')
    })

    it('TRUNCATE está bloqueado por el trigger BEFORE TRUNCATE (transacción revertida)', async () => {
      // Se lanza dentro de una transacción: el trigger aborta el statement y la
      // transacción hace rollback, así que la tabla nunca queda vacía ni a mitad.
      await expectAppendOnlyRejection(
        () => db.transaction(async (tx) => { await tx.execute(`TRUNCATE public.stella_suggestion_decisions`) }),
        { operation: 'TRUNCATE', table: 'stella_suggestion_decisions' },
      )

      const survivors = rowsOf(
        await db.execute(
          `SELECT count(*)::text AS n FROM public.stella_suggestion_decisions
            WHERE suggestion_key = '${G3_LOCAL_SYNTHETIC_KEY}'`,
        ),
      )
      expect(Number(survivors[0].n)).toBe(1)
    })
  })
})
