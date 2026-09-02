// tests/hosted/remediation-operator.test.ts
// COMMIT 5.4 — the OPERATOR entrypoint for the prechain remediation (F-PS-05).
//
// Commit 5.3 built and certified every decision this path takes, and left them
// reachable from exactly one place: `scripts/remediation-certify.ts`, a harness
// whose declared target safety is that no connection string can name a target
// and the containers have no interface but loopback. Correct for a laboratory
// and unusable by an operator, so the machinery that decides whether staging
// may be written existed and could not be run against staging.
//
// What is tested here is the ADAPTER, and the tests are written from the thing
// an adapter can get wrong: reimplementing a decision instead of delegating it.
// Every assertion below either compares the adapter's output with the certified
// function's own output, or drives a refusal that only the certified function
// can produce.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  CERTIFIED_CAPABILITIES_BODY_HEADER,
  REMEDIATION_PROBE_ARTIFACT,
  certifiedCapabilitiesBodyDigest,
  openRemediationAttempt,
  planRemediationWrite,
} from '@/db/hosted/remediation-operator'
import {
  EXPECTED_BOOTSTRAP_SCHEMA_GRANTEES,
  PRECHAIN_REMEDIATION,
  type RemediationObservation,
} from '@/db/hosted/prechain-remediation'
import {
  OLD_BOOTSTRAP_ID,
  REMEDIATION_ATTEMPT_KIND,
  RemediationPinRefusal,
  parseRemediationAttemptLedger,
} from '@/db/hosted/remediation-attempt'
import {
  REMEDIATION_WITNESS_SCHEMA,
  bodyDigest,
  buildRemediationWitnessSql,
  extractDollarQuotedBody,
} from '@/db/hosted/authority/certification/remediation-probes'
import { CHAIN_WRITE_ORDER } from '@/db/hosted/fresh-observation'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'

const ROOT = process.cwd()
const SQL = readFileSync(path.join(ROOT, PRECHAIN_REMEDIATION.sourceFile), 'utf8')
const SHELL = readFileSync(path.join(ROOT, 'scripts/remediation-attempt.ts'), 'utf8')

const A = 'att_' + 'a'.repeat(32)
const B = 'att_' + 'b'.repeat(32)
const AT = '2026-08-10T00:00:00.000Z'
const T1 = CHAIN_WRITE_ORDER[0] as string

/** The measured staging source state: nothing reconciled, nothing leaked. */
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

/** Half reconciled: the attribute moved, the grants did not. */
const HALF: RemediationObservation = { ...SOURCE, installerHasCreateRole: true }

const witness = (
  attemptId: string,
  observation: RemediationObservation,
  override: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    schema: REMEDIATION_WITNESS_SCHEMA,
    attemptId,
    observation,
    ...override,
  })

const opened = (id: string): string =>
  JSON.stringify({
    attemptId: id,
    event: 'OPENED',
    targetProjectRef: KNOWN_STAGING_PROJECT_REF,
    at: AT,
    kind: REMEDIATION_ATTEMPT_KIND,
  })

const plan = (over: Partial<Parameters<typeof planRemediationWrite>[0]> = {}) =>
  planRemediationWrite({
    witnessRaw: witness(A, SOURCE),
    expectedAttemptId: A,
    attemptLedger: opened(A),
    remediationSql: SQL,
    at: AT,
    ...over,
  })

