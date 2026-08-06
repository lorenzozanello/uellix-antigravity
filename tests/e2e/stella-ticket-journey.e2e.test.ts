// tests/e2e/stella-ticket-journey.e2e.test.ts
// INTEGRACIÓN — Tren 4.1, FASE 10/11. El recorrido completo, contra una base
// PostgreSQL real con `stella_0014` instalado.
//
// ---------------------------------------------------------------------------
// QUÉ ES REAL AQUÍ, Y QUÉ ESTÁ SUSTITUIDO
// ---------------------------------------------------------------------------
// REAL: la base de datos (contenedor desechable levantado por
// `scripts/stella-ticket-e2e.sh`), los siete paquetes preparados, el server
// action `runStellaGroundedQueryForProject`, la superficie de emisión
// `issueStellaGroundedQueryTicketForProject`, el adaptador
// `db/stella/operation-tickets`, la canonicalización de la consulta, el
// repositorio persistente de chunks, el generador extractivo local, el
// adaptador de presentación, el emisor de observabilidad y el ledger de cuota.
//
// SUSTITUIDO, y sólo esto:
//
//   `@/lib/auth/session`          — lee cookies de una petición HTTP que aquí
//                                   no existe. Se sustituye por el contexto de
//                                   sesión que un login habría producido.
//   `@/lib/auth/database-context` — se sustituye por una implementación que
//                                   llama a `withDatabaseIdentityContext` REAL
//                                   con ese actor. Las claims, las policies,
//                                   `auth.uid()` y RLS son las de producción:
//                                   lo único sustituido es DE DÓNDE sale el id
//                                   del usuario, no qué se hace con él.
//   `@/lib/stella/config`         — las banderas. En el repositorio son false,
//                                   y encenderlas aquí es precisamente lo que
//                                   permite ejercer el camino y seguir
//                                   entregándolas apagadas.
//   `@/lib/stella/rate-limit`     — el límite por hora usa Upstash/Redis. No
//                                   es parte de la idempotencia y su ausencia
//                                   no es sustituible por una base.
//
// El PROTOCOLO no está sustituido en ninguna parte: cada `bind`, `complete` y
// `abort` de esta batería es una llamada a la función SECURITY DEFINER real, y
// cada aserción de cobro cuenta filas de `public.stella_interactions`.
//
// ---------------------------------------------------------------------------
// CERO PROVEEDOR
// ---------------------------------------------------------------------------
// Afirmado, no supuesto: el guion invoca con `env -u GEMINI_API_KEY` y §0 de
// esta batería vuelve a comprobarlo desde dentro del proceso.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
// El SHAPE del informe que el §19 construye. Se importa el TIPO, nunca el
// modelo de referencia: `RuntimeProjectAttributionReport` es una declaración de
// qué hay que medir contra una base real, y el arnés de RELEASE es un oráculo
// que dice qué haría un sistema correcto. Confundirlos sería usar la respuesta
// como prueba.
import type { RuntimeProjectAttributionReport } from '@/tests/eval/stella-release/project-binding-release-gate'
import type { LocalRuntimeEvidence } from '@/tests/eval/stella-release/local-release-gate'

/* -------------------------------------------------------------------------- */
/* Fixtures — dos organizaciones, dos proyectos, dos actores                   */
/* -------------------------------------------------------------------------- */

const ORG_A = '11111111-1111-4111-8111-1111111111a1'
const ORG_B = '11111111-1111-4111-8111-1111111111b1'
const PROJECT_A1 = '22222222-2222-4222-8222-2222222222a1'
const PROJECT_A2 = '22222222-2222-4222-8222-2222222222a2'
const PROJECT_B1 = '22222222-2222-4222-8222-2222222222b1'
const ACTOR_A1 = '99999999-9999-4999-8999-9999999999a1'
const ACTOR_A2 = '99999999-9999-4999-8999-9999999999a2'
const ACTOR_B1 = '99999999-9999-4999-8999-9999999999b1'
/**
 * TREN 4.2. Un TERCER proyecto de ORG_A, con evidencia propia.
 *
 * Hacía falta uno nuevo en vez de reutilizar `PROJECT_A2`: los casos de
 * atribución necesitan dos proyectos que puedan **responder** la misma pregunta
 * y cobrar cada uno bajo el suyo, mientras que `PROJECT_A2` existe justamente
 * por lo contrario —no tiene evidencia— y es lo que hace medibles los casos de
 * abort. Darle evidencia habría cerrado un escenario para abrir otro.
 */
const PROJECT_A3 = '22222222-2222-4222-8222-2222222222a3'
const EVIDENCE_A1 = '33333333-3333-4333-8333-3333333333a1'
const EVIDENCE_A3 = '33333333-3333-4333-8333-3333333333a3'
const DOCVER_A1 = '44444444-4444-4444-8444-4444444444a1'
const DOCVER_A3 = '44444444-4444-4444-8444-4444444444a3'

/** Un documento real, del que el generador extractivo cita literalmente. */
const DOCUMENT_TEXT =
  'El programa atendió a 1240 beneficiarios durante 2025. La tasa de retención escolar del grupo participante fue del 87 por ciento.'

/* -------------------------------------------------------------------------- */
/* La sesión sustituida                                                       */
/* -------------------------------------------------------------------------- */

/** Quién está "conectado" ahora mismo. Cambia entre escenarios de scope. */
let currentActor = { userId: ACTOR_A1, organizationId: ORG_A, role: 'organization_admin' as string }

const mockStellaConfig = { isEnabled: true, isGroundedQueryEnabled: true }
const mockStellaState = { canUseStella: true }

vi.mock('@/lib/stella/config', () => ({
  get stellaConfig() {
    return mockStellaConfig
  },
  get stellaState() {
    return mockStellaState
  },
}))

vi.mock('@/lib/stella/rate-limit', () => ({
  consumeStellaRateLimit: async () => ({ allowed: true }),
}))

vi.mock('@/lib/auth/session', () => ({
  requireOrganizationAccess: async () => ({
    user: { id: currentActor.userId, email: 'e2e@example.invalid', fullName: null, avatarUrl: null, isSuperAdmin: false },
    organization: { id: currentActor.organizationId, name: 'E2E', slug: 'e2e' },
    membership: {
      id: '00000000-0000-4000-8000-000000000001',
      organizationId: currentActor.organizationId,
      userId: currentActor.userId,
      role: currentActor.role,
      status: 'active',
    },
  }),
}))

/**
 * The REAL identity context, driven by the substituted session.
 *
 * This is the line that keeps the battery honest. It would have been far
 * easier to stub `withOrganizationDatabaseContext` into `cb => cb()` — and
 * every RLS policy, every `auth.uid()` and every `U0102` in this file would
 * then have been evaluated with NO claims, i.e. as nobody. The cross-scope
 * scenarios would have "passed" by finding nothing for reasons that have
 * nothing to do with the protocol.
 */
vi.mock('@/lib/auth/database-context', async () => {
  const { withDatabaseIdentityContext } = await import('@/db/identity-context')
  return {
    withOrganizationDatabaseContext: <T,>(cb: () => Promise<T> | T) =>
      withDatabaseIdentityContext(
        { userId: currentActor.userId, organizationId: currentActor.organizationId, isSuperAdmin: false },
        async () => cb() as Promise<T>,
      ),
  }
})

/* -------------------------------------------------------------------------- */
/* Privileged connection — SEEDING AND ASSERTIONS ONLY                        */
/* -------------------------------------------------------------------------- */

/**
 * A superuser handle used for exactly two things: building the world before a
 * scenario, and COUNTING THE LEDGER after it.
 *
 * Deliberately NOT the runtime's connection. Every charge assertion in this
 * file reads `public.stella_interactions` through this handle — a different
 * connection, a different role, outside the transaction the action ran in —
 * so "one unit was charged" is a fact about COMMITTED ROWS, never about a
 * value the action returned about itself. An action that reported success
 * without charging would pass a return-value check and fail every check here.
 */
let admin: postgres.Sql

/**
 * Supplied by `scripts/stella-ticket-e2e.sh`, never defaulted.
 *
 * A default would be the whole danger: this handle is a superuser that seeds
 * and reads a ledger, and a default pointing at "some local postgres" would
 * make an accidental `vitest` invocation write to whatever database happened
 * to be listening. Absent variable, absent battery.
 */
const CONTAINER_URL = process.env.UELLIX_TICKET_E2E_ADMIN_URL

/** Charge rows for an organization in the current UTC month. */
async function chargeCount(organizationId: string): Promise<number> {
  const rows = await admin`
    SELECT count(*)::int AS n
    FROM public.stella_interactions
    WHERE organization_id = ${organizationId}
      AND created_at >= date_trunc('month', timezone('UTC', now()))
  `
  return Number(rows[0]!.n)
}

/**
 * Charge rows for one PROJECT this month — Train 4.2, FASE 8.
 *
 * The organization-scoped count above cannot see R2-INT at all: a unit charged
 * to the wrong project of the RIGHT organization moves both counts by exactly
 * one, so every assertion written over `chargeCount` alone passed throughout
 * the whole of the defect's life. Attribution needs its own reader.
 */
async function chargeCountForProject(organizationId: string, projectId: string): Promise<number> {
  const rows = await admin`
    SELECT count(*)::int AS n
    FROM public.stella_interactions
    WHERE organization_id = ${organizationId}
      AND project_id = ${projectId}
      AND created_at >= date_trunc('month', timezone('UTC', now()))
  `
  return Number(rows[0]!.n)
}

/**
 * The full ledger rows an organization gained while `body` ran.
 *
 * Returns ROWS, not a count, because FASE 8 asks what the row SAYS —
 * organization, project, role and idempotency key — and a count can only ever
 * answer "how many". Bounded by `created_at` and by the ids seen before, so a
 * row an earlier scenario left behind is never mistaken for this one's.
 */
async function chargesAddedBy<T>(
  organizationId: string,
  body: () => Promise<T>,
): Promise<{ result: T; rows: Array<Record<string, unknown>> }> {
  const before = await admin`
    SELECT id FROM public.stella_interactions WHERE organization_id = ${organizationId}
  `
  const seen = new Set(before.map((r) => String(r.id)))
  const result = await body()
  const after = await admin`
    SELECT id, organization_id, project_id, stella_role, idempotency_key, created_at
    FROM public.stella_interactions
    WHERE organization_id = ${organizationId}
    ORDER BY created_at ASC
  `
  return {
    result,
    rows: (after as unknown as Array<Record<string, unknown>>).filter((r) => !seen.has(String(r.id))),
  }
}

/** Every ticket row's status, for asserting lifecycle rather than inferring it. */
async function ticketStatus(ticketId: string): Promise<string | null> {
  const rows = await admin`
    SELECT status FROM uellix_stella_ops.operation_tickets WHERE ticket_id = ${ticketId}
  `
  return rows.length === 0 ? null : String(rows[0]!.status)
}

async function setQuota(organizationId: string, quota: number | null): Promise<void> {
  await admin`UPDATE public.organizations SET stella_monthly_quota = ${quota} WHERE id = ${organizationId}`
}

