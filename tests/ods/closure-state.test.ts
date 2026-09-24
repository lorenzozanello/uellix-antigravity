// tests/ods/closure-state.test.ts
//
// Positive + negative controls for scripts/ops/closure-state.ts (schema
// v1.1.0), per the ODS negative-control doctrine (ODS_V1_AUTHORITY_v1.0.0.json):
// every rule is shown to FAIL on a deliberately broken copy. Nothing here
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
  isInsideGit,
  loadVocabulary,
  packageDigest,
  resolveRunStateRoot,
  runCi,
  scanSecrets,
  validateClosureState,
  validateRunState,
  validateSchema,
  verdictAgreesWithOutcome,
  verifyGit,
  type Certification,
  type ClosureRecord,
  type ClosureState,
  type EvidenceItem,
  type Issue,
} from '../../scripts/ops/closure-state'
import { cleanupTempGitRepo, commitFile, git, makeTempGitRepo } from './git-fixture-helpers'

const ROOT = path.resolve(__dirname, '../..')
const load = (p: string) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'))
const SCHEMA = load(CLOSURE_STATE_SCHEMA_PATH)
const VOCAB = loadVocabulary(SCHEMA)
const RUN_SCHEMA = load(RUN_STATE_SCHEMA_PATH)
const BASELINE: ClosureState = load(CLOSURE_STATE_PATH)
// The baseline is validated at its own as_of: CI must not become a time
// bomb for unrelated PRs. The CLI and the CI step use the real time.
const NOW = BASELINE.as_of
const LATER = '2026-09-25T00:00:00Z'

const clone = (): ClosureState => structuredClone(BASELINE)
const rec = (s: ClosureState, id: string): ClosureRecord => {
  const r = s.records.find((x) => x.gate_id === id)
  if (!r) throw new Error(`fixture record ${id} missing`)
  return r
}
const validate = (s: unknown, extra: { previous?: unknown; genesis?: boolean } = {}) => validateClosureState(s, SCHEMA, { now: NOW, ...extra })
/** The next revision of the baseline, ready for a transition check. */
const nextRevision = (): ClosureState => {
  const s = clone()
  s.revision += 1
  s.as_of = LATER
  return s
}
const validateNext = (next: ClosureState, prev: ClosureState = BASELINE) => validateClosureState(next, SCHEMA, { now: LATER, previous: prev })

// The meta-test at the end forces every x-semantic-rule of the schema to
// have at least one expectRule(...) negative control in this file.
function expectRule(issues: Issue[], rule: string, fragment?: string) {
  const hits = issues.filter((i) => i.rule === rule && (!fragment || i.message.includes(fragment)))
  expect(hits.length, `expected ${rule}${fragment ? ` ~ "${fragment}"` : ''}; got ${JSON.stringify(issues)}`).toBeGreaterThan(0)
}

const D1 = 'FIBDB053_D1_AUDITOR'
const INFRA = 'INFRA_CONTROL_PLANE_READ'
const ROFF = 'RECOVERY_OFFLINE'
const RIS = 'RECOVERY_INTEGRATION_SUCCESSOR'

/** A durable INDEPENDENT_CERTIFICATION item + matching certification entry for a record's current candidate. */
function certFor(r: ClosureRecord, id: string, verdict: string, outcome: string): { ev: EvidenceItem; cert: Certification } {
  const ev: EvidenceItem = { fact_id: `EV-${id}`, class: 'INDEPENDENT_CERTIFICATION', claim: 'fixture recert record', ref: r.candidate_sha!, path: 'docs/ops/release/FIXTURE_RECERT.json', field: 'VERDICT.verdict', value: verdict }
  const cert: Certification = { certification_id: id, kind: 'INDEPENDENT', verdict, outcome, scope: 'BRANCH_LOCAL', certified_sha: r.candidate_sha!, certified_authority_version: r.authority_version, certified_package_digest: r.covered_package_digest, evidence_fact_id: ev.fact_id }
  return { ev, cert }
}
function addCert(r: ClosureRecord, id: string, verdict: string, outcome: string, status: string) {
  const { ev, cert } = certFor(r, id, verdict, outcome)
  r.evidence.push(ev)
  r.certification_history.push(cert)
  r.certification = cert
  r.certification_status = status
}

describe('CV1 closure state — positive controls', () => {
  it('the committed projection is non-empty and validates at its as_of', () => {
    expect(BASELINE.records.length).toBeGreaterThanOrEqual(4)
    expect(BASELINE.schema_version).toBe('1.1.0')
    expect(validate(BASELINE)).toEqual([])
  })

  it('it also validates as a genesis projection (what CI does when the base lacks the file)', () => {
    expect(validate(BASELINE, { genesis: true })).toEqual([])
  })

  it('branch-local facts stay branch-local; nothing is CLOSED, ARMED or executable; INFRA stays EVIDENCED', () => {
    for (const r of BASELINE.records) {
      expect(r.integration_status).toBe('NOT_INTEGRATED')
      for (const c of r.certification_history) expect(c.scope).toBe('BRANCH_LOCAL')
      for (const e of r.evidence) if (e.scope) expect(e.scope).toBe('BRANCH_LOCAL')
      expect(['CLOSED', 'ARMED']).not.toContain(r.lifecycle_state)
      expect(r.execution_allowed).toBe(false)
    }
    expect(rec(BASELINE, INFRA).lifecycle_state).toBe('EVIDENCED')
  })

  it('a FAIL certification is representable (negative record), and a later PASS supersedes it only under a NEW certification_id', () => {
    const s3 = nextRevision()
    addCert(rec(s3, D1), 'D1_FA43_RECERT_1', 'D1_FIXTURE_RECERT_FAIL', 'FAIL', 'CERTIFIED_FAIL')
    expect(validateNext(s3)).toEqual([])
    const s4: ClosureState = structuredClone(s3)
    s4.revision += 1
    addCert(rec(s4, D1), 'D1_FA43_RECERT_2', 'D1_FIXTURE_RECERT_PASS', 'PASS', 'CERTIFIED_PASS')
    expect(validateClosureState(s4, SCHEMA, { now: LATER, previous: s3 })).toEqual([])
  })

  it('a one-step, durably evidenced forward transition is valid', () => {
    const s3 = nextRevision()
    const r = rec(s3, D1)
    addCert(r, 'D1_FA43_RECERT_1', 'D1_FIXTURE_RECERT_PASS_WITH_NONBLOCKING_FINDINGS', 'PASS_WITH_NONBLOCKING_FINDINGS', 'CERTIFIED_PASS_WITH_NONBLOCKING_FINDINGS')
    r.lifecycle_history.push({ to: 'CERTIFIED', at_revision: 3, candidate_sha: r.candidate_sha, basis_fact_ids: ['EV-D1_FA43_RECERT_1'] })
    r.lifecycle_state = 'CERTIFIED'
    expect(validateNext(s3)).toEqual([])
  })
})

