// tests/eval/stella-release/harness-report.ts
// RELEASE line — Train 4 (STELLA_RELEASE_LOCAL_END_TO_END_GATE_TRAIN_4).
//
// The typed claim scripts/stella-release-e2e-dry-run.sh's journey
// (tests/eval/stella-release/e2e/run-local-journey.ts) makes about what it
// actually did, and the FAIL-CLOSED reducer that turns that claim into
// `localRuntimeHarnessReady`.
//
// WHY THIS IS A SEPARATE MODULE FROM local-release-gate.ts
// local-release-gate.ts's own header is explicit: it "runs zero SQL, opens
// zero database connections, and calls zero providers" — that discipline is
// load-bearing (the 11 Fase-3 gates must stay computable from the offline
// fixture harness alone, cheaply, in every CI run). The disposable-database
// journey this train adds is the opposite of cheap and offline: it starts a
// container, applies real SQL, and tears it down. This module is the seam
// between the two — local-release-gate.ts accepts an OPTIONAL report shaped
// like this and reduces it into a twelfth readiness field
// (localRuntimeHarnessReady) without itself doing any of the I/O that
// produced it.
//
// FAIL CLOSED, BY FIELD. Every field below states a claim the journey script
// can lie about (accidentally or not) if it takes a shortcut — used a
// preconstructed fixture instead of the real pipeline, skipped the database,
// claimed a quota was consumed that the schema cannot record, left the
// container running. `evaluateLocalRuntimeHarnessReadiness` checks each claim
// independently and names EXACTLY which one is false, mirroring the
// discipline `computeLocalReleaseGateReport` already uses for
// `missingForLocalRuntime` — never a bare boolean.

export interface LocalRuntimeHarnessReport {
  /** Must be 'none' — the disposable container is started with --network none. */
  readonly containerNetworkMode: string
  /** The container was confirmed destroyed (docker rm) after the run, pass or fail. */
  readonly containerDestroyed: boolean
  /** No -v/--mount was used — nothing outlives the container. */
  readonly usedPersistentVolume: boolean
  /**
   * 'live-database-execution' iff SQL actually ran against a real Postgres
   * process this run. 'file-existence-only' names the shortcut this field
   * exists to catch: a "harness" that only checked db/prepared/*.sql exists
   * on disk, which is what local-release-gate.ts's OWN gates already do and
   * are honest about — that discipline is right for an offline gate and
   * wrong for a thing calling itself a runtime harness.
   */
  readonly verificationMethod: 'live-database-execution' | 'file-existence-only'
  /** Prepared-package basenames actually applied this run, e.g. 'grounding_0002'. */
  readonly packagesApplied: readonly string[]
  readonly train4PackageStatus: 'applied' | 'not-yet-available'
  /** True iff lib/grounding/ingest's real ingestDocument() produced the
   *  chunks that were inserted — never a hand-built chunk list. */
  readonly documentsIngestedViaRealPipeline: boolean
  /** SECURITY DEFINER function names actually CALLED (not merely present in
   *  the applied SQL) this run, e.g. 'register_document_version'. */
  readonly sqlFunctionsInvoked: readonly string[]
  readonly databaseApplied: boolean
  /** Retrieval against E2E_DECOY_PROJECT_ID (same org, wrong project)
   *  returned nothing, proving chunks_in_scope's project filter held. */
  readonly crossProjectRetrievalRejected: boolean
  /** Re-running the ingestion SQL a second time changed nothing (ON CONFLICT
   *  DO NOTHING on chunk_id, ON CONFLICT on register_document_version). */
  readonly idempotentReapplyVerified: boolean
  /** 'local-extractive-test-only' is the ONLY value this harness may ever
   *  legitimately report — see e2e/local-extractive-generator.ts's header. */
  readonly generatorKind: 'local-extractive-test-only' | 'provider' | 'hardcoded-mock'
  /** The generated answer's citations trace back to chunks a real retrieval
   *  call returned this run — never a canned GroundedAnswer object. */
  readonly answerDerivedFromRetrieval: boolean
  /** Ran the REAL validateAnswerCitations() from lib/grounding/contracts
   *  against the answer and the actually-retrieved chunk set. */
  readonly citationsValidatedAgainstRealChunks: boolean
  readonly citationValidationIssueCount: number
  /** The two-source contradiction fixture was resolved to a ContradictionMarker
   *  with both sideA and sideB independently citable. */
  readonly contradictionAttributed: boolean
  /** The no-match query produced status: 'abstained'. */
  readonly abstentionObserved: boolean
  /** Whether the report CLAIMS a grounded_query interaction was charged
   *  against the org's monthly quota. Cross-checked against quotaRoleExists
   *  below — see evaluateLocalRuntimeHarnessReadiness. */
  readonly quotaConsumptionClaimed: boolean
  /** Ground truth observed FROM THE DATABASE this run: does
   *  stella_interactions_stella_role_check admit 'grounded_query'? False on
   *  this branch — INT-CAP-001 is open and CAPABILITIES-owned, not fixable
   *  from RELEASE. */
  readonly quotaRoleExists: boolean
  /** The grounding functions were called under a real, non-anonymous
   *  request.jwt.claims GUC (a real organization member), not as an
   *  unauthenticated superuser session. */
  readonly scopeAttestedViaJwtClaims: boolean
  /** 'enabled-in-process-only' or 'disabled' are the only legitimate values.
   *  This harness must never observe the flag flipped on for anything beyond
   *  its own local, controlled process (and this train flips no flag at
   *  all — see the Train 4 prohibitions). */
  readonly groundedQueryFlagState: 'disabled' | 'enabled-globally' | 'enabled-in-process-only'
  readonly providerCallCount: number
  /** Every event this run emitted passed the REAL validateObservabilityEvent
   *  contract (tests/eval/stella-release/observability-contract.ts). */
  readonly observabilityEventsSanitized: boolean
  readonly observabilityEventViolationCount: number
  /** Rows found in stella_suggestion_decisions after simulating a local
   *  accept/reject decision. Must be 0 — STELLA_DECISIONS_PERSISTENCE_ENABLED
   *  is false, so a decision is held in the caller's process and nowhere else. */
  readonly localDecisionRowCount: number
  readonly decisionsPersistenceFlagState: 'disabled' | 'enabled'
}