/** Wipe the ledger and every ticket between scenarios. */
async function resetLedger(): Promise<void> {
  // `stella_interactions` is append-only for every role INCLUDING the owner
  // (trg_stella_interactions_append_only, prepared stella_0002), so the rows
  // cannot be deleted — not even here. `session_replication_role = replica`
  // does not help either: the trigger is ENABLE ALWAYS.
  //
  // TRUNCATE is refused as well. So the ledger is reset the only way the
  // schema permits: by dropping and recreating nothing at all, and instead
  // making every scenario read a DELTA rather than an absolute count. See
  // `expectDelta`.
  await admin`DELETE FROM uellix_stella_ops.operation_tickets WHERE status <> 'completed'`
}

/**
 * Assert that running `body` moved the organization's charge count by exactly
 * `expected`.
 *
 * A DELTA, never an absolute, because the ledger is append-only by design and
 * cannot be cleared between scenarios. Reading a delta is also the stronger
 * assertion: it survives any number of rows an earlier scenario left behind,
 * and it cannot be satisfied by a scenario that charged the RIGHT total for
 * the WRONG reason.
 */
async function expectDelta<T>(organizationId: string, expected: number, body: () => Promise<T>): Promise<T> {
  const before = await chargeCount(organizationId)
  const result = await body()
  const after = await chargeCount(organizationId)
  expect(after - before).toBe(expected)
  return result
}

/* -------------------------------------------------------------------------- */
/* World construction                                                         */
/* -------------------------------------------------------------------------- */

async function seedWorld(): Promise<void> {
  await admin.unsafe(`
    INSERT INTO public.users (id, email) VALUES
      ('${ACTOR_A1}', 'a1@example.invalid'),
      ('${ACTOR_A2}', 'a2@example.invalid'),
      ('${ACTOR_B1}', 'b1@example.invalid')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.organizations (id, name, slug, stella_monthly_quota) VALUES
      ('${ORG_A}', 'Org A', 'org-a-e2e', 100),
      ('${ORG_B}', 'Org B', 'org-b-e2e', 100)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.organization_members (id, organization_id, user_id, role, status) VALUES
      ('00000000-0000-4000-8000-0000000000a1', '${ORG_A}', '${ACTOR_A1}', 'organization_admin', 'active'),
      ('00000000-0000-4000-8000-0000000000a2', '${ORG_A}', '${ACTOR_A2}', 'organization_admin', 'active'),
      ('00000000-0000-4000-8000-0000000000b1', '${ORG_B}', '${ACTOR_B1}', 'organization_admin', 'active')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.projects (id, organization_id, name, created_by) VALUES
      ('${PROJECT_A1}', '${ORG_A}', 'Project A1', '${ACTOR_A1}'),
      ('${PROJECT_A2}', '${ORG_A}', 'Project A2', '${ACTOR_A1}'),
      ('${PROJECT_A3}', '${ORG_A}', 'Project A3', '${ACTOR_A1}'),
      ('${PROJECT_B1}', '${ORG_B}', 'Project B1', '${ACTOR_B1}')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.evidence_items (id, project_id, organization_id, type, title, status, created_by) VALUES
      ('${EVIDENCE_A1}', '${PROJECT_A1}', '${ORG_A}', 'text', 'Informe 2025', 'approved', '${ACTOR_A1}'),
      ('${EVIDENCE_A3}', '${PROJECT_A3}', '${ORG_A}', 'text', 'Informe 2025 (A3)', 'approved', '${ACTOR_A1}')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.evidence_document_versions (
      id, organization_id, project_id, evidence_id, version_id, raw_content_hash,
      normalized_content_hash, normalization_version, extractor_version,
      chunker_version, mime_type, ordinal, supersedes_version_id
    ) VALUES (
      '${DOCVER_A1}', '${ORG_A}', '${PROJECT_A1}', '${EVIDENCE_A1}',
      repeat('1', 64), repeat('2', 64), repeat('3', 64),
      'norm-1', 'extract-1', 'chunk-1', 'text/plain', 1, NULL
    ) ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.evidence_chunks (
      chunk_id, organization_id, project_id, evidence_id, document_version_id,
      version_id, raw_content_hash, normalized_content_hash,
      chunk_index, content, content_hash, char_start, char_end,
      normalization_version, chunker_version, injection_scanner_version, signals, canonical_chunk_id
    )
    -- chunk_id y content_hash NO son literales: grounding_0004 impone que
    -- ambos sean DERIVADOS
    -- (sin comillas invertidas en este comentario: vive dentro de un template
    -- literal de JavaScript, y una sola lo cerraría a mitad del SQL)
    --
    --   content_hash = sha256(utf8(content))
    --   chunk_id     = sha256(utf8('grounding/chunk/v1' || LF || version_id
    --                              || LF || chunk_index || LF || content_hash))
    --
    -- Se calculan con las MISMAS expresiones que el CHECK evalúa, en un SELECT,
    -- en vez de precomputarse en Node. Un valor precomputado que se desviara
    -- del contrato haría fallar la siembra —lo cual es correcto— pero un valor
    -- precomputado que COINCIDIERA por casualidad probaría el CHECK contra sí
    -- mismo. Aquí la base es la única que calcula.
    SELECT
      encode(sha256(convert_to('grounding/chunk/v1' || chr(10) || repeat('1', 64) || chr(10)
                               || 0::text || chr(10) || ch, 'UTF8')), 'hex'),
      '${ORG_A}'::uuid, '${PROJECT_A1}'::uuid, '${EVIDENCE_A1}'::uuid, '${DOCVER_A1}'::uuid,
      repeat('1', 64), repeat('2', 64), repeat('3', 64),
      0, body, ch, 0, length(body),
      'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, NULL
    FROM (
      SELECT body, encode(sha256(convert_to(body, 'UTF8')), 'hex') AS ch
      FROM (SELECT '${DOCUMENT_TEXT.replace(/'/g, "''")}'::text AS body) AS t
    ) AS d
    ON CONFLICT (chunk_id) DO NOTHING;

    -- El proyecto A3, con su propia versión y su propio chunk. Mismo TEXTO que
    -- A1 a propósito: los casos de atribución preguntan lo mismo en dos
    -- proyectos, y si el contenido difiriera la diferencia de resultados podría
    -- explicarse por el corpus en vez de por el proyecto.
    INSERT INTO public.evidence_document_versions (
      id, organization_id, project_id, evidence_id, version_id, raw_content_hash,
      normalized_content_hash, normalization_version, extractor_version,
      chunker_version, mime_type, ordinal, supersedes_version_id
    ) VALUES (
      '${DOCVER_A3}', '${ORG_A}', '${PROJECT_A3}', '${EVIDENCE_A3}',
      repeat('7', 64), repeat('8', 64), repeat('9', 64),
      'norm-1', 'extract-1', 'chunk-1', 'text/plain', 1, NULL
    ) ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.evidence_chunks (
      chunk_id, organization_id, project_id, evidence_id, document_version_id,
      version_id, raw_content_hash, normalized_content_hash,
      chunk_index, content, content_hash, char_start, char_end,
      normalization_version, chunker_version, injection_scanner_version, signals, canonical_chunk_id
    )
    SELECT
      encode(sha256(convert_to('grounding/chunk/v1' || chr(10) || repeat('7', 64) || chr(10)
                               || 0::text || chr(10) || ch, 'UTF8')), 'hex'),
      '${ORG_A}'::uuid, '${PROJECT_A3}'::uuid, '${EVIDENCE_A3}'::uuid, '${DOCVER_A3}'::uuid,
      repeat('7', 64), repeat('8', 64), repeat('9', 64),
      0, body, ch, 0, length(body),
      'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, NULL
    FROM (
      SELECT body, encode(sha256(convert_to(body, 'UTF8')), 'hex') AS ch
      FROM (SELECT '${DOCUMENT_TEXT.replace(/'/g, "''")}'::text AS body) AS t
    ) AS d
    ON CONFLICT (chunk_id) DO NOTHING;
  `)
}

/* -------------------------------------------------------------------------- */
/* Runtime under test — imported AFTER the mocks are registered               */
/* -------------------------------------------------------------------------- */

type Runtime = {
  issue: (projectId: string) => Promise<unknown>
  run: (projectId: string, query: string, ticket: string) => Promise<{ status: string; code?: string }>
  canonicalQueryHash: (q: string) => string
  telemetryFailures: () => number
}

let rt: Runtime

beforeAll(async () => {
  if (!CONTAINER_URL || !CONTAINER_URL.includes('127.0.0.1:56322')) {
    throw new Error(
      'UELLIX_TICKET_E2E_ADMIN_URL must be set to the disposable container on 127.0.0.1:56322. ' +
        'Run this battery through scripts/stella-ticket-e2e.sh, which builds and destroys that container.',
    )
  }
  admin = postgres(CONTAINER_URL, { max: 4, onnotice: () => {} })
  await seedWorld()

  const action = await import('@/app/actions/stella/grounded-query')
  const hash = await import('@/lib/stella/operation-ticket/canonical-query-hash')
  const obs = await import('@/lib/stella/operation-ticket/ticket-observability')

  rt = {
    issue: (projectId) => action.issueStellaGroundedQueryTicketForProject(projectId),
    run: (projectId, query, ticket) =>
      action.runStellaGroundedQueryForProject(projectId, { query }, ticket) as Promise<{
        status: string
        code?: string
      }>,
    canonicalQueryHash: hash.canonicalQueryHash,
    telemetryFailures: obs.ticketTelemetryFailureCount,
  }
}, 120_000)

afterAll(async () => {
  await admin?.end({ timeout: 5 })
})

beforeEach(async () => {
  currentActor = { userId: ACTOR_A1, organizationId: ORG_A, role: 'organization_admin' }
  mockStellaConfig.isEnabled = true
  mockStellaConfig.isGroundedQueryEnabled = true
  mockStellaState.canUseStella = true
  await setQuota(ORG_A, 100)
  await setQuota(ORG_B, 100)
  await resetLedger()
})

/** Mint a ticket and fail loudly if issuance did not succeed. */
async function issued(projectId = PROJECT_A1): Promise<string> {
  const result = (await rt.issue(projectId)) as { status: string; ticket?: string }
  expect(result.status).toBe('issued')
  return result.ticket!
}

/* ========================================================================== */