describe('CV1 closure state — lifecycle transitions (explicit graph)', () => {
  const jump = (to: string, basis: string[] = ['D1R2-FINAL-STATE']) => {
    const s = nextRevision()
    const r = rec(s, D1)
    r.lifecycle_history.push({ to, at_revision: 3, candidate_sha: r.candidate_sha, basis_fact_ids: basis })
    r.lifecycle_state = to
    return validateNext(s)
  }
  it('AUTHORED -> CLOSED is refused', () => expectRule(jump('CLOSED'), 'LIFECYCLE_HISTORY', 'AUTHORED -> CLOSED skips 5'))
  it('AUTHORED -> ARMED is refused', () => expectRule(jump('ARMED'), 'LIFECYCLE_HISTORY', 'AUTHORED -> ARMED skips 2'))
  it('AUTHORED -> MATERIALIZED is refused', () => expectRule(jump('MATERIALIZED'), 'LIFECYCLE_HISTORY', 'skips 1'))
  it('AUTHORED -> CERTIFIED without a durable certification basis is refused', () => expectRule(jump('CERTIFIED'), 'LIFECYCLE_HISTORY', 'AUTHORED -> CERTIFIED needs a durable INDEPENDENT_CERTIFICATION basis'))

  it('EVIDENCED -> CLOSED without a HUMAN_DECISION basis and with an unmet dependency is refused', () => {
    const s = nextRevision()
    const r = rec(s, INFRA)
    r.dependencies.push({ gate_id: ROFF, required_state: 'CLOSED', applies_from_state: 'ARMED', rationale: 'fixture' })
    r.lifecycle_history.push({ to: 'CLOSED', at_revision: 3, candidate_sha: r.candidate_sha, basis_fact_ids: ['INFRA-DN0-MEASURED'] })
    r.lifecycle_state = 'CLOSED'
    const issues = validateNext(s)
    expectRule(issues, 'LIFECYCLE_HISTORY', 'EVIDENCED -> CLOSED needs a durable HUMAN_DECISION basis')
    expectRule(issues, 'DEPENDENCY', `dependency ${ROFF} is AUTHORED; this edge requires CLOSED`)
    expectRule(issues, 'CLOSED_REQUIRES', 'durable HUMAN_DECISION')
  })

  it('EVIDENCED -> CLOSED with a durable HUMAN_DECISION but an unmet dependency is still refused', () => {
    const s = nextRevision()
    const r = rec(s, INFRA)
    r.evidence.push({ fact_id: 'HD-CLOSE', class: 'HUMAN_DECISION', claim: 'fixture owner closure', ref: r.candidate_sha!, path: 'docs/ops/owner-ratifications/FIXTURE.json', field: 'decision', value: 'CLOSE' })
    r.dependencies.push({ gate_id: ROFF, required_state: 'CLOSED', applies_from_state: 'ARMED', rationale: 'fixture' })
    r.lifecycle_history.push({ to: 'CLOSED', at_revision: 3, candidate_sha: r.candidate_sha, basis_fact_ids: ['HD-CLOSE'] })
    r.lifecycle_state = 'CLOSED'
    const issues = validateNext(s)
    expectRule(issues, 'DEPENDENCY', 'requires CLOSED')
    expect(issues.some((i) => i.rule === 'LIFECYCLE_HISTORY')).toBe(false)
  })

  it('a regression without a fired invalidator is refused', () => {
    const s = nextRevision()
    const r = rec(s, INFRA)
    r.lifecycle_history.push({ to: 'EXECUTED', at_revision: 3, candidate_sha: r.candidate_sha, basis_fact_ids: [] })
    r.lifecycle_state = 'EXECUTED'
    expectRule(validateNext(s), 'LIFECYCLE_HISTORY', 'requires a fired invalidator')
  })

  it('a candidate rebind without a fired BINDING_CHANGED invalidator is refused', () => {
    const s = nextRevision()
    const r = rec(s, D1)
    r.lifecycle_history.push({ to: 'AUTHORED', at_revision: 3, candidate_sha: 'c'.repeat(40), basis_fact_ids: ['D1R2-FINAL-STATE'], invalidator_id: 'D1R2-CANDIDATE-MOVED' })
    r.candidate_sha = 'c'.repeat(40)
    expectRule(validateNext(s), 'LIFECYCLE_HISTORY', 'rebind needs a fired BINDING_CHANGED invalidator')
  })

  it('new records cannot appear directly in CLOSED / ARMED / EVIDENCED', () => {
    for (const to of ['CLOSED', 'ARMED', 'EVIDENCED']) {
      const s = nextRevision()
      const r: ClosureRecord = structuredClone(rec(s, D1))
      r.gate_id = 'FIXTURE_NEW_RECORD'
      r.lifecycle_history = [{ to, at_revision: 3, candidate_sha: r.candidate_sha, basis_fact_ids: ['D1R2-FINAL-STATE'] }]
      r.lifecycle_state = to
      r.evidence.forEach((e) => { if (e.observation_id) delete e.observation_id })
      r.evidence = r.evidence.filter((e) => e.class !== 'PROVIDER_OBSERVATION')
      s.records.push(r)
      const issues = validateNext(s)
      expectRule(issues, 'LIFECYCLE_HISTORY', `a record cannot start in ${to}`)
      expectRule(issues, 'TRANSITION', `a new record cannot appear in ${to}`)
    }
  })

  it('genesis: a record cannot appear ARMED even with a fully evidenced history', () => {
    const s = clone()
    const r = rec(s, INFRA)
    r.lifecycle_history = r.lifecycle_history.slice(0, 4)
    r.lifecycle_state = 'ARMED'
    expect(validate(s)).toEqual([])
    expectRule(validate(s, { genesis: true }), 'GENESIS', 'cannot appear in ARMED')
  })

  it('lifecycle_state must equal the last history entry', () => {
    const s = clone()
    rec(s, D1).lifecycle_state = 'CERTIFIED'
    expectRule(validate(s), 'LIFECYCLE_HISTORY', 'must equal the last history entry')
  })
})

