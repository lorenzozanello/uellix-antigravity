// scripts/pg176-certify.ts
// COMMIT 5 — the local PostgreSQL 17.6 engine certification of the GOVERNED
// Stella chain.
//
// ---------------------------------------------------------------------------
// WHAT THIS RUNS, AND THE ONE THING IT WILL NOT RUN
// ---------------------------------------------------------------------------
// It applies db/prepared/hosted/governed/*.governed.sql — T1 through T9 — to a
// disposable PostgreSQL 17.6 container, one package per transaction, and reads
// the catalog after each. It CANNOT be pointed at the ungoverned artefacts under
// db/prepared/hosted/: resolution goes through
// `certification/governed-input.ts`, which fences every path on `/governed/`
// and pins every file by digest, and both refusals happen before a byte of SQL
// reaches a server.
//
// COMMIT 5.5. The operational runners USED to resolve `.hosted.sql`, left alone
// deliberately by Commit 5 — and staging paid for it: the chain CLI handed an
// operator that path and T1 died at «permission denied for schema
// uellix_grounding». They now resolve through `db/hosted/governed-artefact.ts`,
// which delegates to the same fenced, pinned resolver this harness uses. The
// engine half of that finding is reproduced below as UNGOVERNED_ARTEFACT_ENGINE.
//
// ---------------------------------------------------------------------------
// WHY docker exec AND NOT A CONNECTION STRING
// ---------------------------------------------------------------------------
// Same reason as scripts/baseline-rehearsal-local.ts: a URL guard answers "is
// this local?", a question with a wrong answer available. `docker exec` into a
// container this script created, on `--network none`, has no wrong answer —
// there is no hostname to mistype and no remote database reachable by that path
// at all. Nothing here reads an environment variable that could name a target.
//
// ---------------------------------------------------------------------------
// WHY EXIT STATUS IS NEVER THE EVIDENCE
// ---------------------------------------------------------------------------
// `psql -1 -v ON_ERROR_STOP=1` exiting 0 means the transaction committed. It
// does not mean the package installed what it was supposed to, that the
// ownership transfers landed on the right roles, or that the temporary
// authority was given back. Every one of those is a separate catalog read, and
// a package is only recorded as applied when its witnesses say so.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  BOOTSTRAP_ENVIRONMENT_SETTING,
  CERTIFICATION_IMAGE,
  EXPECTED_CREATEROLE_SELF_GRANT,
  EXPECTED_SERVER_VERSION,
  EXPECTED_SERVER_VERSION_NUM,
  CANDIDATE_INSTALLERS,
  CHAIN_INSTALLER_PASSWORD,
  CHAIN_INSTALLER_ROLE,
  LAB_FAITHFUL_SURFACE,
  MIGRATOR_LOGIN_SQL,
  LAB_SHIMS,
  STAGING_SENTINEL_SQL,
  STORAGE_SHIM_SQL,
} from '../db/hosted/authority/certification/lab-environment'
import {
  GOVERNED_CERTIFICATION_INPUTS,
  resolveGovernedInput,
  type ResolvedGovernedInput,
} from '../db/hosted/authority/certification/governed-input'
import { refusalExercises } from '../db/hosted/authority/certification/refusal-exercises'
import {
  certificationPredicates,
  certificationVerdict,
  type CertificationEvidence,
} from '../db/hosted/authority/certification/certification-verdict'
import {
  STORAGE_FUNCTIONAL_FIXTURE_SQL,
  STORAGE_FUNCTIONAL_MATRIX_SQL,
  evaluateStorageFunctionalProbe,
  storageFunctionalNotRun,
  type StorageFunctionalObservation,
  type StorageFunctionalResult,
} from '../db/hosted/authority/certification/storage-functional-probe'
import {
  assertRunNamespaceAbsent,
  certificationRunNamespace,
  namespacedPrefix,
  ownsResource,
} from '../db/hosted/authority/certification/run-namespace'
import {
  ENGINE_IDENTITY_PROBE_SQL,
  FUNCTION_OWNER_PROBE_SQL,
  MEMBERSHIP_PROBE_SQL,
  POLICY_PROBE_SQL,
  RELATION_OWNER_PROBE_SQL,
  ROLE_ATTRIBUTE_PROBE_SQL,
  SCHEMA_ACL_PROBE_SQL,
  SCHEMA_CREATE_RESIDUAL_PROBE_SQL,
  SESSION_STATE_PROBE_SQL,
  TABLE_GRANT_PROBE_SQL,
  TRIGGER_PROBE_SQL,
  prechainObservationSql,
  witnessProbeSql,
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
  FAILURE_INJECTIONS,
  injectFailure,
  type FailureInjection,
} from '../db/hosted/authority/certification/failure-injection'
import { BASELINE_UNITS } from '../db/hosted/baseline-manifest'
import {
  PRECHAIN_ADMINISTRATIVE_UNITS,
  sha256OfPreparedSql,
} from '../db/hosted/prechain-ownership'
import { classifyAllPackages, type ObservedWitnesses } from '../db/hosted/package-witnesses'
import { hostedArtefactPath, BOOTSTRAP_ARTEFACT } from '../db/hosted/authority/ownership-simulation'
import { CHAIN_PACKAGE_FILES } from '../db/hosted/authority/window-plan'

/**
 * `T1` is the chain's name for the package; the witness registry keys on the
 * package's own basename. Derived rather than transcribed, so a chain edit
 * cannot leave the two spellings pointing at different packages.
 */
const PACKAGE_NAME_OF: Readonly<Record<string, string>> = Object.fromEntries(
  CHAIN_PACKAGE_FILES.map((e) => [e.packageId, e.sourceFile.replace(/\.sql$/, '')]),
)

const ROOT = path.resolve(import.meta.dirname, '..')
const ARTEFACT_CERTIFICATION = 'artifacts/pg176-certification/latest.json'
const ARTEFACT_DIAGNOSTIC = 'artifacts/pg176-certification/diagnostic.json'

/**
 * Every container and image this RUN creates carries it, and only these are
 * removed.
 *
 * F-4. The prefix used to be fixed, so a second certification on the same
 * machine named the same container — and `startContainer` begins by removing
 * whatever holds the name. Two concurrent runs deleted each other's databases
 * and overwrote each other's snapshots, and each then reported what the
 * wreckage measured. The token never reaches the artefact; `writeReport`
 * enforces that rather than trusting it.
 */
const RUN_NAMESPACE = certificationRunNamespace(process.pid, Date.now())
const PREFIX = namespacedPrefix('uellix-pg176-cert', RUN_NAMESPACE)
const SNAPSHOT_REPO = namespacedPrefix('uellix-pg176-cert-snapshot', RUN_NAMESPACE)