describe('remediation operator — open', () => {
  it('mints a typed remediation attempt, not a chain attempt', () => {
    const result = openRemediationAttempt({ attemptId: A, remediationSql: SQL, at: AT })

    expect(result.attemptId).toBe(A)
    expect(result.packageId).toBe(PRECHAIN_REMEDIATION.id)
    expect(result.targetProjectRef).toBe(KNOWN_STAGING_PROJECT_REF)

    const records = parseRemediationAttemptLedger(result.ledgerLine)
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe(REMEDIATION_ATTEMPT_KIND)
    expect(records[0]?.event).toBe('OPENED')
    expect(records[0]?.attemptId).toBe(A)
  })

  it('emits the certified probe, digested from the pinned package', () => {
    const result = openRemediationAttempt({ attemptId: A, remediationSql: SQL, at: AT })

    const digest = bodyDigest(
      extractDollarQuotedBody(SQL, CERTIFIED_CAPABILITIES_BODY_HEADER),
    )
    expect(result.certifiedBodyDigest).toBe(digest)
    expect(result.certifiedBodyDigest).toMatch(/^[0-9a-f]{64}$/)
    // Byte-identical to what the certified builder produces. An adapter that
    // assembled its own SQL could measure a different set from the one the
    // package writes and still look correct.
    expect(result.probeSql).toBe(buildRemediationWitnessSql(A, digest))
    expect(result.probeSql).toContain(`'${A}'`)
  })

  it('refuses to emit a probe for a package whose bytes moved', () => {
    expect(() =>
      openRemediationAttempt({ attemptId: A, remediationSql: `${SQL}\n-- edit\n`, at: AT }),
    ).toThrow(RemediationPinRefusal)
  })

  it('writes the probe to a deterministic artifact path under artifacts/', () => {
    expect(REMEDIATION_PROBE_ARTIFACT).toMatch(/^artifacts\//)
    expect(REMEDIATION_PROBE_ARTIFACT).toContain('remediation')
  })
})

describe('remediation operator — the shell reaches no database', () => {
  it('has no process, no environment and no driver', () => {
    expect(SHELL).not.toMatch(/child_process/)
    expect(SHELL).not.toMatch(/process\.env/)
    expect(SHELL).not.toMatch(/from 'pg'/)
    expect(SHELL).not.toMatch(/node:net|node:tls|node:https?/)
    expect(SHELL).not.toMatch(/\bfetch\s*\(/)
  })

  it('delegates the decision instead of restating it', () => {
    expect(SHELL).toContain('openRemediationAttempt')
    expect(SHELL).toContain('planRemediationWrite')
    expect(SHELL).not.toContain('classifyRemediation')
  })
})

describe('remediation operator — witness transport', () => {
  it('refuses a witness that is not JSON', () => {
    const result = plan({ witnessRaw: 'not json' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_WITNESS_MALFORMED')
  })

  it('refuses a witness with no measurement at all', () => {
    const result = plan({ witnessRaw: null })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_WITNESS_REQUIRED')
  })

  it('refuses a witness measured for another attempt', () => {
    const result = plan({ witnessRaw: witness(B, SOURCE) })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_WITNESS_ATTEMPT_MISMATCH')
  })

  it('refuses a document that is not a remediation witness', () => {
    const result = plan({
      witnessRaw: JSON.stringify({
        schema: 'uellix.hosted.chain.observation/1',
        attemptId: A,
        observation: SOURCE,
      }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_WITNESS_MALFORMED')
  })

  it('refuses a missing boolean rather than reading it as false', () => {
    const partial = { ...SOURCE } as Record<string, unknown>
    delete partial.topologyAssertionPresent
    const result = plan({
      witnessRaw: JSON.stringify({
        schema: REMEDIATION_WITNESS_SCHEMA,
        attemptId: A,
        observation: partial,
      }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_WITNESS_MALFORMED')
  })
})

describe('remediation operator — plan', () => {
  it('authorises exactly one write from an ABSENT witness', () => {
    const result = plan()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.detail)

    expect(result.record.REMEDIATION_ATTEMPT_ID).toBe(A)
    expect(result.record.WITNESS).toBe('ABSENT')
    expect(result.record.PACKAGE_ID).toBe(PRECHAIN_REMEDIATION.id)
    expect(result.record.PACKAGE_PATH).toBe(PRECHAIN_REMEDIATION.sourceFile)
    expect(result.record.PIN_STATUS).toContain(PRECHAIN_REMEDIATION.sourceSha256)
    expect(result.record.ATTEMPT_STATUS).toBe('CONSUMED')
    expect(result.record.DECISION).toBe('AUTHORIZED')

    const consumed = parseRemediationAttemptLedger(result.consumedLedgerLine)
    expect(consumed[0]?.event).toBe('CONSUMED')
    expect(consumed[0]?.kind).toBe(REMEDIATION_ATTEMPT_KIND)
    expect(consumed[0]?.packageId).toBe(PRECHAIN_REMEDIATION.id)
  })

  it('refuses the same observation a second time', () => {
    const first = plan()
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.detail)

    const second = plan({ attemptLedger: `${opened(A)}\n${first.consumedLedgerLine}` })
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('a consumed attempt authorised a second write')
    expect(second.code).toBe('REMEDIATION_ATTEMPT_NOT_OPEN')
  })

  it('refuses an attempt a later attempt retired', () => {
    const result = plan({ attemptLedger: `${opened(A)}\n${opened(B)}` })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_ATTEMPT_NOT_OPEN')
  })

  it('refuses an attempt that was never opened', () => {
    const result = plan({ attemptLedger: null })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_ATTEMPT_NOT_OPEN')
  })

  it('never re-applies an INSTALLED remediation', () => {
    const result = plan({ witnessRaw: witness(A, TARGET) })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('an installed remediation was authorised again')
    expect(result.code).toBe('REMEDIATION_ALREADY_INSTALLED')
  })

  it('sends PARTIAL_OR_INCONSISTENT to human recovery', () => {
    const result = plan({ witnessRaw: witness(A, HALF) })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_PARTIAL_HUMAN_ONLY')
  })

  it('treats a surviving borrowed grantee as a problem, not as progress', () => {
    const leaked: RemediationObservation = {
      ...TARGET,
      bootstrapSchemaAcl: [...EXPECTED_BOOTSTRAP_SCHEMA_GRANTEES, 'postgres'],
    }
    const result = plan({ witnessRaw: witness(A, leaked) })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_PARTIAL_HUMAN_ONLY')
  })
})

describe('remediation operator — package selection', () => {
  it('refuses the first-provision bootstrap', () => {
    const result = plan({ requestedPackageId: OLD_BOOTSTRAP_ID })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_PACKAGE_NOT_PERMITTED')
    expect(result.detail).toContain('PROHIBITED')
  })

  it('refuses a governed chain package', () => {
    const result = plan({ requestedPackageId: T1 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_PACKAGE_NOT_PERMITTED')
  })

  it('refuses a package nobody registered', () => {
    const result = plan({ requestedPackageId: 'stella_hosted_0099_invented' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_PACKAGE_NOT_PERMITTED')
  })

  it('accepts the one registered remediation by name', () => {
    const result = plan({ requestedPackageId: PRECHAIN_REMEDIATION.id })
    expect(result.ok).toBe(true)
  })
})

describe('remediation operator — the pin is checked before anything is read', () => {
  it('refuses a moved byte even when the witness is also malformed', () => {
    const result = plan({ remediationSql: `${SQL}\n-- edit\n`, witnessRaw: 'not json' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('REMEDIATION_PIN_MISMATCH')
  })

  it('derives the certified body digest from the body rather than a constant', () => {
    // A change INSIDE assert_hosted_capabilities must move the digest; a pinned
    // copy of the hash would keep reporting the old body as certified.
    const moved = SQL.replace(
      'assert_hosted_capabilities: the calling package must name itself.',
      'assert_hosted_capabilities: the calling package must identify itself.',
    )
    expect(moved).not.toBe(SQL)
    expect(certifiedCapabilitiesBodyDigest(SQL)).not.toBe(certifiedCapabilitiesBodyDigest(moved))
  })
})

describe('remediation operator — target', () => {
  it('refuses a production project ref outright', () => {
    const production = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0] as string
    const result = plan({ targetProjectRef: production })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('a production ref was accepted')
    expect(result.code).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it('refuses a project ref that is not the known staging one', () => {
    const result = plan({ targetProjectRef: 'someotherprojectrefx' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('HOSTED_TARGET_NOT_EXPECTED_PROJECT')
  })
})
