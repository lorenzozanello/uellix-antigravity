// scripts/recovery/capture.ts — the logical backup capture primitive
// (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-1; authority RM-2,
// AO-3, AO-4, ADJUDICATIONS.H, CAPABILITY.DATABASE_PLANE).
//
// ORDER, and why each step precedes the next:
//
//   1. identity      — the source is a LOCAL_DISPOSABLE container this run owns.
//                      A HOSTED_STAGING source is REFUSED here: this mechanism has
//                      no hosted grant, and its principal is
//                      BLOCKED_PENDING_AUTHORIZED_REACHABILITY_PROOF (below).
//   2. location      — the artifact directory is outside the repository.
//   3. tool pin      — image id, pg_dump version, source server version.
//   4. principal     — the capture role AND EVERY ROLE IT CAN BECOME are verified
//                      read-only by catalog predicates, as itself, before a
//                      single row is read.
//   5. pre-census    — the source observation the restore is later judged by.
//   6. scope closure — every extension an in-scope object depends on is
//                      declared (pg_dump -n does NOT emit CREATE EXTENSION on
//                      its own — measured), every declared schema exists.
//   7. pg_dump -Fc   — streamed to the file and hashed on the stream.
//   8. post-census   — equality with 5 is recorded as a FACT. Whether equality
//                      is REQUIRED (S8 / OD-3 per event class) is not decided here.
//   9. packet        — built by buildBackupPacket (six frozen contents), then
//                      validated, together with the bound census record.
//
// Any failure after the artifact file exists deletes it: a half-written dump is
// still a copy of source data (RETENTION_AND_DISPOSAL).

import { existsSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import {
  buildBackupPacket,
  classifyData,
  validateBackupPacket,
  validateSourceCensusRecord,
  type BackupPacket,
  type DataClassification,
  type DeclaredScope,
  type SourceCensusRecord,
} from './artifact-packet'
import { checkArtifactLocation } from './artifact-integrity'
import { censusInvocation, parseCensusResult, type Census } from './catalog-census'
import { classifyToolOutcome, extractSqlstate, type GrammarViolation } from './evidence-privacy'
import type { DockerCli, ProcessResult } from './process'
import type { RecoveryIdentity } from './recovery-target'
import { assertSubstrateOwnership, SubstrateRefusal } from './substrate'
import { evaluateToolPin, parseToolVersion, RECOVERY_TOOL_PIN, type ToolRefusal } from './tool-pin'

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/
const CODE = /^[A-Z][A-Z0-9_]{1,95}$/

export interface CapturePrincipal {
  roleName: string
  /**
   * LOCAL_DISPOSABLE_FIXTURE_ROLE — a role the disposable source fixture created.
   * AUTHORITY_SUPPLIED — reserved for a future execution authority; refused today.
   */
  provenance: 'LOCAL_DISPOSABLE_FIXTURE_ROLE' | 'AUTHORITY_SUPPLIED'
}

/**
 * The hosted capture principal's status under THIS mechanism. Proving that a
 * hosted role cannot SET ROLE into a write-capable identity needs catalog reads
 * against the authorized target that no current authority grants (the recovery
 * authority's AUTHORIZED_OPERATIONS name no such read). Until an execution
 * authority supplies an authorized reachability proof, the answer is fixed.
 */
export const HOSTED_PRINCIPAL_STATUS = 'BLOCKED_PENDING_AUTHORIZED_REACHABILITY_PROOF' as const

export interface CaptureRequest {
  source: RecoveryIdentity
  database: string
  principal: CapturePrincipal
  scope: DeclaredScope
  /** Opaque DDL event-class code, carried verbatim. Never interpreted. */
  eventClass: string | null
  declaredClassification: DataClassification
  /** FRESHNESS criterion 4: the SHA of this tooling, when the caller measured a clean tree. */
  toolingSha?: string | null
  releaseSha?: string | null
  migrationCorpusPacketSha256?: string | null
  artifactDir: string
  repoRoot: string
}

export type CaptureRefusalCode =
  | 'RECOVERY_HOSTED_CAPTURE_NOT_AUTHORIZED'
  | 'CAPTURE_PRINCIPAL_PROVENANCE_REFUSED'
  | 'CAPTURE_REQUEST_GRAMMAR'
  | 'CAPTURE_SOURCE_NOT_OWNED'
  | 'CAPTURE_ARTIFACT_LOCATION_REFUSED'
  | 'CAPTURE_TOOL_PIN_REFUSED'
  | 'CAPTURE_PRINCIPAL_REFUSED'
  | 'CAPTURE_CENSUS_FAILED'
  | 'CAPTURE_SCOPE_SCHEMA_ABSENT'
  | 'CAPTURE_SCOPE_EXTENSION_UNDECLARED'
  | 'CAPTURE_SCOPE_EXTENSION_ABSENT'
  | 'CAPTURE_TOOL_FAILED'
  | 'CAPTURE_PACKET_GRAMMAR'

export type CaptureOutcome =
  | { ok: true; packet: BackupPacket; sourceCensus: SourceCensusRecord; artifactPath: string }
  | {
      ok: false
      code: CaptureRefusalCode
      detail: string
      hostedPrincipalStatus?: typeof HOSTED_PRINCIPAL_STATUS
      toolRefusals?: ToolRefusal[]
      principalRefusals?: PrincipalRefusalCode[]
      violations?: GrammarViolation[]
      /** True when an artifact file was created and then deleted. */
      partialArtifactDeleted?: boolean
    }

// ---------------------------------------------------------------------------
// Capture principal verification (pure evaluation over a catalog observation)
// ---------------------------------------------------------------------------

/** A role the principal can BECOME: any membership chain, whatever its INHERIT / SET / ADMIN options. */
export interface ReachableRole {
  name: string
  rolsuper: boolean
  rolcreaterole: boolean
  rolcreatedb: boolean
  write_privileged_relations: number
  schema_create: number
}

export interface PrincipalObservation {
  role: string
  rolsuper: boolean
  rolcreaterole: boolean
  rolcreatedb: boolean
  rolbypassrls: boolean
  write_all_member: boolean
  relation_count: number
  write_privileged_relations: number
  unselectable_relations: number
  schema_create: number
  schema_no_usage: number
  rls_relations: number
  reachable_roles: ReachableRole[]
}

export type PrincipalRefusalCode =
  | 'PRINCIPAL_IDENTITY_MISMATCH'
  | 'PRINCIPAL_SUPERUSER'
  | 'PRINCIPAL_CAN_CREATE_ROLES_OR_DATABASES'
  | 'PRINCIPAL_WRITE_ALL_DATA_MEMBER'
  | 'PRINCIPAL_WRITE_PRIVILEGE_IN_SCOPE'
  | 'PRINCIPAL_CREATE_ON_SCOPE_SCHEMA'
  | 'PRINCIPAL_CANNOT_READ_SCOPE'
  | 'PRINCIPAL_NO_BYPASSRLS_WITH_RLS_IN_SCOPE'
  | 'PRINCIPAL_SCOPE_EMPTY'
  | 'PRINCIPAL_REACHABILITY_UNKNOWN'
  | 'PRINCIPAL_REACHES_UNSAFE_PREDEFINED_ROLE'
  | 'PRINCIPAL_REACHES_SUPERUSER'
  | 'PRINCIPAL_REACHES_ROLE_OR_DB_CREATOR'
  | 'PRINCIPAL_REACHES_WRITE_PRIVILEGE'
  | 'PRINCIPAL_REACHES_CREATE_ON_SCOPE_SCHEMA'

/**
 * The only predefined (pg_*) role a capture principal may be able to become.
 * Everything else under the reserved pg_ prefix is refused unevaluated:
 * pg_write_all_data, pg_write_server_files and pg_execute_server_program write
 * by definition, and a closed allowlist fails closed on any role added later.
 */
export const SAFE_PREDEFINED_ROLES: readonly string[] = ['pg_read_all_data']

/**
 * The CAPTURE_PRINCIPAL_CONTRACT, closed under role reachability.
 *
 * Effective privileges alone are NOT enough — measured by the recert of
 * ec573e9b: a principal granted a writer role WITH INHERIT FALSE, SET TRUE
 * passes every has_table_privilege predicate and then writes after SET ROLE.
 * NOINHERIT does not help either: it removes inherited privileges, not the
 * ability to SET ROLE. Measured here as well: a grant WITH ADMIN TRUE, INHERIT
 * FALSE, SET FALSE lets the principal re-grant itself SET and become the role.
 * So every role reachable through ANY membership chain (pg_has_role MEMBER,
 * which follows grants regardless of their INHERIT/SET/ADMIN options) is held
 * to the same predicates as the principal. Every failure is reported.
 */
export function evaluatePrincipal(expectedRole: string, o: PrincipalObservation): PrincipalRefusalCode[] {
  const out: PrincipalRefusalCode[] = []
  if (o.role !== expectedRole) out.push('PRINCIPAL_IDENTITY_MISMATCH')
  if (o.rolsuper) out.push('PRINCIPAL_SUPERUSER')
  if (o.rolcreaterole || o.rolcreatedb) out.push('PRINCIPAL_CAN_CREATE_ROLES_OR_DATABASES')
  if (o.write_all_member) out.push('PRINCIPAL_WRITE_ALL_DATA_MEMBER')
  if (o.write_privileged_relations > 0) out.push('PRINCIPAL_WRITE_PRIVILEGE_IN_SCOPE')
  if (o.schema_create > 0) out.push('PRINCIPAL_CREATE_ON_SCOPE_SCHEMA')
  if (o.unselectable_relations > 0 || o.schema_no_usage > 0) out.push('PRINCIPAL_CANNOT_READ_SCOPE')
  if (o.rls_relations > 0 && !o.rolbypassrls) out.push('PRINCIPAL_NO_BYPASSRLS_WITH_RLS_IN_SCOPE')
  if (o.relation_count === 0) out.push('PRINCIPAL_SCOPE_EMPTY')
  if (!Array.isArray(o.reachable_roles) || !o.reachable_roles.every(isReachableRole)) {
    out.push('PRINCIPAL_REACHABILITY_UNKNOWN')
    return out
  }
  const add = (code: PrincipalRefusalCode) => {
    if (!out.includes(code)) out.push(code)
  }
  for (const r of o.reachable_roles) {
    if (r.name.startsWith('pg_')) {
      if (!SAFE_PREDEFINED_ROLES.includes(r.name)) add('PRINCIPAL_REACHES_UNSAFE_PREDEFINED_ROLE')
      continue
    }
    if (r.rolsuper) add('PRINCIPAL_REACHES_SUPERUSER')
    if (r.rolcreaterole || r.rolcreatedb) add('PRINCIPAL_REACHES_ROLE_OR_DB_CREATOR')
    if (r.write_privileged_relations > 0) add('PRINCIPAL_REACHES_WRITE_PRIVILEGE')
    if (r.schema_create > 0) add('PRINCIPAL_REACHES_CREATE_ON_SCOPE_SCHEMA')
  }
  return out
}

function isReachableRole(v: unknown): v is ReachableRole {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.name === 'string' &&
    ['rolsuper', 'rolcreaterole', 'rolcreatedb'].every((k) => typeof r[k] === 'boolean') &&
    ['write_privileged_relations', 'schema_create'].every((k) => Number.isSafeInteger(r[k]))
  )
}

