'use server'
// app/actions/stella/grounded-query.ts
// INTEGRATION (Stella parallel train 3) — PRODUCT-002: the grounded-query
// orchestrator entry point.
//
// THE SEAM THIS CLOSES
//
//   StellaGroundedQueryPanel (client)   asks { query }
//        |                               ^
//        v                               |
//   runStellaGroundedQuery (here)  ------+   flag -> auth -> scope -> permission
//        |                                    -> quota -> repository -> orchestrator
//        v                                    -> ONE mapping -> sanitized result
//   orchestrateGroundedResponse (GROUNDING)
//        |
//        v
//   createPersistedGroundingChunkRepository (db/grounding) -> chunks_in_scope
//
// It satisfies `StellaGroundedQueryRunner` exactly, and `components/stella/**`
// does not import it: the runner is a PROP, wired at the mount site. That is
// the contract's own acceptance criterion #1, and it is what keeps the
// presentation layer free of `db/**` and of `node:crypto`.
//
// ---------------------------------------------------------------------------
// ORDER IS THE SECURITY PROPERTY
// ---------------------------------------------------------------------------
// The steps below are not interchangeable, and the flag being FIRST is the one
// that matters most: with `STELLA_GROUNDED_QUERY_ENABLED=false` this function
// returns before it has authenticated, before it has opened a database
// context, before it has read a quota row, before it has touched a chunk and
// before it has emitted a single observability event. "Disabled" therefore
// costs zero database work and leaks zero telemetry — which is what makes it
// safe to ship the code path dark.
//
// ---------------------------------------------------------------------------
// SCOPE IS DERIVED, NEVER RECEIVED
// ---------------------------------------------------------------------------
// `StellaGroundedQueryRequest` has exactly ONE field, `query`. There is no
// parameter here for an organization and none for a project id chosen by the
// caller. `organizationId` comes from `requireOrganizationAccess()`; the
// project is named by the SERVER at the mount site through `boundProjectId`,
// and is re-verified against the session's organization before anything reads
// a chunk. A payload that smuggles extra keys is not "rejected" so much as
// STRUCTURALLY IGNORED: `readQuery` below reads one property and nothing else,
// so an `organizationId` in the JSON has no reader.
//
// ---------------------------------------------------------------------------
// THERE IS NO FIXTURE PATH
// ---------------------------------------------------------------------------
// No mock repository, no seeded corpus, no sample answer. The generation step
// does not exist yet, and its absence is reported as `provider_unavailable`
// (see `absentAnswerDraftProvider`) — a claim about the SYSTEM — rather than
// filled in with plausible text, which would put unverifiable statements
// behind a citation UI whose whole purpose is that its statements are
// verifiable.

import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { canUseStella } from '@/lib/auth/permissions'
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { checkStellaQuota, nextQuotaResetIso, formatQuotaResetDate } from '@/lib/stella/quota'
import { consumeStellaRateLimit } from '@/lib/stella/rate-limit'
import { withOrganizationDatabaseContext } from '@/lib/auth/database-context'
import { db } from '@/db/client'
import { evidenceItems, projects } from '@/db/schema'
import { logAuditAction, AUDIT_ACTIONS } from '@/lib/audit/logger'
import {
  createPersistedGroundingChunkRepository,
  GroundingRepositoryContractError,
} from '@/db/grounding/grounding-chunk-repository'
import {
  GroundingScopeViolationError,
  assertValidScope,
  type GroundingScope,
} from '@/lib/grounding/contracts'
import {
  orchestrateGroundedResponse,
  RepositoryContractViolationError,
  type AnswerDraftProvider,
  type GroundingOrchestrationClassification,
  type GroundingOrchestrationResult,
} from '@/lib/grounding/retrieve'
import { adaptGroundedAnswer, presentationInputFromRetrieval } from '@/components/stella/grounding-adapter'
import type {
  StellaGroundedQueryRequest,
  StellaGroundedQueryResult,
} from '@/components/stella/grounded-query'
import type { StellaPanelErrorCode } from '@/components/stella/error-messages'

/* -------------------------------------------------------------------------- */
/* The single classification mapping (R8)                                     */
/* -------------------------------------------------------------------------- */

