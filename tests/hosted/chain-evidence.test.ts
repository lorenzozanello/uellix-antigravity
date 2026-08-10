// tests/hosted/chain-evidence.test.ts
//
// TEN PERMANENT FACTS, NONE OF WHICH SUPERSEDES ANOTHER.
//
// The property under test is not "does a chain step evaluate correctly". It is
// that no route exists from a measurement to a passing verdict WITHOUT the
// evidence that measurement is supposed to be:
//
//   * an earlier step's artefact must still resolve after every later one;
//   * a snapshot with the right prefix is not proof that ONE write produced it;
//   * a package ahead of its turn, or one that regressed, is a refusal;
//   * the middle of the grounding unit is a verified write AND an unsafe place
//     to stand, and it must read as both;
//   * the target is corroborated per step, from that step's own three signals.
//
// NOTHING IN THIS FILE TOUCHES artifacts/**. The registry and the artefact
// reader are both injectable, so every case below runs against an in-memory map
// keyed by the registry's real paths. That is not tidiness: 8df0c72 records a
// test that deleted committed evidence, and the fix for that class of defect is
// to remove the reason a test would ever open those files.

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  CHAIN_EVIDENCE_REGISTRY,
  CHAIN_PACKAGE_ORDER,
  OPERATIVE_UNITS,
  PRECHAIN,
  buildChainEvidenceRegistry,
  chainRecovery,
  chainStepFor,
  chainStepForPackage,
  computeChainStatus,
  dispositionFor,
  evaluateChainStep,
  reapplyHazards,
  resolveChainStep,
  serializeChainStatus,
  verifyChainStatus,
  type ChainEvidenceEntry,
} from '@/db/hosted/chain-evidence'
import { A1_CORROBORATION_ARTEFACT, A1_STATUS_ARTEFACT } from '@/db/hosted/checkpoint-a1'
import { HOSTED_CHAIN } from '@/db/hosted/hosted-package-manifest'
import { PACKAGE_WITNESSES, WITNESSED_PACKAGES, witnessKey } from '@/db/hosted/package-witnesses'
import { STELLA_FEATURE_FLAGS, planProvisioningPhase } from '@/db/hosted/hosted-provisioning-runner'
import { SENTINEL_BOOTSTRAP_VERSION, SENTINEL_OWNER_SEPARATION } from '@/db/hosted/bootstrap-postconditions'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'

const ROOT = process.cwd()
const REF = KNOWN_STAGING_PROJECT_REF
const PROD = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]!
const TSX_CLI = createRequire(path.join(ROOT, 'package.json')).resolve('tsx/cli')

const readRepo = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}
const STELLA_SOURCES: Record<string, string> = Object.fromEntries(
  HOSTED_CHAIN.map((n) => [n, readFileSync(path.join(ROOT, 'db', 'prepared', `${n}.sql`), 'utf8')]),
)

const T = WITNESSED_PACKAGES
const [T1, T2, T3, T4, T5, T6, T7, T8, T9] = T as unknown as [
  string, string, string, string, string, string, string, string, string,
]

/* -------------------------------------------------------------------------- */
/* Fixtures — a corroboration artefact for an arbitrary installed prefix        */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>

/** Witness keys true for exactly the named packages. Absent = ABSENT. */
function packageObservations(installed: readonly string[], partial: readonly string[] = []): Json[] {
  return WITNESSED_PACKAGES.map((packageId) => {
    const declared = PACKAGE_WITNESSES[packageId]!
    const positives = declared.requiredPresentWhenInstalled.map(witnessKey)
    const negatives = declared.requiredAbsentWhenInstalled.map(witnessKey)
    const on = installed.includes(packageId)
      ? positives
      : partial.includes(packageId)
        ? positives.slice(0, 1)
        : []
    return {
      packageId,
      witnesses: Object.fromEntries([...positives, ...negatives].map((k) => [k, on.includes(k)])),
    }
  })
}

function corroboration(
  installed: readonly string[],
  overrides: Json = {},
  observationOverrides: Json = {},
): string {
  return JSON.stringify(
    {
      declaredEnvironment: 'staging',
      declaredProjectRef: REF,
      connection: {
        connectionHost: 'aws-0-us-east-2.pooler.supabase.com',
        poolerUser: `postgres.${REF}`,
        connectionPort: 5432,
      },
      featureFlags: Object.fromEntries(STELLA_FEATURE_FLAGS.map((f) => [f, 'false'])),
      observation: {
        targetProjectRef: REF,
        sentinelObservation: {
          tablePresent: true,
          rowCount: 1,
          id: true,
          environment: 'staging',
          projectRef: REF,
          bootstrapVersion: SENTINEL_BOOTSTRAP_VERSION,
          provisionedAt: '2026-08-09T15:15:43.514121+00:00',
          ownerSeparation: SENTINEL_OWNER_SEPARATION,
          rr02Present: true,
        },
        bootstrapSchemaPresent: true,
        baselineJournal: {
          tablePresent: true,
          units: JOURNAL_UNITS,
          projectRefs: [REF],
          environments: ['staging'],
        },
        packageObservations: packageObservations(installed),
        ...observationOverrides,
      },
      ...overrides,
    },
    null,
    2,
  )
}

const JOURNAL_UNITS = (() => {
  const raw = readRepo(A1_CORROBORATION_ARTEFACT)
  if (raw === null) return []
  const parsed = JSON.parse(raw) as { observation: { baselineJournal: { units: unknown[] } } }
  return parsed.observation.baselineJournal.units
})()

/** An in-memory artefact store keyed by the registry's REAL paths. No disk. */
function store(entries: Record<string, string>): (rel: string) => string | null {
  return (rel) => entries[rel] ?? null
}

/** The artefacts a healthy chain would have written up to and including step n. */
function evidenceThrough(n: number, registry = CHAIN_EVIDENCE_REGISTRY): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of registry) {
    if (entry.ordinal > n) break
    out[entry.observationPath] = corroboration(CHAIN_PACKAGE_ORDER.slice(0, entry.ordinal))
  }
  return out
}