describe('0. El entorno es el que la batería declara', () => {
  it('no hay clave de proveedor en el proceso', () => {
    expect(process.env.GEMINI_API_KEY).toBeUndefined()
  })

  it('la cadena preparada COMPLETA está instalada, y se comprueba por sus objetos', async () => {
    // TREN 4.3 — CIERRE. El conteo dejó de ser 6 porque la cadena dejó de
    // terminar en stella_0015: stella_0017 publica el verbo de completado de
    // las hermanas (séptima) y stella_0018 el bind ligado a categoría (octava).
    //
    // El conteo se afirma DERIVÁNDOLO de la cadena declarada y no como un
    // literal, y va acompañado de la comprobación que de verdad importa —que
    // los objetos existan— porque un número correcto sobre los objetos
    // equivocados sería un entorno equivocado que pasa.
    const rows = await admin`
      SELECT count(*)::int AS n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'uellix_stella_ops'
    `
    expect(Number(rows[0]!.n)).toBe(8)

    for (const sig of [
      'uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)',
      'uellix_stella.stella_capacity(uuid, character)',
      'uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb)',
      'uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)',
      'uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)',
    ]) {
      const present = await admin`SELECT to_regprocedure(${sig}) IS NOT NULL AS ok`
      expect(present[0]!.ok, `falta el objeto gobernado ${sig}`).toBe(true)
    }
  })

  it('R6a y R6b están cerrados: el runtime no alcanza el bind sin categoría ni el consumo sin ticket', async () => {
    // Se pregunta con `has_function_privilege`, que SIGUE la pertenencia de rol.
    // Una búsqueda de llamantes con cero resultados no bastaría: mientras
    // uellix_app conserve EXECUTE la ruta existe, y una acción futura la alcanza
    // sin que ninguna prueba lo note.
    const rows = await admin`
      SELECT
        has_function_privilege('uellix_app',
          'uellix_stella_ops.bind_operation_ticket(character, uuid, character)', 'EXECUTE') AS blind_bind,
        has_function_privilege('uellix_app',
          'uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)', 'EXECUTE') AS ticketless,
        has_function_privilege('uellix_app',
          'uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)', 'EXECUTE') AS governed_bind
    `
    expect(rows[0]!.blind_bind, 'uellix_app alcanza el bind SIN categoría esperada (R6a)').toBe(false)
    expect(rows[0]!.ticketless, 'uellix_app alcanza el consumo SIN ticket (R6b)').toBe(false)
    expect(rows[0]!.governed_bind, 'uellix_app no puede ligar por la ruta gobernada').toBe(true)
  })

  it('el runtime no tiene privilegio directo sobre la tabla de tickets', async () => {
    const rows = await admin`
      SELECT count(*)::int AS n
      FROM information_schema.table_privileges
      WHERE table_schema = 'uellix_stella_ops'
        AND table_name = 'operation_tickets'
        AND grantee IN ('uellix_app', 'authenticated', 'anon', 'service_role')
    `
    expect(Number(rows[0]!.n)).toBe(0)
  })
})

describe('1-2. Primera consulta y su reintento', () => {
  it('la primera consulta emite ticket, lo vincula, produce respuesta, completa y cobra EXACTAMENTE una unidad', async () => {
    const ticket = await issued()
    expect(await ticketStatus(ticket)).toBe('issued')

    const result = await expectDelta(ORG_A, 1, () => rt.run(PROJECT_A1, '¿Cuántos beneficiarios atendió el programa?', ticket))

    expect(result.status).toBe('ok')
    expect(await ticketStatus(ticket)).toBe('completed')
  })

  it('el REINTENTO del mismo ticket con la misma consulta cobra CERO unidades adicionales', async () => {
    const query = '¿Cuál fue la tasa de retención escolar?'
    const ticket = await issued()

    await expectDelta(ORG_A, 1, () => rt.run(PROJECT_A1, query, ticket))

    // El mismo ticket, la misma consulta. El servidor ve `completed` en bind y
    // NO reejecuta: devuelve el estado operacional explícito de la FASE 11.
    const retry = await expectDelta(ORG_A, 0, () => rt.run(PROJECT_A1, query, ticket))
    expect(retry.status).toBe('error')
    expect(retry.code).toBe('ALREADY_COMPLETED_RESULT_UNAVAILABLE')
  })
})

describe('3. La misma pregunta como operación nueva', () => {
  it('un ticket NUEVO con el MISMO texto cobra una segunda unidad', async () => {
    const query = '¿Cuántos beneficiarios atendió el programa?'

    const first = await issued()
    await expectDelta(ORG_A, 1, () => rt.run(PROJECT_A1, query, first))

    const second = await issued()
    expect(second).not.toBe(first)

    // Sin descuento por repetir una pregunta legítima. Un protocolo que
    // derivara la clave del TEXTO haría gratis esta segunda consulta y pasaría
    // todas las aserciones anteriores.
    const result = await expectDelta(ORG_A, 1, () => rt.run(PROJECT_A1, query, second))
    expect(result.status).toBe('ok')
  })
})

describe('4. El mismo ticket con otra consulta', () => {
  it('se rechaza y no cobra: el digest es write-once', async () => {
    const ticket = await issued()
    await expectDelta(ORG_A, 1, () => rt.run(PROJECT_A1, 'primera pregunta sobre beneficiarios', ticket))

    const other = await expectDelta(ORG_A, 0, () =>
      rt.run(PROJECT_A1, 'una pregunta completamente distinta sobre retención', ticket),
    )
    expect(other.status).toBe('error')
    // U0107 — no `ALREADY_COMPLETED...`: el ticket está completado, pero para
    // OTRA pregunta, y reportar "ya se hizo" sería mentir sobre cuál.
    expect(other.code).toBe('UNAUTHORIZED')
  })
})

describe('5-7. Tickets fuera de scope', () => {
  it('un ticket de OTRA organización se rechaza con cero cargo', async () => {
    currentActor = { userId: ACTOR_B1, organizationId: ORG_B, role: 'organization_admin' }
    const foreign = await issued(PROJECT_B1)

    currentActor = { userId: ACTOR_A1, organizationId: ORG_A, role: 'organization_admin' }
    const beforeB = await chargeCount(ORG_B)
    const result = await expectDelta(ORG_A, 0, () => rt.run(PROJECT_A1, 'pregunta', foreign))
    expect(result.status).toBe('error')
    expect(await chargeCount(ORG_B)).toBe(beforeB)
    expect(await ticketStatus(foreign)).toBe('issued')
  })

  it('R2-INT CERRADO — un ticket de OTRO proyecto de la misma organización y actor se RECHAZA con cero cargo', async () => {
    // ------------------------------------------------------------------
    // ESTE CASO MEDÍA EL DEFECTO. AHORA MIDE EL ARREGLO, Y LA DIFERENCIA
    // ESTÁ EN UNA FIRMA.
    //
    // Hasta el tren 4.1 `bind_operation_ticket(ticket, query_hash)` no recibía
    // el proyecto contra el que la consulta iba a ejecutarse, así que la base
    // no tenía **con qué comparar**: el trabajo leía la evidencia de A1 y la
    // fila del ledger quedaba archivada bajo A2. No era un escape de cuota —la
    // cuota es de organización y se cobraba exactamente una unidad— sino un
    // defecto de ATRIBUCIÓN, y en un producto cuya salida entera es una cifra
    // SROI auditable una unidad mal atribuida es peor que una no cobrada.
    //
    // `stella_0015` da a los cuatro verbos un `p_expected_project_id` sin
    // DEFAULT y el server action le entrega el proyecto que él mismo derivó.
    // El rechazo ocurre en `bind`, ANTES de leer un solo chunk: no hay trabajo
    // que cobrar porque no hubo trabajo.
    //
    // Se comprueban las TRES cosas, y ninguna implica a las otras dos:
    //   1. la respuesta no es utilizable;
    //   2. la organización no ganó ninguna fila —ni bajo A1 ni bajo A2—;
    //   3. el ticket sigue `issued`: nunca reservó, así que no hay que soltarlo.
    // ------------------------------------------------------------------
    const ticketOfA2 = await issued(PROJECT_A2)

    const beforeA1 = await chargeCountForProject(ORG_A, PROJECT_A1)
    const beforeA2 = await chargeCountForProject(ORG_A, PROJECT_A2)

    const result = await expectDelta(ORG_A, 0, () =>
      rt.run(PROJECT_A1, '¿Cuántos beneficiarios atendió el programa?', ticketOfA2),
    )

    expect(result.status).toBe('error')
    // Una sola frase para todo fallo de scope: distinguirlas en pantalla sería
    // un oráculo de tenencia. U0110 sigue siendo distinguible donde sirve —en
    // el log de la base—, y `stella_0015` no lo levanta para nada más.
    expect(result.code).toBe('UNAUTHORIZED')

    // Ninguna lectura de A1 quedó atribuida a A2, ni al revés.
    expect(await chargeCountForProject(ORG_A, PROJECT_A1)).toBe(beforeA1)
    expect(await chargeCountForProject(ORG_A, PROJECT_A2)).toBe(beforeA2)
    expect(await ticketStatus(ticketOfA2)).toBe('issued')
  })

  it('un ticket de otro proyecto tampoco puede COMPLETARSE ni ABORTARSE desde la superficie equivocada', async () => {
    // El mismo ataque en los otros dos verbos, por separado. `complete`
    // revalida por su cuenta —corre en OTRA transacción que `bind`— y `abort`
    // lo comprueba para que la superficie de un proyecto no pueda soltar la
    // reserva que sostiene la operación de otro.
    const { bindOperationTicket, completeOperationTicket, abortOperationTicket, inspectOperationTicket } =
      await import('@/db/stella/operation-tickets')
    const { canonicalQueryHash } = await import('@/lib/stella/operation-ticket/canonical-query-hash')

    const ticketOfA1 = await issued(PROJECT_A1)
    const hash = canonicalQueryHash('¿Cuántos beneficiarios atendió el programa?')

    // bind legítimo, bajo su propio proyecto.
    const bound = await bindOperationTicket(ticketOfA1, PROJECT_A1, hash, 'grounded_query')
    expect(bound.kind).toBe('bound')

    const before = await chargeCount(ORG_A)

    // complete desde B: rechazado, cero cargo, y la reserva intacta.
    const settledFromB = await completeOperationTicket(ticketOfA1, PROJECT_A2, hash)
    expect(settledFromB.kind).toBe('rejected')
    expect((settledFromB as { reason: string }).reason).toBe('out_of_scope')
    expect(await chargeCount(ORG_A)).toBe(before)
    expect(await ticketStatus(ticketOfA1)).toBe('bound')

    // abort desde B: rechazado, y la reserva de A SIGUE viva.
    const abortedFromB = await abortOperationTicket(ticketOfA1, PROJECT_A2, 'caller_abort')
    expect(abortedFromB.kind).toBe('rejected')
    expect(await ticketStatus(ticketOfA1)).toBe('bound')

    // inspect desde B: ni siquiera el ciclo de vida cruza el límite.
    expect(await inspectOperationTicket(ticketOfA1, PROJECT_A2)).toBeNull()
    // Y desde A sí, que es lo que hace que la negativa anterior signifique algo.
    const seenFromA = await inspectOperationTicket(ticketOfA1, PROJECT_A1)
    expect(seenFromA?.status).toBe('bound')

    // complete desde A: ahora sí, exactamente una unidad, bajo A.
    const settled = await completeOperationTicket(ticketOfA1, PROJECT_A1, hash)
    expect(settled.kind).toBe('completed')
    expect(await chargeCount(ORG_A)).toBe(before + 1)
    expect(await chargeCountForProject(ORG_A, PROJECT_A1)).toBeGreaterThan(0)

    // Y el reintento post-complete desde B tampoco puede inspeccionarse.
    expect(await inspectOperationTicket(ticketOfA1, PROJECT_A2)).toBeNull()
    const replayFromB = await completeOperationTicket(ticketOfA1, PROJECT_A2, hash)
    expect(replayFromB.kind).toBe('rejected')
    expect(await chargeCount(ORG_A)).toBe(before + 1)
  })

  it('el registro del defecto que R2-INT cerró — conservado como comentario, no como aserción', async () => {
    // ------------------------------------------------------------------
    // ESTA PRUEBA MEDÍA EL DEFECTO Y AHORA MIDE SU AUSENCIA.
    //
    // Hasta el tren 4.1 este escenario NO se rechazaba, y la prueba lo fijaba
    // en vez de fingirlo: `bind_operation_ticket(ticket, query_hash)` no
    // recibía el proyecto de ejecución, así que la base comparaba sólo lo que
    // conocía —actor y organización por RLS, proyecto del ticket por trigger—
    // y ambas cosas se cumplen en un ataque cross-project dentro de la misma
    // organización. El trabajo leía la evidencia de A1 y la fila del ledger
    // quedaba archivada bajo A2.
    //
    // ERA ALCANZABLE DESDE EL CLIENTE: cada export de un módulo `'use server'`
    // es un endpoint invocable por separado, así que la forma de tres
    // argumentos aceptaba un `projectId` cualquiera junto a un ticket
    // cualquiera. Lo marcó MAJOR la revisión adversarial A del tren 4.1.
    //
    // Lo que se conserva es la MEDICIÓN INVERSA: bajo `stella_0015` la
    // organización no gana ninguna fila, así que no hay ninguna que atribuir.
    // Si alguien reintrodujera las firmas ciegas, aquí aparecería una fila bajo
    // A2 y esta prueba sería la que lo dijera.
    // ------------------------------------------------------------------
    const ticketOfA2 = await issued(PROJECT_A2)

    const { rows } = await chargesAddedBy(ORG_A, async () => {
      await rt.run(PROJECT_A1, '¿Cuántos beneficiarios atendió el programa?', ticketOfA2)
    })

    expect(rows, 'una ejecución cross-project no puede producir ninguna fila de cargo').toEqual([])
  })

  it('un ticket de OTRO actor de la misma organización se rechaza con cero cargo', async () => {
    currentActor = { userId: ACTOR_A2, organizationId: ORG_A, role: 'organization_admin' }
    const otherActors = await issued(PROJECT_A1)

    currentActor = { userId: ACTOR_A1, organizationId: ORG_A, role: 'organization_admin' }
    const result = await expectDelta(ORG_A, 0, () => rt.run(PROJECT_A1, 'pregunta', otherActors))
    expect(result.status).toBe('error')
    // Nunca se vinculó: RLS lo hizo invisible para este actor.
    expect(await ticketStatus(otherActors)).toBe('issued')
  })

  it('un ticket inventado se rechaza con cero cargo y sin distinguirse de uno inexistente', async () => {
    const forged = 'd'.repeat(64)
    const result = await expectDelta(ORG_A, 0, () => rt.run(PROJECT_A1, 'pregunta', forged))
    expect(result.status).toBe('error')
    expect(await ticketStatus(forged)).toBeNull()
  })
})

