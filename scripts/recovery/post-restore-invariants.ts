// scripts/recovery/post-restore-invariants.ts — the post-restore invariant
// runner (STAGING_RECOVERY_OFFLINE_IMPLEMENTATION_MANIFEST_v1.0.0, S-5;
// authority POST_RESTORE_INVARIANTS PRI-1..PRI-7, EVIDENCE).
//
// "A restore is not verified by its exit status." Every invariant here compares
// the RESTORED census with the SOURCE census the BACKUP_PACKET carries, or
// asserts an absolute property the repository has already measured failing
// (RR-CAP-7). Beyond PRI-1..PRI-7 it covers the clean-room's source-derived
// additions — required extensions, sequences and identity columns, trigger
// enabled state, FORCE RLS — and nothing production-only.
//
// ORDERING IS ENFORCED, NOT CONVENTIONAL. A plan runs in three phases:
//
//   READ_ONLY                    every comparison, over ONE census taken in a
//                                READ ONLY transaction;
//   MUTATING_PROBE               the SECURITY DEFINER capability call (it
//                                writes), inside BEGIN ... ROLLBACK;
//   PROBE_ROLLBACK_VERIFICATION  a second census must equal the first, which
//                                proves the probe's writes did not survive.
//
// A plan whose phases are not non-decreasing, or whose READ_ONLY entry claims to
// mutate, is refused BEFORE anything executes (validateInvariantPlan). If a
// mutating probe could run first, the per-relation counts PRI-5 compares would
// include its writes, and a correct restore would read as corrupt — or worse, a
// compensating defect would read as correct.
//
// EVIDENCE. Each result carries the predicate it evaluated (text + sha256), the
// census SQL digest, and the RAW expected/observed facts — never a bare
// verdict. Facts are derived only from grammar-checked census fields
// (identifiers, integers, digests), so no row content can reach them.

import { createHash } from 'node:crypto'

import type { BackupPacket } from './artifact-packet'
import { CENSUS_SQL_SHA256, censusInvocation, censusSha256, parseCensusResult, type Census } from './catalog-census'
import { extractSqlstate, S, type Shape } from './evidence-privacy'
import type { DockerCli } from './process'
import type { RestoreOutcome } from './restore-runner'
import { substratePsql, type Substrate } from './substrate'

export type InvariantPhase = 'READ_ONLY' | 'MUTATING_PROBE' | 'PROBE_ROLLBACK_VERIFICATION'
export type InvariantVerdict = 'PASS' | 'FAIL' | 'UNKNOWN'

export interface InvariantResult {
  id: string
  phase: InvariantPhase
  predicate: string
  predicate_sha256: string
  census_sql_sha256: string
  verdict: InvariantVerdict
  reason_code: string | null
  expected: string[]
  observed: string[]
}

export interface CapabilityProbe {
  /** Role the probe runs as (SET LOCAL ROLE). */
  role: string
  /** `schema.function`, called with no arguments. */
  fn: string
}

export interface InvariantContext {
  packet: BackupPacket
  restored: Census | null
  restoredCensusProblem: string | null
  restore: RestoreOutcome
  probeResults: Array<{ probe: CapabilityProbe; sqlstate: string | null; exitCode: number }> | null
  rollbackCensus: { census: Census | null; problem: string | null } | null
  restoredCensusSha256: string | null
}

interface PlanEntry {
  id: InvariantResult['id']
  phase: InvariantPhase
  mutating: boolean
  predicate: string
  evaluate: (ctx: InvariantContext) => Pick<InvariantResult, 'verdict' | 'reason_code' | 'expected' | 'observed'>
}

const PHASE_RANK: Record<InvariantPhase, number> = { READ_ONLY: 0, MUTATING_PROBE: 1, PROBE_ROLLBACK_VERIFICATION: 2 }

export type PlanOrderProblem = { index: number; problem: 'PHASE_REGRESSION' | 'READ_ONLY_ENTRY_MUTATES' | 'MUTATING_ENTRY_OUTSIDE_PROBE_PHASE' | 'EMPTY_PLAN' }

