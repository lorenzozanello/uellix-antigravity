// tests/e2e/stella-multicategory-quota.e2e.test.ts
// INTEGRACIÓN — Tren 4.3c. La evidencia que el cierre de R6a/R6b dejó pendiente:
// SEIS categorías Stella compartiendo UNA capacidad, contra una base PostgreSQL
// real con la cadena `0013`…`0018` instalada.
//
// ---------------------------------------------------------------------------
// QUÉ ES REAL AQUÍ, Y QUÉ ESTÁ SUSTITUIDO
// ---------------------------------------------------------------------------
// REAL: la base (contenedor desechable de
// `scripts/stella-multicategory-quota-e2e.sh`), los nueve paquetes preparados,
// las SIETE categorías repartidas en seis server actions (`getStellaAdvisor`, `getStellaValidator`,
// `getStellaComposer`, `getStellaReviewer` ×3 roles y
// `runStellaGroundedQueryForProject`), sus superficies de emisión, los
// constructores de contexto —que leen la base BAJO RLS—, los prompts, la
// validación de esquema, el adaptador `db/stella/operation-tickets`, el driver
// `runGovernedStellaOperation`, el emisor de observabilidad y el ledger.
//
// SUSTITUIDO, y sólo esto:
//
//   `@/lib/auth/session`          — lee cookies de una petición HTTP que aquí
//                                   no existe.
//   `@/lib/auth/database-context` — se sustituye por una implementación que
//                                   llama a `withDatabaseIdentityContext` REAL
//                                   con ese actor: las claims, las policies,
//                                   `auth.uid()` y RLS son las de producción.
//   `@/lib/stella/config`         — las banderas. En el repositorio son false;
//                                   encenderlas aquí es lo que permite ejercer
//                                   el camino y seguir entregándolas apagadas.
//   `@/lib/stella/rate-limit`     — usa Upstash/Redis, no es parte de la
//                                   idempotencia y su ausencia no es
//                                   sustituible por una base.
//   `@/lib/stella/adapter/gemini-client` — EL PROVEEDOR. Es el único ejecutor
//                                   inyectado, y es exactamente el «trabajo de
//                                   dominio» que la fase 5 permite sustituir.
//                                   `parseResponse` delega en el esquema Zod
//                                   REAL, así que la validación de salida no se
//                                   sustituye: sólo el texto que la alimenta.
//
// El PROTOCOLO no está sustituido en ninguna parte. Cada `bind`, `complete` y
// `abort` es una llamada a la función SECURITY DEFINER real; cada aserción de
// cobro cuenta filas COMMITEADAS de `public.stella_interactions` leídas por una
// SEGUNDA conexión, con otro rol, fuera de la transacción de la acción.
//
// ---------------------------------------------------------------------------
// CERO PROVEEDOR EXTERNO
// ---------------------------------------------------------------------------
// Afirmado, no supuesto: el guion invoca con `env -u GEMINI_API_KEY` y §0
// vuelve a comprobarlo desde dentro del proceso. El adaptador inyectado no
// abre socket alguno.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import type { MulticategoryQuotaEvidence } from '@/tests/eval/stella-release/multicategory-release-gate'

/* -------------------------------------------------------------------------- */
/* Fixtures — dos organizaciones, dos proyectos en una, dos actores            */
/* -------------------------------------------------------------------------- */

// Ids DISTINTOS de los de tests/e2e/stella-ticket-journey.e2e.test.ts a
// propósito: las dos baterías comparten el puerto del stack desechable (la
// guarda de `db/safety/local-stack.ts` fija 56322) y se ejecutan una cada vez,
// pero un id compartido haría que una siembra `ON CONFLICT DO NOTHING` heredara
// silenciosamente el mundo de la otra.
const ORG_M = '11111111-1111-4111-8111-1111111111c1'
const ORG_N = '11111111-1111-4111-8111-1111111111d1'
const PROJECT_M1 = '22222222-2222-4222-8222-22222222cc01'
const PROJECT_M2 = '22222222-2222-4222-8222-22222222cc02'
const PROJECT_N1 = '22222222-2222-4222-8222-22222222dd01'
const ACTOR_M1 = '99999999-9999-4999-8999-99999999cc01'
const ACTOR_M2 = '99999999-9999-4999-8999-99999999cc02'
const ACTOR_N1 = '99999999-9999-4999-8999-99999999dd01'
const REPORT_M1 = '55555555-5555-4555-8555-55555555cc01'
const REPORT_M2 = '55555555-5555-4555-8555-55555555cc02'
const RUN_M1 = '66666666-6666-4666-8666-66666666cc01'
const RUN_M2 = '66666666-6666-4666-8666-66666666cc02'
const EVIDENCE_M1 = '33333333-3333-4333-8333-33333333cc01'
const EVIDENCE_M2 = '33333333-3333-4333-8333-33333333cc02'
const DOCVER_M1 = '44444444-4444-4444-8444-44444444cc01'
const DOCVER_M2 = '44444444-4444-4444-8444-44444444cc02'

const DOCUMENT_TEXT =
  'El programa atendió a 1240 beneficiarios durante 2025. La tasa de retención escolar del grupo participante fue del 87 por ciento.'

/** Las seis categorías que esta batería conduce con runtime real. */
const CATEGORIES = [
  'grounded_query',
  'advisor',
  'validator',
  'composer',
  'proxy_reviewer',
  'evidence_reviewer',
  'audit_assistant',
] as const
type Category = (typeof CATEGORIES)[number]

/* -------------------------------------------------------------------------- */
/* La sesión sustituida                                                        */
/* -------------------------------------------------------------------------- */

let currentActor = { userId: ACTOR_M1, organizationId: ORG_M, role: 'organization_admin' as string }

const mockStellaConfig = {
  isEnabled: true,
  isGroundedQueryEnabled: true,
  isAdvisorEnabled: true,
  isValidatorEnabled: true,
  isComposerEnabled: true,
  isProxyReviewerEnabled: true,
  isEvidenceReviewerEnabled: true,
  isAuditAssistantEnabled: true,
}
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
    user: {
      id: currentActor.userId,
      email: 'multi@example.invalid',
      fullName: null,
      avatarUrl: null,
      isSuperAdmin: false,
    },
    organization: { id: currentActor.organizationId, name: 'E2E multi', slug: 'e2e-multi' },
    membership: {
      id: '00000000-0000-4000-8000-000000000011',
      organizationId: currentActor.organizationId,
      userId: currentActor.userId,
      role: currentActor.role,
      status: 'active',
    },
  }),
}))

/**
 * El contexto de identidad REAL, conducido por la sesión sustituida.
 *
 * Es la línea que mantiene honesta a la batería. Habría sido mucho más fácil
 * reducir `withOrganizationDatabaseContext` a `cb => cb()` — y entonces cada
 * policy RLS, cada `auth.uid()` y cada `U0102` de este fichero se habría
 * evaluado SIN claims, es decir como nadie. Los escenarios de scope habrían
 * «pasado» por no encontrar nada, por razones que no tienen que ver con el
 * protocolo.
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
/* EL ÚNICO EJECUTOR INYECTADO: el proveedor                                   */
/* -------------------------------------------------------------------------- */

/**
 * Salidas deterministas por rol, y `parseResponse` delegando en el ESQUEMA REAL.
 *
 * Lo que se sustituye es el texto que un modelo habría devuelto. Lo que NO se
 * sustituye es qué se hace con él: el `parse` de Zod es el del producto, así
 * que una salida que no cumpliera el contrato haría fallar la acción aquí igual
 * que en producción — y de hecho el caso 12 lo usa para provocar un fallo real
 * después de `bind`.
 *
 * `providerCalls` cuenta invocaciones. Es lo que permite afirmar «el proveedor
 * no se llamó» en los casos de rechazo por cuota, categoría o scope sin
 * depender de un comentario.
 */
let providerCalls: Array<{ role: string; at: number }> = []
/** Cuando está puesto, `generate` devuelve texto inválido para ese rol. */
let providerBreaksFor: string | null = null

const DETERMINISTIC_OUTPUT: Record<string, unknown> = {
  advisor: {
    step: 'narrative',
    what_to_do: 'Describir la cadena de valor del programa.',
    why_it_matters: 'La narrativa ancla el resto del análisis.',
    how_to_do_it: 'Partir de los grupos de interés y sus cambios observados.',
    common_mistakes: ['Confundir actividad con resultado.'],
    suggested_next_actions: ['Revisar los indicadores asociados.'],
  },
  validator: {
    summary: 'Revisión metodológica de la etapa de cálculo.',
    risk_level: 'medium',
    evidence_gaps: ['Un resultado carece de evidencia documental.'],
    proxy_risks: ['Una aproximación proviene de una fuente secundaria.'],
    attribution_risks: ['No se documenta el peso muerto.'],
    claim_risks: ['La redacción es más categórica de lo que la evidencia sostiene.'],
    recommendations: ['Documentar la fuente de cada aproximación.'],
    requires_human_review: true,
  },
  composer: {
    section_key: 'methodology',
    draft_title: 'Metodología',
    // SIN CIFRAS a propósito: el guardián numérico del composer rechaza un
    // borrador que introduzca números que el contexto no respalda, y este
    // fichero mide el protocolo de cuota, no ese guardián — que tiene su propia
    // suite.
    draft_content:
      'La metodología sigue las etapas descritas por el marco de referencia, sin introducir cifras nuevas.',
    assumptions: ['Los grupos de interés declarados son completos.'],
    limitations: ['El análisis no incluye efectos de largo plazo.'],
    evidence_references: [],
    proxy_references: [],
  },
  reviewer: {
    summary: 'Revisión de la evidencia y las aproximaciones del proyecto.',
    risk_level: 'low',
    findings: ['Una fuente carece de fecha de publicación.'],
    recommendations: ['Registrar la fecha de cada fuente.'],
    requires_human_review: true,
  },
}

function outputFor(role: string): unknown {
  if (role === 'advisor' || role === 'validator' || role === 'composer') return DETERMINISTIC_OUTPUT[role]
  return DETERMINISTIC_OUTPUT.reviewer
}

