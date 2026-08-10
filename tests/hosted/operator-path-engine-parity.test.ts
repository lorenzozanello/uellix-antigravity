// tests/hosted/operator-path-engine-parity.test.ts
// COMMIT 5.4 — the operator path decides what the ENGINE decided.
//
// ---------------------------------------------------------------------------
// WHAT THIS BINDS, AND WHY IT IS NOT A SECOND CERTIFICATION
// ---------------------------------------------------------------------------
// `pnpm certify:remediation` measures an exact-staging-shaped PostgreSQL 17.6,
// applies `stella_hosted_0002` to it, and records both catalog measurements it
// took — the source state and the post-apply state — in
// `artifacts/remediation-certification/latest.json`. Those two objects are
// engine facts: nobody typed them.
//
// The operator CLIs added in this commit are a different code path to the same
// decisions, and the risk they carry is precisely that they reach a different
// verdict from the same facts. So this file replays the ENGINE'S OWN
// observations through the operator adapter and asserts the verdicts match the
// ones the harness recorded beside them.
//
// It certifies nothing about PostgreSQL. It certifies that the path an operator
// runs and the path Docker certified agree about the same measurements — which
// is the one property a unit test built from hand-written fixtures cannot
// state, because a hand-written fixture is a guess about what an engine returns.
//
// The attempt binding is REBOUND: these observations were measured for the
// harness's attempts, and a rehearsal is a new attempt. The VALUES are the
// engine's and only the envelope is this file's.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  openRemediationAttempt,
  planRemediationWrite,
} from '@/db/hosted/remediation-operator'
import {
  GOVERNED_T1_PACKAGE,
  PRECHAIN_OBSERVATION_SCHEMA,
  gateGovernedT1,
} from '@/db/hosted/chain-operator'
import {
  HOSTED_INSTALLER,
  OWNER,
} from '@/db/hosted/authority/certification/prechain-authority-gate'
import {
  collapseByObject,
  derivePrechainRequirements,
} from '@/db/hosted/authority/certification/prechain-requirements'
import { PRECHAIN_REMEDIATION, type RemediationObservation } from '@/db/hosted/prechain-remediation'
import {
  REMEDIATION_WITNESS_SCHEMA,
} from '@/db/hosted/authority/certification/remediation-probes'
import { REMEDIATION_ATTEMPT_KIND } from '@/db/hosted/remediation-attempt'
import { KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'

const ROOT = process.cwd()
const SQL = readFileSync(path.join(ROOT, PRECHAIN_REMEDIATION.sourceFile), 'utf8')

interface CertificationArtifact {
  readonly sourceObservation: { readonly state: string; readonly observation: RemediationObservation }
  readonly postApplyObservation: {
    readonly state: string
    readonly observation: RemediationObservation
  }
  readonly t1BeforeRemediation: {
    readonly authorization: { readonly ok: boolean; readonly code?: string }
  }
  readonly t1Authorization: { readonly ok: boolean }
  readonly verdicts: Readonly<Record<string, string>>
}

const CERT = JSON.parse(
  readFileSync(path.join(ROOT, 'artifacts/remediation-certification/latest.json'), 'utf8'),
) as CertificationArtifact

const A = 'att_' + '1'.repeat(32)
const B = 'att_' + '2'.repeat(32)
const AT = '2026-08-10T00:00:00.000Z'

const witness = (attemptId: string, observation: RemediationObservation): string =>
  JSON.stringify({ schema: REMEDIATION_WITNESS_SCHEMA, attemptId, observation })

const opened = (id: string): string =>
  JSON.stringify({
    attemptId: id,
    event: 'OPENED',
    targetProjectRef: KNOWN_STAGING_PROJECT_REF,
    at: AT,
    kind: REMEDIATION_ATTEMPT_KIND,
  })

describe('the certification artifact carries engine measurements to compare against', () => {
  it('records both states the harness measured', () => {
    expect(CERT.sourceObservation.state).toBe('ABSENT')
    expect(CERT.postApplyObservation.state).toBe('INSTALLED')
    expect(CERT.verdicts.EXACT_STAGING_REMEDIATION).toBe('PASS')
    expect(CERT.verdicts.POST_REMEDIATION_PRECHAIN_GATE).toBe('PASS')
    expect(CERT.verdicts.T1_AUTHORIZATION_AFTER_REMEDIATION).toBe('PASS')
    expect(CERT.t1BeforeRemediation.authorization.code).toBe('REMEDIATION_ABSENT')
    expect(CERT.t1Authorization.ok).toBe(true)
  })
})

describe('the remediation operator path replays the engine source state', () => {
  it('authorises exactly one write, as the harness did', () => {
    const open = openRemediationAttempt({ attemptId: A, remediationSql: SQL, at: AT })
    expect(open.attemptId).toBe(A)

    const result = planRemediationWrite({
      witnessRaw: witness(A, CERT.sourceObservation.observation),
      expectedAttemptId: A,
      attemptLedger: open.ledgerLine,
      remediationSql: SQL,
      at: AT,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
    expect(result.record.WITNESS).toBe(CERT.sourceObservation.state)
    expect(result.record.PACKAGE_ID).toBe(PRECHAIN_REMEDIATION.id)
  })

  it('refuses to re-apply from the engine post-apply state, as the harness did', () => {
    const result = planRemediationWrite({
      witnessRaw: witness(B, CERT.postApplyObservation.observation),
      expectedAttemptId: B,
      attemptLedger: opened(B),
      remediationSql: SQL,
      at: AT,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('the operator path re-applied a committed remediation')
    expect(result.code).toBe('REMEDIATION_ALREADY_INSTALLED')
  })

  it('would decide differently if the engine facts were different', () => {
    // The parity above is only worth something if these assertions can fail.
    // One measured fact flipped is enough to move the verdict.
    const drifted: RemediationObservation = {
      ...CERT.postApplyObservation.observation,
      ownerHoldsE01Grants: false,
    }
    const result = planRemediationWrite({
      witnessRaw: witness(B, drifted),
      expectedAttemptId: B,
      attemptLedger: opened(B),
      remediationSql: SQL,
      at: AT,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_PARTIAL_HUMAN_ONLY')
  })
})

/**
 * A prechain observation the gate has no complaint about.
 *
 * Present so the T1 refusal below can only come from the remediation state. The
 * harness's own prechain observation is not in the artifact — it records the
 * eleven refusals it produced, not the catalog rows behind them — so parity
 * here is asserted on the DECISION the harness recorded, which is the thing an
 * operator acts on.
 */
function healthyPrechain(attemptId: string): string {
  return JSON.stringify({
    schema: PRECHAIN_OBSERVATION_SCHEMA,
    attemptId,
    observation: {
      roles: [
        { name: HOSTED_INSTALLER, canLogin: true, createRole: true, isSuper: false },
        { name: OWNER, canLogin: false, createRole: false, isSuper: false },
      ],
      memberships: [],
      objects: collapseByObject(derivePrechainRequirements()).map((c) => ({
        object: c.object,
        present: true,
        owner: OWNER,
        held: {},
        heldWithGrantOption: {},
      })),
      schemaCreate: { public: true, uellix_grounding: true },
      installerCanSetOwner: true,
      capabilityReachableBy: {},
    },
  })
}

describe('the T1 operator gate replays the engine T1 decision', () => {
  it('refuses T1 from the engine source state with the code the harness recorded', () => {
    const result = gateGovernedT1({
      packageId: GOVERNED_T1_PACKAGE,
      attemptId: A,
      witnessRaw: witness(A, CERT.sourceObservation.observation),
      prechainRaw: healthyPrechain(A),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('T1 was authorised against the engine source state')
    expect(result.code).toBe(CERT.t1BeforeRemediation.authorization.code)
    expect(result.code).toBe('REMEDIATION_ABSENT')
  })

  it('permits T1 from the engine post-apply state, as the harness recorded after', () => {
    const result = gateGovernedT1({
      packageId: GOVERNED_T1_PACKAGE,
      attemptId: B,
      witnessRaw: witness(B, CERT.postApplyObservation.observation),
      prechainRaw: healthyPrechain(B),
    })
    expect(result.ok).toBe(CERT.t1Authorization.ok)
    if (!result.ok) throw new Error(result.detail)
    expect(result.required).toBe(true)
  })
})