describe('CV1 closure state — monotonic history across revisions', () => {
  it('a fired invalidator cannot return to fired=false', () => {
    const s = nextRevision()
    const v = rec(s, D1).invalidated_by.find((x) => x.predicate_id === 'D1-CANDIDATE-MOVED')!
    v.fired = false
    v.fired_at = null
    v.target = null
    expectRule(validateNext(s), 'TRANSITION', 'returned to fired=false')
  })

  it('an invalidator cannot be removed', () => {
    const s = nextRevision()
    const r = rec(s, D1)
    r.invalidated_by = r.invalidated_by.filter((x) => x.predicate_id !== 'D1-COVERED-PACKAGE')
    expectRule(validateNext(s), 'TRANSITION', 'invalidator D1-COVERED-PACKAGE removed')
  })

  it('a recorded FAIL cannot be erased to restore the earlier state', () => {
    const s3 = nextRevision()
    addCert(rec(s3, D1), 'D1_FA43_RECERT_1', 'D1_FIXTURE_RECERT_FAIL', 'FAIL', 'CERTIFIED_FAIL')
    const s4: ClosureState = structuredClone(s3)
    s4.revision += 1
    const r = rec(s4, D1)
    r.certification_history = []
    r.certification = null
    r.certification_status = 'PENDING_INDEPENDENT_RECERT'
    expectRule(validateClosureState(s4, SCHEMA, { now: LATER, previous: s3 }), 'TRANSITION', 'certification_history rewritten')
  })

  it('a recorded FAIL cannot be rewritten into a PASS in place, nor reused under the same id', () => {
    const s3 = nextRevision()
    addCert(rec(s3, D1), 'D1_FA43_RECERT_1', 'D1_FIXTURE_RECERT_FAIL', 'FAIL', 'CERTIFIED_FAIL')
    const edited: ClosureState = structuredClone(s3)
    edited.revision += 1
    const r = rec(edited, D1)
    r.certification_history[0] = { ...r.certification_history[0], verdict: 'D1_FIXTURE_RECERT_PASS', outcome: 'PASS' }
    r.certification = r.certification_history[0]
    r.certification_status = 'CERTIFIED_PASS'
    const issues = validateClosureState(edited, SCHEMA, { now: LATER, previous: s3 })
    expectRule(issues, 'TRANSITION', 'certification_history rewritten')
    expectRule(issues, 'CERTIFICATION_COHERENCE', 'differs from the value its evidence')

    const reused: ClosureState = structuredClone(s3)
    reused.revision += 1
    addCert(rec(reused, D1), 'D1_FA43_RECERT_1', 'D1_FIXTURE_RECERT_PASS', 'PASS', 'CERTIFIED_PASS')
    expectRule(validateClosureState(reused, SCHEMA, { now: LATER, previous: s3 }), 'CERTIFICATION_COHERENCE', 'duplicate certification_id')
  })

  it('an older certification cannot be restored as the current one', () => {
    const s = clone()
    const r = rec(s, D1)
    addCert(r, 'C1', 'D1_FIXTURE_RECERT_PASS', 'PASS', 'CERTIFIED_PASS')
    addCert(r, 'C2', 'D1_FIXTURE_RECERT_FAIL', 'FAIL', 'CERTIFIED_FAIL')
    r.certification = r.certification_history[0]
    r.certification_status = 'CERTIFIED_PASS'
    expectRule(validate(s), 'CERTIFICATION_COHERENCE', 'must equal the LAST certification_history entry')
  })

  it('evidence and findings cannot be deleted or rewritten between revisions', () => {
    const del = nextRevision()
    const r = rec(del, D1)
    r.evidence = r.evidence.filter((e) => e.fact_id !== 'D1-SCHEDULE-N08')
    r.blocking_findings = r.blocking_findings.filter((f) => f.finding_id !== 'PMR-9')
    const issues = validateNext(del)
    expectRule(issues, 'TRANSITION', 'evidence D1-SCHEDULE-N08 removed')
    expectRule(issues, 'TRANSITION', 'finding PMR-9 removed')

    const rw = nextRevision()
    rec(rw, D1).evidence.find((e) => e.fact_id === 'D1-SCHEDULE-N08')!.value = '2026-10-01T00:00:00Z'
    expectRule(validateNext(rw), 'TRANSITION', 'evidence D1-SCHEDULE-N08 rewritten')
  })

  it('dependency edges cannot be dropped or weakened', () => {
    const drop = nextRevision()
    rec(drop, ROFF).dependencies = []
    expectRule(validateNext(drop), 'TRANSITION', `dependency edge ${RIS} removed`)
    const weak = nextRevision()
    rec(weak, ROFF).dependencies[0].required_state = 'AUTHORED'
    expectRule(validateNext(weak), 'TRANSITION', 'required_state lowered')
  })

  it('records and observations cannot be removed; the revision advances by one', () => {
    const s = nextRevision()
    s.records = s.records.filter((r) => r.gate_id !== RIS)
    rec(s, ROFF).dependencies = []
    s.observations = s.observations.filter((o) => o.observation_id !== 'OBS-INFRA-READ-EXEC-E7C8E67B59BF')
    rec(s, INFRA).evidence = rec(s, INFRA).evidence.filter((e) => e.observation_id !== 'OBS-INFRA-READ-EXEC-E7C8E67B59BF')
    s.revision += 1
    const issues = validateNext(s)
    expectRule(issues, 'TRANSITION', 'record removed')
    expectRule(issues, 'TRANSITION', 'observation removed')
    expectRule(issues, 'TRANSITION', 'revision must advance by exactly 1')
  })
})

