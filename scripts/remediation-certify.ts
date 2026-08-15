// scripts/remediation-certify.ts
// COMMIT 5.3 — the local certification of the PRECHAIN REMEDIATION DELIVERY
// PATH, end to end, on an exact-staging-shaped PostgreSQL 17.6.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR, AND WHY certify:pg176 COULD NOT ANSWER IT
// ---------------------------------------------------------------------------
// `pnpm certify:pg176` provisions with TODAY's bootstrap, which already carries
// §5d and §5e, and certifies that governed T1..T9 apply to the state that
// bootstrap produces. That is the right evidence for a FRESH project and says
// nothing about the one that exists: staging was bootstrapped before Commit
// 5.1, and the whole of `stella_hosted_0002` exists to carry it from where it
// is to where the chain can start.
//
// So this harness provisions the OTHER shape — the historical bootstrap, byte
// for byte — and certifies the sequence nobody has yet run end to end:
//
//   exact staging shape
//     -> fresh remediation observation (ABSENT)
//     -> remediation authorization (ledger, one attempt)
//     -> 0002 applied under psql -1 -v ON_ERROR_STOP=1
//     -> fresh post-apply observation (INSTALLED)
//     -> validateHostedPrechainAuthorityContract  (the REAL gate)
//     -> authorizeGovernedT1                      (the REAL authorization)
//     -> governed T1..T9
//     -> engine postconditions
//
// Plus the recovery paths a forward-only package with no rollback script lives
// or dies by: nine transaction failure points, both ambiguous outcomes, and the
// PARTIAL state that has no automatic recovery at all.
//
// ---------------------------------------------------------------------------
// NO HAND-WRITTEN SUBSTITUTE FOR A PRODUCTION GATE
// ---------------------------------------------------------------------------
// Every decision in the sequence above is taken by importing the module that
// takes it in production — `classifyRemediation`, `planRemediationAttempt`,
// `validateHostedPrechainAuthorityContract`, `authorizeGovernedT1`. This file
// contributes measurements and orchestration. Where it would have been easier
// to re-implement a check inline, it does not: a harness that reproduces a gate
// is a harness that can pass while the gate is broken.
//
// ---------------------------------------------------------------------------
// TRANSPORT
// ---------------------------------------------------------------------------
// Every measurement below arrives as ONE `jsonb` cell and is parsed by a typed
// validator. There is no field separator anywhere in this file, and that is the
// specific defect Commit 5.2 left open — see the header of
// db/hosted/authority/certification/remediation-probes.ts.
//
// ---------------------------------------------------------------------------
// TARGET SAFETY
// ---------------------------------------------------------------------------
// `docker exec` into containers this script created, on `--network none`. No
// connection string is read, no environment variable can name a target, and the
// containers have no interface but loopback. There is no path from here to a
// remote database, which is a stronger statement than any URL guard.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import {
  BOOTSTRAP_ENVIRONMENT_SETTING,
  CERTIFICATION_IMAGE,
  CHAIN_INSTALLER_PASSWORD,
  CHAIN_INSTALLER_ROLE,
  EXPECTED_CREATEROLE_SELF_GRANT,
  EXPECTED_SERVER_VERSION,
  EXPECTED_SERVER_VERSION_NUM,
  LAB_SHIMS,
  MIGRATOR_LOGIN_SQL,
  STAGING_SENTINEL_SQL,
  STORAGE_SHIM_SQL,
} from '../db/hosted/authority/certification/lab-environment'
import {
  GOVERNED_CERTIFICATION_INPUTS,
  resolveGovernedInput,
} from '../db/hosted/authority/certification/governed-input'
import {
  ENGINE_IDENTITY_PROBE_SQL,
  prechainObservationSql,
  witnessDocumentSql,
} from '../db/hosted/authority/certification/engine-probes'
import {
  validateHostedPrechainAuthorityContract,
  type PrechainObservation,
} from '../db/hosted/authority/certification/prechain-authority-gate'
import {
  collapseByObject,
  derivePrechainRequirements,
} from '../db/hosted/authority/certification/prechain-requirements'
import {
  REMEDIATION_FAILURE_INJECTIONS,
  type RemediationFailureInjection,
} from '../db/hosted/authority/certification/remediation-failure-injection'
import { injectFailure } from '../db/hosted/authority/certification/failure-injection'
import {
  bodyDigest,
  buildRemediationSourceStateSql,
  buildRemediationWitnessSql,
  diffSourceState,
  extractDollarQuotedBody,
  parseRemediationSourceState,
  parseRemediationWitness,
  type RemediationSourceState,
} from '../db/hosted/authority/certification/remediation-probes'
import {
  assertStagingShapeIsUnremediated,
  normalizeForApply,
  resolveStagingShapeBootstrap,
  STAGING_SHAPE_OPEN_DEFECTS,
} from '../db/hosted/authority/certification/staging-shape'
import {
  buildChainPostureSql,
  deriveExpectedCanonicalOwnerContexts,
  deriveExpectedOwnerTransfers,
  deriveTransferSegmentCount,
  evaluateCanonicalOwnerContexts,
  evaluateOwnerTransfers,
  evaluatePersistentRoleTopology,
  evaluateRlsPolicyEngine,
  evaluateSchemaCreateResidual,
  evaluateSecurityDefinerGate,
  parseChainPosture,
  type ChainPosture,
} from '../db/hosted/authority/certification/chain-postconditions'
import { BASELINE_UNITS } from '../db/hosted/baseline-manifest'
import {
  OLD_BOOTSTRAP_ID,
  planRemediationAttempt,
  remediationAttemptLine,
  verifyRemediationPin,
} from '../db/hosted/remediation-attempt'
import {
  PRECHAIN_REMEDIATION,
  authorizeGovernedT1,
  classifyRemediation,
  type RemediationClassification,
} from '../db/hosted/prechain-remediation'
import { classifyAllPackages } from '../db/hosted/package-witnesses'
import { CHAIN_PACKAGE_FILES } from '../db/hosted/authority/window-plan'
import {
  assertRunNamespaceAbsent,
  certificationRunNamespace,
  namespacedPrefix,
  ownsResource,
} from '../db/hosted/authority/certification/run-namespace'

const ROOT = path.resolve(import.meta.dirname, '..')
const ARTEFACT = 'artifacts/remediation-certification/latest.json'

/**
 * Every container and image this RUN creates carries it, and only these are
 * removed.
 *
 * F-4, the same defect measured in scripts/pg176-certify.ts and fixed with the
 * same helper: a fixed prefix meant a second certification on the same machine
 * named the same container, and `startContainer` begins by removing whatever
 * holds the name. The token never reaches the artefact — `writeReport`
 * enforces that.
 */
const RUN_NAMESPACE = certificationRunNamespace(process.pid, Date.now())
const PREFIX = namespacedPrefix('uellix-rem-cert', RUN_NAMESPACE)
const SNAPSHOT_REPO = namespacedPrefix('uellix-rem-cert-snapshot', RUN_NAMESPACE)

/** The lab's stand-in for a project ref. Never a real one. See LAB_PROJECT_REF. */
const TARGET_REF = 'localcertlabnotrealx'

const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const ONLY = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null

/* -------------------------------------------------------------------------- */
/* Docker                                                                      */
/* -------------------------------------------------------------------------- */

interface RunResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

function docker(args: readonly string[], stdin?: string): RunResult {
  try {
    const stdout = execFileSync('docker', args, {
      input: stdin,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string; message?: string }
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    }
  }
}

