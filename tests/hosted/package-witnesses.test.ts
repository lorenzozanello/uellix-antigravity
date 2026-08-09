// tests/hosted/package-witnesses.test.ts
//
// The five cumulative snapshots, and the states that must never collapse.
//
// The property under test is not "does each package have a witness" — it is
// "does a correctly installed predecessor STAY installed as its successors
// land, and does a half-installed package refuse to look absent". Both are
// failure modes with teeth: the first would make the runner re-apply a package
// that is already there, the second would make it apply one over its own
// partial state.

import { describe, expect, it } from 'vitest'

import {
  PACKAGE_WITNESSES,
  WITNESSED_PACKAGES,
  allWitnesses,
  classifyAllPackages,
  classifyPackage,
  toStellaPackagesInstalled,
  witnessKey,
  type ObservedWitnesses,
} from '@/db/hosted/package-witnesses'
import { HOSTED_CHAIN } from '@/db/hosted/hosted-package-manifest'

/** Everything the registry names, with `present` true only for the listed keys. */
const observe = (present: readonly string[]): ObservedWitnesses =>
  Object.fromEntries(allWitnesses().map((w) => [witnessKey(w), present.includes(witnessKey(w))]))

const positives = (pkg: string): string[] =>
  PACKAGE_WITNESSES[pkg]!.requiredPresentWhenInstalled.map(witnessKey)
const negatives = (pkg: string): string[] =>
  PACKAGE_WITNESSES[pkg]!.requiredAbsentWhenInstalled.map(witnessKey)

const T = WITNESSED_PACKAGES
const [T1, T2, T3, T4, T5, T6, T7, T8, T9] = T as [string, string, string, string, string, string, string, string, string]

/** T1..T4 installed in every T5+ snapshot: they precede the ticket chain. */
const BASE = [...positives(T1), ...positives(T2), ...positives(T3), ...positives(T4)]

const states = (present: readonly string[]): Record<string, string> => {
  const r = classifyAllPackages(observe(present))
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
  return Object.fromEntries(r.classifications.map((c) => [c.packageId, c.state]))
}