describe('CV1 closure state — certification coherence and durable sources', () => {
  it('CERTIFIED_PASS backed only by a free-text `source` is refused', () => {
    const s = clone()
    const r = rec(s, D1)
    const cert: Certification = { certification_id: 'SRC_ONLY', kind: 'INDEPENDENT', verdict: 'D1_RECERT_PASS', outcome: 'PASS', scope: 'BRANCH_LOCAL', certified_sha: r.candidate_sha!, certified_authority_version: r.authority_version, certified_package_digest: r.covered_package_digest, evidence_fact_id: 'EV-SRC' }
    r.evidence.push({ fact_id: 'EV-SRC', class: 'INDEPENDENT_CERTIFICATION', claim: 'owner relayed PASS in chat', source: 'chat' })
    r.certification_history.push(cert)
    r.certification = cert
    r.certification_status = 'CERTIFIED_PASS'
    expectRule(validate(s), 'DURABLE_SOURCE', 'needs a durable INDEPENDENT_CERTIFICATION evidence item')
  })

  it('a value-less pointer (ref/path/field but no expected value) is not durable', () => {
    const s = clone()
    const r = rec(s, D1)
    addCert(r, 'NO_VALUE', 'D1_RECERT_PASS', 'PASS', 'CERTIFIED_PASS')
    delete r.evidence.find((e) => e.fact_id === 'EV-NO_VALUE')!.value
    expectRule(validate(s), 'DURABLE_SOURCE', "'EV-NO_VALUE' is not")
    const f = clone()
    const rf = rec(f, D1)
    rf.evidence.push({ fact_id: 'EV-NOVAL', class: 'REPOSITORY_FACT', claim: 'pointer only', ref: rf.candidate_sha!, path: 'x.json', field: 'status' })
    Object.assign(rf.blocking_findings.find((x) => x.finding_id === 'PMR-9')!, { status: 'RESOLVED', resolution_fact_id: 'EV-NOVAL' })
    expectRule(validate(f), 'FINDING_RESOLUTION', 'durable')
  })

  it('a *_FAIL verdict can never carry a PASS status or outcome', () => {
    const asPass = clone()
    addCert(rec(asPass, D1), 'X', 'D1_RECERT_FAIL', 'PASS', 'CERTIFIED_PASS')
    expectRule(validate(asPass), 'CERTIFICATION_COHERENCE', 'does not agree token-wise')
    const statusOnly = clone()
    addCert(rec(statusOnly, D1), 'X', 'D1_RECERT_FAIL', 'FAIL', 'CERTIFIED_PASS')
    expectRule(validate(statusOnly), 'CERTIFICATION_COHERENCE', 'does not match outcome FAIL')
  })

  it('verdict/outcome agreement is token-based, never substring', () => {
    expect(verdictAgreesWithOutcome('X_RECERT_PASS', 'PASS', VOCAB)).toBe(true)
    expect(verdictAgreesWithOutcome('X_RECERT_PASS_WITH_NONBLOCKING_FINDINGS', 'PASS_WITH_NONBLOCKING_FINDINGS', VOCAB)).toBe(true)
    expect(verdictAgreesWithOutcome('X_RECERT_PASS_WITH_NONBLOCKING_FINDINGS', 'PASS', VOCAB)).toBe(false)
    expect(verdictAgreesWithOutcome('X_RECERT_FAIL_THEN_PASS', 'PASS', VOCAB)).toBe(false)
    expect(verdictAgreesWithOutcome('X_BYPASS', 'PASS', VOCAB)).toBe(false)
    expect(verdictAgreesWithOutcome('X_PASS_BLOCKED', 'BLOCKED', VOCAB)).toBe(false)
    expect(verdictAgreesWithOutcome('X_INSUFFICIENT_EVIDENCE', 'INSUFFICIENT_EVIDENCE', VOCAB)).toBe(true)
  })

  it('a SELF certification cannot enter certification_history', () => {
    const s = clone()
    const r = rec(s, D1)
    addCert(r, 'X', 'D1_RECERT_PASS', 'PASS', 'CERTIFIED_PASS')
    r.certification_history[0].kind = 'SELF'
    r.certification = r.certification_history[0]
    expectRule(validate(s), 'CERTIFICATION_COHERENCE', 'a SELF certification cannot enter certification_history')
  })

  it('CERTIFIED lifecycle without a PASS-class status is refused', () => {
    const s = clone()
    const r = rec(s, D1)
    r.lifecycle_state = 'CERTIFIED'
    r.lifecycle_history.push({ to: 'CERTIFIED', at_revision: 2, candidate_sha: r.candidate_sha, basis_fact_ids: ['D1R2-FINAL-STATE'] })
    expectRule(validate(s), 'LIFECYCLE_CERTIFICATION', 'requires a PASS-class certification status')
  })

  it('a finding RESOLVED without durable repository support is refused', () => {
    const none = clone()
    rec(none, D1).blocking_findings.find((f) => f.finding_id === 'PMR-9')!.status = 'RESOLVED'
    expectRule(validate(none), 'FINDING_RESOLUTION', 'needs resolution_fact_id pointing at a durable evidence item')
    const src = clone()
    const r = rec(src, D1)
    r.evidence.push({ fact_id: 'EV-CHAT', class: 'HUMAN_DECISION', claim: 'owner said resolved', source: 'chat' })
    Object.assign(r.blocking_findings.find((f) => f.finding_id === 'PMR-9')!, { status: 'RESOLVED', resolution_fact_id: 'EV-CHAT' })
    expectRule(validate(src), 'FINDING_RESOLUTION', 'durable')
    const sup = clone()
    Object.assign(rec(sup, D1).blocking_findings.find((f) => f.finding_id === 'PMR-9')!, { status: 'SUPERSEDED', resolution_fact_id: 'D1R2-DAG-FINAL-STATE' })
    expectRule(validate(sup), 'FINDING_RESOLUTION', 'superseded_by')
  })
})