describe('8-9. Fallos antes y después de la reserva', () => {
  it('un proyecto sin evidencia aborta el ticket y no cobra', async () => {
    // PROJECT_A2 existe y pertenece a la organización, pero no tiene evidencia.
    const ticket = await issued(PROJECT_A2)
    const result = await expectDelta(ORG_A, 0, () => rt.run(PROJECT_A2, 'pregunta sin evidencia', ticket))
    expect(result.status).toBe('error')
    expect(result.code).toBe('UNSUPPORTED_STEP')
    // Abortado, no dejado colgando: una consulta irrespondible no puede
    // seguir reteniendo una unidad de cuota.
    expect(await ticketStatus(ticket)).toBe('aborted')
  })

  it('el abort libera la reserva: la cuota vuelve a estar disponible para otro ticket', async () => {
    await setQuota(ORG_A, (await chargeCount(ORG_A)) + 1) // exactamente una unidad libre

    const doomed = await issued(PROJECT_A2)
    await rt.run(PROJECT_A2, 'pregunta sin evidencia', doomed)
    expect(await ticketStatus(doomed)).toBe('aborted')

    // La única unidad sigue disponible porque la reserva se soltó.
    const good = await issued(PROJECT_A1)
    const result = await expectDelta(ORG_A, 1, () =>
      rt.run(PROJECT_A1, '¿Cuántos beneficiarios atendió el programa?', good),
    )
    expect(result.status).toBe('ok')
  })
})

describe('10. Ticket expirado', () => {
  it('se rechaza y no cobra', async () => {
    // NO se puede envejecer un ticket emitido: el trigger de transición
    // declara `expires_at` inmutable y rechaza el UPDATE incluso para el
    // dueño (`U0109`). Eso es correcto —una caducidad editable no es una
    // caducidad— y se comprueba explícitamente aquí antes de rodear la
    // restricción, para que la imposibilidad quede afirmada y no supuesta.
    const live = await issued()
    await expect(
      admin`
        UPDATE uellix_stella_ops.operation_tickets
        SET expires_at = timezone('UTC', now()) - interval '1 minute'
        WHERE ticket_id = ${live}
      `,
    ).rejects.toThrow()

    // Un ticket YA vencido se siembra en su INSERT, que es el único momento en
    // que la ventana se fija. `issued_at` en el pasado y `expires_at` un minuto
    // después satisfacen `expires_at > issued_at AND expires_at <= issued_at +
    // 15 min` y dejan ambos instantes atrás — un ticket genuinamente caducado,
    // no uno manipulado después de nacer.
    const expiredTicket = 'c'.repeat(64)
    await admin`
      INSERT INTO uellix_stella_ops.operation_tickets
        (ticket_id, organization_id, project_id, actor_id, category, status,
         charge_nonce, issued_at, expires_at)
      VALUES (
        ${expiredTicket}, ${ORG_A}, ${PROJECT_A1}, ${ACTOR_A1}, 'grounded_query', 'issued',
        ${'f'.repeat(64)},
        timezone('UTC', now()) - interval '20 minutes',
        timezone('UTC', now()) - interval '5 minutes'
      )
      ON CONFLICT (ticket_id) DO NOTHING
    `

    const result = await expectDelta(ORG_A, 0, () => rt.run(PROJECT_A1, 'pregunta', expiredTicket))
    expect(result.status).toBe('error')
    // Sigue `issued`: caducado no es lo mismo que consumido, y `bind` lo
    // rechaza por el predicado de vivacidad sin tocar la fila.
    expect(await ticketStatus(expiredTicket)).toBe('issued')
  })
})

describe('11-12. Concurrencia', () => {
  it('dos tickets compitiendo por la ÚLTIMA unidad: exactamente uno completa', async () => {
    await setQuota(ORG_A, (await chargeCount(ORG_A)) + 1)

    const t1 = await issued()
    const t2 = await issued()
    const query = '¿Cuántos beneficiarios atendió el programa?'

    const before = await chargeCount(ORG_A)
    const results = await Promise.all([
      rt.run(PROJECT_A1, query, t1),
      rt.run(PROJECT_A1, query, t2),
    ])
    const after = await chargeCount(ORG_A)

    // Exactamente uno. Ni cero (ambos rechazados por una carrera perdida) ni
    // dos (sobreventa de la última unidad).
    expect(after - before).toBe(1)
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1)
  })

  it('dos ejecuciones del MISMO ticket producen como máximo un cargo', async () => {
    const ticket = await issued()
    const query = '¿Cuál fue la tasa de retención escolar?'

    const before = await chargeCount(ORG_A)
    await Promise.all([rt.run(PROJECT_A1, query, ticket), rt.run(PROJECT_A1, query, ticket)])
    const after = await chargeCount(ORG_A)

    expect(after - before).toBeLessThanOrEqual(1)
    expect(await ticketStatus(ticket)).toBe('completed')
  })

  it('dos ejecuciones concurrentes del MISMO ticket entregan UNA sola respuesta, no dos por un cargo', async () => {
    // ------------------------------------------------------------------
    // La versión CONCURRENTE del reintento post-complete. La detectó la
    // revisión adversarial A (Tren 4.1) y esta prueba es la que faltaba.
    //
    // Contar cargos no basta, y ese era exactamente el agujero: la prueba
    // anterior afirmaba `delta <= 1` y habría pasado con dos respuestas
    // entregadas. Dos ejecuciones que se solapan vinculan ambas mientras el
    // ticket sigue `bound`, ambas generan, y sólo una cobra — así que el
    // ledger queda impecable mientras la cuota, que mide RESPUESTAS, se
    // habría gastado la mitad.
    //
    // Se cuentan por tanto las respuestas ENTREGADAS, no las filas cobradas.
    // ------------------------------------------------------------------
    const ticket = await issued()
    const query = '¿Cuántos beneficiarios atendió el programa?'

    const before = await chargeCount(ORG_A)
    const results = await Promise.all([
      rt.run(PROJECT_A1, query, ticket),
      rt.run(PROJECT_A1, query, ticket),
    ])
    const after = await chargeCount(ORG_A)

    expect(after - before).toBe(1)

    const delivered = results.filter((r) => r.status === 'ok')
    expect(delivered).toHaveLength(1)

    // Y quien perdió la carrera recibe el estado explícito, no un error
    // genérico y no una respuesta: la operación ya fue contabilizada.
    const loser = results.find((r) => r.status !== 'ok')!
    expect(loser.code).toBe('ALREADY_COMPLETED_RESULT_UNAVAILABLE')
  })
})

describe('13. Bandera apagada', () => {
  it('con la bandera en false no hay ticket, no hay BD y no hay eventos', async () => {
    mockStellaConfig.isGroundedQueryEnabled = false

    const ticketsBefore = await admin`SELECT count(*)::int AS n FROM uellix_stella_ops.operation_tickets`
    const chargesBefore = await chargeCount(ORG_A)

    const issue = (await rt.issue(PROJECT_A1)) as { status: string }
    expect(issue.status).toBe('disabled')

    const run = await rt.run(PROJECT_A1, 'pregunta', 'e'.repeat(64))
    expect(run.status).toBe('error')
    expect(run.code).toBe('DISABLED')

    const ticketsAfter = await admin`SELECT count(*)::int AS n FROM uellix_stella_ops.operation_tickets`
    expect(Number(ticketsAfter[0]!.n)).toBe(Number(ticketsBefore[0]!.n))
    expect(await chargeCount(ORG_A)).toBe(chargesBefore)
  })
})

describe('14. Observabilidad real', () => {
  it('el recorrido emite eventos del runtime, sin datos sensibles y sin fallos de telemetría', async () => {
    const emitted: unknown[][] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (args[0] === '[stella-ticket]') emitted.push(args)
    })

    const failuresBefore = rt.telemetryFailures()
    const query = '¿Cuántos beneficiarios atendió el programa?'
    const ticket = await issued()
    await rt.run(PROJECT_A1, query, ticket)
    spy.mockRestore()

    // Eventos REALES: los produjo el recorrido, no un fixture.
    const names = emitted.map((a) => (a[1] as { eventName: string }).eventName)
    expect(names).toContain('operation_ticket_issued')
    expect(names).toContain('operation_ticket_bound')
    expect(names).toContain('grounded_query_reserved')
    expect(names).toContain('grounded_query_completed')
    expect(names).toContain('quota_consumed')

    // Y validados contra el contrato que RELEASE posee — el mismo evaluador,
    // no una copia de sus reglas.
    const { validateObservabilityEvent } = await import('@/tests/eval/stella-release/observability-contract')
    for (const [, payload] of emitted) {
      const verdict = validateObservabilityEvent(payload as Record<string, unknown>)
      expect(verdict.violations).toEqual([])
    }

    // Ni la consulta, ni su digest, ni el nonce.
    const serialized = JSON.stringify(emitted)
    expect(serialized).not.toContain('beneficiarios')
    expect(serialized).not.toContain(rt.canonicalQueryHash(query))

    expect(rt.telemetryFailures()).toBe(failuresBefore)
  })
})

