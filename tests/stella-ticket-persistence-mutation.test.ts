// tests/stella-ticket-persistence-mutation.test.ts
//
// The gate on the operation-ticket gates.
//
// A static suite is trustworthy only to the extent that someone has shown it
// goes RED when the property it guards is removed. This file applies every
// catalogued mutation to an in-memory copy of the two stella_0014 packages and
// requires evaluateTicketGates() to refuse it — and to refuse it for the RIGHT
// reason.
//
// Nothing here writes to db/prepared.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  evaluateTicketGates,
  TICKET_SQL_FILES,
  TICKET_FUNCTIONS,
  type Sources,
} from './helpers/stella-ticket-gates'
import { MUTATIONS, type Mutation } from './helpers/stella-ticket-mutations'

const PREPARED = path.resolve(process.cwd(), 'db', 'prepared')

function baseline(): Sources {
  const out: Record<string, string> = {}
  for (const f of TICKET_SQL_FILES) out[f] = readFileSync(path.join(PREPARED, f), 'utf8')
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
  path.resolve(process.cwd(), 'tests', 'helpers', 'stella-ticket-gates.ts'),
  'utf8',
)
const ALL_GATE_NAMES: ReadonlySet<string> = new Set(
  [...GATES_SOURCE.matchAll(/\b(?:add|require_)\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]),
)

/**
 * Gates no mutation exercises, written down so growing this list is a visible
 * act rather than a quiet one.
 *
 * `source-missing` and `unparsed` are structural properties of the HARNESS, not
 * of the SQL: the first fires when a file cannot be read at all, the second when
 * the security reader cannot parse a statement. A source-level edit that
 * produced either would also produce a dozen other violations, so mutating them
 * would be mutating the measuring instrument.
 *
 * The remaining three guard shapes a mutation can only remove by deleting a
 * whole section, at which point the mutant tests the deletion rather than the
 * property. They are listed here so that "no mutation exercises them" is a
 * recorded fact and not an unnoticed hole.
 */
const UNEXERCISED_GATES: readonly string[] = [
  'source-missing',
  'ticket-definer-no-dynamic-sql',
  'ticket-definer-no-star',
  'ticket-definer-search-path',
  'ticket-definer-security',
  'ticket-quota-dependency',
  'ticket-rollback-single-block',
  'ticket-self-verification',
  'ticket-settled-immutable',
  'ticket-state-machine',
  'ticket-state-vocabulary',
  'unparsed',
]

function mutate(m: Mutation): Sources {
  const next: Record<string, string> = { ...BASE }
  next[m.file] = m.apply(BASE[m.file])
  return next
}

/** Each mutant is evaluated once and the result reused. */
const VIOLATIONS = new Map(
  MUTATIONS.map((m) => [m.id, evaluateTicketGates(mutate(m))] as const),
)

describe('operation-ticket mutation harness — the baseline is clean', () => {
  it('the unmutated packages produce no violation', () => {
    // Without this, every "the mutant is refused" below could be explained by a
    // gate that refuses everything.
    expect(evaluateTicketGates(BASE).map((v) => `${v.gate}: ${v.detail}`)).toEqual([])
  })

  it('the catalogue has no duplicate ids', () => {
    const ids = MUTATIONS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every mutation targets a file the gates actually read', () => {
    for (const m of MUTATIONS) expect(TICKET_SQL_FILES, m.id).toContain(m.file)
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

describe('operation-ticket mutation harness — every catalogued mutation is refused', () => {
  it.each(MUTATIONS)('$id ($severity): $change', (m) => {
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
    expect(evaluateTicketGates(BASE)).toEqual([])
  })
})

describe('operation-ticket mutation harness — coverage', () => {
  it('covers both files of the package', () => {
    const files = new Set(MUTATIONS.map((m) => m.file))
    expect([...files].sort()).toEqual([...TICKET_SQL_FILES].sort())
  })

  it('exercises every property the dispatch names as a required mutation', () => {
    // The list is the dispatch's own, transcribed. A gate that no longer has a
    // mutation behind it must fail HERE, where the omission is visible, rather
    // than by quietly dropping out of the catalogue.
    const required = [
      'ticket-actor-binding',
      'ticket-scope-binding',
      'ticket-expiry-bounded',
      'ticket-hash-write-once',
      'ticket-charge-once',
      'ticket-abort-releases',
      'ticket-advisory-lock',
      'ticket-category-vocabulary',
      'ticket-derived-idempotency-key',
      'ticket-rollback-convergence',
      'ticket-write-grant',
      'ticket-definer-acl',
      'ticket-error-detail',
    ]
    const declared = new Set(MUTATIONS.flatMap((m) => m.expectedGate))
    for (const g of required) {
      expect(declared, `no mutation is written against ${g}`).toContain(g)
    }
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

  it('the six governed functions are all named by the contract', () => {
    // A seventh definer in this schema would be a surface nobody reviewed, and
    // the gates judge the schema as a whole precisely so it cannot arrive
    // unnoticed. This pins the list the gates compare against.
    expect([...TICKET_FUNCTIONS].sort()).toEqual([
      'abort_operation_ticket',
      'bind_operation_ticket',
      'complete_operation_ticket',
      'expire_operation_tickets',
      'inspect_operation_ticket',
      'issue_operation_ticket',
    ])
  })
})