/** Refuse a plan before anything runs: phases non-decreasing, mutation only in the probe phase, non-empty. */
export function validateInvariantPlan(plan: ReadonlyArray<Pick<PlanEntry, 'phase' | 'mutating'>>): PlanOrderProblem[] {
  const problems: PlanOrderProblem[] = []
  if (plan.length === 0) problems.push({ index: -1, problem: 'EMPTY_PLAN' })
  let rank = 0
  plan.forEach((entry, index) => {
    if (PHASE_RANK[entry.phase] < rank) problems.push({ index, problem: 'PHASE_REGRESSION' })
    rank = Math.max(rank, PHASE_RANK[entry.phase])
    if (entry.phase === 'READ_ONLY' && entry.mutating) problems.push({ index, problem: 'READ_ONLY_ENTRY_MUTATES' })
    if (entry.mutating && entry.phase !== 'MUTATING_PROBE') problems.push({ index, problem: 'MUTATING_ENTRY_OUTSIDE_PROBE_PHASE' })
  })
  return problems
}

// ---------------------------------------------------------------------------
// Fact formatters — the ONLY way census content becomes evidence.
// ---------------------------------------------------------------------------

const relFacts = (c: Census) => c.relations.map((r) => `${r.schema}.${r.name}:${r.kind}:owner=${r.owner}:acl=${r.acl_sha256}`)
const fnFacts = (c: Census) => c.functions.map((f) => `fn:${f.schema}.${f.name}:args=${f.identity_args_sha256}:secdef=${f.security_definer}:owner=${f.owner}:acl=${f.acl_sha256}`)
const schemaFacts = (c: Census) => c.schemas.map((s) => `${s.name}:owner=${s.owner}:acl=${s.acl.join('|').replace(/ /g, '+')}`)
const countFacts = (c: Census) => c.row_counts.map((r) => `${r.schema}.${r.name}:rows=${r.rows}`)
const rlsFacts = (c: Census) => c.relations.filter((r) => r.kind === 'r' || r.kind === 'p').map((r) => `${r.schema}.${r.name}:rls=${r.rls}:force=${r.force_rls}`)
const policyFacts = (c: Census) =>
  c.policies.map((p) => `policy:${p.schema}.${p.table}.${p.name}:cmd=${p.command}:perm=${p.permissive}:roles=${p.roles.join(',')}:qual=${p.qual_sha256 ?? 'null'}:check=${p.with_check_sha256 ?? 'null'}`)
const seqFacts = (c: Census) => c.sequences.map((s) => `seq:${s.schema}.${s.name}:last=${s.last_value ?? 'null'}`)
const identityFacts = (c: Census) => c.identity_columns.map((i) => `identity:${i.schema}.${i.table}.${i.column}:${i.identity}`)
const triggerFacts = (c: Census) => c.triggers.map((t) => `${t.schema}.${t.table}.${t.name}:enabled=${t.enabled}:def=${t.definition_sha256}`)
const journalFacts = (c: Census) => (c.journal ? [`${c.journal.relation}:rows=${c.journal.row_count}:max_id=${c.journal.max_id ?? 'null'}:content=${c.journal.content_sha256}`] : [])

/** Census digest with sequence positions blanked: everything a ROLLBACK must restore. */
export function transactionalSha256(c: Census): string {
  return censusSha256({ ...c, sequences: c.sequences.map((s) => ({ ...s, last_value: null })) })
}

function sameSet(a: string[], b: string[]): boolean {
  const sa = [...new Set(a)].sort()
  const sb = [...new Set(b)].sort()
  return sa.length === sb.length && sa.every((x, i) => x === sb[i])
}

type Eval = Pick<InvariantResult, 'verdict' | 'reason_code' | 'expected' | 'observed'>
const unknown = (reason: string, expected: string[] = []): Eval => ({ verdict: 'UNKNOWN', reason_code: reason, expected, observed: [] })

function compare(expected: string[], observed: string[], failCode: string): Eval {
  return sameSet(expected, observed)
    ? { verdict: 'PASS', reason_code: null, expected: [...expected].sort(), observed: [...observed].sort() }
    : { verdict: 'FAIL', reason_code: failCode, expected: [...expected].sort(), observed: [...observed].sort() }
}

