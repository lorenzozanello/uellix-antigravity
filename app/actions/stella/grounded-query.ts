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
// R2-INT (TRAIN 4.2) — ONE PROJECT, FIVE CONSUMERS
// ---------------------------------------------------------------------------
// The project the work executes against is derived exactly once, at step 4, and
// every later use of a project is that same value:
//
//     ticket.project_id = derivedProjectId = Grounding scope.projectId
//                                          = charge.project_id
//
// Three substitutions are specifically NOT made, and each was a real way to get
// this wrong:
//
//   * the project is never read off the TICKET. `ticket.project_id` is what the
//     comparison is against; using it as the expected value makes every
//     comparison trivially true, which is the defect R2-INT reports.
//   * the project never comes from the PAYLOAD. `StellaGroundedQueryRequest`
//     still has exactly one field.
//   * `complete` does not inherit `bind`'s verdict. They run in different
//     transactions and only `complete` charges.
//
// `ExecutionProject` (below) is how this is held by the compiler rather than by
// review: the four ticket verbs and the retrieval scope are reached only through
// an object that already carries the derived project, and none of them takes a
// project argument at all.
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
import { nextQuotaResetIso, formatQuotaResetDate } from '@/lib/stella/quota'
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
  StellaOperationTicketIssueResult,
} from '@/components/stella/grounded-query'
import type { StellaPanelErrorCode } from '@/components/stella/error-messages'
import { canonicalQueryHash } from '@/lib/stella/operation-ticket/canonical-query-hash'
import {
  emitTicketEvent,
  type TicketEventScope,
} from '@/lib/stella/operation-ticket/ticket-observability'
import {
  GROUNDED_QUERY_TICKET_CATEGORY,
  abortOperationTicket,
  bindOperationTicket,
  completeOperationTicket,
  inspectOperationTicket,
  issueOperationTicket,
  type AbortTicketResult,
  type BindTicketResult,
  type CompleteTicketResult,
  type OperationTicketAbortReason,
  type OperationTicketInspection,
  type OperationTicketRejection,
} from '@/db/stella/operation-tickets'

/* -------------------------------------------------------------------------- */
/* R2-INT — THE EXECUTION PROJECT, AS A TYPE                                  */
/* -------------------------------------------------------------------------- */

/**
 * A project id that this module DERIVED on the server and is executing against.
 *
 * Branded, and the brand is the whole mechanism: `string` is assignable to
 * `string`, so a plain type alias would let a project read off the ticket, off
 * the payload, or off a component prop reach `bindTicket` unnoticed. Nothing
 * outside this module can produce an `ExecutionProjectId` — `deriveExecutionProject`
 * is the only cast, it is not exported, and it takes the SERVER-BOUND argument.
 *
 * R2-INT is the defect this closes, and it is an ATTRIBUTION defect rather than
 * a quota escape: before Train 4.2 the ticket's project and the project the work
 * actually read evidence under could differ, and the charge landed under the
 * ticket's. The invariant now is one value with five consumers:
 *
 *     ticket.project_id  =  derivedProjectId  =  Grounding scope.projectId
 *                        =  charge.project_id
 */
declare const EXECUTION_PROJECT_BRAND: unique symbol
type ExecutionProjectId = string & { readonly [EXECUTION_PROJECT_BRAND]: 'server-derived' }

/**
 * The ONE place a string becomes an execution project.
 *
 * Takes the SERVER-BOUND argument — a route param already resolved under an
 * authenticated session and sealed into the action reference by
 * `Function.prototype.bind` — never a field of `request`. It trims and
 * shape-checks; it does not authorize. Authorization is a database read and
 * happens later, against the session's organization (step 6).
 */
function deriveExecutionProject(boundProjectId: string): ExecutionProjectId | null {
  const trimmed = typeof boundProjectId === 'string' ? boundProjectId.trim() : ''
  return trimmed === '' ? null : (trimmed as ExecutionProjectId)
}

/**
 * THE ASSERTION FASE 5 ASKS FOR, WRITTEN AS A TYPE RATHER THAN A COMMENT.
 *
 * Every governed use of the execution project goes through one of these five
 * members, and NONE of them takes a project: the value is captured once, from
 * `deriveExecutionProject`, and applied by the factory. A call site cannot pass
 * a different project to `complete` than it passed to `bind` because a call site
 * cannot pass a project at all.
 *
 * That is strictly stronger than threading a `projectId` argument through five
 * call sites and trusting review to notice when the sixth passes
 * `ticket.project_id` instead. `tests/cross-workstream/runtime-grounded-query.test.ts`
 * pins it structurally: this module must contain exactly ONE call to each of the
 * four adapter verbs, and all four inside this factory.
 */