const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const ONLY = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null
/**
 * Applies the E-01 remediation HYPOTHESIS to the environment before the chain.
 *
 * A run with this flag is NOT certification evidence and says so in its own
 * verdict. It exists to answer one question a failed certification cannot:
 * whether E-01 is the first blocker or the only one.
 */
/**
 * RETIRED in Commit 5.1, kept as a flag that refuses.
 *
 * The E-01/E-02 patch existed to answer "is E-01 the first blocker or the only
 * one" while the bootstrap could not establish the contract itself. It now can
 * (§5d/§5e), so a run that patched the environment would be measuring a
 * database nobody will provision — which is the one thing this harness must
 * never quietly do.
 */
const DIAGNOSTIC = false
if (argv.includes('--diagnostic')) {
  throw new Error(
    '--diagnostic was retired in Commit 5.1: E-01 and E-02 are established by ' +
      'stella_hosted_0001 §5d/§5e and are gated before T1. There is nothing left for it to patch.',
  )
}
/**
 * Which identity applies the chain packages.
 *
 * COMMIT 5.1 resolved this: HOSTED_INSTALLER is `uellix_migrator`, the principal
 * every generated elevation names and the one the role registry always
 * specified. `postgres` remains a candidate only so the probe can keep
 * measuring that it is REFUSED — a contract with one permitted identity is only
 * a contract if the other one still fails.
 */
const INSTALLER =
  argv.find((a) => a.startsWith('--installer='))?.slice('--installer='.length) ??
  CHAIN_INSTALLER_ROLE

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

/**
 * The lines that say what went wrong, not the first four lines printed.
 *
 * psql interleaves NOTICEs with the failure. A package that emits three
 * "policy does not exist, skipping" notices before dying pushes its own ERROR
 * out of a head-of-stream slice, and the report then presents three harmless
 * notices as the reason the package failed — which is how the second
 * diagnostic round nearly got read as a different defect from the first.
 */
function diagnosticLines(stderr: string, limit = 4): string {
  const lines = stderr.split('\n').map((l) => l.trimEnd()).filter(Boolean)
  const errors = lines.filter((l) => /\b(ERROR|FATAL|DETAIL|HINT|CONTEXT):/.test(l))
  return (errors.length > 0 ? errors : lines).slice(0, limit).join(' / ')
}

function dockerOrThrow(args: readonly string[], stdin?: string): string {
  const result = docker(args, stdin)
  if (result.status !== 0) {
    throw new Error(`docker ${args.slice(0, 3).join(' ')} failed (${result.status}): ${result.stderr.trim()}`)
  }
  return result.stdout
}

const live = new Set<string>()
const snapshots = new Set<string>()

function startContainer(name: string, image: string = CERTIFICATION_IMAGE): string {
  const full = `${PREFIX}-${name}`
  docker(['rm', '-f', full])
  dockerOrThrow([
    'run',
    '-d',
    '--name',
    full,
    // No network at all. Not a firewall rule, not a bridge with no routes —
    // the container has no interface but loopback.
    '--network',
    'none',
    '-e',
    'POSTGRES_PASSWORD=uellix-pg176-certification',
    image,
  ])
  live.add(full)

  waitUntilReady(full)
  return full
}

/**
 * Waits for the REAL postmaster, not the one the image's init phase runs.
 *
 * MEASURED, and it cost a run to find: docker-entrypoint.sh starts a temporary
 * postmaster on the unix socket, applies the image's own bundled setup, shuts
 * it down, and only then execs the postmaster that serves the container. Both
 * answer `pg_isready` and both answer `SELECT 1`. A harness that took the first
 * one for ready got as far as the storage shim and then met
 * `FATAL: the database system is shutting down` from a probe — which reads
 * exactly like a crash caused by the SQL that was just applied.
 *
 * The discriminator is structural rather than a sleep: the entrypoint `exec`s
 * the final postmaster, so it is PID 1 in the container. The temporary one
 * never is. This also holds for a container started from a snapshot, where the
 * init phase is skipped entirely and there is only ever one postmaster.
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
    throw new Error(`refusing to remove ${full}: not a container of this certification run`)
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

/**
 * Removes what THIS RUN created, and refuses to touch anything else.
 *
 * The sets only ever hold this run's resources, so the ownership check cannot
 * fire — which is the point of asserting it here rather than trusting it. A
 * concurrent run's containers are not this one's to clean up, and neither are
 * the un-namespaced leftovers of a pre-F-4 run.
 */
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
 * THE APPLY CONTRACT: one transaction per package, abort on the first error,
 * AS THE INSTALLER THE PLAN NAMES.
 *
 * `-1` and `ON_ERROR_STOP=1` together are the whole of package-level atomicity:
 * without the first there is no transaction to roll back, and without the
 * second psql carries on past the failure and commits whatever came after it.
 *
 * The connection is TCP to 127.0.0.1 rather than the local socket because the
 * socket is peer-authenticated and the OS user in the container is `postgres`.
 * The container has no network interface but loopback, so this widens nothing.
 */
function applyPackageSql(container: string, sql: string, installer: string = INSTALLER): RunResult {
  return docker(
    [
      'exec',
      '-i',
      '-e',
      `PGPASSWORD=${CHAIN_INSTALLER_PASSWORD}`,
      container,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      installer,
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-1',
      '-f',
      '-',
    ],
    sql,
  )
}

/** Unrestricted apply, for the shim and the baseline units. Still ON_ERROR_STOP. */
function applySql(container: string, sql: string, user = 'postgres', single = true): RunResult {
  const args = ['exec', '-i', container, 'psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q']
  if (single) args.push('-1')
  args.push('-f', '-')
  return docker(args, sql)
}

/**
 * A read. Never inside the applying transaction — a separate session, always.
 *
 * The field separator is an explicit unit-separator constant rather than psql's
 * default `|`, because `proconfig` is itself pipe-joined: a probe that split on
 * `|` would shear `search_path=` off its own value and report a column that does
 * not exist.
 */
const FS = '\u001f'

function query(container: string, sql: string): string[][] {
  const result = docker(
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAq', '-F', FS, '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    sql,
  )
  if (result.status !== 0) throw new Error(`probe failed: ${result.stderr.trim()}`)
  return result.stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => line.split(FS))
}

/* -------------------------------------------------------------------------- */
/* Observation                                                                 */
/* -------------------------------------------------------------------------- */

interface CatalogState {
  readonly witnesses: ObservedWitnesses
  readonly memberships: readonly string[]
  readonly functionOwners: readonly {
    signature: string
    schema: string
    owner: string
    securityDefiner: boolean
    proconfig: string
    executeGrantees: string
  }[]
  readonly relationOwners: readonly { relation: string; kind: string; owner: string; rls: boolean; rlsForced: boolean }[]
  readonly schemaAcls: readonly string[]
  readonly schemaCreateResidual: readonly string[]
  readonly policies: readonly string[]
  readonly tableGrants: readonly string[]
  readonly roleAttributes: readonly string[]
  readonly triggers: readonly string[]
  readonly sessionState: readonly string[]
}

