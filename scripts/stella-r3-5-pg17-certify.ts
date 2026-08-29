// scripts/stella-r3-5-pg17-certify.ts
//
// Closed, disposable MSC-07B R3.5 certification executor. It is intentionally
// not a database runner: there is one profile, one local image, one container,
// one package prefix, and no caller-selected operational value.

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BASELINE_UNITS } from '../db/hosted/baseline-manifest'
import { sha256OfSql } from '../db/hosted/hosted-package-manifest'
import {
  EXPECTED_SERVER_VERSION_NUM,
  STORAGE_SHIM_SQL,
} from '../db/hosted/authority/certification/lab-environment'
import {
  assertR3_5Pg17CertificationImageId,
  assertR3_5Pg17CertificationSourceHashes,
  collectR3_5Pg17CertificationSourceHashes,
  R3_5_PG17_CERTIFICATION_CONTAINER,
  R3_5_PG17_CERTIFICATION_IMAGE,
  R3_5_PG17_CERTIFICATION_OWNER_LABEL,
  R3_5_PG17_CERTIFICATION_OWNER_VALUE,
  R3_5_PG17_CERTIFICATION_PACKAGE_HASHES,
  R3_5_PG17_CERTIFICATION_PHASES,
  type R3_5Pg17CertificationSourceFile,
} from '../db/r3-5-pg17-certification-inputs'
import type { R3_4LocalPhase } from '../db/r3-4-governed-runner'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..')
const PREPARED_DIRECTORY = resolve(REPOSITORY_ROOT, 'db', 'prepared')
const DATABASE_NAME = 'postgres'
const ADMIN_ROLE = 'postgres'
const MIGRATOR_ROLE = 'uellix_migrator'
const OWNER_ROLE = 'uellix_owner'
const APP_ROLE = 'uellix_app'
const INTERNAL_POSTGRES_HOST = '127.0.0.1'
/**
 * Container-local superuser identity, reached only over the container-local
 * Unix socket (no -h, no password): the storage shim, the two superuser-only
 * Stella phases (stella_0001, stella_0004 — see SUPERUSER_PHASE_FILES below),
 * and both governed rollback phases that require it. Never exposed as a
 * caller-selectable role — see runSuperuserPsql.
 *
 * ADMIN_ROLE ('postgres') remains the identity for the pre-existing installer
 * transport (baseline-50, 0002, 0002b) and MIGRATOR_ROLE for 0003; this role
 * is additive, not a replacement for either.
 */
const SUPERUSER_ROLE = 'supabase_admin'
const MATRIX_ERROR = 'R3.5 PG17 certification matrix assertion failed'

/**
 * The exact, closed set of Stella package files that MUST run through the
 * container-local superuser transport because their own SQL requires a
 * superuser session (stella_0001's rollback dependency guard checks
 * `session_user` rolsuper; stella_0004 requires `current_user` rolsuper — see
 * their DO $$ preconditions). Every other phase keeps the pre-existing
 * postgres/migrator installer transport. A single dispatcher
 * (applyCertificationPhase) reads this set so the initial application and the
 * idempotence re-application can never disagree about a phase's identity.
 */
const SUPERUSER_PHASE_FILES: ReadonlySet<string> = Object.freeze(
  new Set(['stella_0001_role_topology_bootstrap.sql', 'stella_0004_role_separation.sql']),
)

/**
 * The certified substrate's OID-10 role name. Package grantor authority is,
 * and remains, the fixed bootstrap-superuser OID (10) — never this name. This
 * constant binds only the HARNESS's live-substrate preflight and superuser
 * transport to the one image this profile is certified against; it is never
 * read by verifyExactMembershipsAndGrantor's comparison logic.
 */
const CERTIFIED_SUBSTRATE_OID10_ROLE_NAME = SUPERUSER_ROLE

/** The exact, stable failure text stella_0001's rollback dependency guard raises when a later package's ownership transfer still survives. Read directly from db/prepared/stella_0001_role_topology_bootstrap_rollback.sql — never a generic non-zero exit. */
const DEPENDENCY_GUARD_FAILURE_PATTERN =
  /stella_0001 rollback REFUSED: surviving relation\(s\) depend on governed ownership/

/**
 * The exact, stable PostgreSQL error text (SQLSTATE 22012) for the atomicity
 * exercise's deliberately injected `SELECT 1 / 0;` — the one failure this
 * witness must prove was actually reached. A non-zero exit alone is not
 * proof: if the real decisionSource fails earlier (e.g. a permission error),
 * the injected statement is never executed, the transaction still aborts
 * non-zero, and the decision table still never exists — falsely satisfying
 * both halves of verifyAtomicity's proof without the intended failure ever
 * being reached. Never a generic non-zero exit.
 */
const ATOMICITY_INJECTED_FAILURE_PATTERN = /division by zero/

type CertificationTransportKind = 'CONTAINER_LOCAL_SOCKET' | 'EXISTING_INSTALLER_TRANSPORT'

interface CertificationPhaseIdentity {
  readonly phaseId:
    | 'STORAGE_SHIM'
    | 'BASELINE_50'
    | '0002'
    | '0002B'
    | '0001'
    | '0003'
    | '0004'
    | '0004_ROLLBACK'
    | '0001_ROLLBACK_DEPENDENCY_NEGATIVE'
  readonly identity: string
  readonly transport: CertificationTransportKind
  readonly superuserRequired: boolean
  readonly rollbackConfirmationRequired: boolean
}

function frozenPhaseIdentity(row: CertificationPhaseIdentity): CertificationPhaseIdentity {
  return Object.freeze(row)
}

/**
 * The closed, testable certification phase-identity contract required by
 * MSC-07B.8-R8N. No caller can alter this matrix (deep-frozen), and no
 * abstract 'admin' identity is inferred from it — every phase's concrete
 * login identity, transport and superuser/rollback-confirmation requirement
 * is stated explicitly.
 */
