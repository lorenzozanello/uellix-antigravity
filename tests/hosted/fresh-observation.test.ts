// tests/hosted/fresh-observation.test.ts
//
// THE PRE-WRITE FRESHNESS GATE — adversarial finding RT-02.
//
// The property under test is not "does a good observation produce a plan". It is
// that every route from a COMMITTED database to a second write is closed:
//
//   * the observation that authorised the last attempt, replayed;
//   * an old document with a new attempt id pasted into it;
//   * a package state edited from INSTALLED to ABSENT;
//   * an observation of one database used to write to another;
//   * a dry run promoted into an apply;
//   * the caller-supplied state map, which is what the hole was.
//
// Every refusal below is paired with the pass it is the refusal of, so an
// implementation that refused everything would fail this file as loudly as the
// one that refused nothing.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ATTEMPT_ID_SHAPE,
  CHAIN_ATTEMPT_LEDGER,
  CHAIN_WRITE_ORDER,
  PRE_WRITE_OBSERVATION_SCHEMA,
  attemptStatus,
  authorizeChainWrite,
  buildPreWriteObservationSql,
  canonicalJson,
  evaluateFreshChainObservation,
  nextChainPackage,
  observationDigest,
  parseAttemptLedger,
  parseFreshChainObservation,
} from '@/db/hosted/fresh-observation'
import { planHostedApply } from '@/db/hosted/hosted-migrator'
import { planProvisioningPhase } from '@/db/hosted/hosted-provisioning-runner'
import { STELLA_FEATURE_FLAGS } from '@/db/hosted/hosted-provisioning-runner'
import { BASELINE_ORDER } from '@/db/hosted/baseline-manifest'
import { HOSTED_CHAIN } from '@/db/hosted/hosted-package-manifest'
import { PACKAGE_WITNESSES, WITNESSED_PACKAGES, witnessKey } from '@/db/hosted/package-witnesses'
import {
  SENTINEL_BOOTSTRAP_VERSION,
  SENTINEL_OWNER_SEPARATION,
} from '@/db/hosted/bootstrap-postconditions'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'

const ROOT = process.cwd()
const REF = KNOWN_STAGING_PROJECT_REF
const PROD = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]!

const ATTEMPT_A = 'att_' + 'a'.repeat(32)
const ATTEMPT_B = 'att_' + 'b'.repeat(32)

const [T1, T2] = CHAIN_WRITE_ORDER as unknown as [string, string]

const STELLA_SOURCES: Record<string, string> = Object.fromEntries(
  HOSTED_CHAIN.map((n) => [n, readFileSync(path.join(ROOT, 'db', 'prepared', `${n}.sql`), 'utf8')]),
)
const readBaselineSql = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

type Json = Record<string, unknown>

const SENTINEL_OK = {
  tablePresent: true,
  rowCount: 1,
  id: true,
  environment: 'staging',
  projectRef: REF,
  bootstrapVersion: SENTINEL_BOOTSTRAP_VERSION,
  provisionedAt: '2026-08-09T17:03:26.683865+00:00',
  ownerSeparation: SENTINEL_OWNER_SEPARATION,
  rr02Present: true,
}
const JOURNAL_OK = {
  tablePresent: true,
  units: BASELINE_ORDER.map((packageId) => ({ packageId, status: 'APPLIED' })),
  projectRefs: [REF],
  environments: ['staging'],
}
const FLAGS_OFF: Record<string, string> = Object.fromEntries(
  STELLA_FEATURE_FLAGS.map((f) => [f, 'false']),
)

/** Witness keys of the packages named INSTALLED; everything else measures false. */
function packageObservations(installed: readonly string[] = []): Json[] {
  return WITNESSED_PACKAGES.map((packageId) => {
    const d = PACKAGE_WITNESSES[packageId]!
    const positives = d.requiredPresentWhenInstalled.map(witnessKey)
    const negatives = d.requiredAbsentWhenInstalled.map(witnessKey)
    const on = installed.includes(packageId)
    return {
      packageId,
      witnesses: {
        ...Object.fromEntries(positives.map((k) => [k, on])),
        ...Object.fromEntries(negatives.map((k) => [k, false])),
      },
    }
  })
}

