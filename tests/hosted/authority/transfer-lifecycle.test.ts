// tests/hosted/authority/transfer-lifecycle.test.ts
// COMMIT 3.3 — the ownership-transfer lifecycle, and the mutations it refuses.
//
// The defect this file exists for was invisible to every check that came before
// it. `ownerTransferPrimitive` emitted well-formed SQL, the cleanup checker said
// it was balanced, RT-07 said it opened no path, and PostgreSQL refused all 27
// of the transfers it would have produced. Nothing in a test suite that only
// looks at the SHAPE of SQL could have said so.
//
// So every expectation here that concerns PostgreSQL is anchored on
// db/hosted/authority/lab/pg176-transfer-lab.sql, run against image
// 17.6.1.143 with network none and destroyed afterwards:
//
//   A  temp row: role=cap, member=owner, grantor=installer, admin=f inherit=f set=t
//   B  installer->cap: false BEFORE, true DURING, false AFTER
//   C  runtime roles: false in all three phases
//   D  the provider's own membership row: 1 row, grantor unchanged, throughout
//   E  schema CREATE for the target: false, true only in the owner phase, false
//   F  ALTER FUNCTION ... OWNER TO: PASS, final owner = the capability role
//   G  cleanup: zero temporary membership rows
//   H  current role back to the session user
//   plus seven distinct mid-transfer failure points, each rolled back and then
//   PROBED — every one restored the original owner and left nothing behind.

import { describe, expect, it } from 'vitest'

import {
  assertReachabilityMatchesExpectation,
  assertTemporaryGrantShape,
  expectedReachabilityFor,
  setReachabilityClosure,
} from '@/db/hosted/authority/expected-reachability'
import {
  assertCleanupComplete,
  membershipEdges,
  ownerTransferPrimitive,
  ownerWindowPrimitive,
  type MembershipEdge,
} from '@/db/hosted/authority/primitives'
import { buildAuthorityPlan, segmentRows } from '@/db/hosted/authority/classification-manifest'
import { validateResolvedAuthorityPlanForGeneration } from '@/db/hosted/authority/execution-disposition'

const plan = buildAuthorityPlan()
const INSTALLER = 'uellix_migrator'
const RUNTIME = ['uellix_app', 'uellix_writer', 'uellix_auditor']

const persistentEdge: MembershipEdge[] = [{ role: 'uellix_owner', member: INSTALLER }]

const transferOf = (target: 'uellix_cap_stella_quota' | 'uellix_cap_stella_ticket', schema: string) =>
  ownerTransferPrimitive({
    installer: INSTALLER,
    fromOwner: 'uellix_owner',
    targetCapability: target,
    schema,
    segmentId: 'W46.S1',
  })

const topology = (
  authorityClass: 'OWNER' | 'CAPABILITY' | 'OWNER_TRANSFER',
  executor: string,
  ownerDestination: string | null,
) =>
  expectedReachabilityFor({
    segmentId: 'S',
    authorityClass,
    executor,
    ownerDestination,
    installer: INSTALLER,
    runtimePrincipals: RUNTIME,
  })

/* -------------------------------------------------------------------------- */
/* The 27 transfers, and what they are                                         */
/* -------------------------------------------------------------------------- */

