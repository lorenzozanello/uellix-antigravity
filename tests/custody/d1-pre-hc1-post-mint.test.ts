// @vitest-environment node
// tests/custody/d1-pre-hc1-post-mint.test.ts
//
// N10'S POST-MINT READINESS CONJUNCTS (effective across the DAG chain), AND
// THE NEGATIVE CONTROLS THAT SHOW THE EVALUATOR CAN SAY NO TO EACH OF THEM.
//
// Every control changes ONE gathered input and watches ONE conjunct fail. The
// positive control builds an input in which every conjunct holds — including a
// synthetic certification event bound to a synthetic candidate — so the
// evaluator is also shown able to say yes.

import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { CONJUNCT_EVALUATORS, evaluatePostMintConjuncts, gatherPostMintInputs, readChain, type PostMintInputs } from '@/scripts/custody/d1-pre-hc1-post-mint'
import { checkInventorySurfaces, deriveDeliveries } from '@/scripts/custody/d1-delivery-matrix'
import { graphNodes } from '@/scripts/custody/d1-dag-validate'
import { eventPathFor, evaluateCandidateBinding } from '@/scripts/custody/d1-candidate-certification'
import { evaluatePreHc1, measureRepoFacts } from '@/scripts/custody/d1-pre-hc1'

const ROOT = process.cwd()
const REAL = gatherPostMintInputs(ROOT)
/** What the certification of THIS checkout mechanically is: derived from git and the event files, never assumed. */
const LIVE_CERTIFICATION = evaluateCandidateBinding(REAL.candidate)

const CAND = 'c'.repeat(40)
const TREE = 'd'.repeat(40)
const DIGEST = 'e'.repeat(64)
const GOOD_EVENT = {
  path: eventPathFor(CAND),
  body: {
    event_class: 'D1_PREHC1_PACKAGE_INDEPENDENT_CERTIFICATION',
    candidate_commit: CAND,
    candidate_tree: TREE,
    verdict: 'X_PASS',
    verdict_class: 'PASS',
    blocking_findings: 0,
    package_closure_digest: DIGEST,
    certifier_is_not_the_author: true,
  },
}

/** Every conjunct satisfied: the real inputs, plus a certified synthetic candidate and demonstrations on the current closures. */
const ALL_GOOD: PostMintInputs = {
  ...REAL,
  demonstrations: Object.fromEntries(Object.entries(REAL.currentClosureBlobs).map(([id, blobs]) => [id, [{ overall: 'SATISFIED_CANDIDATE', closureBlobs: blobs }]])),
  candidate: {
    headCommit: CAND,
    headTree: TREE,
    workingTreeClean: true,
    currentDigest: DIGEST,
    events: [GOOD_EVENT],
    git: { [CAND]: { exists: true, tree: TREE, isAncestorOfHead: true, deltaToHead: [] } },
  },
}
const unsat = (i: PostMintInputs): readonly string[] => evaluatePostMintConjuncts(i).unsatisfied
const withEvent = (over: Record<string, unknown>): PostMintInputs => ({ ...ALL_GOOD, candidate: { ...ALL_GOOD.candidate, events: [{ ...GOOD_EVENT, body: { ...GOOD_EVENT.body, ...over } }] } })