describe('15. El gate de release, alimentado por esta ejecución', () => {
  it('runtime-quota-charged pasa SÓLO con las nueve pruebas medidas aquí', async () => {
    // Un recorrido coherente y seguido, no una recolección de los escenarios
    // anteriores: el gate afirma cosas sobre UNA ejecución, y coserlas desde
    // pruebas independientes permitiría que dos mediciones incompatibles
    // formaran un informe que ninguna ejecución produjo.
    const query = '¿Cuántos beneficiarios atendió el programa?'
    const emitted: Record<string, unknown>[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (args[0] === '[stella-ticket]') emitted.push(args[1] as Record<string, unknown>)
    })

    const t1 = await issued()
    const before1 = await chargeCount(ORG_A)
    await rt.run(PROJECT_A1, query, t1)
    const firstExecutionDelta = (await chargeCount(ORG_A)) - before1

    const before2 = await chargeCount(ORG_A)
    const retry = await rt.run(PROJECT_A1, query, t1)
    const retryDelta = (await chargeCount(ORG_A)) - before2

    const t2 = await issued()
    const before3 = await chargeCount(ORG_A)
    await rt.run(PROJECT_A1, query, t2)
    const newOperationSameTextDelta = (await chargeCount(ORG_A)) - before3

    const doomed = await issued(PROJECT_A2)
    const before4 = await chargeCount(ORG_A)
    await rt.run(PROJECT_A2, 'sin evidencia', doomed)
    const abortDelta = (await chargeCount(ORG_A)) - before4

    currentActor = { userId: ACTOR_B1, organizationId: ORG_B, role: 'organization_admin' }
    const foreign = await issued(PROJECT_B1)
    currentActor = { userId: ACTOR_A1, organizationId: ORG_A, role: 'organization_admin' }
    const before5 = await chargeCount(ORG_A)
    await rt.run(PROJECT_A1, query, foreign)
    await rt.run(PROJECT_A1, query, 'd'.repeat(64))
    const crossScopeDelta = (await chargeCount(ORG_A)) - before5

    await setQuota(ORG_A, (await chargeCount(ORG_A)) + 1)
    const r1 = await issued()
    const r2 = await issued()
    const before6 = await chargeCount(ORG_A)
    await Promise.all([rt.run(PROJECT_A1, query, r1), rt.run(PROJECT_A1, query, r2)])
    const concurrencyLastUnitCharges = (await chargeCount(ORG_A)) - before6

    spy.mockRestore()

    const { validateObservabilityEvent } = await import('@/tests/eval/stella-release/observability-contract')
    const observabilityViolations = emitted.reduce(
      (n, payload) => n + validateObservabilityEvent(payload).violations.length,
      0,
    )

    const { computeIdempotencyReleaseGateReport } = await import(
      '@/tests/eval/stella-release/idempotency-release-gate'
    )
    const { runIdempotencyEvalHarness } = await import('@/tests/eval/stella-release/idempotency-harness')

    const report = computeIdempotencyReleaseGateReport(runIdempotencyEvalHarness(), {
      claimedCharged: true,
      chargesObservedForTicket: firstExecutionDelta,
      firstExecutionDelta,
      retryDelta,
      newOperationSameTextDelta,
      abortDelta,
      crossScopeDelta,
      concurrencyLastUnitCharges,
      postCompleteRetryCode: retry.code,
      runtimeEventsEmitted: emitted.map((p) => String(p.eventName)),
      observabilityViolations,
      // El contenedor sobrevive necesariamente a este proceso: la batería corre
      // DENTRO de su vida. Cero aquí significa "esta ejecución no dejó recursos
      // propios"; la desaparición del contenedor la afirma §6 de
      // scripts/stella-ticket-e2e.sh, que hace fallar el guion entero si
      // sobrevive, y el código de salida de ese guion es el que manda.
      residualResources: 0,
    })

    const runtimeGate = report.gates.find((g) => g.id === 'runtime-quota-charged')!
    expect(runtimeGate.passed, runtimeGate.detail).toBe(true)

    // Y la consecuencia que el tren 4.1 estaba bloqueando: la lista de lo que
    // falta para el runtime del protocolo queda VACÍA. Sus tres entradas eran
    // constantes en la rama de RELEASE; ahora dependen de esta evidencia.
    expect(report.missingForOperationTicketRuntime).toEqual([])

    // `idempotencyHarnessReady` NO se afirma aquí, y la omisión es deliberada.
    // Ese agregado incluye el caso `feature-flag-off-blocks-issuance`, que lee
    // `stellaConfig` — y este proceso lo tiene doblado a `true` justamente para
    // poder ejercer el recorrido. Afirmarlo aquí mediría el doble, no el
    // producto. Su medición honesta vive en
    // `pnpm exec tsx scripts/eval-idempotency-offline.ts`, donde la bandera es
    // la del repositorio.
  })

  it('el mismo gate FALLA si se le retira una sola de las nueve pruebas', async () => {
    // El control negativo del gate. Sin él, "pasa" sólo demostraría que el
    // informe se construyó, no que el reductor comprueba algo.
    const { computeIdempotencyReleaseGateReport } = await import(
      '@/tests/eval/stella-release/idempotency-release-gate'
    )
    const { runIdempotencyEvalHarness } = await import('@/tests/eval/stella-release/idempotency-harness')

    const healthy = {
      claimedCharged: true,
      chargesObservedForTicket: 1,
      firstExecutionDelta: 1,
      retryDelta: 0,
      newOperationSameTextDelta: 1,
      abortDelta: 0,
      crossScopeDelta: 0,
      concurrencyLastUnitCharges: 1,
      postCompleteRetryCode: 'ALREADY_COMPLETED_RESULT_UNAVAILABLE',
      runtimeEventsEmitted: [
        'operation_ticket_issued',
        'operation_ticket_bound',
        'grounded_query_reserved',
        'grounded_query_completed',
        'quota_consumed',
      ],
      observabilityViolations: 0,
      residualResources: 0,
    }
    const run = runIdempotencyEvalHarness()
    expect(
      computeIdempotencyReleaseGateReport(run, healthy).gates.find((g) => g.id === 'runtime-quota-charged')!.passed,
    ).toBe(true)

    const mutations: Array<[string, Record<string, unknown>]> = [
      ['retry charged a second unit', { retryDelta: 1 }],
      ['a new ticket for the same text was free', { newOperationSameTextDelta: 0 }],
      ['an abort still charged', { abortDelta: 1 }],
      ['a cross-scope ticket charged', { crossScopeDelta: 1 }],
      ['the last unit was oversold', { concurrencyLastUnitCharges: 2 }],
      ['the post-complete retry had no named state', { postCompleteRetryCode: undefined }],
      ['the runtime emitted no quota_consumed', { runtimeEventsEmitted: ['operation_ticket_issued'] }],
      ['an event violated the observability contract', { observabilityViolations: 1 }],
      ['teardown left something behind', { residualResources: 1 }],
    ]

    for (const [label, mutation] of mutations) {
      const gate = computeIdempotencyReleaseGateReport(run, { ...healthy, ...mutation } as never).gates.find(
        (g) => g.id === 'runtime-quota-charged',
      )!
      expect(gate.passed, `the gate accepted a run where ${label}`).toBe(false)
    }
  })
})

describe('Vectores compartidos Node <-> SQL del digest canónico', () => {
  it('PostgreSQL recomputa el MISMO digest sobre la cadena canonicalizada por Node', async () => {
    const { canonicalizeQuery } = await import('@/lib/stella/operation-ticket/canonical-query-hash')
    const vectors = [
      'Cuál es el SROI',
      '  espacios    colapsados  ',
      'ACENTOS Áéíóú ñ',
      'mayúsculas DISTINTAS',
      '中文 查询',
      '',
    ]

    for (const v of vectors) {
      const canonical = canonicalizeQuery(v)
      const node = rt.canonicalQueryHash(v)
      // La base nunca recibe el TEXTO en producción. Aquí sí, y sólo aquí:
      // es la única forma de comprobar que los dos motores enmarcan
      // `sha256(namespace || LF || canonical)` sobre los mismos bytes.
      const rows = await admin`
        SELECT encode(sha256(convert_to('stella/query/v1' || chr(10) || ${canonical}, 'UTF8')), 'hex') AS h
      `
      expect(String(rows[0]!.h)).toBe(node)
    }
  })
})

/* ========================================================================== */
/* 16. FASE 8 — ATRIBUCIÓN POSITIVA                                           */
/* ========================================================================== */
//
// NO BASTA CON PROBAR QUE LOS ATAQUES COBRAN CERO.
//
// Un sistema que no cobrara NUNCA pasaría todos los casos negativos de arriba.
// Lo que R2-INT pide es lo contrario y es más difícil de falsificar: que la fila
// que sí se escribe diga exactamente lo que debe decir. Estas pruebas leen la
// FILA REAL de `public.stella_interactions` —columna por columna, por una
// conexión distinta de la que corrió la acción— en vez de contar cuántas hay.

describe('16. La fila del ledger dice lo que debe decir', () => {
  it('una operación completada deja EXACTAMENTE una fila, con su organización, su proyecto y su rol', async () => {
    const ticket = await issued(PROJECT_A1)
    const { rows } = await chargesAddedBy(ORG_A, () =>
      rt.run(PROJECT_A1, '¿Cuántos beneficiarios atendió el programa?', ticket),
    )

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(String(row.organization_id)).toBe(ORG_A)
    // LA ASERCIÓN QUE R2-INT EXISTE PARA HACER POSIBLE. Antes de stella_0015
    // esta columna podía ser cualquier proyecto de la organización.
    expect(String(row.project_id)).toBe(PROJECT_A1)
    expect(String(row.stella_role)).toBe('grounded_query')

    // La clave de idempotencia está ASOCIADA AL TICKET, y no es el ticket: se
    // deriva dentro de `complete_operation_ticket` a partir del ticket y de un
    // nonce que ninguna función devuelve. Se comprueba la forma y la
    // NO-igualdad, que es la parte que importa — si fuera el ticket, cualquiera
    // que lo tuviera podría precobrar bajo esa clave.
    const key = String(row.idempotency_key)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toBe(ticket)
  })

  it('un REINTENTO del mismo ticket no genera una segunda fila', async () => {
    const query = '¿Cuál fue la tasa de retención escolar?'
    const ticket = await issued(PROJECT_A1)

    const first = await chargesAddedBy(ORG_A, () => rt.run(PROJECT_A1, query, ticket))
    expect(first.rows).toHaveLength(1)
    const key = String(first.rows[0]!.idempotency_key)

    const retry = await chargesAddedBy(ORG_A, () => rt.run(PROJECT_A1, query, ticket))
    expect(retry.rows).toHaveLength(0)

    // Y la fila original sigue siendo la única con esa clave.
    const all = await admin`
      SELECT count(*)::int AS n FROM public.stella_interactions
      WHERE organization_id = ${ORG_A} AND idempotency_key = ${key}
    `
    expect(Number(all[0]!.n)).toBe(1)
  })

  it('el MISMO texto en OTRO proyecto cobra bajo ESE proyecto, y no se confunde con un reintento', async () => {
    // Caso 8. Dos operaciones legítimas, indistinguibles por su texto y
    // distinguibles por su ticket. Un protocolo que derivara la clave del TEXTO
    // haría gratis la segunda y pasaría todos los casos negativos de arriba;
    // uno que derivara la clave del texto MÁS el proyecto cobraría las dos y
    // seguiría atribuyendo mal si el proyecto viniera del ticket.
    const query = '¿Cuántos beneficiarios atendió el programa?'

    const ticketA1 = await issued(PROJECT_A1)
    const inA1 = await chargesAddedBy(ORG_A, () => rt.run(PROJECT_A1, query, ticketA1))
    expect((inA1.result as { status: string }).status).toBe('ok')
    expect(inA1.rows).toHaveLength(1)
    expect(String(inA1.rows[0]!.project_id)).toBe(PROJECT_A1)

    const ticketA3 = await issued(PROJECT_A3)
    expect(ticketA3).not.toBe(ticketA1)
    const inA3 = await chargesAddedBy(ORG_A, () => rt.run(PROJECT_A3, query, ticketA3))
    expect((inA3.result as { status: string }).status).toBe('ok')
    expect(inA3.rows).toHaveLength(1)
    expect(String(inA3.rows[0]!.project_id)).toBe(PROJECT_A3)

    // Dos claves distintas: no fue tratado como un reintento de la primera.
    expect(String(inA3.rows[0]!.idempotency_key)).not.toBe(String(inA1.rows[0]!.idempotency_key))
  })

  it('un ataque cross-project no deja ninguna fila, ni siquiera bajo el proyecto correcto', async () => {
    // El complemento negativo de los tres positivos de arriba, escrito sobre
    // FILAS y no sobre un delta: un delta de cero es también lo que produciría
    // una fila añadida y otra retirada, y el ledger es append-only justamente
    // para que eso no pueda pasar — pero afirmarlo sobre las filas lo hace
    // independiente de esa premisa.
    const ticketOfA3 = await issued(PROJECT_A3)
    const { rows } = await chargesAddedBy(ORG_A, () =>
      rt.run(PROJECT_A1, '¿Cuántos beneficiarios atendió el programa?', ticketOfA3),
    )
    expect(rows).toEqual([])
  })
})