/**
 * R8 — ONE canonical vocabulary at this boundary, and ONE mapping out of it.
 *
 * Two vocabularies already exist and both are legitimate in their own layer:
 *
 *   `GroundedOutcomeKind` (5)                 — what the ANSWER BUILDER decided
 *   `GroundingOrchestrationClassification` (6) — what a CALLER switches on
 *
 * The second is a refinement of the first, computed once by
 * `orchestrateGroundedResponse` (it splits `insufficient_evidence` into a real
 * evidence gap and an `abstention` that is a security withholding). At THIS
 * boundary the canonical one is therefore **`GroundingOrchestrationClassification`**,
 * and `GroundedOutcomeKind` is never read here — reading both would be the
 * beginning of a third vocabulary, which is exactly what train 3 forbids.
 *
 * Product does not learn either of them. It receives `StellaGroundedQueryResult`,
 * whose success half carries `GroundedAnswerView.status` (GROUNDING's own
 * three-value answer status) and whose error half carries the SAME 12-code
 * `StellaPanelErrorCode` taxonomy the other five Stella actions return.
 *
 * The table below is the ONLY place a classification becomes a product result.
 */
const CLASSIFICATION_IS_ANSWERABLE: Record<GroundingOrchestrationClassification, boolean> = {
  // An answer exists and is citation-validated. Present it.
  grounded: true,
  partially_grounded: true,
  // A contradiction is an ANSWER — two cited passages that cannot both be
  // true, carried through with attribution and marked
  // `requires_human_resolution`. Suppressing it would be the one failure mode
  // the contradiction contract exists to prevent.
  contradictory: true,
  // An abstention is also an answer: `GroundedAnswerView.abstention` renders
  // GROUNDING's own reason code and explanation, which is more useful to a
  // reviewer than a generic error banner.
  insufficient_evidence: true,
  abstention: true,
  // The ONLY classification that is not an answer: nothing was read, or the
  // generation step could not run. This is a claim about the SYSTEM, and it
  // must stay distinguishable from "your evidence does not cover this".
  provider_unavailable: false,
}

/* -------------------------------------------------------------------------- */
/* The generation seam                                                        */
/* -------------------------------------------------------------------------- */

/**
 * There is no grounded-answer generator in this train.
 *
 * `AnswerDraftProvider` documents that an implementation must REJECT rather
 * than return a degraded draft when it could not run, and that
 * `orchestrateGroundedResponse` turns that rejection into
 * `provider_unavailable`. So the honest implementation of "no generator
 * exists" is one that rejects — not one that returns an empty draft, which
 * would assert "nothing to say about your evidence", a claim nothing measured.
 *
 * This is NOT a mock and NOT a fallback: it produces no content of any kind.
 */