interface ExecutionProject {
  /** The derived id itself, for the audit trail and the event scope. */
  readonly projectId: ExecutionProjectId
  /** The retrieval scope. Same value the ticket verbs below re-impose in SQL. */
  scope(organizationId: string): GroundingScope
  bindTicket(ticketId: string, queryHash: string): Promise<BindTicketResult>
  completeTicket(ticketId: string, queryHash: string): Promise<CompleteTicketResult>
  abortTicket(ticketId: string, reason: OperationTicketAbortReason): Promise<AbortTicketResult>
  inspectTicket(ticketId: string): Promise<OperationTicketInspection | null>
}

function executionProject(projectId: ExecutionProjectId): ExecutionProject {
  return {
    projectId,
    scope: (organizationId) => ({ organizationId, projectId }),
    bindTicket: (ticketId, queryHash) => bindOperationTicket(ticketId, projectId, queryHash),
    completeTicket: (ticketId, queryHash) => completeOperationTicket(ticketId, projectId, queryHash),
    abortTicket: (ticketId, reason) => abortOperationTicket(ticketId, projectId, reason),
    inspectTicket: (ticketId) => inspectOperationTicket(ticketId, projectId),
  }
}

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
 * QUOTA IS NOW CHARGED — TRAIN 4.1 CLOSED INT-INT-001. READ THIS BEFORE
 * CHANGING THE ORDER OF ANYTHING BELOW.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS THE PROBLEM, AND WHAT ANSWERED IT
 * ---------------------------------------------------------------------------
 * `consume_stella_quota` requires an `idempotency_key`, and until Train 4.1
 * nothing this action could reach drew the right distinction:
 *
 *     a RETRY of one question  ->  same key   (charge once)
 *     a NEW question           ->  new key    (charge again)
 *
 * A `randomUUID()` per invocation re-charges every retry. A digest of
 * (user, project, query) makes a reviewer's second, legitimate question free.
 * A timestamp bucket is the same collapse with an arbitrary window. A value in
 * the payload is a client-chosen discount. So nothing was charged, and the
 * shortfall was recorded as INT-INT-001.
 *
 * `db/prepared/stella_0014_operation_tickets.sql` answers it by making the
 * identity SOMETHING THE SERVER ISSUES BEFORE THE OPERATION RUNS — which is
 * exactly what a digest of the request can never be. The key charged is
 *
 *     sha256('stella/ticket/charge/v1' || LF || ticket_id || LF || charge_nonce)
 *
 * derived INSIDE `complete_operation_ticket`, from a nonce generated at issue
 * that no function returns and no runtime principal can read. The caller
 * cannot compute it, cannot pre-charge under it, and cannot choose it.
 *
 * The remaining half — knowing whether THIS call is a retry or a new
 * question — is not something the server can recover from the request, so it
 * is carried explicitly: the client presents the SAME ticket to retry and asks
 * for a NEW one to ask again. See `StellaOperationTicket`.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ALREADY NOT THE PROBLEM
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
 * WHY THERE IS NO LONGER A SEPARATE `checkStellaQuota` READ BEFORE THE WORK
 * ---------------------------------------------------------------------------
 * There used to be one, and it was the right thing while nothing could charge:
 * an unlocked count is better than no enforcement at all. It is now strictly
 * worse than what replaced it. `bind_operation_ticket` performs the SAME count
 * plus the live reservations, under the SAME per-organization advisory lock
 * that `consume_stella_quota` takes — so its answer cannot be overtaken
 * between the check and the charge, which an unlocked pre-read's answer always
 * could. Keeping both would mean two different numbers could disagree, and the
 * losing one would be the one the reviewer was shown.
 *
 * The rate limit stays ahead of `bind`: it is cheap, it is per-hour rather
 * than per-month, and it protects the database from a caller who would
 * otherwise mint tickets in a loop.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE TRANSACTION BOUNDARIES ARE, AND WHY
 * ---------------------------------------------------------------------------
 * `bind` and `complete` each run in their OWN short transaction. Generation
 * happens BETWEEN them, in neither. That is required, not stylistic: `bind`
 * takes the ticket row's `FOR UPDATE` lock and the organization's advisory
 * lock, and both are released only at COMMIT. Wrapping the journey in one
 * transaction would hold an organization-wide mutex across retrieval,
 * generation and citation validation — serialising every other reviewer in the
 * organization behind one question.
 *
 * With the transaction closed, the reservation survives as a ROW STATE
 * (`status='bound'` with a live `expires_at`), which is what INT-INT-001 §4
 * means by "la reserva es un ESTADO DE FILA". Retrieval does open a
 * transaction of its own — `chunks_in_scope_attested` is SECURITY DEFINER and
 * needs the session claims — but it holds no ticket row and no advisory lock.
 */
