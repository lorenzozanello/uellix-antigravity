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
 * Container-local superuser identity for exactly one operation: applying the
 * certification substrate's storage shim. Not part of the ADMIN_ROLE /
 * MIGRATOR_ROLE / APP_ROLE union that every Stella package phase uses, and
 * never exposed as a caller-selectable role — see applyLabSuperuserStorageShim.
 */
const LAB_SUPERUSER_ROLE = 'supabase_admin'
const MATRIX_ERROR = 'R3.5 PG17 certification matrix assertion failed'

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
     * The one exception to `transport` above: the storage shim runs before
     * any Stella phase, as the image's real superuser, never as ADMIN_ROLE.
     */
    storageShimTransport: Object.freeze({
      kind: 'container-local-superuser-psql',
      role: LAB_SUPERUSER_ROLE,
      args: STORAGE_SHIM_TRANSPORT_ARGS,
      hostTcpFallback: false,
      passwordRequired: false,
    }),
    phaseTransactions: Object.freeze(
      R3_5_PG17_CERTIFICATION_PHASES.map((phase) => [
        phase.file,
        phase.identity === 'migrator' ? MIGRATOR_ROLE : ADMIN_ROLE,
        phase.identity === 'migrator' ? OWNER_ROLE : ADMIN_ROLE,
        phase.identity === 'migrator' ? `SET LOCAL ROLE ${OWNER_ROLE};` : null,
      ] as const),
    ),
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
 * The exact, fixed docker/psql argv used to apply STORAGE_SHIM_SQL as the
 * container's actual superuser: no `-h` (so psql falls back to the
 * container-local Unix socket instead of a TCP route), and therefore no
 * password. Exported to the static plan below so the live executor and the
 * audited description cannot drift apart.
 */
const STORAGE_SHIM_TRANSPORT_ARGS: readonly string[] = Object.freeze([
  'exec',
  '-i',
  R3_5_PG17_CERTIFICATION_CONTAINER,
  'psql',
  '-X',
  '-U',
  LAB_SUPERUSER_ROLE,
  '-d',
  DATABASE_NAME,
  '-v',
  'ON_ERROR_STOP=1',
  '-1',
  '-f',
  '-',
])

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
  assertPsqlSuccess(runDocker(STORAGE_SHIM_TRANSPORT_ARGS, STORAGE_SHIM_SQL), 'storage shim')
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

function verifyExactMembershipsAndGrantor(postgresPassword: string): void {
  const exactRows = scalarAdminQuery(
    `
WITH expected(member_name, role_name, grantor_name, inherit_option, set_option, admin_option) AS (
  VALUES
    ('uellix_migrator', 'uellix_owner', 'postgres', false, true, false),
    ('uellix_app', 'uellix_writer', 'postgres', true, false, false),
    ('postgres', 'uellix_writer', 'postgres', true, false, false)
), actual AS (
  SELECT m.rolname, r.rolname, g.rolname, a.inherit_option, a.set_option, a.admin_option
  FROM pg_auth_members a
  JOIN pg_roles m ON m.oid = a.member
  JOIN pg_roles r ON r.oid = a.roleid
  JOIN pg_roles g ON g.oid = a.grantor
  WHERE m.rolname IN ('uellix_migrator', 'uellix_app', 'postgres')
    AND r.rolname IN ('uellix_owner', 'uellix_writer')
)
SELECT NOT EXISTS ((SELECT * FROM expected EXCEPT SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected));
`,
    postgresPassword,
    'exact membership and grantor',
  )
  if (exactRows !== 't') throw new Error(`${MATRIX_ERROR} at exact membership and grantor`)
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
  assertPsqlRefused(
    runContainerPsql(MIGRATOR_ROLE, migratorPassword, migratorIdentitySql(`${decisionSource}\nSELECT 1 / 0;`)),
    '0003 injected failure',
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
    const source = sourceForPhase(sources, phase)
    if (phase.identity === 'admin') {
      applyAdminPhase(source, postgresPassword, `apply ${phase.file}`)
    } else {
      applyMigratorPhase(source, migratorPassword, `apply ${phase.file}`)
    }
  }
}

function verifyIdempotence(
  sources: Readonly<Record<R3_5Pg17CertificationSourceFile, string>>,
  postgresPassword: string,
  migratorPassword: string,
): void {
  applyR3CertificationPhases(sources, postgresPassword, migratorPassword)
}

function verifyRollbacks(
  sources: Readonly<Record<R3_5Pg17CertificationSourceFile, string>>,
  postgresPassword: string,
): void {
  applyAdminPhase(sources['stella_0004_rollback.sql'], postgresPassword, '0004 rollback')
  applyAdminPhase(sources['stella_0004_role_separation.sql'], postgresPassword, '0004 rollback reapply')
  assertPsqlRefused(
    runContainerPsql(ADMIN_ROLE, postgresPassword, adminIdentitySql(sources['stella_0001_role_topology_bootstrap_rollback.sql'])),
    '0001 rollback dependency guard',
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
    verifyPg17SupabaseSurface(postgresPassword)
    applyLabSuperuserStorageShim()
    applyBaseline(postgresPassword)

    const [firstAdmin, secondAdmin, topology, decision, separation] = R3_5_PG17_CERTIFICATION_PHASES
    if (!firstAdmin || !secondAdmin || !topology || !decision || !separation) {
      throw new Error('R3.5 PG17 certification derived an incomplete R8 phase prefix')
    }
    applyAdminPhase(sourceForPhase(sources, firstAdmin), postgresPassword, `apply ${firstAdmin.file}`)
    applyAdminPhase(sourceForPhase(sources, secondAdmin), postgresPassword, `apply ${secondAdmin.file}`)
    applyAdminPhase(sourceForPhase(sources, topology), postgresPassword, `apply ${topology.file}`)
    provisionFixedLogin(MIGRATOR_ROLE, migratorPassword, postgresPassword)
    provisionFixedLogin(APP_ROLE, appPassword, postgresPassword)
    verifyAtomicity(sourceForPhase(sources, decision), postgresPassword, migratorPassword)
    applyMigratorPhase(sourceForPhase(sources, decision), migratorPassword, `apply ${decision.file}`)
    applyAdminPhase(sourceForPhase(sources, separation), postgresPassword, `apply ${separation.file}`)

    verifyExactMembershipsAndGrantor(postgresPassword)
    verifySetAndAdminNegativeAttacks(postgresPassword, appPassword)
    verifyRls(postgresPassword)
    verifyAppendOnly(postgresPassword)
    verifyIdempotence(sources, postgresPassword, migratorPassword)
    verifyRollbacks(sources, postgresPassword)
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
