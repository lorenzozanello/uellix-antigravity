// tests/hosted/authority/red-team.test.ts
// COMMIT 3 — the attacks, each one attempted and each one refused.
//
// These are not "does the happy path work" tests. Each case constructs the
// mutation an adversary (or a tired operator at 3am) would actually make, and
// asserts the plan REFUSES it. A refusal that only exists in a comment is not a
// refusal.
//
// Numbering follows the operator's red-team list so a finding can be traced
// back to the attack that motivated it.

import { describe, expect, it } from 'vitest'

import {
  assertDoBlockHasOneExecutor,
  assertExecutorMatchesOwnership,
  assertNoConcurrentCapabilityLifecycles,
  assertSingleExecutorPerSegment,
  buildAuthorityPlan,
  segmentRows,
  type ExecutionSegment,
} from '@/db/hosted/authority/classification-manifest'
import {
  assertCleanupComplete,
  assertNoTransitiveElevation,
  membershipEdges,
} from '@/db/hosted/authority/primitives'
import { assertNoSessionRoleGrantee } from '@/db/hosted/authority/membership-tripwire'
import type { SimulatedStatement } from '@/db/hosted/authority/ownership-simulation'

const plan = buildAuthorityPlan()
const segmentOf = (id: string): ExecutionSegment =>
  plan.segments.find((s) => s.segmentId === id) as ExecutionSegment

/* -------------------------------------------------------------------------- */
/* 17 — force W38 to a single executor                                         */
/* -------------------------------------------------------------------------- */

describe('17: W38 forced to one executor despite two capability owners', () => {
  it('is refused', () => {
    // The attack: merge W38's two segments back into one, the way a scalar
    // `capabilityRole` field would have forced. Ten statements belong to
    // uellix_cap_stella_quota and two to uellix_cap_stella_ticket.
    const window = plan.windows.find((w) => w.windowId === 'W38')
    expect(window).toBeDefined()

    const merged: ExecutionSegment = {
      ...segmentOf('W38.S1'),
      segmentId: 'W38.MERGED',
      statementCount: window!.structuralStatementCount,
    }

    expect(() =>
      assertSingleExecutorPerSegment([merged], () => window!.members),
    ).toThrow(/AUTHORITY_EXECUTION_SEGMENT_MULTIPLE_ROLES/)
  })

  it('and the plan as derived never produces such a segment', () => {
    expect(() =>
      assertSingleExecutorPerSegment(plan.segments, (segment) => segmentRows(plan, segment)),
    ).not.toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/* 18 — open both capability lifecycles at once in W46                         */
/* -------------------------------------------------------------------------- */

describe('18: W46 opening quota and ticket memberships simultaneously', () => {
  it('is refused', () => {
    const greedy: ExecutionSegment = {
      ...segmentOf('W46.S1'),
      requiredTemporaryMemberships: [
        'uellix_owner',
        'uellix_cap_stella_quota',
        'uellix_cap_stella_ticket',
      ],
    }

    expect(() => assertNoConcurrentCapabilityLifecycles([greedy])).toThrow(
      /AUTHORITY_CONCURRENT_CAPABILITY_LIFECYCLES/,
    )
  })

  it('and the derived segmentation opens exactly one capability at a time', () => {
    expect(() => assertNoConcurrentCapabilityLifecycles(plan.segments)).not.toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/* 19 — a DO block needing two capability roles                                */
/* -------------------------------------------------------------------------- */

describe('19: a governed DO block whose objects span two capability roles', () => {
  it('is refused, because a DO cannot be split across two current_roles', () => {
    const twoRoled = {
      packageId: 'T6',
      statement: { index: 3, raw: 'DO $$ BEGIN END $$;', executable: '', startOffset: 0, endOffset: 0 },
      identity: { statementClass: 'do-block', object: null, operands: [], digest: 'x' },
      ownerBefore: 'MULTIPLE:uellix_cap_stella_quota|uellix_cap_stella_ticket',
      ownerDestination: null,
    } as unknown as SimulatedStatement

    expect(() => assertDoBlockHasOneExecutor(twoRoled)).toThrow(/AUTHORITY_DO_MULTIPLE_EXECUTORS/)
  })

  it('and W29, the only governed DO with a capability executor, resolves to one', () => {
    const w29 = plan.windows.find((w) => w.windowId === 'W29')

    expect(w29!.members).toHaveLength(1)
    expect(() => assertDoBlockHasOneExecutor(w29!.members[0])).not.toThrow()
    expect(w29!.members[0].ownerBefore).toBe('uellix_cap_stella_ticket')
  })
})

/* -------------------------------------------------------------------------- */
/* 20 / 21 — the two Fable findings, as attacks                                */
/* -------------------------------------------------------------------------- */

describe('20: a bare GRANT that confers SET by default', () => {
  it('is detected as a membership edge', () => {
    expect(membershipEdges(['GRANT uellix_cap_stella_quota TO uellix_owner;'])).toHaveLength(1)
  })

  it('is detected by the transitive reachability model', () => {
    expect(() =>
      assertNoTransitiveElevation(
        'attack',
        membershipEdges([
          'GRANT uellix_cap_stella_ticket TO uellix_owner;',
          'GRANT uellix_owner TO uellix_migrator;',
        ]),
      ),
    ).toThrow(/AUTHORITY_STATE_TRANSITION_INVALID/)
  })

  it('is detected by the RT-09 tripwire when it names a session role', () => {
    expect(() => assertNoSessionRoleGrantee('GRANT uellix_owner TO CURRENT_ROLE;')).toThrow(
      /AUTHORITY_MEMBERSHIP_SELF_REFERENCE/,
    )
  })
})

describe('21: authority acquired in the close phase and never released', () => {
  it('is detected', () => {
    expect(() =>
      assertCleanupComplete('attack', {
        open: [],
        close: ['GRANT uellix_cap_stella_ticket TO uellix_owner;'],
      }),
    ).toThrow(/AUTHORITY_CLEANUP_INCOMPLETE/)
  })
})

/* -------------------------------------------------------------------------- */
/* 22 — mutate the execution role, leave the window untouched                  */
/* -------------------------------------------------------------------------- */

describe('22: the classification window stays correct, the executor is swapped', () => {
  it('is refused, because the executor is re-derived from ownerBefore', () => {
    // Nothing about W38.S2 changes except the role it runs as. Same anchors,
    // same count, same digests — a window-level check cannot see this at all.
    const original = segmentOf('W38.S2')
    const mutated: ExecutionSegment = { ...original, executor: 'uellix_cap_stella_quota' }

    expect(() => assertExecutorMatchesOwnership(mutated, segmentRows(plan, original))).toThrow(
      /AUTHORITY_EXECUTOR_ROLE_MISMATCH/,
    )
  })

  it('and every derived segment passes the same check', () => {
    for (const segment of plan.segments) {
      expect(() => assertExecutorMatchesOwnership(segment, segmentRows(plan, segment)), segment.segmentId).not.toThrow()
    }
  })
})