function withRestored(ctx: InvariantContext, f: (source: Census, restored: Census) => Eval): Eval {
  if (!ctx.restored) return unknown(ctx.restoredCensusProblem ?? 'RESTORED_CENSUS_UNAVAILABLE')
  return f(ctx.packet.source_census, ctx.restored)
}

// ---------------------------------------------------------------------------
// The plan. Order is the order of execution.
// ---------------------------------------------------------------------------

export const DEFAULT_INVARIANT_PLAN: readonly PlanEntry[] = [
  {
    id: 'PRI-1',
    phase: 'READ_ONLY',
    mutating: false,
    predicate: 'RELATIONS_AND_FUNCTIONS_SET_EQUAL_AND_SOURCE_NON_EMPTY_AND_DECLARED_SCHEMAS_PRESENT_AND_NO_EXCLUDED_RELATION',
    evaluate: (ctx) =>
      withRestored(ctx, (src, dst) => {
        if (src.relations.length === 0) return { verdict: 'FAIL', reason_code: 'SOURCE_SCOPE_EMPTY', expected: [], observed: relFacts(dst) }
        const present = new Set(dst.schemas.map((s) => s.name))
        const missingSchemas = ctx.packet.scope.schemas.filter((s) => !present.has(s))
        const excludedPresent = dst.relations.filter((r) => ctx.packet.scope.excluded_relations.includes(`${r.schema}.${r.name}`))
        const base = compare([...relFacts(src), ...fnFacts(src)], [...relFacts(dst), ...fnFacts(dst)], 'RELATION_INVENTORY_MISMATCH')
        if (missingSchemas.length > 0) return { ...base, verdict: 'FAIL', reason_code: 'DECLARED_SCHEMA_ABSENT' }
        if (excludedPresent.length > 0) return { ...base, verdict: 'FAIL', reason_code: 'EXCLUDED_RELATION_PRESENT' }
        return base
      }),
  },
  {
    id: 'PRI-2',
    phase: 'READ_ONLY',
    mutating: false,
    predicate: 'PUBLIC_OWNER_IS_PG_DATABASE_OWNER_AND_PUBLIC_HAS_USAGE_FOR_PUBLIC_AND_SCHEMA_ACL_SET_EQUAL',
    evaluate: (ctx) =>
      withRestored(ctx, (src, dst) => {
        const base = compare(schemaFacts(src), schemaFacts(dst), 'SCHEMA_ACL_MISMATCH')
        if (ctx.packet.scope.schemas.includes('public')) {
          const pub = dst.schemas.find((s) => s.name === 'public')
          if (!pub || pub.owner !== 'pg_database_owner') return { ...base, verdict: 'FAIL', reason_code: 'PUBLIC_OWNER_NOT_PG_DATABASE_OWNER' }
          if (!pub.acl.some((a) => a.startsWith('PUBLIC:USAGE:'))) return { ...base, verdict: 'FAIL', reason_code: 'RR_CAP_7_PUBLIC_USAGE_ABSENT' }
        }
        return base
      }),
  },
  {
    id: 'PRI-3',
    phase: 'READ_ONLY',
    mutating: false,
    predicate: 'ROLES_REFERENCED_SET_EQUAL_AND_CLUSTER_ROLES_AFTER_EQ_START_UNION_REFERENCED',
    evaluate: (ctx) =>
      withRestored(ctx, (src, dst) => {
        if (ctx.restore.roles_at_start.length === 0 || ctx.restore.roles_after_restore.length === 0) return unknown('CLUSTER_ROLE_CENSUS_UNAVAILABLE', src.roles_referenced)
        const base = compare(src.roles_referenced, dst.roles_referenced, 'ROLES_REFERENCED_MISMATCH')
        if (base.verdict === 'FAIL') return base
        const allowed = new Set([...ctx.restore.roles_at_start, ...src.roles_referenced])
        const after = new Set(ctx.restore.roles_after_restore)
        const extra = [...after].filter((r) => !allowed.has(r))
        const missing = src.roles_referenced.filter((r) => !after.has(r))
        if (extra.length > 0) return { ...base, verdict: 'FAIL', reason_code: 'CLUSTER_CARRIES_ROLE_NOT_IN_CAPTURE', observed: [...base.observed, ...extra.map((r) => `extra:${r}`)] }
        if (missing.length > 0) return { ...base, verdict: 'FAIL', reason_code: 'REFERENCED_ROLE_ABSENT_FROM_CLUSTER' }
        return base
      }),
  },
  {
    id: 'PRI-4',
    phase: 'READ_ONLY',
    mutating: false,
    predicate: 'JOURNAL_ROWS_MAX_ID_CONTENT_DIGEST_EQUAL',
    evaluate: (ctx) =>
      withRestored(ctx, (src, dst) => (src.journal === null ? unknown('JOURNAL_NOT_IN_SOURCE_SCOPE') : compare(journalFacts(src), journalFacts(dst), 'JOURNAL_PARITY_MISMATCH'))),
  },
  {
    id: 'PRI-5',
    phase: 'READ_ONLY',
    mutating: false,
    predicate: 'PER_RELATION_ROW_COUNTS_EQUAL_AND_SOURCE_HAS_A_NON_EMPTY_RELATION',
    evaluate: (ctx) =>
      withRestored(ctx, (src, dst) => {
        if (!ctx.packet.no_intervening_mutation.census_pre_post_equal) return unknown('SOURCE_COUNTS_NOT_STABLE_DURING_CAPTURE_DEGRADED_TO_RECORDING', countFacts(src))
        if (!src.row_counts.some((r) => r.rows > 0)) return { verdict: 'FAIL', reason_code: 'SOURCE_HAS_NO_ROWS_NEGATIVE_EVIDENCE_IMPOSSIBLE', expected: countFacts(src), observed: countFacts(dst) }
        return compare(countFacts(src), countFacts(dst), 'ROW_COUNT_MISMATCH')
      }),
  },
  {
    id: 'PRI-6',
    phase: 'READ_ONLY',
    mutating: false,
    predicate: 'RLS_AND_FORCE_RLS_PER_RELATION_AND_POLICY_SET_EQUAL',
    evaluate: (ctx) => withRestored(ctx, (src, dst) => compare([...rlsFacts(src), ...policyFacts(src)], [...rlsFacts(dst), ...policyFacts(dst)], 'RLS_OR_POLICY_MISMATCH')),
  },
  {
    id: 'PRI-7',
    phase: 'READ_ONLY',
    mutating: false,
    predicate: 'STORAGE_OBJECT_BYTES_DECLARED_OUT_OF_SCOPE_AND_STORAGE_METADATA_RESTORED_IF_IN_SCOPE',
    evaluate: (ctx) =>
      withRestored(ctx, (src, dst) => {
        const declaration = `storage_object_bytes=${ctx.packet.scope.storage_object_bytes}`
        if (ctx.packet.scope.storage_object_bytes !== 'OUT_OF_SCOPE') return { verdict: 'FAIL', reason_code: 'STORAGE_BYTES_DECLARATION_ABSENT', expected: [], observed: [declaration] }
        if (!ctx.packet.scope.schemas.includes('storage')) return { ...unknown('STORAGE_SCHEMA_NOT_IN_DECLARED_SCOPE'), observed: [declaration] }
        const s = (c: Census) => relFacts(c).filter((f) => f.startsWith('storage.'))
        const base = compare(s(src), s(dst), 'STORAGE_METADATA_MISMATCH')
        return { ...base, observed: [...base.observed, declaration] }
      }),
  },
  {
    id: 'EXT',
    phase: 'READ_ONLY',
    mutating: false,
    predicate: 'EVERY_DECLARED_OR_DEPENDED_EXTENSION_PRESENT_WITH_SOURCE_VERSION',
    evaluate: (ctx) =>
      withRestored(ctx, (src, dst) => {
        const required = [...new Set([...ctx.packet.scope.extensions, ...src.extension_dependencies])].sort()
        const fmt = (c: Census) => c.extensions.filter((e) => required.includes(e.name)).map((e) => `${e.name}@${e.version}`)
        const expected = fmt(src)
        if (expected.length !== required.length) return { verdict: 'FAIL', reason_code: 'REQUIRED_EXTENSION_ABSENT_IN_SOURCE', expected, observed: fmt(dst) }
        return compare(expected, fmt(dst), 'REQUIRED_EXTENSION_MISSING_OR_VERSION_SKEW')
      }),
  },
  {
    id: 'SEQ',
    phase: 'READ_ONLY',
    mutating: false,
    predicate: 'SEQUENCE_LAST_VALUES_AND_IDENTITY_COLUMNS_SET_EQUAL',
    evaluate: (ctx) => withRestored(ctx, (src, dst) => compare([...seqFacts(src), ...identityFacts(src)], [...seqFacts(dst), ...identityFacts(dst)], 'SEQUENCE_OR_IDENTITY_MISMATCH')),
  },
  {
    id: 'TRG',
    phase: 'READ_ONLY',
    mutating: false,
    predicate: 'TRIGGER_ENABLED_STATE_AND_DEFINITION_SET_EQUAL',
    evaluate: (ctx) => withRestored(ctx, (src, dst) => compare(triggerFacts(src), triggerFacts(dst), 'TRIGGER_STATE_MISMATCH')),
  },
  {
    id: 'PRI-2-CAP',
    phase: 'MUTATING_PROBE',
    mutating: true,
    predicate: 'EVERY_DECLARED_SECURITY_DEFINER_CAPABILITY_CALL_SUCCEEDS_AS_ITS_ROLE_INSIDE_A_ROLLED_BACK_TRANSACTION',
    evaluate: (ctx) => {
      if (!ctx.probeResults || ctx.probeResults.length === 0) return unknown('NO_CAPABILITY_PROBE_DECLARED')
      const observed = ctx.probeResults.map((p) => `${p.probe.role}:${p.probe.fn}:exit=${p.exitCode}:sqlstate=${p.sqlstate ?? 'none'}`)
      const expected = ctx.probeResults.map((p) => `${p.probe.role}:${p.probe.fn}:exit=0:sqlstate=none`)
      return compare(expected, observed, 'CAPABILITY_CALL_FAILED')
    },
  },
  {
    id: 'PROBE-ROLLBACK',
    phase: 'PROBE_ROLLBACK_VERIFICATION',
    mutating: false,
    // MEASURED on the first real run: the rolled-back probe's INSERT still
    // advanced its bigserial sequence — nextval() is non-transactional by
    // PostgreSQL design. Transactional state must be byte-identical after the
    // probe; sequence advances are reported as facts, not hidden and not
    // failed. This is also why SEQ runs in READ_ONLY, before any probe.
    predicate: 'TRANSACTIONAL_CENSUS_AFTER_PROBES_EQUALS_BEFORE_AND_SEQUENCE_ADVANCES_ARE_REPORTED',
    evaluate: (ctx) => {
      if (!ctx.rollbackCensus) return unknown('NO_PROBE_EXECUTED')
      if (ctx.rollbackCensus.problem || !ctx.rollbackCensus.census || !ctx.restored) return unknown(ctx.rollbackCensus.problem ?? 'ROLLBACK_CENSUS_UNAVAILABLE')
      const before = ctx.restored
      const after = ctx.rollbackCensus.census
      const advances = after.sequences
        .map((s) => ({ s, prior: before.sequences.find((b) => b.schema === s.schema && b.name === s.name) }))
        .filter(({ s, prior }) => prior !== undefined && prior.last_value !== s.last_value)
        .map(({ s, prior }) => `nontransactional_sequence_advance:${s.schema}.${s.name}:from=${prior?.last_value ?? 'null'}:to=${s.last_value ?? 'null'}`)
      const base = compare([`transactional_census=${transactionalSha256(before)}`], [`transactional_census=${transactionalSha256(after)}`], 'PROBE_WRITES_SURVIVED_ROLLBACK')
      return { ...base, observed: [...base.observed, ...advances] }
    },
  },
]

