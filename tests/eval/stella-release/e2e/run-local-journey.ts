// tests/eval/stella-release/e2e/run-local-journey.ts
// RELEASE line — Train 4 (STELLA_RELEASE_LOCAL_END_TO_END_GATE_TRAIN_4).
//
// The disposable-database journey itself:
//   real evidence -> extraction -> version -> chunks persisted -> SQL
//   retrieval -> extractive generation -> citations -> Product result ->
//   local human decision
//
// Invoked by scripts/stella-release-e2e-dry-run.sh AFTER the disposable
// container is up (--network none), the baseline is restored, and
// grounding_0002 / grounding_0003 / stella_0003 (and Train 4's package, if
// present) are applied. This script owns none of that lifecycle — it takes
// an already-running container name and:
//
//   1. runs the REAL lib/grounding/ingest pipeline over the two real fixture
//      documents (build-ingestion-sql.ts);
//   2. seeds org/user/project/evidence rows and calls the REAL
//      uellix_grounding.* SECURITY DEFINER functions via `docker exec psql`,
//      under a real (non-anonymous) request.jwt.claims session;
//   3. re-applies the same ingestion SQL a second time to prove idempotency;
//   4. retrieves chunks via the REAL `chunks_in_scope_attested` SQL function,
//      comparing each row's OWN scope columns against the requested scope, once for
//      the correct project and once for a same-org decoy project, proving
//      project-scope isolation;
//   5. runs the LOCAL, provider-free extractive generator over the real
//      retrieved rows, validates its citations with the REAL
//      validateAnswerCitations, and adapts the result with the REAL
//      adaptGroundedAnswer (the Product-facing view);
//   6. checks, against the live disposable database, whether
//      stella_interactions_stella_role_check admits 'grounded_query' yet
//      (it must not — INT-CAP-001 is open) and that
//      stella_suggestion_decisions holds zero rows (decisions persistence
//      stays disabled);
//   7. validates every observability event it constructs against the REAL
//      validateObservabilityEvent contract;
//   8. emits one LocalRuntimeHarnessReport (./harness-report.ts) as JSON.
//
// NO PROVIDER CALL ANYWHERE. Every DB interaction is a `docker exec` against
// the container scripts/stella-release-e2e-dry-run.sh started — never a
// direct TCP connection (the container runs --network none and has none to
// accept), never the persistent local Supabase stack, never a remote
// database.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  buildRetrievalQuery,
  deriveChunkId,
  textSpan,
  toCitableChunkRecord,
  validateAnswerCitations,
  type CitableChunkRecord,
  type ContentHash,
  type GroundingChunk,
  type GroundingScope,
  type RetrievalCandidate,
  type RetrievalResult,
} from '@/lib/grounding/contracts'
import { adaptGroundedAnswer, presentationInputFromRetrieval } from '@/components/stella/grounding-adapter'
import type { StellaGroundedQueryRequest } from '@/components/stella/grounded-query'
import { STELLA_DECISION_VALUES } from '@/app/actions/stella/decisions-schema'
import {
  validateObservabilityEvent,
  type StellaObservabilityEventName,
} from '../observability-contract'
import type { LocalRuntimeHarnessReport } from '../harness-report'
import {
  buildIngestSql,
  buildManifest,
  buildSeedSql,
  ingestFixtureDocuments,
  type E2eJourneyManifest,
} from './build-ingestion-sql'
import { generateExtractiveAnswer, type RetrievedChunkForGeneration } from './local-extractive-generator'

const REPO_ROOT = process.cwd()

function parseArgs(argv: readonly string[]): { box: string; out: string | null } {
  let box: string | null = null
  let out: string | null = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--box') box = argv[++i] ?? null
    else if (argv[i] === '--out') out = argv[++i] ?? null
  }
  if (!box) throw new Error('run-local-journey: --box <container-name> is required')
  return { box, out }
}

function log(message: string): void {
  console.log(`[e2e-journey] ${message}`)
}

/* -------------------------------------------------------------------------- */
/* docker exec plumbing                                                       */
/* -------------------------------------------------------------------------- */

function dockerCp(box: string, hostPath: string, containerPath: string): void {
  execFileSync('docker', ['cp', hostPath, `${box}:${containerPath}`], { stdio: 'pipe' })
}

/** Applies one SQL file inside the container as one implicit transaction
 *  (`-1`), failing loudly on the first error (`ON_ERROR_STOP=1`). Returns
 *  stdout so tagged SELECT results (see runTaggedQueries) can be parsed. */