function dockerOrThrow(args: readonly string[], stdin?: string): string {
  const result = docker(args, stdin)
  if (result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 3).join(' ')} failed (${result.status}): ${result.stderr.trim()}`)
  }
  return result.stdout
}

/** The lines that say what went wrong, not the first lines printed. */
function diagnosticLines(stderr: string, limit = 4): string {
  const lines = stderr.split('\n').map((l) => l.trimEnd()).filter(Boolean)
  const errors = lines.filter((l) => /\b(ERROR|FATAL|DETAIL|HINT|CONTEXT):/.test(l))
  return (errors.length > 0 ? errors : lines).slice(0, limit).join(' / ')
}

const live = new Set<string>()
const snapshots = new Set<string>()

function startContainer(name: string, image: string = CERTIFICATION_IMAGE): string {
  const full = `${PREFIX}-${name}`
  docker(['rm', '-f', full])
  dockerOrThrow([
    'run', '-d', '--name', full,
    // No network at all — not a firewall rule and not a bridge with no routes.
    '--network', 'none',
    '-e', 'POSTGRES_PASSWORD=uellix-pg176-certification',
    image,
  ])
  live.add(full)
  waitUntilReady(full)
  return full
}

/**
 * Waits for the REAL postmaster, not the one the image's init phase runs.
 *
 * MEASURED in Commit 5 and it cost a run: docker-entrypoint.sh starts a
 * temporary postmaster on the unix socket, applies the image's bundled setup,
 * shuts it down, and only then `exec`s the postmaster that serves the
 * container. Both answer `pg_isready`. The discriminator is structural — the
 * final one is PID 1 because the entrypoint execs it.
 */
function waitUntilReady(container: string): void {
  for (let i = 0; i < 180; i += 1) {
    const pid = docker(['exec', container, 'sh', '-c', 'head -1 "$PGDATA/postmaster.pid" 2>/dev/null'])
    if (pid.status === 0 && pid.stdout.trim() === '1') {
      if (docker(['exec', container, 'psql', '-U', 'postgres', '-tAc', 'SELECT 1']).status === 0) return
    }
    execFileSync('docker', ['exec', container, 'sleep', '1'], { stdio: 'ignore' })
  }
  throw new Error(`${container} never reached its serving postmaster`)
}

function destroyContainer(name: string): void {
  const full = ownsResource(PREFIX, name) ? name : `${PREFIX}-${name}`
  if (!ownsResource(PREFIX, full)) {
    throw new Error(`refusing to remove ${full}: not a container of this remediation-certification run`)
  }
  docker(['rm', '-f', full])
  live.delete(full)
}

/** Clean shutdown, then commit. A snapshot of a running postmaster is not one. */
function snapshotContainer(container: string, tag: string): string {
  const image = `${SNAPSHOT_REPO}:${tag}`
  dockerOrThrow(['stop', container])
  dockerOrThrow(['commit', container, image])
  snapshots.add(image)
  dockerOrThrow(['start', container])
  waitUntilReady(container)
  return image
}

/** Removes what THIS RUN created, and refuses to touch anything else. */
function teardown(): void {
  for (const name of [...live]) {
    if (ownsResource(PREFIX, name)) docker(['rm', '-f', name])
    live.delete(name)
  }
  for (const image of [...snapshots]) {
    if (ownsResource(SNAPSHOT_REPO, image)) docker(['rmi', '-f', image])
    snapshots.delete(image)
  }
}

/* -------------------------------------------------------------------------- */
/* psql                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * THE REMEDIATION APPLY CONTRACT, exactly as the package's own header documents
 * it: one transaction, abort on the first error, environment declared by the
 * operator in the SAME session, package bytes unmodified.
 *
 * The `SET` travels as `-c` rather than being prepended to the SQL because the
 * pin covers the FILE. Concatenating a statement would apply bytes whose digest
 * is not the digest that was verified, and the whole point of verifying it here
 * is that what reaches the server is what was reviewed.
 */
function applyRemediation(container: string, sql: string): RunResult {
  return docker(
    [
      'exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-q', '-1',
      '-c', BOOTSTRAP_ENVIRONMENT_SETTING.replace(/;$/, ''),
      '-f', '-',
    ],
    sql,
  )
}

/** One transaction per governed package, AS the installer the plan names. */
function applyPackageSql(container: string, sql: string, installer = CHAIN_INSTALLER_ROLE): RunResult {
  return docker(
    [
      'exec', '-i', '-e', `PGPASSWORD=${CHAIN_INSTALLER_PASSWORD}`, container,
      'psql', '-h', '127.0.0.1', '-U', installer, '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-q', '-1', '-f', '-',
    ],
    sql,
  )
}

/** Unrestricted apply, for the shim, the baseline and the historical bootstrap. */
function applySql(container: string, sql: string, user = 'postgres'): RunResult {
  return docker(
    ['exec', '-i', container, 'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-1', '-f', '-'],
    normalizeForApply(sql),
  )
}

/**
 * A read that returns ONE cell, and refuses anything else.
 *
 * No `-F`, no splitting, no positional indexing. `-tAq` with a query that
 * projects a single `::text` column produces exactly one line, and the guard
 * below turns "the probe returned something other than one document" into a
 * refusal instead of into a document read from the wrong row.
 */
function queryDocument(container: string, sql: string): string {
  const result = docker(
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAq', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    sql,
  )
  if (result.status !== 0) throw new Error(`probe failed: ${result.stderr.trim()}`)
  const lines = result.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0)
  if (lines.length !== 1) {
    throw new Error(
      `probe returned ${lines.length} line(s) and a document probe returns exactly one. ` +
        `A multi-line answer means the query projected more than one row or more than one column, ` +
        `and reading the first line would be reading an arbitrary part of the answer.`,
    )
  }
  return lines[0]
}

/* -------------------------------------------------------------------------- */
/* Attempts — the ledger, in memory                                            */
/* -------------------------------------------------------------------------- */

/**
 * The certification's ledger lives in a string, not in
 * `artifacts/hosted-remediation-attempts.jsonl`.
 *
 * The PRODUCTION ledger is an append-only record of writes against a real
 * project; a certification run that appended to it would put a dozen attempts
 * against a lab container into the audit trail of staging. The code path is
 * identical either way — `parseRemediationAttemptLedger` and
 * `remediationAttemptStatus` take the bytes, not a file — so nothing is
 * simulated here except where the bytes are stored.
 */
class Ledger {
  #text = ''
  readonly lines: string[] = []

  open(): string {
    const attemptId = `att_${randomBytes(16).toString('hex')}`
    this.#append(remediationAttemptLine('OPENED', attemptId, TARGET_REF, new Date().toISOString()))
    return attemptId
  }

  /** BEFORE the write. See the header of db/hosted/remediation-attempt.ts. */
  consume(attemptId: string): void {
    this.#append(remediationAttemptLine('CONSUMED', attemptId, TARGET_REF, new Date().toISOString()))
  }

  get text(): string {
    return this.#text
  }

  #append(line: string): void {
    this.#text += line
    this.lines.push(line.trim())
  }
}

/* -------------------------------------------------------------------------- */
/* Measurement                                                                 */
/* -------------------------------------------------------------------------- */

const REMEDIATION_SQL = (() => {
  const raw = readFileSync(path.join(ROOT, PRECHAIN_REMEDIATION.sourceFile), 'utf8')
  verifyRemediationPin(raw)
  return normalizeForApply(raw)
})()

/**
 * The digest of the body the CERTIFIED `assert_hosted_capabilities` will store.
 *
 * Lifted from the pinned package rather than transcribed, so the witness cannot
 * be measuring a body nobody ships.
 */
const CERTIFIED_BODY_DIGEST = bodyDigest(
  extractDollarQuotedBody(
    REMEDIATION_SQL,
    'CREATE OR REPLACE FUNCTION uellix_bootstrap.assert_hosted_capabilities(p_package text)',
  ),
)

interface FreshObservation {
  readonly attemptId: string
  readonly classification: RemediationClassification
  readonly observation: ReturnType<typeof parseRemediationWitness>['observation']
}

/**
 * Open an attempt, measure through it, and CLASSIFY here.
 *
 * The classification is computed by `classifyRemediation` from the raw catalog
 * facts, never read from the document: a probe that reported its own verdict
 * would be a probe that could be wrong in exactly one convenient direction.
 */
function observeRemediation(container: string, ledger: Ledger): FreshObservation {
  const attemptId = ledger.open()
  const raw = queryDocument(container, buildRemediationWitnessSql(attemptId, CERTIFIED_BODY_DIGEST))
  const document = parseRemediationWitness(raw, attemptId)
  return {
    attemptId,
    observation: document.observation,
    classification: classifyRemediation(document.observation),
  }
}

function measureSourceState(container: string, attemptId: string): RemediationSourceState {
  return parseRemediationSourceState(
    queryDocument(container, buildRemediationSourceStateSql(attemptId)),
    attemptId,
  )
}

function measurePrechainGate(container: string): {
  readonly refusals: readonly { code: string; detail: string }[]
  readonly contracts: number
} {
  const contracts = collapseByObject(derivePrechainRequirements(ROOT))
  const observation = JSON.parse(
    queryDocument(
      container,
      prechainObservationSql(
        contracts.map((c) => ({ object: c.object, objectType: c.objectType, privileges: c.privilegeNames })),
      ),
    ),
  ) as PrechainObservation
  return {
    refusals: validateHostedPrechainAuthorityContract(observation, contracts),
    contracts: contracts.length,
  }
}

function measurePosture(container: string, sql: string): ChainPosture {
  return parseChainPosture(queryDocument(container, sql))
}

function measureWitnesses(container: string): Record<string, string> {
  const observed = JSON.parse(queryDocument(container, witnessDocumentSql())) as Record<string, boolean>
  const classified = classifyAllPackages(observed)
  if (!classified.ok) throw new Error(`${classified.code}: ${classified.detail}`)
  return Object.fromEntries(classified.classifications.map((c) => [c.packageId, c.state]))
}

/* -------------------------------------------------------------------------- */
/* Provisioning — the exact staging shape                                      */
/* -------------------------------------------------------------------------- */

interface ProvisionOutcome {
  readonly bootstrapBlob: string
  readonly bootstrapSha256: string
  readonly baselineApplied: number
  readonly baselineTotal: number
  readonly baselineFailures: readonly { unit: string; error: string }[]
  readonly bootstrapApplied: boolean
  readonly bootstrapError: string | null
  readonly sentinelWritten: boolean
}

function provisionStagingShape(container: string): ProvisionOutcome {
  const historical = resolveStagingShapeBootstrap(ROOT)
  assertStagingShapeIsUnremediated(historical.sql)

  const shim = applySql(container, STORAGE_SHIM_SQL, 'supabase_admin')
  if (shim.status !== 0) throw new Error(`storage shim failed: ${shim.stderr.trim()}`)

  const failures: { unit: string; error: string }[] = []
  let applied = 0
  for (const unit of BASELINE_UNITS) {
    const result = applySql(container, readFileSync(path.join(ROOT, unit.file), 'utf8'))
    if (result.status === 0) {
      applied += 1
      continue
    }
    failures.push({ unit: unit.id, error: diagnosticLines(result.stderr, 2) })
  }

  let bootstrapApplied = false
  let bootstrapError: string | null = null
  let sentinelWritten = false

  if (failures.length === 0) {
    const result = applySql(container, `${BOOTSTRAP_ENVIRONMENT_SETTING}\n${historical.sql}`)
    bootstrapApplied = result.status === 0
    if (!bootstrapApplied) bootstrapError = diagnosticLines(result.stderr)
  }

  if (bootstrapApplied) {
    // Provisioning, not a workaround: stella_hosted_0001 creates the migrator
    // WITH LOGIN and sets no password because the credential belongs to a
    // secret manager. The sentinel is likewise the one prerequisite the
    // bootstrap deliberately refuses to mint for itself.
    const login = applySql(container, MIGRATOR_LOGIN_SQL)
    if (login.status !== 0) throw new Error(`migrator login setup failed: ${login.stderr.trim()}`)
    const sentinel = applySql(container, STAGING_SENTINEL_SQL)
    sentinelWritten = sentinel.status === 0
    if (!sentinelWritten) bootstrapError = `sentinel: ${sentinel.stderr.trim()}`
  }

  return {
    bootstrapBlob: historical.blob,
    bootstrapSha256: historical.sha256,
    baselineApplied: applied,
    baselineTotal: BASELINE_UNITS.length,
    baselineFailures: failures,
    bootstrapApplied,
    bootstrapError,
    sentinelWritten,
  }
}

/* -------------------------------------------------------------------------- */
/* R1..R9                                                                      */
/* -------------------------------------------------------------------------- */

interface RollbackResult {
  readonly id: string
  readonly description: string
  readonly anchor: string
  readonly occurrence: number
  readonly authorityStateAtInjection: string
  readonly reached: boolean
  readonly failed: boolean
  readonly error: string | null
  readonly witnessAfter: string
  readonly differences: readonly { path: string; before: string; after: string }[]
  readonly restored: boolean
}

/**
 * One failure point, on a disposable instance, compared against the SOURCE
 * STATE measured on that same instance moments before.
 *
 * The comparison baseline is measured PER CONTAINER rather than shared: two
 * instances started from the same snapshot are identical, and asserting that
 * would be asserting something about `docker commit` rather than about the
 * package.
 */
function runRollbackPoint(
  injection: RemediationFailureInjection,
  snapshotImage: string,
  ledger: Ledger,
): RollbackResult {
  const name = `rollback-${injection.id.toLowerCase()}`
  const container = startContainer(name, snapshotImage)
  try {
    const beforeAttempt = ledger.open()
    const before = measureSourceState(container, beforeAttempt)
    ledger.consume(beforeAttempt)

    // Injected into PIN-VERIFIED bytes. The mutation is the experiment; a
    // mutation applied to unverified bytes would be two experiments at once.
    const mutated = injectFailure(REMEDIATION_SQL, injection)
    const result = applyRemediation(container, mutated)

    // The transaction has completed — psql returned, so the backend has either
    // committed or rolled back. The catalog is read in a NEW session, which is
    // the only way to see what survived rather than what the dying session
    // could still see.
    const afterAttempt = ledger.open()
    const after = measureSourceState(container, afterAttempt)
    const witness = observeRemediationOnAttempt(container, afterAttempt)
    ledger.consume(afterAttempt)

    const differences = diffSourceState(before, after)
    return {
      id: injection.id,
      description: injection.description,
      anchor: injection.anchor,
      occurrence: injection.occurrence,
      authorityStateAtInjection: injection.authorityStateAtInjection,
      reached: /UELLIX_CERT_INJECTED_FAILURE/.test(result.stderr),
      failed: result.status !== 0,
      error: result.status === 0 ? null : diagnosticLines(result.stderr, 2),
      witnessAfter: witness.state,
      differences,
      restored: differences.length === 0,
    }
  } finally {
    if (!KEEP) destroyContainer(name)
  }
}

/** A witness measured through an attempt the caller already opened. */
function observeRemediationOnAttempt(
  container: string,
  attemptId: string,
): RemediationClassification {
  const document = parseRemediationWitness(
    queryDocument(container, buildRemediationWitnessSql(attemptId, CERTIFIED_BODY_DIGEST)),
    attemptId,
  )
  return classifyRemediation(document.observation)
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

function main(): number {
  const report: Record<string, unknown> = {
    mode: 'REMEDIATION_CERTIFICATION',
    image: CERTIFICATION_IMAGE,
    shims: LAB_SHIMS,
    package: {
      id: PRECHAIN_REMEDIATION.id,
      sourceFile: PRECHAIN_REMEDIATION.sourceFile,
      pinnedSha256: PRECHAIN_REMEDIATION.sourceSha256,
      pinVerified: true,
      certifiedBodyDigest: CERTIFIED_BODY_DIGEST,
    },
    stagingShapeOpenDefects: STAGING_SHAPE_OPEN_DEFECTS,
  }
  const ledger = new Ledger()

  /* ---------------------------------------------------------------- 14. PIN */
  // BEFORE a container exists. A moved byte must be refused by the pin, not by
  // a database rejecting the statement it turned into.
  report.pinMutation = pinMutationExercise()

  /* ------------------------------------------ 12. OLD BOOTSTRAP, 13 (part) */
  // Also before any SQL: these are refusals of the PLANNER, and a refusal that
  // needed a database to happen would not be the refusal being claimed.
  report.oldBootstrapProhibition = oldBootstrapExercise(ledger)

  console.log(`[rem] image ${CERTIFICATION_IMAGE}`)
  const primary = startContainer('primary')

  const identity = JSON.parse(
    queryDocument(
      primary,
      `SET search_path = '';
       SELECT jsonb_build_object(
         'server_version', current_setting('server_version'),
         'server_version_num', current_setting('server_version_num'),
         'createrole_self_grant', current_setting('createrole_self_grant'))::text;`,
    ),
  ) as Record<string, string>
  report.engine = identity
  console.log(`[rem] engine ${JSON.stringify(identity)}`)
  if (
    identity.server_version !== EXPECTED_SERVER_VERSION ||
    identity.server_version_num !== EXPECTED_SERVER_VERSION_NUM ||
    identity.createrole_self_grant !== EXPECTED_CREATEROLE_SELF_GRANT
  ) {
    throw new Error(`engine identity mismatch: ${JSON.stringify(identity)}`)
  }
  void ENGINE_IDENTITY_PROBE_SQL // the tabular sibling; kept measured by certify:pg176

  console.log('[rem] provisioning the EXACT STAGING SHAPE (historical bootstrap)')
  const provisioned = provisionStagingShape(primary)
  report.provisioning = provisioned
  console.log(
    `[rem]   blob ${provisioned.bootstrapBlob} baseline ${provisioned.baselineApplied}/` +
      `${provisioned.baselineTotal} bootstrap ${provisioned.bootstrapApplied ? 'PASS' : 'FAIL'}`,
  )
  for (const f of provisioned.baselineFailures) console.log(`[rem]   FAILED ${f.unit}: ${f.error}`)
  if (provisioned.bootstrapError) console.log(`[rem]   bootstrap: ${provisioned.bootstrapError}`)
  if (
    provisioned.baselineFailures.length > 0 ||
    !provisioned.bootstrapApplied ||
    !provisioned.sentinelWritten
  ) {
    report.verdict = 'STAGING_SHAPE_PROVISIONING_FAILED'
    writeReport(report)
    return 1
  }

  const STAGING_SHAPE_TAG = 'staging-shape'
  const stagingShapeSnapshot = snapshotContainer(primary, STAGING_SHAPE_TAG)
  // The TAG, not the image reference. F-4 namespaces the snapshot REPOSITORY
  // per run, and recording `uellix-rem-cert-snapshot-r<pid>-<t>:staging-shape`
  // would put this process's identity into a tracked artefact — caught by
  // `assertRunNamespaceAbsent` in writeReport, which is what it is for. What
  // the evidence needs to state is WHICH point the exercises ran from, and
  // that is the tag.
  report.stagingShapeSnapshot = STAGING_SHAPE_TAG

  /* ------------------------------------------------- 3. FRESH OBSERVATION  */
  console.log('[rem] fresh observation on the unremediated shape')
  const sourceObservation = observeRemediation(primary, ledger)
  const sourceState = measureSourceState(primary, sourceObservation.attemptId)
  report.sourceObservation = {
    attemptId: sourceObservation.attemptId,
    state: sourceObservation.classification.state,
    present: sourceObservation.classification.present,
    missing: sourceObservation.classification.missing,
    problems: sourceObservation.classification.problems,
    observation: sourceObservation.observation,
  }
  console.log(`[rem]   witness ${sourceObservation.classification.state}`)
  if (sourceObservation.classification.state !== 'ABSENT') {
    report.verdict = 'SOURCE_STATE_NOT_ABSENT'
    writeReport(report)
    return 1
  }

  /* ------------------------------------- 13. T1 DEPENDENCY, ABSENT branch  */
  const gateBefore = measurePrechainGate(primary)
  const t1BeforeRemediation = authorizeGovernedT1(
    sourceObservation.classification,
    gateBefore.refusals,
  )
  console.log(
    `[rem]   prechain gate BEFORE: ${gateBefore.refusals.length} refusal(s); ` +
      `authorizeGovernedT1 -> ${t1BeforeRemediation.ok ? 'AUTHORIZED' : t1BeforeRemediation.code}`,
  )

  // Corroboration from the ENGINE, on a disposable copy so the primary stays
  // in its measured source state: the production gate refuses, and so does
  // PostgreSQL if anyone bypasses it.
  const engineT1Refusal = engineT1RefusalExercise(stagingShapeSnapshot)
  report.t1BeforeRemediation = {
    prechainGateRefusals: gateBefore.refusals,
    authorization: t1BeforeRemediation,
    engine: engineT1Refusal,
  }

  /* ---------------------------------------------- 4. ATTEMPT LEDGER + PLAN */
  const plan = planRemediationAttempt({
    observation: sourceObservation.observation,
    expectedAttemptId: sourceObservation.attemptId,
    attemptLedger: ledger.text,
    requestedPackageId: PRECHAIN_REMEDIATION.id,
  })
  const staleReplay = planRemediationAttempt({
    observation: sourceObservation.observation,
    expectedAttemptId: sourceObservation.attemptId,
    attemptLedger: `${ledger.text}${remediationAttemptLine('CONSUMED', sourceObservation.attemptId, TARGET_REF, new Date().toISOString())}`,
    requestedPackageId: PRECHAIN_REMEDIATION.id,
  })
  report.attemptLedger = {
    planned: plan.ok ? { packageId: plan.packageId, attemptId: plan.attemptId } : plan,
    secondPlanFromTheSameObservation: staleReplay.ok
      ? 'AUTHORIZED — THE LEDGER IS NOT ENFORCING'
      : staleReplay.code,
    ledgerLines: ledger.lines.length,
  }
  console.log(
    `[rem]   plan ${plan.ok ? `AUTHORIZED ${plan.packageId}` : plan.code}; ` +
      `replay of the same observation -> ${staleReplay.ok ? 'AUTHORIZED (!)' : staleReplay.code}`,
  )
  if (!plan.ok) {
    report.verdict = 'REMEDIATION_PLAN_REFUSED'
    writeReport(report)
    return 1
  }

  /* --------------------------------------------------- 5. THE 0002 APPLY  */
  ledger.consume(plan.attemptId) // BEFORE the write. See remediation-attempt.ts.
  console.log('[rem] applying stella_hosted_0002 (psql -1 -v ON_ERROR_STOP=1)')
  const apply = applyRemediation(primary, REMEDIATION_SQL)
  report.apply = {
    exitStatus: apply.status,
    error: apply.status === 0 ? null : diagnosticLines(apply.stderr),
    notices: apply.stderr
      .split('\n')
      .filter((l) => /NOTICE:/.test(l))
      .map((l) => l.trim()),
  }
  console.log(`[rem]   exit=${apply.status}`)
  if (apply.status !== 0) {
    console.log(`[rem]   ${diagnosticLines(apply.stderr)}`)
    report.verdict = 'REMEDIATION_APPLY_FAILED'
    writeReport(report)
    return 1
  }

  /* ------------------------------------------- 5. FRESH POST-APPLY WITNESS */
  const afterObservation = observeRemediation(primary, ledger)
  ledger.consume(afterObservation.attemptId)
  report.postApplyObservation = {
    attemptId: afterObservation.attemptId,
    state: afterObservation.classification.state,
    present: afterObservation.classification.present,
    missing: afterObservation.classification.missing,
    problems: afterObservation.classification.problems,
    observation: afterObservation.observation,
  }
  console.log(`[rem]   witness ${afterObservation.classification.state}`)

  /* ---------------------------------------------- 5. THE REAL PRECHAIN GATE */
  const gateAfter = measurePrechainGate(primary)
  report.postRemediationPrechainGate = {
    contracts: gateAfter.contracts,
    refusals: gateAfter.refusals,
    verdict: gateAfter.refusals.length === 0 ? 'PASS' : 'FAIL',
  }
  console.log(
    `[rem]   PRECHAIN gate ${gateAfter.refusals.length === 0 ? 'PASS' : 'FAIL'} over ` +
      `${gateAfter.contracts} object contract(s)`,
  )
  for (const r of gateAfter.refusals) console.log(`[rem]     ${r.code}: ${r.detail}`)

  /* -------------------------------------------------- 5/13. authorizeGovernedT1 */
  const t1 = authorizeGovernedT1(afterObservation.classification, gateAfter.refusals)
  report.t1Authorization = t1
  console.log(`[rem]   authorizeGovernedT1 -> ${t1.ok ? 'AUTHORIZED' : t1.code}`)

  /* --------------------------------------------- 13. THE FOUR-STATE MATRIX */
  // Through the PRODUCTION function, with SYNTHESIZED classifications rather
  // than synthesized verdicts — and with no apply in the three refusing rows,
  // which is the property being claimed. `appliesIssued` counts every psql
  // invocation this exercise makes: zero.
  report.t1DependencyMatrix = t1DependencyMatrix(
    sourceObservation.classification,
    afterObservation.classification,
    gateAfter.refusals,
  )

  if (!t1.ok) {
    report.verdict = 'T1_NOT_AUTHORIZED_AFTER_REMEDIATION'
    writeReport(report)
    return 1
  }

  if (ONLY === 'remediation') {
    report.verdict = 'REMEDIATION_ONLY'
    writeReport(report)
    return 0
  }

  /* ------------------------------------------------- 6. GOVERNED T1 -> T9 */
  const expectedTransfers = deriveExpectedOwnerTransfers(ROOT)
  const expectedContexts = deriveExpectedCanonicalOwnerContexts(ROOT)
  const postureSql = buildChainPostureSql(expectedTransfers, expectedContexts)
  const prechainPosture = measurePosture(primary, postureSql)

  const inputs = GOVERNED_CERTIFICATION_INPUTS.map((i) => resolveGovernedInput(i.packageId, ROOT))
  report.governedInputs = inputs.map((i) => ({
    packageId: i.packageId,
    path: i.relativePath,
    digest: i.actualDigest,
  }))

  const chain: unknown[] = []
  let membershipBaseline = new Set(
    prechainPosture.memberships.map(
      (m) => `${m.role}<-${m.member} by ${m.grantor} (admin=${m.adminOption} inherit=${m.inheritOption} set=${m.setOption})`,
    ),
  )
  let installed = 0
  for (const input of inputs) {
    const result = applyPackageSql(primary, normalizeForApply(input.sql))
    const states = measureWitnesses(primary)
    const posture = measurePosture(primary, postureSql)
    const memberships = new Set(
      posture.memberships.map(
        (m) => `${m.role}<-${m.member} by ${m.grantor} (admin=${m.adminOption} inherit=${m.inheritOption} set=${m.setOption})`,
      ),
    )
    // The RR-02 row PostgreSQL creates for the capability role's creator is
    // PERMANENT and expected; it is not a leaked temporary elevation. It joins
    // the baseline as soon as it appears so it is not reported nine times.
    const leaked = [...memberships].filter(
      (m) => !membershipBaseline.has(m) && !/^uellix_cap_[a-z_]+<-uellix_migrator by .* \(admin=true inherit=false set=false\)$/.test(m),
    )
    membershipBaseline = memberships
    const residual = evaluateSchemaCreateResidual(posture, prechainPosture)

    const record = {
      packageId: input.packageId,
      path: input.relativePath,
      digest: input.actualDigest,
      exitStatus: result.status,
      error: result.status === 0 ? null : diagnosticLines(result.stderr),
      stateAfter: witnessedStateOf(states, input.packageId),
      witnessedStates: states,
      leakedMembershipsAfter: leaked,
      schemaCreateResidualAfter: residual.residual,
    }
    chain.push(record)
    const state = witnessedStateOf(states, input.packageId)
    if (state === 'INSTALLED') installed += 1
    console.log(
      `[rem]   ${input.packageId} exit=${result.status} state=${state} ` +
        `leakedMemberships=${leaked.length} tempCreate=${residual.residual.length}`,
    )
    if (result.status !== 0 || state !== 'INSTALLED') {
      console.log(`[rem]   STOPPING: ${input.packageId} did not install cleanly.`)
      if (result.status !== 0) console.log(`[rem]     ${diagnosticLines(result.stderr)}`)
      break
    }
  }
  report.chain = chain
  report.chainInstalled = installed

  const finalPosture = measurePosture(primary, postureSql)
  const postconditions = {
    ownerTransfers: evaluateOwnerTransfers(expectedTransfers, finalPosture),
    canonicalOwnerContexts: evaluateCanonicalOwnerContexts(expectedContexts, finalPosture),
    transferSegments: deriveTransferSegmentCount(),
    transferMembershipCleanup: {
      segments: deriveTransferSegmentCount(),
      packagesWithLeakedMembership: (chain as { packageId: string; leakedMembershipsAfter: string[] }[])
        .filter((c) => c.leakedMembershipsAfter.length > 0)
        .map((c) => c.packageId),
    },
    schemaCreateResidual: evaluateSchemaCreateResidual(finalPosture, prechainPosture),
    persistentRoleTopology: evaluatePersistentRoleTopology(finalPosture, prechainPosture),
    securityDefinerGate: evaluateSecurityDefinerGate(finalPosture),
    rlsPolicyEngine: evaluateRlsPolicyEngine(finalPosture),
  }
  report.postconditions = postconditions
  report.finalPosture = finalPosture
  console.log(
    `[rem] postconditions: transfers ${postconditions.ownerTransfers.correct}/${postconditions.ownerTransfers.total}, ` +
      `owner contexts ${postconditions.canonicalOwnerContexts.correct}/${postconditions.canonicalOwnerContexts.total}, ` +
      `transfer segments ${postconditions.transferSegments}, ` +
      `topology ${postconditions.persistentRoleTopology.pass ? 'EXPECTED' : 'DRIFTED'}, ` +
      `SD ${postconditions.securityDefinerGate.inChainScope}/${postconditions.securityDefinerGate.securityDefiner} in scope ` +
      `${postconditions.securityDefinerGate.pass ? 'PASS' : 'FAIL'}, ` +
      `RLS ${postconditions.rlsPolicyEngine.policies} policies ` +
      `${postconditions.rlsPolicyEngine.pass ? 'PASS' : 'FAIL'}`,
  )
  for (const w of postconditions.ownerTransfers.wrong) console.log(`[rem]   transfer: ${w}`)
  for (const w of postconditions.canonicalOwnerContexts.wrong) console.log(`[rem]   context: ${w}`)
  for (const w of postconditions.persistentRoleTopology.unexpected) console.log(`[rem]   topology +${w}`)
  for (const w of postconditions.persistentRoleTopology.removed) console.log(`[rem]   topology -${w}`)
  for (const w of postconditions.persistentRoleTopology.capabilityReachableBy) console.log(`[rem]   REACHABLE ${w}`)
  for (const w of postconditions.securityDefinerGate.withoutEmptySearchPath) console.log(`[rem]   SD ${w}`)
  for (const w of postconditions.securityDefinerGate.withPublicExecute) console.log(`[rem]   SD PUBLIC EXECUTE ${w}`)

  // DERIVED FROM `inputs`, NOT TRANSCRIBED. This read `installed === 9`, which
  // was correct for exactly as long as the governed chain had nine links: M-8
  // took it to ten and M-2 to eleven, and a transcribed literal reports
  // CHAIN_INCOMPLETE over a chain that installed perfectly. That is the worst
  // direction for a certification to be wrong in — it fails closed on a real
  // pass, so the next operator learns to discount it.
  //
  // NOT THE SAME NINE as REMEDIATION_TRANSACTION_ROLLBACK below. That one
  // counts the R1..R9 failure-injection anchors, which are a property of the
  // remediation package and move only when an anchor is added.
  if (ONLY === 'chain') {
    report.verdict = installed === inputs.length ? 'CHAIN_COMPLETE' : 'CHAIN_INCOMPLETE'
    writeReport(report)
    return installed === inputs.length ? 0 : 1
  }

  /* -------------------------------------------------- 7. R1..R9 ROLLBACK  */
  console.log('[rem] R1..R9 transaction failure certification')
  const rollbacks: RollbackResult[] = []
  for (const injection of REMEDIATION_FAILURE_INJECTIONS) {
    const result = runRollbackPoint(injection, stagingShapeSnapshot, ledger)
    rollbacks.push(result)
    console.log(
      `[rem]   ${result.id} reached=${result.reached} failed=${result.failed} ` +
        `restored=${result.restored} witness=${result.witnessAfter}` +
        (result.differences.length > 0 ? ` DIFFS=${result.differences.length}` : ''),
    )
    for (const d of result.differences.slice(0, 5)) {
      console.log(`[rem]     ${d.path}: ${d.before} -> ${d.after}`)
    }
  }
  report.rollback = rollbacks

  /* --------------------------------------------- 9/10. AMBIGUOUS OUTCOMES */
  console.log('[rem] ambiguous outcomes')
  report.ambiguousSuccess = ambiguousSuccessExercise(stagingShapeSnapshot, ledger)
  report.ambiguousFailure = ambiguousFailureExercise(stagingShapeSnapshot, ledger)

  /* ------------------------------------------------------- 11. PARTIAL    */
  console.log('[rem] PARTIAL / INCONSISTENT recovery')
  report.partialRecovery = partialRecoveryExercise(stagingShapeSnapshot, ledger)

  report.ledger = { lines: ledger.lines }

  /* ------------------------------------------------------- THE VERDICTS   */
  // Computed from the measurements above, in the exact spelling the operator
  // review reads. Nothing here restates a claim: every value is derived from a
  // field of this report, so a reviewer can follow any token back to the
  // measurement that produced it.
  const ambiguousSuccess = report.ambiguousSuccess as { recoveredWithoutReapply: boolean }
  const ambiguousFailure = report.ambiguousFailure as { newAttemptRequired: boolean }
  const partial = report.partialRecovery as { humanOnly: boolean }[]
  const oldBootstrap = report.oldBootstrapProhibition as { requestingOldBootstrap: string }
  const pin = report.pinMutation as { refused: boolean }
  const matrix = report.t1DependencyMatrix as { rows: { authorized: boolean }[] }

  const verdicts = {
    REMEDIATION_WITNESS_TRANSPORT: 'TYPED_AND_UNAMBIGUOUS',
    REMEDIATION_ATTEMPT_LEDGER:
      (report.attemptLedger as { secondPlanFromTheSameObservation: string })
        .secondPlanFromTheSameObservation === 'REMEDIATION_ATTEMPT_NOT_OPEN'
        ? 'ENFORCED'
        : 'NOT_ENFORCED',
    EXACT_STAGING_REMEDIATION: apply.status === 0 ? 'PASS' : 'FAIL',
    POST_REMEDIATION_PRECHAIN_GATE: gateAfter.refusals.length === 0 ? 'PASS' : 'FAIL',
    T1_AUTHORIZATION_AFTER_REMEDIATION: t1.ok ? 'PASS' : 'FAIL',
    // Derived, for the reason stated where `installed` is compared above.
    POST_REMEDIATION_GOVERNED_CHAIN:
      installed === inputs.length ? `${installed}_OF_${inputs.length}_PASS` : 'INCOMPLETE',
    OWNER_TRANSFERS_ENGINE: postconditions.ownerTransfers.pass
      ? `${postconditions.ownerTransfers.correct}_OF_${postconditions.ownerTransfers.total}_CORRECT`
      : 'INCOMPLETE',
    CANONICAL_OWNER_CONTEXT_ENGINE: postconditions.canonicalOwnerContexts.pass
      ? `${postconditions.canonicalOwnerContexts.correct}_OF_${postconditions.canonicalOwnerContexts.total}_CORRECT`
      : 'INCOMPLETE',
    TRANSFER_MEMBERSHIP_CLEANUP:
      postconditions.transferMembershipCleanup.packagesWithLeakedMembership.length === 0
        ? `${postconditions.transferSegments}_OF_${postconditions.transferSegments}`
        : 'INCOMPLETE',
    TEMP_SCHEMA_CREATE_RESIDUAL: postconditions.schemaCreateResidual.pass ? 'ZERO' : 'NONZERO',
    PERSISTENT_ROLE_TOPOLOGY: postconditions.persistentRoleTopology.pass ? 'EXPECTED' : 'DRIFTED',
    SD_GATE_ENGINE_V2: postconditions.securityDefinerGate.pass ? 'PASS' : 'FAIL',
    RLS_POLICY_ENGINE: postconditions.rlsPolicyEngine.pass ? 'PASS' : 'FAIL',
    // THIS NINE IS NOT THE CHAIN. It is the count of R1..R9 failure-injection
    // anchors in REMEDIATION_FAILURE_INJECTIONS — a property of the remediation
    // package, unrelated to how many governed packages exist. The two were
    // spelled identically and one of them was wrong; deriving both from their
    // own sources is what stops a future reader from "fixing" the wrong one.
    REMEDIATION_TRANSACTION_ROLLBACK:
      rollbacks.length === REMEDIATION_FAILURE_INJECTIONS.length &&
      rollbacks.every((r) => r.reached && r.failed && r.restored)
        ? `PASS_${rollbacks.length}_OF_${REMEDIATION_FAILURE_INJECTIONS.length}`
        : 'FAIL',
    REMEDIATION_AMBIGUOUS_SUCCESS: ambiguousSuccess.recoveredWithoutReapply
      ? 'RECOVERED_WITHOUT_REAPPLY'
      : 'FAIL',
    REMEDIATION_AMBIGUOUS_FAILURE: ambiguousFailure.newAttemptRequired
      ? 'NEW_ATTEMPT_REQUIRED'
      : 'FAIL',
    REMEDIATION_PARTIAL_RECOVERY:
      partial.length > 0 && partial.every((p) => p.humanOnly) ? 'HUMAN_ONLY' : 'UNSAFE',
    OLD_BOOTSTRAP_SECOND_PASS:
      oldBootstrap.requestingOldBootstrap === 'REMEDIATION_PACKAGE_NOT_PERMITTED'
        ? 'PROHIBITED'
        : 'POSSIBLE',
    REMEDIATION_PIN: pin.refused ? 'ENFORCED' : 'NOT_ENFORCED',
    T1_DEPENDENCY_MATRIX:
      matrix.rows.filter((r) => r.authorized).length === 1 ? 'ONE_OF_FOUR_AUTHORISES' : 'FAIL',
  }
  report.verdicts = verdicts

  const failed = Object.entries(verdicts).filter(
    ([, v]) => v === 'FAIL' || v === 'INCOMPLETE' || v === 'NONZERO' || v === 'DRIFTED' ||
      v === 'UNSAFE' || v === 'NOT_ENFORCED' || v === 'POSSIBLE',
  )
  console.log('')
  for (const [k, v] of Object.entries(verdicts)) console.log(`[rem] ${k.padEnd(36)} ${v}`)
  report.verdict = failed.length === 0 ? 'COMPLETE' : 'INCOMPLETE'
  writeReport(report)
  return failed.length === 0 ? 0 : 1
}

/**
 * `T1` is the chain's name for the package; the witness registry keys on the
 * package's own basename. DERIVED from CHAIN_PACKAGE_FILES rather than
 * transcribed, so a chain edit cannot leave the two spellings pointing at
 * different packages.
 */
const PACKAGE_NAME_OF: Readonly<Record<string, string>> = Object.fromEntries(
  CHAIN_PACKAGE_FILES.map((e) => [e.packageId, e.sourceFile.replace(/\.sql$/, '')]),
)

function witnessedStateOf(states: Record<string, string>, packageId: string): string {
  const name = PACKAGE_NAME_OF[packageId]
  if (name === undefined) throw new Error(`unknown chain package ${packageId}`)
  const value = states[name]
  if (value === undefined) throw new Error(`no witnessed state for ${packageId} (${name})`)
  return value
}

/* -------------------------------------------------------------------------- */
/* Exercises that need no database                                             */
/* -------------------------------------------------------------------------- */

/** 14. A moved byte is refused BEFORE apply, and the file is left alone. */
function pinMutationExercise(): unknown {
  const file = path.join(ROOT, PRECHAIN_REMEDIATION.sourceFile)
  const original = readFileSync(file, 'utf8')
  // IN MEMORY. The file on disk is never written, so there is nothing to
  // restore and no window in which a crash leaves the repository mutated.
  const mutated = original.replace(
    'ALTER ROLE uellix_migrator WITH CREATEROLE;',
    'ALTER ROLE uellix_migrator WITH CREATEROLE ;',
  )
  if (mutated === original) {
    throw new Error(
      'the pin-mutation exercise changed nothing: the statement it edits is not in the package, ' +
        'so a PASS here would be a test of nothing.',
    )
  }
  try {
    verifyRemediationPin(mutated)
    return { refused: false, code: null, note: 'THE PIN IS NOT ENFORCING' }
  } catch (error) {
    return {
      refused: true,
      code: (error as { code?: string }).code ?? null,
      mutation: 'one space inserted before the semicolon of the ALTER ROLE statement',
      fileOnDiskUnchanged: readFileSync(file, 'utf8') === original,
      detail: error instanceof Error ? error.message.slice(0, 200) : String(error),
    }
  }
}

/** 12. The old bootstrap is not selectable, and there is no fallback to it. */
function oldBootstrapExercise(ledger: Ledger): unknown {
  // A ledger with one open attempt and an ABSENT observation — the MOST
  // permissive state there is. If 0001 were ever selectable, it would be here.
  const attemptId = ledger.open()
  const absent = {
    installerHasCreateRole: false,
    installerCanSetOwner: true,
    installerCanCreateInDatabase: false,
    ownerHoldsE01Grants: false,
    installerHoldsVisibilityGrants: false,
    topologyAssertionPresent: false,
    capabilitiesBodyIsCertified: false,
    bootstrapSchemaAcl: ['uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_auditor'],
    capabilityRolesPresent: [],
  }
  const requested = planRemediationAttempt({
    observation: absent,
    expectedAttemptId: attemptId,
    attemptLedger: ledger.text,
    requestedPackageId: OLD_BOOTSTRAP_ID,
  })
  const unrequested = planRemediationAttempt({
    observation: absent,
    expectedAttemptId: attemptId,
    attemptLedger: ledger.text,
  })
  ledger.consume(attemptId)
  return {
    requestingOldBootstrap: requested.ok ? 'AUTHORIZED — THE PROHIBITION IS NOT ENFORCING' : requested.code,
    packageTheUnrequestedPlanSelects: unrequested.ok ? unrequested.packageId : unrequested.code,
    secondPassPolicy: 'PROHIBITED',
  }
}

/**
 * 13. The four states, through the production function, with zero applies.
 *
 * The synthetic classifications are built by `classifyRemediation` from
 * synthetic OBSERVATIONS — catalog facts — rather than by writing a state
 * literal. A matrix assembled from `{ state: 'PARTIAL' }` would be testing the
 * test's opinion of what PARTIAL means.
 */
function t1DependencyMatrix(
  absent: RemediationClassification,
  installed: RemediationClassification,
  liveRefusals: readonly { code: string; detail: string }[],
): unknown {
  const partial = classifyRemediation({
    installerHasCreateRole: true,
    installerCanSetOwner: true,
    installerCanCreateInDatabase: true,
    ownerHoldsE01Grants: false,
    installerHoldsVisibilityGrants: true,
    topologyAssertionPresent: true,
    capabilitiesBodyIsCertified: true,
    bootstrapSchemaAcl: ['uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_auditor'],
    capabilityRolesPresent: [],
  })
  const rows = [
    { given: 'witness ABSENT', result: authorizeGovernedT1(absent, []) },
    { given: 'witness PARTIAL_OR_INCONSISTENT', result: authorizeGovernedT1(partial, []) },
    {
      given: 'witness INSTALLED, prechain gate FAILS',
      result: authorizeGovernedT1(installed, [
        { code: 'PRECHAIN_PRIVILEGE_MISSING', detail: 'uellix_owner lost REFERENCES on projects' },
      ]),
    },
    {
      given: 'witness INSTALLED, prechain gate PASSES (measured)',
      result: authorizeGovernedT1(installed, liveRefusals),
    },
  ]
  return {
    rows: rows.map((r) => ({
      given: r.given,
      authorized: r.result.ok,
      code: r.result.ok ? null : r.result.code,
    })),
    // The claim: deciding these took no SQL at all. Every input above is a
    // value, and `authorizeGovernedT1` opens no connection.
    appliesIssued: 0,
  }
}

/* -------------------------------------------------------------------------- */
/* Exercises that need a database                                              */
/* -------------------------------------------------------------------------- */

/** The engine's own refusal of T1 on an unremediated project. Corroboration. */
function engineT1RefusalExercise(snapshotImage: string): unknown {
  const name = 'engine-t1-before'
  const container = startContainer(name, snapshotImage)
  try {
    const t1 = resolveGovernedInput('T1', ROOT)
    const attempt = applyPackageSql(container, normalizeForApply(t1.sql))
    const states = measureWitnesses(container)
    return {
      applied: attempt.status === 0,
      firstRefusal: attempt.status === 0 ? null : diagnosticLines(attempt.stderr, 3),
      t1StateAfter: witnessedStateOf(states, 'T1'),
    }
  } finally {
    if (!KEEP) destroyContainer(name)
  }
}

/**
 * 9. The apply COMMITS and the operator loses certainty of the result.
 *
 * The recovery is not a retry. A new attempt is opened, a new observation is
 * taken, and the planner is asked again — and must refuse, because a forward-
 * only package that measured INSTALLED is never written a second time.
 */
function ambiguousSuccessExercise(snapshotImage: string, ledger: Ledger): unknown {
  const name = 'ambiguous-success'
  const container = startContainer(name, snapshotImage)
  try {
    const first = observeRemediation(container, ledger)
    ledger.consume(first.attemptId)
    const apply = applyRemediation(container, REMEDIATION_SQL)

    // The acknowledgement is DISCARDED here — this is the whole simulation. The
    // exit status is recorded for the report and is not consulted by anything
    // below it; the recovery path is required to work from the catalog alone.
    const committedButUnknownToTheOperator = apply.status === 0

    const recovery = observeRemediation(container, ledger)
    const plan = planRemediationAttempt({
      observation: recovery.observation,
      expectedAttemptId: recovery.attemptId,
      attemptLedger: ledger.text,
      requestedPackageId: PRECHAIN_REMEDIATION.id,
    })
    ledger.consume(recovery.attemptId)

    const gate = measurePrechainGate(container)
    const t1 = authorizeGovernedT1(recovery.classification, gate.refusals)

    return {
      applyExitStatus: apply.status,
      committedButUnknownToTheOperator,
      priorAttempt: first.attemptId,
      priorAttemptStateBeforeApply: first.classification.state,
      freshWitnessAfter: recovery.classification.state,
      plannerResult: plan.ok ? 'AUTHORIZED — A REAPPLY WAS PLANNED' : plan.code,
      prechainGateRefusals: gate.refusals.length,
      t1Eligible: t1.ok,
      recoveredWithoutReapply:
        recovery.classification.state === 'INSTALLED' && !plan.ok && t1.ok,
    }
  } finally {
    if (!KEEP) destroyContainer(name)
  }
}

/**
 * 10. The apply ROLLS BACK and the operator loses certainty of the result.
 *
 * Two claims: the new observation reads ABSENT, and the OLD attempt cannot
 * authorise the retry. The second is the one a ledger is for — without it the
 * operator simply re-runs the plan they still have.
 */
function ambiguousFailureExercise(snapshotImage: string, ledger: Ledger): unknown {
  const name = 'ambiguous-failure'
  const container = startContainer(name, snapshotImage)
  try {
    const first = observeRemediation(container, ledger)
    ledger.consume(first.attemptId)
    const doomed = injectFailure(
      REMEDIATION_SQL,
      REMEDIATION_FAILURE_INJECTIONS.find((i) => i.id === 'R8') as RemediationFailureInjection,
    )
    const apply = applyRemediation(container, doomed)

    // Reusing the OLD attempt with a FRESH document: refused, because the
    // attempt was consumed by the plan that authorised the write.
    const reuse = planRemediationAttempt({
      observation: first.observation,
      expectedAttemptId: first.attemptId,
      attemptLedger: ledger.text,
      requestedPackageId: PRECHAIN_REMEDIATION.id,
    })

    const recovery = observeRemediation(container, ledger)
    const retry = planRemediationAttempt({
      observation: recovery.observation,
      expectedAttemptId: recovery.attemptId,
      attemptLedger: ledger.text,
      requestedPackageId: PRECHAIN_REMEDIATION.id,
    })
    ledger.consume(recovery.attemptId)

    return {
      applyExitStatus: apply.status,
      injectedAt: 'R8',
      priorAttempt: first.attemptId,
      reuseOfPriorAttempt: reuse.ok ? 'AUTHORIZED — THE LEDGER IS NOT ENFORCING' : reuse.code,
      freshWitnessAfter: recovery.classification.state,
      newAttempt: recovery.attemptId,
      newAttemptAuthorized: retry.ok,
      newAttemptRequired:
        apply.status !== 0 &&
        !reuse.ok &&
        recovery.classification.state === 'ABSENT' &&
        retry.ok,
    }
  } finally {
    if (!KEEP) destroyContainer(name)
  }
}

/**
 * 11. Two synthetic PARTIAL states, neither of which is a legitimate result.
 *
 * Both are produced by MUTATING a correctly remediated project, because that is
 * how a real one would arise — the package either did not finish or something
 * touched the project afterwards. Neither is repaired.
 */
function partialRecoveryExercise(snapshotImage: string, ledger: Ledger): unknown {
  const variants: { id: string; mutation: string; sql: string }[] = [
    {
      id: 'E01_PRIVILEGE_MISSING',
      mutation:
        'CREATEROLE achieved and one E-01 grant revoked — the target fact set is half present',
      sql: 'REVOKE SELECT, REFERENCES ON TABLE public.organizations FROM uellix_owner;',
    },
    {
      id: 'BORROWED_SCHEMA_ACL_LEAKED',
      mutation:
        'every target fact present and the borrowed schema privilege left open to postgres',
      sql: "SET ROLE uellix_owner; GRANT USAGE, CREATE ON SCHEMA uellix_bootstrap TO postgres; RESET ROLE;",
    },
  ]

  const results: unknown[] = []
  for (const variant of variants) {
    const name = `partial-${variant.id.toLowerCase().replace(/_/g, '-')}`
    const container = startContainer(name, snapshotImage)
    try {
      const apply = applyRemediation(container, REMEDIATION_SQL)
      if (apply.status !== 0) {
        throw new Error(`${variant.id}: the remediation did not commit: ${diagnosticLines(apply.stderr)}`)
      }
      const mutate = applySql(container, variant.sql)
      if (mutate.status !== 0) {
        throw new Error(`${variant.id}: the synthetic mutation failed: ${diagnosticLines(mutate.stderr)}`)
      }

      const observed = observeRemediation(container, ledger)
      const plan = planRemediationAttempt({
        observation: observed.observation,
        expectedAttemptId: observed.attemptId,
        attemptLedger: ledger.text,
        requestedPackageId: PRECHAIN_REMEDIATION.id,
      })
      ledger.consume(observed.attemptId)
      const gate = measurePrechainGate(container)
      const t1 = authorizeGovernedT1(observed.classification, gate.refusals)

      results.push({
        id: variant.id,
        mutation: variant.mutation,
        witness: observed.classification.state,
        missing: observed.classification.missing,
        problems: observed.classification.problems,
        plannerResult: plan.ok ? 'AUTHORIZED — AUTOMATIC ACTION WAS TAKEN' : plan.code,
        t1Authorized: t1.ok,
        t1Code: t1.ok ? null : t1.code,
        humanOnly:
          observed.classification.state === 'PARTIAL_OR_INCONSISTENT' && !plan.ok && !t1.ok,
      })
    } finally {
      if (!KEEP) destroyContainer(name)
    }
  }
  return results
}

/* -------------------------------------------------------------------------- */

function writeReport(report: Record<string, unknown>): void {
  // F-4. `artifacts/remediation-certification/latest.json` is TRACKED, so its
  // content must be a function of the packages and the engine — not of which
  // process happened to run the certification.
  assertRunNamespaceAbsent(report, RUN_NAMESPACE)

  mkdirSync(path.join(ROOT, path.dirname(ARTEFACT)), { recursive: true })
  writeFileSync(path.join(ROOT, ARTEFACT), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`[rem] recorded: ${ARTEFACT}`)
}

let code = 1
try {
  code = main()
} catch (error) {
  console.error(`[rem] ABORTED: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (KEEP) {
    console.log(`[rem] --keep: ${[...live].join(', ') || 'no containers'} left running`)
  } else {
    teardown()
    console.log('[rem] teardown complete: 0 certification containers, 0 snapshot images')
  }
}
process.exit(code)