function observe(container: string): CatalogState {
  const witnesses: Record<string, boolean> = {}
  for (const [packageId, witness, present] of query(container, witnessProbeSql())) {
    void packageId
    witnesses[witness] = present === 't'
  }

  return {
    witnesses,
    memberships: query(container, MEMBERSHIP_PROBE_SQL).map((r) => r.join('|')),
    functionOwners: query(container, FUNCTION_OWNER_PROBE_SQL).map((r) => ({
      signature: r[0],
      schema: r[1],
      owner: r[2],
      securityDefiner: r[3] === 't',
      proconfig: r[4] ?? '',
      executeGrantees: r[5] ?? '',
    })),
    relationOwners: query(container, RELATION_OWNER_PROBE_SQL).map((r) => ({
      relation: r[0],
      kind: r[1],
      owner: r[2],
      rls: r[3] === 't',
      rlsForced: r[4] === 't',
    })),
    schemaAcls: query(container, SCHEMA_ACL_PROBE_SQL).map((r) => r.join('|')),
    schemaCreateResidual: query(container, SCHEMA_CREATE_RESIDUAL_PROBE_SQL).map((r) => r.join('|')),
    policies: query(container, POLICY_PROBE_SQL).map((r) => r.join('|')),
    tableGrants: query(container, TABLE_GRANT_PROBE_SQL).map((r) => r.join('|')),
    roleAttributes: query(container, ROLE_ATTRIBUTE_PROBE_SQL).map((r) => r.join('|')),
    triggers: query(container, TRIGGER_PROBE_SQL).map((r) => r.join('|')),
    sessionState: query(container, SESSION_STATE_PROBE_SQL).map((r) => r.join('|')),
  }
}

function packageStates(state: CatalogState): Record<string, string> {
  const classified = classifyAllPackages(state.witnesses)
  if (!classified.ok) throw new Error(`${classified.code}: ${classified.detail}`)
  return Object.fromEntries(classified.classifications.map((c) => [c.packageId, c.state]))
}

/** The witnessed state of ONE chain package, keyed by its T-id. */
function stateOf(state: CatalogState, packageId: string): string {
  const name = PACKAGE_NAME_OF[packageId]
  if (name === undefined) throw new Error(`unknown chain package ${packageId}`)
  const value = packageStates(state)[name]
  if (value === undefined) throw new Error(`no witnessed state for ${packageId} (${name})`)
  return value
}

/**
 * Membership rows that were NOT there before the chain ran.
 *
 * A DELTA and not an absolute count, because the post-bootstrap state already
 * holds `uellix_owner -> uellix_migrator WITH SET TRUE`, granted by the
 * installer, which is exactly the shape a leaked temporary elevation has. A
 * probe that counted "memberships in an elevatable role granted by postgres"
 * would report that permanent, designed row as a leak in every package — and
 * the first person to look would learn to ignore the number.
 *
 * The baseline is captured from the catalog after bootstrap, not declared here.
 */
function membershipDelta(state: CatalogState, baseline: readonly string[]): string[] {
  const before = new Set(baseline)
  return state.memberships.filter((row) => !before.has(row) && !isExpectedAutomaticRow(row))
}

/**
 * The row PostgreSQL creates by itself, which is not a leak and must not be
 * counted as one.
 *
 * MEASURED (17.6, createrole_self_grant empty): when the installer creates a
 * capability role, the server grants it membership WITH ADMIN OPTION and
 * nothing else, and records the BOOTSTRAP SUPERUSER as the grantor rather than
 * the creating role. `pg_has_role(installer, capability, 'SET')` stays FALSE.
 * That is RR-02, it is unavoidable, and it is exactly the topology E-04 pins —
 * so the residual probe recognises it instead of reporting three leaks per
 * chain and training a reviewer to ignore the number.
 *
 * The recognition is EXACT. admin=t, inherit=f, set=f, member = the installer.
 * The same row with set=t is a different fact and is still a leak.
 */
function isExpectedAutomaticRow(row: string): boolean {
  const [role, member, , admin, inherit, set] = row.split('|')
  return (
    role.startsWith('uellix_cap_') &&
    member === CHAIN_INSTALLER_ROLE &&
    admin === 't' &&
    inherit === 'f' &&
    set === 'f'
  )
}

/**
 * Schema CREATE grants that were not held before the chain ran, EXCLUDING the
 * schema's own owner.
 *
 * A schema's owner holds CREATE on it inherently — `acldefault('n', owner)`
 * contains it, and no statement granted it. Counting that would report every
 * schema the chain creates as a residual temporary grant, which is the opposite
 * of what section 13 asks.
 */
function schemaCreateDelta(
  state: CatalogState,
  baseline: readonly string[],
  ownerOf: ReadonlyMap<string, string>,
): string[] {
  const before = new Set(baseline)
  return state.schemaCreateResidual.filter((row) => {
    if (before.has(row)) return false
    const [schema, grantee] = row.split('|')
    return ownerOf.get(schema) !== grantee
  })
}

/** `schema -> owner`, from the ACL probe. */
function schemaOwners(state: CatalogState): Map<string, string> {
  return new Map(state.schemaAcls.map((row) => {
    const [schema, owner] = row.split('|')
    return [schema, owner] as const
  }))
}

/* -------------------------------------------------------------------------- */
/* Provisioning                                                                */
/* -------------------------------------------------------------------------- */

interface ProvisionOutcome {
  readonly baselineApplied: number
  readonly baselineTotal: number
  readonly baselineFailures: readonly { unit: string; error: string }[]
  readonly bootstrapApplied: boolean
  readonly bootstrapError: string | null
  readonly measuredClassC: Record<string, string>
  /** The prerequisite stella_hosted_0001 refuses to mint for itself. */
  readonly sentinelWritten: boolean
  readonly prechainAdministrative: {
    readonly appliedAs: string
    readonly allApplied: boolean
    readonly units: readonly {
      readonly packageId: string
      readonly digest: string
      readonly exitStatus: number | null
      readonly error: string | null
      readonly inHostedChain: false
    }[]
    readonly inHostedChain: false
  }
  /** What T1 said when the sentinel was still absent. `null` means it APPLIED. */
  readonly sentinelRefusalBeforeWrite: string | null
}