const absentAnswerDraftProvider: AnswerDraftProvider = {
  id: 'stella-grounded-answer-generator-absent',
  draftAnswer() {
    return Promise.reject(
      new Error('no grounded-answer generator is configured in this build'),
    )
  },
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How many evidence items of the project may back one question. A cap, not a
 * preference: the repository reads one governed function call per evidence
 * item, so an unbounded set would turn one question into an unbounded number
 * of round trips.
 */
const MAX_EVIDENCE_ITEMS_PER_QUERY = 25

/**
 * THE QUOTA LEDGER HAS NO ROW TYPE FOR THIS CAPABILITY, AND THAT IS WHY
 * NOTHING IS CHARGED HERE.
 *
 * `checkStellaQuota` counts rows in `stella_interactions`, and every sibling
 * Stella action inserts one after a successful call precisely so the next
 * caller's quota check sees it. This action reads the quota (below) and does
 * NOT insert — so as written it would never CONSUME what it enforces.
 *
 * That is a real gap and it is not being hidden. It is also not fixable from
 * here: `stella_interactions_stella_role_check` admits exactly six values —
 * advisor, validator, composer, proxy_reviewer, evidence_reviewer,
 * audit_assistant — and `grounded_query` is not one of them. The two ways to
 * "fix" it locally are both worse than the gap:
 *
 *   - file the interaction as `advisor`, which corrupts quota attribution and
 *     the compliance trail for a capability that is not the advisor;
 *   - widen the CHECK constraint, which is `db/**` — CAPABILITIES-owned, and
 *     a schema change integration does not get to make unilaterally.
 *
 * So: contract request INT-CAP-001 asks CAPABILITIES for a `grounded_query`
 * value, the audit trail below is written NOW (it has no such constraint), and
 * the release gate lists the uncharged quota as missing evidence for
 * local-runtime-ready. The flag cannot be turned on without closing it.
 */
const QUOTA_LEDGER_ROLE_MISSING =
  'stella_interactions has no `grounded_query` role (INT-CAP-001); quota is enforced but not consumed'

export interface StellaGroundedQueryOptions {
  /**
   * The project the question is asked within. Supplied by the SERVER at the
   * mount site (a route param already resolved under an authenticated
   * session), never carried in the client payload — and re-verified against
   * the session's organization below regardless.
   */
  boundProjectId: string
}

/**
 * Run one grounded query.
 *
 * NOT EXPORTED, deliberately. Every export of a `'use server'` module is
 * registered as an independently invocable server-action endpoint, so
 * exporting this two-argument form would publish a second endpoint whose
 * `options` object a client supplies wholesale. One endpoint
 * (`runStellaGroundedQueryForProject`) is the smaller surface, and the
 * bound-argument form is the one the mount site actually uses.
 *
 * The project argument is re-verified against the session's organization
 * regardless of which form is called — see step 4.
 */
async function runStellaGroundedQuery(
  request: StellaGroundedQueryRequest,
  options: StellaGroundedQueryOptions,
): Promise<StellaGroundedQueryResult> {
  // 1. FLAG — first, before anything. See the header.
  if (!stellaConfig.isEnabled || !stellaConfig.isGroundedQueryEnabled || !stellaState.canUseStella) {
    return { status: 'error', code: 'DISABLED', message: 'La consulta fundamentada de Stella no está habilitada.' }
  }

  // Read exactly one property. Extra keys in the payload have no reader.
  const queryText = readQuery(request)
  if (queryText === null) {
    return failure('UNSUPPORTED_STEP', 'La consulta está vacía.')
  }

  // 2. AUTHENTICATE.
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return failure('UNAUTHORIZED', 'Se requiere autenticación.')
  }

  // 3. PERMISSION — set inclusion, same gate as every other Stella action.
  if (!canUseStella(ctx.membership.role)) {
    return failure('UNAUTHORIZED', 'Tu rol no tiene permiso para usar Stella.')
  }

  // 4. SCOPE — DERIVED. organizationId from the session; the project verified
  //    to belong to it.
  //
  //    `GroundingScope.projectId` is `string | null` ("the whole organization"
  //    is a representable scope), and this path REFUSES that width: a grounded
  //    answer is always asked inside one project, and an organization-wide
  //    scope here would let a question reach evidence from a project the
  //    reviewer is looking at nothing of. `projectId` is narrowed to a
  //    non-empty string before the scope is built, and stays the value every
  //    query below uses.
  const projectId = typeof options.boundProjectId === 'string' ? options.boundProjectId.trim() : ''
  if (projectId === '') {
    return failure('UNAUTHORIZED', 'El proyecto solicitado no es válido para esta sesión.')
  }

  const scope: GroundingScope = { organizationId: ctx.organization.id, projectId }
  try {
    assertValidScope(scope)
  } catch {
    return failure('UNAUTHORIZED', 'El proyecto solicitado no es válido para esta sesión.')
  }

  const projectBelongs = await withOrganizationDatabaseContext(() =>
    db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, scope.organizationId)))
      .limit(1),
  ).catch(() => null)

  if (projectBelongs === null) {
    return failure('UNKNOWN_ERROR', 'No se pudo verificar el proyecto.')
  }
  // Same message for "not yours" and "does not exist": telling them apart is a
  // tenancy oracle, the same reasoning grounding_0002's U0102 states in SQL.
  if (projectBelongs.length === 0) {
    return failure('UNAUTHORIZED', 'El proyecto solicitado no es válido para esta sesión.')
  }

  // 5. QUOTA, then the per-hour rate limit. Both before any chunk is read.
  const quota = await withOrganizationDatabaseContext(() => checkStellaQuota(scope.organizationId)).catch(
    () => null,
  )
  if (quota === null) {
    return failure('UNKNOWN_ERROR', 'No se pudo verificar la cuota de Stella.')
  }
  if (!quota.allowed) {
    // Verbatim to screen — `stellaErrorPresentation` passes QUOTA_EXCEEDED
    // through untouched because it carries quota, usage and reset date.
    const message =
      quota.reason === 'no_quota'
        ? 'Tu organización no tiene un plan de Stella asignado. Contactá a Uellix para habilitarlo.'
        : `Alcanzaste el límite mensual de ${quota.quota} consultas a Stella (usadas: ${quota.used}). Se renueva el ${formatQuotaResetDate(nextQuotaResetIso())}.`
    return failure('QUOTA_EXCEEDED', message)
  }

  const rate = await consumeStellaRateLimit(scope.organizationId).catch(() => null)
  if (rate === null) {
    return failure('RATE_LIMIT_UNAVAILABLE', 'No se pudo verificar el límite de uso de Stella.')
  }
  if (!rate.allowed) {
    return failure('RATE_LIMITED', 'Alcanzaste el límite de consultas por hora. Intentá de nuevo más tarde.')
  }

  // 6. AUTHORIZED EVIDENCE SET — named explicitly, because the governed SQL
  //    surface cannot enumerate "anything within scope" (see the repository).
  const evidenceIds = await withOrganizationDatabaseContext(() =>
    db
      .select({ id: evidenceItems.id })
      .from(evidenceItems)
      .where(
        and(
          eq(evidenceItems.organizationId, scope.organizationId),
          eq(evidenceItems.projectId, projectId),
          // `archived` and `rejected` evidence is excluded by an ALLOWLIST,
          // not by a `<> 'archived'` denylist: a status added later defaults
          // to being un-citable rather than to being citable, which is the
          // direction a mistake should fail in.
          inArray(evidenceItems.status, ['draft', 'under_review', 'approved']),
        ),
      )
      // Deterministic set for a given project — a cap applied to an unordered
      // read would make the same question reach different evidence run to run.
      .orderBy(evidenceItems.createdAt, evidenceItems.id)
      .limit(MAX_EVIDENCE_ITEMS_PER_QUERY),
  ).catch(() => null)

  if (evidenceIds === null) {
    return failure('UNKNOWN_ERROR', 'No se pudo leer la evidencia del proyecto.')
  }
  if (evidenceIds.length === 0) {
    // A real, reportable state — not an error. There is nothing to ground an
    // answer in, and saying so is more useful than a generic failure.
    return failure('UNSUPPORTED_STEP', 'Este proyecto no tiene evidencia cargada para fundamentar una respuesta.')
  }

  // 7. REPOSITORY + ORCHESTRATOR. Everything below runs inside the identity
  //    context so `chunks_in_scope` sees the session's claims.
  let orchestration: GroundingOrchestrationResult
  try {
    orchestration = await withOrganizationDatabaseContext(() =>
      orchestrateGroundedResponse(
        createPersistedGroundingChunkRepository(scope),
        absentAnswerDraftProvider,
        scope,
        queryText,
        { evidenceIds: evidenceIds.map((row) => row.id) },
      ),
    )
  } catch (error) {
    // A scope or repository-contract break is a BOUNDARY BREAK, not an
    // operational hiccup: it is logged by name and reported as an internal
    // error, never as "try again", and never with its own message.
    if (
      error instanceof GroundingScopeViolationError ||
      error instanceof RepositoryContractViolationError ||
      error instanceof GroundingRepositoryContractError
    ) {
      console.error('[stella-grounding] scope boundary violation:', error.name)
      return failure('UNKNOWN_ERROR', 'La consulta no pudo completarse.')
    }
    console.error('[stella-grounding] orchestration failed:', error instanceof Error ? error.name : 'unknown')
    return failure('UNKNOWN_ERROR', 'La consulta no pudo completarse.')
  }

  // 8/9. VALIDATE + ADAPT — exactly once, through the ONE authorized producer
  //      of the presentation model.
  const result = toProductResult(orchestration)

  // 10. AUDIT. Metadata only — ids, codes and counts, never the query text,
  //     never a claim, never a passage. Fire-and-forget: an audit_logs failure
  //     must not change what the reviewer sees, which is the same rule
  //     app/actions/stella/advisor.ts states for its own trail.
  //
  //     This is the half of the compliance record that IS writable today. The
  //     other half — the `stella_interactions` row that would CONSUME quota —
  //     is blocked on INT-CAP-001; see QUOTA_LEDGER_ROLE_MISSING.
  void auditGroundedQuery(ctx, projectId, {
    outcome: result.status === 'ok' ? orchestration.classification : result.code,
    quotaLedger: QUOTA_LEDGER_ROLE_MISSING,
  })

  return result
}

