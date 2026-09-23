// @vitest-environment node
// tests/recovery/post-restore-invariants.test.ts — the invariant predicates over
// census pairs (OR-N6..N9, OR-N15), plan ordering (OR-N16), the READ ONLY census
// wrapper, and the evidence grammar of every result.

import { describe, expect, it } from 'vitest'

import { censusInvocation, type Census } from '../../scripts/recovery/catalog-census'
import { validateEvidence } from '../../scripts/recovery/evidence-privacy'
import {
  DEFAULT_INVARIANT_PLAN,
  INVARIANT_RESULT_SHAPE,
  runPostRestoreInvariants,
  validateInvariantPlan,
  type InvariantContext,
} from '../../scripts/recovery/post-restore-invariants'
import type { RestoreOutcome } from '../../scripts/recovery/restore-runner'
import type { Substrate } from '../../scripts/recovery/substrate'
import { FakeDocker } from './fake-docker'
import { sampleCensus, sampleCensusRecord, samplePacket } from './sample-evidence'
import { NO_MUTATION_CONFIRMATION } from '../../scripts/recovery/artifact-packet'
import { STORAGE_BYTES_DECLARATION } from '../../scripts/recovery/post-restore-invariants'

const restore: RestoreOutcome = {
  ok: true,
  refusal: null,
  refusal_detail: null,
  restore_database: 'recovery_restore_x',
  restore_started_at: '2026-09-23T20:00:40.000Z',
  restore_finished_at: '2026-09-23T20:00:41.000Z',
  streamed_sha256: 'a'.repeat(64),
  steps: [],
  roles_at_start: ['anon', 'pg_database_owner', 'postgres', 'supabase_admin'],
  roles_after_restore: ['anon', 'fixture_app_owner', 'fixture_capability', 'pg_database_owner', 'postgres', 'supabase_admin'],
  tool_refusals: [],
  target_observation: { image_id: 'sha256:' + '0'.repeat(64), network_mode: 'none' },
  substrate_server_version_num: 170006,
}

function ctx(mutate: (c: Census) => void = () => undefined, extra: Partial<InvariantContext> = {}): InvariantContext {
  const restored = sampleCensus()
  mutate(restored)
  return {
    packet: samplePacket(),
    sourceCensus: sampleCensus(),
    restored,
    restoredCensusProblem: null,
    restore,
    probeResults: [{ probe: { role: 'fixture_capability', fn: 'public.fixture_capability_probe' }, sqlstate: null, exitCode: 0 }],
    rollbackCensus: { census: restored, problem: null },
    restoredCensusSha256: 'a'.repeat(64),
    ...extra,
  }
}

function evalAll(c: InvariantContext) {
  return Object.fromEntries(DEFAULT_INVARIANT_PLAN.map((e) => [e.id, e.evaluate(c)]))
}

describe('invariants over a faithful restore', () => {
  it('every invariant PASSes except PRI-7 (storage not in the fixture scope), and every fact is grammar-valid', () => {
    const r = evalAll(ctx())
    for (const [id, res] of Object.entries(r)) {
      expect(res.verdict, id).toBe(id === 'PRI-7' ? 'UNKNOWN' : 'PASS')
    }
    expect(r['PRI-7'].reason_code).toBe('STORAGE_SCHEMA_NOT_IN_DECLARED_SCOPE')
    expect(r['PRI-7'].observed).toEqual([STORAGE_BYTES_DECLARATION])
    for (const e of DEFAULT_INVARIANT_PLAN) {
      const full = { id: e.id, phase: e.phase, predicate: e.predicate, predicate_sha256: 'a'.repeat(64), census_sql_sha256: 'b'.repeat(64), ...r[e.id] }
      expect(validateEvidence(full, INVARIANT_RESULT_SHAPE), e.id).toEqual([])
    }
  })
})