describe('CV1 closure state — required negative controls (R1 set, v1.1.0 shape)', () => {
  it('missing SHA for a SHA-bound state', () => {
    const s = clone()
    rec(s, D1).tree_sha = null
    expectRule(validate(s), 'SHA_BINDING', 'tree_sha required')
    const e = clone()
    delete rec(e, INFRA).lineage_shas.evidence_head
    expectRule(validate(e), 'SHA_BINDING', 'lineage_shas.evidence_head')
  })

  it('stale certification inherited after a covered-path change', () => {
    const s = clone()
    const r = rec(s, INFRA)
    r.candidate_sha = 'a'.repeat(40)
    r.covered_package_digest = 'b'.repeat(64)
    r.certification_inherits_from = { certification_id: r.certification!.certification_id, from_sha: r.certification!.certified_sha, rationale: 'inherit' }
    expectRule(validate(s), 'CERTIFICATION_BINDING', 'COVERED_PATH_CHANGED')
    const noInherit = clone()
    rec(noInherit, INFRA).candidate_sha = 'a'.repeat(40)
    expectRule(validate(noInherit), 'CERTIFICATION_BINDING', 'BINDING_CHANGED')
  })

  it('inheritance across SHAs without both package digests is refused (M16)', () => {
    const s = clone()
    const r = rec(s, INFRA)
    r.candidate_sha = 'a'.repeat(40)
    r.covered_package_digest = null
    r.certification_inherits_from = { certification_id: r.certification!.certification_id, from_sha: r.certification!.certified_sha, rationale: 'inherit' }
    expectRule(validate(s), 'CERTIFICATION_BINDING', 'requires both certified and current package digests')
  })

  it('changed authority with an inherited certification', () => {
    const s = clone()
    const r = rec(s, INFRA)
    r.authority_version = '1.0.10'
    r.certification_inherits_from = { certification_id: r.certification!.certification_id, from_sha: r.certification!.certified_sha, rationale: 'inherit' }
    expectRule(validate(s), 'CERTIFICATION_BINDING', 'AUTHORITY_CHANGED')
  })

  it('expired evidence freshness (record TTL and consumed observation TTL)', () => {
    const s = clone()
    const r = rec(s, INFRA)
    r.evidence_freshness = 'TTL'
    r.evidence_expires_at = '2026-09-24T00:00:00Z'
    expectRule(validate(s), 'FRESHNESS', 'expired')
    const o = clone()
    const obs = o.observations.find((x) => x.observation_id === 'OBS-INFRA-READ-EXEC-E7C8E67B59BF')!
    obs.freshness_class = 'TTL'
    obs.expires_at = '2026-09-24T04:00:00Z'
    expectRule(validate(o), 'FRESHNESS', 'OBS-INFRA-READ-EXEC-E7C8E67B59BF expired')
  })

  it('a fired invalidator targeting the current certification cannot leave it PASS', () => {
    const s = clone()
    const r = rec(s, INFRA)
    Object.assign(r.invalidated_by[0], { fired: true, fired_at: LATER, target: { certification_id: r.certification!.certification_id } })
    expectRule(validate(s), 'FIRED_INVALIDATOR', 'but certification_status is still CERTIFIED_PASS_WITH_NONBLOCKING_FINDINGS')
  })

  it('a fired invalidator needs a target and fired_at', () => {
    const s = clone()
    Object.assign(rec(s, INFRA).invalidated_by[0], { fired: true })
    expectRule(validate(s), 'FIRED_INVALIDATOR', 'needs fired_at and a non-empty target')
  })

  it('NOT_INTEGRATED misread as NOT_IMPLEMENTED', () => {
    const s = clone()
    rec(s, INFRA).implementation_status = 'NOT_IMPLEMENTED'
    expectRule(validate(s), 'IMPLEMENTED_VS_INTEGRATED', 'NOT_INTEGRATED is not NOT_IMPLEMENTED')
  })

  it('branch-local certification presented as integration certification', () => {
    const s = clone()
    const r = rec(s, INFRA)
    r.certification_history[0].scope = 'INTEGRATION'
    r.certification = r.certification_history[0]
    expectRule(validate(s), 'CERTIFICATION_SCOPE', 'branch-local certification presented as INTEGRATION')
    const e = clone()
    rec(e, D1).evidence[0].scope = 'INTEGRATED'
    expectRule(validate(e), 'CERTIFICATION_SCOPE', 'must not be presented as integrated')
  })

  it('execution_allowed=true with an unresolved blocker, an unmet dependency, and no PASS', () => {
    const s = clone()
    rec(s, ROFF).execution_allowed = true
    const issues = validate(s)
    expectRule(issues, 'EXECUTION_ALLOWED', 'unresolved blocking finding(s) OCCURRENCE_NOT_MATERIALIZED')
    expectRule(issues, 'EXECUTION_ALLOWED', 'requires lifecycle ARMED')
    expectRule(issues, 'EXECUTION_ALLOWED', 'requires a PASS-class certification')
    expectRule(issues, 'DEPENDENCY', `dependency ${RIS} is AUTHORED; this edge requires CERTIFIED from CERTIFIED and for execution`)
  })

  it('execution_allowed=true with a consumed observation that fired', () => {
    const s = clone()
    rec(s, D1).execution_allowed = true
    expectRule(validate(s), 'FIRED_INVALIDATOR', 'OBS-GITHUB-PR-HEADS-20260924T130321Z fired but execution_allowed=true')
  })

  it('a dependency without required-state semantics is refused (STOP), and one beyond ARMED cannot defer', () => {
    const s = clone() as unknown as { records: { gate_id: string; dependencies: Record<string, unknown>[] }[] }
    delete s.records.find((r) => r.gate_id === ROFF)!.dependencies[0].required_state
    expect(validate(s).some((i) => i.rule === 'SCHEMA' && i.message.includes("missing required field 'required_state'"))).toBe(true)
    const late = clone()
    rec(late, ROFF).dependencies[0].applies_from_state = 'CLOSED'
    expectRule(validate(late), 'DEPENDENCY', 'applies_from_state CLOSED is after ARMED')
  })

  it('unknown lifecycle / risk / status / outcome values', () => {
    for (const [field, bad] of [['lifecycle_state', 'DONE'], ['risk_tier', 'EXTREME'], ['certification_status', 'APPROVED'], ['integration_status', 'MERGED']] as const) {
      const s = clone() as unknown as { records: Record<string, unknown>[] }
      s.records[0][field] = bad
      expect(validate(s).some((i) => i.rule === 'SCHEMA' && i.message.includes(`unknown value "${bad}"`))).toBe(true)
    }
    const o = clone()
    ;(rec(o, INFRA).certification_history[0] as unknown as Record<string, unknown>).outcome = 'MOSTLY_PASS'
    expect(validate(o).some((i) => i.rule === 'SCHEMA' && i.message.includes('unknown value "MOSTLY_PASS"'))).toBe(true)
  })
})