describe('the transfer inventory', () => {
  it('is 27 statements over 11 segments, and every one is a FUNCTION', () => {
    // Measured, not assumed: a primitive built for routines would be wrong for
    // a table or a sequence, and there is no generic string-replacement variant.
    const segments = plan.segments.filter((s) => s.authorityClass === 'OWNER_TRANSFER')
    const rows = segments.flatMap((s) => segmentRows(plan, s))

    expect(segments).toHaveLength(11)
    expect(rows).toHaveLength(27)
    expect(new Set(rows.map((r) => r.identity.object!.objectClass))).toEqual(new Set(['function']))
  })

  it('gives every transfer segment exactly one target and one schema', () => {
    for (const segment of plan.segments.filter((s) => s.authorityClass === 'OWNER_TRANSFER')) {
      const rows = segmentRows(plan, segment)
      expect(new Set(rows.map((r) => r.ownerDestination))).toEqual(
        new Set([segment.ownerDestination]),
      )
      expect(new Set(rows.map((r) => r.identity.object!.schema))).toHaveProperty('size', 1)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The lifecycle shape                                                         */
/* -------------------------------------------------------------------------- */

describe('the case-G lifecycle', () => {
  it('grants the incoming owner to uellix_owner, with SET and without INHERIT', () => {
    const open = transferOf('uellix_cap_stella_quota', 'uellix_stella').open

    expect(open[0]).toBe(
      'GRANT uellix_cap_stella_quota TO uellix_owner WITH INHERIT FALSE, SET TRUE;',
    )
  })

  it('refuses a temporary grant that carries INHERIT', () => {
    // INHERIT would make the member carry the role on every statement, not only
    // when it announces itself. That is the shortcut this fix deliberately did
    // not take.
    expect(() =>
      assertTemporaryGrantShape('mutation', [
        'GRANT uellix_cap_stella_quota TO uellix_owner WITH INHERIT TRUE, SET TRUE;',
      ]),
    ).toThrow(/AUTHORITY_STATE_TRANSITION_INVALID/)
  })

  it('accepts what the primitive actually emits', () => {
    const primitive = transferOf('uellix_cap_stella_ticket', 'uellix_stella_ops')

    expect(() =>
      assertTemporaryGrantShape('emitted', [...primitive.open, ...primitive.close]),
    ).not.toThrow()
  })

  it('gives back the schema CREATE and the membership, in the pinned order', () => {
    const primitive = transferOf('uellix_cap_stella_ticket', 'uellix_stella_ops')

    // M5: the installer cannot grant on a schema uellix_owner owns, so the
    // revoke has to precede RESET ROLE.
    expect(primitive.close.indexOf('REVOKE CREATE ON SCHEMA uellix_stella_ops FROM uellix_cap_stella_ticket;'))
      .toBeLessThan(primitive.close.indexOf('RESET ROLE;'))
    expect(() => assertCleanupComplete('W46.S2', primitive)).not.toThrow()
  })

  it('refuses a lifecycle that keeps the membership', () => {
    const leaky = {
      open: transferOf('uellix_cap_stella_quota', 'uellix_stella').open,
      close: ['REVOKE CREATE ON SCHEMA uellix_stella FROM uellix_cap_stella_quota;', 'RESET ROLE;'],
    }

    expect(() => assertCleanupComplete('mutation', leaky)).toThrow(/AUTHORITY_CLEANUP_INCOMPLETE/)
  })

  it('refuses a lifecycle that keeps the schema CREATE', () => {
    const leaky = {
      open: transferOf('uellix_cap_stella_quota', 'uellix_stella').open,
      close: ['RESET ROLE;', 'REVOKE uellix_cap_stella_quota FROM uellix_owner;'],
    }

    expect(() => assertCleanupComplete('mutation', leaky)).toThrow(/AUTHORITY_CLEANUP_INCOMPLETE/)
  })
})

/* -------------------------------------------------------------------------- */
/* Reachability, before / during / after                                       */
/* -------------------------------------------------------------------------- */

describe('transfer reachability', () => {
  const phases = topology('OWNER_TRANSFER', 'uellix_cap_stella_quota', 'uellix_cap_stella_quota')
  const during = [...persistentEdge, ...membershipEdges([...transferOf('uellix_cap_stella_quota', 'uellix_stella').open])]

  it('expects nothing but the persistent owner membership BEFORE', () => {
    expect(() => assertReachabilityMatchesExpectation(persistentEdge, phases[0])).not.toThrow()
    expect(setReachabilityClosure(persistentEdge)).toEqual(
      new Set([`${INSTALLER}->uellix_owner`]),
    )
  })

  it('expects installer -> owner -> target DURING, and nothing else', () => {
    // Measured (lab B): installer->cap is false before, TRUE during, false
    // after. The path is the operation, not a leak.
    expect(() => assertReachabilityMatchesExpectation(during, phases[1])).not.toThrow()
    expect(setReachabilityClosure(during)).toEqual(
      new Set([
        `${INSTALLER}->uellix_owner`,
        `${INSTALLER}->uellix_cap_stella_quota`,
        'uellix_owner->uellix_cap_stella_quota',
      ]),
    )
  })

  it('expects the path to be GONE after', () => {
    expect(() => assertReachabilityMatchesExpectation(persistentEdge, phases[2])).not.toThrow()
  })

  it('refuses a transfer to the wrong capability', () => {
    const wrong = [...persistentEdge, { role: 'uellix_cap_stella_ticket', member: 'uellix_owner' }]

    expect(() => assertReachabilityMatchesExpectation(wrong, phases[1])).toThrow(
      /AUTHORITY_STATE_TRANSITION_INVALID/,
    )
  })

  it('refuses two capability targets open at once — the W46 mutation', () => {
    const both = [
      ...persistentEdge,
      { role: 'uellix_cap_stella_quota', member: 'uellix_owner' },
      { role: 'uellix_cap_stella_ticket', member: 'uellix_owner' },
    ]

    expect(() => assertReachabilityMatchesExpectation(both, phases[1])).toThrow(
      /AUTHORITY_STATE_TRANSITION_INVALID|AUTHORITY_CONCURRENT_CAPABILITY_LIFECYCLES/,
    )
  })

  it('refuses a SET FALSE grant, which creates no path at all', () => {
    // One-sided checking would pass this: no edge means nothing forbidden
    // appears. The transfer would then fail at apply time with
    // `must be able to SET ROLE`.
    const noPath = membershipEdges([
      'GRANT uellix_cap_stella_quota TO uellix_owner WITH INHERIT FALSE, SET FALSE;',
    ])

    expect(() =>
      assertReachabilityMatchesExpectation([...persistentEdge, ...noPath], phases[1]),
    ).toThrow(/AUTHORITY_STATE_TRANSITION_INVALID/)
  })

  it('refuses any path reaching a runtime principal', () => {
    const runtime = [...persistentEdge, { role: 'uellix_cap_stella_quota', member: 'uellix_app' }]

    expect(() => assertReachabilityMatchesExpectation(runtime, phases[1])).toThrow(
      /AUTHORITY_STATE_TRANSITION_INVALID/,
    )
  })
})

/* -------------------------------------------------------------------------- */
/* The models cannot be swapped                                                */
/* -------------------------------------------------------------------------- */

describe('a segment gets the topology its own class implies', () => {
  it('refuses an ordinary capability segment that declares a transfer destination', () => {
    // "Mark it as a transfer exception" is the shortcut this model exists to
    // make impossible. The expectation is derived from the class, so there is
    // no flag to set.
    expect(() => topology('CAPABILITY', 'uellix_cap_grounding', 'uellix_cap_grounding')).toThrow(
      /AUTHORITY_EXECUTOR_ROLE_MISMATCH/,
    )
  })

  it('refuses a transfer segment with no destination', () => {
    expect(() => topology('OWNER_TRANSFER', 'uellix_owner', null)).toThrow(
      /AUTHORITY_EXECUTOR_ROLE_MISMATCH/,
    )
  })

  it('keeps a capability segment on the strict, direct-only topology', () => {
    const phases = topology('CAPABILITY', 'uellix_cap_grounding', null)
    const transitive = [
      ...persistentEdge,
      { role: 'uellix_cap_grounding', member: 'uellix_owner' },
    ]

    expect(() => assertReachabilityMatchesExpectation(transitive, phases[1])).toThrow(
      /AUTHORITY_STATE_TRANSITION_INVALID/,
    )
  })

  it('keeps an owner segment on the persistent membership alone', () => {
    // COMMIT 5.1 made this literal. The owner window used to emit its own
    // temporary grant and this test asserted the resulting graph matched the
    // expectation anyway; the window now emits NO membership at all, so the
    // graph it contributes is empty and the persistent row is the whole of it.
    const phases = topology('OWNER', 'uellix_owner', null)
    const edges = membershipEdges([
      ...ownerWindowPrimitive(INSTALLER).open,
      'GRANT uellix_owner TO uellix_migrator WITH INHERIT FALSE, SET TRUE;',
    ])

    expect(membershipEdges([...ownerWindowPrimitive(INSTALLER).open])).toEqual([])
    expect(() => assertReachabilityMatchesExpectation(edges, phases[1])).not.toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/* The plan is unchanged, and the gate still passes                            */
/* -------------------------------------------------------------------------- */

describe('the validated plan is untouched by this remediation', () => {
  it('still holds 51 classification windows and 59 execution segments', () => {
    expect(plan.windows).toHaveLength(51)
    expect(plan.segments).toHaveLength(59)
    expect(plan.segments.filter((s) => s.authorityClass === 'OWNER_TRANSFER')).toHaveLength(11)
  })

  it('passes the pre-generation gate, which now checks every segment topology', () => {
    const gate = validateResolvedAuthorityPlanForGeneration(plan)

    expect(gate.checks).toContain(
      'every execution segment is balanced and matches its expected reachability graph in all three phases',
    )
  })

  it('constructs a working primitive for all 11 transfer segments', () => {
    for (const segment of plan.segments.filter((s) => s.authorityClass === 'OWNER_TRANSFER')) {
      const primitive = ownerTransferPrimitive({
        installer: INSTALLER,
        fromOwner: 'uellix_owner',
        targetCapability: segment.ownerDestination as 'uellix_cap_grounding',
        schema: segment.requiredTemporarySchemaCreate as string,
        segmentId: segment.segmentId,
      })

      expect(primitive.open[0], segment.segmentId).toContain('TO uellix_owner')
      expect(() => assertCleanupComplete(segment.segmentId, primitive)).not.toThrow()
    }
  })
})
