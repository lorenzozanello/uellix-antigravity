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
//   runStellaGroundedQuery (here)  ------+   1 flag -> 2 auth -> 3 org scope ->
//        |                                   4 project scope -> 5 permission ->
//        |                                   6 project membership -> 7 quota ->
//        v                                   8 repository -> 9 query journey ->
//   runGroundedQuery (GROUNDING)             10 ONE mapping -> 11 sanitized audit
//        |
//        v
//   createPersistedGroundingChunkRepository (db/grounding)
//        -> uellix_grounding.chunks_in_scope_attested
//
// WHY PERMISSION (5) SITS AFTER THE SCOPE IS DERIVED (3, 4) BUT BEFORE THE
// DATABASE IS TOUCHED (6). Steps 3 and 4 are pure derivations — the
// organization comes out of the session object step 2 already returned, and
// the project is the bound argument, trimmed and shape-checked. Neither reads
// a row. So ordering them ahead of the role check costs nothing and gives the
// permission failure a scope to be reported against, while the first statement
// that actually queries (6, project membership) still happens only after a
// caller has been shown to hold the capability at all.
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
// No mock repository, no seeded corpus, no sample answer.
//
// Until Train 4 there was no generator either, and its absence was reported as
// `provider_unavailable` — a claim about the SYSTEM — rather than filled in
// with plausible text. That placeholder is gone: `runGroundedQuery` is given
// the LOCAL EXTRACTIVE generator explicitly (step 9), a real component that
// answers by quoting retrieved passages verbatim and runs offline.
//
// IT IS SELECTED, NEVER FALLEN BACK TO. The generator is named in the request
// unconditionally; there is no branch that reaches for it because a database
// was down, a package was missing or authorization failed. Those remain
// operational failures and remain `provider_unavailable`: answering them with
// quotations from an empty retrieval would present a system fault as an
// evidence finding.

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
  EXTRACTIVE_GENERATOR_NAME,
  RepositoryContractViolationError,
  createExtractiveAnswerProvider,
  runGroundedQuery,
  type GroundedQueryRun,
  type GroundingOrchestrationClassification,
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
 * QUOTA IS ENFORCED HERE AND STILL NOT CHARGED — AND THE REASON CHANGED IN
 * TRAIN 4. READ THIS BEFORE "JUST CALLING THE FUNCTION".
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NO LONGER THE PROBLEM
 * ---------------------------------------------------------------------------
 * INT-CAP-001 is closed. `db/prepared/stella_0013_grounded_query_quota.sql`
 * widens `stella_interactions_stella_role_check` to admit `grounded_query` and
 * installs `uellix_stella.consume_stella_quota`, which checks AND charges one
 * unit inside the caller's transaction under a per-organization advisory lock.
 * It is verified against a live disposable database
 * (`scripts/stella-train4-dry-run.sh`): first consumption, exhaustion,
 * cross-organization `U0102`, cross-project `U0102`, ungoverned role `U0106`,
 * and two real sessions racing for the last unit where the second waits for
 * the first to COMMIT and gets `quota_exceeded`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS THE PROBLEM — INT-INT-001, THE IDEMPOTENCY KEY HAS NO SOURCE
 * ---------------------------------------------------------------------------
 * `consume_stella_quota` REQUIRES an `idempotency_key`, and the requirement is
 * right: `uq_stella_interactions_idempotency` is what turns "do not charge a
 * retry twice" into a property of the DATA rather than of who called. But a
 * key is only worth the distinction it draws, and it must draw exactly one:
 *
 *     a RETRY of one question  ->  same key   (charge once)
 *     a NEW question           ->  new key    (charge again)
 *
 * Everything this action can reach fails one side of that:
 *
 *   * `randomUUID()` per invocation — the client cannot influence it, and a
 *     retry gets a fresh key. Charges twice. Fails the left side.
 *   * a digest of (user, project, query) — stable across a retry, and equally
 *     stable across a reviewer legitimately asking the same question twice
 *     after uploading new evidence. The second one is free. Fails the right
 *     side, and is named as prohibited in the Train 4 dispatch.
 *   * a timestamp bucket — the same collapse, with an arbitrary window, and
 *     unsigned so it protects nothing.
 *   * a value in the payload — `StellaGroundedQueryRequest` is `{ query }`
 *     and must stay `{ query }`; a client-chosen key is a client-chosen
 *     discount.
 *   * a bound server-action argument — the one mechanism here that IS
 *     unforgeable (Next.js seals it server-side and it travels encrypted).
 *     But it is bound at RENDER, and one render serves many questions, so a
 *     bound token is constant exactly where it needs to vary. Re-binding per
 *     question would require a server round trip whose response the client
 *     then chooses to use or ignore — which returns the choice to the client.
 *
 * Searched for and NOT FOUND in this application: any canonical `requestId`,
 * `correlationId` or `invocationId` (no middleware, no request-scoped id —
 * `headers()` is used only for a rate-limit IP); any general-purpose signing
 * secret (only `STRIPE_*`, another domain's credential); any table of issued
 * operation tickets. `lib/capabilities/contracts.ts` CAP-05 defines the
 * `replayed` vocabulary but is `enabled: false` and mints no keys.
 *
 * ---------------------------------------------------------------------------
 * WHY NOTHING IS CHARGED RATHER THAN SOMETHING BEING CHARGED
 * ---------------------------------------------------------------------------
 * Calling the function with a per-invocation uuid would look like the gap was
 * closed, pass a naive reading of the ledger, and double-charge every retry —
 * a worse state than the honest one, because the failure would be invisible
 * and would land on the customer's bill. So the call is NOT made, the quota is
 * still ENFORCED (the read below refuses an exhausted organization), and the
 * shortfall is recorded as contract request INT-INT-001.
 *
 * This is what blocks `local-runtime-ready`. The feature flag must not be
 * turned on while an enforced quota cannot be charged.
 */
const QUOTA_LEDGER_NOT_CHARGED =
  'consume_stella_quota requires an idempotency key with no canonical server-side source (INT-INT-001); quota is enforced but not consumed'

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

  // 3. ORGANIZATION SCOPE — DERIVED, never received. It is the id the session
  //    object already carries; there is no parameter for it anywhere in this
  //    module and no read happens to obtain it.
  const organizationId = ctx.organization.id

  // 4. PROJECT SCOPE — DERIVED from the SERVER-BOUND argument, never from the
  //    payload.
  //
  //    `GroundingScope.projectId` is `string | null` ("the whole organization"
  //    is a representable scope), and this path REFUSES that width: a grounded
  //    answer is always asked inside one project, and an organization-wide
  //    scope here would let a question reach evidence from a project the
  //    reviewer is looking at nothing of. `projectId` is narrowed to a
  //    non-empty string before the scope is built, and stays the value every
  //    query below uses.
  //
  //    Still no row has been read: this is a trim and a shape check.
  const projectId = typeof options.boundProjectId === 'string' ? options.boundProjectId.trim() : ''
  if (projectId === '') {
    return failure('UNAUTHORIZED', 'El proyecto solicitado no es válido para esta sesión.')
  }

  const scope: GroundingScope = { organizationId, projectId }
  try {
    assertValidScope(scope)
  } catch {
    return failure('UNAUTHORIZED', 'El proyecto solicitado no es válido para esta sesión.')
  }

  // 5. PERMISSION — set inclusion, same gate as every other Stella action.
  //    Last of the checks that cost no I/O, and deliberately the last one
  //    before any statement runs: a caller without the capability never
  //    reaches the database at all.
  if (!canUseStella(ctx.membership.role)) {
    return failure('UNAUTHORIZED', 'Tu rol no tiene permiso para usar Stella.')
  }

  // 6. PROJECT MEMBERSHIP — the FIRST read. The bound project must belong to
  //    the authenticated session's organization; `bind` makes the argument
  //    unforgeable, this makes it irrelevant whether it was.
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

  // 7. QUOTA, then the per-hour rate limit. Both before any chunk is read.
  //    ENFORCED here; NOT charged — see QUOTA_LEDGER_NOT_CHARGED (INT-INT-001).
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

  // 8. AUTHORIZED EVIDENCE SET — named explicitly, because the governed SQL
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

  // 8/9. REPOSITORY + QUERY JOURNEY. Everything below runs inside the identity
  //       context so `chunks_in_scope_attested` sees the session's claims.
  //
  //       `runGroundedQuery` is the whole journey as one call — scope ->
  //       repository -> retrieval -> extractive generation -> citation
  //       validation -> canonical classification -> provenance. It adds NO
  //       vocabulary: it returns `GroundingOrchestrationResult` verbatim plus
  //       one provenance field, so the six-member
  //       `GroundingOrchestrationClassification` remains the only status
  //       vocabulary at this boundary (R8).
  let run: GroundedQueryRun
  try {
    run = await withOrganizationDatabaseContext(() =>
      runGroundedQuery({
        repository: createPersistedGroundingChunkRepository(scope),
        scope,
        text: queryText,
        // The strategy is CHOSEN here, in the composition root, and named in
        // the request rather than left to the default. Relying on the default
        // would make "which generator answered?" a question about another
        // module's constant.
        generator: createExtractiveAnswerProvider(),
        retrieval: {
          evidenceIds: evidenceIds.map((row) => row.id),
          // INT-GR-004. The persisted adapter reads
          // `chunks_in_scope_attested`, so every chunk arrives with the scope
          // its ROW carries and `enforceRepositoryScope`'s comparison is real.
          // Demanding attestation here is what makes a repository that CANNOT
          // attest fail loudly instead of passing a vacuous check — including,
          // specifically, a database where grounding_0004 is not applied.
          requireScopeAttestation: true,
        },
      }),
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

  // 10. ADAPT — exactly once, through the ONE authorized producer of the
  //     presentation model. Citation validation already happened inside the
  //     journey, against the chunks retrieval actually returned.
  const result = toProductResult(run)

  // 11. AUDIT (sanitized observability). Metadata only — ids, codes and counts, never the query text,
  //     never a claim, never a passage. Fire-and-forget: an audit_logs failure
  //     must not change what the reviewer sees, which is the same rule
  //     app/actions/stella/advisor.ts states for its own trail.
  //
  //     This is the half of the compliance record that IS writable today. The
  //     other half — the `stella_interactions` row that would CONSUME quota —
  //     is blocked on INT-INT-001; see QUOTA_LEDGER_NOT_CHARGED.
  void auditGroundedQuery(ctx, projectId, {
    outcome: result.status === 'ok' ? run.classification : result.code,
    generator: run.provenance.generatorId,
    quotaLedger: QUOTA_LEDGER_NOT_CHARGED,
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
function toProductResult(run: GroundedQueryRun): StellaGroundedQueryResult {
  const { classification, outcome } = run

  if (!CLASSIFICATION_IS_ANSWERABLE[classification]) {
    // No provider detail crosses the boundary. `outcome.answer.abstention`
    // names the failing component internally; the client gets a fixed string.
    //
    // `UNKNOWN_ERROR`, NOT `GEMINI_ERROR` — adversarial review B, train 4.
    //
    // The only unanswerable classification is `provider_unavailable`, and in
    // THIS flow there is no provider. The generator is local and offline, so
    // the condition can only originate in the repository: a grounding package
    // not applied, a missing attestation column, a connection refused.
    //
    // `GEMINI_ERROR` renders as "Error del servicio de IA … Podés intentar de
    // nuevo en unos minutos" with `retryable: true`. Both halves are wrong
    // here: it names a service this path never calls, and it invites a retry
    // for a condition that is typically PERMANENT until an operator applies a
    // package. In a tool whose output is meant to be auditable, telling a
    // reviewer the AI service failed when the evidence index is missing is a
    // misattribution they cannot see through.
    //
    // `UNKNOWN_ERROR` renders as "Stella no está disponible temporalmente"
    // with `retryable: false`. It claims nothing about a component, and its
    // non-retryable stance matches a fault a retry does not clear. The 12-code
    // taxonomy is reused rather than widened — a thirteenth code would be a
    // second error vocabulary for the five sibling actions to learn.
    return failure('UNKNOWN_ERROR', 'Stella no pudo generar una respuesta fundamentada en este momento.')
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
    // R9 — the disclosure input, DERIVED from what actually ran.
    //
    // `kind` is computed from `run.provenance.generatorId`, which
    // `runGroundedQuery` read off the generator object it invoked. It is not a
    // constant this file chose and not a value the panel could have guessed:
    // the comparison lives here because this is the layer that imports
    // `lib/grounding`, and shipping the CLASSIFICATION instead of the id keeps
    // the generator's name out of `components/stella/**` entirely.
    //
    // Prefix match on the NAME, not equality with the full id: the id embeds a
    // contract version (`grounding-local-extractive/extractive-1`) that is
    // expected to move. An equality check would silently stop matching at
    // `extractive-2` and silently drop the disclosure — the one failure mode a
    // disclosure must not have.
    answerStrategy: {
      generatorId: run.provenance.generatorId,
      kind: run.provenance.generatorId.startsWith(`${EXTRACTIVE_GENERATOR_NAME}/`)
        ? 'extractive'
        : 'generative',
    },
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