/** Closed: ids and predicate texts come from the plan itself, never from a caller. */
export const INVARIANT_RESULT_SHAPE: Shape = S.obj({
  id: S.enm(...DEFAULT_INVARIANT_PLAN.map((e) => e.id)),
  phase: S.enm('READ_ONLY', 'MUTATING_PROBE', 'PROBE_ROLLBACK_VERIFICATION'),
  predicate: S.enm(...DEFAULT_INVARIANT_PLAN.map((e) => e.predicate)),
  predicate_sha256: S.str('sha256'),
  census_sql_sha256: S.str('sha256'),
  verdict: S.enm('PASS', 'FAIL', 'UNKNOWN'),
  reason_code: S.opt(S.str('code')),
  expected: S.arr(S.str('fact')),
  observed: S.arr(S.str('fact')),
})

export interface InvariantRunRequest {
  substrate: Substrate
  database: string
  packet: BackupPacket
  restore: RestoreOutcome
  capabilityProbes: CapabilityProbe[]
  /** Defaults to DEFAULT_INVARIANT_PLAN. Accepted only so the ordering refusal is testable. */
  plan?: readonly PlanEntry[]
}

export type InvariantRun =
  | { ok: true; results: InvariantResult[]; restored_census_sha256: string | null }
  | { ok: false; refusal: 'INVARIANT_PLAN_ORDER_VIOLATION'; problems: PlanOrderProblem[] }