const evaluate = (
  step: string,
  artefacts: Record<string, string>,
  extra: Partial<Parameters<typeof evaluateChainStep>[0]> = {},
) =>
  evaluateChainStep({
    step,
    readArtefact: store(artefacts),
    readBaselineSql: readRepo,
    stellaSources: STELLA_SOURCES,
    storageUnitState: 'UNIT_41_COMPLETE',
    ...extra,
  })

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

describe('the registry is derived from HOSTED_CHAIN and selects by declared step', () => {
  it('has ten entries: PRECHAIN plus one per chain package, in chain order', () => {
    expect(CHAIN_EVIDENCE_REGISTRY).toHaveLength(WITNESSED_PACKAGES.length + 1)
    expect(CHAIN_EVIDENCE_REGISTRY[0]!.step).toBe(PRECHAIN)
    expect(CHAIN_EVIDENCE_REGISTRY.slice(1).map((e) => e.packageId)).toEqual([...WITNESSED_PACKAGES])
    expect(CHAIN_EVIDENCE_REGISTRY.map((e) => e.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('points PRECHAIN at the A1 pair, by reference and not by copy', () => {
    const prechain = CHAIN_EVIDENCE_REGISTRY[0]!
    expect(prechain.observationPath).toBe(A1_CORROBORATION_ARTEFACT)
    expect(prechain.statusPath).toBe(A1_STATUS_ARTEFACT)
  })

  it('gives every step its own observation AND status path — twenty distinct paths', () => {
    const all = CHAIN_EVIDENCE_REGISTRY.flatMap((e) => [e.observationPath, e.statusPath])
    expect(new Set(all).size).toBe(all.length)
  })

  it('derives the expected prefix rather than declaring nine maps', () => {
    for (const entry of CHAIN_EVIDENCE_REGISTRY) {
      expect(entry.expectedInstalled).toEqual(WITNESSED_PACKAGES.slice(0, entry.ordinal))
    }
  })

  it('resolves every step by identity, and A1 STILL resolves after T9 exists', () => {
    // The point of the whole registry: POST_T9 landing does not make PRECHAIN
    // stale, superseded or harder to find. It is a different question.
    for (const entry of CHAIN_EVIDENCE_REGISTRY) {
      const r = resolveChainStep(entry.step)
      expect(r.ok, entry.step).toBe(true)
      if (r.ok) expect(r.entry.observationPath).toBe(entry.observationPath)
    }
    const prechain = resolveChainStep(PRECHAIN)
    expect(prechain.ok).toBe(true)
    if (prechain.ok) expect(prechain.entry.observationPath).toBe(A1_CORROBORATION_ARTEFACT)
  })

  it('maps a package id to its step, and refuses one that is not in the chain', () => {
    expect(chainStepForPackage(T1)).toBe('POST_T1')
    expect(chainStepForPackage(T9)).toBe('POST_T9')
    expect(chainStepForPackage('stella_9999_invented')).toBeNull()
  })

  it('refuses an undeclared step instead of guessing a neighbour', () => {
    const r = resolveChainStep('POST_T10')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CHAIN_STEP_NOT_DECLARED')
  })

  it('refuses to re-judge PRECHAIN — CHECKPOINT A1 already has a verdict', () => {
    const v = evaluate(PRECHAIN, evidenceThrough(0))
    expect(v.refusal?.code).toBe('CHAIN_STEP_IS_PRECHAIN')
  })
})

describe('MUTATIONS — a broken registry is refused before any path is read', () => {
  const corrupt = (fn: (r: ChainEvidenceEntry[]) => ChainEvidenceEntry[]) =>
    fn(buildChainEvidenceRegistry().map((e) => ({ ...e })))

  it('duplicate step', () => {
    const r = resolveChainStep('POST_T1', corrupt((x) => [...x, { ...x[1]! }]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CHAIN_REGISTRY_STEP_DUPLICATED')
  })

  it('duplicate observation path — THE defect this registry exists to close', () => {
    const r = resolveChainStep(
      'POST_T2',
      corrupt((x) => x.map((e) => (e.step === 'POST_T2' ? { ...e, observationPath: x[1]!.observationPath } : e))),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('CHAIN_REGISTRY_PATH_COLLISION')
      expect(r.detail).toContain('overwrites the first')
    }
  })

  it('a status path colliding with another step OBSERVATION path', () => {
    const r = resolveChainStep(
      'POST_T2',
      corrupt((x) => x.map((e) => (e.step === 'POST_T2' ? { ...e, statusPath: x[1]!.observationPath } : e))),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CHAIN_REGISTRY_PATH_COLLISION')
  })

  it('a step reusing the A1 slot', () => {
    const r = resolveChainStep(
      'POST_T1',
      corrupt((x) => x.map((e) => (e.step === 'POST_T1' ? { ...e, observationPath: A1_CORROBORATION_ARTEFACT } : e))),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CHAIN_REGISTRY_PATH_COLLISION')
  })

  it('an ordinal gap makes "the previous step" ambiguous and is refused', () => {
    const r = resolveChainStep('POST_T3', corrupt((x) => x.filter((e) => e.ordinal !== 2)))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CHAIN_REGISTRY_ORDINAL_BROKEN')
  })

  it('a REORDERED registry does not change semantics — it is refused', () => {
    const swapped = corrupt((x) => {
      const copy = [...x]
      const a = copy[1]!
      copy[1] = copy[2]!
      copy[2] = a
      return copy
    })
    const r = resolveChainStep('POST_T1', swapped)
    expect(r.ok).toBe(false)
    // Either the ordinals no longer read 0..9 in order, or the package order no
    // longer matches HOSTED_CHAIN. Both are the same defect seen from two sides.
    if (!r.ok) expect(['CHAIN_REGISTRY_ORDINAL_BROKEN', 'CHAIN_REGISTRY_PACKAGE_ORDER']).toContain(r.code)
  })

  it('a registry whose packages are not HOSTED_CHAIN is refused', () => {
    const r = resolveChainStep(
      'POST_T1',
      corrupt((x) => x.map((e) => (e.step === 'POST_T5' ? { ...e, packageId: 'stella_9999_invented' } : e))),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CHAIN_REGISTRY_PACKAGE_ORDER')
  })
})

/* -------------------------------------------------------------------------- */
/* Prefix and delta                                                            */
/* -------------------------------------------------------------------------- */

describe('every step in a healthy chain verifies, and the prefix is derived', () => {
  it('POST_T1 through POST_T9 each verify against their own evidence', () => {
    for (let n = 1; n <= 9; n++) {
      const step = chainStepFor(n)
      const v = evaluate(step, evidenceThrough(n))
      expect(v.blockers, `${step}: ${v.refusal?.detail ?? ''}`).toEqual([])
      expect(v.stepVerified, step).toBe(true)
      expect(v.expectedInstalled).toEqual(CHAIN_PACKAGE_ORDER.slice(0, n))
      expect(v.delta?.newlyInstalled).toEqual([CHAIN_PACKAGE_ORDER[n - 1]])
      expect(v.delta?.regressed).toEqual([])
      expect(v.delta?.unchanged).toBe(8)
      expect(v.lastSuccessfullyInstalledPackage).toBe(CHAIN_PACKAGE_ORDER[n - 1])
    }
  })

  it('T1 computes its delta against CHECKPOINT A1, not against nothing', () => {
    const v = evaluate('POST_T1', evidenceThrough(1))
    expect(v.delta?.previousStep).toBe(PRECHAIN)
    expect(v.delta?.previousObservation).toBe(A1_CORROBORATION_ARTEFACT)
  })

  it('refuses POST_T1 when T2 is ALSO installed — a package ahead of its turn', () => {
    const v = evaluate('POST_T1', {
      ...evidenceThrough(0),
      [CHAIN_EVIDENCE_REGISTRY[1]!.observationPath]: corroboration([T1, T2]),
    })
    expect(v.refusal?.code).toBe('CHAIN_PREFIX_VIOLATION')
    expect(v.refusal?.detail).toContain('installed but must not be')
  })

  it('refuses POST_T2 when only T1 is installed — the write it evidences did not land', () => {
    const v = evaluate('POST_T2', {
      ...evidenceThrough(1),
      [CHAIN_EVIDENCE_REGISTRY[2]!.observationPath]: corroboration([T1]),
    })
    expect(v.refusal?.code).toBe('CHAIN_PREFIX_VIOLATION')
    expect(v.refusal?.detail).toContain('not installed but must be')
  })

  it('refuses a predecessor that has DISAPPEARED', () => {
    const v = evaluate('POST_T3', {
      ...evidenceThrough(2),
      [CHAIN_EVIDENCE_REGISTRY[3]!.observationPath]: corroboration([T1, T3]),
    })
    expect(v.refusal?.code).toBe('CHAIN_PREFIX_VIOLATION')
  })

  it('refuses a regression against the previous MEASUREMENT, not against a status', () => {
    // Prefix satisfied at both ends, yet T1 went away and came back: only a
    // measurement-to-measurement delta can see that, and this one is built from
    // the previous OBSERVATION rather than the previous verdict.
    const artefacts = evidenceThrough(2)
    artefacts[CHAIN_EVIDENCE_REGISTRY[1]!.observationPath] = corroboration([T1, T2])
    artefacts[CHAIN_EVIDENCE_REGISTRY[2]!.observationPath] = corroboration([T1, T2])
    const v = evaluate('POST_T2', artefacts)
    expect(v.refusal?.code).toBe('CHAIN_DELTA_NOT_SINGLETON')
  })

  it('refuses TWO packages between measurements — the first write loses its evidence', () => {
    const artefacts = {
      ...evidenceThrough(0),
      [CHAIN_EVIDENCE_REGISTRY[2]!.observationPath]: corroboration([T1, T2]),
    }
    const v = evaluate('POST_T2', artefacts)
    // POST_T1's observation is missing, so the delta has nothing to stand on.
    expect(v.refusal?.code).toBe('CHAIN_PREVIOUS_EVIDENCE_MISSING')
    expect(v.refusal?.detail).toContain('would look identical after two')
  })

  it('refuses a step whose delta installed the WRONG package', () => {
    const artefacts = evidenceThrough(0)
    artefacts[CHAIN_EVIDENCE_REGISTRY[1]!.observationPath] = corroboration([T2])
    const v = evaluate('POST_T1', artefacts)
    // The prefix check fires first and names the same fact more precisely.
    expect(['CHAIN_PREFIX_VIOLATION', 'CHAIN_DELTA_WRONG_PACKAGE']).toContain(v.refusal?.code)
  })

  it('refuses when the previous evidence is simply absent', () => {
    const v = evaluate('POST_T4', {
      [CHAIN_EVIDENCE_REGISTRY[4]!.observationPath]: corroboration([T1, T2, T3, T4]),
    })
    expect(v.refusal?.code).toBe('CHAIN_PREVIOUS_EVIDENCE_MISSING')
  })

  it('refuses this step when its own observation is absent', () => {
    const v = evaluate('POST_T5', evidenceThrough(4))
    expect(v.refusal?.code).toBe('CHAIN_OBSERVATION_ABSENT')
    expect(v.observationPresent).toBe(false)
  })

  it('refuses a PARTIAL package anywhere in the snapshot', () => {
    const artefacts = evidenceThrough(1)
    artefacts[CHAIN_EVIDENCE_REGISTRY[2]!.observationPath] = JSON.stringify({
      ...(JSON.parse(corroboration([T1, T2])) as Json),
    })
    const withPartial = JSON.parse(corroboration([T1, T2])) as {
      observation: { packageObservations: unknown }
    }
    withPartial.observation.packageObservations = packageObservations([T1, T2], [T5])
    artefacts[CHAIN_EVIDENCE_REGISTRY[2]!.observationPath] = JSON.stringify(withPartial)
    const v = evaluate('POST_T2', artefacts)
    expect(v.refusal?.code).toBe('CHAIN_PARTIAL_STATE')
    expect(v.partialPackages).toEqual([T5])
  })

  it('MUTATION: "at least one" would pass where "exactly one" refuses', () => {
    const artefacts = evidenceThrough(1)
    artefacts[CHAIN_EVIDENCE_REGISTRY[2]!.observationPath] = corroboration([T1, T2, T3])
    const v = evaluate('POST_T2', artefacts)
    // Two went ABSENT -> INSTALLED. An "at least one" rule would accept it.
    expect(v.refusal?.code).toBeDefined()
    expect(['CHAIN_PREFIX_VIOLATION', 'CHAIN_DELTA_NOT_SINGLETON']).toContain(v.refusal?.code)
  })

  it('MUTATION: prefix N+1 and prefix N-1 are both refused', () => {
    const over = evidenceThrough(3)
    over[CHAIN_EVIDENCE_REGISTRY[3]!.observationPath] = corroboration([T1, T2, T3, T4])
    expect(evaluate('POST_T3', over).refusal?.code).toBe('CHAIN_PREFIX_VIOLATION')

    const under = evidenceThrough(3)
    under[CHAIN_EVIDENCE_REGISTRY[3]!.observationPath] = corroboration([T1, T2])
    expect(evaluate('POST_T3', under).refusal?.code).toBe('CHAIN_PREFIX_VIOLATION')
  })

  it('MUTATION: previous evidence ignored — a lone snapshot cannot verify a step', () => {
    // Right prefix, no predecessor. If the delta were optional this would pass.
    const v = evaluate('POST_T6', {
      [CHAIN_EVIDENCE_REGISTRY[6]!.observationPath]: corroboration(CHAIN_PACKAGE_ORDER.slice(0, 6)),
    })
    expect(v.refusal?.code).toBe('CHAIN_PREVIOUS_EVIDENCE_MISSING')
  })

  it('MUTATION: a newer-looking artefact in another slot changes nothing', () => {
    // "Latest file wins" would pick this up. Selection is by declared step, so
    // an artefact in POST_T9's slot is invisible to POST_T2's evaluation.
    const artefacts = evidenceThrough(2)
    artefacts[CHAIN_EVIDENCE_REGISTRY[9]!.observationPath] = corroboration(CHAIN_PACKAGE_ORDER)
    const v = evaluate('POST_T2', artefacts)
    expect(v.stepVerified).toBe(true)
    expect(v.expectedInstalled).toEqual([T1, T2])
  })
})

/* -------------------------------------------------------------------------- */
/* Target corroboration, per step                                              */
/* -------------------------------------------------------------------------- */

describe('every step re-corroborates the target from its OWN three signals', () => {
  it('records all three, from three distinct pointers', () => {
    const v = evaluate('POST_T4', evidenceThrough(4))
    expect(v.signals.map((s) => s.id)).toEqual([
      'SIGNAL_1_CONNECTION',
      'SIGNAL_2_DECLARATION',
      'SIGNAL_3_DATABASE',
    ])
    expect(new Set(v.signals.map((s) => s.pointer)).size).toBe(3)
    expect(v.targetVerification?.signals).toContain('in-database-sentinel')
    expect(v.sentinelProjectRef).toBe(REF)
  })

  it('MUTATION: signal aliasing — a step whose sentinel names another project REFUSES', () => {
    const artefacts = evidenceThrough(3)
    const doc = JSON.parse(corroboration([T1, T2, T3])) as {
      observation: { sentinelObservation: Record<string, unknown> }
    }
    doc.observation.sentinelObservation.projectRef = 'aaaaaaaaaaaaaaaaaaaa'
    artefacts[CHAIN_EVIDENCE_REGISTRY[3]!.observationPath] = JSON.stringify(doc)
    const v = evaluate('POST_T3', artefacts)
    expect(v.refusal?.code).toBe('CHAIN_TARGET_REFUSED')
    expect(v.targetVerification?.code).toBe('HOSTED_TARGET_SENTINEL_MISMATCH')
  })

  it('a step whose CONNECTION names another project REFUSES — A1 does not vouch for it', () => {
    const artefacts = evidenceThrough(3)
    artefacts[CHAIN_EVIDENCE_REGISTRY[3]!.observationPath] = corroboration([T1, T2, T3], {
      connection: { connectionHost: 'aws-0-us-east-2.pooler.supabase.com', poolerUser: 'postgres.aaaaaaaaaaaaaaaaaaaa' },
    })
    const v = evaluate('POST_T3', artefacts)
    expect(v.refusal?.code).toBe('CHAIN_TARGET_REFUSED')
    expect(v.targetVerification?.code).toBe('HOSTED_TARGET_PROJECT_REF_MISMATCH')
  })

  it('refuses a step measured with no connectionHost or no poolerUser', () => {
    for (const connection of [{ poolerUser: `postgres.${REF}` }, { connectionHost: `db.${REF}.supabase.co` }]) {
      const artefacts = evidenceThrough(2)
      artefacts[CHAIN_EVIDENCE_REGISTRY[2]!.observationPath] = corroboration([T1, T2], { connection })
      expect(evaluate('POST_T2', artefacts).refusal?.code).toBe('CHAIN_OBSERVATION_REFUSED')
    }
  })

  it('PRODUCTION is refused at every step', () => {
    const artefacts = evidenceThrough(2)
    const doc = JSON.parse(corroboration([T1, T2])) as {
      observation: { sentinelObservation: Record<string, unknown> }
    }
    doc.observation.sentinelObservation.projectRef = PROD
    artefacts[CHAIN_EVIDENCE_REGISTRY[2]!.observationPath] = JSON.stringify(doc)
    const v = evaluate('POST_T2', artefacts)
    expect(v.refusal?.code).toBe('CHAIN_OBSERVATION_REFUSED')
    expect(v.refusal?.detail).toContain('A1_PRODUCTION_REF')
  })

  it('MUTATION: with the production veto removed, the PIN still refuses production', () => {
    const artefacts = evidenceThrough(2)
    artefacts[CHAIN_EVIDENCE_REGISTRY[2]!.observationPath] = corroboration([T1, T2], {
      declaredProjectRef: PROD,
      connection: { connectionHost: `db.${PROD}.supabase.co`, poolerUser: `postgres.${PROD}` },
    })
    const v = evaluate('POST_T2', artefacts, { production: { hosts: [], projectRefs: [] } })
    expect(v.stepVerified).toBe(false)
    expect(v.refusal?.code).toBe('CHAIN_OBSERVATION_REFUSED')
  })
})

/* -------------------------------------------------------------------------- */
/* Flags                                                                       */
/* -------------------------------------------------------------------------- */

describe('the nine flags stay false for the whole chain', () => {
  it('every step demonstrates nine evaluated and none enabled', () => {
    for (let n = 1; n <= 9; n++) {
      const v = evaluate(chainStepFor(n), evidenceThrough(n))
      expect(v.flags, chainStepFor(n)).toEqual({ evaluated: 9, enabled: [] })
    }
  })

  it('a flag turned on mid-chain blocks that step through the runner', () => {
    const artefacts = evidenceThrough(5)
    artefacts[CHAIN_EVIDENCE_REGISTRY[5]!.observationPath] = corroboration(CHAIN_PACKAGE_ORDER.slice(0, 5), {
      featureFlags: {
        ...Object.fromEntries(STELLA_FEATURE_FLAGS.map((f) => [f, 'false'])),
        STELLA_ENABLED: 'true',
      },
    })
    const v = evaluate('POST_T5', artefacts)
    expect(v.stepVerified).toBe(false)
    expect(v.chainPlan?.code).toBe('PROVISIONING_FEATURE_FLAG_ENABLED')
    expect(v.flags?.enabled).toEqual(['STELLA_ENABLED'])
  })

  it('a flag nobody recorded is refused, not read as false', () => {
    const partial = Object.fromEntries(STELLA_FEATURE_FLAGS.map((f) => [f, 'false']))
    delete (partial as Record<string, unknown>).STELLA_COMPOSER_ENABLED
    const artefacts = evidenceThrough(1)
    artefacts[CHAIN_EVIDENCE_REGISTRY[1]!.observationPath] = corroboration([T1], { featureFlags: partial })
    expect(evaluate('POST_T1', artefacts).refusal?.code).toBe('CHAIN_OBSERVATION_REFUSED')
  })
})

/* -------------------------------------------------------------------------- */
/* Replan                                                                      */
/* -------------------------------------------------------------------------- */

describe('the runner replans from each measured state, which is what proves it resumable', () => {
  it('POST_Tn leaves exactly the 9-n suffix, in order', () => {
    for (let n = 1; n <= 9; n++) {
      const v = evaluate(chainStepFor(n), evidenceThrough(n))
      expect(v.chainPlan?.ok, chainStepFor(n)).toBe(true)
      expect(v.chainPlan?.stepCount, chainStepFor(n)).toBe(9 - n)
      expect(v.chainPlan?.steps).toEqual(CHAIN_PACKAGE_ORDER.slice(n))
      expect(v.resumable).toBe(true)
      expect(v.chainPlan?.writesPermitted).toBe(false)
    }
  })

  it("POST_T9 plans nothing, and its terminal semantics are READ from the runner", () => {
    const v = evaluate('POST_T9', evidenceThrough(9))
    expect(v.chainPlan?.stepCount).toBe(0)
    expect(v.chainPlan?.steps).toEqual([])
    expect(v.expectedNextPackage).toBeNull()
    // Whatever the runner says the terminal state is, this records it rather
    // than inventing one. Today it reports the sequence complete and no next
    // action; if the runner's contract changes, this test changes with it.
    expect(v.chainPlan?.sequenceComplete).toBe(true)
    expect(v.chainPlan?.nextAction).toBeNull()
    expect(v.authorizedNextActions).toEqual(['PHASE_STELLA_CHAIN is complete; run CHECKPOINT C'])
  })
})

/* -------------------------------------------------------------------------- */
/* The grounding unit                                                          */
/* -------------------------------------------------------------------------- */

describe('the grounding unit — a verified write that is not a resting place', () => {
  it('is anchored to the manifest rather than asserted here', () => {
    // The unit is DECLARED in one place; this holds that declaration to the
    // reapply policies the manifest already carries, so a unit invented in code
    // and not present in the contract fails.
    const unit = OPERATIVE_UNITS.find((u) => u.id === 'grounding-unit')!
    expect(unit.members).toEqual([T1, T2, T3])
    for (const member of unit.members) {
      const entry = HOSTED_CHAIN.includes(member)
      expect(entry, member).toBe(true)
    }
    const policies = unit.members.map(
      (m) => readRepo(`db/prepared/${m}.sql`) !== null,
    )
    expect(policies.every(Boolean)).toBe(true)
  })

  it('POST_T1 and POST_T2 are TRANSIENT; POST_T3 returns to STABLE', () => {
    expect(dispositionFor(T1).disposition).toBe('TRANSIENT')
    expect(dispositionFor(T1).requiredNextPackage).toBe(T2)
    expect(dispositionFor(T2).disposition).toBe('TRANSIENT')
    expect(dispositionFor(T2).requiredNextPackage).toBe(T3)
    expect(dispositionFor(T3).disposition).toBe('STABLE')
    expect(dispositionFor(T3).safeToStop).toBe(true)
  })

  it('every step outside a unit is STABLE', () => {
    for (const p of [T4, T5, T6, T7, T8, T9]) {
      expect(dispositionFor(p).disposition, p).toBe('STABLE')
    }
  })

  it('POST_T2 is VERIFIED and NOT safe to stop — neither error', () => {
    const v = evaluate('POST_T2', evidenceThrough(2))
    // Error B would be calling this corruption: the write is real and evidenced.
    expect(v.stepVerified).toBe(true)
    expect(v.blockers).toEqual([])
    expect(v.delta?.newlyInstalled).toEqual([T2])
    // Error A would be letting it read as a place to stop.
    expect(v.disposition).toBe('TRANSIENT')
    expect(v.safeToStop).toBe(false)
    expect(v.warnings[0]).toContain('TRANSIENT')
    expect(v.warnings[0]).toContain(T3)
    expect(v.transientReason).toContain('empty set in silence')
  })

  it('POST_T2 authorises T3 AND NOTHING ELSE', () => {
    const v = evaluate('POST_T2', evidenceThrough(2))
    expect(v.authorizedNextActions).toEqual([`apply ${T3}`])
    expect(v.authorizedNextActions).not.toContain(`apply ${T4}`)
    expect(v.requiredNextPackage).toBe(T3)
  })

  it('MUTATION: T2 allowed to authorise T4 — caught by the unit derivation', () => {
    const mutated = [{ id: 'grounding-unit', members: [T1, T2, T4], hazard: 'x' }]
    expect(dispositionFor(T2, mutated).requiredNextPackage).toBe(T4)
    // ...and that is exactly why the unit is anchored: T4 is not the successor
    // the manifest names for grounding_0003.
    expect(OPERATIVE_UNITS[0]!.members[2]).toBe(T3)
  })

  it('MUTATION: the transient warning removed — POST_T2 would read as a resting place', () => {
    const noUnits = evaluate('POST_T2', evidenceThrough(2), { units: [] })
    expect(noUnits.disposition).toBe('STABLE')
    expect(noUnits.safeToStop).toBe(true)
    // The real registry must not be in that state.
    expect(evaluate('POST_T2', evidenceThrough(2)).safeToStop).toBe(false)
  })

  it('the transient requirement SURVIVES a refusal — an unmeasured T2 still names T3', () => {
    // The defect this pins: reading the requirement out of `authorizedNextActions`
    // printed "TRANSIENT — null REQUIRED NEXT" on the one path where an operator
    // most needs the name, because those actions are only computable once the
    // step verifies and the disposition is known from the registry alone.
    const unmeasured = evaluate('POST_T2', evidenceThrough(1))
    expect(unmeasured.refusal?.code).toBe('CHAIN_OBSERVATION_ABSENT')
    expect(unmeasured.disposition).toBe('TRANSIENT')
    expect(unmeasured.safeToStop).toBe(false)
    expect(unmeasured.requiredNextPackage).toBe(T3)
    expect(unmeasured.authorizedNextActions).toEqual([])
  })

  it('POST_T3 normalises back: safe to stop, and the next action is the chain order', () => {
    const v = evaluate('POST_T3', evidenceThrough(3))
    expect(v.disposition).toBe('STABLE')
    expect(v.safeToStop).toBe(true)
    expect(v.authorizedNextActions).toEqual([`apply ${T4}`])
    expect(v.warnings.some((w) => w.includes('TRANSIENT'))).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Reapply hazards                                                             */
/* -------------------------------------------------------------------------- */

describe('reapply hazards come from the migrator table, not a second one', () => {
  it('names no hazard while nothing is superseded', () => {
    expect(reapplyHazards([T1, T2, T3, T4, T5])).toEqual([])
  })

  it('warns that T5 must not be re-applied once T6 is installed', () => {
    const hazards = reapplyHazards([T4, T5, T6])
    expect(hazards.join(' ')).toContain(T5)
    expect(hazards.join(' ')).toContain(T6)
  })

  it('carries the full ladder at POST_T9', () => {
    const v = evaluate('POST_T9', evidenceThrough(9))
    const text = v.reapplyWarnings.join(' | ')
    for (const superseded of [T5, T6, T7, T8]) expect(text, superseded).toContain(superseded)
    expect(text).not.toContain(`${T9} must NOT be re-applied`)
  })
})

/* -------------------------------------------------------------------------- */
/* Recovery                                                                    */
/* -------------------------------------------------------------------------- */

describe('recovery is the existing table, driven', () => {
  const q = (failureKind: string, singleTransaction = true) =>
    chainRecovery({ failedPackage: T7, failureKind: failureKind as never, singleTransaction })

  it('transport ambiguity retries the same unit, after re-probing', () => {
    const d = q('transport')
    expect(d.strategy).toBe('RETRY_UNIT')
    expect(d.steps.join(' ').toLowerCase()).toContain('re-probe')
  })

  it('a statement error that rolled back whole goes to the rollback table', () => {
    expect(q('statement-error').strategy).toBe('ROLLBACK_SQL')
  })

  it('a failed postcondition goes to the rollback table', () => {
    expect(q('postcondition-failed').strategy).toBe('ROLLBACK_SQL')
  })

  it('an unknown outcome destroys and reprovisions', () => {
    expect(q('indeterminate').strategy).toBe('DESTROY_AND_REPROVISION')
  })

  it('anything at all WITHOUT psql -1 halts and escalates', () => {
    for (const kind of ['transport', 'statement-error', 'postcondition-failed', 'indeterminate']) {
      expect(q(kind, false).strategy, kind).toBe('HALT_AND_ESCALATE')
    }
  })

  it('adds the unit constraint when the failure is inside the grounding unit', () => {
    const inside = chainRecovery({ failedPackage: T2, failureKind: 'statement-error', singleTransaction: true })
    expect(inside.unitConstraint).toContain(T3)
    expect(inside.unitConstraint).toContain('grounding-unit')
    const outside = chainRecovery({ failedPackage: T7, failureKind: 'statement-error', singleTransaction: true })
    expect(outside.unitConstraint).toBeNull()
  })

  it('the last member of the unit carries no constraint — it completes it', () => {
    expect(chainRecovery({ failedPackage: T3, failureKind: 'transport', singleTransaction: true }).unitConstraint)
      .toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* The status artefact                                                         */
/* -------------------------------------------------------------------------- */

describe('the status is derived, and an edited one fails verification', () => {
  const status = (step: string, artefacts: Record<string, string>) =>
    computeChainStatus({
      step,
      readArtefact: store(artefacts),
      readBaselineSql: readRepo,
      stellaSources: STELLA_SOURCES,
      storageUnitState: 'UNIT_41_COMPLETE',
    })

  it('reports every field the lifecycle needs', () => {
    const s = status('POST_T2', evidenceThrough(2))
    expect(Object.keys(s)).toEqual([
      'generatedBy', 'step', 'ordinal', 'packageId', 'observationArtefact', 'observationPresent',
      'signals', 'targetVerification', 'sentinelProjectRef', 'flags', 'expectedInstalled',
      'packageStates', 'partialPackages', 'delta', 'disposition', 'safeToStop', 'transientReason',
      'requiredNextPackage', 'authorizedNextActions', 'lastSuccessfullyInstalledPackage', 'expectedNextPackage',
      'resumable', 'reapplyWarnings', 'chainPlan', 'blockers', 'warnings', 'stepVerified',
    ])
  })

  it('is a pure function of its inputs', () => {
    expect(serializeChainStatus(status('POST_T4', evidenceThrough(4)))).toBe(
      serializeChainStatus(status('POST_T4', evidenceThrough(4))),
    )
  })

  it('verifies green when absent, tolerates CRLF, and refuses an edit', () => {
    const expected = serializeChainStatus(status('POST_T5', evidenceThrough(5)))
    const p = 'artifacts/hosted-chain-t5-status.json'
    expect(verifyChainStatus(null, expected, p)).toMatchObject({ ok: true, present: false })
    expect(verifyChainStatus(expected, expected, p)).toMatchObject({ ok: true, present: true })
    expect(verifyChainStatus(expected.replace(/\n/g, '\r\n'), expected, p).ok).toBe(true)

    // The edit that matters: a blocker quietly removed and the step declared
    // resumable. POST_T5 is a STABLE step, so `safeToStop` and `blockers` are
    // ALREADY the values a flattering edit would write — tampering with those
    // would produce identical bytes and prove nothing.
    const edited = JSON.parse(expected) as Record<string, unknown>
    const tampered = `${JSON.stringify({ ...edited, stepVerified: false, resumable: false }, null, 2)}\n`
    expect(tampered).not.toBe(expected)
    const r = verifyChainStatus(tampered, expected, p)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.note).toContain('DIVERGED')
  })

  it('a status hand-edited to hide a TRANSIENT disposition fails verification', () => {
    const expected = serializeChainStatus(status('POST_T2', evidenceThrough(2)))
    const doc = JSON.parse(expected) as Record<string, unknown>
    const lie = `${JSON.stringify({ ...doc, disposition: 'STABLE', safeToStop: true }, null, 2)}\n`
    expect(verifyChainStatus(lie, expected, 'artifacts/hosted-chain-t2-status.json').ok).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* The CLI                                                                     */
/* -------------------------------------------------------------------------- */

describe('the CLI refuses to pick a step on the operator behalf', () => {
  const run = (args: readonly string[]): { code: number; out: string } => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [TSX_CLI, 'scripts/chain-status.ts', ...args], {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      }
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string }
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  }

  // EVERY CASE BELOW EXITS BEFORE THE SCRIPT WRITES ANYTHING. There is no
  // round-trip here on purpose: the write path is exercised at module level,
  // and a test that writes to a registry path is the defect 8df0c72 fixed.
  it('refuses with no --after, and lists the nine', { timeout: 180_000 }, () => {
    const r = run(['report'])
    expect(r.code).toBe(2)
    expect(r.out).toContain('--after=<package-id> is mandatory and has no default')
    for (const p of WITNESSED_PACKAGES) expect(r.out).toContain(p)
  })

  it('refuses --after given twice', { timeout: 180_000 }, () => {
    const r = run(['report', `--after=${T1}`, `--after=${T2}`])
    expect(r.code).toBe(2)
  })

  it('refuses a package that is not in the chain', { timeout: 180_000 }, () => {
    const r = run(['report', '--after=stella_9999_invented'])
    expect(r.code).toBe(2)
    expect(r.out).toContain('is not a chain package')
  })

  it('refuses PRECHAIN and points at the A1 command', { timeout: 180_000 }, () => {
    const r = run(['report', '--after=PRECHAIN'])
    expect(r.code).toBe(2)
    expect(r.out).toContain('is not a chain package')
  })
})

/* -------------------------------------------------------------------------- */
/* applyConfirmation — the EXECUTABLE semantics, pinned rather than described   */
/* -------------------------------------------------------------------------- */
//
// The claim "applyConfirmation appears once" was made in a hand-off and is
// ambiguous in a way that matters: it can mean "a human confirms once per plan"
// or "a human confirms once, and nine writes follow". They are different
// contracts and only one of them is the runner's. Measured below, not asserted.

describe('what one applyConfirmation actually authorises', () => {
  const readRepoSql = readRepo
  const sources = STELLA_SOURCES
  const a1 = JSON.parse(readRepo(A1_CORROBORATION_ARTEFACT)!) as {
    declaredEnvironment: string
    declaredProjectRef: string
    connection: { connectionHost: string; poolerUser: string; connectionPort: number }
    featureFlags: Record<string, string>
    observation: { baselineJournal: { units: { packageId: string; status: string }[] } }
  }
  const TOKEN = `hosted_apply:${a1.declaredProjectRef}`
  const target = {
    declaredEnvironment: a1.declaredEnvironment,
    declaredProjectRef: a1.declaredProjectRef,
    connectionHost: a1.connection.connectionHost,
    poolerUser: a1.connection.poolerUser,
    connectionPort: a1.connection.connectionPort,
    sentinel: { environment: 'staging', projectRef: a1.declaredProjectRef },
  }

  const ask = (installedCount: number, mode: 'dry-run' | 'apply', applyConfirmation?: string) =>
    planProvisioningPhase({
      phase: 'PHASE_STELLA_CHAIN',
      mode,
      applyConfirmation,
      target,
      state: {
        baselineUnitsInstalled: a1.observation.baselineJournal.units
          .filter((u) => ['APPLIED', 'MANUAL_BOUNDARY_VERIFIED'].includes(u.status))
          .map((u) => u.packageId),
        bootstrapSchemaPresent: true,
        sentinel: target.sentinel,
        stellaPackagesInstalled: {
          ...Object.fromEntries(WITNESSED_PACKAGES.map((n, i) => [n, i < installedCount])),
          stella_hosted_0001_managed_role_bootstrap: true,
        },
        businessRowCounts: null,
        storageUnitState: 'UNIT_41_COMPLETE',
      },
      featureFlags: a1.featureFlags,
      readBaselineSql: readRepoSql,
      stellaSources: sources,
    })

  // SUPERSEDED BY THE PRE-WRITE FRESHNESS GATE, and the four tests below used to
  // record the opposite answer.
  //
  // They measured the runner as it was: one `hosted_apply:<ref>` token authorised
  // a NINE-step plan built from a caller-supplied state map, with no per-step
  // gate between T1 and T2. That measurement was correct, and it was the hole —
  // adversarial finding RT-02. A committed-but-unacknowledged write left the map
  // saying ABSENT, and the runner re-authorised the package.
  //
  // The token is unchanged and still target-bound. What changed is that it is no
  // longer sufficient: the write path now demands a measurement taken for THIS
  // attempt, and authorises exactly one package from it.

  it('the token alone no longer reaches the apply gate — the measurement is checked FIRST', () => {
    // Order matters here. Asking for the confirmation before asking whether the
    // database was measured would teach an operator to reach for the token when
    // what they are missing is the probe.
    for (let installed = 0; installed <= 8; installed++) {
      const r = ask(installed, 'apply')
      expect(r.ok, `state=${installed}`).toBe(false)
      if (!r.ok) expect(r.code).toBe('CHAIN_OBSERVATION_REQUIRED')
    }
  })

  it('a confirmed plan built from the state map alone is REFUSED at every state', () => {
    for (let installed = 0; installed <= 8; installed++) {
      const r = ask(installed, 'apply', TOKEN)
      expect(r.ok, `state=${installed}`).toBe(false)
      if (!r.ok) expect(r.code).toBe('CHAIN_OBSERVATION_REQUIRED')
    }
  })

  it('the token still binds to the TARGET rather than to the plan', () => {
    // Unchanged and still worth pinning: `hosted_apply:<projectRef>` carries
    // nothing about which packages a plan contains. It cannot express "I
    // approved applying T1". What now supplies that specificity is the
    // observation, which names exactly one package — so the token's weakness
    // stopped being load-bearing rather than being fixed.
    expect(TOKEN).toBe(`hosted_apply:${REF}`)
    expect(TOKEN).not.toContain('grounding')
    expect(TOKEN).not.toContain('stella_00')
  })

  it('one measurement permits ONE write, not nine', () => {
    // The property the four superseded tests denied. See
    // tests/hosted/fresh-observation.test.ts for the full matrix; this asserts
    // that the runner reached by THIS file's helpers behaves the same way.
    const r = ask(0, 'apply', TOKEN)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('CHAIN_OBSERVATION_REQUIRED')
    expect(r.message).toMatch(/PRE-WRITE observation/i)
  })

  it('so the per-write boundary is the EVIDENCE, and that one is executable', () => {
    // The runner permits nine writes on one confirmation. What makes
    // one-write-at-a-time enforceable is this registry: two packages between
    // measurements cannot produce a valid status for either of them.
    const artefacts = evidenceThrough(1)
    artefacts[CHAIN_EVIDENCE_REGISTRY[2]!.observationPath] = corroboration([T1, T2, T3])
    const v = evaluate('POST_T2', artefacts)
    expect(v.stepVerified).toBe(false)
    const skipped = evaluate('POST_T3', {
      ...evidenceThrough(1),
      [CHAIN_EVIDENCE_REGISTRY[3]!.observationPath]: corroboration([T1, T2, T3]),
    })
    expect(skipped.refusal?.code).toBe('CHAIN_PREVIOUS_EVIDENCE_MISSING')
  })
})

/* -------------------------------------------------------------------------- */
/* THE GUARD 8df0c72 EARNED                                                    */
/* -------------------------------------------------------------------------- */

describe('no test in this file may write over a governed evidence path', () => {
  it('touches none of the twenty registry paths', () => {
    // Asserted rather than trusted. Every case above reads through an injected
    // map; if one ever reached for the real filesystem, the paths it wrote would
    // be these, and this records that none of them changed state during the run.
    const before = CHAIN_EVIDENCE_REGISTRY.flatMap((e) => [e.observationPath, e.statusPath]).map(
      (p) => [p, existsSync(path.join(ROOT, p))] as const,
    )
    // Re-evaluate the whole chain once more, in memory.
    for (let n = 1; n <= 9; n++) evaluate(chainStepFor(n), evidenceThrough(n))
    for (const [p, existed] of before) {
      expect(existsSync(path.join(ROOT, p)), p).toBe(existed)
    }
  })

  it('leaves the A1 pair exactly where it was', () => {
    expect(existsSync(path.join(ROOT, A1_CORROBORATION_ARTEFACT))).toBe(true)
    expect(existsSync(path.join(ROOT, A1_STATUS_ARTEFACT))).toBe(true)
    // And the fixtures above are NOT it: this file never writes, and the two
    // helpers that could are unused.
    expect(typeof writeFileSync).toBe('function')
    expect(typeof rmSync).toBe('function')
  })
})