describe('the repository as it stands', () => {
  it('derives the effective conjuncts from the chain and has an evaluator for each', () => {
    expect(REAL.chain.chainErrors).toEqual([])
    expect(REAL.chain.conjunctIds.length).toBeGreaterThanOrEqual(9)
    for (const id of REAL.chain.conjunctIds) expect(CONJUNCT_EVALUATORS[id], id).toBeDefined()
  })
  // B-NEW-1: these assertions hold in EVERY certification state of the checkout
  // (no event, a valid event, an invalid one). They never pin PMR-9 to a fixed
  // value, which is what made the certifier's event turn the suite red; the
  // termination regression plays that move on a real copy.
  it('PMR-9 is exactly the mechanically derived certification state of this checkout', () => {
    expect(unsat(REAL).includes('PMR-9_CANDIDATE_CERTIFIED')).toBe(!LIVE_CERTIFICATION.eligible)
    if (REAL.candidate.events.length === 0) expect(LIVE_CERTIFICATION.eligible).toBe(false)
    expect(unsat(REAL)).not.toContain('PMR-7_NO_OPEN_AUTHORITY_CONFLICT')
    expect(unsat(REAL)).not.toContain('PMR-10_RULINGS_MATCH_IMPLEMENTATION')
  })
  it('with only an invalid event for this very HEAD, PMR-9 is unsatisfied', () => {
    const bad = { ...GOOD_EVENT, path: eventPathFor(REAL.candidate.headCommit), body: { ...GOOD_EVENT.body, candidate_commit: REAL.candidate.headCommit, candidate_tree: REAL.candidate.headTree, verdict_class: 'FAIL' } }
    expect(unsat({ ...REAL, candidate: { ...REAL.candidate, events: [bad] } })).toContain('PMR-9_CANDIDATE_CERTIFIED')
  })
  it('and N10 is the conjunction of what was measured: PMR-9 as derived, READY only with nothing unsatisfied', () => {
    const f = measureRepoFacts(ROOT, [], false)
    const ev = evaluatePreHc1(ROOT, { declaredBase: { branch: f.branch, head: f.head, tree: f.tree }, liveIntegration: false })
    expect(ev.n10.unsatisfied.includes('PMR-9_CANDIDATE_CERTIFIED')).toBe(!LIVE_CERTIFICATION.eligible)
    expect(ev.n10.readiness).toBe(ev.n10.unsatisfied.length === 0 ? 'READY_FOR_HUMAN_CONFIRMATION' : 'NOT_READY')
  }, 180_000)
})

describe('the positive control', () => {
  it('with every conjunct input satisfied, nothing is unsatisfied', () => {
    expect(unsat(ALL_GOOD)).toEqual([])
  })
})