interface FixtureOptions {
  readonly attemptId?: string
  /** The attempt the DATABASE echoed. Defaults to `attemptId`. */
  readonly echoedAttemptId?: string
  readonly installed?: readonly string[]
  readonly projectRef?: string
  readonly phase?: string
  readonly schema?: string
  readonly sentinel?: Json
  /** Applied AFTER the digest is computed — i.e. tampering. */
  readonly tamper?: (doc: Json) => void
  readonly observationOverrides?: Json
}

function observation(opts: FixtureOptions = {}): string {
  const attemptId = opts.attemptId ?? ATTEMPT_A
  const ref = opts.projectRef ?? REF
  const corroboration: Json = {
    declaredEnvironment: 'staging',
    declaredProjectRef: ref,
    connection: {
      connectionHost: 'aws-0-us-east-2.pooler.supabase.com',
      poolerUser: `postgres.${ref}`,
      connectionPort: 5432,
    },
    featureFlags: { ...FLAGS_OFF },
    observation: {
      attemptId: opts.echoedAttemptId ?? attemptId,
      targetProjectRef: ref,
      measuredBy: 'operator, psql session pooler, inside a READ ONLY transaction',
      sentinelObservation: opts.sentinel ?? { ...SENTINEL_OK, projectRef: ref },
      bootstrapSchemaPresent: true,
      baselineJournal: { ...JOURNAL_OK, projectRefs: [ref] },
      packageObservations: packageObservations(opts.installed ?? []),
      ...(opts.observationOverrides ?? {}),
    },
  }
  const body = {
    schema: opts.schema ?? PRE_WRITE_OBSERVATION_SCHEMA,
    phase: opts.phase ?? 'PRE_WRITE',
    attemptId,
    observationId: `obs_${attemptId.slice(4, 12)}`,
    corroboration,
  }
  const doc: Json = { ...body, digest: observationDigest(body as never) }
  opts.tamper?.(doc)
  return JSON.stringify(doc, null, 2)
}

const ledger = (
  entries: readonly { id: string; event: 'OPENED' | 'CONSUMED'; pkg?: string }[],
): string =>
  entries
    .map((e) =>
      JSON.stringify({
        attemptId: e.id,
        event: e.event,
        targetProjectRef: REF,
        at: '2026-08-09T18:00:00.000Z',
        ...(e.pkg ? { packageId: e.pkg } : {}),
      }),
    )
    .join('\n')

const OPEN_A = ledger([{ id: ATTEMPT_A, event: 'OPENED' }])

const authorize = (raw: string | null, extra: Partial<Parameters<typeof authorizeChainWrite>[0]> = {}) =>
  authorizeChainWrite({
    raw,
    expectedAttemptId: ATTEMPT_A,
    attemptLedger: OPEN_A,
    production: KNOWN_PRODUCTION_IDENTIFIERS,
    ...extra,
  })

/* -------------------------------------------------------------------------- */
/* A. the happy path                                                          */
/* -------------------------------------------------------------------------- */

