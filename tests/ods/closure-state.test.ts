// tests/ods/closure-state.test.ts
//
// Positive + negative controls for scripts/ops/closure-state.ts, per the
// ODS negative-control doctrine (ODS_V1_AUTHORITY_v1.0.0.json): every rule
// is shown to FAIL on a deliberately broken fixture copy. Nothing here
// mutates the real docs/ops/ods/CV1_CLOSURE_STATE.json — each negative
// control works on a structuredClone, or on a disposable git fixture repo.

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  CLOSURE_STATE_PATH,
  CLOSURE_STATE_SCHEMA_PATH,
  RUN_STATE_SCHEMA_PATH,
  checkRunStateResume,
  packageDigest,
  validateClosureState,
  validateRunState,
  validateSchema,
  validateTransition,
  verifyGit,
  type ClosureRecord,
  type ClosureState,
  type Issue,
} from '../../scripts/ops/closure-state'
import { cleanupTempGitRepo, commitFile, git, makeTempGitRepo } from './git-fixture-helpers'

const ROOT = path.resolve(__dirname, '../..')
const load = (p: string) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'))
const SCHEMA = load(CLOSURE_STATE_SCHEMA_PATH)
const RUN_SCHEMA = load(RUN_STATE_SCHEMA_PATH)
const BASELINE: ClosureState = load(CLOSURE_STATE_PATH)
// The baseline is validated at its own as_of: CI must not become a time
// bomb for unrelated PRs. The CLI validates at the real current time.
const NOW = BASELINE.as_of

const clone = (): ClosureState => structuredClone(BASELINE)
const rec = (s: ClosureState, id: string): ClosureRecord => {
  const r = s.records.find((x) => x.gate_id === id)
  if (!r) throw new Error(`fixture record ${id} missing`)
  return r
}
const validate = (s: unknown) => validateClosureState(s, SCHEMA, { now: NOW })

// The meta-test at the end forces every x-semantic-rule of the schema to
// have at least one expectRule(...) negative control in this file.
function expectRule(issues: Issue[], rule: string, fragment?: string) {
  const hits = issues.filter((i) => i.rule === rule && (!fragment || i.message.includes(fragment)))
  expect(hits.length, `expected ${rule}${fragment ? ` ~ "${fragment}"` : ''}; got ${JSON.stringify(issues)}`).toBeGreaterThan(0)
}

describe('CV1 closure state — positive controls', () => {
  it('the committed baseline is non-empty and validates at its as_of', () => {
    expect(BASELINE.records.length).toBeGreaterThanOrEqual(4)
    expect(validate(BASELINE)).toEqual([])
  })

  it('represents branch-local facts as branch-local, never integrated', () => {
    for (const r of BASELINE.records) {
      expect(r.integration_status).toBe('NOT_INTEGRATED')
      expect(r.certification?.scope ?? 'BRANCH_LOCAL').toBe('BRANCH_LOCAL')
      for (const e of r.evidence) if (e.scope) expect(e.scope).toBe('BRANCH_LOCAL')
    }
  })

  it('nothing in the baseline is CLOSED or executable', () => {
    for (const r of BASELINE.records) {
      expect(r.lifecycle_state).not.toBe('CLOSED')
      expect(r.execution_allowed).toBe(false)
    }
  })

  it('an advance of exactly one lifecycle step is a valid transition', () => {
    const next = clone()
    next.revision += 1
    const d1 = rec(next, 'FIBDB053_D1_AUDITOR')
    expect(d1.lifecycle_state).toBe('AUTHORED')
    // Only the ladder is under test here, not the certification rules.
    d1.lifecycle_state = 'CERTIFIED'
    expect(validateTransition(BASELINE, next, SCHEMA)).toEqual([])
  })
})

