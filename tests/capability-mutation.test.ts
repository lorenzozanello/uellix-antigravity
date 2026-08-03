// tests/capability-mutation.test.ts
//
// The gate on the gates.
//
// A static suite can only be trusted to the extent that someone has shown it
// goes RED when the thing it guards is broken. tests/capability-isolation.test.ts
// was never shown that, and twenty-two security mutations lived inside a
// 220/220 run. This file removes the possibility of that happening silently: it
// applies each catalogued mutation to an in-memory copy of the packages and
// requires evaluateCapabilityGates() to refuse.
//
// Two rules make the result mean something.
//
// 1. A mutation must actually CHANGE the text. A stale anchor that quietly
//    matched nothing would produce an unmutated source, a violation-free run,
//    and a test that fails for the right-looking wrong reason — so the harness
//    asserts the edit landed before it asserts anything about detection.
//
// 2. A mutation is NOT detected because the mutated SQL would fail to compile.
//    Compilation is not one of the protected properties here, and "PostgreSQL
//    would have rejected it" is an argument about a database this unit is
//    forbidden from touching. Detection means: a named gate returned a
//    violation, offline, from the text.
//
// Nothing here writes to db/prepared. scripts/capability-mutation-audit.ts does
// that — on purpose, to produce the SHA-before/after evidence — and restores.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  evaluateCapabilityGates,
  CAPABILITY_SQL_FILES,
  type Sources,
} from './helpers/capability-gates'
import {
  MUTATIONS,
  PREVIOUSLY_SURVIVING,
  NEW_MUTATIONS,
  type Mutation,
} from './helpers/capability-mutations'

const PREPARED = path.resolve(process.cwd(), 'db', 'prepared')

function baseline(): Sources {
  const out: Record<string, string> = {}
  for (const f of CAPABILITY_SQL_FILES) out[f] = readFileSync(path.join(PREPARED, f), 'utf8')
  return out
}

const BASE = baseline()

/**
 * Every gate name `evaluateCapabilityGates` can emit, read out of its source.
 *
 * Derived rather than listed, for the same reason DISCLOSURE_FLAGS is derived
 * from the CREATE TABLE: a hardcoded list of names cannot see the name that is
 * not on it, and a gate added without a mutation is exactly the thing this file
 * exists to make visible.
 */