// Square brackets, not parentheses, and that is not a style choice.
// `tests/cross-workstream/train4-attested-runtime.test.ts` asserts this module
// never INVOKES `uellix_stella.consume_stella_quota` directly — it matches the
// schema-qualified name followed by an open paren, precisely so that prose
// naming the function is not mistaken for a call to it. An audit label written
// with parentheses would trip that check while invoking nothing.
const QUOTA_LEDGER_CHARGED_BY_TICKET =
  'charged via uellix_stella_ops.complete_operation_ticket -> uellix_stella.consume_stella_quota [INT-INT-001 closed, prepared stella_0014; project-bound and attributed to the execution project, prepared stella_0015 / R2-INT]'

export interface StellaGroundedQueryOptions {
  /**
   * The project the question is asked within. Supplied by the SERVER at the
   * mount site (a route param already resolved under an authenticated
   * session), never carried in the client payload — and re-verified against
   * the session's organization below regardless.
   */
  boundProjectId: string
  /**
   * The operation ticket, minted by `issueStellaGroundedQueryTicketForProject`.
   *
   * Carried by the client and NEVER trusted on that account: every use of it
   * below goes through `bind`/`complete`/`abort`, each of which re-derives the
   * actor from `auth.uid()` and re-checks organization and project in SQL. A
   * forged or borrowed value finds nothing.
   */
  ticket: string
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
  //
  //    R2-INT (Train 4.2). This is the ONE derivation, and everything downstream
  //    that names a project names THIS value: the retrieval scope, the four
  //    ticket verbs, the event scope and the audit row. `executionProject` is
  //    what makes that structural rather than a convention — see its doc.
  const execution = deriveExecutionProject(options.boundProjectId)
  if (execution === null) {
    return failure('UNAUTHORIZED', 'El proyecto solicitado no es válido para esta sesión.')
  }
  const project = executionProject(execution)
  const projectId = project.projectId

  const scope: GroundingScope = project.scope(organizationId)
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

  // 7. NO RATE LIMIT HERE — IT MOVED TO ISSUANCE, AND THAT IS THE POINT.
  //
  //    The per-hour limit now runs in `issueStellaGroundedQueryTicket`, one
  //    step earlier in the operation's life. Two things follow, and both are
  //    improvements rather than side effects:
  //
  //      * MINTING IS BOUNDED. Issuance reserves nothing, so it was not
  //        self-limiting: an authenticated member could previously mint
  //        unbounded rows into `operation_tickets`, which nothing reclaims
  //        (there is no pg_cron and `expire_operation_tickets` is called by no
  //        runtime path). Raised as MAJOR by adversarial review A.
  //      * A RETRY NO LONGER SPENDS THE LIMIT. It is the same operation,
  //        already counted when its ticket was minted. Charging the hourly
  //        budget again for re-delivering one answer would penalise exactly
  //        the callers the protocol exists to protect.
  //
  //    Every path into this function requires a ticket, and every ticket was
  //    rate-limited when it was issued — so this is a narrowing of what the
  //    limit is spent on, never a removal of it.
  //
  //    The MONTHLY quota is likewise not read here: `bind` counts it under the
  //    same advisory lock the charge takes, and an unlocked pre-read could
  //    only ever disagree with it.

  // ---------------------------------------------------------------------
  // 8. CANONICAL QUERY DIGEST — computed in Node, per INT-INT-001 §5. The
  //    TEXT never crosses the database boundary; only these 64 hex chars do.
  // ---------------------------------------------------------------------
  const queryHash = canonicalQueryHash(queryText)

  // Telemetry correlation only. Minted per INVOCATION, so a retry carries a
  // NEW one while reusing the SAME ticket — the opposite of an identity. It
  // never reaches the database and never reaches `consume_stella_quota`.
  const events: TicketEventScope = {
    organizationId: scope.organizationId,
    projectId,
    requestId: randomUUID(),
  }