describe('each broken property turns its invariant RED', () => {
  it.each<[string, string, (c: Census) => void, string]>([
    ['OR-N6', 'PRI-2', (c) => (c.schemas[0].acl = c.schemas[0].acl.filter((a) => !a.startsWith('PUBLIC:'))), 'RR_CAP_7_PUBLIC_USAGE_ABSENT'],
    ['OR-N6', 'PRI-2', (c) => (c.schemas[0].owner = 'postgres'), 'PUBLIC_OWNER_NOT_PG_DATABASE_OWNER'],
    ['OR-N7', 'EXT', (c) => (c.extensions = c.extensions.filter((e) => e.name !== 'pg_trgm')), 'REQUIRED_EXTENSION_MISSING_OR_VERSION_SKEW'],
    ['OR-N7', 'EXT', (c) => (c.extensions[0].version = '1.5'), 'REQUIRED_EXTENSION_MISSING_OR_VERSION_SKEW'],
    ['OR-N8', 'TRG', (c) => (c.triggers[0].enabled = 'D'), 'TRIGGER_STATE_MISMATCH'],
    ['OR-N8', 'TRG', (c) => (c.triggers[1].enabled = 'O'), 'TRIGGER_STATE_MISMATCH'],
    ['OR-N9', 'PRI-6', (c) => (c.relations[2].force_rls = false), 'RLS_OR_POLICY_MISMATCH'],
    ['OR-N9', 'PRI-6', (c) => (c.relations[2].rls = false), 'RLS_OR_POLICY_MISMATCH'],
    ['OR-N9', 'PRI-6', (c) => (c.policies = []), 'RLS_OR_POLICY_MISMATCH'],
    ['OR-N15', 'SEQ', (c) => (c.sequences[0].last_value = 1), 'SEQUENCE_OR_IDENTITY_MISMATCH'],
    ['OR-N15', 'SEQ', (c) => (c.identity_columns[0].identity = 'd'), 'SEQUENCE_OR_IDENTITY_MISMATCH'],
    ['PRI-5', 'PRI-5', (c) => (c.row_counts[1].rows = 4), 'ROW_COUNT_MISMATCH'],
    ['PRI-5 compensating pair', 'PRI-5', (c) => ((c.row_counts[0].rows = 3), (c.row_counts[2].rows = 2)), 'ROW_COUNT_MISMATCH'],
    ['PRI-1', 'PRI-1', (c) => (c.relations = c.relations.slice(1)), 'RELATION_INVENTORY_MISMATCH'],
    ['PRI-1', 'PRI-1', (c) => (c.functions[0].security_definer = false), 'RELATION_INVENTORY_MISMATCH'],
    ['PRI-1', 'PRI-1', (c) => (c.schemas = c.schemas.slice(0, 1)), 'DECLARED_SCHEMA_ABSENT'],
    ['PRI-3', 'PRI-3', (c) => (c.roles_referenced = c.roles_referenced.slice(1)), 'ROLES_REFERENCED_MISMATCH'],
    ['PRI-4', 'PRI-4', (c) => (c.journal = { ...c.journal!, max_id: 3 }), 'JOURNAL_PARITY_MISMATCH'],
  ])('%s: %s FAILs', (_ctl, id, mutate, reason) => {
    const res = DEFAULT_INVARIANT_PLAN.find((e) => e.id === id)!.evaluate(ctx(mutate))
    expect(res.verdict).toBe('FAIL')
    expect(res.reason_code).toBe(reason)
  })

  it('OR-N6: RR-CAP-7 is ABSOLUTE — a source that itself lacks PUBLIC USAGE does not excuse the restore (parity alone would PASS)', () => {
    const c = ctx((r) => (r.schemas[0].acl = r.schemas[0].acl.filter((a) => !a.startsWith('PUBLIC:'))))
    c.sourceCensus.schemas[0].acl = c.sourceCensus.schemas[0].acl.filter((a) => !a.startsWith('PUBLIC:'))
    expect(DEFAULT_INVARIANT_PLAN.find((e) => e.id === 'PRI-2')!.evaluate(c)).toMatchObject({ verdict: 'FAIL', reason_code: 'RR_CAP_7_PUBLIC_USAGE_ABSENT' })
  })

  it('PRI-3: a cluster role the capture did not contain is a FAIL (masking hazard)', () => {
    const res = DEFAULT_INVARIANT_PLAN.find((e) => e.id === 'PRI-3')!.evaluate(ctx(undefined, { restore: { ...restore, roles_after_restore: [...restore.roles_after_restore, 'uellix_app'] } }))
    expect(res).toMatchObject({ verdict: 'FAIL', reason_code: 'CLUSTER_CARRIES_ROLE_NOT_IN_CAPTURE' })
  })

  it('OR-N6: a SECURITY DEFINER capability call failing with 42501 FAILs PRI-2-CAP', () => {
    const res = DEFAULT_INVARIANT_PLAN.find((e) => e.id === 'PRI-2-CAP')!.evaluate(
      ctx(undefined, { probeResults: [{ probe: { role: 'fixture_capability', fn: 'public.fixture_capability_probe' }, sqlstate: '42501', exitCode: 3 }] }),
    )
    expect(res).toMatchObject({ verdict: 'FAIL', reason_code: 'CAPABILITY_CALL_FAILED' })
    expect(res.observed).toEqual(['fixture_capability:public.fixture_capability_probe:exit=3:sqlstate=42501'])
  })

  it('an EMPTY restore fails the negative-capable checks (EVIDENCE.negative_evidence_requirement)', () => {
    const empty = (c: Census) => {
      c.relations = []
      c.row_counts = []
      c.functions = []
    }
    const r = evalAll(ctx(empty))
    expect(r['PRI-1'].verdict).toBe('FAIL')
    expect(r['PRI-5'].verdict).toBe('FAIL')
  })

  it('a source with no rows cannot supply negative evidence: PRI-5 FAILs rather than passing trivially', () => {
    const c = ctx()
    c.sourceCensus.row_counts.forEach((r) => (r.rows = 0))
    c.restored!.row_counts.forEach((r) => (r.rows = 0))
    expect(DEFAULT_INVARIANT_PLAN.find((e) => e.id === 'PRI-5')!.evaluate(c)).toMatchObject({ verdict: 'FAIL', reason_code: 'SOURCE_HAS_NO_ROWS_NEGATIVE_EVIDENCE_IMPOSSIBLE' })
  })
})