vi.mock('@/lib/stella/adapter/gemini-client', () => ({
  getGeminiAdapter: () => ({
    generate: async (request: { role: string }) => {
      providerCalls.push({ role: request.role, at: Date.now() })
      const broken = providerBreaksFor === request.role
      return {
        role: request.role,
        rawOutput: broken ? '{"not":"the contract"}' : JSON.stringify(outputFor(request.role)),
        parsedOutput: null,
        modelUsed: 'e2e-deterministic',
        tokensUsed: 42,
        timestamp: new Date(),
      }
    },
    // EL ESQUEMA REAL. No se sustituye la validación, sólo el texto.
    parseResponse: async <T,>(rawOutput: string, schema: { parse: (data: unknown) => T }): Promise<T> => {
      const { StellaParseError } = await import('@/lib/stella/errors')
      try {
        return schema.parse(JSON.parse(rawOutput))
      } catch (error) {
        throw new StellaParseError((error as Error).message)
      }
    },
  }),
}))

/* -------------------------------------------------------------------------- */
/* Captura de observabilidad — del RUNTIME, no del evaluador                   */
/* -------------------------------------------------------------------------- */

/**
 * Los eventos se leen de `console.log('[stella-ticket]', payload)`, que es
 * exactamente lo que `emitTicketEvent` escribe en producción.
 *
 * No se fabrica ninguno. Un evento que esta batería afirme haber visto es un
 * evento que el runtime emitió durante una acción real de este fichero.
 */
type CapturedEvent = { eventName: string; payload: Record<string, unknown> }
let captured: CapturedEvent[] = []
let realConsoleLog: typeof console.log

function eventsNamed(name: string): CapturedEvent[] {
  return captured.filter((e) => e.eventName === name)
}

function eventsWithReason(name: string, reasonCode: string): CapturedEvent[] {
  return eventsNamed(name).filter((e) => e.payload.reasonCode === reasonCode)
}

/* -------------------------------------------------------------------------- */
/* Conexión privilegiada — SIEMBRA Y VERIFICACIÓN ÚNICAMENTE                   */
/* -------------------------------------------------------------------------- */

let admin: postgres.Sql

const CONTAINER_URL = process.env.UELLIX_MULTICATEGORY_E2E_ADMIN_URL

async function chargeCount(organizationId: string): Promise<number> {
  const rows = await admin`
    SELECT count(*)::int AS n FROM public.stella_interactions
    WHERE organization_id = ${organizationId}
      AND created_at >= date_trunc('month', timezone('UTC', now()))
  `
  return Number(rows[0]!.n)
}

async function chargeCountForProject(organizationId: string, projectId: string): Promise<number> {
  const rows = await admin`
    SELECT count(*)::int AS n FROM public.stella_interactions
    WHERE organization_id = ${organizationId} AND project_id = ${projectId}
      AND created_at >= date_trunc('month', timezone('UTC', now()))
  `
  return Number(rows[0]!.n)
}

type LedgerRow = {
  id: string
  organization_id: string
  project_id: string
  stella_role: string
  pipeline_step: string | null
  context_hash: string | null
  model_used: string | null
  tokens_used: number | null
  response_json: unknown
  idempotency_key: string | null
  created_at: string
}

/** Las filas que la organización GANÓ mientras corría `body`. */
async function ledgerDelta<T>(
  organizationId: string,
  body: () => Promise<T>,
): Promise<{ result: T; rows: LedgerRow[] }> {
  const before = await admin`SELECT id FROM public.stella_interactions WHERE organization_id = ${organizationId}`
  const seen = new Set(before.map((r) => String(r.id)))
  const result = await body()
  const after = await admin`
    SELECT id, organization_id, project_id, stella_role, pipeline_step, context_hash,
           model_used, tokens_used, response_json, idempotency_key, created_at
    FROM public.stella_interactions
    WHERE organization_id = ${organizationId}
    ORDER BY created_at ASC
  `
  return {
    result,
    rows: (after as unknown as LedgerRow[]).filter((r) => !seen.has(String(r.id))),
  }
}

async function ticketRow(ticketId: string): Promise<Record<string, unknown> | null> {
  const rows = await admin`
    SELECT ticket_id, organization_id, project_id, category, status, expires_at, period_month
    FROM uellix_stella_ops.operation_tickets WHERE ticket_id = ${ticketId}
  `
  return rows.length === 0 ? null : (rows[0] as unknown as Record<string, unknown>)
}

async function liveReserved(organizationId: string): Promise<number> {
  const rows = await admin`
    SELECT count(*)::int AS n FROM uellix_stella_ops.operation_tickets
    WHERE organization_id = ${organizationId} AND status = 'bound'
      AND expires_at > timezone('UTC', now())
  `
  return Number(rows[0]!.n)
}

async function limitOf(organizationId: string): Promise<number | null> {
  const rows = await admin`SELECT stella_monthly_quota AS q FROM public.organizations WHERE id = ${organizationId}`
  return rows[0]!.q === null ? null : Number(rows[0]!.q)
}

async function setQuota(organizationId: string, quota: number | null): Promise<void> {
  await admin`UPDATE public.organizations SET stella_monthly_quota = ${quota} WHERE id = ${organizationId}`
}

/**
 * Las filas que la organización YA tenía al empezar el escenario.
 *
 * `public.stella_interactions` es APPEND-ONLY para todo rol, incluido el owner
 * (`trg_stella_interactions_append_only`, prepared stella_0002), así que no se
 * puede vaciar entre escenarios — ni con DELETE, ni con TRUNCATE, ni bajo
 * `session_replication_role = replica`, porque el trigger es ENABLE ALWAYS.
 *
 * De ahí que TODO en este fichero se mida como DELTA sobre esta línea base. Es
 * también la aserción más fuerte: sobrevive a cualquier número de filas que un
 * escenario anterior dejara, y no puede satisfacerse por un escenario que
 * cobrara el total correcto por la razón equivocada.
 */
const baseline: Record<string, number> = {}

/**
 * Fijar el HUECO disponible, no la cuota absoluta.
 *
 * `setQuota(org, 1)` significaría «una unidad en todo el mes», y con seis filas
 * ya en el ledger de escenarios anteriores es «cero» — que es exactamente el
 * fallo que la primera versión de esta batería produjo en seis casos. Lo que un
 * escenario quiere decir es «queda UNA unidad a partir de ahora».
 */
async function setHeadroom(organizationId: string, units: number): Promise<void> {
  await setQuota(organizationId, baseline[organizationId]! + units)
}

/**
 * La invariante, medida y no argumentada.
 *
 * `Consumed` son filas COMMITEADAS del mes; `LiveReserved` son tickets `bound`
 * no expirados. Se comprueba después de CADA escenario, no una vez al final:
 * una violación transitoria que se resuelve sola sigue siendo una unidad
 * vendida dos veces.
 *
 * Medida sobre la línea base por la razón de arriba, y con una consecuencia que
 * conviene decir en voz alta: bajar el tope por debajo de lo ya consumido NO es
 * una violación. `stella_0016` lo declara —una reserva es un compromiso tomado
 * bajo el límite vigente cuando se tomó, y bajar el cap después no anula
 * compromisos ya hechos, sólo rechaza los nuevos— y el §8 de esta batería lo
 * ejerce a propósito.
 */
async function expectInvariant(organizationId: string): Promise<void> {
  const [consumed, reserved, limit] = await Promise.all([
    chargeCount(organizationId),
    liveReserved(organizationId),
    limitOf(organizationId),
  ])
  if (limit === null) return
  const base = baseline[organizationId] ?? 0
  const headroom = Math.max(0, limit - base)
  expect(
    consumed - base + reserved,
    `ΔConsumed(${consumed - base}) + LiveReserved(${reserved}) supera el hueco(${headroom}) en ${organizationId}`,
  ).toBeLessThanOrEqual(headroom)
}

/** Los tickets no completados se retiran entre escenarios; el ledger es append-only. */
async function resetTickets(): Promise<void> {
  await admin`DELETE FROM uellix_stella_ops.operation_tickets WHERE status <> 'completed'`
}

/**
 * Poner un ticket en estado `bound` con una ventana que este arnés elige.
 *
 * NO SE PUEDE HACER CON UN UPDATE, y descubrirlo fue el resultado correcto:
 * `stella_0014` §4 instala un trigger que refuse cualquier UPDATE que mueva
 * `expires_at` —o el alcance, la categoría, el actor o el nonce— PARA TODO ROL,
 * incluido el owner. Esa es exactamente la propiedad que hace que un ticket no
 * se pueda estirar, y una batería que la sorteara con un `SET expires_at`
 * estaría midiendo un sistema que este producto no tiene.
 *
 * Lo que el paquete SÍ permite es borrar un ticket no completado (el trigger de
 * DELETE sólo protege los `completed`, porque son la contraparte de una fila
 * cobrada). Así que la fila se retira y se vuelve a escribir con la ventana
 * deseada, conservando ticket_id, alcance, categoría, actor y nonce. El estado
 * resultante es indistinguible del que produciría el paso del tiempo — que es
 * lo que hace falta para medir la expiración sin esperar quince minutos.
 *
 * `period_month` es GENERATED ALWAYS y por eso no se nombra: la base la deriva
 * de `bound_at`, que es justo lo que el caso de transición de periodo mueve.
 */