export const R3_5_PG17_CERTIFICATION_PHASE_IDENTITY_MATRIX: readonly CertificationPhaseIdentity[] = Object.freeze([
  frozenPhaseIdentity({
    phaseId: 'STORAGE_SHIM',
    identity: SUPERUSER_ROLE,
    transport: 'CONTAINER_LOCAL_SOCKET',
    superuserRequired: true,
    rollbackConfirmationRequired: false,
  }),
  frozenPhaseIdentity({
    phaseId: 'BASELINE_50',
    identity: 'postgres',
    transport: 'EXISTING_INSTALLER_TRANSPORT',
    superuserRequired: false,
    rollbackConfirmationRequired: false,
  }),
  frozenPhaseIdentity({
    phaseId: '0002',
    identity: 'postgres',
    transport: 'EXISTING_INSTALLER_TRANSPORT',
    superuserRequired: false,
    rollbackConfirmationRequired: false,
  }),
  frozenPhaseIdentity({
    phaseId: '0002B',
    identity: 'postgres',
    transport: 'EXISTING_INSTALLER_TRANSPORT',
    superuserRequired: false,
    rollbackConfirmationRequired: false,
  }),
  frozenPhaseIdentity({
    phaseId: '0001',
    identity: SUPERUSER_ROLE,
    transport: 'CONTAINER_LOCAL_SOCKET',
    superuserRequired: true,
    rollbackConfirmationRequired: false,
  }),
  frozenPhaseIdentity({
    phaseId: '0003',
    identity: 'uellix_migrator',
    transport: 'EXISTING_INSTALLER_TRANSPORT',
    superuserRequired: false,
    rollbackConfirmationRequired: false,
  }),
  frozenPhaseIdentity({
    phaseId: '0004',
    identity: SUPERUSER_ROLE,
    transport: 'CONTAINER_LOCAL_SOCKET',
    superuserRequired: true,
    rollbackConfirmationRequired: false,
  }),
  frozenPhaseIdentity({
    phaseId: '0004_ROLLBACK',
    identity: SUPERUSER_ROLE,
    transport: 'CONTAINER_LOCAL_SOCKET',
    superuserRequired: true,
    rollbackConfirmationRequired: true,
  }),
  frozenPhaseIdentity({
    phaseId: '0001_ROLLBACK_DEPENDENCY_NEGATIVE',
    identity: SUPERUSER_ROLE,
    transport: 'CONTAINER_LOCAL_SOCKET',
    superuserRequired: true,
    rollbackConfirmationRequired: true,
  }),
])

type DockerCommandKind =
  | 'image-inspect'
  | 'preflight-container-absence'
  | 'create'
  | 'cleanup-owner-check'
  | 'cleanup-remove'

interface StaticDockerCommand {
  readonly kind: DockerCommandKind
  readonly args: readonly string[]
}

interface DockerResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

const STATIC_DOCKER_COMMANDS: readonly StaticDockerCommand[] = Object.freeze([
  Object.freeze({
    kind: 'image-inspect',
    args: Object.freeze(['image', 'inspect', '--format', '{{.Id}}', R3_5_PG17_CERTIFICATION_IMAGE]),
  }),
  Object.freeze({
    kind: 'preflight-container-absence',
    args: Object.freeze(['container', 'inspect', R3_5_PG17_CERTIFICATION_CONTAINER]),
  }),
  Object.freeze({
    kind: 'create',
    args: Object.freeze([
      'run',
      '-d',
      '--name',
      R3_5_PG17_CERTIFICATION_CONTAINER,
      '--label',
      `${R3_5_PG17_CERTIFICATION_OWNER_LABEL}=${R3_5_PG17_CERTIFICATION_OWNER_VALUE}`,
      '--network',
      'none',
      '--pull',
      'never',
      '-e',
      'POSTGRES_PASSWORD=<internally-generated>',
      R3_5_PG17_CERTIFICATION_IMAGE,
    ]),
  }),
  Object.freeze({
    kind: 'cleanup-owner-check',
    args: Object.freeze([
      'container',
      'inspect',
      '--format',
      `{{ index .Config.Labels "${R3_5_PG17_CERTIFICATION_OWNER_LABEL}" }}`,
      R3_5_PG17_CERTIFICATION_CONTAINER,
    ]),
  }),
  Object.freeze({
    kind: 'cleanup-remove',
    args: Object.freeze(['container', 'rm', '-f', R3_5_PG17_CERTIFICATION_CONTAINER]),
  }),
])

function fixedDockerCommand(kind: DockerCommandKind): readonly string[] {
  const command = STATIC_DOCKER_COMMANDS.find((candidate) => candidate.kind === kind)
  if (command === undefined) throw new Error(`R3.5 PG17 certification command is missing: ${kind}`)
  return command.args
}

/** Every required R8 live check is fixed in the executor; none is caller-selectable. */
export const R3_5_PG17_CERTIFICATION_MATRIX_STEPS = Object.freeze([
  'certified-substrate-preflight',
  'pg17-supabase-surface',
  'storage-shim',
  'baseline-50',
  'stella-0001-topology',
  'stella-0003-migrator-owner',
  'stella-0004-separation',
  'exact-memberships-and-grantor',
  'set-and-admin-negative-attacks',
  'rls',
  'append-only',
  'idempotence',
  'atomicity',
  'stella-0004-rollback',
  'stella-0001-rollback',
  'cleanup',
] as const)

/** The closed public command surface: the certification accepts no arguments. */
export function parseR3_5Pg17CertificationArguments(args: readonly string[]): void {
  if (args.length !== 0) {
    throw new Error(
      'The R3.5 PG17 certification command does not accept arguments, SQL, package names, paths, Docker options, or database targets.',
    )
  }
}

/**
 * Pure inspection for static tests and independent audit. It has no CLI route
 * and performs no Docker operation.
 */