describe('negative controls (one input each)', () => {
  const impl = ALL_GOOD.implementation
  const cases: Array<[string, Partial<PostMintInputs>, string | string[]]> = [
    ['owner decision record missing', { ownerDecision: null }, ['PMR-1_MINT_ROUTE_RATIFIED', 'PMR-3_PASSWORD_NULL_SEMANTICS']],
    ['mint route different from the ratified one', { ownerDecision: { ...REAL.ownerDecision!, D1_MINT_ROUTE: 'A_MANAGEMENT_PLANE' } }, 'PMR-1_MINT_ROUTE_RATIFIED'],
    ['operator tool infeasible', { operatorToolFeasibility: { verdict: 'STOP_OPERATOR_TOOL_DEPENDENCY_GAP', driver: 'pg' } }, 'PMR-2_OPERATOR_TOOL_FEASIBLE'],
    ['PASSWORD NULL semantics missing', { ownerDecision: { ...REAL.ownerDecision!, D1_PASSWORD_NULL_REQUIRES_SEPARATE_HUMAN_CONFIRMATION: '' } }, 'PMR-3_PASSWORD_NULL_SEMANTICS'],
    ['N06 on an old topology', { inventorySurfaceReasons: ['processes_or_environments omits surface MINT_OPERATOR_TRANSIENT_SURFACE'] }, 'PMR-4_N06_REDERIVED_FOR_TOPOLOGY'],
    ['N13 consumer absent', { entryFilesPresent: { ...REAL.entryFilesPresent, 'scripts/custody/d1-auditor-n13-consumer.ts': false } }, 'PMR-5_IN_DAG_CONSUMERS_IMPLEMENTED'],
    ['N14 consumer absent', { entryFilesPresent: { ...REAL.entryFilesPresent, 'scripts/custody/d1-auditor-n14-consumer.ts': false } }, 'PMR-5_IN_DAG_CONSUMERS_IMPLEMENTED'],
    ['N22 consumer absent', { entryFilesPresent: { ...REAL.entryFilesPresent, 'scripts/custody/d1-auditor-n22-consumer.ts': false } }, 'PMR-5_IN_DAG_CONSUMERS_IMPLEMENTED'],
    ['one topology demonstration missing', { demonstrations: Object.fromEntries(Object.entries(ALL_GOOD.demonstrations).filter(([k]) => k !== 'DL-N22')) }, 'PMR-6_TOPOLOGY_DEMONSTRATED_PER_CONSUMER'],
    [
      'a demonstration on a closure that has since changed',
      { currentClosureBlobs: { ...REAL.currentClosureBlobs, 'DL-N14': { ...REAL.currentClosureBlobs['DL-N14'], 'db/custody/p1-reads.ts': '0'.repeat(40) } } },
      'PMR-6_TOPOLOGY_DEMONSTRATED_PER_CONSUMER',
    ],
    ['CONTROL successor-ruling-ignored (chain read only to v1.0.5)', { chain: readChain(ROOT, [...REAL.chain.sourcesRead].filter((s) => !s.includes('v1.0.6'))) }, ['PMR-7_NO_OPEN_AUTHORITY_CONFLICT', 'PMR-8_PACKAGE_CERTIFIED_AT_CURRENT_BLOBS']],
    ['CONTROL AC-1 resolved but TABLE_PRIVILEGES still blocked', { implementation: { ...impl, tablePrivileges: { ...impl.tablePrivileges, disposition: 'DEFERRED_TO_PRECHECK_R2' } } }, 'PMR-10_RULINGS_MATCH_IMPLEMENTATION'],
    ['CONTROL AC-1 adds another relation', { implementation: { ...impl, tablePrivilegePairs: [...impl.tablePrivilegePairs, 'public.organizations|SELECT'] } }, 'PMR-10_RULINGS_MATCH_IMPLEMENTATION'],
    ['CONTROL AC-1 adds another privilege', { implementation: { ...impl, tablePrivilegePairs: [...impl.tablePrivilegePairs, 'public.users|INSERT'] } }, 'PMR-10_RULINGS_MATCH_IMPLEMENTATION'],
    ['CONTROL AC-1 dynamic object name', { implementation: { ...impl, tablePrivilegePairs: [...impl.tablePrivilegePairs, '(non-literal has_table_privilege call)'] } }, 'PMR-10_RULINGS_MATCH_IMPLEMENTATION'],
    ['CONTROL AC-1 text differs from the pin', { implementation: { ...impl, tablePrivileges: { ...impl.tablePrivileges, sql: `${impl.tablePrivileges.sql} ` } } }, 'PMR-10_RULINGS_MATCH_IMPLEMENTATION'],
    ['CONTROL AC-2 introduces role enumeration', { implementation: { ...impl, reachIsKeyed: false } }, 'PMR-10_RULINGS_MATCH_IMPLEMENTATION'],
    ['CONTROL NB-4 another statement enumerates roles', { implementation: { ...impl, roleEnumerationFindings: ['MEMBERSHIPS: pattern match or uellix_cap_ reference'] } }, 'PMR-10_RULINGS_MATCH_IMPLEMENTATION'],
    ['CONTROL AC-2 accepted without its structural proof', { implementation: { ...impl, pv14WhenProofFails: 'PASS' } }, 'PMR-10_RULINGS_MATCH_IMPLEMENTATION'],
    ['CONTROL AC-3 FUNCTION_EXECUTE still required by a provisioning exit', { implementation: { ...impl, functionExecute: { ...impl.functionExecute, inN22: true } } }, 'PMR-10_RULINGS_MATCH_IMPLEMENTATION'],
    ['CONTROL AC-3 FUNCTION_EXECUTE issuable', { implementation: { ...impl, functionExecute: { ...impl.functionExecute, disposition: 'ISSUABLE' } } }, 'PMR-10_RULINGS_MATCH_IMPLEMENTATION'],
    ['CONTROL AC-3 silently PASSes PV-24/25', { implementation: { ...impl, deferredRowVerdicts: ['PASS', 'PASS'] } }, 'PMR-10_RULINGS_MATCH_IMPLEMENTATION'],
    ['CONTROL candidate SHA mismatch', { candidate: { ...ALL_GOOD.candidate, headCommit: 'f'.repeat(40), git: { [CAND]: { exists: true, tree: TREE, isAncestorOfHead: false, deltaToHead: [] } } } }, 'PMR-9_CANDIDATE_CERTIFIED'],
    ['CONTROL candidate tree mismatch', { candidate: { ...ALL_GOOD.candidate, git: { [CAND]: { exists: true, tree: 'a'.repeat(40), isAncestorOfHead: true, deltaToHead: [] } } } }, 'PMR-9_CANDIDATE_CERTIFIED'],
    [
      'CONTROL uncertified post-certification code edit',
      { candidate: { ...ALL_GOOD.candidate, headCommit: 'b'.repeat(40), git: { [CAND]: { exists: true, tree: TREE, isAncestorOfHead: true, deltaToHead: [['A', GOOD_EVENT.path], ['M', 'scripts/custody/d1-consumer-shell.ts']] } } } },
      'PMR-9_CANDIDATE_CERTIFIED',
    ],
    ['CONTROL wrong recert event (path not derived from its candidate)', { candidate: { ...ALL_GOOD.candidate, events: [{ ...GOOD_EVENT, path: eventPathFor('0'.repeat(40)) }] } }, 'PMR-9_CANDIDATE_CERTIFIED'],
    ['CONTROL FAIL recert', withEvent({ verdict_class: 'FAIL' }), 'PMR-9_CANDIDATE_CERTIFIED'],
    ['CONTROL blocking_findings > 0', withEvent({ blocking_findings: 2 }), 'PMR-9_CANDIDATE_CERTIFIED'],
    ['CONTROL self-certification', withEvent({ certifier_is_not_the_author: false }), 'PMR-9_CANDIDATE_CERTIFIED'],
    ['CONTROL digest of a different package', withEvent({ package_closure_digest: '1'.repeat(64) }), 'PMR-9_CANDIDATE_CERTIFIED'],
  ]
  it.each(cases)('%s -> only its conjunct fails', (_name, change, conjunct) => {
    expect(unsat({ ...ALL_GOOD, ...change })).toEqual(Array.isArray(conjunct) ? conjunct : [conjunct])
  })
  it('CONTROL delivery-consumer-in-successor-omitted: a HOSTED_SQL session node added by a later amendment is a gap', () => {
    const nodes = [...graphNodes(), { id: 'N33', plane: 'HOSTED_SQL', act: 'Read the privilege state again as uellix_auditor.', source: 'v9.9.9' }]
    const { gaps } = deriveDeliveries(ROOT, nodes)
    expect(gaps).toEqual(['N33 opens a session as uellix_auditor and has no registered consumer'])
    expect(unsat({ ...ALL_GOOD, deliveryGaps: gaps })).toEqual(['PMR-5_IN_DAG_CONSUMERS_IMPLEMENTED'])
  })
  it('an unregistered conjunct id, or a chain that cannot be read, is NOT_READY', () => {
    expect(unsat({ ...ALL_GOOD, chain: { ...ALL_GOOD.chain, conjunctIds: [...ALL_GOOD.chain.conjunctIds, 'PMR-99_UNKNOWN'] } })).toEqual(['PMR-99_UNKNOWN'])
    expect(unsat({ ...ALL_GOOD, chain: { ...ALL_GOOD.chain, chainErrors: ['x'] } })).toHaveLength(1)
    expect(unsat({ ...ALL_GOOD, chain: { ...ALL_GOOD.chain, conjunctIds: [] } })).toHaveLength(1)
  })
  it('a superseded conjunct cannot be revived by listing it again (PMR-8 always fails)', () => {
    expect(unsat({ ...ALL_GOOD, chain: { ...ALL_GOOD.chain, conjunctIds: [...ALL_GOOD.chain.conjunctIds, 'PMR-8_PACKAGE_CERTIFIED_AT_CURRENT_BLOBS'] } })).toEqual(['PMR-8_PACKAGE_CERTIFIED_AT_CURRENT_BLOBS'])
  })
})