describe('CV1 closure state — required negative controls', () => {
  it('1. invalid lifecycle transition (skip, and regression without a fired invalidator)', () => {
    const skip = clone()
    skip.revision += 1
    rec(skip, 'FIBDB053_D1_AUDITOR').lifecycle_state = 'MATERIALIZED'
    expectRule(validateTransition(BASELINE, skip, SCHEMA), 'TRANSITION', 'skips 1 state')

    const back = clone()
    back.revision += 1
    rec(back, 'INFRA_CONTROL_PLANE_READ').lifecycle_state = 'EXECUTED'
    expectRule(validateTransition(BASELINE, back, SCHEMA), 'TRANSITION', 'requires a fired invalidator')

    const removed = clone()
    removed.revision += 1
    removed.records = removed.records.filter((r) => r.gate_id !== 'RECOVERY_OFFLINE')
    removed.records.forEach((r) => (r.dependencies = r.dependencies.filter((d) => d !== 'RECOVERY_OFFLINE')))
    expectRule(validateTransition(BASELINE, removed, SCHEMA), 'TRANSITION', 'record removed')
  })

  it('2. missing SHA for a SHA-bound state', () => {
    const s = clone()
    rec(s, 'FIBDB053_D1_AUDITOR').candidate_sha = null
    expectRule(validate(s), 'SHA_BINDING', 'candidate_sha required')

    const e = clone()
    delete rec(e, 'INFRA_CONTROL_PLANE_READ').lineage_shas.evidence_head
    expectRule(validate(e), 'SHA_BINDING', 'lineage_shas.evidence_head')
  })

  it('3. stale certification inherited after a covered-path change', () => {
    const s = clone()
    const r = rec(s, 'INFRA_CONTROL_PLANE_READ')
    // Successor candidate whose covered package no longer matches the certified one.
    r.candidate_sha = 'a'.repeat(40)
    r.covered_package_digest = 'b'.repeat(64)
    r.certification_inherits_from = { certification_id: r.certification!.certification_id, from_sha: r.certification!.certified_sha, rationale: 'inherit' }
    expectRule(validate(s), 'CERTIFICATION_BINDING', 'COVERED_PATH_CHANGED')

    const noInherit = clone()
    rec(noInherit, 'INFRA_CONTROL_PLANE_READ').candidate_sha = 'a'.repeat(40)
    expectRule(validate(noInherit), 'CERTIFICATION_BINDING', 'BINDING_CHANGED')
  })

  it('4. changed authority with an inherited certification', () => {
    const s = clone()
    const r = rec(s, 'INFRA_CONTROL_PLANE_READ')
    r.authority_version = '1.0.10'
    r.certification_inherits_from = { certification_id: r.certification!.certification_id, from_sha: r.certification!.certified_sha, rationale: 'inherit' }
    expectRule(validate(s), 'CERTIFICATION_BINDING', 'AUTHORITY_CHANGED')
  })

  it('5. expired evidence freshness (record TTL and consumed observation TTL)', () => {
    const s = clone()
    const r = rec(s, 'INFRA_CONTROL_PLANE_READ')
    r.evidence_freshness = 'TTL'
    r.evidence_expires_at = '2026-09-24T00:00:00Z'
    expectRule(validate(s), 'FRESHNESS', 'expired')

    const o = clone()
    const obs = o.observations.find((x) => x.observation_id === 'OBS-INFRA-READ-EXEC-E7C8E67B59BF')!
    obs.freshness_class = 'TTL'
    obs.expires_at = '2026-09-24T04:00:00Z'
    expectRule(validate(o), 'FRESHNESS', 'OBS-INFRA-READ-EXEC-E7C8E67B59BF expired')
  })

  it('6. a fired invalidator still treated as valid (record and observation)', () => {
    const s = clone()
    rec(s, 'INFRA_CONTROL_PLANE_READ').invalidated_by[0].fired = true
    expectRule(validate(s), 'FIRED_INVALIDATOR', 'certification_status is still CERTIFIED')

    const o = clone()
    o.observations[0].invalidated_by[0].fired = true
    expectRule(validate(o), 'FIRED_INVALIDATOR', 'OBS-PR-HEADS-PUSH')
  })

  it('7. NOT_INTEGRATED misread as NOT_IMPLEMENTED', () => {
    const s = clone()
    rec(s, 'INFRA_CONTROL_PLANE_READ').implementation_status = 'NOT_IMPLEMENTED'
    expectRule(validate(s), 'IMPLEMENTED_VS_INTEGRATED', 'NOT_INTEGRATED is not NOT_IMPLEMENTED')
  })

  it('8. branch-local certification presented as integration certification', () => {
    const s = clone()
    rec(s, 'INFRA_CONTROL_PLANE_READ').certification!.scope = 'INTEGRATION'
    expectRule(validate(s), 'CERTIFICATION_SCOPE', 'branch-local certification presented as INTEGRATION')

    const e = clone()
    rec(e, 'FIBDB053_D1_AUDITOR').evidence[0].scope = 'INTEGRATED'
    expectRule(validate(e), 'CERTIFICATION_SCOPE', 'must not be presented as integrated')
  })

  it('9. EVIDENCED promoted directly to CLOSED without required dependencies', () => {
    const s = clone()
    s.revision += 1
    const r = rec(s, 'INFRA_CONTROL_PLANE_READ')
    r.lifecycle_state = 'CLOSED'
    r.dependencies = ['RECOVERY_OFFLINE']
    const issues = validate(s)
    expectRule(issues, 'CLOSED_REQUIRES', 'dependency RECOVERY_OFFLINE is AUTHORED')
    expectRule(issues, 'CLOSED_REQUIRES', 'HUMAN_DECISION')
  })

  it('10. execution_allowed=true with an unresolved blocking finding', () => {
    const s = clone()
    rec(s, 'FIBDB053_D1_AUDITOR').execution_allowed = true
    const issues = validate(s)
    expectRule(issues, 'EXECUTION_ALLOWED', 'unresolved blocking finding(s) PMR-9, PMR-13')
    expectRule(issues, 'EXECUTION_ALLOWED', 'requires lifecycle ARMED')
  })

  it('11. unknown lifecycle / risk / status values', () => {
    for (const [field, bad] of [['lifecycle_state', 'DONE'], ['risk_tier', 'EXTREME'], ['certification_status', 'APPROVED'], ['integration_status', 'MERGED']] as const) {
      const s = clone() as unknown as { records: Record<string, unknown>[] }
      s.records[0][field] = bad
      const issues = validate(s)
      expect(issues.some((i) => i.rule === 'SCHEMA' && i.message.includes(`unknown value "${bad}"`)), JSON.stringify(issues)).toBe(true)
    }
  })
})