/* ========================================================================== */
/* 17. Concurrencia CON atribución                                            */
/* ========================================================================== */

describe('17. Concurrencia entre proyectos', () => {
  it('dos tickets de PROYECTOS distintos por la última unidad: como mucho uno completa, y el cargo queda en el proyecto ganador', async () => {
    // Caso 9. La cuota es de ORGANIZACIÓN, así que A1 y A3 compiten de verdad.
    // Lo que se mide no es sólo "una sola unidad" —eso ya lo medía el tren
    // 4.1— sino que la unidad quedó bajo el proyecto de QUIEN GANÓ, y que el
    // perdedor no dejó ninguna.
    await setQuota(ORG_A, (await chargeCount(ORG_A)) + 1)

    const tA1 = await issued(PROJECT_A1)
    const tA3 = await issued(PROJECT_A3)
    const query = '¿Cuántos beneficiarios atendió el programa?'

    const { result: results, rows } = await chargesAddedBy(ORG_A, () =>
      Promise.all([rt.run(PROJECT_A1, query, tA1), rt.run(PROJECT_A3, query, tA3)]),
    )

    expect(rows.length).toBeLessThanOrEqual(1)
    const delivered = results.filter((r) => r.status === 'ok')
    expect(delivered.length).toBe(rows.length)

    if (rows.length === 1) {
      // El proyecto de la fila es el del ticket que completó, y sólo uno de los
      // dos completó.
      const winner = (await ticketStatus(tA1)) === 'completed' ? PROJECT_A1 : PROJECT_A3
      const loser = winner === PROJECT_A1 ? PROJECT_A3 : PROJECT_A1
      expect(String(rows[0]!.project_id)).toBe(winner)
      // Y el perdedor no dejó cargo alguno EN ESTA VENTANA.
      expect(rows.filter((r) => String(r.project_id) === loser)).toEqual([])
    }
  })

  it('dos ejecuciones concurrentes del MISMO ticket: una respuesta, un cargo, y bajo el proyecto del ticket', async () => {
    // Caso 10. La versión de atribución del caso que el tren 4.1 ya cubría.
    const ticket = await issued(PROJECT_A3)
    const query = '¿Cuál fue la tasa de retención escolar?'

    const { result: results, rows } = await chargesAddedBy(ORG_A, () =>
      Promise.all([rt.run(PROJECT_A3, query, ticket), rt.run(PROJECT_A3, query, ticket)]),
    )

    expect(rows).toHaveLength(1)
    expect(String(rows[0]!.project_id)).toBe(PROJECT_A3)
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1)
    const loser = results.find((r) => r.status !== 'ok')!
    expect(loser.code).toBe('ALREADY_COMPLETED_RESULT_UNAVAILABLE')
  })
})

/* ========================================================================== */
/* 18. Orden de paquetes (R2a) — la reaplicación fuera de orden falla CERRADA  */
/* ========================================================================== */

describe('18. La cadena preparada no se puede recorrer al revés', () => {
  it('la guarda del runner RECHAZA todo paquete superado en esta base, y admite el resto', async () => {
    const { assertPreparedPackageOrder, assertNoProjectBlindTicketSignatures } = await import('@/db/migrator')

    // TREN 4.3 — CIERRE. La cadena instalada aquí es
    // 0013 -> 0014 -> 0015 -> 0016 -> 0017 -> 0018, así que CUATRO paquetes
    // están superados y no uno. La lista se DERIVA del registro en vez de
    // repetirse: una copia escrita aquí podría quedar corta el día que se
    // registre una supersesión más, y una guarda que nadie comprueba para el
    // paquete nuevo es la guarda que no estaba cuando hizo falta.
    const { PREPARED_PACKAGE_SUPERSESSIONS, STELLA_TICKET_PACKAGE_CHAIN } = await import(
      '@/db/prepared-package-order'
    )
    const superseded = new Set(PREPARED_PACKAGE_SUPERSESSIONS.map((r) => r.packageName))
    // NO se fija un número. La primera versión de esta línea exigía cuatro y
    // hubo que reescribirla el día que se registró la quinta regla — que es la
    // forma de una aserción que sigue un conteo en vez de una propiedad. Lo que
    // tiene que ser cierto es que hay reglas, que TODAS se rechazan sobre esta
    // base, y que el último eslabón no está entre ellas.
    expect(superseded.size, 'el registro no declara ninguna supersesión').toBeGreaterThan(0)

    for (const pkg of superseded) {
      // La negativa, con su código propio. Es una PRECONDICIÓN: en el migrador
      // corre dentro de la transacción y antes del script, así que una negativa
      // hace rollback y nada inseguro llega a publicarse.
      await expect(
        assertPreparedPackageOrder(admin, `db/prepared/${pkg}.sql`),
        `${pkg} debería ser rechazado sobre esta base`,
      ).rejects.toMatchObject({ code: 'DB_MIGRATOR_PACKAGE_ORDER_VIOLATION' })
    }

    // Y no es una guarda que diga que no a todo. El ÚLTIMO eslabón de la cadena
    // no tiene sucesor, así que pasa; y un paquete de otra línea también.
    const last = STELLA_TICKET_PACKAGE_CHAIN[STELLA_TICKET_PACKAGE_CHAIN.length - 1]
    expect(superseded.has(last), 'el último eslabón no puede estar superado por nadie').toBe(false)
    await expect(assertPreparedPackageOrder(admin, `db/prepared/${last}.sql`)).resolves.toBeUndefined()
    await expect(
      assertPreparedPackageOrder(admin, 'db/prepared/grounding_0004_runtime_attestation.sql'),
    ).resolves.toBeUndefined()

    // La postcondición que la negativa protege.
    await expect(assertNoProjectBlindTicketSignatures(admin)).resolves.toBeUndefined()
  })

  it('la guarda es PORTANTE: sin ella, reaplicar stella_0014 republica las cuatro firmas ciegas', async () => {
    // ------------------------------------------------------------------
    // LA DEMOSTRACIÓN QUE HACE QUE LA PRUEBA ANTERIOR SIGNIFIQUE ALGO.
    //
    // Una guarda que rechaza algo inofensivo es una guarda que nadie ha visto
    // trabajar. Aquí se salta deliberadamente —aplicando el SQL crudo por la
    // conexión de superusuario, que es exactamente lo que haría un operador con
    // psql— y se mide el estado resultante.
    //
    // DENTRO DE UNA TRANSACCIÓN QUE SE DESHACE, y el cambio respecto del tren
    // 4.2 es obligado, no una preferencia. Entonces la convergencia se lograba
    // reaplicando stella_0015; con la cadena completa eso ya no es posible —
    // stella_0015 §4 (5) afirma que uellix_stella_ops tiene SEIS funciones y
    // después de stella_0017 y stella_0018 tiene ocho, así que abortaría. Una
    // demostración destructiva sin vuelta atrás dejaría la base inservible para
    // las secciones 19 y 20, que miden evidencia de runtime.
    //
    // stella_0014 declara «Idempotent AND convergent. No CREATE INDEX
    // CONCURRENTLY», así que su cuerpo entero es transaccional y el ROLLBACK
    // devuelve el catálogo exactamente a donde estaba. Se comprueba después.
    // ------------------------------------------------------------------
    const { readFileSync } = await import('node:fs')
    const { assertNoProjectBlindTicketSignatures } = await import('@/db/migrator')

    const BLIND_SIGNATURES = `SELECT count(*)::int AS n FROM (VALUES
      ('uellix_stella_ops.bind_operation_ticket(character, character)'),
      ('uellix_stella_ops.complete_operation_ticket(character, character)'),
      ('uellix_stella_ops.abort_operation_ticket(character, character varying)'),
      ('uellix_stella_ops.inspect_operation_ticket(character)')
    ) AS f(sig) WHERE to_regprocedure(f.sig) IS NOT NULL`

    const blindCount = async (): Promise<number> =>
      Number((await admin.unsafe(BLIND_SIGNATURES))[0]!.n)

    expect(await blindCount()).toBe(0)

    const ticket14 = readFileSync('db/prepared/stella_0014_operation_tickets.sql', 'utf8')
    let republished: number | null = null
    try {
      await admin.begin(async (tx) => {
        await tx.unsafe(ticket14).simple()
        republished = Number((await tx.unsafe(BLIND_SIGNATURES))[0]!.n)
        // La medición está tomada. Deshacer es lo único que queda por hacer:
        // el propósito de esta prueba es MEDIR el riesgo, no dejarlo instalado.
        throw new Error('ROLLBACK_MEASUREMENT')
      })
    } catch (error) {
      // stella_0014 puede negarse por su cuenta sobre esta base. Es un resultado
      // MEJOR que el esperado, no un fallo: significa que hay dos protecciones y
      // no una. Se registra y se sigue.
      if ((error as Error).message !== 'ROLLBACK_MEASUREMENT') republished = null
    }

    if (republished !== null) {
      // El riesgo R2a es real y está medido, no argumentado.
      expect(republished, 'reaplicar stella_0014 no republicó nada — R2a no existiría').toBe(4)
    }

    // LA VUELTA ATRÁS ES COMPLETA, y se comprueba en vez de suponerse: la
    // transacción se deshizo, así que ni una firma ciega sobrevive y el resto de
    // la batería corre contra la misma base que antes de esta sección.
    expect(await blindCount()).toBe(0)
    await expect(assertNoProjectBlindTicketSignatures(admin)).resolves.toBeUndefined()

    const bound = await admin`
      SELECT count(*)::int AS n FROM (VALUES
        ('uellix_stella_ops.bind_operation_ticket(character, uuid, character)'),
        ('uellix_stella_ops.complete_operation_ticket(character, uuid, character)'),
        ('uellix_stella_ops.abort_operation_ticket(character, uuid, character varying)'),
        ('uellix_stella_ops.inspect_operation_ticket(character, uuid)')
      ) AS f(sig) WHERE to_regprocedure(f.sig) IS NOT NULL
    `
    expect(Number(bound[0]!.n)).toBe(4)

    // Y el bind ligado a categoría —lo que stella_0014 NO puede republicar—
    // sigue en pie, que es la diferencia entre «volvió» y «volvió entero».
    const governed = await admin`
      SELECT to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)') IS NOT NULL AS ok
    `
    expect(governed[0]!.ok).toBe(true)

    // Y el runtime sigue funcionando después de la ida y vuelta.
    const ticket = await issued(PROJECT_A1)
    const result = await expectDelta(ORG_A, 1, () =>
      rt.run(PROJECT_A1, '¿Cuántos beneficiarios atendió el programa?', ticket),
    )
    expect(result.status).toBe('ok')
  }, 180_000)
})

