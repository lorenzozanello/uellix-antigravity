// tests/hosted/forward-only-contract.test.ts
//
// THE FORWARD-ONLY CONTRACT — adversarial finding RT-03.
//
// Commit 1 made the code refuse a re-apply. This file makes the CONTRACT
// executable: the four operations that "reapply" used to name have four
// different answers, the governing documents say so, and the historical evidence
// that measured the opposite keeps its scope instead of being rewritten.
//
// The document gate is deliberately NOT a global grep. A naive one would fail on
// `ADVERSARIAL_FINDINGS.md`, which correctly records that five packages were
// applied twice with identical state — evidence that is true, was expensive to
// obtain, and must not be edited into agreement with a later contract. The gate
// is an explicit list plus a marker assertion.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  CHAIN_WRITE_ORDER,
  HOSTED_CHAIN_REAPPLY_POLICY,
  INSTALLED_PACKAGE_ACTION,
  PRE_WRITE_OBSERVATION_SCHEMA,
  authorizeChainWrite,
  observationDigest,
} from '@/db/hosted/fresh-observation'
import { BASELINE_ORDER } from '@/db/hosted/baseline-manifest'
import { PACKAGE_WITNESSES, WITNESSED_PACKAGES, witnessKey } from '@/db/hosted/package-witnesses'
import { STELLA_FEATURE_FLAGS } from '@/db/hosted/hosted-provisioning-runner'
import {
  SENTINEL_BOOTSTRAP_VERSION,
  SENTINEL_OWNER_SEPARATION,
} from '@/db/hosted/bootstrap-postconditions'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'

const ROOT = process.cwd()
const REF = KNOWN_STAGING_PROJECT_REF
const A1 = 'att_' + '1'.repeat(32)
const A2 = 'att_' + '2'.repeat(32)
const [T1, T2] = CHAIN_WRITE_ORDER as unknown as [string, string]

const doc = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')

/* -------------------------------------------------------------------------- */
/* fixture — one builder, so the four contract cases differ only where they    */
/* are supposed to differ                                                      */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>

function witnesses(installed: readonly string[], partial?: string): Json[] {
  return WITNESSED_PACKAGES.map((packageId) => {
    const d = PACKAGE_WITNESSES[packageId]!
    const pos = d.requiredPresentWhenInstalled.map(witnessKey)
    const neg = d.requiredAbsentWhenInstalled.map(witnessKey)
    const on = installed.includes(packageId)
    const w: Record<string, boolean> = {
      ...Object.fromEntries(pos.map((k) => [k, on])),
      ...Object.fromEntries(neg.map((k) => [k, false])),
    }
    // PARTIAL: exactly one positive witness present, the rest absent.
    if (packageId === partial && pos[0] !== undefined) w[pos[0]] = true
    return { packageId, witnesses: w }
  })
}

function observation(attemptId: string, installed: readonly string[], partial?: string): string {
  const body = {
    schema: PRE_WRITE_OBSERVATION_SCHEMA,
    phase: 'PRE_WRITE',
    attemptId,
    observationId: `obs_${attemptId.slice(4, 10)}`,
    corroboration: {
      declaredEnvironment: 'staging',
      declaredProjectRef: REF,
      connection: {
        connectionHost: 'aws-0-us-east-2.pooler.supabase.com',
        poolerUser: `postgres.${REF}`,
        connectionPort: 5432,
      },
      featureFlags: Object.fromEntries(STELLA_FEATURE_FLAGS.map((f) => [f, 'false'])),
      observation: {
        attemptId,
        targetProjectRef: REF,
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
          units: BASELINE_ORDER.map((p) => ({ packageId: p, status: 'APPLIED' })),
          projectRefs: [REF],
          environments: ['staging'],
        },
        packageObservations: witnesses(installed, partial),
      },
    },
  }
  return JSON.stringify({ ...body, digest: observationDigest(body as never) })
}

const rec = (id: string, event: 'OPENED' | 'CONSUMED', pkg?: string) =>
  JSON.stringify({
    attemptId: id,
    event,
    targetProjectRef: REF,
    at: '2026-08-09T18:00:00.000Z',
    ...(pkg ? { packageId: pkg } : {}),
  })

