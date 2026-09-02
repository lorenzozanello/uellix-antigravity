// scripts/baseline-rehearsal-local.ts
// TRAIN 5C0 — Phase 9. The local baseline rehearsal.
// HPO-ODS-W2-03 — rehearses the REAL provisioning order on an ISOLATED cluster.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR, AND THE THING IT IS EXPLICITLY NOT FOR
// ---------------------------------------------------------------------------
// It is a REGRESSION harness and a DEFECT REPRODUCTION. It is not, and must
// never be cited as, evidence of managed-Supabase compatibility.
//
// The reason is specific rather than cautious. `supabase/config.toml` sets
// `[db.migrations] enabled = true`, so the Supabase CLI applies
// supabase/migrations/** at container start, before a single Drizzle file runs.
// That is precisely why "0000…0039" appeared to work locally for a year while
// being an unrunnable sequence anywhere else. So this script runs the naive
// order first, to WATCH IT FAIL. Run A failing is a passing result.
//
// ---------------------------------------------------------------------------
// WHY A FRESH CONTAINER, NOT A SHARED ONE (HPO-ODS-W2-03)
// ---------------------------------------------------------------------------
// PostgreSQL roles are CLUSTER-scoped. The previous form of this script borrowed
// a running `supabase_db_*` container and created fresh DATABASES inside it —
// which proved nothing about roles: the cluster it borrowed already carried a
// `uellix_app` from that project's own history, so 0042/0045 (`CREATE POLICY …
// TO uellix_app`) appeared to pass and the real first failure was masked.
//
// So the rehearsal now STARTS its own container from the same image managed
// Supabase runs (public.ecr.aws/supabase/postgres:17.6.1.143), with
// `--network none`, asserts the cluster is role-pristine, and destroys it at
// the end. Measured on that image, standalone: `postgres` is NOSUPERUSER with
// CREATEROLE and CREATEDB — the managed installer profile — the seven platform
// roles exist, and a new database has none of auth/storage/extensions, so the
// repository shim still provides the minimum the corpus references (and we own
// it, which is exactly what the shim's own header warns makes privilege
// questions answer trivially and wrongly).
//
// ---------------------------------------------------------------------------
// THE SEQUENCE IT PROVES (docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.4.json D5)
// ---------------------------------------------------------------------------
//   pristine cluster (0 uellix_* roles)
//   RUN A   naive Drizzle-only order              -> must fail at 0039 (historic control)
//   RUN N1  manifest order WITHOUT identities     -> must fail at 0042 with 42704
//   IDENTITY stella_hosted_0000 as postgres        -> five roles, canonical topology, 0 tables
//   RUN B   64 units in manifest order            -> must complete; 0044 skips its guarded pair
//   GUARD   the unconditional form                -> must raise 42P01 (the guard is load-bearing)
//   B0      read-only postconditions              -> must all pass
//   S1      stella_hosted_0001 post-baseline      -> must complete against the existing roles
//   PRESENT table-present control for 0044        -> the conditional trigger IS created
//   teardown: container removed, 0 leftovers
//
// It never opens, reads or writes any pre-existing container.

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  BASELINE_ORDER,
  BASELINE_UNITS,
  REHEARSAL_ARTEFACT,
  baselineManifestDigest,
} from '../db/hosted/baseline-manifest'
import { KNOWN_STAGING_PROJECT_REF } from '../db/hosted/target-identity'
import {
  deriveExpectedBaselineState,
  evaluateBaselinePostconditions,
  type BaselineObservation,
} from '../db/hosted/baseline-postconditions'
import {
  MANAGED_ROLE_ATTRIBUTES,
  MANAGED_ROLE_IDENTITIES,
  MANAGED_ROLE_IDENTITY_PACKAGE,
  MANAGED_ROLE_MEMBERSHIPS,
  verifyRoleIdentityPackage,
} from '../db/hosted/managed-role-identities'
import { sha256OfSql } from '../db/hosted/hosted-package-manifest'

const ROOT = path.resolve(import.meta.dirname, '..')
const SHIM = path.join(ROOT, 'scripts', 'rehearsal', 'local-supabase-shim.sql')
const POST_BASELINE_BOOTSTRAP = 'db/prepared/stella_hosted_0001_managed_role_bootstrap.sql'

/** The image managed Supabase runs. Pinned, not "latest". */
export const REHEARSAL_IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143'
/** Fixed prefixes. Teardown only ever removes what matches them. */
const CONTAINER_PREFIX = 'uellix_rehearsal_pg_'
const CONTAINER_LABEL = 'uellix.rehearsal=baseline'
const DB_PREFIX = 'uellix_rehearsal_'
const DB_NAIVE = `${DB_PREFIX}naive`
const DB_NOROLE = `${DB_PREFIX}norole`
const DB_MANIFEST = `${DB_PREFIX}manifest`
const DB_PRESENT = `${DB_PREFIX}present`