describe('A. a fresh PRE_WRITE observation authorises exactly one package', () => {
  it('authorises T1 and nothing else when the chain is PRECHAIN', () => {
    const r = authorize(observation())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.packageId).toBe(T1)
    expect(r.attemptId).toBe(ATTEMPT_A)
    expect(r.projectRef).toBe(REF)
    expect(Object.values(r.packageStates).every((s) => s === 'ABSENT')).toBe(true)
  })

  it('authorises T2 once T1 measures INSTALLED — the state is DERIVED, not declared', () => {
    const r = authorize(observation({ installed: [T1] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.packageId).toBe(T2)
    expect(r.packageStates[T1]).toBe('INSTALLED')
  })

  it('reports the sequence complete rather than inventing a tenth package', () => {
    const r = authorize(observation({ installed: CHAIN_WRITE_ORDER }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_SEQUENCE_COMPLETE')
  })
})

/* -------------------------------------------------------------------------- */
/* B–G. the envelope                                                          */
/* -------------------------------------------------------------------------- */

describe('B–G. an observation that is not this attempt is not an observation', () => {
  it('B. refuses when no observation was supplied at all', () => {
    const r = authorize(null)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_REQUIRED')
    expect(r.detail).toMatch(/absence of evidence/i)
  })

  it('C. refuses a POST-phase document on the write path', () => {
    const r = authorize(observation({ phase: 'POST_WRITE' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_PHASE_INVALID')
  })

  it('C2. refuses a document of another schema version', () => {
    const r = authorize(observation({ schema: 'uellix.hosted.chain.observation/99' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_MALFORMED')
  })

  it('D. refuses an observation of a different project', () => {
    const r = authorize(observation({ projectRef: 'cccccccccccccccccccc' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_TARGET_MISMATCH')
  })

  it('D2. refuses an observation of the production project, denylist first', () => {
    const r = authorize(observation({ projectRef: PROD }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_TARGET_MISMATCH')
  })

  it('E. refuses an observation minted for another attempt', () => {
    const r = authorize(observation({ attemptId: ATTEMPT_B }), {
      attemptLedger: ledger([
        { id: ATTEMPT_B, event: 'OPENED' },
        { id: ATTEMPT_A, event: 'OPENED' },
      ]),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_ATTEMPT_MISMATCH')
  })

  it('F. refuses when any digested field was edited after assembly', () => {
    const r = authorize(
      observation({
        tamper: (d) => {
          const c = d.corroboration as Json
          const o = c.observation as Json
          o.bootstrapSchemaPresent = false
        },
      }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_DIGEST_INVALID')
  })

  it('G. refuses a sentinel that does not corroborate the target', () => {
    const r = authorize(
      observation({ sentinel: { ...SENTINEL_OK, projectRef: 'dddddddddddddddddddd' } }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(['CHAIN_OBSERVATION_SENTINEL_INVALID', 'CHAIN_OBSERVATION_TARGET_MISMATCH']).toContain(
      r.code,
    )
  })
})

/* -------------------------------------------------------------------------- */
/* H–I. installed and partial                                                 */
/* -------------------------------------------------------------------------- */

describe('H–I. installed is not absent, and partial is neither', () => {
  it('H. refuses to re-apply a package the measurement says is INSTALLED', () => {
    const r = authorize(observation({ installed: [T1] }), { requestedPackage: T1 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_TARGET_ALREADY_INSTALLED')
    expect(r.detail).toMatch(/never re-applied/i)
  })

  it('H2. names the correct next package when the request points elsewhere', () => {
    const r = authorize(observation(), { requestedPackage: T2 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_NEXT_PACKAGE_MISMATCH')
    expect(r.detail).toContain(T1)
  })

  it('I. refuses everything when a package measures PARTIAL_OR_INCONSISTENT', () => {
    const half = packageObservations() as Json[]
    const first = half[0] as Json
    const keys = Object.keys(first.witnesses as Json)
    ;(first.witnesses as Json)[keys[0]!] = true // one positive true, the rest false
    const r = authorize(observation({ observationOverrides: { packageObservations: half } }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_PARTIAL_STATE')
    expect(r.detail).toMatch(/not absent and is not installed/i)
  })

  it('I2. refuses a gap: an ABSENT package with an INSTALLED successor', () => {
    const r = authorize(observation({ installed: [T2] }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_PREDECESSOR_STATE_INVALID')
  })
})

/* -------------------------------------------------------------------------- */
/* J–L. the RT-02 counterexample, exactly                                     */
/* -------------------------------------------------------------------------- */

describe('J–L. the committed-but-unacknowledged write', () => {
  it('J. refuses the stale PRECHAIN observation after a newer attempt is opened', () => {
    // Attempt A measured T1 ABSENT and produced a plan. The write committed and
    // the acknowledgement was lost, so no POST evidence exists. The operator
    // opens attempt B — and reaches back for A's document.
    const stale = observation({ attemptId: ATTEMPT_A })
    const r = authorizeChainWrite({
      raw: stale,
      expectedAttemptId: ATTEMPT_A,
      attemptLedger: ledger([
        { id: ATTEMPT_A, event: 'OPENED' },
        { id: ATTEMPT_A, event: 'CONSUMED', pkg: T1 },
        { id: ATTEMPT_B, event: 'OPENED' },
      ]),
      production: KNOWN_PRODUCTION_IDENTIFIERS,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_ATTEMPT_NOT_OPEN')
    expect(r.detail).toMatch(/one observation authorises one write/i)
  })

  it('J2. re-labelling the stale document with the new attempt fails the digest', () => {
    const forged = JSON.parse(observation({ attemptId: ATTEMPT_A })) as Json
    forged.attemptId = ATTEMPT_B // the exact edit the contract had to make useless
    const r = authorizeChainWrite({
      raw: JSON.stringify(forged),
      expectedAttemptId: ATTEMPT_B,
      attemptLedger: ledger([
        { id: ATTEMPT_A, event: 'OPENED' },
        { id: ATTEMPT_B, event: 'OPENED' },
      ]),
      production: KNOWN_PRODUCTION_IDENTIFIERS,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_DIGEST_INVALID')
  })

  it('J3. recomputing the digest still fails: the DATABASE echo names attempt A', () => {
    // The strongest form of the attack an honest operator could stumble into —
    // a tool that re-wraps an old probe output for a new attempt. The echo comes
    // from the server and does not move.
    const r = authorizeChainWrite({
      raw: observation({ attemptId: ATTEMPT_B, echoedAttemptId: ATTEMPT_A }),
      expectedAttemptId: ATTEMPT_B,
      attemptLedger: ledger([{ id: ATTEMPT_B, event: 'OPENED' }]),
      production: KNOWN_PRODUCTION_IDENTIFIERS,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_ATTEMPT_MISMATCH')
  })

  it('K. after the ambiguous commit, a fresh observation moves to T2 and never re-runs T1', () => {
    const r = authorizeChainWrite({
      raw: observation({ attemptId: ATTEMPT_B, installed: [T1] }),
      expectedAttemptId: ATTEMPT_B,
      attemptLedger: ledger([
        { id: ATTEMPT_A, event: 'OPENED' },
        { id: ATTEMPT_A, event: 'CONSUMED', pkg: T1 },
        { id: ATTEMPT_B, event: 'OPENED' },
      ]),
      production: KNOWN_PRODUCTION_IDENTIFIERS,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.packageId).toBe(T2)
  })

  it('L. after a rollback the package is still ABSENT, and a NEW attempt may retry it', () => {
    const r = authorizeChainWrite({
      raw: observation({ attemptId: ATTEMPT_B, installed: [] }),
      expectedAttemptId: ATTEMPT_B,
      attemptLedger: ledger([
        { id: ATTEMPT_A, event: 'OPENED' },
        { id: ATTEMPT_A, event: 'CONSUMED', pkg: T1 },
        { id: ATTEMPT_B, event: 'OPENED' },
      ]),
      production: KNOWN_PRODUCTION_IDENTIFIERS,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.packageId).toBe(T1)
  })
})

/* -------------------------------------------------------------------------- */
/* the attempt ledger                                                         */
/* -------------------------------------------------------------------------- */

describe('the attempt ledger: opening one attempt retires every earlier one', () => {
  it('reports OPEN only for the most recently opened, unconsumed attempt', () => {
    const rs = parseAttemptLedger(
      ledger([
        { id: ATTEMPT_A, event: 'OPENED' },
        { id: ATTEMPT_B, event: 'OPENED' },
      ]),
    )
    expect(attemptStatus(rs, ATTEMPT_B)).toBe('OPEN')
    expect(attemptStatus(rs, ATTEMPT_A)).toBe('CONSUMED')
    expect(attemptStatus(rs, 'att_' + 'f'.repeat(32))).toBe('UNKNOWN')
  })

  it('refuses an attempt that was never opened — the ledger is the record, not the claim', () => {
    const r = authorize(observation(), { attemptLedger: null })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_ATTEMPT_NOT_OPEN')
    expect(r.detail).toMatch(/never opened/i)
  })

  it('a corrupt line can never make an attempt OPEN', () => {
    const rs = parseAttemptLedger(`{"attemptId":"nope","event":"OPENED"}\nnot json\n`)
    expect(rs).toHaveLength(0)
    expect(attemptStatus(rs, ATTEMPT_A)).toBe('UNKNOWN')
  })

  it('names an append-only artefact that is not an evidence slot', () => {
    expect(CHAIN_ATTEMPT_LEDGER).toBe('artifacts/hosted-chain-attempts.jsonl')
    expect(CHAIN_ATTEMPT_LEDGER).not.toContain('a1')
    expect(CHAIN_ATTEMPT_LEDGER).not.toMatch(/hosted-chain-t\d/)
  })
})

/* -------------------------------------------------------------------------- */
/* M–N. dry-run isolation and the closed legacy path                          */
/* -------------------------------------------------------------------------- */

const targetInput = {
  declaredEnvironment: 'staging',
  declaredProjectRef: REF,
  connectionHost: 'aws-0-us-east-2.pooler.supabase.com',
  poolerUser: `postgres.${REF}`,
  sentinel: { environment: 'staging', projectRef: REF },
}

const runnerState = {
  baselineUnitsInstalled: [...BASELINE_ORDER],
  bootstrapSchemaPresent: true,
  sentinel: { environment: 'staging', projectRef: REF },
  stellaPackagesInstalled: Object.fromEntries(WITNESSED_PACKAGES.map((p) => [p, false])),
  businessRowCounts: null,
  storageUnitState: 'UNIT_41_COMPLETE' as const,
}

const plan = (extra: Record<string, unknown>) =>
  planProvisioningPhase({
    phase: 'PHASE_STELLA_CHAIN',
    target: targetInput,
    state: runnerState,
    featureFlags: { ...FLAGS_OFF },
    readBaselineSql,
    stellaSources: STELLA_SOURCES,
    production: KNOWN_PRODUCTION_IDENTIFIERS,
    ...extra,
  } as never)

describe('M–N. the write path requires a measurement; the dry run cannot become one', () => {
  it('M. a synthetic dry run still plans, and still permits no writes', () => {
    const p = plan({ mode: 'dry-run' })
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.writesPermitted).toBe(false)
    expect(p.steps.length).toBe(CHAIN_WRITE_ORDER.length)
  })

  it('N. apply with a state map and no observation is REFUSED — the RT-02 hole', () => {
    const p = plan({ mode: 'apply', applyConfirmation: `hosted_apply:${REF}` })
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.code).toBe('CHAIN_OBSERVATION_REQUIRED')
    expect(p.message).toMatch(/is not a measurement that it did not/i)
  })

  it('N2. apply WITH a fresh observation authorises exactly one step', () => {
    const p = plan({
      mode: 'apply',
      applyConfirmation: `hosted_apply:${REF}`,
      freshObservation: { raw: observation(), attemptId: ATTEMPT_A, attemptLedger: OPEN_A },
    })
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.writesPermitted).toBe(true)
    expect(p.steps).toHaveLength(1)
    expect(p.steps[0]!.id).toBe(T1)
    expect(p.nextAction).toMatch(/OPEN A NEW ATTEMPT/i)
  })

  it('N3. the state map is ignored on the write path: a lying map cannot skip T1', () => {
    // The caller claims everything is installed. The MEASUREMENT says otherwise,
    // and the measurement is what the plan is built from.
    const p = plan({
      mode: 'apply',
      applyConfirmation: `hosted_apply:${REF}`,
      state: {
        ...runnerState,
        stellaPackagesInstalled: Object.fromEntries(WITNESSED_PACKAGES.map((x) => [x, true])),
      },
      freshObservation: { raw: observation(), attemptId: ATTEMPT_A, attemptLedger: OPEN_A },
    })
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.steps).toHaveLength(1)
    expect(p.steps[0]!.id).toBe(T1)
  })

  it('N4. a stale observation cannot authorise an apply through the runner either', () => {
    const p = plan({
      mode: 'apply',
      applyConfirmation: `hosted_apply:${REF}`,
      freshObservation: {
        raw: observation({ attemptId: ATTEMPT_A }),
        attemptId: ATTEMPT_A,
        attemptLedger: ledger([
          { id: ATTEMPT_A, event: 'OPENED' },
          { id: ATTEMPT_B, event: 'OPENED' },
        ]),
      },
    })
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.code).toBe('CHAIN_OBSERVATION_ATTEMPT_NOT_OPEN')
  })
})

/* -------------------------------------------------------------------------- */
/* the probe, the digest, and the shape that needs no escaping                */
/* -------------------------------------------------------------------------- */

describe('the probe carries the attempt the database must echo', () => {
  it('compiles the attempt id into the SQL as a literal', () => {
    const sql = buildPreWriteObservationSql(ATTEMPT_A)
    expect(sql).toContain(`'attemptId', '${ATTEMPT_A}'`)
    expect(sql).toContain("'targetProjectRef'")
    expect(sql).toMatch(/BEGIN READ ONLY;/)
    expect(sql.trimEnd().endsWith('ROLLBACK;')).toBe(true)
  })

  it('two attempts produce two different probes', () => {
    expect(buildPreWriteObservationSql(ATTEMPT_A)).not.toBe(buildPreWriteObservationSql(ATTEMPT_B))
  })

  it('refuses to build a probe for an id that could close the literal', () => {
    for (const bad of [`att_'; DROP`, 'att_XYZ', 'attempt-1', '', 'att_' + 'a'.repeat(31)]) {
      expect(ATTEMPT_ID_SHAPE.test(bad)).toBe(false)
      expect(() => buildPreWriteObservationSql(bad)).toThrow(/32 hex characters/)
    }
  })

  it('emits no INSERT, UPDATE, DELETE or DDL', () => {
    const sql = buildPreWriteObservationSql(ATTEMPT_A)
    for (const verb of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bCREATE\s+(TABLE|ROLE|FUNCTION)\b/i, /\bALTER\s+(TABLE|ROLE)\b/i]) {
      expect(sql).not.toMatch(verb)
    }
  })
})

describe('the digest covers what it claims to cover', () => {
  it('is stable under key reordering and sensitive to every value', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }))
  })

  it('changes when the attempt, the target or a package state changes', () => {
    const d = (raw: string) => (JSON.parse(raw) as Json).digest as string
    const base = d(observation())
    expect(d(observation({ attemptId: ATTEMPT_B }))).not.toBe(base)
    expect(d(observation({ installed: [T1] }))).not.toBe(base)
    expect(d(observation({ projectRef: 'eeeeeeeeeeeeeeeeeeee' }))).not.toBe(base)
  })

  it('accepts the untampered document it was computed over', () => {
    const r = parseFreshChainObservation(observation())
    expect(r.ok).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* the second door                                                            */
/* -------------------------------------------------------------------------- */

describe('planHostedApply is the OTHER way to writesPermitted, and it is gated too', () => {
  const applyPlan = (extra: Record<string, unknown>) =>
    planHostedApply({
      target: targetInput,
      packages: [T1, T2, ...CHAIN_WRITE_ORDER.slice(2)],
      mode: 'apply',
      applyConfirmation: `hosted_apply:${REF}`,
      installedProbes: Object.fromEntries(WITNESSED_PACKAGES.map((p) => [p, false])),
      sources: STELLA_SOURCES,
      production: KNOWN_PRODUCTION_IDENTIFIERS,
      ...extra,
    } as never)

  it('refuses an apply-mode chain plan carrying no authorization', () => {
    const r = applyPlan({})
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('HOSTED_CHAIN_WRITE_UNAUTHORIZED')
    expect(r.message).toMatch(/acknowledgement was lost/i)
  })

  it('refuses an authorization for a package the plan does not contain', () => {
    // A VALID plan — T1 already installed, so the grounding unit is satisfied
    // and the earlier unit rules do not fire — carrying an authorization for a
    // package the plan does not contain.
    const r = applyPlan({
      packages: CHAIN_WRITE_ORDER.slice(1),
      installedProbes: Object.fromEntries(WITNESSED_PACKAGES.map((p) => [p, p === T1])),
      chainWriteAuthorization: { attemptId: ATTEMPT_A, packageId: T1 },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('HOSTED_CHAIN_WRITE_UNAUTHORIZED')
    expect(r.message).toMatch(/for one package/i)
  })

  it('permits the write when the authorization names a package in the plan', () => {
    const r = applyPlan({ chainWriteAuthorization: { attemptId: ATTEMPT_A, packageId: T1 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.writesPermitted).toBe(true)
    expect(r.log.join(' ')).toContain(ATTEMPT_A)
  })

  it('leaves a dry run alone: no authorization needed, no writes permitted', () => {
    const r = applyPlan({ mode: 'dry-run', applyConfirmation: undefined })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.writesPermitted).toBe(false)
  })
})

describe('nextChainPackage is the chain, not a set', () => {
  it('walks HOSTED_CHAIN order minus the bootstrap', () => {
    expect(CHAIN_WRITE_ORDER).toHaveLength(9)
    expect(CHAIN_WRITE_ORDER).not.toContain('stella_hosted_0001_managed_role_bootstrap')
    const states = Object.fromEntries(CHAIN_WRITE_ORDER.map((p) => [p, 'ABSENT' as const]))
    const r = nextChainPackage(states)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.packageId).toBe(CHAIN_WRITE_ORDER[0])
  })
})

describe('evaluateFreshChainObservation derives states rather than reading them', () => {
  it('ignores any state the document tries to declare for itself', () => {
    const r = evaluateFreshChainObservation({
      raw: observation({ observationOverrides: { packageStates: { [T1]: 'INSTALLED' } } }),
      expectedAttemptId: ATTEMPT_A,
      attemptLedger: OPEN_A,
      production: KNOWN_PRODUCTION_IDENTIFIERS,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.packageStates[T1]).toBe('ABSENT')
    expect(r.stellaPackagesInstalled[T1]).toBe(false)
  })
})