const ask = (attemptId: string, ledger: string, installed: readonly string[], opts: { partial?: string; requested?: string } = {}) =>
  authorizeChainWrite({
    raw: observation(attemptId, installed, opts.partial),
    expectedAttemptId: attemptId,
    attemptLedger: ledger,
    requestedPackage: opts.requested,
    production: KNOWN_PRODUCTION_IDENTIFIERS,
  })

/* -------------------------------------------------------------------------- */
/* the four operations                                                        */
/* -------------------------------------------------------------------------- */

describe('the four operations "reapply" used to name', () => {
  it('C. REPLAY_CHAIN_ON_FRESH_TARGET — everything ABSENT authorises T1', () => {
    const r = ask(A1, rec(A1, 'OPENED'), [])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.packageId).toBe(T1)
  })

  it('A. RETRY_AFTER_ROLLBACK — still ABSENT, so a NEW attempt may retry it', () => {
    // The first attempt was consumed and its write rolled back. The package
    // never became installed, so this is first-run semantics, not a re-apply.
    const ledger = [rec(A1, 'OPENED'), rec(A1, 'CONSUMED', T1), rec(A2, 'OPENED')].join('\n')
    const r = ask(A2, ledger, [])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.packageId).toBe(T1)
  })

  it('A2. …but only with a NEW attempt: the consumed one cannot retry it', () => {
    const ledger = [rec(A1, 'OPENED'), rec(A1, 'CONSUMED', T1), rec(A2, 'OPENED')].join('\n')
    const r = ask(A1, ledger, [])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_ATTEMPT_NOT_OPEN')
  })

  it('B. REAPPLY_INSTALLED_PACKAGE — refused, and T2 is what comes next', () => {
    const ledger = rec(A2, 'OPENED')
    const refused = ask(A2, ledger, [T1], { requested: T1 })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.code).toBe('CHAIN_TARGET_ALREADY_INSTALLED')

    const next = ask(A2, ledger, [T1])
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.packageId).toBe(T2)
  })

  it('PARTIAL — neither a retry nor a next package', () => {
    const r = ask(A1, rec(A1, 'OPENED'), [], { partial: T1 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_PARTIAL_STATE')
  })
})

/* -------------------------------------------------------------------------- */
/* where the one-write property is actually enforced                          */
/* -------------------------------------------------------------------------- */

describe('EXACTLY_ONE_WRITE_PER_OBSERVATION — the locus, pinned rather than remembered', () => {
  it('the PURE gate authorises one PACKAGE, and cannot limit invocations', () => {
    // A pure function has no side effects, so calling it twice returns twice.
    // This is not a hole; it is where the responsibility sits, and the contract
    // says so out loud rather than implying the gate self-limits.
    const ledger = rec(A1, 'OPENED')
    const first = ask(A1, ledger, [])
    const second = ask(A1, ledger, [])
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.packageId).toBe(second.packageId)
    expect(first.packageId).toBe(T1)
  })

  it('the LEDGER authorises one PLAN: the CONSUMED record closes the observation', () => {
    const after = [rec(A1, 'OPENED'), rec(A1, 'CONSUMED', T1)].join('\n')
    const r = ask(A1, after, [])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_ATTEMPT_NOT_OPEN')
  })

  it('and the CLI is what writes it — so the contract documents that, not the gate', () => {
    const cli = doc('scripts/chain-attempt.ts')
    expect(cli).toContain("event: 'CONSUMED'")
    expect(cli).toContain('appendFileSync')
    // The gate must NOT pretend to perform the transition itself.
    expect(doc('db/hosted/fresh-observation.ts')).not.toContain('appendFileSync')
  })
})

/* -------------------------------------------------------------------------- */
/* the policy constants reflect behaviour, and are not a second switch         */
/* -------------------------------------------------------------------------- */