/**
 * Metadata-only audit write, in its own short transaction.
 *
 * Never awaited by the caller and never able to change the result: the
 * reviewer's answer does not depend on whether the trail was written, and a
 * failure here is logged by NAME only.
 */
async function auditGroundedQuery(
  ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>,
  projectId: string,
  afterJson: Record<string, unknown>,
): Promise<void> {
  try {
    await withOrganizationDatabaseContext(() =>
      logAuditAction({
        organizationId: ctx.organization.id,
        actorUserId: ctx.user.id,
        entityType: 'project',
        entityId: projectId,
        action: AUDIT_ACTIONS.STELLA_INVOKED,
        afterJson: { stellaRole: 'grounded_query', ...afterJson },
      }),
    )
  } catch (error) {
    console.error('[stella-grounding] audit write failed:', error instanceof Error ? error.name : 'unknown')
  }
}

/**
 * The BINDABLE form, for the mount site:
 *
 *   const runQuery = runStellaGroundedQueryForProject.bind(null, projectId)
 *
 * `Function.prototype.bind` on a server action is what Next.js supports for
 * carrying a server-resolved value across the RSC boundary. Precisely: the
 * bound argument is sealed into the action reference ON THE SERVER and travels
 * to the browser and back as an ENCRYPTED closure — it is not that the value
 * never crosses the network, it is that the browser cannot read or forge it.
 * The resulting signature is exactly `StellaGroundedQueryRunner` —
 * `(request: { query }) => …` — so the client component's own payload has
 * nowhere to put a scope.
 *
 * That is a convenience, not the boundary. The boundary is step 4 below: the
 * project is re-verified against the authenticated session's organization
 * before any chunk is read, so this function is safe to call with an arbitrary
 * `projectId` — which is what every export of a `'use server'` module must
 * assume, since each one is an independently invocable endpoint.
 *
 * `projectId` comes FIRST because `bind` prepends. It is a server-resolved
 * route param, and it is re-verified against the session's organization inside
 * `runStellaGroundedQuery` regardless of where it came from.
 */