describe('CV1 closure state — further negative controls', () => {
  it('a SELF certification cannot back a CERTIFIED status', () => {
    const s = clone()
    rec(s, 'INFRA_CONTROL_PLANE_READ').certification!.kind = 'SELF'
    expectRule(validate(s), 'LIFECYCLE_CERTIFICATION', 'SELF certification')
  })

  it('CERTIFIED lifecycle without a certified status', () => {
    const s = clone()
    rec(s, 'FIBDB053_D1_AUDITOR').lifecycle_state = 'CERTIFIED'
    expectRule(validate(s), 'LIFECYCLE_CERTIFICATION', 'requires a CERTIFIED_PASS* status')
  })

  it('EXECUTED on INFERENCE alone is refused', () => {
    const s = clone()
    const r = rec(s, 'INFRA_CONTROL_PLANE_READ')
    r.observed_at = null
    r.evidence = r.evidence.filter((e) => e.class === 'INDEPENDENT_CERTIFICATION')
    r.evidence.push({ fact_id: 'GUESS', class: 'INFERENCE', claim: 'probably ran', derived_from: ['INFRA-RECERT-VERDICT'] })
    s.observations.forEach((o) => (o.consumers = o.consumers.filter((c) => c !== 'INFRA_CONTROL_PLANE_READ')))
    s.observations = s.observations.filter((o) => o.consumers.length > 0)
    const issues = validate(s)
    expectRule(issues, 'EXECUTED_EVIDENCE', 'INFERENCE alone never suffices')
    expectRule(issues, 'EXECUTED_EVIDENCE', 'requires observed_at')
  })

  it('the same provider read duplicated per consumer is refused; consumers must match citations', () => {
    const s = clone()
    const dup = structuredClone(s.observations[0])
    dup.observation_id = 'OBS-DUPLICATE-READ'
    dup.consumers = ['FIBDB053_D1_AUDITOR']
    s.observations.push(dup)
    const issues = validate(s)
    expectRule(issues, 'REFERENCES', 'duplicates the same provider read')
    expectRule(issues, 'REFERENCES', 'consumers must equal citing records')
  })

  it('evidence-class requirements', () => {
    const s = clone()
    rec(s, 'FIBDB053_D1_AUDITOR').evidence.push({ fact_id: 'BARE', class: 'REPOSITORY_FACT', claim: 'no pointer' })
    expectRule(validate(s), 'EVIDENCE_CLASS', 'REPOSITORY_FACT requires ref and path')
  })

  it('credential-shaped strings are refused', () => {
    const s = clone()
    rec(s, 'FIBDB053_D1_AUDITOR').notes = 'leak ' + 'gh' + 'p_' + 'A1b2C3d4'.repeat(5)
    expectRule(validate(s), 'NO_SECRET_MATERIAL', 'github-token')
    const u = clone()
    rec(u, 'FIBDB053_D1_AUDITOR').notes = 'postgres' + '://user:' + 'pw1234@db.example.invalid:5432/x'
    expectRule(validate(u), 'NO_SECRET_MATERIAL', 'connection-uri-with-credentials')
  })

  it('the schema interpreter refuses keywords it does not implement', () => {
    const issues = validateSchema({ type: 'string', format: 'date-time' }, 'x')
    expect(issues.some((i) => i.message.includes("unsupported schema keyword 'format'"))).toBe(true)
  })
})