describe('the policy constants name what the code does', () => {
  it('are the values the contract states', () => {
    expect(HOSTED_CHAIN_REAPPLY_POLICY).toBe('forward-only')
    expect(INSTALLED_PACKAGE_ACTION).toBe('refuse')
  })

  it('are not consulted by any decision — one implementation, not two', () => {
    const src = doc('db/hosted/fresh-observation.ts')
    const uses = src.split('HOSTED_CHAIN_REAPPLY_POLICY').length - 1
    const usesAction = src.split('INSTALLED_PACKAGE_ACTION').length - 1
    // Once each: the declaration. A second occurrence would mean a branch reads
    // it, and a readable policy is a policy someone can flip.
    expect(uses).toBe(1)
    expect(usesAction).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* the document gate                                                          */
/* -------------------------------------------------------------------------- */

/** Hosted OPERATIONAL docs: these govern what an operator may do today. */
const GOVERNING_HOSTED_DOCS = [
  'docs/ops/staging/STELLA_HOSTED_FORWARD_ONLY_CONTRACT.md',
  'docs/ops/staging/STELLA_STAGING_PROVISIONING_REQUIREMENTS.md',
  'docs/ops/staging/STELLA_STAGING_MIGRATION_PLAN.md',
]

/** Historical evidence: preserved verbatim, but must carry its scope. */
const SCOPED_HISTORICAL_DOCS = [
  'docs/ops/capabilities/ADVERSARIAL_FINDINGS.md',
  'docs/ops/LOCAL_STAGING_G2_REHEARSAL.md',
  'docs/ops/DATABASE_ROLE_MODEL.md',
]

describe('the document gate: hosted operational docs cannot promise a re-apply', () => {
  it('the contract exists and names itself normative', () => {
    const c = doc(GOVERNING_HOSTED_DOCS[0]!)
    expect(c).toContain('HOSTED_CHAIN_CONTRACT = FORWARD_ONLY')
    expect(c).toMatch(/normativ/i)
  })

  it('every governing hosted doc carries the contract marker or points at it', () => {
    for (const rel of GOVERNING_HOSTED_DOCS) {
      const text = doc(rel)
      expect(
        text.includes('FORWARD_ONLY') || text.includes('STELLA_HOSTED_FORWARD_ONLY_CONTRACT.md'),
        `${rel} does not reference the forward-only contract`,
      ).toBe(true)
    }
  })

  it('every historical doc that measured a second apply carries its scope', () => {
    for (const rel of SCOPED_HISTORICAL_DOCS) {
      const text = doc(rel)
      expect(
        text.includes('STELLA_HOSTED_FORWARD_ONLY_CONTRACT.md'),
        `${rel} records second-apply evidence without scoping it`,
      ).toBe(true)
      expect(text).toMatch(/Alcance|alcance/)
    }
  })

  it('the historical evidence is PRESERVED, not edited into agreement', () => {
    // The specific measurements RT-03 flagged must still be readable. A gate
    // that passed because somebody deleted the inconvenient sentence would be
    // worse than no gate.
    expect(doc('docs/ops/capabilities/ADVERSARIAL_FINDINGS.md')).toContain('aplicados **dos veces**')
    expect(doc('docs/ops/LOCAL_STAGING_G2_REHEARSAL.md')).toMatch(/Idempotencia.*medida, no supuesta/)
    expect(doc('docs/ops/DATABASE_ROLE_MODEL.md')).toContain('El script es **idempotente**')
  })

  it('the runbook forbids deciding a retry from an exit code', () => {
    const runbook = doc('docs/ops/staging/STELLA_STAGING_PROVISIONING_REQUIREMENTS.md')
    expect(runbook).toMatch(/exit code/i)
    expect(runbook).toMatch(/observación read-only fresca/i)
    expect(runbook).toContain('CHAIN_OBSERVATION_REQUIRED')
  })

  it('the contract does not claim the gate stops a determined administrator', () => {
    const c = doc(GOVERNING_HOSTED_DOCS[0]!)
    expect(c).toContain('OPERATOR_PROCEDURE_VIOLATION')
    // Line-wrap tolerant: the prose is wrapped, and an assertion that forces a
    // document to be rewrapped is an assertion about formatting, not content.
    expect(c.replace(/\s+/g, ' ')).toMatch(/no es una barrera criptográfica/i)
  })

  it('the bootstrap defect is scoped to reprovision, not to the current chain', () => {
    const c = doc(GOVERNING_HOSTED_DOCS[0]!)
    expect(c).toContain('BOOTSTRAP_SECOND_PASS = DEFERRED_WITH_EXPLICIT_GATE')
    expect(c).toMatch(/No bloquea la cadena actual/i)
  })

  it('T1 stays unauthorised, and says why', () => {
    const c = doc(GOVERNING_HOSTED_DOCS[0]!)
    expect(c).toContain('T1_RETRY_AUTHORIZED = false')
    expect(c).toContain('FAILED_AND_ROLLED_BACK_CONFIRMED')
  })
})