const UNIT_0042 = '0042_fib_audit_insert_policy.sql'
const UNIT_0044 = '0044_fib_audit_hardening_supersession.sql'
const UNIT_0045 = '0045_fib_domain_object_version_lineage.sql'
const B1_UNITS = [
  '0048_fib_evidence_versions.sql',
  '0049_fib_evidence_sensitivity_vocabulary.sql',
  '0050_fib_evidence_sufficiency_determinations.sql',
  '0051_fib_evidence_erasure_substrate.sql',
  '0052_fib_evidence_sufficiency_run_binding.sql',
] as const
const CONDITIONAL_TRIGGER = 'trg_stella_suggestion_decisions_no_truncate'
const UNCONDITIONAL_0044_TRIGGERS = [
  'trg_stella_interactions_append_only',
  'trg_audit_logs_no_truncate',
  'trg_sroi_calculation_runs_no_truncate',
  'trg_sroi_calculation_line_items_no_truncate',
  'trg_stella_interactions_no_truncate',
] as const

/* -------------------------------------------------------------------------- */
/* docker / psql plumbing                                                      */
/* -------------------------------------------------------------------------- */

function docker(args: readonly string[], stdin?: string): string {
  return execFileSync('docker', args, { input: stdin, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

interface SqlFailure {
  readonly sqlstate: string | null
  readonly message: string
}

function failureOf(error: unknown): SqlFailure {
  const raw = error instanceof Error ? `${(error as { stderr?: string | Buffer }).stderr ?? ''}${error.message}` : String(error)
  const m = /ERROR:\s+([0-9A-Z]{5}):/.exec(raw)
  return { sqlstate: m ? m[1] : null, message: raw.split('\n').filter(Boolean).slice(0, 3).join(' / ') }
}

/**
 * One psql invocation as the non-superuser `postgres` over the container's
 * local socket (trust auth, no credential anywhere). `-v VERBOSITY=verbose` so
 * a refusal carries its SQLSTATE, which the negative controls assert on.
 */
function psql(container: string, database: string, sql: string, opts: { singleTransaction?: boolean; env?: boolean } = {}): string {
  const args = ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-q']
  if (opts.singleTransaction !== false) args.push('-1')
  args.push('-f', '-')
  // The environment declaration the hosted packages require, in the SAME
  // transaction — the exact shape their headers document with `-c`.
  const body = opts.env ? `SET uellix.bootstrap_environment = 'staging';\n${sql}` : sql
  return docker(args, body)
}

function query(container: string, database: string, sql: string): string[] {
  const out = docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', database, '-tAq', '-c', sql])
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

function createDatabase(container: string, name: string): void {
  if (!name.startsWith(DB_PREFIX)) throw new Error(`refusing to create ${name}: not a rehearsal database`)
  docker(['exec', container, 'psql', '-U', 'postgres', '-q', '-c', `DROP DATABASE IF EXISTS ${name}`])
  docker(['exec', container, 'psql', '-U', 'postgres', '-q', '-c', `CREATE DATABASE ${name}`])
  psql(container, name, readFileSync(SHIM, 'utf8'), { singleTransaction: false })
}

/* -------------------------------------------------------------------------- */
/* The isolated cluster                                                        */
/* -------------------------------------------------------------------------- */

function removeStaleRehearsalContainers(): string[] {
  const stale = docker(['ps', '-a', '--filter', `label=${CONTAINER_LABEL}`, '--format', '{{.Names}}'])
    .split('\n')
    .map((s) => s.trim())
    .filter((n) => n.startsWith(CONTAINER_PREFIX))
  for (const name of stale) docker(['rm', '-f', name])
  return stale
}

function startCluster(): string {
  const name = `${CONTAINER_PREFIX}${process.pid}_${Date.now().toString(36)}`
  // The password is never used: every access is `docker exec` over the local
  // socket. It exists because the image's entrypoint requires one to start.
  const password = randomBytes(24).toString('hex')
  docker(['run', '-d', '--name', name, '--label', CONTAINER_LABEL, '--network', 'none', '-e', `POSTGRES_PASSWORD=${password}`, REHEARSAL_IMAGE])

  // The image restarts postgres once after its init scripts, so "ready" is
  // asserted as THREE consecutive successful queries a second apart.
  const deadline = Date.now() + 180_000
  let consecutive = 0
  while (Date.now() < deadline) {
    try {
      docker(['exec', name, 'psql', '-U', 'postgres', '-tAqc', 'select 1'])
      consecutive += 1
      if (consecutive >= 3) return name
    } catch {
      consecutive = 0
    }
    execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'])
  }
  docker(['rm', '-f', name])
  throw new Error(`rehearsal cluster ${name} did not become ready within 180s`)
}

function destroyCluster(name: string): void {
  if (!name.startsWith(CONTAINER_PREFIX)) throw new Error(`refusing to remove ${name}: not a rehearsal container`)
  docker(['rm', '-f', name])
}

function leftoverContainers(): string[] {
  return docker(['ps', '-a', '--format', '{{.Names}}'])
    .split('\n')
    .map((s) => s.trim())
    .filter((n) => n.startsWith(CONTAINER_PREFIX))
}

/* -------------------------------------------------------------------------- */
/* Pristinity, topology, tables                                                */
/* -------------------------------------------------------------------------- */

function uellixRoles(container: string): string[] {
  return query(container, 'postgres', `SELECT rolname FROM pg_roles WHERE rolname LIKE 'uellix\\_%' ORDER BY 1`)
}

function publicTableCount(container: string, database: string): number {
  return Number(query(container, database, `SELECT count(*) FROM pg_tables WHERE schemaname = 'public'`)[0] ?? '0')
}

interface PristineCheck {
  readonly ok: boolean
  readonly uellixRoles: readonly string[]
  readonly installerIsSuperuser: boolean
  readonly installerHasCreateRole: boolean
  readonly platformRolesMissing: readonly string[]
  readonly detail: string
}

/** P1 / N3: the cluster must carry zero uellix_* roles and a managed-shaped installer. */
function checkPristine(container: string): PristineCheck {
  const roles = uellixRoles(container)
  const [isSuper, hasCreateRole] = query(
    container,
    'postgres',
    `SELECT rolsuper::text || '|' || rolcreaterole::text FROM pg_roles WHERE rolname = 'postgres'`,
  )[0]!.split('|')
  const missing = query(
    container,
    'postgres',
    `SELECT r.name FROM (VALUES ('supabase_admin'),('supabase_auth_admin'),('supabase_storage_admin'),('authenticator'),('anon'),('authenticated'),('service_role')) AS r(name) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name)`,
  )
  const problems: string[] = []
  if (roles.length > 0) problems.push(`residual uellix_* role(s): ${roles.join(', ')}`)
  if (isSuper === 'true') problems.push('postgres is a superuser (not the managed profile)')
  if (hasCreateRole !== 'true') problems.push('postgres lacks CREATEROLE')
  if (missing.length > 0) problems.push(`platform role(s) missing: ${missing.join(', ')}`)
  return {
    ok: problems.length === 0,
    uellixRoles: roles,
    installerIsSuperuser: isSuper === 'true',
    installerHasCreateRole: hasCreateRole === 'true',
    platformRolesMissing: missing,
    detail: problems.length === 0 ? 'pristine: 0 uellix_* roles, non-superuser CREATEROLE installer, 7 platform roles' : problems.join('; '),
  }
}

interface TopologyCheck {
  readonly ok: boolean
  readonly problems: readonly string[]
}

/** P3 / N6: exactly the five identities, canonical attributes and memberships. */
function checkTopology(container: string): TopologyCheck {
  const problems: string[] = []
  const roles = uellixRoles(container)
  const expected = [...MANAGED_ROLE_IDENTITIES].sort()
  if (JSON.stringify([...roles].sort()) !== JSON.stringify(expected)) {
    problems.push(`uellix_* roles are ${roles.join(', ') || 'none'}, expected exactly ${expected.join(', ')}`)
  }
  for (const role of MANAGED_ROLE_IDENTITIES) {
    const row = query(
      container,
      'postgres',
      `SELECT rolcanlogin::text||'|'||rolcreaterole::text||'|'||rolsuper::text||'|'||rolbypassrls::text||'|'||rolcreatedb::text||'|'||rolreplication::text||'|'||rolinherit::text FROM pg_roles WHERE rolname = '${role}'`,
    )[0]
    if (!row) {
      problems.push(`${role} absent`)
      continue
    }
    const [login, createrole, superuser, bypassrls, createdb, replication, inherit] = row.split('|')
    const want = MANAGED_ROLE_ATTRIBUTES[role]
    if (login !== String(want.login)) problems.push(`${role}: login=${login}, expected ${want.login}`)
    if (createrole !== String(want.createrole)) problems.push(`${role}: createrole=${createrole}, expected ${want.createrole}`)
    if (superuser !== 'false' || bypassrls !== 'false' || createdb !== 'false' || replication !== 'false' || inherit !== 'true') {
      problems.push(`${role}: dangerous or non-canonical attribute (super=${superuser} bypassrls=${bypassrls} createdb=${createdb} replication=${replication} inherit=${inherit})`)
    }
  }
  for (const m of MANAGED_ROLE_MEMBERSHIPS) {
    const row = query(
      container,
      'postgres',
      `SELECT am.inherit_option::text||'|'||am.set_option::text FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles g ON g.oid = am.member WHERE r.rolname = '${m.role}' AND g.rolname = '${m.member}'`,
    )[0]
    if (!row) {
      problems.push(`membership ${m.member} -> ${m.role} absent`)
      continue
    }
    const [inherit, set] = row.split('|')
    if (inherit !== String(m.inherit) || set !== String(m.set)) {
      problems.push(`membership ${m.member} -> ${m.role}: inherit=${inherit} set=${set}, expected inherit=${m.inherit} set=${m.set}`)
    }
  }
  const appReachesOwner = query(container, 'postgres', `SELECT pg_has_role('uellix_app','uellix_owner','MEMBER')::text`)[0]
  if (appReachesOwner !== 'false') problems.push('uellix_app can reach uellix_owner')
  const postgresCanSetOwner = query(container, 'postgres', `SELECT pg_has_role('postgres','uellix_owner','SET')::text`)[0]
  if (postgresCanSetOwner !== 'true') problems.push('postgres cannot SET ROLE uellix_owner (RR-02 grant missing)')
  return { ok: problems.length === 0, problems }
}

/* -------------------------------------------------------------------------- */
/* Applying units                                                              */
/* -------------------------------------------------------------------------- */

interface ApplyOutcome {
  readonly applied: number
  readonly appliedUnits: readonly string[]
  readonly failedUnit: string | null
  readonly sqlstate: string | null
  readonly error: string | null
}

function applyUnits(container: string, database: string, files: readonly string[]): ApplyOutcome {
  const appliedUnits: string[] = []
  for (const file of files) {
    const sql = readFileSync(path.join(ROOT, file), 'utf8')
    try {
      psql(container, database, sql)
      appliedUnits.push(path.basename(file))
    } catch (error) {
      const f = failureOf(error)
      return { applied: appliedUnits.length, appliedUnits, failedUnit: file, sqlstate: f.sqlstate, error: f.message }
    }
  }
  return { applied: appliedUnits.length, appliedUnits, failedUnit: null, sqlstate: null, error: null }
}

function triggerExists(container: string, database: string, trigger: string, table: string): boolean {
  return (
    query(
      container,
      database,
      `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE t.tgname = '${trigger}' AND c.relname = '${table}' AND n.nspname = 'public' AND NOT t.tgisinternal`,
    )[0] === '1'
  )
}

/* -------------------------------------------------------------------------- */
/* CHECKPOINT B0 observation                                                   */
/* -------------------------------------------------------------------------- */

/** Reads the catalog into the shape the postconditions consume. */
function observe(container: string, database: string): BaselineObservation {
  const q = (sql: string) => query(container, database, sql)

  const columns: Record<string, string[]> = {}
  for (const row of q(
    `SELECT table_schema||'.'||table_name||'|'||column_name FROM information_schema.columns WHERE table_schema='public'`,
  )) {
    const [table, column] = row.split('|')
    ;(columns[table] ??= []).push(column)
  }

  const rowCounts: Record<string, number> = {}
  for (const table of q(`SELECT 'public.'||tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`)) {
    // COUNT(*), not n_live_tup: an unanalysed table reports 0 whether or not it
    // holds rows, and a postcondition that accepted a stale zero would be the
    // exact "decorative check" this train is trying not to ship.
    rowCounts[table] = Number(q(`SELECT count(*) FROM ${table}`)[0] ?? '0')
  }

  return {
    schemas: q(`SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY 1`),
    tables: q(`SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`),
    columns,
    constraints: q(`SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY 1`),
    functions: q(`SELECT n.nspname||'.'||p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1`),
    triggers: q(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`),
    rlsEnabledTables: q(`SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relrowsecurity AND n.nspname='public' ORDER BY 1`),
    // public AND storage: the corpus creates the evidence-bucket policies on
    // storage.objects, and an observation scoped to public would report them
    // missing while looking like a clean pass for everything it did see.
    policies: q(`SELECT schemaname||'.'||tablename||'.'||policyname FROM pg_policies WHERE schemaname IN ('public','storage') ORDER BY 1`),
    roles: q(`SELECT rolname FROM pg_roles ORDER BY 1`),
    grants: q(`SELECT grantee||':'||privilege_type||':'||table_schema||'.'||table_name FROM information_schema.role_table_grants WHERE grantee='anon' AND table_schema='public' ORDER BY 1`),
    rowCounts,
    extensions: q(`SELECT extname FROM pg_extension ORDER BY 1`),
    // The shim creates no bucket table. B0-15 is a HOSTED question; the
    // rehearsal declares the bucket present rather than pretending to measure
    // it, and lists that among its shims.
    storageBuckets: ['uellix-evidence'],
    storagePolicies: [
      { schemaname: 'storage', tablename: 'objects', policyname: 'select_evidence', roles: '{authenticated}', cmd: 'SELECT', qual: "((bucket_id = 'uellix-evidence'::text) AND public.can_read_evidence_object(name, auth.uid()))", withCheck: null },
      { schemaname: 'storage', tablename: 'objects', policyname: 'insert_evidence', roles: '{authenticated}', cmd: 'INSERT', qual: null, withCheck: "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))" },
      { schemaname: 'storage', tablename: 'objects', policyname: 'delete_evidence', roles: '{authenticated}', cmd: 'DELETE', qual: "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))", withCheck: null },
    ],
    // B0-14 asks about a secret manager, which a disposable cluster does not have.
    environmentSecretNames: [],
    // B0-17 IS measurable here, so it is measured. Effective ACL.
    functionGrants: q(
      `SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END||':'||a.privilege_type||':'||n.nspname||'.'||p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE n.nspname='public' AND a.privilege_type='EXECUTE' ORDER BY 1`,
    ),
    // B0-18 is NOT measurable here: the journal is written by the hosted
    // wrapper chain, and this rehearsal applies the raw units. Declared as the
    // conforming shape and listed among the shims.
    journal: {
      packages: [...BASELINE_ORDER],
      environments: ['staging'],
      projectRefs: [KNOWN_STAGING_PROJECT_REF],
      statuses: ['APPLIED'],
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The rehearsal                                                               */
/* -------------------------------------------------------------------------- */

export interface RehearsalResult {
  readonly image: string
  readonly container: string
  readonly network: 'none'
  readonly staleContainersRemoved: readonly string[]
  readonly pristine: PristineCheck
  /** RUN A — the naive Drizzle-only order. Must fail at 0039. */
  readonly naiveFailedAt: string | null
  readonly naiveError: string | null
  /** RUN N1 — manifest order without identities. Must fail at 0042 / 42704. */
  readonly noRoleFailedAt: string | null
  readonly noRoleSqlstate: string | null
  readonly noRoleApplied: number
  readonly uellixRolesAfterControls: readonly string[]
  /** IDENTITY — stella_hosted_0000. */
  readonly identityPackage: string
  readonly identityPackageSha256: string
  readonly identityApplied: boolean
  readonly identityError: string | null
  readonly topology: TopologyCheck
  readonly applicationTablesAfterIdentity: number
  /** RUN B — the manifest order. Must complete. */
  readonly manifestApplied: number
  readonly manifestFailedAt: string | null
  readonly manifestError: string | null
  readonly manifestAppliedUnits: readonly string[]
  readonly unit0042Applied: boolean
  readonly unit0044Applied: boolean
  readonly unit0045Applied: boolean
  readonly b1UnitsApplied: Readonly<Record<string, boolean>>
  readonly stellaSuggestionDecisionsPresent: boolean
  readonly unconditional0044TriggersPresent: boolean
  readonly conditionalTriggerPresent: boolean
  /** GUARD — the unconditional statement against the table-absent database. */
  readonly guardMutationSqlstate: string | null
  /** CHECKPOINT B0. */
  readonly postconditions: readonly { id: string; passed: boolean; detail: string }[]
  /** S1 — stella_hosted_0001 post-baseline. */
  readonly postBaselineBootstrapApplied: boolean
  readonly postBaselineBootstrapError: string | null
  readonly postBaselineOwnership: { bootstrapSchemaOwner: string | null; ledgerOwner: string | null; shimPresent: boolean; sentinelRows: number | null }
  /** PRESENT — 0044 with the relation pre-existing. */
  readonly tablePresentTriggerCreated: boolean
  readonly tablePresentError: string | null
  readonly shimmed: readonly string[]
  readonly manifestDigest: string
  readonly leftovers: readonly string[]
}

export function runRehearsal(): RehearsalResult {
  const staleContainersRemoved = removeStaleRehearsalContainers()
  const container = startCluster()
  console.log(`[rehearsal] image ${REHEARSAL_IMAGE}`)
  console.log(`[rehearsal] container ${container} (--network none)`)

  const readSql = (file: string): string | null => {
    try {
      return readFileSync(path.join(ROOT, file), 'utf8')
    } catch {
      return null
    }
  }
  const naiveOrder = BASELINE_UNITS.filter((u) => u.kind === 'drizzle-migration').map((u) => u.file)
  const manifestOrder = BASELINE_UNITS.map((u) => u.file)
  const identitySql = readSql(MANAGED_ROLE_IDENTITY_PACKAGE.file)
  const identitySha = identitySql === null ? '' : sha256OfSql(identitySql)

  try {
    /* PRISTINE. The control every later claim depends on. */
    const pristine = checkPristine(container)
    console.log(`[rehearsal] PRISTINE: ${pristine.detail}`)
    if (!pristine.ok) {
      throw new Error(`REHEARSAL_REFUSED_NOT_PRISTINE: ${pristine.detail}`)
    }

    /* RUN A — the naive order. Must fail at 0039. */
    console.log(`[rehearsal] RUN A: the naive order, ${naiveOrder.length} Drizzle units only`)
    createDatabase(container, DB_NAIVE)
    const naive = applyUnits(container, DB_NAIVE, naiveOrder)
    console.log(naive.failedUnit === null ? '[rehearsal]   RUN A completed — which is a FAILURE of this rehearsal.' : `[rehearsal]   failed at ${naive.failedUnit} after ${naive.applied} unit(s) (${naive.sqlstate ?? '?'})`)

    /* RUN N1 — manifest order WITHOUT identities. Must fail at 0042 / 42704. */
    console.log(`[rehearsal] RUN N1: the manifest order without the role identities`)
    createDatabase(container, DB_NOROLE)
    const noRole = applyUnits(container, DB_NOROLE, manifestOrder)
    console.log(noRole.failedUnit === null ? '[rehearsal]   RUN N1 completed — which is a FAILURE of this rehearsal.' : `[rehearsal]   failed at ${noRole.failedUnit} after ${noRole.applied} unit(s) (${noRole.sqlstate ?? '?'})`)
    const uellixRolesAfterControls = uellixRoles(container)

    /* IDENTITY — stella_hosted_0000 as the non-superuser installer. */
    console.log(`[rehearsal] IDENTITY: ${MANAGED_ROLE_IDENTITY_PACKAGE.id}`)
    createDatabase(container, DB_MANIFEST)
    const tablesBefore = publicTableCount(container, DB_MANIFEST)
    let identityApplied = false
    let identityError: string | null = null
    const pin = verifyRoleIdentityPackage(identitySql)
    if (!pin.ok) {
      identityError = pin.detail
    } else {
      try {
        psql(container, DB_MANIFEST, identitySql as string, { env: true })
        identityApplied = true
      } catch (error) {
        identityError = failureOf(error).message
      }
    }
    const topology = identityApplied ? checkTopology(container) : { ok: false, problems: ['identity package did not apply'] }
    const applicationTablesAfterIdentity = publicTableCount(container, DB_MANIFEST)
    console.log(`[rehearsal]   applied=${identityApplied} topology=${topology.ok ? 'canonical' : topology.problems.join('; ')} tables=${tablesBefore}->${applicationTablesAfterIdentity}`)

    /* RUN B — the manifest order. Must complete. */
    console.log(`[rehearsal] RUN B: the manifest order, ${manifestOrder.length} units`)
    const manifest = identityApplied ? applyUnits(container, DB_MANIFEST, manifestOrder) : { applied: 0, appliedUnits: [], failedUnit: 'not attempted', sqlstate: null, error: 'identity package did not apply' }
    console.log(`[rehearsal]   applied ${manifest.applied}/${manifestOrder.length}`)
    if (manifest.failedUnit) console.log(`[rehearsal]   FAILED at ${manifest.failedUnit}: ${manifest.error}`)
    const applied = new Set(manifest.appliedUnits)

    const stellaSuggestionDecisionsPresent =
      query(container, DB_MANIFEST, `SELECT (to_regclass('public.stella_suggestion_decisions') IS NOT NULL)::text`)[0] === 'true'
    const unconditional0044TriggersPresent = UNCONDITIONAL_0044_TRIGGERS.every((t) =>
      query(container, DB_MANIFEST, `SELECT count(*) FROM pg_trigger WHERE tgname = '${t}' AND NOT tgisinternal`)[0] === '1',
    )
    const conditionalTriggerPresent =
      query(container, DB_MANIFEST, `SELECT count(*) FROM pg_trigger WHERE tgname = '${CONDITIONAL_TRIGGER}' AND NOT tgisinternal`)[0] === '1'

    /* GUARD — prove the guard is load-bearing: the unconditional form raises 42P01. */
    let guardMutationSqlstate: string | null = null
    try {
      psql(container, DB_MANIFEST, `DROP TRIGGER IF EXISTS ${CONDITIONAL_TRIGGER} ON stella_suggestion_decisions;`)
    } catch (error) {
      guardMutationSqlstate = failureOf(error).sqlstate
    }
    console.log(`[rehearsal] GUARD: unconditional form -> ${guardMutationSqlstate ?? 'no error (FAILURE)'}`)

    /* CHECKPOINT B0, before the bootstrap — that is where B0 sits in the sequence. */
    let postconditions: { id: string; passed: boolean; detail: string }[] = []
    if (manifest.failedUnit === null) {
      const observed = observe(container, DB_MANIFEST)
      const expected = deriveExpectedBaselineState(readSql)
      postconditions = evaluateBaselinePostconditions(observed, expected).map((r) => ({ id: r.id, passed: r.passed, detail: r.detail }))
      const failed = postconditions.filter((p) => !p.passed)
      console.log(`[rehearsal] CHECKPOINT B0: ${postconditions.length - failed.length}/${postconditions.length} postconditions pass`)
      for (const f of failed) console.log(`[rehearsal]   FAIL ${f.id}: ${f.detail}`)
    }

    /* S1 — stella_hosted_0001 post-baseline, against the roles that already exist. */
    let postBaselineBootstrapApplied = false
    let postBaselineBootstrapError: string | null = null
    if (manifest.failedUnit === null) {
      try {
        psql(container, DB_MANIFEST, readFileSync(path.join(ROOT, POST_BASELINE_BOOTSTRAP), 'utf8'), { env: true })
        postBaselineBootstrapApplied = true
      } catch (error) {
        postBaselineBootstrapError = failureOf(error).message
      }
    }
    const postBaselineOwnership = {
      bootstrapSchemaOwner: query(container, DB_MANIFEST, `SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'uellix_bootstrap'`)[0] ?? null,
      ledgerOwner: query(container, DB_MANIFEST, `SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass('public.stella_interactions')`)[0] ?? null,
      shimPresent: query(container, DB_MANIFEST, `SELECT (to_regprocedure('public.uellix_auth_uid()') IS NOT NULL)::text`)[0] === 'true',
      sentinelRows: postBaselineBootstrapApplied ? Number(query(container, DB_MANIFEST, `SELECT count(*) FROM uellix_bootstrap.staging_sentinel`)[0] ?? '0') : null,
    }
    console.log(`[rehearsal] S1: applied=${postBaselineBootstrapApplied} schemaOwner=${postBaselineOwnership.bootstrapSchemaOwner} ledgerOwner=${postBaselineOwnership.ledgerOwner} shim=${postBaselineOwnership.shimPresent}`)
    if (postBaselineBootstrapError) console.log(`[rehearsal]   ${postBaselineBootstrapError}`)

    /* PRESENT — 0044 with the relation pre-existing: the conditional trigger IS created. */
    let tablePresentTriggerCreated = false
    let tablePresentError: string | null = null
    if (identityApplied) {
      createDatabase(container, DB_PRESENT)
      const idx = manifestOrder.findIndex((f) => f.endsWith(UNIT_0044))
      const before = applyUnits(container, DB_PRESENT, manifestOrder.slice(0, idx))
      if (before.failedUnit !== null) {
        tablePresentError = `prefix failed at ${before.failedUnit}: ${before.error}`
      } else {
        // A STAND-IN for the gate-managed table (stella_0003 creates the real
        // one). The control is about the trigger branch, not the table shape.
        psql(container, DB_PRESENT, `CREATE TABLE public.stella_suggestion_decisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid());`)
        const rest = applyUnits(container, DB_PRESENT, manifestOrder.slice(idx))
        if (rest.failedUnit !== null) tablePresentError = `failed at ${rest.failedUnit}: ${rest.error}`
        tablePresentTriggerCreated = triggerExists(container, DB_PRESENT, CONDITIONAL_TRIGGER, 'stella_suggestion_decisions')
      }
    }
    console.log(`[rehearsal] PRESENT: conditional trigger created=${tablePresentTriggerCreated}${tablePresentError ? ` (${tablePresentError})` : ''}`)

    return {
      image: REHEARSAL_IMAGE,
      container,
      network: 'none',
      staleContainersRemoved,
      pristine,
      naiveFailedAt: naive.failedUnit,
      naiveError: naive.error,
      noRoleFailedAt: noRole.failedUnit,
      noRoleSqlstate: noRole.sqlstate,
      noRoleApplied: noRole.applied,
      uellixRolesAfterControls,
      identityPackage: MANAGED_ROLE_IDENTITY_PACKAGE.id,
      identityPackageSha256: identitySha,
      identityApplied,
      identityError,
      topology,
      applicationTablesAfterIdentity,
      manifestApplied: manifest.applied,
      manifestFailedAt: manifest.failedUnit,
      manifestError: manifest.error,
      manifestAppliedUnits: manifest.appliedUnits,
      unit0042Applied: applied.has(UNIT_0042),
      unit0044Applied: applied.has(UNIT_0044),
      unit0045Applied: applied.has(UNIT_0045),
      b1UnitsApplied: Object.fromEntries(B1_UNITS.map((u) => [u, applied.has(u)])),
      stellaSuggestionDecisionsPresent,
      unconditional0044TriggersPresent,
      conditionalTriggerPresent,
      guardMutationSqlstate,
      postconditions,
      postBaselineBootstrapApplied,
      postBaselineBootstrapError,
      postBaselineOwnership,
      tablePresentTriggerCreated,
      tablePresentError,
      shimmed: [
        'schema auth (auth.users, auth.uid()) — owned by supabase_auth_admin on a real project',
        'schema storage (storage.objects, storage.foldername()) — owned by supabase_storage_admin',
        'schema extensions — provided by the platform on a real project',
        'B0-15 (uellix-evidence bucket) is ASSERTED, not measured: a disposable cluster has no Storage',
        'B0-14 (no SUPABASE_SERVICE_ROLE_KEY) is ASSERTED, not measured: no secret manager here',
        'B0-18 (journal) is ASSERTED, not measured: the raw units are applied, not their journal wrappers',
        'the stella_suggestion_decisions table in the PRESENT control is a one-column stand-in for the gate-managed table',
      ],
      manifestDigest: baselineManifestDigest(),
      leftovers: [],
    }
  } finally {
    // TEARDOWN runs even on a throw. The whole cluster goes, so no database and
    // no role can outlive the rehearsal.
    destroyCluster(container)
    console.log('[rehearsal] teardown: disposable cluster removed')
  }
}

if (import.meta.filename === process.argv[1]) {
  const result = runRehearsal()
  const leftovers = leftoverContainers()

  console.log('')
  console.log('='.repeat(78))
  console.log('SHIMMED — none of this exists on a real managed project as OUR object:')
  for (const s of result.shimmed) console.log(`  - ${s}`)
  console.log('A green run proves ORDER and INTERNAL CONSISTENCY on a role-pristine cluster.')
  console.log('It proves nothing about managed-Supabase privileges. See the header of this file.')
  console.log('='.repeat(78))

  const pristine = result.pristine.ok
  const naiveFailedAsExpected = result.naiveFailedAt === 'db/migrations/0039_grant_rls_helper_execution.sql'
  const noRoleFailedAsExpected = result.noRoleFailedAt === `db/migrations/${UNIT_0042}` && result.noRoleSqlstate === '42704'
  const identityOk = result.identityApplied && result.topology.ok && result.applicationTablesAfterIdentity === 0
  const manifestSucceeded = result.manifestFailedAt === null && result.manifestApplied === BASELINE_UNITS.length
  const guardOk = !result.stellaSuggestionDecisionsPresent && result.unconditional0044TriggersPresent && !result.conditionalTriggerPresent && result.guardMutationSqlstate === '42P01'
  const b0 = result.postconditions.every((p) => p.passed) && result.postconditions.length > 0
  const s1 = result.postBaselineBootstrapApplied && result.postBaselineOwnership.bootstrapSchemaOwner === 'uellix_owner' && result.postBaselineOwnership.ledgerOwner === 'uellix_owner' && result.postBaselineOwnership.shimPresent && result.postBaselineOwnership.sentinelRows === 0
  const present = result.tablePresentTriggerCreated && result.tablePresentError === null
  const clean = leftovers.length === 0

  console.log(`PRISTINE cluster (0 uellix_* roles)          : ${pristine}`)
  console.log(`RUN A failed at 0039 as predicted           : ${naiveFailedAsExpected}`)
  console.log(`RUN N1 failed at 0042 with 42704            : ${noRoleFailedAsExpected}`)
  console.log(`IDENTITY applied, canonical, 0 tables       : ${identityOk}`)
  console.log(`RUN B applied all ${BASELINE_UNITS.length} units               : ${manifestSucceeded}`)
  console.log(`0044 guard: absent table, 5 triggers, 42P01 : ${guardOk}`)
  console.log(`CHECKPOINT B0 clean                         : ${b0}`)
  console.log(`S1 post-baseline bootstrap                  : ${s1}`)
  console.log(`PRESENT control created the 6th trigger     : ${present}`)
  console.log(`0 leftover containers                       : ${clean}`)

  mkdirSync(path.join(ROOT, path.dirname(REHEARSAL_ARTEFACT)), { recursive: true })
  writeFileSync(
    path.join(ROOT, REHEARSAL_ARTEFACT),
    `${JSON.stringify(
      {
        manifestDigest: result.manifestDigest,
        naiveFailedAt: result.naiveFailedAt,
        manifestApplied: result.manifestApplied,
        manifestFailedAt: result.manifestFailedAt,
        postconditionsPassed: result.postconditions.filter((p) => p.passed).length,
        postconditionsTotal: result.postconditions.length,
        // By id, so a red checkpoint names its reason in the artefact rather
        // than only in a console line that scrolled away.
        postconditionsFailed: result.postconditions.filter((p) => !p.passed).map((p) => ({ id: p.id, detail: p.detail })),
        shimmed: result.shimmed,
        sequence: ['PLATFORM_SUBSTRATE', 'PHASE_MANAGED_ROLE_IDENTITIES', 'PHASE_BASELINE', 'PHASE_STELLA_BOOTSTRAP'],
        cluster: { image: result.image, network: result.network, pristine: result.pristine.detail, uellixRolesAtStart: result.pristine.uellixRoles },
        noRoleControl: { failedAt: result.noRoleFailedAt, sqlstate: result.noRoleSqlstate, applied: result.noRoleApplied },
        identity: { package: result.identityPackage, sha256: result.identityPackageSha256, applied: result.identityApplied, topologyCanonical: result.topology.ok, applicationTablesAfter: result.applicationTablesAfterIdentity },
        units: { '0042': result.unit0042Applied, '0044': result.unit0044Applied, '0045': result.unit0045Applied, ...result.b1UnitsApplied },
        guard0044: { stellaSuggestionDecisionsPresent: result.stellaSuggestionDecisionsPresent, unconditionalTriggersPresent: result.unconditional0044TriggersPresent, conditionalTriggerPresent: result.conditionalTriggerPresent, unconditionalFormSqlstate: result.guardMutationSqlstate },
        postBaselineBootstrap: { applied: result.postBaselineBootstrapApplied, ...result.postBaselineOwnership },
        tablePresentControl: { conditionalTriggerCreated: result.tablePresentTriggerCreated },
        leftovers: leftovers,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\nrecorded: ${REHEARSAL_ARTEFACT}`)

  process.exit(pristine && naiveFailedAsExpected && noRoleFailedAsExpected && identityOk && manifestSucceeded && guardOk && b0 && s1 && present && clean ? 0 : 1)
}
