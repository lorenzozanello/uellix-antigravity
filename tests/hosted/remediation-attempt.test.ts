// tests/hosted/remediation-attempt.test.ts
// COMMIT 5.3 — the remediation's attempt ledger, planner and pin, as a
// contract.
//
// The engine half — that a real transaction rolls back from nine failure
// points, that an ambiguous commit is recovered without a re-apply, that the
// exact staging shape reaches 9/9 after 0002 — is measured by
// `pnpm certify:remediation`. What lives here is every decision that must hold
// WITHOUT Docker, and each test is written from the failure it prevents.
//
// Deliberately NOT re-tested here: the witness classification itself and the
// four rows of the T1 matrix by example. `tests/hosted/prechain-remediation.test.ts`
// already owns those, and a second copy would drift. What this file adds about
// authorizeGovernedT1 is the property the examples cannot state — that there is
// no combination at all in which one condition substitutes for the other.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  OLD_BOOTSTRAP_ID,
  OLD_BOOTSTRAP_SECOND_PASS,
  REMEDIATION_ATTEMPT_KIND,
  REMEDIATION_ATTEMPT_LEDGER,
  RemediationPinRefusal,
  SELECTABLE_REMEDIATION_PACKAGES,
  parseRemediationAttemptLedger,
  planRemediationAttempt,
  remediationAttemptLine,
  remediationAttemptStatus,
  verifyRemediationPin,
} from '@/db/hosted/remediation-attempt'
import {
  EXPECTED_BOOTSTRAP_SCHEMA_GRANTEES,
  PRECHAIN_REMEDIATION,
  authorizeGovernedT1,
  classifyRemediation,
  type RemediationObservation,
} from '@/db/hosted/prechain-remediation'
import { CHAIN_ATTEMPT_LEDGER } from '@/db/hosted/fresh-observation'

const ROOT = process.cwd()
const A = 'att_00000000000000000000000000000001'
const B = 'att_00000000000000000000000000000002'
const REF = 'localcertlabnotrealx'
const AT = '2026-08-10T00:00:00.000Z'

const SOURCE: RemediationObservation = {
  installerHasCreateRole: false,
  installerCanSetOwner: true,
  installerCanCreateInDatabase: false,
  ownerHoldsE01Grants: false,
  installerHoldsVisibilityGrants: false,
  topologyAssertionPresent: false,
  capabilitiesBodyIsCertified: false,
  bootstrapSchemaAcl: [...EXPECTED_BOOTSTRAP_SCHEMA_GRANTEES],
  capabilityRolesPresent: [],
}

const TARGET: RemediationObservation = {
  ...SOURCE,
  installerHasCreateRole: true,
  installerCanCreateInDatabase: true,
  ownerHoldsE01Grants: true,
  installerHoldsVisibilityGrants: true,
  topologyAssertionPresent: true,
  capabilitiesBodyIsCertified: true,
}

const opened = (id: string): string => remediationAttemptLine('OPENED', id, REF, AT)
const consumed = (id: string): string => remediationAttemptLine('CONSUMED', id, REF, AT)

/* -------------------------------------------------------------------------- */
/* The ledger                                                                  */
/* -------------------------------------------------------------------------- */