/**
 * Run AS the principal. Relation and role predicates use OIDs, never names (no
 * absent-object errors).
 *
 * COLUMN GRANTS. has_table_privilege sees only TABLE-level grants: measured by
 * the recert of 2b254ab8, GRANT UPDATE (note) ON a table let a principal write
 * while every table predicate stayed false. Of the privileges the frozen
 * predicate lists (INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER),
 * PostgreSQL grants exactly INSERT, UPDATE and REFERENCES per column, so
 * has_any_column_privilege is checked for exactly those three, for the
 * principal AND for every reachable role. Nothing outside the frozen list
 * (sequence USAGE, MAINTAIN, CREATE ON DATABASE) is decided here — those are
 * open authority questions, reported, not silently chosen. `reachable` is every role other than the principal
 * that pg_has_role(..., 'MEMBER') says it belongs to through any chain.
 */
export const PRINCIPAL_SQL = String.raw`
BEGIN READ ONLY;
WITH scope AS (
  SELECT unnest(string_to_array(:'scope_schemas', ','))::name AS nspname
), ns AS (
  SELECT n.oid FROM pg_namespace n JOIN scope s ON s.nspname = n.nspname
), rel AS (
  SELECT c.oid, c.relkind, c.relrowsecurity FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','S','f')
), me AS (
  SELECT oid FROM pg_roles WHERE rolname = current_user
), reachable AS (
  SELECT r.oid, r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb
  FROM pg_roles r, me WHERE r.oid <> me.oid AND pg_has_role(me.oid, r.oid, 'MEMBER')
)
SELECT json_build_object(
  'role', current_user,
  'rolsuper', r.rolsuper, 'rolcreaterole', r.rolcreaterole, 'rolcreatedb', r.rolcreatedb, 'rolbypassrls', r.rolbypassrls,
  'write_all_member', pg_has_role(current_user, 'pg_write_all_data', 'MEMBER'),
  'relation_count', (SELECT count(*) FROM rel),
  'write_privileged_relations', (SELECT count(*) FROM rel WHERE
      (relkind <> 'S' AND has_table_privilege(oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
   OR (relkind <> 'S' AND has_any_column_privilege(oid, 'INSERT,UPDATE,REFERENCES'))
   OR (relkind = 'S' AND has_sequence_privilege(oid, 'UPDATE'))),
  'unselectable_relations', (SELECT count(*) FROM rel WHERE
      (relkind <> 'S' AND NOT has_table_privilege(oid, 'SELECT'))
   OR (relkind = 'S' AND NOT has_sequence_privilege(oid, 'SELECT'))),
  'schema_create', (SELECT count(*) FROM ns WHERE has_schema_privilege(oid, 'CREATE')),
  'schema_no_usage', (SELECT count(*) FROM ns WHERE NOT has_schema_privilege(oid, 'USAGE')),
  'rls_relations', (SELECT count(*) FROM rel WHERE relrowsecurity),
  'reachable_roles', (SELECT coalesce(json_agg(json_build_object(
      'name', x.rolname, 'rolsuper', x.rolsuper, 'rolcreaterole', x.rolcreaterole, 'rolcreatedb', x.rolcreatedb,
      'write_privileged_relations', (SELECT count(*) FROM rel WHERE
          (relkind <> 'S' AND has_table_privilege(x.oid, rel.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
       OR (relkind <> 'S' AND has_any_column_privilege(x.oid, rel.oid, 'INSERT,UPDATE,REFERENCES'))
       OR (relkind = 'S' AND has_sequence_privilege(x.oid, rel.oid, 'UPDATE'))),
      'schema_create', (SELECT count(*) FROM ns WHERE has_schema_privilege(x.oid, ns.oid, 'CREATE'))
    ) ORDER BY x.rolname), '[]'::json) FROM reachable x)
) FROM pg_roles r WHERE r.rolname = current_user;
COMMIT;
`

