// tests/train4-persistence-mutation.test.ts
//
// The gate on the Train 4 gates.
//
// A static suite is trustworthy only to the extent that someone has shown it
// goes RED when the property it guards is removed. This file applies every
// catalogued mutation to an in-memory copy of the four Train 4 packages and
// requires evaluateTrain4Gates() to refuse it — and to refuse it for the RIGHT
// reason.
//
// Nothing here writes to db/prepared.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  evaluateTrain4Gates,
  TRAIN4_SQL_FILES,
  type Sources,
} from './helpers/train4-gates'
import { MUTATIONS, type Mutation } from './helpers/train4-mutations'

const PREPARED = path.resolve(process.cwd(), 'db', 'prepared')

function baseline(): Sources {
  const out: Record<string, string> = {}
  for (const f of TRAIN4_SQL_FILES) out[f] = readFileSync(path.join(PREPARED, f), 'utf8')
  return out
}

const BASE = baseline()

/**
 * Every gate name the evaluator can emit, read out of its own source.
 *
 * Derived rather than listed: a hardcoded list cannot see the name that is not
 * on it, and a gate added without a mutation is exactly what this file exists
 * to make visible.
 */
const GATES_SOURCE = readFileSync(
  path.resolve(process.cwd(), 'tests', 'helpers', 'train4-gates.ts'),
  'utf8',
)
const ALL_GATE_NAMES: ReadonlySet<string> = new Set(
  [...GATES_SOURCE.matchAll(/\b(?:add|require_)\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]),
)

/**
 * Gates no mutation exercises, written down so growing this list is a visible
 * act rather than a quiet one.
 *
 * `source-missing` is a structural property of the harness, not of the SQL: it
 * fires when a file cannot be read at all, and a source-level edit to the
 * packages cannot produce it without also producing a dozen other violations.
 * Mutating it would be mutating the measuring instrument.
 */
const UNEXERCISED_GATES: readonly string[] = ['source-missing']

function mutate(m: Mutation): Sources {
  const next: Record<string, string> = { ...BASE }
  next[m.file] = m.apply(BASE[m.file])
  return next
}

/** Each mutant is evaluated once and the result reused. */
const VIOLATIONS = new Map(
  MUTATIONS.map((m) => [m.id, evaluateTrain4Gates(mutate(m))] as const),
)

describe('train 4 mutation harness — the baseline is clean', () => {
  it('the unmutated packages produce no violation', () => {
    // Without this, every "the mutant is refused" below could be explained by a
    // gate that refuses everything.
    expect(evaluateTrain4Gates(BASE).map((v) => `${v.gate}: ${v.detail}`)).toEqual([])
  })

  it('the catalogue has no duplicate ids', () => {
    const ids = MUTATIONS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every mutation targets a file the gates actually read', () => {
    for (const m of MUTATIONS) expect(TRAIN4_SQL_FILES, m.id).toContain(m.file)
  })

  it('no two mutations share a description or a rationale', () => {
    // Distinct properties must not be collapsed under one generic label.
    expect(new Set(MUTATIONS.map((m) => m.change)).size).toBe(MUTATIONS.length)
    expect(new Set(MUTATIONS.map((m) => m.breaks)).size).toBe(MUTATIONS.length)
  })

  it('every mutation says what it breaks, at length', () => {
    // A finding without a mechanism is a coincidence.
    for (const m of MUTATIONS) {
      expect(m.breaks.length, `${m.id} does not say what it breaks`).toBeGreaterThan(60)
    }
  })
})

describe('train 4 mutation harness — every catalogued mutation is refused', () => {
  it.each(MUTATIONS)('$id ($severity, $contract): $change', (m) => {
    const mutated = mutate(m)

    // Rule 1: the edit landed.
    expect(mutated[m.file], `${m.id} is a no-op — its anchor matched nothing`).not.toBe(BASE[m.file])

    // Rule 2: a named gate refuses it.
    const violations = VIOLATIONS.get(m.id)!
    expect(violations.length, `${m.id} SURVIVES. It breaks: ${m.breaks}`).toBeGreaterThan(0)

    // Rule 3: the RIGHT gate refuses it. Without this the suite proves only
    // that SOMETHING objected — a much weaker claim than it reads as, because a
    // bystander gate keeps firing on the day the real one is weakened.
    const fired = new Set(violations.map((v) => v.gate))
    expect(
      m.expectedGate.some((g) => fired.has(g)),
      `${m.id} was refused by [${[...fired].join(', ')}], but the property it tests belongs to [${m.expectedGate.join(', ')}]`,
    ).toBe(true)
  })

  it('restores the baseline between mutations — no test leaks into the next', () => {
    expect(baseline()).toEqual(BASE)
    expect(evaluateTrain4Gates(BASE)).toEqual([])
  })
})