async function rewriteTicketWindow(
  ticketId: string,
  window: { readonly boundAt: string; readonly expiresAt: string | null },
): Promise<void> {
  // (1) SI hay que mover `expires_at`, la fila se retira y se vuelve a escribir
  //     — y se vuelve a escribir como `issued`, porque hay un SEGUNDO trigger
  //     («a ticket is issued, not declared») que refuse cualquier INSERT que
  //     declare un estado posterior. Las dos negativas juntas son la razón por
  //     la que un ticket no se puede fabricar ya reservado.
  if (window.expiresAt !== null) {
    await admin.unsafe(
      `WITH removed AS (
         DELETE FROM uellix_stella_ops.operation_tickets
         WHERE ticket_id = $1 AND status <> 'completed'
         RETURNING ticket_id, organization_id, project_id, actor_id, category, charge_nonce, issued_at
       )
       INSERT INTO uellix_stella_ops.operation_tickets
         (ticket_id, organization_id, project_id, actor_id, category, status,
          charge_nonce, issued_at, expires_at)
       SELECT ticket_id, organization_id, project_id, actor_id, category, 'issued',
              charge_nonce,
              -- issued_at SE MUEVE CON LA VENTANA, y no por comodidad:
              -- operation_tickets_expiry_window_check exige
              -- expires_at > issued_at y expires_at <= issued_at + 15 min.
              -- Una caducidad en el pasado sobre una emisión de ahora viola las
              -- dos mitades — que es la CHECK haciendo su trabajo: la ventana no
              -- se puede estirar ni acortar, sólo desplazar entera.
              timezone('UTC', now()) + ($2)::interval - interval '5 minutes',
              timezone('UTC', now()) + ($2)::interval
       FROM removed`,
      [ticketId, window.expiresAt],
    )
  }

  // (2) Y la transición `issued` → `bound` por la vía que el trigger SÍ admite:
  //     un UPDATE que no toca alcance, categoría, actor, nonce ni ventana.
  //     `bound_at` no está en la lista inmutable — es lo que `bind` escribe— así
  //     que moverlo es legal y es lo que la transición de periodo necesita.
  //
  //     LO QUE ESTE ESTADO NO ES: indistinguible del que produciría el paso del
  //     tiempo. `operation_tickets_expiry_window_check` acota la vida real de un
  //     ticket a quince minutos tras su emisión, así que una reserva «ligada
  //     hace un mes y todavía viva» no puede ocurrir en producción. Lo señaló la
  //     revisión adversarial A. Se construye igual porque las dos columnas que
  //     las aserciones leen son exactamente las que el arnés fija de forma
  //     coherente: `liveReserved` depende de `status` y `expires_at`, y
  //     `period_month` es GENERATED ALWAYS desde `bound_at`. Lo que se mide es
  //     que la aritmética NO filtra por periodo — no que la ventana sea
  //     alcanzable.
  await admin.unsafe(
    `UPDATE uellix_stella_ops.operation_tickets
     SET status = 'bound', query_hash = repeat('a', 64),
         bound_at = timezone('UTC', now()) + ($2)::interval
     WHERE ticket_id = $1`,
    [ticketId, window.boundAt],
  )
}

async function expectDelta<T>(organizationId: string, expected: number, body: () => Promise<T>): Promise<T> {
  const before = await chargeCount(organizationId)
  const result = await body()
  const after = await chargeCount(organizationId)
  expect(after - before, `se esperaban ${expected} cargo(s)`).toBe(expected)
  return result
}

/* -------------------------------------------------------------------------- */
/* Construcción del mundo                                                     */
/* -------------------------------------------------------------------------- */

async function seedWorld(): Promise<void> {
  await admin.unsafe(`
    INSERT INTO public.users (id, email) VALUES
      ('${ACTOR_M1}', 'm1@example.invalid'),
      ('${ACTOR_M2}', 'm2@example.invalid'),
      ('${ACTOR_N1}', 'n1@example.invalid')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.organizations (id, name, slug, stella_monthly_quota) VALUES
      ('${ORG_M}', 'Org M', 'org-m-multi', 100),
      ('${ORG_N}', 'Org N', 'org-n-multi', 100)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.organization_members (id, organization_id, user_id, role, status) VALUES
      ('00000000-0000-4000-8000-0000000000c1', '${ORG_M}', '${ACTOR_M1}', 'organization_admin', 'active'),
      ('00000000-0000-4000-8000-0000000000c2', '${ORG_M}', '${ACTOR_M2}', 'organization_admin', 'active'),
      ('00000000-0000-4000-8000-0000000000d1', '${ORG_N}', '${ACTOR_N1}', 'organization_admin', 'active')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.projects (id, organization_id, name, created_by) VALUES
      ('${PROJECT_M1}', '${ORG_M}', 'Project M1', '${ACTOR_M1}'),
      ('${PROJECT_M2}', '${ORG_M}', 'Project M2', '${ACTOR_M1}'),
      ('${PROJECT_N1}', '${ORG_N}', 'Project N1', '${ACTOR_N1}')
    ON CONFLICT (id) DO NOTHING;

    -- \`status\` EXPLÍCITO. El default de la columna en el baseline es
    -- 'completed' y su propio CHECK sólo admite calculated/failed/pending — un
    -- desajuste preexistente del esquema que hace que un INSERT sin status
    -- falle. Se nombra el valor en vez de heredar el default roto.
    INSERT INTO public.sroi_calculation_runs (id, project_id, organization_id, calculated_by, status) VALUES
      ('${RUN_M1}', '${PROJECT_M1}', '${ORG_M}', '${ACTOR_M1}', 'calculated'),
      ('${RUN_M2}', '${PROJECT_M2}', '${ORG_M}', '${ACTOR_M1}', 'calculated')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.sroi_reports (id, organization_id, project_id, calculation_run_id, title, created_by) VALUES
      ('${REPORT_M1}', '${ORG_M}', '${PROJECT_M1}', '${RUN_M1}', 'Informe M1', '${ACTOR_M1}'),
      ('${REPORT_M2}', '${ORG_M}', '${PROJECT_M2}', '${RUN_M2}', 'Informe M2', '${ACTOR_M1}')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.evidence_items (id, project_id, organization_id, type, title, status, created_by) VALUES
      ('${EVIDENCE_M1}', '${PROJECT_M1}', '${ORG_M}', 'text', 'Informe 2025 (M1)', 'approved', '${ACTOR_M1}'),
      ('${EVIDENCE_M2}', '${PROJECT_M2}', '${ORG_M}', 'text', 'Informe 2025 (M2)', 'approved', '${ACTOR_M1}')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.evidence_document_versions (
      id, organization_id, project_id, evidence_id, version_id, raw_content_hash,
      normalized_content_hash, normalization_version, extractor_version,
      chunker_version, mime_type, ordinal, supersedes_version_id
    ) VALUES
      ('${DOCVER_M1}', '${ORG_M}', '${PROJECT_M1}', '${EVIDENCE_M1}',
       repeat('a', 64), repeat('b', 64), repeat('c', 64), 'norm-1', 'extract-1', 'chunk-1', 'text/plain', 1, NULL),
      ('${DOCVER_M2}', '${ORG_M}', '${PROJECT_M2}', '${EVIDENCE_M2}',
       repeat('d', 64), repeat('e', 64), repeat('f', 64), 'norm-1', 'extract-1', 'chunk-1', 'text/plain', 1, NULL)
    ON CONFLICT (id) DO NOTHING;
  `)

  // Los chunks, con chunk_id y content_hash DERIVADOS por la propia base: es lo
  // que grounding_0004 impone y un valor precomputado que coincidiera por
  // casualidad probaría el CHECK contra sí mismo.
  for (const [version, org, project, evidence, docver] of [
    ['a', ORG_M, PROJECT_M1, EVIDENCE_M1, DOCVER_M1],
    ['d', ORG_M, PROJECT_M2, EVIDENCE_M2, DOCVER_M2],
  ] as const) {
    await admin.unsafe(`
      INSERT INTO public.evidence_chunks (
        chunk_id, organization_id, project_id, evidence_id, document_version_id,
        version_id, raw_content_hash, normalized_content_hash,
        chunk_index, content, content_hash, char_start, char_end,
        normalization_version, chunker_version, injection_scanner_version, signals, canonical_chunk_id
      )
      SELECT
        encode(sha256(convert_to('grounding/chunk/v1' || chr(10) || repeat('${version}', 64) || chr(10)
                                 || 0::text || chr(10) || ch, 'UTF8')), 'hex'),
        '${org}'::uuid, '${project}'::uuid, '${evidence}'::uuid, '${docver}'::uuid,
        repeat('${version}', 64), repeat('${version === 'a' ? 'b' : 'e'}', 64), repeat('${version === 'a' ? 'c' : 'f'}', 64),
        0, body, ch, 0, length(body),
        'norm-1', 'chunk-1', 'inj-1', '[]'::jsonb, NULL
      FROM (
        SELECT body, encode(sha256(convert_to(body, 'UTF8')), 'hex') AS ch
        FROM (SELECT '${DOCUMENT_TEXT.replace(/'/g, "''")}'::text AS body) AS t
      ) AS d
      ON CONFLICT (chunk_id) DO NOTHING;
    `)
  }
}

/* -------------------------------------------------------------------------- */
/* Runtime bajo prueba — importado DESPUÉS de registrar los mocks             */
/* -------------------------------------------------------------------------- */

type IssueResult = { status: string; ticket?: string; code?: string }
type RunResult = { ok: boolean; error?: string; message?: string; data?: unknown }

type CategoryRuntime = {
  issue: (projectId: string) => Promise<IssueResult>
  run: (projectId: string, ticket: string) => Promise<RunResult>
  /** El rol que el proveedor recibe — para contar llamadas por categoría. */
  providerRole: string
}

let rt: Record<Category, CategoryRuntime>
let telemetryFailures: () => number

/** Emite un ticket y falla ruidosamente si la emisión no fue exitosa. */
async function issued(category: Category, projectId: string): Promise<string> {
  const result = await rt[category].issue(projectId)
  expect(result.status, `la emisión de ${category} falló: ${JSON.stringify(result)}`).toBe('issued')
  return result.ticket!
}