describe('the registry matches HOSTED_CHAIN exactly', () => {
  it('declares the nine packages after the bootstrap, and no others', () => {
    expect(WITNESSED_PACKAGES).toEqual(
      HOSTED_CHAIN.filter((n) => n !== 'stella_hosted_0001_managed_role_bootstrap'),
    )
    expect(Object.keys(PACKAGE_WITNESSES).sort()).toEqual([...WITNESSED_PACKAGES].sort())
  })

  it('gives every package at least one positive witness', () => {
    for (const p of WITNESSED_PACKAGES) {
      expect(PACKAGE_WITNESSES[p]!.requiredPresentWhenInstalled.length, p).toBeGreaterThan(0)
      expect(PACKAGE_WITNESSES[p]!.discriminates.length, p).toBeGreaterThan(40)
    }
  })

  it('carries a FULL SIGNATURE on every function witness — arity is the discriminator', () => {
    for (const w of allWitnesses()) {
      if (w.kind !== 'regprocedure') continue
      expect(w.identifier, `${w.identifier} must name its argument list`).toMatch(/\(.*\)$/)
    }
  })

  it('refuses a package nobody declared', () => {
    const r = classifyPackage('stella_9999_invented', observe([]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('WITNESS_PACKAGE_UNKNOWN')
  })

  it('refuses a witness that was never measured — unknown is not false', () => {
    const partialObservation = { [witnessKey(allWitnesses()[0]!)]: false }
    const r = classifyAllPackages(partialObservation)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('WITNESS_OBSERVATION_MISSING')
  })
})

describe('the five cumulative snapshots', () => {
  // At T5-current the project-blind signatures still exist: they are what
  // stella_0015 will drop. T6 must read ABSENT anyway, because absence comes
  // from ITS OWN positives being missing and never from the old ones lingering.
  const S5 = [...BASE, ...positives(T5), ...negatives(T6)]
  const S6 = [...BASE, ...positives(T5), ...positives(T6)]
  const S7 = [...S6, ...positives(T7)]
  const S8 = [...S7, ...positives(T8)]
  const S9 = [...S8, ...positives(T9)]

  it('T5 current — T5 installed, T6..T9 absent', () => {
    expect(states(S5)).toEqual({
      [T1]: 'INSTALLED', [T2]: 'INSTALLED', [T3]: 'INSTALLED', [T4]: 'INSTALLED',
      [T5]: 'INSTALLED', [T6]: 'ABSENT', [T7]: 'ABSENT', [T8]: 'ABSENT', [T9]: 'ABSENT',
    })
  })

  it('T6 current — T5 SURVIVES the drop of the signatures it created', () => {
    // The near-miss this pins: witnessing T5 by bind(2)/complete(2) would flip
    // it to ABSENT here, because stella_0015 DROPS exactly those.
    expect(states(S6)[T5]).toBe('INSTALLED')
    expect(states(S6)).toEqual({
      [T1]: 'INSTALLED', [T2]: 'INSTALLED', [T3]: 'INSTALLED', [T4]: 'INSTALLED',
      [T5]: 'INSTALLED', [T6]: 'INSTALLED', [T7]: 'ABSENT', [T8]: 'ABSENT', [T9]: 'ABSENT',
    })
  })

  it('T7 current — T6 survives having its BODIES redefined at the same signatures', () => {
    expect(states(S7)).toEqual({
      [T1]: 'INSTALLED', [T2]: 'INSTALLED', [T3]: 'INSTALLED', [T4]: 'INSTALLED',
      [T5]: 'INSTALLED', [T6]: 'INSTALLED', [T7]: 'INSTALLED', [T8]: 'ABSENT', [T9]: 'ABSENT',
    })
  })

  it('T8 current — T7 survives because stella_0017 re-creates the 5-argument settle', () => {
    expect(states(S8)[T7]).toBe('INSTALLED')
    expect(states(S8)[T8]).toBe('INSTALLED')
    expect(states(S8)[T9]).toBe('ABSENT')
  })

  it('T9 current — everything installed, and the coexisting 3-arg bind is CORRECT', () => {
    expect(states(S9)).toEqual(
      Object.fromEntries(T.map((p) => [p, 'INSTALLED'])),
    )
  })

  it('T8 is not reported installed merely because T7 is', () => {
    // settle_reserved_quota exists in both, at 5 and 10 arguments.
    expect(states(S7)[T8]).toBe('ABSENT')
  })
})

describe('partial and inconsistent states never collapse to absent', () => {
  const BASE5 = [...BASE, ...positives(T5)]

  it('one of four new signatures present is PARTIAL, not absent', () => {
    const s = states([...BASE5, positives(T6)[0]!])
    expect(s[T6]).toBe('PARTIAL_OR_INCONSISTENT')
  })

  it('all four new present but an old one still standing is INCONSISTENT', () => {
    const s = states([...BASE5, ...positives(T6), negatives(T6)[0]!])
    expect(s[T6]).toBe('PARTIAL_OR_INCONSISTENT')
  })

  it('the same coexistence in stella_0018 is INSTALLED — its source re-creates the old one', () => {
    const s = states([...BASE5, ...positives(T6), ...positives(T7), ...positives(T8), ...positives(T9)])
    expect(s[T9]).toBe('INSTALLED')
  })

  it('T8 with the 10-arg settle but no governed-identity CHECK is PARTIAL', () => {
    const s = states([...BASE5, ...positives(T6), ...positives(T7), positives(T8)[0]!, positives(T8)[1]!])
    expect(s[T8]).toBe('PARTIAL_OR_INCONSISTENT')
  })

  it('REFUSES to hand a partial state to the runner — there is no partial -> false path', () => {
    const r = classifyAllPackages(observe([...BASE5, positives(T6)[0]!]))
    expect(r.ok).toBe(true)
    if (r.ok) {
      const m = toStellaPackagesInstalled(r.classifications)
      expect(m.ok).toBe(false)
      if (!m.ok) {
        expect(m.code).toBe('WITNESS_PARTIAL_STATE')
        expect(m.detail).toContain(T6)
      }
    }
  })

  it('a clean absent state DOES convert, to nine explicit falses', () => {
    const r = classifyAllPackages(observe([]))
    expect(r.ok).toBe(true)
    if (r.ok) {
      const m = toStellaPackagesInstalled(r.classifications)
      expect(m.ok).toBe(true)
      if (m.ok) {
        expect(Object.keys(m.stellaPackagesInstalled)).toHaveLength(9)
        expect(Object.values(m.stellaPackagesInstalled).every((v) => v === false)).toBe(true)
      }
    }
  })

  it('an empty database is ABSENT, never INSTALLED — absence comes from the positives alone', () => {
    // stella_0015's required-absent witnesses are missing in a virgin database
    // too. Reading absence from them would call it installed.
    expect(states([])[T6]).toBe('ABSENT')
  })
})