describe('the remediation reuses the chain ledger machinery and none of its identity', () => {
  it('writes its own file, not the chain\'s', () => {
    // Two independently-serialized resources. Sharing the file would let a
    // chain attempt opened later retire a remediation attempt that is still the
    // current measurement of a different question.
    expect(REMEDIATION_ATTEMPT_LEDGER).not.toBe(CHAIN_ATTEMPT_LEDGER)
    expect(REMEDIATION_ATTEMPT_LEDGER).toMatch(/remediation/)
  })

  it('declares a typed kind on every record it writes', () => {
    const record = JSON.parse(opened(A)) as Record<string, unknown>
    expect(record.kind).toBe(REMEDIATION_ATTEMPT_KIND)
    expect(record.event).toBe('OPENED')
    expect(JSON.parse(consumed(A)).packageId).toBe(PRECHAIN_REMEDIATION.id)
  })

  it('refuses to write a line for a malformed attempt id', () => {
    expect(() => remediationAttemptLine('OPENED', "att_'; DROP", REF, AT)).toThrow(/32 hex/)
  })

  it('DROPS a record that does not declare the remediation kind', () => {
    // A chain attempt record parses as a generic attempt. If the two files were
    // ever swapped, or a line pasted between them, an attempt for a completely
    // different write must not be able to authorise a remediation.
    const chainRecord = `${JSON.stringify({ attemptId: A, event: 'OPENED', targetProjectRef: REF, at: AT })}\n`
    expect(parseRemediationAttemptLedger(chainRecord)).toEqual([])
    expect(remediationAttemptStatus(parseRemediationAttemptLedger(chainRecord), A)).toBe('UNKNOWN')
  })

  it('is OPEN only while unconsumed AND the most recently opened', () => {
    const records = parseRemediationAttemptLedger(`${opened(A)}${opened(B)}`)
    expect(remediationAttemptStatus(records, B)).toBe('OPEN')
    // Opening an attempt is the act that retires every attempt before it —
    // otherwise an operator could reach back past a newer measurement to an
    // older one that still said ABSENT.
    expect(remediationAttemptStatus(records, A)).toBe('CONSUMED')
  })

  it('survives a corrupt line without letting it make anything OPEN', () => {
    const records = parseRemediationAttemptLedger(`not json\n${opened(A)}\n{"kind":"x"}\n`)
    expect(records).toHaveLength(1)
    expect(remediationAttemptStatus(records, A)).toBe('OPEN')
  })
})

/* -------------------------------------------------------------------------- */
/* Freshness                                                                   */
/* -------------------------------------------------------------------------- */