beforeAll(async () => {
  if (!CONTAINER_URL || !CONTAINER_URL.includes('127.0.0.1:56322')) {
    throw new Error(
      'UELLIX_MULTICATEGORY_E2E_ADMIN_URL debe apuntar al contenedor desechable en 127.0.0.1:56322. ' +
        'Ejecute esta batería a través de scripts/stella-multicategory-quota-e2e.sh.',
    )
  }
  admin = postgres(CONTAINER_URL, { max: 6, onnotice: () => {} })
  await seedWorld()

  const grounded = await import('@/app/actions/stella/grounded-query')
  const advisor = await import('@/app/actions/stella/advisor')
  const validator = await import('@/app/actions/stella/validator')
  const composer = await import('@/app/actions/stella/composer')
  const reviewer = await import('@/app/actions/stella/reviewer')
  const obs = await import('@/lib/stella/operation-ticket/ticket-observability')
  telemetryFailures = obs.ticketTelemetryFailureCount

  const reportFor = (projectId: string) => (projectId === PROJECT_M2 ? REPORT_M2 : REPORT_M1)

  rt = {
    grounded_query: {
      issue: (p) => grounded.issueStellaGroundedQueryTicketForProject(p) as Promise<IssueResult>,
      run: async (p, t) => {
        const r = (await grounded.runStellaGroundedQueryForProject(
          p,
          { query: '¿Cuántos beneficiarios atendió el programa?' },
          t,
        )) as { status: string; code?: string; message?: string }
        return { ok: r.status === 'ok', error: r.code, message: r.message }
      },
      providerRole: 'grounded_query',
    },
    advisor: {
      issue: (p) => advisor.issueStellaAdvisorTicket(p) as Promise<IssueResult>,
      run: (p, t) => advisor.getStellaAdvisor(p, 'narrative', t) as Promise<RunResult>,
      providerRole: 'advisor',
    },
    validator: {
      issue: (p) => validator.issueStellaValidatorTicket(p) as Promise<IssueResult>,
      run: (p, t) => validator.getStellaValidator(p, 'calculation', t) as Promise<RunResult>,
      providerRole: 'validator',
    },
    composer: {
      issue: (p) => composer.issueStellaComposerTicket(p) as Promise<IssueResult>,
      run: (p, t) =>
        composer.getStellaComposer(p, reportFor(p), 'section-1', 'methodology', t) as Promise<RunResult>,
      providerRole: 'composer',
    },
    proxy_reviewer: {
      issue: (p) => reviewer.issueStellaReviewerTicket(p, 'proxy_reviewer') as Promise<IssueResult>,
      run: (p, t) => reviewer.getStellaReviewer(p, 'proxy_reviewer', t) as Promise<RunResult>,
      providerRole: 'proxy_reviewer',
    },
    evidence_reviewer: {
      issue: (p) => reviewer.issueStellaReviewerTicket(p, 'evidence_reviewer') as Promise<IssueResult>,
      run: (p, t) => reviewer.getStellaReviewer(p, 'evidence_reviewer', t) as Promise<RunResult>,
      providerRole: 'evidence_reviewer',
    },
    audit_assistant: {
      issue: (p) => reviewer.issueStellaReviewerTicket(p, 'audit_assistant') as Promise<IssueResult>,
      run: (p, t) => reviewer.getStellaReviewer(p, 'audit_assistant', t) as Promise<RunResult>,
      providerRole: 'audit_assistant',
    },
  }
}, 180_000)

afterAll(async () => {
  await admin?.end({ timeout: 5 })
})

beforeEach(async () => {
  currentActor = { userId: ACTOR_M1, organizationId: ORG_M, role: 'organization_admin' }
  Object.assign(mockStellaConfig, {
    isEnabled: true,
    isGroundedQueryEnabled: true,
    isAdvisorEnabled: true,
    isValidatorEnabled: true,
    isComposerEnabled: true,
    isProxyReviewerEnabled: true,
    isEvidenceReviewerEnabled: true,
    isAuditAssistantEnabled: true,
  })
  mockStellaState.canUseStella = true
  providerCalls = []
  providerBreaksFor = null
  captured = []
  await resetTickets()
  // La línea base se toma ANTES de fijar la cuota, y en cada escenario: el
  // ledger es append-only y crece monótonamente durante toda la batería.
  baseline[ORG_M] = await chargeCount(ORG_M)
  baseline[ORG_N] = await chargeCount(ORG_N)
  await setHeadroom(ORG_M, 100)
  await setHeadroom(ORG_N, 100)

  realConsoleLog = console.log
  console.log = ((...args: unknown[]) => {
    if (args[0] === '[stella-ticket]' && args[1] && typeof args[1] === 'object') {
      const payload = args[1] as Record<string, unknown>
      captured.push({ eventName: String(payload.eventName), payload })
    }
    // No se reenvía a la consola real: cada escenario emite decenas de eventos
    // y el ruido haría ilegible el fallo que importa. Lo que se conserva es el
    // PAYLOAD, que es lo que la fase 7 audita.
  }) as typeof console.log
})

afterEach(async () => {
  console.log = realConsoleLog
  await expectInvariant(ORG_M)
  await expectInvariant(ORG_N)
})

/* ========================================================================== */
/* 0. El entorno es el que la batería declara                                 */
/* ========================================================================== */

describe('0. El entorno', () => {
  it('no hay clave de proveedor en el proceso', () => {
    expect(process.env.GEMINI_API_KEY).toBeUndefined()
  })

  it('la cadena 0013…0018 está instalada, comprobada por sus objetos', async () => {
    for (const sig of [
      'uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)',
      'uellix_stella.stella_capacity(uuid, character)',
      'uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb)',
      'uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)',
      'uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)',
    ]) {
      const rows = await admin`SELECT to_regprocedure(${sig}) IS NOT NULL AS ok`
      expect(rows[0]!.ok, `falta ${sig}`).toBe(true)
    }
  })

  it('ninguna ruta de runtime alcanza una superficie sin ticket', async () => {
    const rows = await admin`
      SELECT
        has_function_privilege('uellix_app','uellix_stella_ops.bind_operation_ticket(character, uuid, character)','EXECUTE') AS blind_bind,
        has_function_privilege('uellix_app','uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)','EXECUTE') AS capacity,
        has_function_privilege('uellix_app','uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)','EXECUTE') AS quota
    `
    expect(rows[0]!.blind_bind).toBe(false)
    expect(rows[0]!.capacity).toBe(false)
    expect(rows[0]!.quota).toBe(false)
  })
})

/* ========================================================================== */
/* 1-5. Contención sobre la ÚLTIMA unidad, entre categorías                   */
/* ========================================================================== */

/**
 * El patrón, escrito una vez.
 *
 * `holder` reserva la última unidad emitiendo y ligando su ticket a través de
 * la acción real; se comprueba entonces que `challenger` es RECHAZADO **antes
 * de ejecutar** —el proveedor no recibe llamada— y que el `holder` completa con
 * exactamente un cargo.
 *
 * El reto no se «simula» ligando a mano: se conduce la acción entera, que es lo
 * que hace la prueba capaz de detectar un rechazo que llegue tarde.
 */
async function lastUnitDuel(holder: Category, challenger: Category): Promise<void> {
  await setHeadroom(ORG_M, 1)

  const holderTicket = await issued(holder, PROJECT_M1)
  const challengerTicket = await issued(challenger, PROJECT_M1)

  // El holder liga su unidad ejecutando su operación completa.
  const before = await chargeCount(ORG_M)
  const holderRun = await rt[holder].run(PROJECT_M1, holderTicket)
  expect(holderRun.ok, `${holder} debería completar: ${JSON.stringify(holderRun)}`).toBe(true)
  expect(await chargeCount(ORG_M)).toBe(before + 1)

  // Y ahora el retador, con la unidad ya gastada.
  providerCalls = []
  const challengerRun = await rt[challenger].run(PROJECT_M1, challengerTicket)
  expect(challengerRun.ok, `${challenger} no debería completar`).toBe(false)
  expect(
    providerCalls.filter((c) => c.role === rt[challenger].providerRole),
    `${challenger} llamó al proveedor pese a no tener cuota`,
  ).toEqual([])
  expect(await chargeCount(ORG_M)).toBe(before + 1)
  expect(await ticketRow(challengerTicket).then((r) => r?.status)).toBe('issued')
}