describe('UNKNOWN is explicit, never an omission', () => {
  it('unstable source counts degrade PRI-5 to UNKNOWN with the stated reason', () => {
    const c = ctx()
    c.packet[NO_MUTATION_CONFIRMATION].capture_census.pre_post_equal = false
    expect(DEFAULT_INVARIANT_PLAN.find((e) => e.id === 'PRI-5')!.evaluate(c)).toMatchObject({ verdict: 'UNKNOWN', reason_code: 'SOURCE_COUNTS_NOT_STABLE_DURING_CAPTURE_DEGRADED_TO_RECORDING' })
  })

  it('a failed restored census makes every read-only invariant UNKNOWN with the reason', () => {
    const r = evalAll(ctx(undefined, { restored: null, restoredCensusProblem: 'RESTORED_CENSUS_EXEC_FAILED' }))
    for (const e of DEFAULT_INVARIANT_PLAN.filter((x) => x.phase === 'READ_ONLY')) {
      expect(r[e.id]).toMatchObject({ verdict: 'UNKNOWN', reason_code: 'RESTORED_CENSUS_EXEC_FAILED' })
    }
  })
})

describe('probe rollback verification', () => {
  it('a sequence advanced by the rolled-back probe is REPORTED, not failed (nextval is non-transactional)', () => {
    const after = sampleCensus()
    after.sequences[0].last_value = 3
    const res = DEFAULT_INVARIANT_PLAN.find((e) => e.id === 'PROBE-ROLLBACK')!.evaluate(ctx(undefined, { rollbackCensus: { census: after, problem: null } }))
    expect(res.verdict).toBe('PASS')
    expect(res.observed).toContain('nontransactional_sequence_advance:public.fixture_audit_id_seq:from=2:to=3')
  })

  it('a row the probe wrote that survived ROLLBACK is a FAIL', () => {
    const after = sampleCensus()
    after.row_counts[0].rows = 3
    const res = DEFAULT_INVARIANT_PLAN.find((e) => e.id === 'PROBE-ROLLBACK')!.evaluate(ctx(undefined, { rollbackCensus: { census: after, problem: null } }))
    expect(res).toMatchObject({ verdict: 'FAIL', reason_code: 'PROBE_WRITES_SURVIVED_ROLLBACK' })
  })
})

