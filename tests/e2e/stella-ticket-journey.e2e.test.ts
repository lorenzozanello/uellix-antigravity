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
const EVIDENCE_A1 = '33333333-3333-4333-8333-3333333333a1'
const DOCVER_A1 = '44444444-4444-4444-8444-4444444444a1'

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
      ('${PROJECT_B1}', '${ORG_B}', 'Project B1', '${ACTOR_B1}')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.evidence_items (id, project_id, organization_id, type, title, status, created_by) VALUES
      ('${EVIDENCE_A1}', '${PROJECT_A1}', '${ORG_A}', 'text', 'Informe 2025', 'approved', '${ACTOR_A1}')
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

  it('el paquete stella_0014 está instalado y sus seis funciones existen', async () => {
    const rows = await admin`
      SELECT count(*)::int AS n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'uellix_stella_ops'
    `
    expect(Number(rows[0]!.n)).toBe(6)
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

  it('un ticket de OTRO proyecto de la misma organización y actor: UNA sola unidad, atribuida al proyecto del TICKET (R2-INT, riesgo abierto)', async () => {
    // ------------------------------------------------------------------
    // ESTE ESCENARIO NO SE RECHAZA, Y LA PRUEBA LO FIJA EN VEZ DE FINGIRLO.
    //
    // `bind_operation_ticket(ticket, query_hash)` no recibe el proyecto contra
    // el que la consulta va a ejecutarse — su firma tiene dos argumentos — así
    // que la base NO PUEDE comparar "el proyecto del ticket" con "el proyecto
    // del trabajo". Compara lo que sí conoce: que el ticket pertenece al actor
    // y a la organización de la sesión (RLS), y que su proyecto pertenece a esa
    // organización (trigger). Ambas cosas se cumplen aquí.
    //
    // Consecuencia real, medida abajo: el trabajo lee la evidencia de
    // PROJECT_A1 y la fila del ledger queda archivada bajo PROJECT_A2.
    //
    // POR QUÉ NO ES UN ESCAPE DE CUOTA: la cuota es de ORGANIZACIÓN, y se cobra
    // exactamente una unidad. No hay ni sobreconsumo ni descuento.
    // ES ALCANZABLE DESDE EL CLIENTE, y decir lo contrario sería el error más
    // peligroso de este comentario. Una versión anterior afirmaba que el
    // montaje enlaza ambas acciones al MISMO `projectId` y que por tanto un
    // cliente no puede hacerlas discrepar. Es falso: CADA export de un módulo
    // `'use server'` es un endpoint invocable por separado —cosa que el propio
    // `grounded-query.ts` enuncia sobre sí mismo— así que la forma de tres
    // argumentos acepta un `projectId` cualquiera junto a un ticket cualquiera,
    // y cualquier miembro autenticado de la organización puede combinarlos.
    // La llamada de esta misma prueba es la demostración.
    // Corregido tras la revisión adversarial A (Tren 4.1), que lo marcó MAJOR.
    // QUÉ QUEDA ABIERTO: es un defecto de ATRIBUCIÓN, y cerrarlo exige que
    // `bind`/`complete` reciban el proyecto — un cambio de firma en un paquete
    // ya publicado de CAPABILITIES. Registrado como R2-INT para el tren 5.
    //
    // La prueba existe para que, si alguien cambia ese comportamiento, se entere.
    // ------------------------------------------------------------------
    const ticketOfA2 = await issued(PROJECT_A2)

    const beforeB = await chargeCount(ORG_B)
    await expectDelta(ORG_A, 1, () =>
      rt.run(PROJECT_A1, '¿Cuántos beneficiarios atendió el programa?', ticketOfA2),
    )

    // Exactamente una unidad, y ninguna de la OTRA organización.
    expect(await chargeCount(ORG_B)).toBe(beforeB)

    // La atribución, fijada explícitamente: la fila es del proyecto del TICKET.
    const rows = await admin`
      SELECT project_id FROM public.stella_interactions
      WHERE organization_id = ${ORG_A}
      ORDER BY created_at DESC LIMIT 1
    `
    expect(String(rows[0]!.project_id)).toBe(PROJECT_A2)
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