  // ---------------------------------------------------------------------
  // 9. BIND — fix the digest write-once and RESERVE one unit, under the
  //    per-organization advisory lock. The transaction closes here; from this
  //    point the reservation is a row state, not a held lock.
  // ---------------------------------------------------------------------
  //
  //    R2-INT: `bindTicket` applies the derived execution project, and SQL
  //    compares it against the one welded onto the ticket at issue. A ticket of
  //    another project raises U0110 and never reserves — so a cross-project
  //    presentation stops HERE, before a single chunk of the wrong project's
  //    evidence is read, and therefore before there is anything to charge for.
  const bound = await project.bindTicket(options.ticket, queryHash)

  if (bound.kind === 'already_completed') {
    // ---------------------------------------------------------------
    // THE POST-COMPLETE RETRY (FASE 11). This ticket already ran and was
    // already charged; the reviewer never saw the answer because the
    // response was lost in transit.
    //
    // The three things NOT done here are the point:
    //   * the work is NOT re-run. Re-running would be free of charge (the
    //     ledger would answer `replayed`), but it could produce DIFFERENT
    //     text than the unit already paid for, and nothing would record
    //     that the reviewer was shown a second answer for one charge.
    //   * no answer is INVENTED, reconstructed or approximated.
    //   * nothing is charged again.
    //
    // Option C of the dispatch: a specific operational state that neither
    // charges nor pretends to have succeeded. Options A (persist a minimal
    // result) and B (deterministic reconstruction from stable provenance)
    // are both defensible, and neither exists canonically in this
    // application today — there is no answer store, and `answerId` is
    // minted per run rather than derived — so claiming either would be
    // claiming a capability that is not there.
    // ---------------------------------------------------------------
    //
    // THE POST-COMPLETE RETRY IS WHERE `inspect` BELONGS, and it is the only
    // path that calls it. R2-INT gave the verb a reason to exist here: the
    // audit row for a retry used to record a state INFERRED from what `bind`
    // returned, and it now records the state READ from the ticket under the
    // execution project. A ticket of another project cannot be read at all
    // (U0110 -> `null`), so this call cannot become a lifecycle oracle for a
    // ticket the caller is not entitled to see.
    //
    // Its failure changes nothing — the disposition below is already decided by
    // `bind`. It is a read FOR THE RECORD, not a second gate, and writing it as
    // a gate would make a settled operation's reporting depend on a round trip
    // that has nothing left to decide.
    const settledState = await project.inspectTicket(options.ticket)
    emitTicketEvent('grounded_query_retried', events, { ticketId: options.ticket, attempt: 2 })
    emitTicketEvent('quota_reuse_detected', events, { ticketId: options.ticket })
    void auditGroundedQuery(ctx, projectId, {
      outcome: 'already_completed_result_unavailable',
      quotaLedger: QUOTA_LEDGER_CHARGED_BY_TICKET,
      // The ticket's own status, under THIS project. `unreadable` is not an
      // error state — it is what a ticket of another project looks like from
      // here, and recording it by that name keeps the two apart in the trail.
      ticketState: settledState === null ? 'unreadable' : settledState.status,
    })
    return failure(
      'ALREADY_COMPLETED_RESULT_UNAVAILABLE',
      'Esta consulta ya se ejecutó y se contabilizó en tu cuota, pero la respuesta no pudo entregarse y no se conserva.',
    )
  }

  if (bound.kind === 'quota_exceeded' || bound.kind === 'no_quota') {
    // REFUSED BEFORE THE WORK RAN — the only point at which refusing is free.
    // The ticket stays `issued`; nothing was reserved and nothing charged.
    emitTicketEvent('replay_rejected', events, { ticketId: options.ticket, reasonCode: bound.kind })
    const message =
      bound.kind === 'no_quota'
        ? 'Tu organización no tiene un plan de Stella asignado. Contactá a Uellix para habilitarlo.'
        : `Alcanzaste el límite mensual de ${bound.quota ?? 0} consultas a Stella (usadas: ${bound.used ?? 0}). Se renueva el ${formatQuotaResetDate(nextQuotaResetIso())}.`
    return failure('QUOTA_EXCEEDED', message)
  }

  if (bound.kind === 'rejected') {
    // A forged, borrowed, expired, cross-scope or already-settled ticket, or a
    // digest that does not match the one this ticket was bound to. All of them
    // are reported to the reviewer identically — telling them apart on screen
    // would be an oracle — but they are told apart in the event, by a stable
    // code and never by a sentence.
    emitTicketEvent('replay_rejected', events, { ticketId: options.ticket, reasonCode: bound.reason })
    return failure(...groundedTicketRejection(bound.reason))
  }