describe('1-5. La última unidad, disputada entre categorías', () => {
  it('1. grounded_query reserva la última unidad; advisor es rechazado antes de ejecutar', async () => {
    await lastUnitDuel('grounded_query', 'advisor')
  })

  it('2. advisor reserva la última unidad; grounded_query es rechazado antes de recuperar y generar', async () => {
    await lastUnitDuel('advisor', 'grounded_query')
  })

  it('3. validator contra composer sobre la última unidad: como máximo un ganador', async () => {
    await setHeadroom(ORG_M, 1)
    const tv = await issued('validator', PROJECT_M1)
    const tc = await issued('composer', PROJECT_M1)
    const before = await chargeCount(ORG_M)

    const [rv, rc] = await Promise.all([
      rt.validator.run(PROJECT_M1, tv),
      rt.composer.run(PROJECT_M1, tc),
    ])

    const winners = [rv, rc].filter((r) => r.ok)
    expect(winners.length, 'dos operaciones concurrentes cobraron la misma unidad').toBeLessThanOrEqual(1)
    expect(await chargeCount(ORG_M)).toBe(before + winners.length)
  })

  it('4. proxy_reviewer contra evidence_reviewer sobre la última unidad', async () => {
    await setHeadroom(ORG_M, 1)
    const tp = await issued('proxy_reviewer', PROJECT_M1)
    const te = await issued('evidence_reviewer', PROJECT_M1)
    const before = await chargeCount(ORG_M)

    const [rp, re] = await Promise.all([
      rt.proxy_reviewer.run(PROJECT_M1, tp),
      rt.evidence_reviewer.run(PROJECT_M1, te),
    ])

    const winners = [rp, re].filter((r) => r.ok)
    expect(winners.length).toBeLessThanOrEqual(1)
    expect(await chargeCount(ORG_M)).toBe(before + winners.length)
  })

  it('5. audit_assistant reserva, completa y queda registrado bajo SU categoría', async () => {
    const { rows } = await ledgerDelta(ORG_M, async () => {
      const t = await issued('audit_assistant', PROJECT_M1)
      const r = await rt.audit_assistant.run(PROJECT_M1, t)
      expect(r.ok, JSON.stringify(r)).toBe(true)
      return t
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.stella_role).toBe('audit_assistant')
    expect(rows[0]!.project_id).toBe(PROJECT_M1)
  })
})

/* ========================================================================== */
/* 6-8. Actores, proyectos y organizaciones                                   */
/* ========================================================================== */

describe('6-8. El alcance del pool', () => {
  it('6. la RESERVA VIVA del actor M1 es visible para el actor M2 — R1b, sin oversell', async () => {
    await setHeadroom(ORG_M, 1)

    // M1 LIGA la única unidad y la deja VIVA. La reserva se mantiene ligando el
    // ticket por el adaptador real y no completándolo: es el estado que R1b
    // describe —una reserva sostenida mientras el proveedor trabaja— y el único
    // que puede distinguir «el otro actor ve la reserva» de «el otro actor ve
    // el cargo».
    //
    // El bind se hace por el ADAPTADOR y no por la acción entera porque la
    // acción, al terminar, o cobra o suelta: no hay forma de dejarla a medias
    // sin dejar el proceso a medias. El adaptador es el mismo que la acción
    // usa, con la misma identidad y el mismo SQL.
    const { bindOperationTicket } = await import('@/db/stella/operation-tickets')
    const { withDatabaseIdentityContext } = await import('@/db/identity-context')
    const { operationRequestHash } = await import('@/lib/stella/operation-ticket/operation-request-hash')

    const t1 = await issued('advisor', PROJECT_M1)
    const bound = await withDatabaseIdentityContext(
      { userId: ACTOR_M1, organizationId: ORG_M, isSuperAdmin: false },
      () =>
        bindOperationTicket(
          t1,
          PROJECT_M1,
          operationRequestHash({ category: 'advisor', projectId: PROJECT_M1, parts: ['step', 'narrative'] }),
          'advisor',
        ),
    )
    expect(bound.kind).toBe('bound')
    expect(await liveReserved(ORG_M), 'la reserva no quedó viva').toBe(1)

    // Y ahora el OTRO actor de la MISMA organización. La policy que gobierna la
    // lectura de tickets es actor-scoped (`actor_id = auth.uid()`), así que si
    // la aritmética contara reservas bajo la identidad del llamante, M2 vería
    // cero y se llevaría la unidad. Esto es exactamente R1b.
    currentActor = { userId: ACTOR_M2, organizationId: ORG_M, role: 'organization_admin' }
    const t2 = await issued('validator', PROJECT_M1)
    providerCalls = []
    const r2 = await rt.validator.run(PROJECT_M1, t2)

    expect(r2.ok, 'el segundo actor se llevó una unidad que otra reserva sostenía').toBe(false)
    expect(providerCalls, 'el segundo actor llegó a ejecutar').toEqual([])
    expect(await chargeCount(ORG_M)).toBe(baseline[ORG_M])
  })

  it('7. dos proyectos de la MISMA organización comparten límite y cobran a su proyecto', async () => {
    // DOS MITADES, y la primera versión de este caso sólo medía la segunda.
    // «Cobran a su proyecto» es ATRIBUCIÓN; «comparten límite» es que gastar en
    // uno deje sin sitio al otro. Un sistema con un pool POR PROYECTO pasaría la
    // mitad de atribución con nota perfecta — lo señaló la revisión adversarial
    // A, y tenía razón: la propiedad estaba afirmada, no medida.

    /* --- (a) atribución: cada cargo bajo su proyecto -------------------- */
    await setHeadroom(ORG_M, 10)
    const { rows } = await ledgerDelta(ORG_M, async () => {
      const t1 = await issued('validator', PROJECT_M1)
      expect((await rt.validator.run(PROJECT_M1, t1)).ok).toBe(true)
      const t2 = await issued('validator', PROJECT_M2)
      expect((await rt.validator.run(PROJECT_M2, t2)).ok).toBe(true)
    })
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.project_id))).toEqual(new Set([PROJECT_M1, PROJECT_M2]))
    expect(await chargeCountForProject(ORG_M, PROJECT_M1)).toBeGreaterThan(0)
    expect(await chargeCountForProject(ORG_M, PROJECT_M2)).toBeGreaterThan(0)

    /* --- (b) pool compartido: agotar en M1 deja sin sitio a M2 ---------- */
    // Se deja hueco para UNA unidad, se gasta en PROJECT_M1, y se comprueba que
    // una operación de PROJECT_M2 —otro proyecto, misma organización— es
    // rechazada ANTES de ejecutar.
    await setQuota(ORG_M, (await chargeCount(ORG_M)) + 1)
    const tM1 = await issued('advisor', PROJECT_M1)
    expect((await rt.advisor.run(PROJECT_M1, tM1)).ok).toBe(true)

    const beforeM2 = await chargeCountForProject(ORG_M, PROJECT_M2)
    const tM2 = await issued('advisor', PROJECT_M2)
    providerCalls = []
    const m2 = await rt.advisor.run(PROJECT_M2, tM2)
    expect(m2.ok, 'PROJECT_M2 cobró una unidad que PROJECT_M1 ya había gastado').toBe(false)
    expect(providerCalls, 'PROJECT_M2 llegó a ejecutar sin cuota').toEqual([])
    expect(await chargeCountForProject(ORG_M, PROJECT_M2)).toBe(beforeM2)
  })

  it('8. la organización N está aislada: agotar M no la afecta', async () => {
    await setHeadroom(ORG_M, 0)
    const tm = await issued('advisor', PROJECT_M1)
    expect((await rt.advisor.run(PROJECT_M1, tm)).ok).toBe(false)

    currentActor = { userId: ACTOR_N1, organizationId: ORG_N, role: 'organization_admin' }
    const beforeN = await chargeCount(ORG_N)
    const tn = await issued('advisor', PROJECT_N1)
    expect((await rt.advisor.run(PROJECT_N1, tn)).ok).toBe(true)
    expect(await chargeCount(ORG_N)).toBe(beforeN + 1)
    expect(await chargeCountForProject(ORG_N, PROJECT_N1)).toBeGreaterThan(0)
  })
})

/* ========================================================================== */
/* 9-11. Reintento, operación nueva y reintento concurrente                   */
/* ========================================================================== */

describe('9-11. Identidad de la operación', () => {
  it('9. un reintento con el MISMO ticket no reserva ni cobra de nuevo', async () => {
    const t = await issued('advisor', PROJECT_M1)
    const { rows: first } = await ledgerDelta(ORG_M, () => rt.advisor.run(PROJECT_M1, t))
    expect(first).toHaveLength(1)

    const { result, rows: second } = await ledgerDelta(ORG_M, () => rt.advisor.run(PROJECT_M1, t))
    expect(second, 'el reintento creó una segunda fila de ledger').toHaveLength(0)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('ALREADY_COMPLETED_RESULT_UNAVAILABLE')
  })

  it('10. una operación NUEVA con el mismo contenido emite ticket nuevo y cobra otra vez', async () => {
    const t1 = await issued('advisor', PROJECT_M1)
    const { rows: r1 } = await ledgerDelta(ORG_M, () => rt.advisor.run(PROJECT_M1, t1))
    const t2 = await issued('advisor', PROJECT_M1)
    const { rows: r2 } = await ledgerDelta(ORG_M, () => rt.advisor.run(PROJECT_M1, t2))

    expect(t1).not.toBe(t2)
    expect(r1).toHaveLength(1)
    expect(r2).toHaveLength(1)
    expect(r1[0]!.idempotency_key).not.toBe(r2[0]!.idempotency_key)
  })

  it('11. dos entregas CONCURRENTES del mismo ticket: como máximo una respuesta y un cargo', async () => {
    const t = await issued('validator', PROJECT_M1)
    const before = await chargeCount(ORG_M)
    const [a, b] = await Promise.all([
      rt.validator.run(PROJECT_M1, t),
      rt.validator.run(PROJECT_M1, t),
    ])
    const usable = [a, b].filter((r) => r.ok)
    expect(usable.length, 'dos respuestas utilizables para un solo ticket').toBeLessThanOrEqual(1)
    expect(await chargeCount(ORG_M)).toBe(before + 1)
  })
})

/* ========================================================================== */
/* 12-14. Abort, expiración y transición de periodo                           */
/* ========================================================================== */