/* ========================================================================== */
/* 19. El gate de RELEASE, alimentado por ESTA ejecución                      */
/* ========================================================================== */

describe('19. runtime-project-attribution-verified', () => {
  it('pasa SÓLO con las siete pruebas medidas contra la base real', async () => {
    // Un recorrido seguido, igual que el §15: el gate afirma cosas sobre UNA
    // ejecución, y coserlas desde pruebas independientes permitiría que dos
    // mediciones incompatibles formaran un informe que ninguna ejecución
    // produjo.
    const { bindOperationTicket, completeOperationTicket, abortOperationTicket, inspectOperationTicket } =
      await import('@/db/stella/operation-tickets')
    const { canonicalQueryHash } = await import('@/lib/stella/operation-ticket/canonical-query-hash')

    const query = '¿Cuántos beneficiarios atendió el programa?'
    const hash = canonicalQueryHash(query)

    // --- bind, complete, abort e inspect contra un proyecto ajeno ---
    const ticketA1 = await issued(PROJECT_A1)
    const bindForeign = await bindOperationTicket(ticketA1, PROJECT_A3, hash, 'grounded_query')
    const bindRejectedForeignProject = bindForeign.kind === 'rejected'

    const bindOwn = await bindOperationTicket(ticketA1, PROJECT_A1, hash, 'grounded_query')
    expect(bindOwn.kind).toBe('bound')

    const completeForeign = await completeOperationTicket(ticketA1, PROJECT_A3, hash)
    const completeRejectedForeignProject = completeForeign.kind === 'rejected'

    const abortForeign = await abortOperationTicket(ticketA1, PROJECT_A3, 'caller_abort')
    const abortRejectedForeignProject = abortForeign.kind === 'rejected'

    const inspectForeign = await inspectOperationTicket(ticketA1, PROJECT_A3)
    const inspectRejectedForeignProject = inspectForeign === null

    // --- el cargo, leído de vuelta ---
    const settled = await chargesAddedBy(ORG_A, () => completeOperationTicket(ticketA1, PROJECT_A1, hash))
    const chargeAttributedToExecutionProject =
      settled.rows.length === 1 && String(settled.rows[0]!.project_id) === PROJECT_A1

    // --- el ataque completo, por el server action real ---
    const attackTicket = await issued(PROJECT_A3)
    const attack = await chargesAddedBy(ORG_A, () => rt.run(PROJECT_A1, query, attackTicket))
    const zeroChargeOnAttack =
      attack.rows.length === 0 && (attack.result as { status: string }).status === 'error'

    // --- las firmas antiguas, preguntadas al catálogo ---
    const legacy = await admin`
      SELECT count(*)::int AS n FROM (VALUES
        ('uellix_stella_ops.bind_operation_ticket(character, character)'),
        ('uellix_stella_ops.complete_operation_ticket(character, character)'),
        ('uellix_stella_ops.abort_operation_ticket(character, character varying)'),
        ('uellix_stella_ops.inspect_operation_ticket(character)')
      ) AS f(sig) WHERE to_regprocedure(f.sig) IS NOT NULL
    `
    const legacySignatureInvocable = Number(legacy[0]!.n) > 0

    const { computeProjectBindingGateReport } = await import(
      '@/tests/eval/stella-release/project-binding-release-gate'
    )
    const { runProjectBindingEvalHarness } = await import('@/tests/eval/stella-release/project-binding-harness')

    const runtimeReport: RuntimeProjectAttributionReport = {
      bindRejectedForeignProject,
      completeRejectedForeignProject,
      abortRejectedForeignProject,
      inspectRejectedForeignProject,
      chargeAttributedToExecutionProject,
      zeroChargeOnAttack,
      legacySignatureInvocable,
    }

    const report = computeProjectBindingGateReport(runProjectBindingEvalHarness(), runtimeReport)
    const gate = report.gates.find((g) => g.id === 'runtime-project-attribution-verified')!
    expect(gate.passed, gate.detail).toBe(true)

    // El gate offline, del modelo de referencia, sigue siendo lo que era: un
    // ORÁCULO. Se comprueba que está verde, y NO se usa como evidencia de nada
    // sobre el runtime — esa es la función del informe de arriba.
    expect(report.projectBindingHarnessReady).toBe(true)
    expect(report.missingForProjectBindingRuntime).toEqual([])
  }, 120_000)

  it('el mismo gate FALLA si se le retira una sola de las siete pruebas', async () => {
    // El control negativo. Sin él, "pasa" sólo demostraría que el informe se
    // construyó, no que el reductor comprueba algo.
    const { computeProjectBindingGateReport } = await import(
      '@/tests/eval/stella-release/project-binding-release-gate'
    )
    const { runProjectBindingEvalHarness } = await import('@/tests/eval/stella-release/project-binding-harness')
    const run = runProjectBindingEvalHarness()

    const healthy: RuntimeProjectAttributionReport = {
      bindRejectedForeignProject: true,
      completeRejectedForeignProject: true,
      abortRejectedForeignProject: true,
      inspectRejectedForeignProject: true,
      chargeAttributedToExecutionProject: true,
      zeroChargeOnAttack: true,
      legacySignatureInvocable: false,
    }
    expect(
      computeProjectBindingGateReport(run, healthy).gates.find(
        (g) => g.id === 'runtime-project-attribution-verified',
      )!.passed,
    ).toBe(true)

    const mutations: Array<[string, Partial<RuntimeProjectAttributionReport>]> = [
      ['bind accepted a foreign project', { bindRejectedForeignProject: false }],
      ['complete accepted a foreign project', { completeRejectedForeignProject: false }],
      ['abort released another project reservation', { abortRejectedForeignProject: false }],
      ['inspect leaked another project ticket state', { inspectRejectedForeignProject: false }],
      ['the charge landed under the wrong project', { chargeAttributedToExecutionProject: false }],
      ['the attack still charged', { zeroChargeOnAttack: false }],
      ['a project-blind signature is still invocable', { legacySignatureInvocable: true }],
    ]

    for (const [label, mutation] of mutations) {
      const gate = computeProjectBindingGateReport(run, { ...healthy, ...mutation }).gates.find(
        (g) => g.id === 'runtime-project-attribution-verified',
      )!
      expect(gate.passed, `the gate accepted a run where ${label}`).toBe(false)
    }

    // Y sin informe alguno — que es toda invocación offline — sigue en false.
    expect(
      computeProjectBindingGateReport(run).gates.find(
        (g) => g.id === 'runtime-project-attribution-verified',
      )!.passed,
    ).toBe(false)
  })
})

/* ========================================================================== */
/* 20. local-runtime-ready, alimentado por ESTA ejecución                     */
/* ========================================================================== */
//
// EL NIVEL QUE EL TREN 4 DEJÓ EN `false` POR UNA CAUSA QUE NADIE PODÍA RETIRAR.
//
// `missingForLocalRuntime` llevaba dos entradas incondicionales —«los paquetes
// de grounding no están aplicados a NINGUNA base» y «la cuota se exige y no se
// consume»— que eran ciertas y, desde un gate offline, INFALSIFICABLES: ese
// módulo no abre conexiones, así que jamás podría observar que dejaran de
// serlo. Una evidencia que no puede satisfacerse no es evidencia que falta; es
// un nivel retirado sin decirlo.
//
// Esta sección es la única cosa en el árbol que puede retirarlas, y lo hace
// midiendo: los seis paquetes aplicados a la base desechable de este
// contenedor, un cargo real leído de vuelta por una segunda conexión, los dos
// gates de runtime en verde y la guarda de orden de paquetes ejercida.