describe('CV1 closure state — git layer (disposable fixture repos)', () => {
  const repos: string[] = []
  afterEach(() => { while (repos.length) cleanupTempGitRepo(repos.pop()!) })

  function fixture() {
    const dir = makeTempGitRepo()
    repos.push(dir)
    const base = commitFile(dir, 'README.md', 'base\n')
    git(dir, ['checkout', '-q', '-b', 'lane'])
    const c1 = commitFile(dir, 'pkg/a.json', JSON.stringify({ version: '1.0.0', final_state: 'READY' }))
    const c2 = commitFile(dir, 'pkg/a.json', JSON.stringify({ version: '1.0.0', final_state: 'READY', edited: true }))
    const tree = (sha: string) => git(dir, ['rev-parse', `${sha}^{tree}`])
    return { dir, base, c1, c2, tree }
  }

  function stateFor(f: ReturnType<typeof fixture>, candidate: string, over: Partial<ClosureRecord> = {}): ClosureState {
    const digest = packageDigest(f.dir, candidate, ['pkg'])!
    const record: ClosureRecord = {
      gate_id: 'FIXTURE_GATE', milestone: 'fixture', lifecycle_state: 'AUTHORED',
      implementation_status: 'NOT_APPLICABLE', integration_status: 'NOT_INTEGRATED',
      candidate_sha: candidate, tree_sha: f.tree(candidate), lineage_shas: {},
      authority: { path: 'pkg/a.json', ref: candidate }, authority_version: '1.0.0',
      certification: null, certification_status: 'PENDING_INDEPENDENT_RECERT', certification_inherits_from: null,
      covered_paths: ['pkg'], covered_package_digest: digest,
      evidence: [{ fact_id: 'F1', class: 'REPOSITORY_FACT', claim: 'final state', ref: candidate, path: 'pkg/a.json', field: 'final_state', value: 'READY', scope: 'BRANCH_LOCAL' }],
      evidence_freshness: 'SHA_BOUND', evidence_expires_at: null, observed_at: null, invalidated_by: [],
      dependencies: [], blocking_findings: [], branch: 'lane', pr: null, execution_allowed: false,
      risk_tier: 'LOW', next_legal_act: 'recert', unconfirmed: [], ...over,
    }
    return {
      state_id: 'CV1_CLOSURE_STATE', schema_version: '1.0.0', state_class: 'OPERATIONAL_DERIVED_STATE', not_authority: true,
      revision: 1, as_of: NOW, written_by_lane: 'FIXTURE',
      integration_base: { branch: 'main', sha: f.base, tree_sha: f.tree(f.base) },
      records: [record], observations: [], unconfirmed: [],
    } as unknown as ClosureState
  }

  it('positive: a faithful state re-derives cleanly from git', () => {
    const f = fixture()
    const s = stateFor(f, f.c1)
    expect(validateClosureState(s, SCHEMA, { now: NOW, gitCwd: f.dir })).toEqual([])
  })

  it('negative: a covered-path change after certification is detected by digest', () => {
    const f = fixture()
    const d1 = packageDigest(f.dir, f.c1, ['pkg'])!
    const d2 = packageDigest(f.dir, f.c2, ['pkg'])!
    expect(d1).not.toBe(d2)
    // Candidate moved to c2 but the record still claims the c1 package digest.
    const s = stateFor(f, f.c2, { covered_package_digest: d1 })
    const issues = verifyGit(s, f.dir)
    expectRule(issues, 'GIT', 'covered_package_digest mismatch')
  })

  it('negative: an INTEGRATED claim that git ancestry refutes', () => {
    const f = fixture()
    const s = stateFor(f, f.c1, { integration_status: 'INTEGRATED' })
    expectRule(verifyGit(s, f.dir), 'GIT', 'contradicts git')
  })

  it('negative: a recorded evidence value that the ref does not contain', () => {
    const f = fixture()
    const s = stateFor(f, f.c1)
    s.records[0].evidence[0].value = 'CLOSED'
    expectRule(verifyGit(s, f.dir), 'GIT', 'field final_state = "READY" != recorded "CLOSED"')
  })

  it('negative: a wrong tree for the candidate', () => {
    const f = fixture()
    const s = stateFor(f, f.c1, { tree_sha: f.tree(f.c2) })
    expectRule(verifyGit(s, f.dir), 'GIT', 'tree_sha')
  })

  it('negative: a gate_id that shadows a canonical RELEASE_GATE_LEDGER gate', () => {
    const f = fixture()
    mkdirSync(path.join(f.dir, 'docs/ops/release'), { recursive: true })
    writeFileSync(path.join(f.dir, 'docs/ops/release/RELEASE_GATE_LEDGER_v1.0.0.json'), JSON.stringify({ GATES: [{ id: 'FIXTURE_GATE' }] }))
    expectRule(verifyGit(stateFor(f, f.c1), f.dir), 'GIT', 'collides')
  })

  it('packageDigest refuses a partial package', () => {
    const f = fixture()
    expect(packageDigest(f.dir, f.c1, ['pkg', 'missing/path'])).toBeUndefined()
  })
})