function provision(container: string): ProvisionOutcome {
  // The shim goes in as the SUPERUSER because schema `storage` belongs to
  // supabase_admin and the installer cannot create in it. That refusal is the
  // measurement; the shim is what lets the run continue past it.
  const shim = applySql(container, STORAGE_SHIM_SQL, 'supabase_admin')
  if (shim.status !== 0) throw new Error(`storage shim failed: ${shim.stderr.trim()}`)

  // Class-C facts, MEASURED on this engine rather than assumed from the
  // manifest's prose. Recorded whichever way they come out.
  const measuredClassC: Record<string, string> = Object.fromEntries(
    query(
      container,
      `SET search_path = '';
       SELECT 'postgres_can_create_in_auth', has_schema_privilege('postgres','auth','CREATE')::text
       UNION ALL SELECT 'postgres_can_create_in_storage', has_schema_privilege('postgres','storage','CREATE')::text
       UNION ALL SELECT 'postgres_has_trigger_on_auth_users', has_table_privilege('postgres','auth.users','TRIGGER')::text
       UNION ALL SELECT 'auth_users_owner', (SELECT pg_get_userbyid(relowner) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth' AND c.relname='users')
       UNION ALL SELECT 'auth_schema_owner', (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='auth')
       UNION ALL SELECT 'postgres_is_superuser', (SELECT rolsuper::text FROM pg_roles WHERE rolname='postgres');`,
    ).map((r) => [r[0], r[1]]),
  )

  const failures: { unit: string; error: string }[] = []
  let applied = 0
  for (const unit of BASELINE_UNITS) {
    const sql = readFileSync(path.join(ROOT, unit.file), 'utf8')
    const result = applySql(container, sql)
    if (result.status === 0) {
      applied += 1
      continue
    }
    failures.push({
      unit: unit.id,
      error: diagnosticLines(result.stderr, 2),
    })
  }

  let bootstrapApplied = false
  let bootstrapError: string | null = null
  let sentinelWritten = false
  let sentinelRefusalBeforeWrite: string | null = null
  let ownershipReconciled = false
  const prechainAdmin: {
    packageId: string
    digest: string
    exitStatus: number | null
    error: string | null
    inHostedChain: false
  }[] = []
  if (failures.length === 0) {
    const bootstrapSql = readFileSync(hostedArtefactPath(BOOTSTRAP_ARTEFACT, ROOT), 'utf8')
    const result = applySql(container, `${BOOTSTRAP_ENVIRONMENT_SETTING}\n${bootstrapSql}`)
    bootstrapApplied = result.status === 0
    if (!bootstrapApplied) {
      bootstrapError = diagnosticLines(result.stderr)
    }
  }

  if (bootstrapApplied) {
    // NEGATIVE CASE FIRST. The sentinel is the one prerequisite the bootstrap
    // deliberately does not write, so before writing it the chain must refuse.
    // Measured rather than assumed: if T1 applied here, the sentinel would not
    // be gating anything and the whole declaration would be decorative.
    const t1 = resolveGovernedInput('T1', ROOT)
    const withoutSentinel = applyPackageSql(container, t1.sql)
    sentinelRefusalBeforeWrite =
      withoutSentinel.status === 0
        ? null
        : diagnosticLines(withoutSentinel.stderr, 2)

    // The migrator's credential, provisioned before anything is applied AS it.
    const login = applySql(container, MIGRATOR_LOGIN_SQL)
    if (login.status !== 0) throw new Error(`migrator login setup failed: ${login.stderr.trim()}`)

    const sentinel = applySql(container, STAGING_SENTINEL_SQL)
    sentinelWritten = sentinel.status === 0
    if (!sentinelWritten) bootstrapError = `sentinel: ${sentinel.stderr.trim()}`

    // M-2. THE PRECHAIN OWNERSHIP RECONCILIATION, and the identity it runs
    // under is the whole point of it being here rather than in the chain.
    //
    // `applySql` is the UNRESTRICTED path — the one that applied the baseline
    // units, i.e. `postgres`. The chain below runs through `applyPackageSql`,
    // which is `uellix_migrator`. This package must use the first because the
    // baseline units left the Storage helpers owned by the role that created
    // them, and `ALTER FUNCTION … OWNER TO` requires membership in the CURRENT
    // owner. Running it on the migrator path is not a stricter version of the
    // same thing; it is impossible, which is exactly what T11 refusing at 10/11
    // measured before this package existed.
    //
    // Pinned before it is applied, for the same reason every governed input is:
    // a byte change here would otherwise certify a file nobody reviewed.
    // BOTH units, IN ORDER. The second refuses unless the first has run — its
    // §0.4 requires a SECURITY DEFINER helper already owned by uellix_owner —
    // so the sequence is enforced by the packages rather than by this loop.
    for (const unit of PRECHAIN_ADMINISTRATIVE_UNITS) {
      const unitSql = readFileSync(path.join(ROOT, unit.sourceFile), 'utf8')
      const digest = sha256OfPreparedSql(unitSql)
      if (digest !== unit.sourceSha256) {
        throw new Error(
          `PRECHAIN_ADMIN_PIN_MISMATCH: ${unit.sourceFile} hashes to ${digest} and the ` +
            `registry pins ${unit.sourceSha256}.`,
        )
      }
      const applied = applySql(container, unitSql)
      prechainAdmin.push({
        packageId: unit.id,
        digest,
        exitStatus: applied.status,
        error: applied.status === 0 ? null : diagnosticLines(applied.stderr, 2),
        inHostedChain: false,
      })
      if (applied.status !== 0) {
        bootstrapError = `prechain ${unit.id}: ${diagnosticLines(applied.stderr, 2)}`
        break
      }
    }
    ownershipReconciled = prechainAdmin.every((u) => u.exitStatus === 0)
  }

  return {
    baselineApplied: applied,
    baselineTotal: BASELINE_UNITS.length,
    baselineFailures: failures,
    bootstrapApplied,
    bootstrapError,
    measuredClassC,
    sentinelWritten,
    sentinelRefusalBeforeWrite,
    prechainAdministrative: {
      appliedAs: 'administrative (unrestricted) — NOT the chain installer',
      allApplied: ownershipReconciled,
      units: prechainAdmin,
      inHostedChain: false,
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The chain                                                                   */
/* -------------------------------------------------------------------------- */

interface PackageResult {
  readonly packageId: string
  readonly sourcePath: string
  readonly digest: string
  readonly stateBefore: string
  readonly exitStatus: number
  readonly error: string | null
  readonly stateAfter: string
  readonly temporaryMembershipsAfter: readonly string[]
  readonly schemaCreateResidualAfter: readonly string[]
  readonly providerMembershipsUnchanged: boolean
  readonly sessionStateAfter: readonly string[]
}

/**
 * The provider's own membership rows.
 *
 * Told apart by GRANTOR (lab M2), and with the RR-02 automatic rows excluded:
 * those carry the bootstrap superuser as grantor and would otherwise read as
 * the provider's topology drifting every time the chain creates a role.
 */
const providerRows = (state: CatalogState): string[] =>
  state.memberships.filter((row) => {
    const [, , grantor] = row.split('|')
    return grantor !== 'postgres' && grantor !== CHAIN_INSTALLER_ROLE && !isExpectedAutomaticRow(row)
  })

function applyChain(
  container: string,
  inputs: readonly ResolvedGovernedInput[],
  onPackage?: (input: ResolvedGovernedInput, after: CatalogState) => void,
): { results: PackageResult[]; finalState: CatalogState } {
  let state = observe(container)
  const providerBaseline = providerRows(state)
  const membershipBaseline = state.memberships
  const schemaCreateBaseline = state.schemaCreateResidual
  const results: PackageResult[] = []

  for (const input of inputs) {
    const before = stateOf(state, input.packageId)
    console.log(`[cert] applying ${input.packageId}`)
    console.log(`[cert]   path   ${input.relativePath}`)
    console.log(`[cert]   digest ${input.actualDigest}`)
    console.log(`[cert]   state  ${before}`)

    const result = applyPackageSql(container, input.sql)
    state = observe(container)
    const after = stateOf(state, input.packageId)

    const record: PackageResult = {
      packageId: input.packageId,
      sourcePath: input.relativePath,
      digest: input.actualDigest,
      stateBefore: before,
      exitStatus: result.status,
      error: result.status === 0 ? null : diagnosticLines(result.stderr),
      stateAfter: after,
      temporaryMembershipsAfter: membershipDelta(state, membershipBaseline),
      schemaCreateResidualAfter: schemaCreateDelta(state, schemaCreateBaseline, schemaOwners(state)),
      providerMembershipsUnchanged:
        JSON.stringify(providerRows(state)) === JSON.stringify(providerBaseline),
      sessionStateAfter: state.sessionState,
    }
    results.push(record)

    console.log(
      `[cert]   exit=${record.exitStatus} state=${record.stateAfter} ` +
        `tempMemberships=${record.temporaryMembershipsAfter.length} ` +
        `tempCreate=${record.schemaCreateResidualAfter.length} ` +
        `provider=${record.providerMembershipsUnchanged ? 'unchanged' : 'DRIFTED'}`,
    )

    onPackage?.(input, state)

    if (record.exitStatus !== 0 || record.stateAfter !== 'INSTALLED') {
      console.log(`[cert]   STOPPING: ${input.packageId} did not install cleanly.`)
      break
    }
  }

  return { results, finalState: state }
}

/* -------------------------------------------------------------------------- */
/* Failure injection                                                           */
/* -------------------------------------------------------------------------- */

interface InjectionResult {
  readonly id: string
  readonly description: string
  readonly packageId: string
  readonly failed: boolean
  readonly sqlstateSeen: string | null
  readonly rolledBack: boolean
  readonly stateAfter: string
  readonly temporaryMembershipsAfter: readonly string[]
  readonly schemaCreateResidualAfter: readonly string[]
  readonly ownershipRestored: boolean
  readonly providerMembershipsUnchanged: boolean
  readonly priorPackagesIntact: boolean
}

function runInjection(
  injection: FailureInjection,
  snapshotImage: string,
  prefixInputs: readonly ResolvedGovernedInput[],
): InjectionResult {
  const container = startContainer(`inj-${injection.id.toLowerCase()}`, snapshotImage)
  try {
    // Bring the instance up to the package under test, using the pinned bytes.
    for (const input of prefixInputs) {
      const r = applyPackageSql(container, input.sql)
      if (r.status !== 0) throw new Error(`${injection.id}: prefix ${input.packageId} failed: ${r.stderr}`)
    }

    const before = observe(container)
    const target = resolveGovernedInput(injection.packageId, ROOT)
    const mutated = injectFailure(target.sql, injection)

    const result = applyPackageSql(container, mutated)
    const after = observe(container)

    // EVERY package, not only the prefix this container applied: a snapshot
    // carries the ones applied before it, and "the packages already committed
    // are still committed" is the claim being checked.
    const priorStatesBefore = packageStates(before)
    const priorStatesAfter = packageStates(after)
    const priorIntact =
      JSON.stringify(priorStatesBefore) === JSON.stringify(priorStatesAfter) ||
      Object.entries(priorStatesBefore).every(
        ([id, s]) => s !== 'INSTALLED' || priorStatesAfter[id] === 'INSTALLED',
      )

    const ownersBefore = JSON.stringify(before.functionOwners)
    const ownersAfter = JSON.stringify(after.functionOwners)

    return {
      id: injection.id,
      description: injection.description,
      packageId: injection.packageId,
      failed: result.status !== 0,
      // Whether the chosen failure point was REACHED at all. An injection that
      // sits behind an earlier blocker still makes the package fail, and
      // recording that as a passing rollback test would be counting a failure
      // nobody arranged as evidence about one that was.
      sqlstateSeen: /UELLIX_CERT_INJECTED_FAILURE/.test(result.stderr) ? 'injected' : 'NOT_REACHED',
      rolledBack: stateOf(after, injection.packageId) === stateOf(before, injection.packageId),
      stateAfter: stateOf(after, injection.packageId),
      // Against the state the container was in BEFORE the doomed apply, which
      // is the only baseline that answers "did this apply leave anything".
      temporaryMembershipsAfter: membershipDelta(after, before.memberships),
      schemaCreateResidualAfter: schemaCreateDelta(after, before.schemaCreateResidual, schemaOwners(after)),
      ownershipRestored: ownersBefore === ownersAfter,
      providerMembershipsUnchanged:
        JSON.stringify(providerRows(after)) === JSON.stringify(providerRows(before)),
      priorPackagesIntact: priorIntact,
    }
  } finally {
    if (!KEEP) destroyContainer(`inj-${injection.id.toLowerCase()}`)
  }
}

/* -------------------------------------------------------------------------- */
/* Refusal exercises — sections 21 and 22                                      */
/* -------------------------------------------------------------------------- */
//
// F-1. These used to be re-implemented HERE, and the offline suite tested a
// second copy of them in tests/hosted/authority/engine-certification.test.ts.
// The two drifted: the fixture derived its unknown-package sentinel from the
// chain, this file spelled it `'T10'`, and M-8 made T10 real. The executed
// probe resolved, recorded `refused=false`, and the run reported COMPLETE
// anyway.
//
// There is now one implementation, in
// db/hosted/authority/certification/refusal-exercises.ts, and the tests
// exercise the same function this script calls.

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

function main(): number {
  const report: Record<string, unknown> = {
    mode: 'CERTIFICATION',
    image: CERTIFICATION_IMAGE,
    shims: LAB_SHIMS,
    faithfulSurface: LAB_FAITHFUL_SURFACE,
  }

  console.log(`[cert] image ${CERTIFICATION_IMAGE}`)
  console.log(`[cert] run namespace ${RUN_NAMESPACE} — docker resources are scoped to ${PREFIX}*`)
  console.log(`[cert] resolving governed inputs (no glob, no basename fallback)`)
  const inputs = GOVERNED_CERTIFICATION_INPUTS.map((i) => resolveGovernedInput(i.packageId, ROOT))
  report.inputs = inputs.map((i) => ({ packageId: i.packageId, path: i.relativePath, digest: i.actualDigest }))
  for (const i of inputs) console.log(`[cert]   ${i.packageId} ${i.relativePath} ${i.actualDigest}`)

  // Recorded AND printed. The defect these closed was invisible in a 4 000-line
  // artefact and would have been one line on a terminal.
  const refusals = refusalExercises(ROOT)
  report.refusals = refusals
  for (const r of refusals) {
    console.log(`[cert] refusal ${r.id} refused=${r.refused} code=${r.code ?? '-'} — ${r.attempted}`)
  }

  const primary = startContainer('primary')

  const identity = Object.fromEntries(
    query(primary, ENGINE_IDENTITY_PROBE_SQL).flatMap((r) => [
      ['server_version', r[0]],
      ['server_version_num', r[1]],
      ['createrole_self_grant', r[2] ?? ''],
      ['installer_is_superuser', r[3]],
      ['installer', r[4]],
    ]),
  )
  report.engine = identity
  console.log(`[cert] engine ${JSON.stringify(identity)}`)

  if (
    identity.server_version !== EXPECTED_SERVER_VERSION ||
    identity.server_version_num !== EXPECTED_SERVER_VERSION_NUM ||
    (identity.createrole_self_grant ?? '') !== EXPECTED_CREATEROLE_SELF_GRANT
  ) {
    throw new Error(`engine identity mismatch: ${JSON.stringify(identity)}`)
  }

  console.log('[cert] provisioning baseline + bootstrap')
  const provisioned = provision(primary)
  report.provisioning = provisioned
  console.log(
    `[cert]   baseline ${provisioned.baselineApplied}/${provisioned.baselineTotal}, ` +
      `bootstrap ${provisioned.bootstrapApplied ? 'PASS' : 'FAIL'}`,
  )
  for (const f of provisioned.baselineFailures) console.log(`[cert]   FAILED ${f.unit}: ${f.error}`)
  if (provisioned.bootstrapError) console.log(`[cert]   bootstrap: ${provisioned.bootstrapError}`)
  // Only meaningful when the bootstrap committed: with no bootstrap there is no
  // sentinel table to be absent from, and reporting "APPLIED" for a probe that
  // never ran would be the harness inventing a result.
  if (provisioned.bootstrapApplied) {
    console.log(
      `[cert]   sentinel written=${provisioned.sentinelWritten}; T1 without it: ` +
        `${provisioned.sentinelRefusalBeforeWrite === null ? 'APPLIED (the sentinel gates nothing!)' : 'REFUSED'}`,
    )
  }
  if (provisioned.sentinelRefusalBeforeWrite !== null) {
    console.log(`[cert]     ${provisioned.sentinelRefusalBeforeWrite}`)
  }

  // Captured rather than only branched on: these are three of the six
  // predicates COMPLETE is a conjunction of, and the artefact records the whole
  // conjunction beside the verdict it produced.
  const provisioningComplete =
    provisioned.baselineFailures.length === 0 &&
    provisioned.bootstrapApplied &&
    provisioned.sentinelWritten
  if (!provisioningComplete) {
    report.verdict = 'PROVISIONING_FAILED'
    writeReport(report)
    return 1
  }

  const prechain = observe(primary)
  const prechainStates = packageStates(prechain)
  report.prechain = {
    packageStates: prechainStates,
    memberships: prechain.memberships,
    schemaCreateResidual: prechain.schemaCreateResidual,
    relationOwners: prechain.relationOwners,
    roleAttributes: prechain.roleAttributes,
  }
  const prechainClean = Object.values(prechainStates).every((s) => s === 'ABSENT')
  console.log(`[cert] PRECHAIN ${prechainClean ? 'CLEAN' : 'INVALID'} — ${JSON.stringify(prechainStates)}`)
  if (!prechainClean) {
    report.verdict = 'PRECHAIN_INVALID'
    writeReport(report)
    return 1
  }

  /* THE PRECHAIN AUTHORITY GATE (Commit 5.1).
   *
   * Before a single governed statement runs. E-01, E-02 and E-04 were each
   * found from inside T1, one statement at a time, after everything before them
   * had already executed in the transaction. This asks the whole question up
   * front, from the catalog, against a contract DERIVED from the same plan the
   * generator uses — so a package that starts depending on a new baseline object
   * is gated without anybody editing a list. */
  const contracts = collapseByObject(derivePrechainRequirements(ROOT))
  const prechainObservation = JSON.parse(
    query(primary, prechainObservationSql(
      contracts.map((c) => ({ object: c.object, objectType: c.objectType, privileges: c.privilegeNames })),
    ))[0][0],
  ) as PrechainObservation
  const gateRefusals = validateHostedPrechainAuthorityContract(prechainObservation, contracts)
  const prechainAuthorityGatePassed = gateRefusals.length === 0
  report.prechainAuthorityGate = {
    contracts,
    observation: prechainObservation,
    refusals: gateRefusals,
    verdict: prechainAuthorityGatePassed ? 'PASS' : 'FAIL',
  }
  console.log(
    `[cert] PRECHAIN_AUTHORITY_GATE ${gateRefusals.length === 0 ? 'PASS' : 'FAIL'} — ` +
      `${contracts.length} object contract(s), ${gateRefusals.length} refusal(s)`,
  )
  for (const refusal of gateRefusals) console.log(`[cert]   ${refusal.code}: ${refusal.detail}`)
  if (gateRefusals.length > 0) {
    report.verdict = 'PRECHAIN_AUTHORITY_GATE_FAILED'
    writeReport(report)
    return 1
  }

  const bootstrapSnapshot = snapshotContainer(primary, 'bootstrap')

  /* E-02, measured on a DISPOSABLE copy so the primary stays PRECHAIN-clean.
   * A contract naming one permitted identity is only a contract if the other
   * one still fails, so both are tried and both results are recorded. */
  const installerProbe = CANDIDATE_INSTALLERS.map((installer) => {
    const probeContainer = startContainer(`installer-${installer.replace(/_/g, '-')}`, bootstrapSnapshot)
    try {
      const t1 = resolveGovernedInput('T1', ROOT)
      const attempt = applyPackageSql(probeContainer, t1.sql, installer)
      const after = observe(probeContainer)
      return {
        installer,
        applied: attempt.status === 0,
        firstRefusal: attempt.status === 0 ? null : diagnosticLines(attempt.stderr, 3),
        leftT1: stateOf(after, 'T1'),
      }
    } finally {
      if (!KEEP) destroyContainer(`installer-${installer.replace(/_/g, '-')}`)
    }
  })
  report.installerProbe = installerProbe
  for (const probe of installerProbe) {
    console.log(`[cert] installer ${probe.installer}: applied=${probe.applied} T1=${probe.leftT1}`)
    if (probe.firstRefusal) console.log(`[cert]     ${probe.firstRefusal}`)
  }

  /* THE UNGOVERNED ARTEFACT, ON THE ENGINE (Commit 5.5).
   *
   * Section 22 of the brief already proves the RESOLVER refuses
   * `db/prepared/hosted/<pkg>.hosted.sql` before any SQL is read. That is a
   * statement about this harness, and staging proved it was not a statement
   * about the operator: the chain CLI formatted that path itself, the operator
   * ran it, and T1 died at
   *
   *   grounding_0002_document_versions.hosted.sql:915
   *   ERROR:  permission denied for schema uellix_grounding
   *
   * So the failure is reproduced HERE, on the engine, as the managed
   * non-superuser installer — the same file, the same psql flags — and the
   * rollback it leaves behind is measured rather than assumed. Run on a
   * disposable copy so the primary stays PRECHAIN-clean. */
  const ungovernedProbe = (() => {
    const name = 'ungoverned-t1'
    const container = startContainer(name, bootstrapSnapshot)
    try {
      const relativePath = 'db/prepared/hosted/grounding_0002_document_versions.hosted.sql'
      const sql = readFileSync(path.join(ROOT, relativePath), 'utf8')
      const attempt = applyPackageSql(container, sql)
      const after = observe(container)
      return {
        relativePath,
        installer: INSTALLER,
        exitStatus: attempt.status,
        firstRefusal: attempt.status === 0 ? null : diagnosticLines(attempt.stderr, 3),
        permissionDeniedOnOwnerSchema: /permission denied for schema uellix_grounding/.test(
          attempt.stderr,
        ),
        t1StateAfter: stateOf(after, 'T1'),
        temporaryMembershipsAfter: membershipDelta(after, prechain.memberships).length,
        schemaCreateResidualAfter: schemaCreateDelta(
          after,
          prechain.schemaCreateResidual,
          schemaOwners(after),
        ).length,
      }
    } finally {
      if (!KEEP) destroyContainer(name)
    }
  })()
  report.ungovernedArtefactProbe = ungovernedProbe
  console.log(
    `[cert] UNGOVERNED_ARTEFACT_ENGINE exit=${ungovernedProbe.exitStatus} ` +
      `permissionDenied=${ungovernedProbe.permissionDeniedOnOwnerSchema} ` +
      `T1=${ungovernedProbe.t1StateAfter} ` +
      `tempMemberships=${ungovernedProbe.temporaryMembershipsAfter} ` +
      `tempCreate=${ungovernedProbe.schemaCreateResidualAfter}`,
  )
  if (ungovernedProbe.firstRefusal) console.log(`[cert]     ${ungovernedProbe.firstRefusal}`)

  if (ONLY === 'provision') {
    writeReport(report)
    return 0
  }

  // Snapshots are taken AFTER a package commits, and only where an injection
  // declares it needs one. DERIVED from FAILURE_INJECTIONS rather than listed:
  // a snapshot nobody asked for costs a container image, and an injection whose
  // snapshot nobody takes is SKIPPED — reported, but not measured.
  const SNAPSHOT_POINTS: readonly string[] = [
    ...new Set(FAILURE_INJECTIONS.map((i) => i.fromSnapshot).filter((s) => s !== 'bootstrap')),
  ]
  const snapshotAfter = new Map<string, string>()
  const { results, finalState } = applyChain(primary, inputs, (input) => {
    if (SNAPSHOT_POINTS.includes(input.packageId)) {
      snapshotAfter.set(input.packageId, snapshotContainer(primary, input.packageId.toLowerCase()))
    }
  })
  report.chain = results

  const chainComplete =
    results.length === inputs.length && results.every((r) => r.stateAfter === 'INSTALLED')
  console.log(
    `[cert] chain ${results.filter((r) => r.stateAfter === 'INSTALLED').length}/${inputs.length} installed`,
  )

  report.posture = {
    functionOwners: finalState.functionOwners,
    relationOwners: finalState.relationOwners,
    schemaAcls: finalState.schemaAcls,
    schemaCreateResidual: finalState.schemaCreateResidual,
    policies: finalState.policies,
    tableGrants: finalState.tableGrants,
    roleAttributes: finalState.roleAttributes,
    triggers: finalState.triggers,
    memberships: finalState.memberships,
    sessionState: finalState.sessionState,
  }

  /* Forward-only: a re-apply of an installed package must be refused by the
   * hosted workflow, not by the database. */
  report.forwardOnly = forwardOnlyExercise(finalState)

  /* M-2. THE FUNCTIONAL PROBE, and the reason it is not optional.
   *
   * Everything above measures INSTALLATION. T11 was recorded INSTALLED — the
   * function present, four roles in its body, owner and ACL unmoved, all three
   * storage policies intact — on a database where all nine cases of the role
   * matrix were refused, because uellix_owner could not SELECT
   * public.organization_members and the helper bodies swallow their own
   * permission error. No structural witness can see that.
   *
   * Run LAST, on the primary, after the chain: it writes fixture rows, and
   * nothing after it reads the primary's data. The failure injections that
   * follow work from snapshots taken DURING the chain, so they are unaffected.
   *
   * A throw here is recorded as a failure rather than aborting the run: a
   * certification that ends with no artefact because its own probe errored is
   * one nobody can audit. */
  const storageFunctional: StorageFunctionalResult = (() => {
    if (!chainComplete) {
      return storageFunctionalNotRun(
        'the chain did not complete, so there is no final managed shape to drive the policies on',
      )
    }
    try {
      const fixture = applySql(primary, STORAGE_FUNCTIONAL_FIXTURE_SQL)
      if (fixture.status !== 0) {
        return storageFunctionalNotRun(`the fixture failed to apply: ${diagnosticLines(fixture.stderr, 2)}`)
      }
      const rows = query(primary, STORAGE_FUNCTIONAL_MATRIX_SQL)
      if (rows.length !== 1 || rows[0][0] === undefined || rows[0][0].length === 0) {
        return storageFunctionalNotRun(
          `the matrix query returned ${rows.length} row(s) and it projects exactly one JSON document`,
        )
      }
      return evaluateStorageFunctionalProbe(JSON.parse(rows[0][0]) as StorageFunctionalObservation)
    } catch (error) {
      return storageFunctionalNotRun(
        `the probe raised: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })()
  report.storageFunctionalProbe = storageFunctional
  console.log(
    `[cert] STORAGE_FUNCTIONAL ran=${storageFunctional.ran} passed=${storageFunctional.passed} — ${storageFunctional.detail}`,
  )
  for (const m of storageFunctional.mismatches) {
    console.log(`[cert]   MISMATCH ${m.caseId}.${m.operation}: expected ${m.expected}, observed ${m.observed}`)
  }

  if (ONLY === 'chain') {
    report.verdict = chainComplete ? 'CHAIN_COMPLETE' : 'CHAIN_INCOMPLETE'
    writeReport(report)
    return chainComplete ? 0 : 1
  }

  // Injections run whether or not the chain completed. Package-level atomicity
  // is a property of the APPLY CONTRACT, not of a successful chain, and the
  // injections that sit before the first blocker measure it for real. Those
  // behind it are reported NOT_REACHED rather than quietly counted.
  console.log('[cert] failure injections')
  const injections: InjectionResult[] = []
  for (const injection of FAILURE_INJECTIONS) {
    const fromBootstrap = injection.fromSnapshot === 'bootstrap'
    const base = fromBootstrap ? bootstrapSnapshot : snapshotAfter.get(injection.fromSnapshot)
    if (base === undefined) {
      console.log(
        `[cert]   ${injection.id} SKIPPED: the chain never reached ${injection.fromSnapshot}, so there is no state to inject into`,
      )
      injections.push({
        id: injection.id,
        description: injection.description,
        packageId: injection.packageId,
        failed: false,
        sqlstateSeen: 'SKIPPED_NO_PREREQUISITE_STATE',
        rolledBack: false,
        stateAfter: 'UNKNOWN',
        temporaryMembershipsAfter: [],
        schemaCreateResidualAfter: [],
        ownershipRestored: false,
        providerMembershipsUnchanged: false,
        priorPackagesIntact: false,
      })
      continue
    }
    // How many packages the snapshot ALREADY carries, derived from the chain
    // rather than counted by hand. It was the literal `7` for T7, which is the
    // kind of constant that is right until a second snapshot point exists and
    // then silently re-applies nine packages over a database that has them.
    const prefix = inputs.slice(0, inputs.findIndex((i) => i.packageId === injection.packageId))
    const carried = fromBootstrap
      ? 0
      : inputs.findIndex((i) => i.packageId === injection.fromSnapshot) + 1
    const result = runInjection(injection, base, prefix.slice(carried))
    injections.push(result)
    console.log(
      `[cert]   ${result.id} failed=${result.failed} rolledBack=${result.rolledBack} ` +
        `tempMem=${result.temporaryMembershipsAfter.length} tempCreate=${result.schemaCreateResidualAfter.length} ` +
        `owners=${result.ownershipRestored ? 'restored' : 'DRIFTED'} prior=${result.priorPackagesIntact ? 'intact' : 'DAMAGED'}`,
    )
  }
  report.injections = injections

  /* THE VERDICT (F-1).
   *
   * It used to be `chainComplete ? 'COMPLETE' : ...` and nothing else. The
   * refusal exercises and the failure injections were recorded next to it and
   * gated NOTHING, so the run that first met a resolving unknown-package probe
   * wrote `"refused": false` and `"verdict": "COMPLETE"` into the same tracked
   * artefact. A negative control that cannot fail the run is decoration.
   *
   * Now COMPLETE is the conjunction, computed by a pure function so that "a
   * resolving unknown package makes COMPLETE impossible" is a test that runs
   * without Docker — and the whole predicate set is written down beside the
   * verdict, because a verdict that does not say what it required cannot be
   * audited for the thing that went wrong here. */
  const evidence: CertificationEvidence = {
    provisioningComplete,
    prechainClean,
    prechainAuthorityGatePassed,
    chainComplete,
    storageFunctionalProbe: {
      ran: storageFunctional.ran,
      passed: storageFunctional.passed,
      detail: storageFunctional.detail,
    },
    refusals,
    injections,
  }
  const predicates = certificationPredicates(evidence)
  report.requiredPredicates = predicates
  report.verdict = DIAGNOSTIC ? 'DIAGNOSTIC_ONLY_NOT_CERTIFICATION' : certificationVerdict(evidence)

  for (const p of predicates) {
    console.log(`[cert] ${p.holds ? 'HOLDS  ' : 'FAILED '} ${p.id} — ${p.detail}`)
  }
  console.log(`[cert] VERDICT ${String(report.verdict)}`)

  writeReport(report)
  // Aligned with the verdict, as the three earlier gates already are. The
  // artefact remains the evidence — this only stops `certify && something-else`
  // from continuing past a run that did not certify.
  return report.verdict === 'COMPLETE' ? 0 : 1
}

/**
 * Section 20. The DATABASE may or may not tolerate a repeated DDL; that is not
 * the contract. The contract is that the hosted workflow refuses to PLAN a
 * package it has just observed installed.
 */
function forwardOnlyExercise(state: CatalogState): unknown {
  const classified = classifyAllPackages(state.witnesses)
  if (!classified.ok) return { ok: false, detail: classified.detail }
  const installed = classified.classifications.filter((c) => c.state === 'INSTALLED').map((c) => c.packageId)
  return {
    observedInstalled: installed,
    policy: 'forward-only',
    installedPackageAction: 'refuse',
    note:
      `All ${installed.length} of the ${CHAIN_PACKAGE_FILES.length} declared packages are observed ` +
      'INSTALLED from the catalog, so nextChainPackage has no candidate left and any plan naming ' +
      'one of them is refused. Exercised as a contract test in ' +
      'tests/hosted/authority/engine-certification.test.ts rather than by re-applying SQL here: ' +
      're-applying to find out would be the very thing the contract forbids.',
  }
}

function writeReport(report: Record<string, unknown>): void {
  // F-4. The run token names containers and images; it is not a fact about the
  // database, and this artefact is TRACKED. A pid reaching it would put a diff
  // in every run, reviewers would learn the diff is noise, and the one run
  // whose content actually changed would go unread. Enforced on the way to
  // disk rather than reasoned about at each field.
  assertRunNamespaceAbsent(report, RUN_NAMESPACE)

  // A diagnostic run writes a DIFFERENT file. Overwriting the certification
  // artefact with a run that patched the environment is the one way this
  // harness could produce a green record of something it never certified.
  const artefact = DIAGNOSTIC ? ARTEFACT_DIAGNOSTIC : ARTEFACT_CERTIFICATION
  mkdirSync(path.join(ROOT, path.dirname(artefact)), { recursive: true })
  writeFileSync(path.join(ROOT, artefact), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`[cert] recorded: ${artefact}`)
}

let code = 1
try {
  code = main()
} catch (error) {
  console.error(`[cert] ABORTED: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (KEEP) {
    console.log(`[cert] --keep: ${[...live].join(', ') || 'no containers'} left running`)
  } else {
    teardown()
    console.log(
      `[cert] teardown complete: 0 containers and 0 snapshot images left by run ${RUN_NAMESPACE}. ` +
        'Resources belonging to any other run were not touched.',
    )
  }
}
process.exit(code)