describe('12-14. Ciclo de vida de la reserva', () => {
  it('12. un fallo DESPUÉS de bind aborta: cero cargo y la unidad vuelve', async () => {
    await setHeadroom(ORG_M, 1)
    providerBreaksFor = 'validator'
    const t = await issued('validator', PROJECT_M1)
    const before = await chargeCount(ORG_M)

    const r = await rt.validator.run(PROJECT_M1, t)
    expect(r.ok).toBe(false)
    expect(providerCalls.some((c) => c.role === 'validator'), 'el proveedor no llegó a ejecutarse').toBe(true)
    expect(await chargeCount(ORG_M)).toBe(before)
    expect(await ticketRow(t).then((x) => x?.status)).toBe('aborted')
    expect(await liveReserved(ORG_M)).toBe(0)

    // Y la unidad está libre otra vez: otra categoría la toma.
    providerBreaksFor = null
    const t2 = await issued('advisor', PROJECT_M1)
    expect((await rt.advisor.run(PROJECT_M1, t2)).ok).toBe(true)
  })

  it('13. una reserva expirada deja de contar sin cron, y su complete es rechazado', async () => {
    await setHeadroom(ORG_M, 1)
    const t = await issued('composer', PROJECT_M1)
    // Ligar sin completar: el proveedor se rompe, pero el abort se impide
    // caducando el ticket ANTES de que el driver lo suelte. Se hace al revés:
    // se liga por la acción real y luego se envejece la fila.
    providerBreaksFor = 'composer'
    await rt.composer.run(PROJECT_M1, t)
    providerBreaksFor = null

    // El ticket quedó abortado por el driver; para medir EXPIRACIÓN se emite
    // otro y se envejece su ventana directamente en la fila.
    const t2 = await issued('composer', PROJECT_M1)
    await rewriteTicketWindow(t2, { boundAt: '-1 hour', expiresAt: '-30 minutes' })
    expect(await liveReserved(ORG_M), 'una reserva expirada sigue contando').toBe(0)

    // La unidad es reutilizable por otra categoría…
    const t3 = await issued('advisor', PROJECT_M1)
    expect((await rt.advisor.run(PROJECT_M1, t3)).ok).toBe(true)

    // …y el ticket expirado ya no puede completarse.
    const r = await rt.composer.run(PROJECT_M1, t2)
    expect(r.ok).toBe(false)
  })

  it('14. una reserva viva de OTRO periodo sigue contando, y no hay doble conteo', async () => {
    await setHeadroom(ORG_M, 1)
    const t = await issued('evidence_reviewer', PROJECT_M1)
    await rewriteTicketWindow(t, {
      // Reservada el mes pasado, viva ahora: es la ventana que la transición de
      // periodo necesita y la que `period_month` recuerda.
      boundAt: '-' + (new Date().getUTCDate() + 1) + ' days',
      // La ventana original se CONSERVA: emitirla ya la puso en el futuro, y
      // reescribirla obligaría a retirar y recrear la fila sin necesidad.
      expiresAt: null,
    })
    const rows = await admin`
      SELECT period_month FROM uellix_stella_ops.operation_tickets WHERE ticket_id = ${t}
    `
    // `period_month` es GENERATED ALWAYS desde bound_at: la fila recuerda el
    // periodo en que se reservó, y la aritmética NO lo filtra a propósito.
    expect(rows[0]!.period_month).not.toBeNull()
    expect(await liveReserved(ORG_M), 'la reserva de otro mes dejó de contar').toBe(1)

    // Con la única unidad reservada por el mes anterior, una operación de ESTE
    // mes es rechazada — conservador y nunca sobrevendedor.
    const t2 = await issued('advisor', PROJECT_M1)
    providerCalls = []
    expect((await rt.advisor.run(PROJECT_M1, t2)).ok).toBe(false)
    expect(providerCalls).toEqual([])
    // Cero cargos NUEVOS. El absoluto sería la historia entera de la batería:
    // el ledger es append-only y no se puede vaciar entre escenarios.
    expect(await chargeCount(ORG_M)).toBe(baseline[ORG_M])
  })
})

/* ========================================================================== */
/* 15-17. Ataques                                                             */
/* ========================================================================== */

describe('15-17. Ataques en vivo', () => {
  it('15. ninguna escritura directa del ledger sobrevive', async () => {
    const attacks: Array<[string, string]> = [
      [
        'uellix_app INSERT',
        `SET LOCAL ROLE uellix_app; INSERT INTO public.stella_interactions
           (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json, model_used, idempotency_key)
         VALUES ('${ORG_M}','${PROJECT_M1}','${ACTOR_M1}','advisor','narrative', repeat('1',64), '{}'::jsonb, 'm', repeat('1',64))`,
      ],
      [
        'uellix_writer INSERT',
        `SET LOCAL ROLE uellix_writer; INSERT INTO public.stella_interactions
           (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json, model_used, idempotency_key)
         VALUES ('${ORG_M}','${PROJECT_M1}','${ACTOR_M1}','advisor','narrative', repeat('1',64), '{}'::jsonb, 'm', repeat('2',64))`,
      ],
      [
        'authenticated INSERT',
        `SET LOCAL ROLE authenticated; INSERT INTO public.stella_interactions
           (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json, model_used, idempotency_key)
         VALUES ('${ORG_M}','${PROJECT_M1}','${ACTOR_M1}','advisor','narrative', repeat('1',64), '{}'::jsonb, 'm', repeat('3',64))`,
      ],
      ['COPY FROM', `SET LOCAL ROLE uellix_app; COPY public.stella_interactions FROM PROGRAM 'echo'`],
      [
        'owner sin identidad gobernada',
        `SET LOCAL ROLE uellix_owner; INSERT INTO public.stella_interactions
           (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json, model_used)
         VALUES ('${ORG_M}','${PROJECT_M1}','${ACTOR_M1}','advisor','narrative', repeat('1',64), '{}'::jsonb, 'm')`,
      ],
    ]

    const before = await chargeCount(ORG_M)
    for (const [label, sql] of attacks) {
      let refused = false
      try {
        await admin.begin(async (tx) => {
          await tx.unsafe(sql)
          throw new Error('ROLLBACK_IF_IT_SUCCEEDED')
        })
      } catch (error) {
        refused = (error as Error).message !== 'ROLLBACK_IF_IT_SUCCEEDED'
      }
      expect(refused, `${label} NO fue rechazado`).toBe(true)
    }
    expect(await chargeCount(ORG_M)).toBe(before)
  })

  it('16. un ticket de otra categoría es rechazado ANTES de ejecutar, sin cargo', async () => {
    const crossings: Array<[Category, Category]> = [
      ['advisor', 'validator'],
      ['validator', 'composer'],
      ['proxy_reviewer', 'evidence_reviewer'],
      ['grounded_query', 'advisor'],
      ['advisor', 'grounded_query'],
    ]
    for (const [issuedAs, presentedTo] of crossings) {
      const t = await issued(issuedAs, PROJECT_M1)
      providerCalls = []
      const { result, rows } = await ledgerDelta(ORG_M, () => rt[presentedTo].run(PROJECT_M1, t))
      expect(result.ok, `${issuedAs} → ${presentedTo} completó`).toBe(false)
      expect(rows, `${issuedAs} → ${presentedTo} dejó una fila`).toHaveLength(0)
      expect(
        providerCalls.filter((c) => c.role === rt[presentedTo].providerRole),
        `${issuedAs} → ${presentedTo} llegó a ejecutar`,
      ).toEqual([])
      expect(await liveReserved(ORG_M), 'la presentación cruzada dejó una reserva viva').toBe(0)
    }
  })

  it('17. cross-project, cross-organization y cross-actor: cero cargo', async () => {
    // Cross-project: ticket de M1 presentado ejecutando M2.
    const tProject = await issued('validator', PROJECT_M1)
    let d = await ledgerDelta(ORG_M, () => rt.validator.run(PROJECT_M2, tProject))
    expect(d.result.ok).toBe(false)
    expect(d.rows).toHaveLength(0)

    // Cross-actor: M2 presenta el ticket de M1.
    const tActor = await issued('advisor', PROJECT_M1)
    currentActor = { userId: ACTOR_M2, organizationId: ORG_M, role: 'organization_admin' }
    d = await ledgerDelta(ORG_M, () => rt.advisor.run(PROJECT_M1, tActor))
    expect(d.result.ok).toBe(false)
    expect(d.rows).toHaveLength(0)

    // Cross-organization: N1 presenta un ticket de M.
    currentActor = { userId: ACTOR_N1, organizationId: ORG_N, role: 'organization_admin' }
    const beforeN = await chargeCount(ORG_N)
    d = await ledgerDelta(ORG_M, () => rt.advisor.run(PROJECT_M1, tActor))
    expect(d.result.ok).toBe(false)
    expect(d.rows).toHaveLength(0)
    expect(await chargeCount(ORG_N)).toBe(beforeN)
  })
})

/* ========================================================================== */
/* 18. Bandera apagada                                                        */
/* ========================================================================== */

describe('18. Bandera apagada', () => {
  it('con la bandera en false no hay ticket, ni ejecución, ni proveedor, ni evento', async () => {
    mockStellaConfig.isValidatorEnabled = false
    captured = []
    providerCalls = []
    const before = await chargeCount(ORG_M)

    const issue = await rt.validator.issue(PROJECT_M1)
    expect(issue.status).not.toBe('issued')

    const run = await rt.validator.run(PROJECT_M1, 'a'.repeat(64))
    expect(run.ok).toBe(false)

    expect(providerCalls, 'el proveedor fue llamado con la bandera apagada').toEqual([])
    expect(captured, 'se emitieron eventos con la bandera apagada').toEqual([])
    expect(await chargeCount(ORG_M)).toBe(before)
    // Un DELTA, no un absoluto: los tickets `completed` de escenarios previos no
    // se pueden retirar (`resetTickets` sólo borra los no completados) y contar
    // el total mediría la historia de la batería en vez de este escenario.
    const rows = await admin`
      SELECT count(*)::int AS n FROM uellix_stella_ops.operation_tickets
      WHERE organization_id = ${ORG_M} AND category = 'validator' AND status = 'issued'
    `
    expect(Number(rows[0]!.n), 'se emitió un ticket con la bandera apagada').toBe(0)
  })
})

/* ========================================================================== */
/* 19. Inspección del ledger — segunda conexión, fila por fila                */
/* ========================================================================== */