  emitTicketEvent('operation_ticket_bound', events, { ticketId: options.ticket })
  emitTicketEvent('grounded_query_reserved', events, { ticketId: options.ticket })

  // From here on the ticket HOLDS A RESERVATION. Every exit path below either
  // completes it (charging exactly one unit) or aborts it (charging nothing).
  // There is no path that returns while leaving it silently bound.

  // 10. AUTHORIZED EVIDENCE SET — named explicitly, because the governed SQL
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
    await releaseTicket(project, options.ticket, 'execution_failed', events)
    return failure('UNKNOWN_ERROR', 'No se pudo leer la evidencia del proyecto.')
  }
  if (evidenceIds.length === 0) {
    // A real, reportable state — not an error. There is nothing to ground an
    // answer in, and saying so is more useful than a generic failure. The
    // reservation is released: an unanswerable question must not hold a unit.
    await releaseTicket(project, options.ticket, 'no_result', events)
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
    // THE WORK FAILED AFTER THE RESERVATION. Release it: a failed operation
    // must not hold a unit, and must not be charged for one.
    await releaseTicket(project, options.ticket, 'execution_failed', events)
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

  // 12. ADAPT — exactly once, through the ONE authorized producer of the
  //     presentation model. Citation validation already happened inside the
  //     journey, against the chunks retrieval actually returned.
  // GUARDED, because the ticket is reserved and this code is between the
  // reservation and the settlement.
  //
  // `toProductResult` calls `adaptGroundedAnswer`, which walks retrieval
  // output. It is not expected to throw — but "not expected to throw" is not a
  // property this function can rely on, and an exception escaping here would
  // leave the ticket `bound`: neither completed nor aborted, holding a unit of
  // the organization's headroom until its 15-minute window lapses.
  //
  // The SQL-side liveness predicate makes that self-healing rather than
  // permanent, and a later retry with the same ticket still resolves
  // correctly, so this is a robustness gap and not a double-charge. It is
  // closed anyway: the comment above claims every exit either completes or
  // aborts, and a claim with one uncovered path is worse than no claim.
  //
  // Raised as MINOR by adversarial review B, Train 4.1.
  let result: StellaGroundedQueryResult
  try {
    result = toProductResult(run)
  } catch (error) {
    await releaseTicket(project, options.ticket, 'execution_failed', events)
    console.error('[stella-grounding] presentation mapping failed:', error instanceof Error ? error.name : 'unknown')
    return failure('UNKNOWN_ERROR', 'La consulta no pudo completarse.')
  }

  if (result.status === 'error') {
    // `provider_unavailable` — nothing was read, or generation could not run.
    // There is no answer, so there is nothing to charge for.
    await releaseTicket(project, options.ticket, 'no_result', events)
    void auditGroundedQuery(ctx, projectId, {
      outcome: result.code,
      generator: run.provenance.generatorId,
      quotaLedger: 'not charged — aborted before completion',
    })
    return result
  }

  // ---------------------------------------------------------------------
  // 13. COMPLETE AND CHARGE. The answer exists but is NOT yet returnable:
  //     nothing is handed back until the ledger says a unit was accounted
  //     for. This ordering is the reason a failed charge cannot leave a
  //     usable answer behind.
  // ---------------------------------------------------------------------
  //
  //     R2-INT: `complete` re-proves the project INDEPENDENTLY of `bind`. The
  //     two ran in different transactions, so "bind already checked it" is a
  //     claim about a request that has since ended — and `complete` is the call
  //     that charges, so it is the only one that can make the charge land under
  //     the right project. The ledger row is append-only; a `project_id` written
  //     wrong there can never be corrected.
  const settled = await project.completeTicket(options.ticket, queryHash)

  if (settled.kind === 'quota_refused') {
    // R1, DECLARED AND NOT PAPERED OVER. A sibling Stella action charged the
    // ledger between this operation's `bind` and its `complete`, so the unit
    // this ticket reserved was spent elsewhere and the charge is refused on
    // work that has already run.
    //
    // The conservative policy Train 4.1 keeps: NEVER exceed the quota, and
    // never show an uncharged answer as successful. The computed answer is
    // DISCARDED. Whether the work should instead be given away, or the cap
    // overrun by one, is a billing decision — recorded as R1 for Train 5,
    // and deliberately not taken here or in `consume_stella_quota`.
    await releaseTicket(project, options.ticket, 'quota_refused', events)
    void auditGroundedQuery(ctx, projectId, {
      outcome: 'quota_refused_after_execution',
      generator: run.provenance.generatorId,
      quotaLedger: 'not charged — ledger refused after execution (R1)',
    })
    return failure(
      'QUOTA_EXCEEDED',
      `Alcanzaste el límite mensual de ${settled.quota ?? 0} consultas a Stella (usadas: ${settled.used ?? 0}). Se renueva el ${formatQuotaResetDate(nextQuotaResetIso())}.`,
    )
  }

  if (settled.kind === 'rejected') {
    // The settlement itself failed — a dropped connection, a package that is
    // not applied, an expired reservation. We do NOT know whether the charge
    // landed, so the answer is withheld: presenting it would be presenting an
    // answer that may never have been accounted for.
    //
    // The abort attempt is safe in BOTH worlds. If the charge did land, the
    // ticket is `completed` and SQL refuses to abort it (`U0109`) — so a
    // successful charge can never be undone by this line. If it did not, the
    // reservation is released. Its result is ignored for exactly that reason.
    await releaseTicket(project, options.ticket, 'execution_failed', events)
    void auditGroundedQuery(ctx, projectId, {
      outcome: 'settlement_failed',
      generator: run.provenance.generatorId,
      quotaLedger: 'unknown — settlement rejected, answer withheld',
    })
    return failure('UNKNOWN_ERROR', 'La consulta no pudo completarse.')
  }

  if (settled.kind === 'replayed') {
    // ---------------------------------------------------------------
    // THE CONCURRENT FORM OF THE POST-COMPLETE RETRY. Raised as MAJOR by
    // adversarial review A, Train 4.1.
    //
    // `bind` catches the SEQUENTIAL retry: it sees `completed` and this
    // function returns the explicit state without re-running anything. It
    // cannot catch the CONCURRENT one. Two deliveries of the same ticket that
    // overlap both bind while the ticket is still `bound`, both are told
    // "proceed", both run the whole journey, and only at `complete` does the
    // loser learn that someone else already settled it.
    //
    // Returning `result` here would hand back a SECOND answer — independently
    // retrieved, independently generated, with its own `answerId` — for ONE
    // charged unit. The ledger would be right and the metering would be a
    // fiction: the quota measures answers delivered, and two would have been.
    //
    // So the loser gets the same disposition as the sequential retry. Its
    // computed answer is discarded rather than delivered, and the caller is
    // told, truthfully, that the operation was already accounted for. The
    // charge is untouched — `replayed` means the ledger already holds exactly
    // one row for this ticket.
    // ---------------------------------------------------------------
    emitTicketEvent('grounded_query_retried', events, { ticketId: options.ticket, attempt: 2 })
    emitTicketEvent('quota_reuse_detected', events, { ticketId: options.ticket })
    void auditGroundedQuery(ctx, projectId, {
      outcome: 'already_completed_result_unavailable',
      generator: run.provenance.generatorId,
      quotaLedger: QUOTA_LEDGER_CHARGED_BY_TICKET,
      settlement: 'replayed_concurrent',
    })
    return failure(
      'ALREADY_COMPLETED_RESULT_UNAVAILABLE',
      'Esta consulta ya se ejecutó y se contabilizó en tu cuota, pero la respuesta no pudo entregarse y no se conserva.',
    )
  }

  // 14. OBSERVABILITY — from the REAL runtime, after the real charge. Only
  //     `completed` reaches here now: this delivery is the one that charged,
  //     so it is the one entitled to hand back an answer.
  emitTicketEvent('grounded_query_completed', events, { ticketId: options.ticket })
  emitTicketEvent('quota_consumed', events, { ticketId: options.ticket })

  // 15. AUDIT (sanitized). Metadata only — ids, codes and counts, never the
  //     query text, never a claim, never a passage. Fire-and-forget: an
  //     audit_logs failure must not change what the reviewer sees, the same
  //     rule app/actions/stella/advisor.ts states for its own trail.
  void auditGroundedQuery(ctx, projectId, {
    outcome: run.classification,
    generator: run.provenance.generatorId,
    quotaLedger: QUOTA_LEDGER_CHARGED_BY_TICKET,
    settlement: settled.kind,
  })

  return result
}