describe('train 4 mutation harness — coverage', () => {
  it('covers every contract this train closes, and every file', () => {
    const contracts = new Set(MUTATIONS.map((m) => m.contract))
    for (const c of ['INT-CAP-001', 'INT-CAP-002', 'INT-CAP-003', 'INT-CAP-004', 'INT-GR-004']) {
      expect(contracts, `no mutation exercises ${c}`).toContain(c)
    }
    const files = new Set(MUTATIONS.map((m) => m.file))
    expect([...files].sort()).toEqual([...TRAIN4_SQL_FILES].sort())
  })

  it('every mutation names the gate that must refuse it', () => {
    for (const m of MUTATIONS) {
      expect(m.expectedGate.length, `${m.id} names no gate`).toBeGreaterThan(0)
      for (const g of m.expectedGate) {
        expect(g, `${m.id}`).toMatch(/^[a-z0-9-]+$/)
        expect(ALL_GATE_NAMES, `${m.id} declares gate ${g}, which no add()/require_() emits`).toContain(g)
      }
    }
  })

  it('names every gate that no mutation exercises, so the list cannot grow quietly', () => {
    // "0 of N mutations survive" says nothing about the gates no mutation
    // touches. A gate that has never gone red is indistinguishable from a gate
    // that cannot. This does not demand a mutation per gate — it demands that
    // the unexercised set be WRITTEN DOWN.
    const exercised = new Set(MUTATIONS.flatMap((m) => VIOLATIONS.get(m.id)!.map((v) => v.gate)))
    const unexercised = [...ALL_GATE_NAMES].filter((g) => !exercised.has(g)).sort()
    expect(unexercised).toEqual([...UNEXERCISED_GATES].sort())
  })

  it('the derived gate inventory can see every gate that actually fires', () => {
    // ALL_GATE_NAMES is derived by matching a single-quoted literal in the
    // gates' SOURCE. Its blind spot is a gate whose name is computed at run
    // time: absent from the inventory AND from the unexercised list, i.e.
    // invisible to the one check meant to make a missing gate visible. This
    // closes the loop from the other end.
    const fired = new Set(MUTATIONS.flatMap((m) => VIOLATIONS.get(m.id)!.map((v) => v.gate)))
    const invisible = [...fired].filter((g) => !ALL_GATE_NAMES.has(g)).sort()
    expect(
      invisible,
      'these gates fire but are not written as a literal, so the coverage check cannot see them',
    ).toEqual([])
  })

  it('every gate name in the gates source is a single-quoted literal', () => {
    // Makes the derivation SOUND rather than merely careful: a name in double
    // quotes, outside [a-z0-9-], or built at run time would be invisible above.
    const calls = [...GATES_SOURCE.matchAll(/\b(?:add|require_)\(/g)].length
    const literal = [...GATES_SOURCE.matchAll(/\b(?:add|require_)\(\s*'[a-z0-9-]+'/g)].length
    // ONE forwarder is allowed and named exactly: `require_(gate, ok, detail)`
    // calls `add(gate, detail)`, so its argument is always a literal one frame
    // up. Pinned by count so a second, unnamed forwarder cannot appear quietly.
    const forwarders = [...GATES_SOURCE.matchAll(/\badd\(gate, detail\)/g)].length
    expect(forwarders, 'more than the one documented forwarder').toBe(1)
    expect(
      literal + forwarders,
      `${calls - literal - forwarders} add()/require_() call(s) do not take a single-quoted lowercase gate name`,
    ).toBe(calls)
    // add() is the only producer. A direct push bypasses it.
    expect([...GATES_SOURCE.matchAll(/\bv\.push\(/g)].length, 'a violation is produced without add()').toBe(1)
    // And no phantom: a commented-out add('x' would enter the inventory and
    // then have to be excused on the unexercised list.
    for (const line of GATES_SOURCE.split('\n')) {
      const trimmed = line.trimStart()
      if (!trimmed.startsWith('//') && !trimmed.startsWith('*')) continue
      expect(trimmed, 'a comment contains an add() call, which becomes a phantom gate').not.toMatch(
        /\b(?:add|require_)\(\s*'[a-z0-9-]+'/,
      )
    }
  })

  it('no single DECLARED gate accounts for more than half the kills', () => {
    // Counting the DECLARED gate rather than every gate that fired measures the
    // catalogue's spread over PROPERTIES instead of over symptoms, and it is
    // the stricter of the two.
    const byGate = new Map<string, number>()
    for (const m of MUTATIONS) {
      for (const g of new Set(m.expectedGate)) byGate.set(g, (byGate.get(g) ?? 0) + 1)
    }
    const worst = Math.max(...byGate.values())
    expect(
      worst,
      `declared-gate distribution: ${JSON.stringify(Object.fromEntries(byGate))}`,
    ).toBeLessThan(Math.ceil(MUTATIONS.length / 2))
  })
})