describe('CV1 closure state — further negative controls', () => {
  it('EXECUTED on INFERENCE alone is refused', () => {
    const s = clone()
    const r = rec(s, INFRA)
    r.observed_at = null
    r.evidence = r.evidence.map((e) => {
      if (e.class !== 'REPOSITORY_FACT' && e.class !== 'PROVIDER_OBSERVATION') return e
      const rest: EvidenceItem = { ...e, class: 'INFERENCE', derived_from: ['INFRA-RECERT-VERDICT'] }
      delete rest.observation_id
      return rest
    })
    s.observations.forEach((o) => (o.consumers = o.consumers.filter((c) => c !== INFRA)))
    s.observations = s.observations.filter((o) => o.consumers.length > 0)
    const issues = validate(s)
    expectRule(issues, 'EXECUTED_EVIDENCE', 'INFERENCE alone never suffices')
    expectRule(issues, 'EXECUTED_EVIDENCE', 'requires observed_at')
  })

  it('the same provider read duplicated per consumer is refused; consumers must match citations', () => {
    const s = clone()
    const dup = structuredClone(s.observations[0])
    dup.observation_id = 'OBS-DUPLICATE-READ'
    dup.consumers = [D1]
    s.observations.push(dup)
    const issues = validate(s)
    expectRule(issues, 'REFERENCES', 'duplicates the same provider read')
    expectRule(issues, 'REFERENCES', 'consumers must equal citing records')
  })

  it('evidence-class requirements', () => {
    const s = clone()
    rec(s, D1).evidence.push({ fact_id: 'BARE', class: 'REPOSITORY_FACT', claim: 'no pointer' })
    expectRule(validate(s), 'EVIDENCE_CLASS', 'REPOSITORY_FACT requires ref and path')
  })

  it('the schema interpreter refuses keywords it does not implement', () => {
    const issues = validateSchema({ type: 'string', format: 'date-time' }, 'x')
    expect(issues.some((i) => i.message.includes("unsupported schema keyword 'format'"))).toBe(true)
  })
})