export function describeR3_5Pg17CertificationPlan() {
  return Object.freeze({
    container: Object.freeze({
      name: R3_5_PG17_CERTIFICATION_CONTAINER,
      image: R3_5_PG17_CERTIFICATION_IMAGE,
      ownerLabel: Object.freeze({
        key: R3_5_PG17_CERTIFICATION_OWNER_LABEL,
        value: R3_5_PG17_CERTIFICATION_OWNER_VALUE,
      }),
    }),
    docker: Object.freeze({ commands: STATIC_DOCKER_COMMANDS }),
    transport: Object.freeze({
      kind: 'private-container-local-psql',
      adminSession: ADMIN_ROLE,
      migratorSession: MIGRATOR_ROLE,
      migratorCurrentUser: OWNER_ROLE,
      migratorRoleStatement: `SET LOCAL ROLE ${OWNER_ROLE};`,
      transactionPerPhase: true,
      hostTcpFallback: false,
    }),
    /**
     * The closed superuser transport: the storage shim and every phase named
     * in SUPERUSER_PHASE_FILES (stella_0001, stella_0004) plus both governed
     * rollback phases run here — over the container-local Unix socket, as the
     * image's real superuser, never as ADMIN_ROLE. `storageShimTransport` is
     * kept as an alias of the same fixed args for call-site clarity.
     */
    superuserTransport: Object.freeze({
      kind: 'container-local-superuser-psql',
      role: SUPERUSER_ROLE,
      args: SUPERUSER_TRANSPORT_ARGS,
      hostTcpFallback: false,
      passwordRequired: false,
    }),
    storageShimTransport: Object.freeze({
      kind: 'container-local-superuser-psql',
      role: SUPERUSER_ROLE,
      args: SUPERUSER_TRANSPORT_ARGS,
      hostTcpFallback: false,
      passwordRequired: false,
    }),
    /**
     * Fails closed, before any package executes, unless the live substrate's
     * OID 10 is the exact certified image's superuser role. Harness-layer
     * binding only — package grantor authority stays the fixed OID, never
     * this name (see verifyExactMembershipsAndGrantor).
     */
    substratePreflight: Object.freeze({
      oid: 10,
      expectedRoleName: CERTIFIED_SUBSTRATE_OID10_ROLE_NAME,
      expectedRolsuper: true,
      installerRole: ADMIN_ROLE,
      installerExpectedRolsuper: false,
      installerExpectedRolcreaterole: true,
    }),
    phaseIdentityMatrix: R3_5_PG17_CERTIFICATION_PHASE_IDENTITY_MATRIX,
    phaseTransactions: Object.freeze(
      R3_5_PG17_CERTIFICATION_PHASES.map((phase) => {
        const isSuperuser = SUPERUSER_PHASE_FILES.has(phase.file)
        const isMigrator = phase.identity === 'migrator'
        return [
          phase.file,
          isSuperuser ? SUPERUSER_ROLE : isMigrator ? MIGRATOR_ROLE : ADMIN_ROLE,
          isSuperuser ? SUPERUSER_ROLE : isMigrator ? OWNER_ROLE : ADMIN_ROLE,
          isMigrator ? `SET LOCAL ROLE ${OWNER_ROLE};` : null,
          isSuperuser ? 'CONTAINER_LOCAL_SOCKET' : 'EXISTING_INSTALLER_TRANSPORT',
        ] as const
      }),
    ),
    /**
     * The 0003 atomicity exercise's exact injected-failure contract, read
     * directly from ATOMICITY_INJECTED_FAILURE_PATTERN — never invented here.
     * Exposed declaratively so tests can bind the reason-specific proof to
     * the same regex the live executor enforces, mirroring rollbackContracts
     * below.
     */
    atomicityContract: Object.freeze({
      injectedStatement: 'SELECT 1 / 0;',
      expectedFailureSqlstate: '22012',
      expectedFailurePattern: ATOMICITY_INJECTED_FAILURE_PATTERN.source,
      genericFailureAccepted: false,
    }),
    /**
     * The two governed rollback phases' exact confirmation contract, read
     * directly from db/prepared/stella_0004_rollback.sql and
     * stella_0001_role_topology_bootstrap_rollback.sql — never invented here.
     */
    rollbackContracts: Object.freeze({
      '0004_rollback': Object.freeze({
        role: SUPERUSER_ROLE,
        transport: 'CONTAINER_LOCAL_SOCKET',
        confirmationSetting: 'uellix.rollback_confirmation',
        confirmationValueExpression: "'rollback-0004:' || current_database()",
        transactionLocal: true,
        callerSelectableConfirmationText: false,
      }),
      '0001_rollback_dependency_negative': Object.freeze({
        role: SUPERUSER_ROLE,
        transport: 'CONTAINER_LOCAL_SOCKET',
        confirmationSetting: 'uellix.rollback_confirmation',
        confirmationValueExpression: "'rollback-0001:' || current_database()",
        transactionLocal: true,
        callerSelectableConfirmationText: false,
        expectedFailurePattern: DEPENDENCY_GUARD_FAILURE_PATTERN.source,
        genericFailureAccepted: false,
      }),
    }),
  })
}