function psqlApplyFile(box: string, containerPath: string): string {
  return execFileSync(
    'docker',
    ['exec', box, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-1', '-tA', '-v', 'ON_ERROR_STOP=1', '-f', containerPath],
    { encoding: 'utf8' },
  )
}

/** Runs a SQL script and parses lines of the form `TAG=value` out of its
 *  stdout. Every value this journey reads back from the database goes
 *  through this — never assumed, never hardcoded. */
function runTaggedQueries(box: string, hostFile: string, containerFile: string, sql: string): Record<string, string> {
  writeFileSync(hostFile, sql)
  dockerCp(box, hostFile, containerFile)
  const stdout = psqlApplyFile(box, containerFile)
  const tags: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (match) tags[match[1]] = match[2]
  }
  return tags
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/* -------------------------------------------------------------------------- */
/* Row -> GroundingChunk (mirrors db/grounding/grounding-chunk-repository.ts) */
/* -------------------------------------------------------------------------- */

interface ChunksInScopeRow {
  readonly chunk_id: string
  readonly chunk_index: number
  readonly content: string
  readonly content_hash: string
  readonly char_start: number
  readonly char_end: number
  readonly page: number | null
  readonly section_index: number | null
  readonly normalized_content_hash: string
  readonly normalization_version: string
  readonly chunker_version: string
  readonly injection_scanner_version: string
  readonly signals: readonly unknown[]
  // INT-GR-004 — the four attestation columns grounding_0004 §3 adds. Typed
  // as REQUIRED, not optional: a run against a database without that package
  // must fail to typecheck its own result rather than quietly reading
  // `undefined` and comparing it against a uuid.
  readonly organization_id: string
  readonly project_id: string
  readonly evidence_id: string
  readonly document_version_id: string
}

interface ManifestDocument {
  readonly evidenceId: string
  readonly title: string
  readonly mimeType: string
  readonly versionId: ContentHash
  readonly rawContentHash: ContentHash
}

/**
 * Re-derives chunk_id from (versionId, chunkIndex, contentHash) and throws on
 * mismatch — the SAME contract check
 * db/grounding/grounding-chunk-repository.ts's toGroundingChunk performs. A
 * harness that skipped this check would not be holding itself to the
 * standard production code is held to.
 */
function toGroundingChunk(scope: GroundingScope, doc: ManifestDocument, row: ChunksInScopeRow): GroundingChunk {
  const contentHash = row.content_hash as ContentHash
  const storedChunkId = row.chunk_id as ContentHash
  const derived = deriveChunkId(doc.versionId, row.chunk_index, contentHash)
  if (derived !== storedChunkId) {
    throw new Error(
      `run-local-journey: stored chunk_id ${storedChunkId} does not match deriveChunkId(versionId, chunkIndex, contentHash) — the same contract db/grounding/grounding-chunk-repository.ts enforces in production`,
    )
  }
  return {
    chunkId: storedChunkId,
    scope,
    evidenceId: doc.evidenceId,
    versionId: doc.versionId,
    chunkIndex: row.chunk_index,
    text: row.content,
    contentHash,
    location: {
      span: textSpan(row.char_start, row.char_end),
      coordinateSpace: row.normalized_content_hash as ContentHash,
      page: row.page,
      sectionIndex: row.section_index,
      sectionLabel: null,
      lineStart: 0,
      lineEnd: 0,
    },
    provenance: {
      evidenceId: doc.evidenceId,
      scope,
      versionId: doc.versionId,
      rawContentHash: doc.rawContentHash,
      normalizedContentHash: row.normalized_content_hash as ContentHash,
      normalizationVersion: row.normalization_version,
      chunkerVersion: row.chunker_version,
      injectionScannerVersion: row.injection_scanner_version,
      sourceLabel: doc.title,
      mimeType: doc.mimeType,
    },
    signals: row.signals as GroundingChunk['signals'],
  }
}

function toRetrievedForGeneration(chunk: GroundingChunk): RetrievedChunkForGeneration {
  return {
    chunkId: chunk.chunkId,
    evidenceId: chunk.evidenceId,
    versionId: chunk.versionId,
    scope: chunk.scope,
    text: chunk.text,
    contentHash: chunk.contentHash,
    location: chunk.location,
  }
}

/* -------------------------------------------------------------------------- */
/* Flag isolation — proves STELLA_GROUNDED_QUERY_ENABLED is 'true' only for a */
/* deliberately overridden CHILD process, never globally or persistently.     */
/* -------------------------------------------------------------------------- */

function checkFlagIsolatedToChildProcess(): { defaultIsFalse: boolean; childReportedTrue: boolean } {
  const probePath = path.join(REPO_ROOT, 'scripts', `_e2e_flag_probe_${process.pid}.ts`)
  writeFileSync(
    probePath,
    "import { stellaConfig } from '@/lib/stella/config'\nprocess.stdout.write(String(stellaConfig.isGroundedQueryEnabled))\n",
  )
  // pnpm resolves to a shim (.cmd) on Windows, which execFileSync cannot
  // exec directly without shell resolution — matches the same PATH lookup a
  // plain `pnpm ...` typed at the prompt would use.
  const useShell = process.platform === 'win32'
  try {
    const defaultOut = execFileSync('pnpm', ['exec', 'tsx', probePath], { cwd: REPO_ROOT, encoding: 'utf8', shell: useShell }).trim()
    const overriddenOut = execFileSync('pnpm', ['exec', 'tsx', probePath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: useShell,
      env: { ...process.env, STELLA_GROUNDED_QUERY_ENABLED: 'true' },
    }).trim()
    return { defaultIsFalse: defaultOut === 'false', childReportedTrue: overriddenOut === 'true' }
  } finally {
    rmSync(probePath, { force: true })
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const { box, out } = parseArgs(process.argv.slice(2))
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'stella-e2e-'))
  const sqlFunctionsInvoked = new Set<string>()
  const observabilityViolations: string[] = []

  // ---- 1. Real ingestion pipeline over the two real fixture documents -----
  log('running the real lib/grounding/ingest pipeline over the fixture documents')
  const ingested = ingestFixtureDocuments(REPO_ROOT)
  const manifest: E2eJourneyManifest = buildManifest(ingested)
  const scope: GroundingScope = { organizationId: manifest.organizationId, projectId: manifest.projectId }

  try {
    await runDatabaseJourney()
  } catch (error) {
    // FAIL CLEARLY, per the Fase 3 instruction ("el arnés debe fallar de
    // forma clara si ... falla una función") — but still emit a complete,
    // honest report rather than a bare stack trace, and still let the bash
    // wrapper destroy the container and run the fail-closed gate, which is
    // what actually turns this into an actionable, specific finding instead
    // of a crash. Every DB-dependent field below defaults to its "not
    // proven" value; only what genuinely ran (the real ingestion pipeline,
    // whatever SQL functions were reached before the failure) is reported
    // true.
    console.error('[e2e-journey] BLOCKER — a real SQL function call failed. This is not a harness bug to silently route around; see docs/ops/workstreams/RELEASE.md Train 4 for the reproduction and root-cause analysis.')
    console.error(error instanceof Error ? error.message : String(error))
    const flagCheck = checkFlagIsolatedToChildProcess()
    const report: LocalRuntimeHarnessReport = {
      containerNetworkMode: 'none',
      containerDestroyed: false,
      usedPersistentVolume: false,
      scopeAttestationVerified: false,
      quotaChargedByRuntime: false,
      verificationMethod: 'live-database-execution',
      packagesApplied: [],
      train4PackageStatus: 'not-yet-available',
      documentsIngestedViaRealPipeline: ingested.every((doc) => doc.outcome.status === 'ingested'),
      sqlFunctionsInvoked: [...sqlFunctionsInvoked],
      databaseApplied: true,
      crossProjectRetrievalRejected: false,
      idempotentReapplyVerified: false,
      generatorKind: 'local-extractive-test-only',
      answerDerivedFromRetrieval: false,
      citationsValidatedAgainstRealChunks: false,
      citationValidationIssueCount: 1,
      contradictionAttributed: false,
      abstentionObserved: false,
      quotaConsumptionClaimed: false,
      quotaRoleExists: false,
      scopeAttestedViaJwtClaims: sqlFunctionsInvoked.size > 0,
      groundedQueryFlagState: flagCheck.defaultIsFalse && flagCheck.childReportedTrue ? 'enabled-in-process-only' : flagCheck.defaultIsFalse ? 'disabled' : 'enabled-globally',
      providerCallCount: 0,
      observabilityEventsSanitized: false,
      observabilityEventSource: 'harness-constructed',
      observabilityEventViolationCount: 1,
      localDecisionRowCount: 0,
      decisionsPersistenceFlagState: 'disabled',
    }
    const json = JSON.stringify(report, null, 2)
    if (out) writeFileSync(out, json)
    console.log(`[e2e-journey] REPORT_JSON=${JSON.stringify(report)}`)
    rmSync(tmpDir, { recursive: true, force: true })
    process.exit(1)
  }

  rmSync(tmpDir, { recursive: true, force: true })

  async function runDatabaseJourney(): Promise<void> {
  // ---- 2. Seed + ingest, via docker exec psql -------------------------------
  const seedHostPath = path.join(tmpDir, 'seed.sql')
  const seedContainerPath = '/e2e_seed.sql'
  writeFileSync(seedHostPath, buildSeedSql(ingested))
  dockerCp(box, seedHostPath, seedContainerPath)
  log('applying seed rows (organizations/users/projects/evidence_items) as uellix_owner')
  psqlApplyFile(box, seedContainerPath)

  const ingestHostPath = path.join(tmpDir, 'ingest.sql')
  const ingestContainerPath = '/e2e_ingest.sql'
  const ingestSql = buildIngestSql(ingested)
  writeFileSync(ingestHostPath, ingestSql)
  dockerCp(box, ingestHostPath, ingestContainerPath)
  log('calling register_document_version -> insert_evidence_chunks -> finalize_document_ingestion as uellix_app (pass 1)')
  psqlApplyFile(box, ingestContainerPath)
  for (const fn of ['register_document_version', 'insert_evidence_chunks', 'finalize_document_ingestion']) {
    sqlFunctionsInvoked.add(fn)
  }

  // ---- 3. Idempotency: re-apply the SAME ingestion SQL a second time --------
  log('re-applying the same ingestion SQL a second time (idempotency)')
  psqlApplyFile(box, ingestContainerPath)

  const claims = JSON.stringify({ sub: manifest.userId, role: 'authenticated' })
  const [docA, docB] = manifest.documents

  const countTags = runTaggedQueries(
    box,
    path.join(tmpDir, 'recount.sql'),
    '/e2e_recount.sql',
    [
      'RESET ROLE;',
      'SET ROLE uellix_app;',
      `SELECT set_config('request.jwt.claims', ${sqlStringLiteral(claims)}, true);`,
      `SELECT v.id AS docver_a FROM public.evidence_document_versions v WHERE v.evidence_id = ${sqlStringLiteral(docA.evidenceId)}::uuid AND v.version_id = ${sqlStringLiteral(docA.versionId)}::char(64) \\gset`,
      `SELECT v.id AS docver_b FROM public.evidence_document_versions v WHERE v.evidence_id = ${sqlStringLiteral(docB.evidenceId)}::uuid AND v.version_id = ${sqlStringLiteral(docB.versionId)}::char(64) \\gset`,
      `SELECT 'CHUNK_COUNT_A=' || count(*)::text FROM public.evidence_chunks WHERE document_version_id = :'docver_a'::uuid AND canonical_chunk_id IS NULL;`,
      `SELECT 'CHUNK_COUNT_B=' || count(*)::text FROM public.evidence_chunks WHERE document_version_id = :'docver_b'::uuid AND canonical_chunk_id IS NULL;`,
      `SELECT 'DOCVER_A=' || :'docver_a';`,
      `SELECT 'DOCVER_B=' || :'docver_b';`,
      'RESET ROLE;',
    ].join('\n') + '\n',
  )

  const idempotentReapplyVerified =
    countTags.CHUNK_COUNT_A === String(docA.expectedChunkCount) && countTags.CHUNK_COUNT_B === String(docB.expectedChunkCount)
  const docverA = countTags.DOCVER_A
  const docverB = countTags.DOCVER_B
  if (!docverA || !docverB) {
    throw new Error('run-local-journey: could not resolve evidence_document_versions.id for one of the fixture documents')
  }
  log(`idempotency check: chunk counts stable across two applications (A=${countTags.CHUNK_COUNT_A}, B=${countTags.CHUNK_COUNT_B}) -> ${idempotentReapplyVerified}`)

  // ---- 4. Retrieval — real project (both docs) and decoy project ------------
  log('retrieving via the real uellix_grounding.chunks_in_scope_attested SQL function (INT-GR-004)')
  const retrievalTags = runTaggedQueries(
    box,
    path.join(tmpDir, 'retrieval.sql'),
    '/e2e_retrieval.sql',
    [
      'RESET ROLE;',
      'SET ROLE uellix_app;',
      `SELECT set_config('request.jwt.claims', ${sqlStringLiteral(claims)}, true);`,
      `SELECT 'RETRIEVAL_REAL_A=' || COALESCE(json_agg(t)::text, '[]') FROM (SELECT * FROM uellix_grounding.chunks_in_scope_attested(${sqlStringLiteral(manifest.organizationId)}::uuid, ${sqlStringLiteral(manifest.projectId)}::uuid, ${sqlStringLiteral(docverA)}::uuid)) t;`,
      `SELECT 'RETRIEVAL_REAL_B=' || COALESCE(json_agg(t)::text, '[]') FROM (SELECT * FROM uellix_grounding.chunks_in_scope_attested(${sqlStringLiteral(manifest.organizationId)}::uuid, ${sqlStringLiteral(manifest.projectId)}::uuid, ${sqlStringLiteral(docverB)}::uuid)) t;`,
      `SELECT 'RETRIEVAL_DECOY_A=' || COALESCE(json_agg(t)::text, '[]') FROM (SELECT * FROM uellix_grounding.chunks_in_scope_attested(${sqlStringLiteral(manifest.organizationId)}::uuid, ${sqlStringLiteral(manifest.decoyProjectId)}::uuid, ${sqlStringLiteral(docverA)}::uuid)) t;`,
      `SELECT 'RETRIEVAL_DECOY_B=' || COALESCE(json_agg(t)::text, '[]') FROM (SELECT * FROM uellix_grounding.chunks_in_scope_attested(${sqlStringLiteral(manifest.organizationId)}::uuid, ${sqlStringLiteral(manifest.decoyProjectId)}::uuid, ${sqlStringLiteral(docverB)}::uuid)) t;`,
      'RESET ROLE;',
    ].join('\n') + '\n',
  )
  sqlFunctionsInvoked.add('chunks_in_scope_attested')

  const rowsA: ChunksInScopeRow[] = JSON.parse(retrievalTags.RETRIEVAL_REAL_A ?? '[]')
  const rowsB: ChunksInScopeRow[] = JSON.parse(retrievalTags.RETRIEVAL_REAL_B ?? '[]')
  const decoyRowsA: ChunksInScopeRow[] = JSON.parse(retrievalTags.RETRIEVAL_DECOY_A ?? '[]')
  const decoyRowsB: ChunksInScopeRow[] = JSON.parse(retrievalTags.RETRIEVAL_DECOY_B ?? '[]')

  if (rowsA.length === 0 || rowsB.length === 0) {
    throw new Error('run-local-journey: retrieval from the REAL project returned zero rows for a document that was just ingested')
  }
  const crossProjectRetrievalRejected = decoyRowsA.length === 0 && decoyRowsB.length === 0
  log(`real-project retrieval: A=${rowsA.length} row(s), B=${rowsB.length} row(s). decoy-project retrieval: A=${decoyRowsA.length}, B=${decoyRowsB.length} -> isolation held = ${crossProjectRetrievalRejected}`)

  // ---- 4b. INT-GR-004 — the scope each ROW carries, compared row by row ----
  //
  // The decoy probe above proves the FILTER holds. This proves the
  // ATTESTATION does: every returned row states its own organization,
  // project, evidence item and document version, and each is compared against
  // what was asked for. Before grounding_0004 these columns did not exist and
  // the adapter restated the request, so this comparison could not fail — it
  // is new, and it is the whole content of INT-GR-004.
  //
  // A DISAGREEMENT is fatal rather than counted: a chunk that reports a scope
  // other than the one it was read for is either a broken WHERE clause or a
  // cross-tenant read, and neither may be reported as a degraded success.
  let attestedRowCount = 0
  for (const [row, doc, docverUuid] of [
    ...rowsA.map((r) => [r, docA, docverA] as const),
    ...rowsB.map((r) => [r, docB, docverB] as const),
  ]) {
    const mismatches: string[] = []
    if (row.organization_id !== manifest.organizationId) mismatches.push('organization_id')
    if (row.project_id !== manifest.projectId) mismatches.push('project_id')
    if (row.evidence_id !== doc.evidenceId) mismatches.push('evidence_id')
    if (row.document_version_id !== docverUuid) mismatches.push('document_version_id')
    if (mismatches.length > 0) {
      throw new Error(
        `run-local-journey: chunk ${row.chunk_id} was returned for a scope it does not carry — disagreeing column(s): ${mismatches.join(', ')}`,
      )
    }
    attestedRowCount++
  }
  const scopeAttestationVerified = attestedRowCount === rowsA.length + rowsB.length && attestedRowCount > 0
  log(`scope attestation: ${attestedRowCount} row(s) carried their own organization/project/evidence/version and every one matched the request`)

  const chunksA = rowsA.map((row) => toGroundingChunk(scope, { ...docA }, row))
  const chunksB = rowsB.map((row) => toGroundingChunk(scope, { ...docB }, row))
  const allChunks = [...chunksA, ...chunksB]

  // ---- 5a. Extractive generation (local, provider-free) over the real rows --
  log('generating an extractive answer over the real retrieved chunks — no provider, no LLM')
  const query = buildRetrievalQuery(scope, manifest.queryWithContradiction)
  const candidates = allChunks.map(toRetrievedForGeneration)
  const generation = generateExtractiveAnswer(query, candidates)

  const citableChunks: ReadonlyMap<ContentHash, CitableChunkRecord> = new Map(
    allChunks.map((chunk) => [chunk.chunkId, toCitableChunkRecord(chunk)]),
  )
  const citationIssues = validateAnswerCitations(generation.answer, citableChunks)
  log(`citation validation against real retrieved chunks: ${citationIssues.length} issue(s)`)

  const contradictionAttributed =
    generation.answer.status === 'partially_grounded' &&
    generation.answer.contradictions.length === 1 &&
    generation.answer.contradictions[0].sideA.length > 0 &&
    generation.answer.contradictions[0].sideB.length > 0

  // ---- 5b. Abstention — the generator's own contract with zero candidates ---
  // The disposable harness has no scored retrieval layer (LexicalChunkScorer
  // is exercised by the existing offline release-eval harness, not
  // re-proven here); what this DOES prove for real is that the generator
  // this journey actually calls abstains correctly when nothing is handed to
  // it, exactly as a real scorer filtering an irrelevant query to zero
  // candidates would leave it.
  const noMatchQuery = buildRetrievalQuery(scope, manifest.queryWithNoMatch)
  const abstentionGeneration = generateExtractiveAnswer(noMatchQuery, [])
  const abstentionObserved = abstentionGeneration.answer.status === 'abstained'
  log(`abstention check (zero candidates): status=${abstentionGeneration.answer.status} -> ${abstentionObserved}`)

  // ---- 5c. Product-facing result (INTEGRATION-001 adapter, real data) -------
  const retrievalResult: RetrievalResult = {
    query,
    candidates: allChunks.map(
      (chunk, index): RetrievalCandidate => ({ chunk, score: 1, rank: index, strategy: 'exact_reference', untrusted: true }),
    ),
    quarantinedCount: 0,
    belowThresholdCount: 0,
  }
  const productView = adaptGroundedAnswer(generation.answer, presentationInputFromRetrieval(retrievalResult, 'e2e-journey-real-project'))
  log(`Product-facing view (adaptGroundedAnswer): status=${productView.status}, claims=${productView.claims.length}, contradictions=${productView.contradictions.length}`)

  // ---- 5d. Request payload carries only the query, never scope ------------
  const requestPayload: StellaGroundedQueryRequest = { query: manifest.queryWithContradiction }
  const payloadIsQueryOnly = Object.keys(requestPayload).length === 1 && 'query' in requestPayload

  // ---- 6a. INT-CAP-001 — quota role check, against the LIVE database --------
  log('checking stella_interactions_stella_role_check admits grounded_query (INT-CAP-001, closed by stella_0013)')
  const catalogTags = runTaggedQueries(
    box,
    path.join(tmpDir, 'catalog.sql'),
    '/e2e_catalog.sql',
    [
      `SELECT 'QUOTA_ROLE_CHECK_DEF=' || COALESCE(pg_get_constraintdef(oid), '(not found)') FROM pg_constraint WHERE conname = 'stella_interactions_stella_role_check';`,
      // stella_0003 is applied BEST-EFFORT by the bash wrapper (see its
      // header note on baseline drift) — this run may not have it. A missing
      // table means zero rows were EVER possible to write, which is still
      // honestly "0" for localDecisionRowCount, not a failure of this check.
      `SELECT 'DECISIONS_TABLE_EXISTS=' || (to_regclass('public.stella_suggestion_decisions') IS NOT NULL)::text;`,
      `SELECT 'DECISIONS_ROW_COUNT=' || CASE WHEN to_regclass('public.stella_suggestion_decisions') IS NOT NULL THEN (SELECT count(*)::text FROM public.stella_suggestion_decisions) ELSE '0' END;`,
    ].join('\n') + '\n',
  )
  const quotaRoleExists = (catalogTags.QUOTA_ROLE_CHECK_DEF ?? '').includes('grounded_query')
  const decisionsTableExists = catalogTags.DECISIONS_TABLE_EXISTS === 'true'
  const decisionsRowCount = Number(catalogTags.DECISIONS_ROW_COUNT ?? '0')
  log(`quotaRoleExists (grounded_query in CHECK) = ${quotaRoleExists} — expected TRUE since stella_0013 is a required package`)
  log('quotaChargedByRuntime = false — the runtime does not call consume_stella_quota: it requires an idempotency key with no canonical server-side source (INT-INT-001)')
  // The table comes from db/baseline/stella_g2_schema.sql, NOT from
  // db/prepared/stella_0003 (which this harness deliberately no longer
  // applies). So "present" here says nothing about the package — what carries
  // the claim is the row COUNT: a decision was taken in this run and the table
  // that could have received it has zero rows.
  log(`stella_suggestion_decisions present in BASELINE = ${decisionsTableExists}; row count after a local decision (must stay 0) = ${decisionsRowCount}`)

  // ---- 6b. Local human decision — held in this process, never persisted ----
  // Simulates the ONE thing this train's scope allows: a caller "deciding"
  // in memory. Never writes to stella_suggestion_decisions — the flag stays
  // false throughout this train, matched against decisionsRowCount above.
  const localDecision = { decision: STELLA_DECISION_VALUES[0], answerId: `e2e-${docA.evidenceId.slice(-4)}-${docB.evidenceId.slice(-4)}` }
  log(`local decision recorded in process memory only: ${localDecision.decision} (never written to the database)`)

  // ---- 7. Observability events — built from REAL run data, validated -------
  const events: ReadonlyArray<{ eventName: StellaObservabilityEventName; payload: Record<string, unknown> }> = [
    { eventName: 'ingestion.started', payload: { eventName: 'ingestion.started', timestamp: new Date().toISOString(), organizationId: manifest.organizationId, projectId: manifest.projectId, requestId: 'e2e-journey', documentId: docA.evidenceId, sourceKind: 'file' } },
    { eventName: 'ingestion.completed', payload: { eventName: 'ingestion.completed', timestamp: new Date().toISOString(), organizationId: manifest.organizationId, projectId: manifest.projectId, requestId: 'e2e-journey', documentId: docA.evidenceId, chunkCount: docA.expectedChunkCount, durationMs: 1 } },
    { eventName: 'retrieval.started', payload: { eventName: 'retrieval.started', timestamp: new Date().toISOString(), organizationId: manifest.organizationId, projectId: manifest.projectId, requestId: 'e2e-journey', queryId: 'e2e-query-1' } },
    { eventName: 'retrieval.completed', payload: { eventName: 'retrieval.completed', timestamp: new Date().toISOString(), organizationId: manifest.organizationId, projectId: manifest.projectId, requestId: 'e2e-journey', queryId: 'e2e-query-1', resultCount: allChunks.length, topScore: 1, durationMs: 1 } },
    { eventName: 'retrieval.abstained', payload: { eventName: 'retrieval.abstained', timestamp: new Date().toISOString(), organizationId: manifest.organizationId, projectId: manifest.projectId, requestId: 'e2e-journey', queryId: 'e2e-query-2', reasonCode: 'no_matching_evidence' } },
    { eventName: 'citations.validated', payload: { eventName: 'citations.validated', timestamp: new Date().toISOString(), organizationId: manifest.organizationId, projectId: manifest.projectId, requestId: 'e2e-journey', citationCount: productView.claims.reduce((n, c) => n + c.citations.length, 0) } },
    { eventName: 'response.produced', payload: { eventName: 'response.produced', timestamp: new Date().toISOString(), organizationId: manifest.organizationId, projectId: manifest.projectId, requestId: 'e2e-journey', assertionCount: productView.claims.length, requiresHumanReview: true } },
    { eventName: 'human_decision.recorded', payload: { eventName: 'human_decision.recorded', timestamp: new Date().toISOString(), organizationId: manifest.organizationId, projectId: manifest.projectId, requestId: 'e2e-journey', decision: localDecision.decision, suggestionKey: localDecision.answerId } },
    { eventName: 'quota.rejected', payload: { eventName: 'quota.rejected', timestamp: new Date().toISOString(), organizationId: manifest.organizationId, projectId: manifest.projectId, requestId: 'e2e-journey', limit: 0, windowHours: 720 } },
  ]
  for (const { eventName, payload } of events) {
    const result = validateObservabilityEvent(payload)
    if (!result.ok) observabilityViolations.push(`${eventName}: ${result.violations.join('; ')}`)
  }
  log(`observability: ${events.length} event(s) validated, ${observabilityViolations.length} violation(s)`)

  // ---- Flag isolation --------------------------------------------------------
  log('checking STELLA_GROUNDED_QUERY_ENABLED is false by default and true only in a deliberately overridden child process')
  const flagCheck = checkFlagIsolatedToChildProcess()
  const groundedQueryFlagState: LocalRuntimeHarnessReport['groundedQueryFlagState'] =
    flagCheck.defaultIsFalse && flagCheck.childReportedTrue ? 'enabled-in-process-only' : flagCheck.defaultIsFalse ? 'disabled' : 'enabled-globally'
  log(`groundedQueryFlagState = ${groundedQueryFlagState}`)

  // ---- Assemble the report ----------------------------------------------------
  const report: LocalRuntimeHarnessReport = {
    containerNetworkMode: 'none',
    containerDestroyed: false, // set true by the bash wrapper after it destroys the container
    usedPersistentVolume: false,
    verificationMethod: 'live-database-execution',
    packagesApplied: [], // filled in by the bash wrapper, which knows what it applied
    train4PackageStatus: 'not-yet-available',
    documentsIngestedViaRealPipeline: ingested.every((doc) => doc.outcome.status === 'ingested'),
    sqlFunctionsInvoked: [...sqlFunctionsInvoked],
    databaseApplied: true,
    crossProjectRetrievalRejected,
    idempotentReapplyVerified,
    generatorKind: 'local-extractive-test-only',
    answerDerivedFromRetrieval: generation.usedChunkIds.length > 0 || generation.answer.status === 'abstained',
    citationsValidatedAgainstRealChunks: true,
    citationValidationIssueCount: citationIssues.length,
    contradictionAttributed,
    abstentionObserved,
    scopeAttestationVerified,
    quotaConsumptionClaimed: false,
    quotaRoleExists,
    // INT-INT-001. The runtime does not call consume_stella_quota: the
    // function requires an idempotency key and this application has no
    // canonical server-side source for one. Hardcoded false rather than
    // observed, because there is nothing to observe — no call is made — and a
    // field derived from "did we see a row?" would report true the day some
    // OTHER path writes a grounded_query interaction.
    quotaChargedByRuntime: false,
    scopeAttestedViaJwtClaims: true,
    groundedQueryFlagState,
    providerCallCount: 0,
    observabilityEventsSanitized: observabilityViolations.length === 0,
    // Hardcoded, and hardcoded HONESTLY: these nine events were built above by
    // this file. Nothing in app/** or lib/grounding/** emits a named
    // observability event, so there is no runtime telemetry to collect. The
    // day something does emit, this becomes an observation instead of a
    // constant — and until then the reducer refuses to call the runtime ready
    // on the strength of a schema check over the harness's own strings.
    observabilityEventSource: 'harness-constructed',
    observabilityEventViolationCount: observabilityViolations.length,
    localDecisionRowCount: decisionsRowCount < 0 ? 0 : decisionsRowCount,
    decisionsPersistenceFlagState: 'disabled',
  }

  if (!payloadIsQueryOnly) {
    throw new Error('run-local-journey: StellaGroundedQueryRequest carried more than just `query` — PRODUCT-002 requires scope to come from the server, never the client payload')
  }

  const json = JSON.stringify(report, null, 2)
  if (out) writeFileSync(out, json)
  console.log(`[e2e-journey] REPORT_JSON=${JSON.stringify(report)}`)
  if (out) log(`report written to ${out}`)
  }
}

main().catch((error) => {
  console.error('[e2e-journey] FATAL', error)
  process.exit(1)
})