/**
 * Release a reservation and say so.
 *
 * AWAITED, not fire-and-forget. Everything else in this module that writes for
 * the record (the audit trail) is deliberately not awaited, because the
 * reviewer's answer must not depend on it. This one is different: until the
 * abort lands, the ticket still counts against the organization's headroom in
 * every concurrent `bind`. Returning first and releasing later would let a
 * failed question keep blocking a successful one.
 *
 * Never throws, and its result is not inspected. An abort that fails because
 * the ticket is already `completed` (`U0109`) is not an error to handle — it
 * is the protocol refusing to un-charge a settled operation, which is exactly
 * what it should do.
 */
async function releaseTicket(
  // R2-INT: the execution project is a PARAMETER rather than something this
  // helper recovers, and specifically it is never read off the ticket. An abort
  // that took the ticket's own project would release any project's reservation,
  // which is the denial of service `abort_operation_ticket`'s own U0110 exists
  // to refuse. Taking the whole `ExecutionProject` — not a bare string — means
  // the value cannot be reconstructed here from anything else.
  project: ExecutionProject,
  ticketId: string,
  reason: OperationTicketAbortReason,
  events: TicketEventScope,
): Promise<void> {
  // Named `released`, not `outcome`: `outcome.kind` is GROUNDING's own
  // `GroundedOutcomeKind` vocabulary, which R8 forbids this boundary from
  // reading, and a cross-workstream test pins that by name. Two unrelated
  // things called `outcome` in one module is how a vocabulary leak starts
  // looking like a variable name.
  const released = await project.abortTicket(ticketId, reason)
  if (released.kind === 'aborted') {
    emitTicketEvent('grounded_query_aborted', events, { ticketId })
  } else if (released.kind === 'expired') {
    emitTicketEvent('operation_ticket_expired', events, { ticketId })
  } else {
    emitTicketEvent('replay_rejected', events, { ticketId, reasonCode: released.reason })
  }
}