describe('the inputs are measured, not asserted', () => {
  it('the inventory at the base of the post-mint completeness lane (old topology) fails the surface check', () => {
    const old = JSON.parse(
      execFileSync('git', ['show', '3def3c5b7b82747a3d4533aa6badccb0043cffff:docs/ops/staging/FIBDB053_AUDITOR_CREDENTIAL_CUSTODY_INVENTORY_v1.0.0.json'], { cwd: ROOT, encoding: 'utf8' })
    ) as { entries: Array<Record<string, unknown>> }
    expect(checkInventorySurfaces(ROOT, old.entries[0]!.processes_or_environments)).toContain('processes_or_environments omits surface MINT_OPERATOR_TRANSIENT_SURFACE')
  })
  it('the current inventory lists every derived surface and delivery, derived over the whole chain', () => {
    expect(REAL.inventorySurfaceReasons).toEqual([])
    expect(REAL.deliveries.map((d) => d.id)).toEqual(['DL-N13', 'DL-N14', 'DL-N21', 'DL-N22', 'DL-N23', 'DL-FINAL-WITNESS'])
  })
  it('a stale declared base stops N01 and keeps N10 NOT_READY', () => {
    const f = measureRepoFacts(ROOT, [], false)
    const ev = evaluatePreHc1(ROOT, { declaredBase: { branch: f.branch, head: '0'.repeat(40), tree: f.tree }, liveIntegration: false })
    expect(ev.n01.status).toBe('STOP')
    expect(ev.n10.readiness).toBe('NOT_READY')
  }, 180_000)
})