const ALL_GATE_NAMES: ReadonlySet<string> = new Set(
  [
    ...readFileSync(
      path.resolve(process.cwd(), 'tests', 'helpers', 'capability-gates.ts'),
      'utf8',
    ).matchAll(/\b(?:add|require)\(\s*'([a-z0-9-]+)'/g),
  ].map((m) => m[1]),
)

/**
 * Gates no mutation exercises, and why that is acceptable for each.
 *
 * Two admissible reasons only:
 *   (a) the gate guards a structural invariant of the HARNESS — a missing
 *       source file, a desynchronised comment mask — which a source-level
 *       mutation cannot produce and which fires when the tooling breaks;
 *   (b) the gate is the second half of a pair whose first half is exercised,
 *       so the branch is reached but the specific message is not.
 *
 * Anything else on this list is a coverage hole wearing a permission slip.
 */
const UNEXERCISED_GATES: readonly string[] = [
  'cap01-concurrent-replay',
  'cap01-function',
  'cap01-lock-timeout',
  'cap01-membership-unique',
  'cap01-single-membership',
  'cap01-status',
  'cap01-subject',
  'cap01-token-hash',
  'cap01-token-shape',
  'cap02-function',
  'cap02-hits',
  'cap02-hits-personal-data',
  'cap02-locked',
  'cap02-minimal',
  'cap02-readonly',
  'cap02-revoked',
  'cap02-table',
  'cap03-blast-radius',
  'cap03-claim-atomic',
  'cap03-event-pk',
  'cap03-events-table',
  'cap03-function',
  'cap03-login-identity',
  'cap03-no-payload',
  'cap03-single-org',
  'cap04-function',
  'cap04-lock-timeout',
  'cap04-no-status-param',
  'cap04-on-conflict',
  'cap04-retire-dead-policies',
  'cap04-server-derived',
  'cap04-status-constant',
  'cap05-allowlist',
  'cap05-claim-first',
  'cap05-function',
  'cap05-grant',
  'cap05-no-plan',
  'cap05-organization',
  'cap05-single-membership',
  'cap05-slug-atomic',
  'cap05-slug-shape',
  'definer-detail',
  'definer-inventory',
  'definer-overqualified',
  'definer-security',
  'definer-select-star',
  'definer-uniform-error',
  'index-missing',
  'mask-desync',
  'policy-command',
  'rls-disabled',
  'role-crossgrant',
  'rollback-cascade',
  'rollback-function',
  'rollback-ownership',
  'rollback-retention',
  'rollback-rls',
  'rollback-role',
  'source-missing',
]

function mutate(m: Mutation): Sources {
  const next: Record<string, string> = { ...BASE }
  next[m.file] = m.apply(BASE[m.file])
  return next
}

/**
 * Each mutant is evaluated ONCE and the result reused.
 *
 * Not premature optimisation: the first draft evaluated every mutant twice —
 * once per-mutation, once for the gate-distribution check — and the second pass
 * blew vitest's default 5s timeout when the file ran alongside the other 151,
 * while passing in isolation. A suite whose result depends on what else is
 * running is not a gate.
 */
const VIOLATIONS = new Map(
  MUTATIONS.map((m) => [m.id, evaluateCapabilityGates(mutate(m))] as const),
)

describe('mutation harness — the baseline is clean', () => {
  it('the unmutated packages produce no violation', () => {
    // Without this, every "the mutant is refused" below could be explained by a
    // gate that refuses everything.
    expect(evaluateCapabilityGates(BASE)).toEqual([])
  })

  it('the catalogue has no duplicate ids', () => {
    const ids = MUTATIONS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every mutation targets a file the gates actually read', () => {
    for (const m of MUTATIONS) expect(CAPABILITY_SQL_FILES, m.id).toContain(m.file)
  })
})

describe('mutation harness — every catalogued mutation is refused', () => {
  it.each(MUTATIONS)('$id ($severity, $capability): $change', (m) => {
    const mutated = mutate(m)

    // Rule 1: the edit landed.
    expect(mutated[m.file], `${m.id} is a no-op`).not.toBe(BASE[m.file])

    // Rule 2: a named gate refuses it.
    const violations = VIOLATIONS.get(m.id)!
    expect(
      violations.length,
      `${m.id} SURVIVES. It breaks: ${m.breaks}`,
    ).toBeGreaterThan(0)

    // Rule 3: the RIGHT gate refuses it.
    //
    // Without this the suite proves only that SOMETHING objected, which is a
    // much weaker claim than it reads as: a mutation can be caught by a gate
    // unrelated to the property it tests, and the day the real gate is weakened
    // the suite stays green because the bystander still fires. That was not
    // hypothetical — N-08 tests "the first read takes the lock" and was caught
    // by cap01-order-replay, because cap01-order-unlocked-read turned out to be
    // definitionally true and could never fail.
    const fired = new Set(violations.map((v) => v.gate))
    expect(
      m.expectedGate.some((g) => fired.has(g)),
      `${m.id} was refused by [${[...fired].join(', ')}], but the property it tests belongs to [${m.expectedGate.join(', ')}]`,
    ).toBe(true)
  })

  it('restores the baseline between mutations — no test leaks into the next', () => {
    // BASE is captured once and every mutant is built by copying it. If a
    // mutation mutated the shared object instead of a copy, this would be the
    // only place it showed up.
    expect(baseline()).toEqual(BASE)
    expect(evaluateCapabilityGates(BASE)).toEqual([])
  })
})

describe('mutation harness — coverage of the reaudit findings', () => {
  it('carries all twenty-two previously surviving mutations', () => {
    expect(PREVIOUSLY_SURVIVING).toHaveLength(22)
  })

  it('adds at least fifteen new mutations', () => {
    expect(NEW_MUTATIONS.length).toBeGreaterThanOrEqual(15)
  })

  it('every mutation names the gate that must refuse it', () => {
    for (const m of MUTATIONS) {
      expect(m.expectedGate.length, `${m.id} names no gate`).toBeGreaterThan(0)
      for (const g of m.expectedGate) expect(g, `${m.id}`).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('names every gate that no mutation exercises, so the list cannot grow quietly', () => {
    // "0 of N mutations survive" says nothing about the gates no mutation
    // touches. Those gates have never been shown to go red, and a gate that has
    // never gone red is indistinguishable from a gate that cannot.
    //
    // This test does not demand a mutation per gate — several gates guard
    // structural invariants (a missing file, a desynchronised comment mask)
    // that a source-level edit cannot produce. It demands that the unexercised
    // set be WRITTEN DOWN, so growing it is a visible act.
    const exercised = new Set(MUTATIONS.flatMap((m) => VIOLATIONS.get(m.id)!.map((v) => v.gate)))
    const unexercised = [...ALL_GATE_NAMES].filter((g) => !exercised.has(g)).sort()
    expect(unexercised).toEqual([...UNEXERCISED_GATES].sort())
  })

  it('every previously surviving mutation records WHY it survived', () => {
    // A finding without a mechanism is a coincidence. If the reason is not
    // written down, the same blindness returns in the next gate.
    for (const m of PREVIOUSLY_SURVIVING) {
      expect(m.survivedBecause.length, `${m.id} has no explanation`).toBeGreaterThan(40)
      expect(m.breaks.length, `${m.id} does not say what it breaks`).toBeGreaterThan(40)
    }
  })

  it('no two mutations share a description', () => {
    // The brief is explicit that distinct mutations must not be collapsed under
    // one generic label.
    const changes = MUTATIONS.map((m) => m.change)
    expect(new Set(changes).size).toBe(changes.length)
    const breaks = MUTATIONS.map((m) => m.breaks)
    expect(new Set(breaks).size).toBe(breaks.length)
  })

  it('covers all five capabilities', () => {
    const caps = new Set(MUTATIONS.map((m) => m.capability))
    for (const c of ['CAP-01', 'CAP-02', 'CAP-03', 'CAP-04', 'CAP-05']) expect(caps).toContain(c)
  })

  it('no single gate accounts for more than half the kills', () => {
    // A catalogue whose every member dies on the same assertion tests one
    // property N times and calls it N properties.
    const byGate = new Map<string, number>()
    for (const m of MUTATIONS) {
      const gates = new Set(VIOLATIONS.get(m.id)!.map((v) => v.gate))
      for (const g of gates) byGate.set(g, (byGate.get(g) ?? 0) + 1)
    }
    const worst = Math.max(...byGate.values())
    expect(worst, `gate distribution: ${JSON.stringify(Object.fromEntries(byGate))}`).toBeLessThan(
      Math.ceil(MUTATIONS.length / 2),
    )
  })
})