describe('19. Inspección del ledger', () => {
  it('cada categoría deja EXACTAMENTE una fila, correctamente atribuida', async () => {
    await setHeadroom(ORG_M, 100)
    const expected: Array<{ category: Category; ticket: string; project: string }> = []

    const { rows } = await ledgerDelta(ORG_M, async () => {
      for (const category of CATEGORIES) {
        const project = PROJECT_M1
        const t = await issued(category, project)
        const r = await rt[category].run(project, t)
        expect(r.ok, `${category}: ${JSON.stringify(r)}`).toBe(true)
        expected.push({ category, ticket: t, project })
      }
    })

    expect(rows, 'una fila por operación completada').toHaveLength(CATEGORIES.length)

    for (const { category, ticket, project } of expected) {
      const row = rows.find((r) => r.stella_role === category)
      expect(row, `no hay fila para ${category}`).toBeTruthy()
      expect(row!.organization_id).toBe(ORG_M)
      expect(row!.project_id).toBe(project)
      expect(row!.pipeline_step, `${category} sin pipeline_step`).toBeTruthy()
      // LAS DOS POBLACIONES, y la diferencia es del CONTRATO, no del arnés.
      // `grounded_query` se liquida por el verbo de TRES argumentos, que no
      // lleva payload: `stella_0016` fija su fila y `stella_0017` reproduce esa
      // fila exacta pasando NULL. Las seis hermanas se liquidan por el de SIETE,
      // que sí transporta el modelo y los tokens que el adaptador reportó.
      // Exigirle a la grounded lo mismo sería exigirle una fila que su verbo no
      // puede escribir.
      if (category === 'grounded_query') {
        expect(row!.model_used, 'la fila grounded dejó de ser la que stella_0016 fija').toBe('not-applicable')
      } else {
        expect(row!.model_used).toBe('e2e-deterministic')
        expect(row!.tokens_used).toBe(42)
      }
      expect(row!.idempotency_key, `${category} sin identidad gobernada`).toMatch(/^[0-9a-f]{64}$/)
      expect(row!.context_hash, `${category} sin context_hash`).toMatch(/^[0-9a-f]{64}$/)
      expect(row!.response_json, `${category} sin payload`).toBeTruthy()

      // El mapeo explícito: ticket → categoría esperada → proyecto → fila.
      const ticketState = await ticketRow(ticket)
      expect(ticketState!.status).toBe('completed')
      expect(ticketState!.category).toBe(category)
      expect(ticketState!.project_id).toBe(project)
    }

    // Claves de idempotencia DISTINTAS para operaciones distintas.
    const keys = rows.map((r) => r.idempotency_key)
    expect(new Set(keys).size).toBe(keys.length)

    // Ni el prompt ni el contexto viajan al ledger: `response_json` es la salida
    // del modelo, y ninguna fila contiene el texto del documento sembrado.
    for (const row of rows) {
      expect(JSON.stringify(row.response_json)).not.toContain(DOCUMENT_TEXT.slice(0, 30))
    }
  })

  it('el CHECK de identidad gobernada rechaza una fila NUEVA sin clave, y se inventaría el histórico', async () => {
    let refused = false
    try {
      await admin.begin(async (tx) => {
        await tx.unsafe(`
          SET LOCAL ROLE uellix_owner;
          INSERT INTO public.stella_interactions
            (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json, model_used)
          VALUES ('${ORG_M}','${PROJECT_M1}','${ACTOR_M1}','advisor','narrative', repeat('1',64), '{}'::jsonb, 'm')
        `)
        throw new Error('ROLLBACK_IF_IT_SUCCEEDED')
      })
    } catch (error) {
      refused = (error as Error).message !== 'ROLLBACK_IF_IT_SUCCEEDED'
    }
    expect(refused, 'una fila nueva sin identidad gobernada fue aceptada').toBe(true)

    // INVENTARIO del histórico. En esta base desechable no hay filas previas al
    // paquete, así que el CHECK PUEDE validarse — y se mide en vez de suponerse.
    const legacy = await admin`
      SELECT count(*)::int AS n FROM public.stella_interactions WHERE idempotency_key IS NULL
    `
    expect(Number(legacy[0]!.n)).toBe(0)

    // Se valida en una transacción que se deshace: el objetivo es DEMOSTRAR que
    // es validable en este estado, no cambiar el paquete publicado.
    let validated = false
    try {
      await admin.begin(async (tx) => {
        await tx.unsafe(
          'ALTER TABLE public.stella_interactions VALIDATE CONSTRAINT stella_interactions_governed_identity_check',
        )
        validated = true
        throw new Error('ROLLBACK_AFTER_PROOF')
      })
    } catch (error) {
      if ((error as Error).message !== 'ROLLBACK_AFTER_PROOF') validated = false
    }
    expect(validated, 'el CHECK no pudo validarse pese a no haber filas incompatibles').toBe(true)
  })
})

/* ========================================================================== */
/* 20. Observabilidad de runtime                                              */
/* ========================================================================== */

describe('20. Observabilidad', () => {
  it('el runtime emite el ciclo completo, y ninguna carga sensible viaja en los eventos', async () => {
    await setHeadroom(ORG_M, 100)
    captured = []

    // Un recorrido que toca cada rama: emisión, bind, conversión, consumo,
    // reintento, abort, rechazo por categoría y rechazo por scope.
    const t = await issued('advisor', PROJECT_M1)
    expect((await rt.advisor.run(PROJECT_M1, t)).ok).toBe(true)
    await rt.advisor.run(PROJECT_M1, t) // reintento → replay

    providerBreaksFor = 'validator'
    const tAbort = await issued('validator', PROJECT_M1)
    await rt.validator.run(PROJECT_M1, tAbort) // abort
    providerBreaksFor = null

    const tCross = await issued('advisor', PROJECT_M1)
    await rt.validator.run(PROJECT_M1, tCross) // category mismatch

    const tScope = await issued('advisor', PROJECT_M1)
    await rt.advisor.run(PROJECT_M2, tScope) // scope mismatch

    // Sin HUECO, y no «cuota cero»: bajar el tope por debajo de lo ya
    // consumido en este mismo escenario haría fallar la invariante por una
    // razón que stella_0016 declara legítima (un cap bajado no anula
    // compromisos hechos). Lo que este caso quiere es que no quede sitio.
    await setQuota(ORG_M, await chargeCount(ORG_M))
    const tNoQuota = await issued('advisor', PROJECT_M1)
    await rt.advisor.run(PROJECT_M1, tNoQuota) // capacity rejected

    for (const name of [
      'operation_ticket_issued',
      'operation_ticket_bound',
      'quota_reservation_created',
      'quota_reservation_converted',
      'quota_consumed',
      'quota_reservation_released',
      'quota_capacity_rejected',
      'quota_reuse_detected',
      'replay_rejected',
    ]) {
      expect(eventsNamed(name).length, `no se emitió ningún ${name}`).toBeGreaterThan(0)
    }

    // Los dos rechazos que la fase 7 nombra viajan como `replay_rejected` con su
    // propio `reasonCode`, que es el vocabulario que el runtime realmente emite.
    expect(eventsWithReason('replay_rejected', 'category_mismatch').length).toBeGreaterThan(0)
    expect(eventsWithReason('replay_rejected', 'out_of_scope').length).toBeGreaterThan(0)

    // ALLOWLIST. Ningún evento lleva prompt, consulta, contexto, respuesta,
    // evidencia, hash, nonce, clave de idempotencia ni token.
    const ALLOWED = new Set([
      'eventName',
      'timestamp',
      'organizationId',
      'projectId',
      'interactionId',
      'requestId',
      'ticketId',
      'reservationId',
      'chargeId',
      'reasonCode',
      'attempt',
    ])
    for (const event of captured) {
      for (const key of Object.keys(event.payload)) {
        expect(ALLOWED.has(key), `${event.eventName} lleva un campo no permitido: ${key}`).toBe(true)
      }
      const serialized = JSON.stringify(event.payload)
      expect(serialized).not.toContain(DOCUMENT_TEXT.slice(0, 30))
      expect(serialized).not.toContain('systemPrompt')
      expect(serialized).not.toContain('requires_human_review')
    }

    expect(telemetryFailures(), 'la telemetría descartó payloads').toBe(0)
  })
})

/* ========================================================================== */
/* 21. El gate — alimentado POR ESTA EJECUCIÓN                                */
/* ========================================================================== */