describe('OR-N16: ordering of non-mutating checks before any mutating probe', () => {
  it('the default plan is valid: READ_ONLY, then the probe, then rollback verification', () => {
    expect(validateInvariantPlan(DEFAULT_INVARIANT_PLAN)).toEqual([])
    const phases = DEFAULT_INVARIANT_PLAN.map((e) => e.phase)
    expect(phases.indexOf('MUTATING_PROBE')).toBeGreaterThan(phases.lastIndexOf('READ_ONLY'))
    expect(DEFAULT_INVARIANT_PLAN.filter((e) => e.mutating).map((e) => e.id)).toEqual(['PRI-2-CAP'])
  })

  it('a mutating probe placed before a read-only check is refused', () => {
    const probe = DEFAULT_INVARIANT_PLAN.find((e) => e.phase === 'MUTATING_PROBE')!
    const bad = [probe, ...DEFAULT_INVARIANT_PLAN.filter((e) => e !== probe)]
    expect(validateInvariantPlan(bad).map((p) => p.problem)).toContain('PHASE_REGRESSION')
  })

  it('a READ_ONLY entry that declares it mutates is refused; so is a mutating entry outside the probe phase; so is an empty plan', () => {
    expect(validateInvariantPlan([{ phase: 'READ_ONLY', mutating: true }]).map((p) => p.problem)).toContain('READ_ONLY_ENTRY_MUTATES')
    expect(validateInvariantPlan([{ phase: 'PROBE_ROLLBACK_VERIFICATION', mutating: true }]).map((p) => p.problem)).toContain('MUTATING_ENTRY_OUTSIDE_PROBE_PHASE')
    expect(validateInvariantPlan([]).map((p) => p.problem)).toEqual(['EMPTY_PLAN'])
  })

  it('the runner refuses a mis-ordered plan BEFORE issuing a single docker call', () => {
    const fake = new FakeDocker()
    const probe = DEFAULT_INVARIANT_PLAN.find((e) => e.phase === 'MUTATING_PROBE')!
    const run = runPostRestoreInvariants(fake, {
      substrate: { identity: { containerId: 'c'.repeat(64) } } as Substrate,
      database: 'd',
      packet: samplePacket(),
      sourceCensus: sampleCensusRecord(),
      restore,
      capabilityProbes: [],
      plan: [probe, ...DEFAULT_INVARIANT_PLAN.filter((e) => e !== probe)],
    })
    expect(run).toMatchObject({ ok: false, refusal: 'INVARIANT_PLAN_ORDER_VIOLATION' })
    expect(fake.calls).toEqual([])
  })

  it('every census (the substrate of all non-mutating checks) runs in a READ ONLY transaction with row_security off', () => {
    const inv = censusInvocation({ schemas: ['public'], excludedRelations: [] })
    expect(inv.stdin.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL row_security = off;\n')).toBe(true)
    expect(inv.stdin.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(inv.psqlArgs).toContain('ON_ERROR_STOP=1')
  })

  it('census scope tokens are grammar-checked before they reach psql', () => {
    expect(() => censusInvocation({ schemas: ["public'; DROP TABLE x; --"], excludedRelations: [] })).toThrow(/RECOVERY_SCOPE_GRAMMAR/)
    expect(() => censusInvocation({ schemas: [], excludedRelations: [] })).toThrow(/RECOVERY_SCOPE_EMPTY/)
  })
})

describe('the source census judged is the one the packet is bound to', () => {
  it('a census record that differs from the bound one is refused before a single docker call', () => {
    const fake = new FakeDocker()
    const other = sampleCensus()
    other.row_counts[0].rows = 77
    const run = runPostRestoreInvariants(fake, {
      substrate: { identity: { containerId: 'c'.repeat(64) } } as Substrate,
      database: 'd',
      packet: samplePacket(),
      sourceCensus: sampleCensusRecord(other),
      restore,
      capabilityProbes: [],
    })
    expect(run).toMatchObject({ ok: false, refusal: 'INVARIANT_SOURCE_CENSUS_NOT_BOUND' })
    expect(fake.calls).toEqual([])
  })
})