export interface LocalRuntimeHarnessReadiness {
  readonly localRuntimeHarnessReady: boolean
  readonly missingForLocalRuntimeHarness: readonly string[]
}

const REQUIRED_PACKAGES = ['grounding_0002', 'grounding_0003'] as const

const REQUIRED_SQL_FUNCTIONS = [
  'register_document_version',
  'insert_evidence_chunks',
  'finalize_document_ingestion',
  'chunks_in_scope',
] as const

/**
 * Fail-closed reduction of one journey report to `localRuntimeHarnessReady`.
 * No field is trusted in isolation — several are cross-checked against each
 * other (quotaConsumptionClaimed vs quotaRoleExists) so a report cannot
 * claim a result the rest of its own data contradicts.
 */
export function evaluateLocalRuntimeHarnessReadiness(
  report: LocalRuntimeHarnessReport | null | undefined,
): LocalRuntimeHarnessReadiness {
  if (!report) {
    return {
      localRuntimeHarnessReady: false,
      missingForLocalRuntimeHarness: [
        'no harness report provided — run scripts/stella-release-e2e-dry-run.sh and pass its JSON report to this reducer',
      ],
    }
  }

  const missing: string[] = []

  if (report.verificationMethod !== 'live-database-execution') {
    missing.push(
      `verificationMethod is '${report.verificationMethod}', required 'live-database-execution' — a report that only inspected files on disk proves existence, not a real run`,
    )
  }
  if (report.containerNetworkMode !== 'none') {
    missing.push(`containerNetworkMode is '${report.containerNetworkMode}', required 'none' — the disposable container must run with --network none`)
  }
  if (!report.containerDestroyed) {
    missing.push('containerDestroyed is false — the disposable container was not confirmed torn down')
  }
  if (report.usedPersistentVolume) {
    missing.push('usedPersistentVolume is true — this harness must use no persistent volume')
  }
  if (!report.databaseApplied) {
    missing.push('databaseApplied is false — the disposable database stage was skipped')
  }
  for (const pkg of REQUIRED_PACKAGES) {
    if (!report.packagesApplied.includes(pkg)) {
      missing.push(`required package '${pkg}' is not in packagesApplied`)
    }
  }
  if (!report.documentsIngestedViaRealPipeline) {
    missing.push(
      'documentsIngestedViaRealPipeline is false — a preconstructed fixture was used in place of the real lib/grounding/ingest pipeline',
    )
  }
  for (const fn of REQUIRED_SQL_FUNCTIONS) {
    if (!report.sqlFunctionsInvoked.includes(fn)) {
      missing.push(`required SQL function '${fn}' was not invoked this run`)
    }
  }
  if (!report.crossProjectRetrievalRejected) {
    missing.push('crossProjectRetrievalRejected is false — retrieval from the decoy project was not proven rejected (scope not checked)')
  }
  if (!report.idempotentReapplyVerified) {
    missing.push('idempotentReapplyVerified is false — a second application of the ingestion SQL was not proven idempotent')
  }
  if (report.generatorKind !== 'local-extractive-test-only') {
    missing.push(`generatorKind is '${report.generatorKind}' — must be the local test-only extractive generator, never a provider or a hardcoded mock`)
  }
  if (report.providerCallCount !== 0) {
    missing.push(`providerCallCount is ${report.providerCallCount} — this harness must make zero calls to any provider`)
  }
  if (!report.answerDerivedFromRetrieval) {
    missing.push('answerDerivedFromRetrieval is false — the answer was not shown to emerge from a real retrieval call this run')
  }
  if (!report.citationsValidatedAgainstRealChunks || report.citationValidationIssueCount !== 0) {
    missing.push(
      `citations were not shown clean against the real retrieved chunk set (validated=${report.citationsValidatedAgainstRealChunks}, issues=${report.citationValidationIssueCount}) — a citation may be invented`,
    )
  }
  if (!report.contradictionAttributed) {
    missing.push('contradictionAttributed is false — the controlled two-source contradiction fixture was not shown attributed to both sides')
  }
  if (!report.abstentionObserved) {
    missing.push('abstentionObserved is false — the no-match query was not shown to abstain')
  }
  if (report.quotaConsumptionClaimed && !report.quotaRoleExists) {
    missing.push(
      "quotaConsumptionClaimed is true but quotaRoleExists is false — INT-CAP-001 is open (grounded_query is not a legal stella_interactions role), so a report claiming quota was consumed under that condition is false",
    )
  }
  if (!report.scopeAttestedViaJwtClaims) {
    missing.push('scopeAttestedViaJwtClaims is false — the grounding functions were not shown to run under a real authenticated session, not an anonymous or superuser one')
  }
  if (report.groundedQueryFlagState === 'enabled-globally') {
    missing.push("groundedQueryFlagState is 'enabled-globally' — STELLA_GROUNDED_QUERY_ENABLED must never be turned on outside this harness's own controlled local process")
  }
  if (!report.observabilityEventsSanitized || report.observabilityEventViolationCount !== 0) {
    missing.push(
      `observability events were not shown clean of sensitive fields (sanitized=${report.observabilityEventsSanitized}, violations=${report.observabilityEventViolationCount})`,
    )
  }
  if (report.localDecisionRowCount !== 0) {
    missing.push(`localDecisionRowCount is ${report.localDecisionRowCount} — STELLA_DECISIONS_PERSISTENCE_ENABLED is false, so a local decision must never be written to the database`)
  }
  if (report.decisionsPersistenceFlagState !== 'disabled') {
    missing.push(`decisionsPersistenceFlagState is '${report.decisionsPersistenceFlagState}' — must stay disabled on this train`)
  }

  return { localRuntimeHarnessReady: missing.length === 0, missingForLocalRuntimeHarness: missing }
}