describe('21. runtime-reserved-quota-verified', () => {
  it('pasa a TRUE sólo con la evidencia MEDIDA en esta ejecución, y cae si se le retira una pieza', async () => {
    const { evaluateMulticategoryQuotaGate, MULTICATEGORY_EVIDENCE_KEYS } = await import(
      '@/tests/eval/stella-release/multicategory-release-gate'
    )

    // UN RECORRIDO SEGUIDO. El gate afirma cosas sobre UNA ejecución, y coserlo
    // desde escenarios independientes permitiría que dos mediciones
    // incompatibles se presentaran como una.
    //
    // NADA de lo que sigue es un literal `true`. La primera versión de este
    // bloque rellenaba nueve campos con constantes y el gate «pasaba» — que es
    // exactamente la tautología que la fase 8 prohíbe. Cada campo de abajo es
    // el resultado de una medición hecha aquí.
    await setHeadroom(ORG_M, 100)
    captured = []
    providerCalls = []

    /* --- (a) las siete categorías, con runtime real --------------------- */
    const reached: string[] = []
    const { rows } = await ledgerDelta(ORG_M, async () => {
      for (const category of CATEGORIES) {
        const t = await issued(category, PROJECT_M1)
        const r = await rt[category].run(PROJECT_M1, t)
        expect(r.ok, `${category}: ${JSON.stringify(r)}`).toBe(true)
        reached.push(category)
      }
    })
    const ledgerAttributionCorrect = rows.every(
      (r) =>
        r.organization_id === ORG_M &&
        r.project_id === PROJECT_M1 &&
        typeof r.idempotency_key === 'string' &&
        /^[0-9a-f]{64}$/.test(r.idempotency_key) &&
        (CATEGORIES as readonly string[]).includes(r.stella_role),
    )

    /* --- (b) reintento y operación nueva -------------------------------- */
    const tRetry = await issued('advisor', PROJECT_M1)
    const firstRun = await ledgerDelta(ORG_M, () => rt.advisor.run(PROJECT_M1, tRetry))
    const retry = await ledgerDelta(ORG_M, () => rt.advisor.run(PROJECT_M1, tRetry))
    const retryChargedNothing = firstRun.rows.length === 1 && retry.rows.length === 0

    const tFresh = await issued('advisor', PROJECT_M1)
    const fresh = await ledgerDelta(ORG_M, () => rt.advisor.run(PROJECT_M1, tFresh))
    const newOperationCharged =
      fresh.rows.length === 1 && fresh.rows[0]!.idempotency_key !== firstRun.rows[0]!.idempotency_key

    /* --- (c) abort tras bind -------------------------------------------- */
    providerBreaksFor = 'validator'
    const tAbort = await issued('validator', PROJECT_M1)
    const aborted = await ledgerDelta(ORG_M, () => rt.validator.run(PROJECT_M1, tAbort))
    providerBreaksFor = null
    const abortChargedNothing =
      aborted.rows.length === 0 && (await ticketRow(tAbort))?.status === 'aborted'

    /* --- (d) expiración, sin cron --------------------------------------- */
    const tExpire = await issued('composer', PROJECT_M1)
    await rewriteTicketWindow(tExpire, { boundAt: '-1 hour', expiresAt: '-30 minutes' })
    const reservedAfterExpiry = await liveReserved(ORG_M)
    const expiredComplete = await ledgerDelta(ORG_M, () => rt.composer.run(PROJECT_M1, tExpire))
    const expirationReleased =
      reservedAfterExpiry === 0 && !expiredComplete.result.ok && expiredComplete.rows.length === 0

    /* --- (e) transición de periodo -------------------------------------- */
    const tPeriod = await issued('evidence_reviewer', PROJECT_M1)
    await rewriteTicketWindow(tPeriod, {
      // Reservada el mes pasado, viva ahora: es la ventana que la transición de
      // periodo necesita y la que `period_month` recuerda.
      boundAt: '-' + (new Date().getUTCDate() + 1) + ' days',
      // La ventana original se CONSERVA: emitirla ya la puso en el futuro, y
      // reescribirla obligaría a retirar y recrear la fila sin necesidad.
      expiresAt: null,
    })
    const periodRow = await ticketRow(tPeriod)
    const periodConsistent = (await liveReserved(ORG_M)) === 1 && periodRow?.period_month != null

    /* --- (f) R1b: la reserva viva de un actor, vista por el otro --------- */
    // Se aprovecha la reserva de (e), que está VIVA y pertenece a M1, y se
    // reduce el hueco a exactamente esa unidad.
    await setQuota(ORG_M, (await chargeCount(ORG_M)) + 1)
    currentActor = { userId: ACTOR_M2, organizationId: ORG_M, role: 'organization_admin' }
    const tOtherActor = await issued('validator', PROJECT_M1)
    providerCalls = []
    const otherActor = await ledgerDelta(ORG_M, () => rt.validator.run(PROJECT_M1, tOtherActor))
    const crossActorVisibility =
      !otherActor.result.ok &&
      otherActor.rows.length === 0 &&
      providerCalls.every((c) => c.role !== 'validator')
    currentActor = { userId: ACTOR_M1, organizationId: ORG_M, role: 'organization_admin' }

    /* --- (g) hermana rechazada por una reserva viva, sin ejecutar ------- */
    const tSibling = await issued('composer', PROJECT_M1)
    providerCalls = []
    const sibling = await ledgerDelta(ORG_M, () => rt.composer.run(PROJECT_M1, tSibling))
    const siblingReservationRejected = !sibling.result.ok && sibling.rows.length === 0
    const siblingNeverExecuted = providerCalls.every((c) => c.role !== 'composer')

    // Devolver el hueco y soltar la reserva del mes anterior.
    await admin`DELETE FROM uellix_stella_ops.operation_tickets WHERE ticket_id = ${tPeriod}`
    await setHeadroom(ORG_M, 100)

    /* --- (h) cruce de categoría y de scope ------------------------------ */
    const beforeAttacks = await chargeCount(ORG_M)
    const tCat = await issued('advisor', PROJECT_M1)
    providerCalls = []
    const catAttack = await ledgerDelta(ORG_M, () => rt.validator.run(PROJECT_M1, tCat))
    const categoryBindingRejected =
      !catAttack.result.ok &&
      catAttack.rows.length === 0 &&
      providerCalls.every((c) => c.role !== 'validator')

    const tScope = await issued('advisor', PROJECT_M1)
    const scopeAttack = await ledgerDelta(ORG_M, () => rt.advisor.run(PROJECT_M2, tScope))
    const scopeBindingRejected = !scopeAttack.result.ok && scopeAttack.rows.length === 0
    const attacksChargedNothing = (await chargeCount(ORG_M)) === beforeAttacks

    /* --- (i) proyectos hermanos: atribucion Y limite compartido ---------- */
    // LAS DOS MITADES. Atribuir bien no prueba que compartan: un pool POR
    // PROYECTO satisfaria la primera con nota perfecta. La segunda agota el
    // hueco desde M1 y exige que M2 sea rechazado antes de ejecutar.
    const beforeM2 = await chargeCountForProject(ORG_M, PROJECT_M2)
    const tM2 = await issued('validator', PROJECT_M2)
    expect((await rt.validator.run(PROJECT_M2, tM2)).ok).toBe(true)
    const attributedToItsOwnProject =
      (await chargeCountForProject(ORG_M, PROJECT_M2)) === beforeM2 + 1 &&
      (await chargeCountForProject(ORG_M, PROJECT_M1)) > 0

    await setQuota(ORG_M, (await chargeCount(ORG_M)) + 1)
    const tPoolM1 = await issued('advisor', PROJECT_M1)
    expect((await rt.advisor.run(PROJECT_M1, tPoolM1)).ok).toBe(true)
    const beforeStarved = await chargeCountForProject(ORG_M, PROJECT_M2)
    const tStarved = await issued('advisor', PROJECT_M2)
    providerCalls = []
    const starved = await rt.advisor.run(PROJECT_M2, tStarved)
    const poolIsShared =
      !starved.ok &&
      providerCalls.every((c) => c.role !== 'advisor') &&
      (await chargeCountForProject(ORG_M, PROJECT_M2)) === beforeStarved
    await setHeadroom(ORG_M, 100)

    const crossProjectSharedPool = attributedToItsOwnProject && poolIsShared

    /* --- (j) escritura directa ------------------------------------------ */
    let directWriteRejected = false
    try {
      await admin.begin(async (tx) => {
        await tx.unsafe(
          "SET LOCAL ROLE uellix_app; INSERT INTO public.stella_interactions " +
            "(organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json, model_used, idempotency_key) " +
            "VALUES ('" +
            ORG_M +
            "','" +
            PROJECT_M1 +
            "','" +
            ACTOR_M1 +
            "','advisor','narrative', repeat('9',64), '{}'::jsonb, 'm', repeat('9',64))",
        )
        throw new Error('ROLLBACK_IF_IT_SUCCEEDED')
      })
    } catch (error) {
      directWriteRejected = (error as Error).message !== 'ROLLBACK_IF_IT_SUCCEEDED'
    }

    /* --- (k) superficies sin ticket y forma de la cadena ---------------- */
    const privileges = await admin`
      SELECT
        has_function_privilege('uellix_app','uellix_stella_ops.bind_operation_ticket(character, uuid, character)','EXECUTE') AS blind_bind,
        has_function_privilege('uellix_app','uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)','EXECUTE') AS capacity,
        has_function_privilege('uellix_app','uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)','EXECUTE') AS quota,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'uellix_stella_ops') AS governed_functions
    `

    /* --- (l) la invariante, al cierre del recorrido ---------------------- */
    const [finalConsumed, finalReserved, finalLimit] = await Promise.all([
      chargeCount(ORG_M),
      liveReserved(ORG_M),
      limitOf(ORG_M),
    ])
    const base = baseline[ORG_M]!
    const invariantHeld =
      finalLimit === null || finalConsumed - base + finalReserved <= finalLimit - base

    /* --- (m) la base es desechable y está aislada ------------------------ */
    // NO se afirma «el contenedor fue destruido»: eso ocurre DESPUÉS de que este
    // proceso termine, y un campo que lo declarara sería una afirmación sin
    // medición — lo señaló la revisión adversarial B. Lo que se mide es lo que
    // es medible desde aquí, y son dos hechos independientes:
    //
    //   · la conexión apunta al contenedor efímero en loopback 56322, leído del
    //     entorno que el guion construyó (y sin el cual `beforeAll` ya abortó);
    //   · el guion declaró haber instalado su trap antes de invocar la batería.
    //
    // La destrucción real la afirma el §6 del guion, cuyo fallo aborta la
    // ejecución entera sea cual sea el veredicto de este gate.
    const disposableDatabaseGuarded =
      (CONTAINER_URL ?? '').includes('127.0.0.1:56322') &&
      process.env.UELLIX_MULTICATEGORY_TEARDOWN_GUARDED === '1'

    const evidence: MulticategoryQuotaEvidence = {
      categoriesReached: reached,
      ledgerRowsInspected: rows.length,
      ledgerAttributionCorrect,
      siblingReservationRejected,
      siblingNeverExecuted,
      crossActorVisibility,
      crossProjectSharedPool,
      categoryBindingRejected,
      scopeBindingRejected,
      attacksChargedNothing,
      retryChargedNothing,
      newOperationCharged,
      abortChargedNothing,
      expirationReleased,
      periodConsistent,
      directWriteRejected,
      unticketedConsumptionRejected:
        privileges[0]!.blind_bind === false &&
        privileges[0]!.capacity === false &&
        privileges[0]!.quota === false,
      governedFunctionCount: Number(privileges[0]!.governed_functions),
      observabilityEventsSeen: [...new Set(captured.map((e) => e.eventName))],
      invariantHeld,
      disposableDatabaseGuarded,
    }

    const verdict = evaluateMulticategoryQuotaGate(evidence)
    expect(verdict.reasons, 'el gate rechazó la evidencia de esta ejecución').toEqual([])
    expect(verdict.verified).toBe(true)

    // EL CONTROL NEGATIVO, UNO POR CAMPO. Retirar cualquiera lo devuelve a
    // false — que es lo que separa un gate de una constante con nombre largo.
    for (const key of MULTICATEGORY_EVIDENCE_KEYS) {
      const weakened = { ...evidence } as Record<string, unknown>
      const current = weakened[key]
      if (typeof current === 'boolean') weakened[key] = false
      else if (typeof current === 'number') weakened[key] = 0
      else if (Array.isArray(current)) weakened[key] = []
      const degraded = evaluateMulticategoryQuotaGate(weakened as unknown as MulticategoryQuotaEvidence)
      expect(degraded.verified, `retirar ${key} no bajó el gate`).toBe(false)
      expect(degraded.reasons.length, `retirar ${key} no produjo una razón`).toBeGreaterThan(0)
    }
  }, 300_000)
})