describe('secrets — keys and values, never printed', () => {
  // Built at runtime so this file itself carries no credential-shaped literal.
  const samples: [string, string][] = [
    ['github-token', 'gh' + 'p_' + 'A1b2C3d4'.repeat(5)],
    ['connection-uri-with-credentials', 'postgres' + '://user:' + 'pw1234@db.example.invalid:5432/x'],
    ['jwt', 'ey' + 'J' + 'hbGciOiJIUzI1NiJ9' + '.' + 'ey' + 'J' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36P'],
    ['aws-access-key-id', 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'],
    ['supabase-access-token', 'sb' + 'p_' + '0123456789abcdef0123456789abcdef01234567'],
    ['bearer-token', 'Authorization: Bear' + 'er ' + 'abcDEF1234567890abcDEF.xyz'],
  ]
  for (const [name, value] of samples) {
    it(`detects a ${name} value without echoing it`, () => {
      const s = clone()
      rec(s, D1).notes = `leak ${value}`
      const issues = validate(s)
      expectRule(issues, 'NO_SECRET_MATERIAL', name)
      expect(JSON.stringify(issues)).not.toContain(value)
    })
  }
  it('detects secret-bearing object keys anywhere, including free-form evidence values', () => {
    const s = clone()
    rec(s, D1).evidence.push({ fact_id: 'EV-KEY', class: 'REPOSITORY_FACT', claim: 'x', ref: 'a'.repeat(40), path: 'x.json', field: 'x', value: { api_key: 'redacted', nested: { Password: 'x' } } })
    const issues = scanSecrets(s)
    expect(issues.filter((i) => i.message.includes('secret-bearing key')).length).toBe(2)
    expect(JSON.stringify(issues)).not.toContain('redacted')
  })
})

describe('single vocabulary source — schema self-consistency', () => {
  const broken = (mutate: (sc: typeof SCHEMA) => void) => {
    const sc = structuredClone(SCHEMA)
    mutate(sc)
    return validateClosureState(BASELINE, sc, { now: NOW })
  }
  it('an x-vocabulary token outside its enum is refused', () => {
    expectRule(broken((sc) => { sc['x-vocabulary'].pass_statuses.push('CERTIFIED_MAYBE') }), 'SCHEMA_CONSISTENCY', 'CERTIFIED_MAYBE')
  })
  it('an x-vocabulary key with no enum binding is refused', () => {
    expectRule(broken((sc) => { sc['x-vocabulary'].extra_states = ['CLOSED'] }), 'SCHEMA_CONSISTENCY', 'extra_states is not bound')
  })
  it('a transition graph that disagrees with the lifecycle ladder is refused', () => {
    expectRule(broken((sc) => { sc['x-transition-graph'].forward.AUTHORED.to = 'MATERIALIZED' }), 'SCHEMA_CONSISTENCY', 'must lead to CERTIFIED')
  })
  it('the nullable certification shape cannot drift from certification_entry', () => {
    expectRule(broken((sc) => { delete sc.$defs.certification.properties.outcome }), 'SCHEMA_CONSISTENCY', 'same shape')
  })
})

describe('git layer (disposable fixture repos)', () => {
  const repos: string[] = []
  afterEach(() => { while (repos.length) cleanupTempGitRepo(repos.pop()!) })

  function fixture() {
    const dir = makeTempGitRepo()
    repos.push(dir)
    git(dir, ['checkout', '-q', '-b', 'main'])
    const base = commitFile(dir, 'README.md', 'base\n')
    git(dir, ['checkout', '-q', '-b', 'lane'])
    const c1 = commitFile(dir, 'pkg/a.json', JSON.stringify({ version: '1.0.0', final_state: 'READY' }))
    commitFile(dir, 'pkg/b.json', JSON.stringify({ b: true }))
    const c2 = commitFile(dir, 'pkg/a.json', JSON.stringify({ version: '1.0.0', final_state: 'READY', edited: true }))
    const tree = (sha: string) => git(dir, ['rev-parse', `${sha}^{tree}`])
    return { dir, base, c1, c2, tree }
  }

  function stateFor(f: ReturnType<typeof fixture>, candidate: string, over: Partial<ClosureRecord> = {}): ClosureState {
    const record: ClosureRecord = {
      gate_id: 'FIXTURE_GATE', milestone: 'fixture', lifecycle_state: 'AUTHORED',
      lifecycle_history: [{ to: 'AUTHORED', at_revision: 1, candidate_sha: candidate, basis_fact_ids: ['F1'] }],
      implementation_status: 'NOT_APPLICABLE', integration_status: 'NOT_INTEGRATED',
      candidate_sha: candidate, tree_sha: f.tree(candidate), lineage_shas: {},
      authority: { path: 'pkg/a.json', ref: candidate }, authority_version: '1.0.0',
      certification: null, certification_history: [], certification_status: 'PENDING_INDEPENDENT_RECERT', certification_inherits_from: null,
      covered_paths: ['pkg'], covered_package_digest: packageDigest(f.dir, candidate, ['pkg'])!,
      evidence: [{ fact_id: 'F1', class: 'REPOSITORY_FACT', claim: 'final state', ref: candidate, path: 'pkg/a.json', field: 'final_state', value: 'READY', scope: 'BRANCH_LOCAL' }],
      evidence_freshness: 'SHA_BOUND', evidence_expires_at: null, observed_at: null, invalidated_by: [],
      dependencies: [], blocking_findings: [], branch: 'lane', pr: null, execution_allowed: false,
      risk_tier: 'LOW', next_legal_act: 'recert', unconfirmed: [], ...over,
    }
    return {
      state_id: 'CV1_CLOSURE_STATE', schema_version: '1.1.0', state_class: 'OPERATIONAL_DERIVED_STATE', not_authority: true,
      revision: 1, as_of: NOW, written_by_lane: 'FIXTURE',
      integration_base: { branch: 'main', sha: f.base, tree_sha: f.tree(f.base) },
      records: [record], observations: [], unconfirmed: [],
    } as unknown as ClosureState
  }

  it('positive: a faithful state re-derives cleanly from git', () => {
    const f = fixture()
    expect(validateClosureState(stateFor(f, f.c1), SCHEMA, { now: NOW, gitCwd: f.dir })).toEqual([])
  })

  it('the package digest does not depend on path order (M10)', () => {
    const f = fixture()
    const ab = packageDigest(f.dir, f.c2, ['pkg/a.json', 'pkg/b.json'])
    const ba = packageDigest(f.dir, f.c2, ['pkg/b.json', 'pkg/a.json'])
    expect(ab).toBeDefined()
    expect(ab).toBe(ba)
  })

  it('negative: a covered-path change after certification is detected by digest', () => {
    const f = fixture()
    const d1 = packageDigest(f.dir, f.c1, ['pkg'])!
    const s = stateFor(f, f.c2, { covered_package_digest: d1 })
    s.records[0].evidence[0].ref = f.c2
    s.records[0].authority = { path: 'pkg/a.json', ref: f.c2 }
    expectRule(verifyGit(s, f.dir, VOCAB), 'GIT', 'covered_package_digest mismatch')
  })

  it('negative: an INTEGRATED claim that git ancestry refutes', () => {
    const f = fixture()
    expectRule(verifyGit(stateFor(f, f.c1, { integration_status: 'INTEGRATED' }), f.dir, VOCAB), 'GIT', 'contradicts git')
  })

  it('negative: a recorded evidence value that the ref does not contain', () => {
    const f = fixture()
    const s = stateFor(f, f.c1)
    s.records[0].evidence[0].value = 'CLOSED'
    expectRule(verifyGit(s, f.dir, VOCAB), 'GIT', 'field final_state = "READY" != recorded "CLOSED"')
  })

  it('negative: a wrong tree, and a gate_id shadowing the canonical ledger', () => {
    const f = fixture()
    expectRule(verifyGit(stateFor(f, f.c1, { tree_sha: f.tree(f.c2) }), f.dir, VOCAB), 'GIT', 'tree_sha')
    mkdirSync(path.join(f.dir, 'docs/ops/release'), { recursive: true })
    writeFileSync(path.join(f.dir, 'docs/ops/release/RELEASE_GATE_LEDGER_v1.0.0.json'), JSON.stringify({ GATES: [{ id: 'FIXTURE_GATE' }] }))
    expectRule(verifyGit(stateFor(f, f.c1), f.dir, VOCAB), 'GIT', 'collides')
  })

  it('packageDigest refuses a partial package', () => {
    const f = fixture()
    expect(packageDigest(f.dir, f.c1, ['pkg', 'missing/path'])).toBeUndefined()
  })

  describe('ci: previous projection derived from the merge-base', () => {
    function withSchema(f: ReturnType<typeof fixture>) {
      git(f.dir, ['checkout', '-q', 'main'])
      commitFile(f.dir, CLOSURE_STATE_SCHEMA_PATH, readFileSync(path.join(ROOT, CLOSURE_STATE_SCHEMA_PATH), 'utf8'))
    }
    it('genesis when the base lacks the projection; unchanged when identical; transition-checked when changed', () => {
      const f = fixture()
      withSchema(f)
      git(f.dir, ['checkout', '-q', 'lane'])
      git(f.dir, ['merge', '-q', '--no-edit', 'main'])
      const s1 = stateFor(f, f.c1)
      commitFile(f.dir, CLOSURE_STATE_PATH, JSON.stringify(s1, null, 2))
      const g = runCi(f.dir, 'main', LATER)
      expect(g.mode).toBe('CHANGED_GENESIS')
      expect(g.issues).toEqual([])

      // The projection lands on main; a later lane that erases evidence is caught.
      git(f.dir, ['checkout', '-q', 'main'])
      git(f.dir, ['merge', '-q', '--no-edit', 'lane'])
      expect(runCi(f.dir, 'main', LATER).mode).toBe('UNCHANGED')
      git(f.dir, ['checkout', '-q', '-b', 'lane2'])
      const s2: ClosureState = structuredClone(s1)
      s2.revision = 2
      s2.records[0].evidence.push({ fact_id: 'F2', class: 'REPOSITORY_FACT', claim: 'b', ref: f.c1, path: 'pkg/a.json', field: 'version', value: '1.0.0' })
      s2.records[0].lifecycle_history[0].basis_fact_ids = ['F2']
      s2.records[0].evidence = s2.records[0].evidence.filter((e) => e.fact_id !== 'F1')
      commitFile(f.dir, CLOSURE_STATE_PATH, JSON.stringify(s2, null, 2))
      const c = runCi(f.dir, 'main', LATER)
      expect(c.mode).toBe('CHANGED_WITH_PREVIOUS')
      expectRule(c.issues, 'TRANSITION', 'evidence F1 removed')
    })
  })
})

describe('RUN_STATE contract', () => {
  const own1 = 'c'.repeat(40)
  const own2 = 'e'.repeat(40)
  const valid = {
    run_state_version: '1.1.0', lane: 'FIXTURE-LANE-R1', role: 'writer', base: 'a'.repeat(40), candidate: own2,
    branch: 'codex/fixture', worktree: 'C:/w', done_when: ['x'], completed: [], active: 'step', remaining: [], findings: [],
    unconfirmed: [], needs_from_owner: [], own_commits: [own1, own2], last_verified_head: own2, updated_at: '2026-09-24T00:00:00Z',
  }
  const expected = { lane: 'FIXTURE-LANE-R1', role: 'writer', branch: 'codex/fixture', base: 'a'.repeat(40) }
  const measured = (head: string, branch = 'codex/fixture') => ({ head, branch })

  it('positive: a well-formed RUN_STATE validates and resumes on its own identity', () => {
    expect(validateRunState(valid, RUN_SCHEMA)).toEqual([])
    expect(checkRunStateResume(valid, measured(own2), expected).verdict).toBe('RESUME')
  })

  it('negative: a missing identity field is refused', () => {
    const rest: Record<string, unknown> = { ...valid }
    delete rest.branch
    expect(validateRunState(rest, RUN_SCHEMA).some((i) => i.message.includes("missing required field 'branch'"))).toBe(true)
  })

  it('negative: another lane, role, base, branch or candidate at the same HEAD is DRIFT (HEAD alone is insufficient)', () => {
    for (const [k, v] of [['lane', 'OTHER-LANE'], ['role', 'reviewer'], ['base', 'b'.repeat(40)], ['branch', 'codex/other']] as const) {
      const r = checkRunStateResume({ ...valid, [k]: v }, measured(own2), expected)
      expect(r.verdict, k).toBe('DRIFT')
    }
    expect(checkRunStateResume(valid, measured(own2, 'codex/other'), expected).verdict).toBe('DRIFT')
    expect(checkRunStateResume(valid, measured(own2), { ...expected, candidate: own1 }).verdict).toBe('DRIFT')
    expect(checkRunStateResume({ ...valid, candidate: 'f'.repeat(40) }, measured(own2), expected).verdict).toBe('DRIFT')
  })

  it('negative: HEAD at an EARLIER own commit is DRIFT, only the last one resumes (M14)', () => {
    const rs = { ...valid, last_verified_head: 'd'.repeat(40) }
    expect(checkRunStateResume(rs, measured(own2), expected).verdict).toBe('RESUME')
    expect(checkRunStateResume(rs, measured(own1), expected).verdict).toBe('DRIFT')
  })

  it('location: a RUN_STATE inside a git repository is refused; the root falls back to a verified non-git location', () => {
    const repo = makeTempGitRepo()
    try {
      expect(isInsideGit(path.join(repo, 'uellix-runs', 'LANE'))).toBe(true)
      expect(validateRunState(valid, RUN_SCHEMA, path.join(repo, 'uellix-runs')).some((i) => i.rule === 'RUN_STATE_LOCATION')).toBe(true)
    } finally {
      cleanupTempGitRepo(repo)
    }
    const inGit = (d: string) => d.startsWith(path.join('T', 'x'))
    const env = { TEMP: path.join('T', 'x'), LOCALAPPDATA: path.join('L', 'y') }
    expect(resolveRunStateRoot(env, inGit).root).toBe(path.join('L', 'y', 'uellix-runs'))
    expect(resolveRunStateRoot(env, () => true).root).toBeUndefined()
    expect(resolveRunStateRoot(env, () => false).root).toBe(path.join('T', 'x', 'uellix-runs'))
  })
})

describe('CI integration', () => {
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  it('ci.yml runs closure-state validation against the merge-base, before tests, without swallowing its exit code', () => {
    const i = ci.indexOf('pnpm ops:closure-state -- ci --base')
    expect(i).toBeGreaterThan(-1)
    expect(i).toBeGreaterThan(ci.indexOf('pnpm install --frozen-lockfile'))
    expect(i).toBeLessThan(ci.indexOf('run: pnpm test:unit'))
    const blockStart = ci.lastIndexOf('- name:', i)
    const blockEnd = ci.indexOf('- name:', i + 1)
    expect(ci.slice(blockStart, blockEnd)).not.toMatch(/continue-on-error:\s*true/)
    expect(ci.slice(blockStart, blockEnd)).toMatch(/github\.base_ref/)
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
