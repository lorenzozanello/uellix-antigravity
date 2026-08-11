// tests/hosted/chain-operator-t1-gate.test.ts
// COMMIT 5.4 — the T1 prerequisite, enforced where the operator actually
// stands (F-PS-02), and the ledger's kind symmetry (F-PS-04).
//
// ---------------------------------------------------------------------------
// THE FINDING
// ---------------------------------------------------------------------------
// `authorizeGovernedT1` is exact, certified, and — until this commit — called
// by nothing an operator could run. `scripts/chain-attempt.ts plan` authorised
// the next chain package through `authorizeChainWrite`, which knows about
// witnesses and chain order and knows nothing about the prechain remediation.
// So the first package it would ever authorise is T1, and it would authorise it
// on a database where the remediation had never been applied.
//
// The backstop was real — the engine refuses T1 inside its own transaction, and
// that is where E-01 was found in the first place — but a backstop that fires
// after the operator has already run a write against staging is not the gate
// the certification proved.
//
// What is tested here is that no combination of inputs reaches an authorised T1
// without BOTH conditions, that the refusal happens before anything is
// consumed, and that T2..T9 did not acquire a prerequisite they do not have.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  GOVERNED_T1_PACKAGE,
  PRECHAIN_OBSERVATION_SCHEMA,
  buildPrechainObservationSql,
  gateGovernedT1,
  planChainWriteForOperator,
} from '@/db/hosted/chain-operator'
import {
  CHAIN_ATTEMPT_KIND,
  CHAIN_WRITE_ORDER,
  PRE_WRITE_OBSERVATION_SCHEMA,
  observationDigest,
  parseChainAttemptLedger,
} from '@/db/hosted/fresh-observation'
import {
  CAPABILITY_ROLES,
  HOSTED_INSTALLER,
  OWNER,
  type PrechainObservation,
} from '@/db/hosted/authority/certification/prechain-authority-gate'
import {
  collapseByObject,
  derivePrechainRequirements,
} from '@/db/hosted/authority/certification/prechain-requirements'
import { REMEDIATION_WITNESS_SCHEMA } from '@/db/hosted/authority/certification/remediation-probes'
import {
  EXPECTED_BOOTSTRAP_SCHEMA_GRANTEES,
  type RemediationObservation,
} from '@/db/hosted/prechain-remediation'
import { REMEDIATION_ATTEMPT_KIND } from '@/db/hosted/remediation-attempt'
import { STELLA_FEATURE_FLAGS } from '@/db/hosted/hosted-provisioning-runner'
import { BASELINE_ORDER } from '@/db/hosted/baseline-manifest'
import { PACKAGE_WITNESSES, WITNESSED_PACKAGES, witnessKey } from '@/db/hosted/package-witnesses'
import {
  SENTINEL_BOOTSTRAP_VERSION,
  SENTINEL_OWNER_SEPARATION,
} from '@/db/hosted/bootstrap-postconditions'
import { KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'

const ROOT = process.cwd()
const SHELL = readFileSync(path.join(ROOT, 'scripts/chain-attempt.ts'), 'utf8')

const A = 'att_' + 'a'.repeat(32)
const AT = '2026-08-10T00:00:00.000Z'
const REF = KNOWN_STAGING_PROJECT_REF
const T1 = CHAIN_WRITE_ORDER[0] as string
const T2 = CHAIN_WRITE_ORDER[1] as string

const contracts = collapseByObject(derivePrechainRequirements())

/* -------------------------------------------------------------------------- */
/* Evidence fixtures                                                           */
/* -------------------------------------------------------------------------- */

const REMEDIATION_ABSENT: RemediationObservation = {
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
const REMEDIATION_INSTALLED: RemediationObservation = {
  ...REMEDIATION_ABSENT,
  installerHasCreateRole: true,
  installerCanCreateInDatabase: true,
  ownerHoldsE01Grants: true,
  installerHoldsVisibilityGrants: true,
  topologyAssertionPresent: true,
  capabilitiesBodyIsCertified: true,
}
const REMEDIATION_PARTIAL: RemediationObservation = {
  ...REMEDIATION_ABSENT,
  installerHasCreateRole: true,
}

const witness = (attemptId: string, o: RemediationObservation): string =>
  JSON.stringify({ schema: REMEDIATION_WITNESS_SCHEMA, attemptId, observation: o })

/** Everything the contract asks for, satisfied by ownership. */
function healthyPrechain(): PrechainObservation {
  return {
    roles: [
      { name: HOSTED_INSTALLER, canLogin: true, createRole: true, isSuper: false },
      { name: OWNER, canLogin: false, createRole: false, isSuper: false },
    ],
    memberships: [],
    objects: contracts.map((c) => ({
      object: c.object,
      present: true,
      owner: OWNER,
      held: {},
      heldWithGrantOption: {},
    })),
    schemaCreate: { public: true, uellix_grounding: true },
    installerCanSetOwner: true,
    capabilityReachableBy: {},
  }
}

const prechain = (attemptId: string, o: PrechainObservation = healthyPrechain()): string =>
  JSON.stringify({ schema: PRECHAIN_OBSERVATION_SCHEMA, attemptId, observation: o })

/** The installer lost CREATEROLE: E-02, as the engine met it. */
function drivenPrechain(): PrechainObservation {
  const o = healthyPrechain()
  return {
    ...o,
    roles: [{ name: HOSTED_INSTALLER, canLogin: true, createRole: false, isSuper: false }, o.roles[1]!],
  }
}

/* -------------------------------------------------------------------------- */
/* The chain observation, assembled the way the operator assembles it          */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>

const FLAGS_OFF: Record<string, string> = Object.fromEntries(
  STELLA_FEATURE_FLAGS.map((f) => [f, 'false']),
)

function packageObservations(installed: readonly string[]): Json[] {
  return WITNESSED_PACKAGES.map((packageId) => {
    const d = PACKAGE_WITNESSES[packageId]!
    const on = installed.includes(packageId)
    return {
      packageId,
      witnesses: {
        ...Object.fromEntries(d.requiredPresentWhenInstalled.map(witnessKey).map((k) => [k, on])),
        ...Object.fromEntries(d.requiredAbsentWhenInstalled.map(witnessKey).map((k) => [k, false])),
      },
    }
  })
}

function chainObservation(installed: readonly string[] = []): string {
  const corroboration: Json = {
    declaredEnvironment: 'staging',
    declaredProjectRef: REF,
    connection: {
      connectionHost: 'aws-0-us-east-2.pooler.supabase.com',
      poolerUser: `postgres.${REF}`,
      connectionPort: 5432,
    },
    featureFlags: { ...FLAGS_OFF },
    observation: {
      attemptId: A,
      targetProjectRef: REF,
      measuredBy: 'operator, psql session pooler, inside a READ ONLY transaction',
      sentinelObservation: {
        tablePresent: true,
        rowCount: 1,
        id: true,
        environment: 'staging',
        projectRef: REF,
        bootstrapVersion: SENTINEL_BOOTSTRAP_VERSION,
        provisionedAt: '2026-08-09T17:03:26.683865+00:00',
        ownerSeparation: SENTINEL_OWNER_SEPARATION,
        rr02Present: true,
      },
      bootstrapSchemaPresent: true,
      baselineJournal: {
        tablePresent: true,
        units: BASELINE_ORDER.map((packageId) => ({ packageId, status: 'APPLIED' })),
        projectRefs: [REF],
        environments: ['staging'],
      },
      packageObservations: packageObservations(installed),
    },
  }
  const body = {
    schema: PRE_WRITE_OBSERVATION_SCHEMA,
    phase: 'PRE_WRITE',
    attemptId: A,
    observationId: 'obs_t1gate',
    corroboration,
  }
  return JSON.stringify({ ...body, digest: observationDigest(body as never) })
}

const OPEN_A = JSON.stringify({
  attemptId: A,
  event: 'OPENED',
  targetProjectRef: REF,
  at: AT,
})

/* -------------------------------------------------------------------------- */
/* B1 — the matrix                                                             */
/* -------------------------------------------------------------------------- */

const gate = (over: Partial<Parameters<typeof gateGovernedT1>[0]> = {}) =>
  gateGovernedT1({
    packageId: T1,
    attemptId: A,
    witnessRaw: witness(A, REMEDIATION_INSTALLED),
    prechainRaw: prechain(A),
    ...over,
  })

describe('the T1 operator gate — required matrix', () => {
  it('refuses T1 when the remediation is ABSENT', () => {
    const result = gate({ witnessRaw: witness(A, REMEDIATION_ABSENT) })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('T1 was authorised on an unremediated project')
    expect(result.code).toBe('REMEDIATION_ABSENT')
  })

  it('refuses T1 when the remediation is PARTIAL_OR_INCONSISTENT', () => {
    const result = gate({ witnessRaw: witness(A, REMEDIATION_PARTIAL) })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_PARTIAL')
  })

  it('refuses T1 when the remediation is INSTALLED and the prechain gate fails', () => {
    const result = gate({ prechainRaw: prechain(A, drivenPrechain()) })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('T1 was authorised against a failing prechain gate')
    expect(result.code).toBe('PRECHAIN_GATE_FAILED')
  })

  it('permits T1 only when the remediation is INSTALLED and the gate passes', () => {
    const result = gate()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.detail)
    expect(result.required).toBe(true)
    if (!result.required) throw new Error('unreachable')
    expect(result.remediation.state).toBe('INSTALLED')
    expect(result.gateRefusals).toEqual([])
  })

  it('authorises exactly one of the four matrix cells', () => {
    const cells = [
      { remediation: REMEDIATION_ABSENT, healthy: true },
      { remediation: REMEDIATION_ABSENT, healthy: false },
      { remediation: REMEDIATION_PARTIAL, healthy: true },
      { remediation: REMEDIATION_PARTIAL, healthy: false },
      { remediation: REMEDIATION_INSTALLED, healthy: false },
      { remediation: REMEDIATION_INSTALLED, healthy: true },
    ]
    const authorised = cells.filter(
      (c) =>
        gate({
          witnessRaw: witness(A, c.remediation),
          prechainRaw: prechain(A, c.healthy ? healthyPrechain() : drivenPrechain()),
        }).ok,
    )
    expect(authorised).toHaveLength(1)
    expect(authorised[0]?.remediation).toBe(REMEDIATION_INSTALLED)
    expect(authorised[0]?.healthy).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* B3 — evidence, never a flag                                                 */
/* -------------------------------------------------------------------------- */

describe('the T1 operator gate — evidence is typed or absent', () => {
  it('refuses T1 when the remediation witness was not supplied', () => {
    const result = gate({ witnessRaw: null })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('CHAIN_T1_EVIDENCE_REQUIRED')
  })

  it('refuses T1 when the prechain observation was not supplied', () => {
    const result = gate({ prechainRaw: null })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('CHAIN_T1_EVIDENCE_REQUIRED')
  })

  it('refuses evidence measured for a different attempt', () => {
    const other = 'att_' + 'b'.repeat(32)
    expect(gate({ witnessRaw: witness(other, REMEDIATION_INSTALLED) }).ok).toBe(false)
    expect(gate({ prechainRaw: prechain(other) }).ok).toBe(false)
  })

  it('refuses a prechain document whose booleans are missing rather than false', () => {
    const o = healthyPrechain() as unknown as Record<string, unknown>
    const broken = { ...o }
    delete broken.installerCanSetOwner
    const result = gate({
      prechainRaw: JSON.stringify({
        schema: PRECHAIN_OBSERVATION_SCHEMA,
        attemptId: A,
        observation: broken,
      }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('PRECHAIN_OBSERVATION_MALFORMED')
  })

  it('accepts no trust-me flag anywhere in the operator shell', () => {
    expect(SHELL).not.toMatch(/remediation-installed/)
    expect(SHELL).not.toMatch(/prechain-pass/)
    expect(SHELL).not.toMatch(/=true/)
  })

  it('emits a prechain probe that carries the attempt and the certified question', () => {
    const sql = buildPrechainObservationSql(A)
    expect(sql).toContain(`'${A}'`)
    expect(sql).toContain(PRECHAIN_OBSERVATION_SCHEMA)
    expect(sql).toContain('capabilityReachableBy')
    expect(sql).toContain('installerCanSetOwner')
    for (const role of CAPABILITY_ROLES) expect(sql).toContain(role)
  })
})

/* -------------------------------------------------------------------------- */
/* B2 — T2..T9 keep the flow they had                                          */
/* -------------------------------------------------------------------------- */

describe('the T1 operator gate — T2..T9 unchanged', () => {
  it('does not require remediation evidence for a non-T1 package', () => {
    const result = gateGovernedT1({ packageId: T2, attemptId: A })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.detail)
    expect(result.required).toBe(false)
  })

  it('names T1 as the first governed package and nothing else', () => {
    expect(GOVERNED_T1_PACKAGE).toBe(T1)
    for (const later of CHAIN_WRITE_ORDER.slice(1)) {
      expect(gateGovernedT1({ packageId: later, attemptId: A }).ok).toBe(true)
    }
  })

  it('plans T2 from a chain observation alone, with no T1 evidence at all', () => {
    const result = planChainWriteForOperator({
      raw: chainObservation([T1]),
      expectedAttemptId: A,
      attemptLedger: OPEN_A,
      at: AT,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
    expect(result.authorization.packageId).toBe(T2)
    expect(result.t1).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* B4 — nothing is consumed on a refusal                                       */
/* -------------------------------------------------------------------------- */

describe('the T1 operator gate — refusal precedes consumption', () => {
  it('issues no consumable ledger line when T1 evidence is missing', () => {
    const result = planChainWriteForOperator({
      raw: chainObservation([]),
      expectedAttemptId: A,
      attemptLedger: OPEN_A,
      at: AT,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('T1 was planned without evidence')
    expect(result.code).toBe('CHAIN_T1_EVIDENCE_REQUIRED')
    expect(result).not.toHaveProperty('consumedLedgerLine')
  })

  it('issues no consumable ledger line when the remediation is absent', () => {
    const result = planChainWriteForOperator({
      raw: chainObservation([]),
      expectedAttemptId: A,
      attemptLedger: OPEN_A,
      at: AT,
      witnessRaw: witness(A, REMEDIATION_ABSENT),
      prechainRaw: prechain(A),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_ABSENT')
    expect(result).not.toHaveProperty('consumedLedgerLine')
  })

  it('plans T1 and consumes exactly one attempt once both gates pass', () => {
    const result = planChainWriteForOperator({
      raw: chainObservation([]),
      expectedAttemptId: A,
      attemptLedger: OPEN_A,
      at: AT,
      witnessRaw: witness(A, REMEDIATION_INSTALLED),
      prechainRaw: prechain(A),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
    expect(result.authorization.packageId).toBe(T1)
    expect(result.t1?.remediation).toBe('INSTALLED')
    expect(result.t1?.prechainRefusals).toBe(0)

    const consumed = parseChainAttemptLedger(result.consumedLedgerLine)
    expect(consumed).toHaveLength(1)
    expect(consumed[0]?.event).toBe('CONSUMED')
    expect(consumed[0]?.packageId).toBe(T1)
  })

  it('names the governed artefact, pinned, and never the middle one', () => {
    const result = planChainWriteForOperator({
      raw: chainObservation([]),
      expectedAttemptId: A,
      attemptLedger: OPEN_A,
      at: AT,
      witnessRaw: witness(A, REMEDIATION_INSTALLED),
      prechainRaw: prechain(A),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
    expect(result.record.PACKAGE_PATH).toBe(
      `db/prepared/hosted/governed/${T1}.governed.sql`,
    )
    expect(result.record.PACKAGE_PATH).not.toContain('.hosted.sql')
    expect(result.record.PACKAGE_DIGEST).toMatch(/^[0-9a-f]{64}$/)
  })

  it('issues no plan at all when the governed artefact does not match its pin', () => {
    // The refusal has to arrive here rather than at psql: this is a write into
    // an open transaction against staging, and «the bytes moved» is not
    // something to discover at statement 915.
    const result = planChainWriteForOperator({
      raw: chainObservation([]),
      expectedAttemptId: A,
      attemptLedger: OPEN_A,
      at: AT,
      witnessRaw: witness(A, REMEDIATION_INSTALLED),
      prechainRaw: prechain(A),
      readGovernedArtefact: () => '-- somebody edited this\n',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('an unpinned artefact was authorised')
    expect(result.code).toBe('CERT_DIGEST_MISMATCH')
    expect(result).not.toHaveProperty('consumedLedgerLine')
  })

  it('consults the gate in the shell rather than authorising directly', () => {
    expect(SHELL).toContain('planChainWriteForOperator')
    expect(SHELL).not.toMatch(/authorizeChainWrite\s*\(/)
  })

  it('reports the gate without touching the ledger', () => {
    // The runbook has a HARD STOP between a verified prechain gate and T1, and
    // a stop that can only be observed by running the command that consumes the
    // attempt is not a stop. `gate` answers the same question through the same
    // certified path and writes nothing — so the shell's gate branch must
    // contain no append at all.
    const start = SHELL.indexOf('function gate(')
    expect(start).toBeGreaterThan(-1)
    const body = SHELL.slice(start, SHELL.indexOf('\nfunction ', start + 1))
    expect(body).toContain('gateGovernedT1')
    expect(body).not.toContain('appendFileSync')
    expect(body).not.toContain('writeFileSync')
  })
})

/* -------------------------------------------------------------------------- */
/* F-PS-04 — the two ledgers cannot lend each other a record                   */
/* -------------------------------------------------------------------------- */

describe('attempt ledgers refuse each other kinds', () => {
  it('drops a remediation record pasted into the chain ledger', () => {
    const foreign = JSON.stringify({
      attemptId: A,
      event: 'OPENED',
      targetProjectRef: REF,
      at: AT,
      kind: REMEDIATION_ATTEMPT_KIND,
    })
    expect(parseChainAttemptLedger(foreign)).toHaveLength(0)
  })

  it('keeps the legacy chain records that predate the kind field', () => {
    expect(parseChainAttemptLedger(OPEN_A)).toHaveLength(1)
    const explicit = JSON.stringify({
      attemptId: A,
      event: 'OPENED',
      targetProjectRef: REF,
      at: AT,
      kind: CHAIN_ATTEMPT_KIND,
    })
    expect(parseChainAttemptLedger(explicit)).toHaveLength(1)
  })

  it('cannot be made to authorise a chain write from a remediation attempt', () => {
    const foreign = JSON.stringify({
      attemptId: A,
      event: 'OPENED',
      targetProjectRef: REF,
      at: AT,
      kind: REMEDIATION_ATTEMPT_KIND,
    })
    const result = planChainWriteForOperator({
      raw: chainObservation([]),
      expectedAttemptId: A,
      attemptLedger: foreign,
      at: AT,
      witnessRaw: witness(A, REMEDIATION_INSTALLED),
      prechainRaw: prechain(A),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('a remediation ledger record opened a chain attempt')
    expect(result.code).toBe('CHAIN_OBSERVATION_ATTEMPT_NOT_OPEN')
  })
})