/** psql AS the capture principal over the source container's loopback (never the host network). */
function principalPsql(docker: DockerCli, containerId: string, role: string, database: string, extra: string[], stdin: string): ProcessResult {
  return docker.run(['exec', '-i', containerId, 'psql', '-X', '-h', '127.0.0.1', '-U', role, '-d', database, '-w', ...extra], stdin)
}

function firstJsonLine(stdout: string): unknown {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('{'))
  if (!line) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function isPrincipalObservation(v: unknown): v is PrincipalObservation {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  const bools = ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolbypassrls', 'write_all_member']
  const ints = ['relation_count', 'write_privileged_relations', 'unselectable_relations', 'schema_create', 'schema_no_usage', 'rls_relations']
  // reachable_roles is NOT required here: its absence must reach evaluatePrincipal as REACHABILITY_UNKNOWN.
  return typeof o.role === 'string' && bools.every((k) => typeof o[k] === 'boolean') && ints.every((k) => Number.isSafeInteger(o[k]))
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export async function captureLogicalBackup(docker: DockerCli, req: CaptureRequest): Promise<CaptureOutcome> {
  // 1. Identity.
  if (req.source.identityClass === 'HOSTED_STAGING') {
    return {
      ok: false,
      code: 'RECOVERY_HOSTED_CAPTURE_NOT_AUTHORIZED',
      detail: 'this mechanism holds no hosted grant, and no authorized reachability proof for a hosted capture principal exists',
      hostedPrincipalStatus: HOSTED_PRINCIPAL_STATUS,
    }
  }
  if (req.principal.provenance !== 'LOCAL_DISPOSABLE_FIXTURE_ROLE') {
    return { ok: false, code: 'CAPTURE_PRINCIPAL_PROVENANCE_REFUSED', detail: 'only a disposable fixture role is accepted by the offline mechanism', hostedPrincipalStatus: HOSTED_PRINCIPAL_STATUS }
  }
  const grammarProblems = [
    ...[req.database, req.principal.roleName, ...req.scope.schemas, ...req.scope.extensions].filter((t) => !IDENT.test(t)),
    ...(req.eventClass !== null && !CODE.test(req.eventClass) ? ['event_class'] : []),
  ]
  if (grammarProblems.length > 0 || req.scope.schemas.length === 0) {
    return { ok: false, code: 'CAPTURE_REQUEST_GRAMMAR', detail: 'database, principal, schemas, extensions and event class must be plain identifiers/codes' }
  }
  const source = req.source
  try {
    assertSubstrateOwnership(docker, source, 'source-fixture')
  } catch (error) {
    // An owned container on the wrong image is a TOOL skew (the capture tool
    // is that image's pg_dump), reported as such rather than as ownership.
    if (error instanceof SubstrateRefusal && error.code === 'SUBSTRATE_IMAGE_NOT_PINNED') {
      return { ok: false, code: 'CAPTURE_TOOL_PIN_REFUSED', detail: 'TOOL_IMAGE_ID_MISMATCH', toolRefusals: [{ code: 'TOOL_IMAGE_ID_MISMATCH', field: 'imageId' }] }
    }
    return { ok: false, code: 'CAPTURE_SOURCE_NOT_OWNED', detail: error instanceof SubstrateRefusal ? error.code : 'inspect failed' }
  }

  // 2. Location.
  const location = checkArtifactLocation(req.artifactDir, req.repoRoot)
  if (location && !location.ok) return { ok: false, code: 'CAPTURE_ARTIFACT_LOCATION_REFUSED', detail: location.code }
  if (!existsSync(req.artifactDir) || !statSync(req.artifactDir).isDirectory()) {
    return { ok: false, code: 'CAPTURE_ARTIFACT_LOCATION_REFUSED', detail: 'ARTIFACT_DIRECTORY_ABSENT' }
  }

  // 3. Tool pin.
  const cid = source.containerId
  const dumpVersion = docker.run(['exec', cid, 'pg_dump', '--version'])
  const serverVersion = principalPsql(docker, cid, req.principal.roleName, req.database, ['-tAq'], 'SHOW server_version_num;\n')
  const toolVerdict = evaluateToolPin(
    {
      imageId: source.imageId,
      pgDumpVersionLine: dumpVersion.status === 0 ? dumpVersion.stdout.split(/\r?\n/)[0] : null,
      sourceServerVersionNum: serverVersion.status === 0 && /^\d+$/.test(serverVersion.stdout.trim()) ? Number(serverVersion.stdout.trim()) : null,
    },
    ['imageId', 'pgDumpVersionLine', 'sourceServerVersionNum'],
  )
  if (!toolVerdict.ok) return { ok: false, code: 'CAPTURE_TOOL_PIN_REFUSED', detail: toolVerdict.refusals.map((r) => r.code).join(','), toolRefusals: toolVerdict.refusals }

  // 4. Principal, closed under role reachability.
  const scopeVars = ['-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-tAq', '-v', `scope_schemas=${req.scope.schemas.join(',')}`]
  const principalRes = principalPsql(docker, cid, req.principal.roleName, req.database, scopeVars, PRINCIPAL_SQL)
  const observation = principalRes.status === 0 ? firstJsonLine(principalRes.stdout) : null
  if (!isPrincipalObservation(observation)) {
    return { ok: false, code: 'CAPTURE_PRINCIPAL_REFUSED', detail: `principal observation failed (${classifyToolOutcome(principalRes.status, principalRes.stderr).diagnostic}, sqlstate ${extractSqlstate(principalRes.stderr) ?? 'none'})`, principalRefusals: ['PRINCIPAL_REACHABILITY_UNKNOWN'] }
  }
  const principalRefusals = evaluatePrincipal(req.principal.roleName, observation)
  if (principalRefusals.length > 0) return { ok: false, code: 'CAPTURE_PRINCIPAL_REFUSED', detail: principalRefusals.join(','), principalRefusals }

  // 5. Pre-census.
  const censusScope = { schemas: req.scope.schemas, excludedRelations: req.scope.excluded_relations }
  const runCensus = () => {
    const inv = censusInvocation(censusScope)
    return parseCensusResult(principalPsql(docker, cid, req.principal.roleName, req.database, inv.psqlArgs, inv.stdin))
  }
  const pre = runCensus()
  if (!pre.ok) return { ok: false, code: 'CAPTURE_CENSUS_FAILED', detail: pre.code, violations: pre.violations }

  // 6. Scope closure.
  const closure = scopeClosureProblem(req.scope, pre.census)
  if (closure) return closure

  // 7. pg_dump.
  const artifactPath = path.join(req.artifactDir, `uellix-recovery-${source.runId}.dump`)
  const invocation = [
    'pg_dump',
    '-h',
    '127.0.0.1',
    '-U',
    req.principal.roleName,
    '-d',
    req.database,
    '--no-password',
    '-Fc',
    ...req.scope.schemas.flatMap((s) => ['-n', s]),
    ...req.scope.excluded_relations.flatMap((r) => ['-T', r]),
    ...req.scope.extensions.flatMap((e) => ['-e', e]),
  ]
  const startedAt = new Date().toISOString()
  const dump = await docker.streamToFile(['exec', cid, ...invocation], artifactPath)
  const finishedAt = new Date().toISOString()
  const deletePartial = () => {
    rmSync(artifactPath, { force: true })
    return !existsSync(artifactPath)
  }
  if (dump.status !== 0 || dump.bytes === 0) {
    return { ok: false, code: 'CAPTURE_TOOL_FAILED', detail: `pg_dump ${classifyToolOutcome(dump.status, dump.stderr).diagnostic}`, partialArtifactDeleted: deletePartial() }
  }

  // 8. Post-census.
  const post = runCensus()
  if (!post.ok) return { ok: false, code: 'CAPTURE_CENSUS_FAILED', detail: post.code, violations: post.violations, partialArtifactDeleted: deletePartial() }

  // 9. Packet + bound census record.
  const packet = buildBackupPacket({
    identity: source,
    artifactSha256: dump.sha256,
    captureStartedAt: startedAt,
    captureFinishedAt: finishedAt,
    toolVersion: parseToolVersion(dumpVersion.stdout.split(/\r?\n/)[0], 'pg_dump') ?? '0',
    imageRefPinned: RECOVERY_TOOL_PIN.imageRef,
    imageIdObserved: source.imageId,
    toolingSha: req.toolingSha ?? null,
    invocation,
    scope: req.scope,
    preCensus: pre.census,
    postCensus: post.census,
    eventClass: req.eventClass,
    releaseSha: req.releaseSha ?? null,
    migrationCorpusPacketSha256: req.migrationCorpusPacketSha256 ?? null,
  })
  const sourceCensus: SourceCensusRecord = {
    record_class: 'SOURCE_CATALOG_CENSUS_RECORD',
    census: pre.census,
    data_classification: classifyData(source, req.declaredClassification),
  }
  const violations = [...validateBackupPacket(packet), ...validateSourceCensusRecord(sourceCensus, packet)]
  if (violations.length > 0) return { ok: false, code: 'CAPTURE_PACKET_GRAMMAR', detail: `${violations.length} grammar violation(s)`, violations, partialArtifactDeleted: deletePartial() }
  return { ok: true, packet, sourceCensus, artifactPath }
}

/** Declared schemas exist; declared extensions exist; every depended-upon extension is declared. */
export function scopeClosureProblem(scope: DeclaredScope, census: Census): CaptureOutcome | null {
  const presentSchemas = new Set(census.schemas.map((s) => s.name))
  const missing = scope.schemas.filter((s) => !presentSchemas.has(s))
  if (missing.length > 0) return { ok: false, code: 'CAPTURE_SCOPE_SCHEMA_ABSENT', detail: `${missing.length} declared schema(s) absent` }
  const presentExt = new Set(census.extensions.map((e) => e.name))
  const absentExt = scope.extensions.filter((e) => !presentExt.has(e))
  if (absentExt.length > 0) return { ok: false, code: 'CAPTURE_SCOPE_EXTENSION_ABSENT', detail: absentExt.join(',') }
  const undeclared = census.extension_dependencies.filter((e) => !scope.extensions.includes(e))
  if (undeclared.length > 0) {
    return { ok: false, code: 'CAPTURE_SCOPE_EXTENSION_UNDECLARED', detail: `in-scope objects depend on undeclared extension(s): ${undeclared.join(',')}` }
  }
  return null
}