function runDocker(args: readonly string[], stdin?: string): DockerResult {
  try {
    const stdout = execFileSync('docker', args, {
      encoding: 'utf8',
      input: stdin,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const dockerError = error as { status?: number; stdout?: string; stderr?: string; message?: string }
    return {
      status: typeof dockerError.status === 'number' ? dockerError.status : 1,
      stdout: dockerError.stdout ?? '',
      stderr: dockerError.stderr ?? dockerError.message ?? '',
    }
  }
}

function dockerOrThrow(args: readonly string[], stdin?: string): string {
  const result = runDocker(args, stdin)
  if (result.status !== 0) {
    throw new Error(`Docker certification transport failed at ${args.slice(0, 3).join(' ')}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function fixedPreparedPath(file: R3_5Pg17CertificationSourceFile): string {
  const candidate = resolve(PREPARED_DIRECTORY, file)
  if (!candidate.startsWith(`${PREPARED_DIRECTORY}${sep}`)) {
    throw new Error(`R3.5 PG17 certification refused an unsafe fixed path: ${file}`)
  }
  return candidate
}

function loadVerifiedR3Sources(): Readonly<Record<R3_5Pg17CertificationSourceFile, string>> {
  assertR3_5Pg17CertificationSourceHashes(collectR3_5Pg17CertificationSourceHashes())
  const sources = {} as Record<R3_5Pg17CertificationSourceFile, string>
  for (const file of Object.keys(R3_5_PG17_CERTIFICATION_PACKAGE_HASHES) as R3_5Pg17CertificationSourceFile[]) {
    sources[file] = readFileSync(fixedPreparedPath(file), 'utf8')
  }
  assertR3_5Pg17CertificationSourceHashes(
    Object.fromEntries(
      Object.entries(sources).map(([file, source]) => [
        file,
        createHash('sha256').update(source, 'utf8').digest('hex'),
      ]),
    ) as Record<R3_5Pg17CertificationSourceFile, string>,
  )
  return Object.freeze(sources)
}

function sourceForPhase(
  sources: Readonly<Record<R3_5Pg17CertificationSourceFile, string>>,
  phase: R3_4LocalPhase,
): string {
  if (!(phase.file in sources)) {
    throw new Error(`R3.5 PG17 certification refused unpinned phase: ${phase.file}`)
  }
  return sources[phase.file as R3_5Pg17CertificationSourceFile]
}

function sourceForBaseline(file: string): string {
  const candidate = resolve(REPOSITORY_ROOT, file)
  if (!candidate.startsWith(`${REPOSITORY_ROOT}${sep}`)) {
    throw new Error(`R3.5 PG17 certification refused unsafe baseline path: ${file}`)
  }
  return readFileSync(candidate, 'utf8')
}

function internalPassword(): string {
  return randomBytes(32).toString('hex')
}

function assertInternalPassword(password: string): void {
  if (!/^[a-f0-9]{64}$/.test(password)) {
    throw new Error('R3.5 PG17 certification generated an invalid internal password')
  }
}

function assertPinnedLocalImage(): void {
  const imageId = dockerOrThrow(fixedDockerCommand('image-inspect')).trim()
  assertR3_5Pg17CertificationImageId(imageId)
}

function assertCertificationContainerAbsent(): void {
  const existing = runDocker(fixedDockerCommand('preflight-container-absence'))
  if (existing.status === 0) {
    throw new Error(`Refusing to replace existing certification container: ${R3_5_PG17_CERTIFICATION_CONTAINER}`)
  }
}

function createCertificationContainer(postgresPassword: string): void {
  assertInternalPassword(postgresPassword)
  dockerOrThrow(
    fixedDockerCommand('create').map((argument) =>
      argument === 'POSTGRES_PASSWORD=<internally-generated>'
        ? `POSTGRES_PASSWORD=${postgresPassword}`
        : argument,
    ),
  )
}

function waitForServingPostgres(postgresPassword: string): void {
  assertInternalPassword(postgresPassword)
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const ready = runDocker([
      'exec',
      '-e',
      `PGPASSWORD=${postgresPassword}`,
      R3_5_PG17_CERTIFICATION_CONTAINER,
      'pg_isready',
      '-h',
      INTERNAL_POSTGRES_HOST,
      '-U',
      ADMIN_ROLE,
      '-d',
      DATABASE_NAME,
    ])
    if (ready.status === 0) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  }
  throw new Error('Disposable R3.5 PG17 certification container did not become ready')
}

function runContainerPsql(
  role: typeof ADMIN_ROLE | typeof MIGRATOR_ROLE | typeof APP_ROLE,
  password: string,
  sql: string,
  options: { readonly tuplesOnly?: boolean } = {},
): DockerResult {
  assertInternalPassword(password)
  const args = [
    'exec',
    '-i',
    '-e',
    `PGPASSWORD=${password}`,
    R3_5_PG17_CERTIFICATION_CONTAINER,
    'psql',
    '-X',
    '-h',
    INTERNAL_POSTGRES_HOST,
    '-U',
    role,
    '-d',
    DATABASE_NAME,
    '-v',
    'ON_ERROR_STOP=1',
  ]
  if (options.tuplesOnly) args.push('-tAq')
  args.push('-1', '-f', '-')
  return runDocker(args, sql)
}

function assertPsqlSuccess(result: DockerResult, step: string): void {
  if (result.status !== 0) {
    throw new Error(`${MATRIX_ERROR} at ${step}: ${result.stderr.trim()}`)
  }
}

function assertPsqlRefused(result: DockerResult, step: string): void {
  if (result.status === 0) {
    throw new Error(`${MATRIX_ERROR} at ${step}: expected PostgreSQL refusal`)
  }
}

function adminIdentitySql(source: string): string {
  return `
DO $$
BEGIN
  IF session_user <> '${ADMIN_ROLE}' OR current_user <> '${ADMIN_ROLE}'
     OR NOT COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user), false) THEN
    RAISE EXCEPTION 'R3.5 PG17 certification requires the container-local administrative session';
  END IF;
END $$;
${source}
DO $$
BEGIN
  IF session_user <> '${ADMIN_ROLE}' OR current_user <> '${ADMIN_ROLE}' THEN
    RAISE EXCEPTION 'R3.5 PG17 certification administrative identity drifted';
  END IF;
END $$;
`
}

function migratorIdentitySql(source: string): string {
  return `
DO $$
BEGIN
  IF session_user <> '${MIGRATOR_ROLE}' OR current_user <> '${MIGRATOR_ROLE}' THEN
    RAISE EXCEPTION 'R3.5 PG17 certification requires an actual uellix_migrator login session';
  END IF;
END $$;
SET LOCAL ROLE ${OWNER_ROLE};
DO $$
BEGIN
  IF session_user <> '${MIGRATOR_ROLE}' OR current_user <> '${OWNER_ROLE}' THEN
    RAISE EXCEPTION 'R3.5 PG17 certification failed to reach uellix_owner with SET LOCAL ROLE';
  END IF;
END $$;
${source}
DO $$
BEGIN
  IF session_user <> '${MIGRATOR_ROLE}' OR current_user <> '${OWNER_ROLE}' THEN
    RAISE EXCEPTION 'R3.5 PG17 certification migrator identity drifted';
  END IF;
END $$;
`
}

function applyAdminPhase(source: string, postgresPassword: string, step: string): void {
  assertPsqlSuccess(runContainerPsql(ADMIN_ROLE, postgresPassword, adminIdentitySql(source)), step)
}

/**
 * The exact, fixed docker/psql argv used for every superuser-required
 * operation (the storage shim, stella_0001, stella_0004, and both governed
 * rollback phases): no `-h` (so psql falls back to the container-local Unix
 * socket instead of a TCP route), and therefore no password/PGPASSWORD.
 * Exported to the static plan above so the live executor and the audited
 * description cannot drift apart. There is no caller-reachable variant of
 * this argv — every call site below composes it with a fixed, internally
 * built SQL string; no exported function accepts arbitrary SQL, role,
 * container, database, host, port, password, or shell input.
 */
const SUPERUSER_TRANSPORT_ARGS: readonly string[] = Object.freeze([
  'exec',
  '-i',
  R3_5_PG17_CERTIFICATION_CONTAINER,
  'psql',
  '-X',
  '-U',
  SUPERUSER_ROLE,
  '-d',
  DATABASE_NAME,
  '-v',
  'ON_ERROR_STOP=1',
  '-1',
  '-f',
  '-',
])

/** Runs fixed SQL through the closed superuser transport. Not exported; every caller below passes only fixed, internally composed SQL. */
function runSuperuserPsql(sql: string): DockerResult {
  return runDocker(SUPERUSER_TRANSPORT_ARGS, sql)
}

/**
 * Applies the certification substrate's storage shim as the image's actual
 * superuser, over the container-local Unix socket — the identity and
 * transport PG176 already uses for this exact SQL (scripts/pg176-certify.ts).
 *
 * `applyAdminPhase` cannot be reused here: schema `storage` belongs to
 * `supabase_admin`, not to `postgres` (ADMIN_ROLE), and `adminIdentitySql`'s
 * own guard requires `session_user = 'postgres'`, so it would refuse a
 * `supabase_admin` session before ever reaching the shim's CREATE TABLE.
 *
 * Deliberately not a generic executor: it takes no parameters. The SQL, role,
 * container, database, and connection route are all fixed — only
 * STORAGE_SHIM_SQL, applied exactly once against the fixed certification
 * container, over the local socket (no -h, no password).
 */
function applyLabSuperuserStorageShim(): void {
  assertPsqlSuccess(runSuperuserPsql(STORAGE_SHIM_SQL), 'storage shim')
}

/**
 * The identity guard wrapped around a superuser-required Stella phase
 * (stella_0001, stella_0004): asserts session_user = current_user =
 * SUPERUSER_ROLE and that the session is an actual superuser, both before and
 * after the package — no SET ROLE anywhere in this wrapper, matching the
 * package's own precondition (stella_0004 requires `current_user` rolsuper;
 * stella_0001's own rollback requires `session_user` rolsuper).
 */
function superuserIdentitySql(source: string): string {
  return `
DO $$
BEGIN
  IF session_user <> '${SUPERUSER_ROLE}' OR current_user <> '${SUPERUSER_ROLE}'
     OR NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false) THEN
    RAISE EXCEPTION 'R3.5 PG17 certification requires the container-local superuser session';
  END IF;
END $$;
${source}
DO $$
BEGIN
  IF session_user <> '${SUPERUSER_ROLE}' OR current_user <> '${SUPERUSER_ROLE}' THEN
    RAISE EXCEPTION 'R3.5 PG17 certification superuser identity drifted';
  END IF;
END $$;
`
}

function applySuperuserPhase(source: string, step: string): void {
  assertPsqlSuccess(runSuperuserPsql(superuserIdentitySql(source)), step)
}

/**
 * Wraps a governed rollback package with its identity guard plus the exact
 * transaction-local confirmation its own SQL reads via
 * `current_setting('uellix.rollback_confirmation', true)` — computed in SQL
 * (`'<token>:' || current_database()`) rather than interpolated from a
 * caller-supplied value, and set with `set_config(..., true)` so it never
 * outlives the single `-1` transaction this transport already runs in.
 */
function superuserRollbackSql(token: 'rollback-0001' | 'rollback-0004', source: string): string {
  return `
DO $$
BEGIN
  IF session_user <> '${SUPERUSER_ROLE}' OR current_user <> '${SUPERUSER_ROLE}'
     OR NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false) THEN
    RAISE EXCEPTION 'R3.5 PG17 certification requires the container-local superuser session';
  END IF;
END $$;
SELECT set_config('uellix.rollback_confirmation', '${token}:' || current_database(), true);
${source}
`
}

function applySuperuserRollbackPhase(source: string, token: 'rollback-0001' | 'rollback-0004', step: string): void {
  assertPsqlSuccess(runSuperuserPsql(superuserRollbackSql(token, source)), step)
}

/**
 * Fails closed unless the result is both a refusal AND a refusal for the
 * expected reason — a non-zero exit alone (permission errors, missing
 * relations, syntax errors, or any other package-level failure) is never
 * sufficient. Exported so tests can exercise this exact production
 * assertion against in-memory simulated process results, rather than
 * reimplementing its two-part contract as a parallel test-only parser that
 * could silently disagree with it. Takes only a fixed DockerResult shape and
 * a RegExp — never SQL, a role, a container, or a database target — so
 * exporting it does not create a caller-reachable generic executor.
 */
export function assertPsqlRefusedWithReason(result: DockerResult, step: string, reasonPattern: RegExp): void {
  if (result.status === 0) {
    throw new Error(`${MATRIX_ERROR} at ${step}: expected PostgreSQL refusal`)
  }
  if (!reasonPattern.test(result.stderr)) {
    throw new Error(
      `${MATRIX_ERROR} at ${step}: refused, but not for the expected dependency-guard reason: ${result.stderr.trim()}`,
    )
  }
}

/**
 * The single dispatch point for applying any R3_5_PG17_CERTIFICATION_PHASES
 * entry — used identically by the first application and by
 * verifyIdempotence's re-application, so the two can never disagree about a
 * phase's identity. Routes by SUPERUSER_PHASE_FILES (stella_0001,
 * stella_0004) first; a phase not in that closed set keeps its pre-existing
 * postgres/migrator installer transport regardless of R3_4LocalPhase's own
 * ('admin' | 'migrator') identity field, which has no superuser concept.
 */
function applyCertificationPhase(
  phase: R3_4LocalPhase,
  sources: Readonly<Record<R3_5Pg17CertificationSourceFile, string>>,
  postgresPassword: string,
  migratorPassword: string,
): void {
  const source = sourceForPhase(sources, phase)
  const step = `apply ${phase.file}`
  if (SUPERUSER_PHASE_FILES.has(phase.file)) {
    applySuperuserPhase(source, step)
  } else if (phase.identity === 'migrator') {
    applyMigratorPhase(source, migratorPassword, step)
  } else {
    applyAdminPhase(source, postgresPassword, step)
  }
}

function applyMigratorPhase(source: string, migratorPassword: string, step: string): void {
  assertPsqlSuccess(runContainerPsql(MIGRATOR_ROLE, migratorPassword, migratorIdentitySql(source)), step)
}

function provisionFixedLogin(role: typeof MIGRATOR_ROLE | typeof APP_ROLE, password: string, postgresPassword: string): void {
  assertInternalPassword(password)
  applyAdminPhase(`ALTER ROLE ${role} PASSWORD '${password}';`, postgresPassword, `provision ${role} login`)
}

function scalarAdminQuery(sql: string, postgresPassword: string, step: string): string {
  const result = runContainerPsql(ADMIN_ROLE, postgresPassword, sql, { tuplesOnly: true })
  assertPsqlSuccess(result, step)
  return result.stdout.trim()
}

/**
 * Explicit, query-controlled boolean representation for the certified
 * substrate preflight. PostgreSQL's `boolean::text` cast yields `'true'` /
 * `'false'` (the `booltext` cast function), NOT the `t`/`f` short form
 * `psql`'s default display uses for the bare column — a spelling this
 * harness previously got backwards, causing every live run to fail closed
 * before any package executed. `CASE WHEN … THEN … ELSE … END` fully
 * controls the emitted text so this contract can never depend on either
 * spelling.
 */
const CERTIFIED_SUBSTRATE_PREFLIGHT_TRUE = '1'
const CERTIFIED_SUBSTRATE_PREFLIGHT_FALSE = '0'

function certifiedSubstrateBooleanCase(column: string): string {
  return `CASE WHEN ${column} THEN '${CERTIFIED_SUBSTRATE_PREFLIGHT_TRUE}' ELSE '${CERTIFIED_SUBSTRATE_PREFLIGHT_FALSE}' END`
}

/**
 * Pure query text for the certified substrate preflight — no Docker, no
 * network. Exported so tests can bind directly to the exact text the
 * executable preflight sends, instead of re-describing it separately and
 * risking drift between the two.
 */
export function certifiedSubstratePreflightQuery(installerRole: string): string {
  return `SELECT
       (SELECT rolname FROM pg_roles WHERE oid = 10) || '|' ||
       (SELECT ${certifiedSubstrateBooleanCase('rolsuper')} FROM pg_roles WHERE oid = 10) || '|' ||
       (SELECT ${certifiedSubstrateBooleanCase('rolsuper')} FROM pg_roles WHERE rolname = '${installerRole}') || '|' ||
       (SELECT ${certifiedSubstrateBooleanCase('rolcreaterole')} FROM pg_roles WHERE rolname = '${installerRole}');`
}

/**
 * Pure parse-and-assert surface for the certified substrate preflight —
 * takes the raw `psql -tAq` scalar line and fails closed unless it encodes
 * exactly the certified facts. This is the ONE predicate implementation;
 * both the live executor and the test suite call it directly so a
 * declarative description of the contract can never silently diverge from
 * what actually gets enforced.
 *
 * Requires exactly four pipe-delimited fields before reading any of them —
 * `String.prototype.split` on its own would silently truncate a fifth
 * (or fewer than four) field via destructuring, accepting a malformed
 * observation as long as the first four fields happened to be certified.
 */
export function assertCertifiedSubstratePreflightObserved(
  observed: string,
  expected: { readonly oid10RoleName: string; readonly installerRole: string },
): void {
  if (observed.includes('\n') || observed.includes('\r')) {
    throw new Error(
      `${MATRIX_ERROR} at certified substrate preflight: expected exactly one output line, observed an embedded newline: ${JSON.stringify(observed)}`,
    )
  }
  const fields = observed.split('|')
  if (fields.length !== 4) {
    throw new Error(
      `${MATRIX_ERROR} at certified substrate preflight: expected exactly 4 pipe-delimited fields (role, OID-10 rolsuper, installer rolsuper, installer rolcreaterole), observed ${fields.length}: ${JSON.stringify(observed)}`,
    )
  }
  const [oid10Name, oid10Rolsuper, installerRolsuper, installerRolcreaterole] = fields
  if (oid10Name !== expected.oid10RoleName || oid10Rolsuper !== CERTIFIED_SUBSTRATE_PREFLIGHT_TRUE) {
    throw new Error(
      `${MATRIX_ERROR} at certified substrate preflight: expected OID 10 to be the superuser role ${expected.oid10RoleName}, observed name=${oid10Name ?? '<null>'} rolsuper=${oid10Rolsuper ?? '<null>'}`,
    )
  }
  if (
    installerRolsuper !== CERTIFIED_SUBSTRATE_PREFLIGHT_FALSE ||
    installerRolcreaterole !== CERTIFIED_SUBSTRATE_PREFLIGHT_TRUE
  ) {
    throw new Error(
      `${MATRIX_ERROR} at certified substrate preflight: expected ${expected.installerRole} to be a non-superuser CREATEROLE role, observed rolsuper=${installerRolsuper ?? '<null>'} rolcreaterole=${installerRolcreaterole ?? '<null>'}`,
    )
  }
}

/**
 * Fails closed before any package or storage-shim execution unless the live
 * substrate provides exactly the certified facts: OID 10 is
 * CERTIFIED_SUBSTRATE_OID10_ROLE_NAME and is a superuser, and ADMIN_ROLE
 * ('postgres') is a non-superuser CREATEROLE role. Harness-layer binding
 * only — this never feeds package grantor authority, which stays the fixed
 * OID (see verifyExactMembershipsAndGrantor); it only decides whether the
 * closed superuser transport (which logs in by role NAME) is safe to use on
 * this container at all.
 */
function verifyCertifiedSubstratePreflight(postgresPassword: string): void {
  const observed = scalarAdminQuery(
    certifiedSubstratePreflightQuery(ADMIN_ROLE),
    postgresPassword,
    'certified substrate OID 10 preflight',
  )
  assertCertifiedSubstratePreflightObserved(observed, {
    oid10RoleName: CERTIFIED_SUBSTRATE_OID10_ROLE_NAME,
    installerRole: ADMIN_ROLE,
  })
}

function verifyPg17SupabaseSurface(postgresPassword: string): void {
  const version = scalarAdminQuery('SHOW server_version_num;', postgresPassword, 'PG17 server version')
  if (version !== EXPECTED_SERVER_VERSION_NUM) {
    throw new Error(`${MATRIX_ERROR} at PG17 server version: expected ${EXPECTED_SERVER_VERSION_NUM}, received ${version}`)
  }
  const surface = scalarAdminQuery(
    "SELECT to_regclass('auth.users') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin');",
    postgresPassword,
    'Supabase PG17 surface',
  )
  if (surface !== 't') throw new Error(`${MATRIX_ERROR} at Supabase PG17 surface`)
}

function applyBaseline(postgresPassword: string): void {
  if (BASELINE_UNITS.length !== 50) {
    throw new Error(`R3.5 PG17 certification expects the imported 50-unit baseline, found ${BASELINE_UNITS.length}`)
  }
  for (const unit of BASELINE_UNITS) {
    const source = sourceForBaseline(unit.file)
    if (sha256OfSql(source) !== unit.sha256) {
      throw new Error(`R3.5 PG17 certification baseline SHA-256 mismatch for ${unit.file}`)
    }
    applyAdminPhase(source, postgresPassword, `baseline ${unit.ordinal}: ${unit.id}`)
  }
}

/**
 * Package grantor authority is the fixed PostgreSQL BOOTSTRAP SUPERUSER OID
 * (10) — never a role name (the certified substrate's OID 10 happens to be
 * named `supabase_admin`, not `postgres`; see verifyCertifiedSubstratePreflight).
 * Compares by `a.grantor = e.grantor_oid`, matching every production
 * verifier's own convention (stella_0001, stella_0003, stella_0004) rather
 * than inventing a harness-only comparison shape. `g.rolname` is resolved
 * only for the diagnostic query below, never as a side of the equality/EXCEPT
 * comparison that decides pass/fail.
 */
function verifyExactMembershipsAndGrantor(postgresPassword: string): void {
  const exactRows = scalarAdminQuery(
    `
WITH expected(member_name, role_name, grantor_oid, inherit_option, set_option, admin_option) AS (
  VALUES
    ('uellix_migrator', 'uellix_owner', 10::oid, false, true, false),
    ('uellix_app', 'uellix_writer', 10::oid, true, false, false),
    ('postgres', 'uellix_writer', 10::oid, true, false, false)
), actual AS (
  SELECT m.rolname AS member_name, r.rolname AS role_name, a.grantor AS grantor_oid,
         a.inherit_option, a.set_option, a.admin_option
  FROM pg_auth_members a
  JOIN pg_roles m ON m.oid = a.member
  JOIN pg_roles r ON r.oid = a.roleid
  WHERE m.rolname IN ('uellix_migrator', 'uellix_app', 'postgres')
    AND r.rolname IN ('uellix_owner', 'uellix_writer')
)
SELECT NOT EXISTS ((SELECT * FROM expected EXCEPT SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected));
`,
    postgresPassword,
    'exact membership and grantor',
  )
  if (exactRows !== 't') {
    const diagnostic = scalarAdminQuery(
      `
SELECT COALESCE(string_agg(
  m.rolname || '->' || r.rolname || ' grantor_oid=' || a.grantor || ' grantor_name=' || g.rolname ||
  ' inherit=' || a.inherit_option || ' set=' || a.set_option || ' admin=' || a.admin_option,
  ', '
), '<none>')
FROM pg_auth_members a
JOIN pg_roles m ON m.oid = a.member
JOIN pg_roles r ON r.oid = a.roleid
JOIN pg_roles g ON g.oid = a.grantor
WHERE m.rolname IN ('uellix_migrator', 'uellix_app', 'postgres')
  AND r.rolname IN ('uellix_owner', 'uellix_writer');
`,
      postgresPassword,
      'exact membership and grantor diagnostic',
    )
    throw new Error(`${MATRIX_ERROR} at exact membership and grantor: ${diagnostic}`)
  }
}

function verifySetAndAdminNegativeAttacks(
  postgresPassword: string,
  appPassword: string,
): void {
  assertPsqlRefused(
    runContainerPsql(APP_ROLE, appPassword, `SET ROLE ${OWNER_ROLE};`),
    'app SET ROLE owner negative attack',
  )
  assertPsqlRefused(
    runContainerPsql(ADMIN_ROLE, postgresPassword, `SET ROLE ${OWNER_ROLE};`),
    'admin SET ROLE owner negative attack',
  )
  assertPsqlRefused(
    runContainerPsql(APP_ROLE, appPassword, `GRANT ${OWNER_ROLE} TO ${APP_ROLE} WITH ADMIN OPTION;`),
    'app ADMIN OPTION negative attack',
  )
}

function verifyRls(postgresPassword: string): void {
  const rls = scalarAdminQuery(
    "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.stella_suggestion_decisions'::regclass;",
    postgresPassword,
    'decision RLS',
  )
  if (rls !== 't') throw new Error(`${MATRIX_ERROR} at decision RLS`)
}

function verifyAppendOnly(postgresPassword: string): void {
  assertPsqlRefused(
    runContainerPsql(ADMIN_ROLE, postgresPassword, 'TRUNCATE TABLE public.stella_interactions;'),
    'append-only truncate negative attack',
  )
}

function verifyAtomicity(
  decisionSource: string,
  postgresPassword: string,
  migratorPassword: string,
): void {
  assertPsqlRefusedWithReason(
    runContainerPsql(MIGRATOR_ROLE, migratorPassword, migratorIdentitySql(`${decisionSource}\nSELECT 1 / 0;`)),
    '0003 injected failure',
    ATOMICITY_INJECTED_FAILURE_PATTERN,
  )
  const absent = scalarAdminQuery(
    "SELECT to_regclass('public.stella_suggestion_decisions') IS NULL;",
    postgresPassword,
    '0003 atomic rollback',
  )
  if (absent !== 't') throw new Error(`${MATRIX_ERROR} at 0003 atomic rollback`)
}

function applyR3CertificationPhases(
  sources: Readonly<Record<R3_5Pg17CertificationSourceFile, string>>,
  postgresPassword: string,
  migratorPassword: string,
): void {
  for (const phase of R3_5_PG17_CERTIFICATION_PHASES) {
    applyCertificationPhase(phase, sources, postgresPassword, migratorPassword)
  }
}

function verifyIdempotence(
  sources: Readonly<Record<R3_5Pg17CertificationSourceFile, string>>,
  postgresPassword: string,
  migratorPassword: string,
): void {
  applyR3CertificationPhases(sources, postgresPassword, migratorPassword)
}

/**
 * Exercises both governed rollback phases through the closed superuser
 * transport, in the sequence stella_0001's own dependency guard requires to
 * be provably reached rather than assumed: roll 0004 back (ownership returns
 * to `postgres`), REAPPLY 0004 so the dependency stella_0001's rollback
 * refuses on — surviving relations owned by `uellix_owner` — is deliberately
 * still present, then attempt the 0001 rollback and require it to fail with
 * that exact dependency-guard text (never a generic non-zero exit).
 */
function verifyRollbacks(
  sources: Readonly<Record<R3_5Pg17CertificationSourceFile, string>>,
): void {
  applySuperuserRollbackPhase(sources['stella_0004_rollback.sql'], 'rollback-0004', '0004 rollback')
  applySuperuserPhase(sources['stella_0004_role_separation.sql'], '0004 rollback reapply')
  assertPsqlRefusedWithReason(
    runSuperuserPsql(superuserRollbackSql('rollback-0001', sources['stella_0001_role_topology_bootstrap_rollback.sql'])),
    '0001 rollback dependency guard',
    DEPENDENCY_GUARD_FAILURE_PATTERN,
  )
}

function cleanupOwnedCertificationContainer(): void {
  const owner = dockerOrThrow(fixedDockerCommand('cleanup-owner-check')).trim()
  if (owner !== R3_5_PG17_CERTIFICATION_OWNER_VALUE) {
    throw new Error(`Refusing to remove container without the R3.5 certification ownership label`)
  }
  dockerOrThrow(fixedDockerCommand('cleanup-remove'))
}

function executeFixedCertification(): void {
  // This happens before any Docker inspection or mutation, as package bytes are
  // the root authority of this certification profile.
  const sources = loadVerifiedR3Sources()
  if (BASELINE_UNITS.length !== 50) {
    throw new Error(`R3.5 PG17 certification expects 50 imported baseline units, found ${BASELINE_UNITS.length}`)
  }

  assertPinnedLocalImage()
  assertCertificationContainerAbsent()

  const postgresPassword = internalPassword()
  const migratorPassword = internalPassword()
  const appPassword = internalPassword()
  let created = false

  try {
    createCertificationContainer(postgresPassword)
    created = true
    waitForServingPostgres(postgresPassword)
    verifyCertifiedSubstratePreflight(postgresPassword)
    verifyPg17SupabaseSurface(postgresPassword)
    applyLabSuperuserStorageShim()
    applyBaseline(postgresPassword)

    const [firstAdmin, secondAdmin, topology, decision, separation] = R3_5_PG17_CERTIFICATION_PHASES
    if (!firstAdmin || !secondAdmin || !topology || !decision || !separation) {
      throw new Error('R3.5 PG17 certification derived an incomplete R8 phase prefix')
    }
    applyCertificationPhase(firstAdmin, sources, postgresPassword, migratorPassword)
    applyCertificationPhase(secondAdmin, sources, postgresPassword, migratorPassword)
    applyCertificationPhase(topology, sources, postgresPassword, migratorPassword)
    provisionFixedLogin(MIGRATOR_ROLE, migratorPassword, postgresPassword)
    provisionFixedLogin(APP_ROLE, appPassword, postgresPassword)
    verifyAtomicity(sourceForPhase(sources, decision), postgresPassword, migratorPassword)
    applyCertificationPhase(decision, sources, postgresPassword, migratorPassword)
    applyCertificationPhase(separation, sources, postgresPassword, migratorPassword)

    verifyExactMembershipsAndGrantor(postgresPassword)
    verifySetAndAdminNegativeAttacks(postgresPassword, appPassword)
    verifyRls(postgresPassword)
    verifyAppendOnly(postgresPassword)
    verifyIdempotence(sources, postgresPassword, migratorPassword)
    verifyRollbacks(sources)
    console.log('MSC-07B R3.5 PG17 certification passed inside the disposable, network-isolated container.')
  } finally {
    if (created) cleanupOwnedCertificationContainer()
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return typeof entry === 'string' && pathToFileURL(resolve(entry)).href === import.meta.url
}

if (isDirectExecution()) {
  try {
    parseR3_5Pg17CertificationArguments(process.argv.slice(2))
    executeFixedCertification()
  } catch (error) {
    console.error('[r3.5-pg17-certification] failed:', error instanceof Error ? error.message : 'unknown error')
    process.exitCode = 1
  }
}