export async function runStellaGroundedQueryForProject(
  projectId: string,
  request: StellaGroundedQueryRequest,
): Promise<StellaGroundedQueryResult> {
  return runStellaGroundedQuery(request, { boundProjectId: projectId })
}

/* -------------------------------------------------------------------------- */
/* Mapping and helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The ONE function that turns an orchestration result into a product result.
 * See `CLASSIFICATION_IS_ANSWERABLE` for why the split is where it is.
 */
function toProductResult(orchestration: GroundingOrchestrationResult): StellaGroundedQueryResult {
  const { classification, outcome } = orchestration

  if (!CLASSIFICATION_IS_ANSWERABLE[classification]) {
    // No provider detail crosses the boundary. `outcome.answer.abstention`
    // names the failing component internally; the client gets a fixed string.
    return failure('GEMINI_ERROR', 'Stella no pudo generar una respuesta fundamentada en este momento.')
  }

  // `retrieval` is null only when retrieval itself failed, which is
  // `provider_unavailable` and already handled above. Guarded anyway rather
  // than asserted: an empty presentation input yields citations marked
  // `source_unavailable`, which is honest, where a crash would not be.
  const input =
    outcome.retrieval === null
      ? { chunks: new Map(), candidates: new Map() }
      : presentationInputFromRetrieval(outcome.retrieval, outcome.retrieval.scorerId)

  return {
    status: 'ok',
    // Server-generated. A browser-generated id would give two tabs two
    // identities for the same exchange (PRODUCT-002 §4).
    answerId: randomUUID(),
    answer: adaptGroundedAnswer(outcome.answer, input),
  }
}

function failure(code: StellaPanelErrorCode, message: string): StellaGroundedQueryResult {
  return { status: 'error', code, message }
}

/**
 * Reads ONE property. A payload carrying `organizationId`, `projectId` or
 * `scope` is not rejected with an error message that would confirm the field
 * name — it simply has no reader, which is the stronger property.
 */
function readQuery(request: StellaGroundedQueryRequest): string | null {
  const raw = typeof request?.query === 'string' ? request.query.trim() : ''
  return raw.length === 0 ? null : raw
}