const QUALIFIED = /^[A-Za-z_][A-Za-z0-9_$]{0,62}\.[A-Za-z_][A-Za-z0-9_$]{0,62}$/
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function runPostRestoreInvariants(docker: DockerCli, req: InvariantRunRequest): InvariantRun {
  const plan = req.plan ?? DEFAULT_INVARIANT_PLAN
  const problems = validateInvariantPlan(plan)
  if (problems.length > 0) return { ok: false, refusal: 'INVARIANT_PLAN_ORDER_VIOLATION', problems }

  const scope = { schemas: req.packet.scope.schemas, excludedRelations: req.packet.scope.excluded_relations }
  const takeCensus = () => {
    const inv = censusInvocation(scope)
    return parseCensusResult(substratePsql(docker, req.substrate, req.database, inv.stdin, inv.psqlArgs))
  }

  const ctx: InvariantContext = {
    packet: req.packet,
    restored: null,
    restoredCensusProblem: null,
    restore: req.restore,
    probeResults: null,
    rollbackCensus: null,
    restoredCensusSha256: null,
  }
  const results: InvariantResult[] = []
  let censusTaken = false

  for (const entry of plan) {
    if (entry.phase === 'READ_ONLY' && !censusTaken) {
      censusTaken = true
      const census = takeCensus()
      if (census.ok) {
        ctx.restored = census.census
        ctx.restoredCensusSha256 = censusSha256(census.census)
      } else {
        ctx.restoredCensusProblem = `RESTORED_${census.code}`
      }
    }
    if (entry.phase === 'MUTATING_PROBE' && ctx.probeResults === null) {
      ctx.probeResults = req.capabilityProbes.map((probe) => {
        if (!IDENT.test(probe.role) || !QUALIFIED.test(probe.fn)) return { probe, sqlstate: 'GRAMMAR', exitCode: 2 }
        const res = substratePsql(docker, req.substrate, req.database, `BEGIN;\nSET LOCAL ROLE ${probe.role};\nSELECT ${probe.fn}();\nROLLBACK;\n`)
        return { probe, sqlstate: res.status === 0 ? null : extractSqlstate(res.stderr) ?? 'UNCLASSIFIED', exitCode: res.status }
      })
    }
    if (entry.phase === 'PROBE_ROLLBACK_VERIFICATION' && ctx.rollbackCensus === null && ctx.probeResults !== null && ctx.probeResults.length > 0) {
      const after = takeCensus()
      ctx.rollbackCensus = after.ok ? { census: after.census, problem: null } : { census: null, problem: `ROLLBACK_${after.code}` }
    }
    const evaluated = entry.evaluate(ctx)
    results.push({
      id: entry.id,
      phase: entry.phase,
      predicate: entry.predicate,
      predicate_sha256: sha256(entry.predicate),
      census_sql_sha256: CENSUS_SQL_SHA256,
      ...evaluated,
    })
  }
  return { ok: true, results, restored_census_sha256: ctx.restoredCensusSha256 }
}