/**
 * One rejection reason -> one product presentation.
 *
 * Every scope failure collapses to the SAME `UNAUTHORIZED` sentence the
 * project check already uses. Telling a caller that its ticket belongs to
 * another organization, or that it merely expired, would let it probe the
 * difference — the same tenancy-oracle reasoning `U0102` states in SQL, where
 * "not yours" and "never existed" are deliberately indistinguishable.
 */
function groundedTicketRejection(
  // TRAIN 4.3 added `category_mismatch` to the union. It is UNREACHABLE from
  // this path — the grounded action does not run the driver's category check,
  // because `bind`/`complete` here settle a `grounded_query` ticket through the
  // three-argument verb and a ticket of any other category would already have
  // failed the digest or the project comparison. Spelled out rather than
  // narrowed away with a cast: the exhaustive union is what makes a NEW
  // rejection reason a compile error here instead of a silent `default`.
  reason: OperationTicketRejection,
): [StellaPanelErrorCode, string] {
  switch (reason) {
    case 'unavailable':
      // The database, not the caller. A retry may well clear it, but the code
      // is non-retryable because a missing prepared package is not transient.
      return ['UNKNOWN_ERROR', 'La consulta no pudo completarse.']
    default:
      return ['UNAUTHORIZED', 'Esta operación ya no es válida. Volvé a hacer la consulta.']
  }
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
  ticket: string,
): Promise<StellaGroundedQueryResult> {
  return runStellaGroundedQuery(request, { boundProjectId: projectId, ticket })
}

/* -------------------------------------------------------------------------- */
/* Ticket issuance — the governed server surface (FASE 5)                     */
/* -------------------------------------------------------------------------- */

/**
 * Mint one operation ticket for one grounded-query operation.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CLIENT CANNOT SEND
 * ---------------------------------------------------------------------------
 * `organizationId`, `projectId`, `actorId`, `category`, TTL, nonce,
 * idempotency key. The signature has ONE parameter and Next.js binds it
 * server-side, so none of those has anywhere to arrive from:
 *
 *   organization  <- `requireOrganizationAccess()`, the session
 *   project       <- the BOUND argument, re-verified against the session's org
 *   actor         <- `auth.uid()`, inside the SQL function — no parameter
 *   category      <- a module constant (`grounded_query`)
 *   TTL           <- `stella_0014`, bounded to 15 minutes by a CHECK
 *   nonce         <- `stella_0014`, and never returned by any function
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CLIENT RECEIVES
 * ---------------------------------------------------------------------------
 * 64 hex characters, and nothing else. Not the nonce, not the stored digest,
 * not an internal id, not a scope. The opaque identifier needed to continue,
 * and no more — FASE 5's requirement stated as the return type.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER, AND WHAT `disabled` COSTS
 * ---------------------------------------------------------------------------
 *   1 flag -> 2 auth -> 3 organization -> 4 project -> 5 permission ->
 *   6 rate limit -> 7 issue
 *
 * With the flag false this returns at step 1: zero authentication, zero
 * database work, zero ticket, zero observability. That is the same posture
 * `runStellaGroundedQuery` takes and the reason both are safe to ship dark.
 */