describe('an observation authorises exactly one write, and only while its attempt is open', () => {
  it('a FRESH ABSENT observation authorises the remediation', () => {
    const plan = planRemediationAttempt({
      observation: SOURCE,
      expectedAttemptId: A,
      attemptLedger: opened(A),
      requestedPackageId: PRECHAIN_REMEDIATION.id,
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.packageId).toBe(PRECHAIN_REMEDIATION.id)
  })

  it('a STALE ABSENT observation is refused — the attempt was never opened', () => {
    // The exact shape of RT-02 for this package: the operator still has
    // yesterday's measurement on screen and it still says ABSENT.
    const plan = planRemediationAttempt({
      observation: SOURCE,
      expectedAttemptId: A,
      attemptLedger: null,
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('REMEDIATION_ATTEMPT_NOT_OPEN')
  })

  it('the SAME observation cannot authorise a second write', () => {
    const ledger = opened(A)
    const first = planRemediationAttempt({
      observation: SOURCE,
      expectedAttemptId: A,
      attemptLedger: ledger,
    })
    expect(first.ok).toBe(true)

    // The plan consumes the attempt BEFORE the write, so the second ask sees a
    // spent attempt whether or not the write was acknowledged.
    const second = planRemediationAttempt({
      observation: SOURCE,
      expectedAttemptId: A,
      attemptLedger: `${ledger}${consumed(A)}`,
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('REMEDIATION_ATTEMPT_NOT_OPEN')
  })

  it('a FRESH INSTALLED observation refuses the re-apply', () => {
    const plan = planRemediationAttempt({
      observation: TARGET,
      expectedAttemptId: A,
      attemptLedger: opened(A),
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.code).toBe('REMEDIATION_ALREADY_INSTALLED')
      expect(plan.detail).toMatch(/forward-only/)
    }
  })

  it('a FRESH PARTIAL observation refuses ANY automatic action', () => {
    const plan = planRemediationAttempt({
      observation: { ...TARGET, ownerHoldsE01Grants: false },
      expectedAttemptId: A,
      attemptLedger: opened(A),
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.code).toBe('REMEDIATION_PARTIAL_HUMAN_ONLY')
      expect(plan.detail).toMatch(/Human recovery/)
      // No repair is proposed, and none is possible: there is no rollback.
      expect(plan.detail).toMatch(/no automatic repair/)
    }
  })

  it('a LEAKED borrowed privilege is PARTIAL even with every target fact present', () => {
    const plan = planRemediationAttempt({
      observation: {
        ...TARGET,
        bootstrapSchemaAcl: [...EXPECTED_BOOTSTRAP_SCHEMA_GRANTEES, 'postgres'],
      },
      expectedAttemptId: A,
      attemptLedger: opened(A),
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('REMEDIATION_PARTIAL_HUMAN_ONLY')
  })
})

/* -------------------------------------------------------------------------- */
/* Ambiguity                                                                   */
/* -------------------------------------------------------------------------- */

describe('an ambiguous outcome is resolved by a NEW observation, never by the old one', () => {
  it('AMBIGUOUS SUCCESS: the new observation reads INSTALLED and no reapply is planned', () => {
    // The write committed and the acknowledgement was lost. The old attempt is
    // spent; the new one measures the database and the answer is the recovery.
    const ledger = `${opened(A)}${consumed(A)}${opened(B)}`
    const recovery = planRemediationAttempt({
      observation: TARGET,
      expectedAttemptId: B,
      attemptLedger: ledger,
    })
    expect(recovery.ok).toBe(false)
    if (!recovery.ok) expect(recovery.code).toBe('REMEDIATION_ALREADY_INSTALLED')

    // And T1 becomes eligible from that same measurement once the gate is clean.
    expect(authorizeGovernedT1(classifyRemediation(TARGET), []).ok).toBe(true)
  })

  it('AMBIGUOUS FAILURE: the old attempt cannot authorise the retry', () => {
    const ledger = `${opened(A)}${consumed(A)}`
    const reuse = planRemediationAttempt({
      observation: SOURCE,
      expectedAttemptId: A,
      attemptLedger: ledger,
    })
    expect(reuse.ok).toBe(false)
    if (!reuse.ok) expect(reuse.code).toBe('REMEDIATION_ATTEMPT_NOT_OPEN')
  })

  it('AMBIGUOUS FAILURE: a NEW attempt with a NEW ABSENT observation is authorised', () => {
    const plan = planRemediationAttempt({
      observation: SOURCE,
      expectedAttemptId: B,
      attemptLedger: `${opened(A)}${consumed(A)}${opened(B)}`,
    })
    expect(plan.ok).toBe(true)
  })

  it('the recovery for the two ambiguous directions differs ONLY by the measurement', () => {
    // Same ledger, same attempt, same code path: what decides is the catalog.
    const ledger = `${opened(A)}${consumed(A)}${opened(B)}`
    const afterCommit = planRemediationAttempt({ observation: TARGET, expectedAttemptId: B, attemptLedger: ledger })
    const afterRollback = planRemediationAttempt({ observation: SOURCE, expectedAttemptId: B, attemptLedger: ledger })
    expect(afterCommit.ok).toBe(false)
    expect(afterRollback.ok).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* The old bootstrap                                                           */
/* -------------------------------------------------------------------------- */

describe('stella_hosted_0001 is not a remediation vehicle and never becomes one', () => {
  it('is refused by name, in the most permissive state there is', () => {
    // Fresh attempt, ABSENT observation — everything the planner needs to say
    // yes to the RIGHT package. It still refuses this one.
    const plan = planRemediationAttempt({
      observation: SOURCE,
      expectedAttemptId: A,
      attemptLedger: opened(A),
      requestedPackageId: OLD_BOOTSTRAP_ID,
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.code).toBe('REMEDIATION_PACKAGE_NOT_PERMITTED')
      expect(plan.detail).toMatch(/PROHIBITED/)
      expect(plan.detail).toMatch(/COMMENT ON SCHEMA/)
    }
  })

  it('is not in the selectable set, and the set has exactly one member', () => {
    expect(SELECTABLE_REMEDIATION_PACKAGES).toEqual([PRECHAIN_REMEDIATION.id])
    expect(SELECTABLE_REMEDIATION_PACKAGES).not.toContain(OLD_BOOTSTRAP_ID)
    expect(OLD_BOOTSTRAP_SECOND_PASS).toBe('PROHIBITED')
  })

  it('is refused BEFORE the ledger and the observation are consulted', () => {
    // A stale attempt AND the wrong package: the answer names the package,
    // because "the database is not ready" would send an operator to fix the
    // wrong thing.
    const plan = planRemediationAttempt({
      observation: TARGET,
      expectedAttemptId: A,
      attemptLedger: null,
      requestedPackageId: OLD_BOOTSTRAP_ID,
    })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('REMEDIATION_PACKAGE_NOT_PERMITTED')
  })

  it('there is no fallback: an unrequested plan selects 0002 and nothing else', () => {
    const plan = planRemediationAttempt({
      observation: SOURCE,
      expectedAttemptId: A,
      attemptLedger: opened(A),
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.packageId).toBe(PRECHAIN_REMEDIATION.id)
  })
})

/* -------------------------------------------------------------------------- */
/* The pin                                                                     */
/* -------------------------------------------------------------------------- */

describe('the package bytes are pinned, and the refusal happens before any server', () => {
  const SQL = readFileSync(path.join(ROOT, PRECHAIN_REMEDIATION.sourceFile), 'utf8')

  it('accepts the file as committed', () => {
    expect(verifyRemediationPin(SQL)).toBe(PRECHAIN_REMEDIATION.sourceSha256)
  })

  it('refuses a single moved byte', () => {
    const mutated = SQL.replace(
      'ALTER ROLE uellix_migrator WITH CREATEROLE;',
      'ALTER ROLE uellix_migrator WITH CREATEROLE ;',
    )
    expect(mutated).not.toBe(SQL)
    expect(() => verifyRemediationPin(mutated)).toThrow(RemediationPinRefusal)
  })

  it('refuses a mutation that is semantically enormous and textually small', () => {
    // The one that matters: an operator handed a file with an extra attribute
    // on the ALTER ROLE. The engine would accept it happily.
    const mutated = SQL.replace(
      'ALTER ROLE uellix_migrator WITH CREATEROLE;',
      'ALTER ROLE uellix_migrator WITH CREATEROLE SUPERUSER;',
    )
    expect(() => verifyRemediationPin(mutated)).toThrow(/REMEDIATION_PIN_MISMATCH/)
  })

  it('is insensitive to line endings, so a CRLF checkout still matches', () => {
    expect(verifyRemediationPin(SQL.replace(/\n/g, '\r\n'))).toBe(PRECHAIN_REMEDIATION.sourceSha256)
  })
})

/* -------------------------------------------------------------------------- */
/* The T1 dependency, as a property                                            */
/* -------------------------------------------------------------------------- */

describe('neither T1 condition substitutes for the other, over the whole grid', () => {
  it('authorises in exactly one of six combinations', () => {
    const states: RemediationObservation[] = [
      SOURCE, // ABSENT
      { ...TARGET, ownerHoldsE01Grants: false }, // PARTIAL
      TARGET, // INSTALLED
    ]
    const gates: { code: string; detail: string }[][] = [
      [],
      [{ code: 'PRECHAIN_PRIVILEGE_MISSING', detail: 'uellix_owner lost REFERENCES on projects' }],
    ]

    const authorised: string[] = []
    for (const observation of states) {
      for (const refusals of gates) {
        const classification = classifyRemediation(observation)
        if (authorizeGovernedT1(classification, refusals).ok) {
          authorised.push(`${classification.state}/${refusals.length} refusal(s)`)
        }
      }
    }
    expect(authorised).toEqual(['INSTALLED/0 refusal(s)'])
  })

  it('reports which condition failed, because the two need different actions', () => {
    // An ABSENT remediation is an apply. A drifted one is an investigation.
    // A refusal that said only "not ready" would send an operator to guess.
    const absent = authorizeGovernedT1(classifyRemediation(SOURCE), [])
    const drifted = authorizeGovernedT1(classifyRemediation(TARGET), [
      { code: 'PRECHAIN_PRIVILEGE_MISSING', detail: 'x' },
    ])
    expect(absent.ok).toBe(false)
    expect(drifted.ok).toBe(false)
    if (!absent.ok && !drifted.ok) {
      expect(absent.code).not.toBe(drifted.code)
    }
  })
})