describe('RUN_STATE contract', () => {
  const valid = {
    run_state_version: '1.0.0', lane: 'FIXTURE-LANE-R1', role: 'writer', base: 'a'.repeat(40), candidate: null,
    done_when: ['x'], completed: [], active: 'step', remaining: [], findings: [], unconfirmed: [],
    needs_from_owner: [], own_commits: ['c'.repeat(40)], last_verified_head: 'b'.repeat(40), updated_at: '2026-09-24T00:00:00Z',
  }

  it('positive: a well-formed RUN_STATE validates', () => {
    expect(validateRunState(valid, RUN_SCHEMA)).toEqual([])
  })

  it('negative: a missing minimum field is refused', () => {
    const rest: Record<string, unknown> = { ...valid }
    delete rest.needs_from_owner
    const issues = validateRunState(rest, RUN_SCHEMA)
    expect(issues.some((i) => i.message.includes("missing required field 'needs_from_owner'"))).toBe(true)
  })

  it('negative: an UNCONFIRMED entry without its required fields is refused', () => {
    const issues = validateRunState({ ...valid, unconfirmed: [{ fact: 'x', status: 'UNCONFIRMED' }] }, RUN_SCHEMA)
    expect(issues.some((i) => i.message.includes("missing required field 'next_evidence_required'"))).toBe(true)
  })

  it('resume: HEAD at last_verified_head or last own commit resumes; anything else is DRIFT', () => {
    expect(checkRunStateResume(valid, 'b'.repeat(40)).verdict).toBe('RESUME')
    expect(checkRunStateResume(valid, 'c'.repeat(40)).verdict).toBe('RESUME')
    expect(checkRunStateResume(valid, 'd'.repeat(40)).verdict).toBe('DRIFT')
  })
})

describe('ODS-C5: CLAUDE.md stays within its frozen line budget', () => {
  it('line count <= ods_v1_frozen_scope ODS-C5 max_lines', () => {
    const ods = load('docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json')
    const c5 = ods.ods_v1_frozen_scope.components.find((c: { id: string }) => c.id === 'ODS-C5')
    expect(typeof c5.max_lines).toBe('number')
    const lines = readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8').replace(/\r?\n$/, '').split(/\r?\n/).length
    expect(lines).toBeLessThanOrEqual(c5.max_lines)
  })
})

describe('meta: every semantic rule has a negative control', () => {
  // Read statically from this file's own expectRule(...) calls, so the check
  // does not depend on test order or a `-t` filter; each expectRule call
  // additionally asserts at runtime that the rule really fired.
  it('each x-semantic-rules key has an expectRule negative control in this file', () => {
    const declared = Object.keys(SCHEMA['x-semantic-rules'])
    expect(declared.length).toBeGreaterThan(0)
    const source = readFileSync(__filename, 'utf8')
    const controlled = new Set([...source.matchAll(/expectRule\([^\n]*?'([A-Z_]+)'/g)].map((m) => m[1]))
    expect(declared.filter((r) => !controlled.has(r))).toEqual([])
  })
})