async function issueStellaGroundedQueryTicket(
  projectId: string,
): Promise<StellaOperationTicketIssueResult> {
  // 1. FLAG — before authentication, before any read, before any event.
  if (!stellaConfig.isEnabled || !stellaConfig.isGroundedQueryEnabled || !stellaState.canUseStella) {
    return { status: 'disabled' }
  }

  // 2. AUTHENTICATE.
  let ctx: Awaited<ReturnType<typeof requireOrganizationAccess>>
  try {
    ctx = await requireOrganizationAccess()
  } catch {
    return { status: 'error', code: 'UNAUTHORIZED', message: 'Se requiere autenticación.' }
  }

  // 3/4. SCOPE — derived, never received. The SAME derivation the execution
  //      path uses (`deriveExecutionProject`), so the project welded onto the
  //      ticket at issue and the project the execution asserts later are
  //      produced by one function rather than by two trims that could drift.
  const organizationId = ctx.organization.id
  const boundProjectId = deriveExecutionProject(projectId)
  if (boundProjectId === null) {
    return {
      status: 'error',
      code: 'UNAUTHORIZED',
      message: 'El proyecto solicitado no es válido para esta sesión.',
    }
  }

  // 5. PERMISSION — the same set-inclusion gate every Stella action uses, and
  //    the last check that costs no I/O.
  if (!canUseStella(ctx.membership.role)) {
    return { status: 'error', code: 'UNAUTHORIZED', message: 'Tu rol no tiene permiso para usar Stella.' }
  }

  // 6. RATE LIMIT — per hour, per organization, and HERE rather than at
  //    execution. One question mints one ticket, so this counts operations
  //    rather than deliveries; a retry of an operation already counted does
  //    not spend the budget a second time. It also bounds minting, which
  //    reserves nothing and is therefore not self-limiting.
  const rate = await consumeStellaRateLimit(organizationId).catch(() => null)
  if (rate === null) {
    return {
      status: 'error',
      code: 'RATE_LIMIT_UNAVAILABLE',
      message: 'No se pudo verificar el límite de uso de Stella.',
    }
  }
  if (!rate.allowed) {
    return {
      status: 'error',
      code: 'RATE_LIMITED',
      message: 'Alcanzaste el límite de consultas por hora. Intentá de nuevo más tarde.',
    }
  }

  // 7. ISSUE. The project is re-verified against the organization INSIDE the
  //    SQL function (a trigger, plus RLS), so no read is duplicated here to
  //    do it again in a weaker place.
  // TRAIN 4.3: the category is now a PARAMETER of the adapter, because six more
  // categories share it. It is still not something a caller can name — it is
  // this module's own constant, passed at the one call site that mints a
  // grounded ticket.
  const issued = await issueOperationTicket(
    organizationId,
    boundProjectId,
    GROUNDED_QUERY_TICKET_CATEGORY,
  )
  if (issued.kind === 'rejected') {
    if (issued.reason === 'out_of_scope') {
      return {
        status: 'error',
        code: 'UNAUTHORIZED',
        message: 'El proyecto solicitado no es válido para esta sesión.',
      }
    }
    return { status: 'error', code: 'UNKNOWN_ERROR', message: 'No se pudo iniciar la consulta.' }
  }

  emitTicketEvent(
    'operation_ticket_issued',
    { organizationId, projectId: boundProjectId, requestId: randomUUID() },
    { ticketId: issued.ticketId },
  )

  return { status: 'issued', ticket: issued.ticketId }
}

/**
 * The BINDABLE form of issuance, for the mount site:
 *
 *   const issueTicket = issueStellaGroundedQueryTicketForProject.bind(null, projectId)
 *
 * Same reasoning as `runStellaGroundedQueryForProject`: `bind` prepends, the
 * bound value is sealed server-side, and the action re-verifies it regardless
 * because every export of a `'use server'` module is an independently
 * invocable endpoint.
 */
export async function issueStellaGroundedQueryTicketForProject(
  projectId: string,
): Promise<StellaOperationTicketIssueResult> {
  return issueStellaGroundedQueryTicket(projectId)
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