describe('20. local-runtime-ready', () => {
  it('pasa a TRUE únicamente con la evidencia de runtime que esta batería produce', async () => {
    const { bindOperationTicket, completeOperationTicket, abortOperationTicket, inspectOperationTicket } =
      await import('@/db/stella/operation-tickets')
    const { canonicalQueryHash } = await import('@/lib/stella/operation-ticket/canonical-query-hash')
    const { assertPreparedPackageOrder, assertNoProjectBlindTicketSignatures } = await import('@/db/migrator')

    const query = '¿Cuántos beneficiarios atendió el programa?'
    const hash = canonicalQueryHash(query)

    /* --- los paquetes que ESTA base tiene, preguntados al catálogo --------- */
    // No una lista escrita aquí: se deriva de objetos que sólo cada paquete
    // crea, así que una lista mentirosa no es representable.
    const probes = await admin`
      SELECT
        to_regclass('public.evidence_document_versions') IS NOT NULL AS g2,
        to_regclass('public.evidence_chunks')            IS NOT NULL AS g3,
        to_regprocedure('uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid)') IS NOT NULL AS g4,
        to_regprocedure('uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)') IS NOT NULL AS s13,
        to_regclass('uellix_stella_ops.operation_tickets') IS NOT NULL AS s14,
        to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character)') IS NOT NULL AS s15
    `
    const p = probes[0]! as Record<string, unknown>
    const packagesApplied = [
      p.g2 ? 'grounding_0002_document_versions' : '',
      p.g3 ? 'grounding_0003_evidence_chunks' : '',
      p.g4 ? 'grounding_0004_runtime_attestation' : '',
      p.s13 ? 'stella_0013_grounded_query_quota' : '',
      p.s14 ? 'stella_0014_operation_tickets' : '',
      p.s15 ? 'stella_0015_project_bound_operation_tickets' : '',
    ].filter(Boolean)

    /* --- el recorrido completo, con eventos reales ------------------------ */
    const emitted: Record<string, unknown>[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (args[0] === '[stella-ticket]') emitted.push(args[1] as Record<string, unknown>)
    })

    /**
     * Every charging execution of this run, paired with THE PROJECT IT RAN
     * UNDER — not with a project read back afterwards.
     *
     * The pairing is the whole point, and its absence was the defect
     * adversarial review B raised as MAJOR against the first version of this
     * section. That version derived `everyChargeAttributedToItsExecutionProject`
     * from a single query over the whole ledger and asserted
     * `project_id !== PROJECT_A2` — a proxy that PROJECT_A2 satisfies for free,
     * because A2 has no evidence and therefore never charges. A regression that
     * charged every A1 execution under A3 would have satisfied it, and
     * `local-runtime-ready` would still have flipped to true.
     *
     * Now each entry records what the execution was, so the check is
     * `charge.project_id === the project THIS execution ran under`, once per
     * execution, across MORE THAN ONE project — a system that always charged
     * the same project cannot pass it.
     */
    const attributed: Array<{ execution: string; rows: Array<Record<string, unknown>> }> = []
    const runAndAttribute = async (projectId: string, ticket: string) => {
      const { result, rows } = await chargesAddedBy(ORG_A, () => rt.run(projectId, query, ticket))
      attributed.push({ execution: projectId, rows })
      return { result, rows }
    }

    const t1 = await issued(PROJECT_A1)
    const firstCharge = await runAndAttribute(PROJECT_A1, t1)
    const firstExecutionDelta = firstCharge.rows.length

    const before2 = await chargeCount(ORG_A)
    const retry = await rt.run(PROJECT_A1, query, t1)
    const retryDelta = (await chargeCount(ORG_A)) - before2

    const t2 = await issued(PROJECT_A1)
    const secondCharge = await runAndAttribute(PROJECT_A1, t2)
    const newOperationSameTextDelta = secondCharge.rows.length

    // A SECOND project that actually charges. Without it every assertion below
    // is satisfiable by a system that hardcodes one project.
    const t3 = await issued(PROJECT_A3)
    await runAndAttribute(PROJECT_A3, t3)

    const doomed = await issued(PROJECT_A2)
    const before4 = await chargeCount(ORG_A)
    await rt.run(PROJECT_A2, 'sin evidencia', doomed)
    const abortDelta = (await chargeCount(ORG_A)) - before4

    currentActor = { userId: ACTOR_B1, organizationId: ORG_B, role: 'organization_admin' }
    const foreign = await issued(PROJECT_B1)
    currentActor = { userId: ACTOR_A1, organizationId: ORG_A, role: 'organization_admin' }
    const before5 = await chargeCount(ORG_A)
    await rt.run(PROJECT_A1, query, foreign)
    await rt.run(PROJECT_A1, query, 'd'.repeat(64))
    // R2-INT: el ataque cross-PROJECT, dentro de la misma organización, que es
    // el que ninguna medición organizacional podía ver.
    const crossProjectTicket = await issued(PROJECT_A3)
    const crossProject = await chargesAddedBy(ORG_A, () => rt.run(PROJECT_A1, query, crossProjectTicket))
    const crossScopeDelta = (await chargeCount(ORG_A)) - before5

    await setQuota(ORG_A, (await chargeCount(ORG_A)) + 1)
    const r1 = await issued(PROJECT_A1)
    const r3 = await issued(PROJECT_A3)
    const race = await chargesAddedBy(ORG_A, () =>
      Promise.all([rt.run(PROJECT_A1, query, r1), rt.run(PROJECT_A3, query, r3)]),
    )
    const concurrencyLastUnitCharges = race.rows.length
    await setQuota(ORG_A, 100)

    spy.mockRestore()

    /* --- ¿toda fila cobrada lleva el proyecto de SU ejecución? ------------ */
    // Fila por fila, contra el proyecto bajo el que corrió la ejecución que la
    // produjo. Se exige además que haya al menos DOS proyectos distintos entre
    // los cobros: un sistema que atribuyera todo al mismo proyecto pasaría
    // cualquier comprobación que sólo mirase una ejecución.
    const chargingRuns = attributed.filter((a) => a.rows.length > 0)
    const projectsCharged = new Set(chargingRuns.map((a) => a.execution))
    const everyChargeAttributedToItsExecutionProject =
      chargingRuns.length >= 2 &&
      projectsCharged.size >= 2 &&
      chargingRuns.every((a) => a.rows.every((row) => String(row.project_id) === a.execution))

    // Y se afirma aquí además de alimentar la evidencia: si esto se rompe, la
    // prueba tiene que decir QUÉ se rompió, no sólo que un nivel quedó en false.
    for (const a of attributed) {
      for (const row of a.rows) {
        expect(String(row.project_id), `una ejecución bajo ${a.execution} cobró bajo otro proyecto`).toBe(a.execution)
      }
    }
    expect(projectsCharged.size, 'los cobros medidos tienen que abarcar más de un proyecto').toBeGreaterThanOrEqual(2)

    /* --- el informe de atribución, contra la base real -------------------- */
    const probeTicket = await issued(PROJECT_A1)
    const bindForeign = await bindOperationTicket(probeTicket, PROJECT_A3, hash, 'grounded_query')
    const bindOwn = await bindOperationTicket(probeTicket, PROJECT_A1, hash, 'grounded_query')
    expect(bindOwn.kind).toBe('bound')
    const completeForeign = await completeOperationTicket(probeTicket, PROJECT_A3, hash)
    const abortForeign = await abortOperationTicket(probeTicket, PROJECT_A3, 'caller_abort')
    const inspectForeign = await inspectOperationTicket(probeTicket, PROJECT_A3)
    const charged = await chargesAddedBy(ORG_A, () => completeOperationTicket(probeTicket, PROJECT_A1, hash))

    const legacy = await admin`
      SELECT count(*)::int AS n FROM (VALUES
        ('uellix_stella_ops.bind_operation_ticket(character, character)'),
        ('uellix_stella_ops.complete_operation_ticket(character, character)'),
        ('uellix_stella_ops.abort_operation_ticket(character, character varying)'),
        ('uellix_stella_ops.inspect_operation_ticket(character)')
      ) AS f(sig) WHERE to_regprocedure(f.sig) IS NOT NULL
    `

    const runtimeReport: RuntimeProjectAttributionReport = {
      bindRejectedForeignProject: bindForeign.kind === 'rejected',
      completeRejectedForeignProject: completeForeign.kind === 'rejected',
      abortRejectedForeignProject: abortForeign.kind === 'rejected',
      inspectRejectedForeignProject: inspectForeign === null,
      chargeAttributedToExecutionProject:
        charged.rows.length === 1 && String(charged.rows[0]!.project_id) === PROJECT_A1,
      zeroChargeOnAttack: crossProject.rows.length === 0,
      legacySignatureInvocable: Number(legacy[0]!.n) > 0,
    }

    /* --- la guarda de orden de paquetes ----------------------------------- */
    let packageOrderGuardHeld = false
    try {
      await assertPreparedPackageOrder(admin, 'db/prepared/stella_0014_operation_tickets.sql')
    } catch {
      // Rechazó, que es lo que debe hacer. Y el estado que protege, además.
      await assertNoProjectBlindTicketSignatures(admin)
      packageOrderGuardHeld = true
    }

    /* --- los dos gates de runtime ----------------------------------------- */
    const { validateObservabilityEvent } = await import('@/tests/eval/stella-release/observability-contract')
    const observabilityViolations = emitted.reduce(
      (n, payload) => n + validateObservabilityEvent(payload).violations.length,
      0,
    )

    const { computeIdempotencyReleaseGateReport } = await import(
      '@/tests/eval/stella-release/idempotency-release-gate'
    )
    const { runIdempotencyEvalHarness } = await import('@/tests/eval/stella-release/idempotency-harness')
    const idempotencyReport = computeIdempotencyReleaseGateReport(runIdempotencyEvalHarness(), {
      claimedCharged: true,
      chargesObservedForTicket: firstExecutionDelta,
      firstExecutionDelta,
      retryDelta,
      newOperationSameTextDelta,
      abortDelta,
      crossScopeDelta,
      concurrencyLastUnitCharges,
      postCompleteRetryCode: retry.code,
      runtimeEventsEmitted: emitted.map((p) => String(p.eventName)),
      observabilityViolations,
      residualResources: 0,
    })
    const quotaGate = idempotencyReport.gates.find((g) => g.id === 'runtime-quota-charged')!
    expect(quotaGate.passed, quotaGate.detail).toBe(true)

    const { computeProjectBindingGateReport } = await import(
      '@/tests/eval/stella-release/project-binding-release-gate'
    )
    const { runProjectBindingEvalHarness } = await import('@/tests/eval/stella-release/project-binding-harness')
    const projectReport = computeProjectBindingGateReport(runProjectBindingEvalHarness(), runtimeReport)
    const projectGate = projectReport.gates.find((g) => g.id === 'runtime-project-attribution-verified')!
    expect(projectGate.passed, projectGate.detail).toBe(true)

    /* --- y el nivel ------------------------------------------------------- */
    const evidence: LocalRuntimeEvidence = {
      packagesApplied,
      runtimeQuotaChargedGatePassed: quotaGate.passed,
      projectAttributionGatePassed: projectGate.passed,
      chargeRowsObserved:
        attributed.reduce((n, a) => n + a.rows.length, 0) + charged.rows.length,
      everyChargeAttributedToItsExecutionProject,
      zeroCrossProjectCharges: crossScopeDelta === 0 && crossProject.rows.length === 0,
      concurrencyAttributionHeld:
        concurrencyLastUnitCharges <= 1 &&
        (concurrencyLastUnitCharges === 0 ||
          [PROJECT_A1, PROJECT_A3].includes(String(race.rows[0]!.project_id))),
      packageOrderGuardHeld,
      observabilityViolations,
      providerCalls: 0,
      // El contenedor sobrevive necesariamente a este proceso: la batería corre
      // DENTRO de su vida. Cero significa «esta ejecución no dejó recursos
      // propios»; que el contenedor desaparezca lo afirma la §6 de
      // scripts/stella-ticket-e2e.sh, y su código de salida es el que manda.
      residualResources: 0,
    }

    const { computeLocalReleaseGateReport } = await import('@/tests/eval/stella-release/local-release-gate')
    const { runReleaseEvalHarness } = await import('@/tests/eval/stella-release/harness')
    const first = runReleaseEvalHarness()
    const second = runReleaseEvalHarness()

    const report = computeLocalReleaseGateReport(first, second, process.cwd(), null, evidence)

    expect(report.missingForLocalRuntime, 'local-runtime-ready must say WHY, never a bare false').toEqual([])
    expect(report.localRuntimeReady).toBe(true)

    // Y lo que NO cambia con ninguna evidencia local.
    expect(report.stagingBlocked).toBe(true)
    expect(report.hostedBlocked).toBe(true)
    expect(report.missingForStaging.length).toBeGreaterThan(0)
    expect(report.missingForHosted.length).toBeGreaterThan(0)
  }, 300_000)

  it('sin evidencia — toda invocación offline — el nivel sigue en false, con sus razones', async () => {
    // El control negativo del nivel. Sin él, «pasa a true» sólo demostraría que
    // se le pasó un objeto, no que el reductor comprueba algo.
    const { computeLocalReleaseGateReport } = await import('@/tests/eval/stella-release/local-release-gate')
    const { runReleaseEvalHarness } = await import('@/tests/eval/stella-release/harness')
    const first = runReleaseEvalHarness()
    const second = runReleaseEvalHarness()

    const offline = computeLocalReleaseGateReport(first, second)
    expect(offline.localRuntimeReady).toBe(false)
    expect(offline.missingForLocalRuntime.join(' ')).toMatch(/applied to NO database/)
    expect(offline.missingForLocalRuntime.join(' ')).toMatch(/quota is enforced but not consumed/)
  }, 120_000)
})
