// tests/stella-project-ticket-mutation.test.ts
//
// The gate on the project-binding gates.
//
// A static suite is trustworthy only to the extent that someone has shown it
// goes RED when the property it guards is removed. This file applies every
// catalogued mutation to an in-memory copy of the two stella_0015 packages and
// requires evaluateProjectTicketGates() to refuse it — and to refuse it for the
// RIGHT reason.
//
// Nothing here writes to db/prepared.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  evaluateProjectTicketGates,
  PROJECT_TICKET_SQL_FILES,
  PROJECT_BOUND_FUNCTIONS,
  PROJECT_ARGUMENT,
  PROJECT_MISMATCH_SQLSTATE,
  PRE_EXISTING_SQLSTATES,
  type Sources,
} from './helpers/stella-project-ticket-gates'
import { PROJECT_MUTATIONS, type Mutation } from './helpers/stella-project-ticket-mutations'
import { MUTATIONS as TICKET_MUTATIONS } from './helpers/stella-ticket-mutations'

const PREPARED = path.resolve(process.cwd(), 'db', 'prepared')

function baseline(): Sources {
  const out: Record<string, string> = {}
  for (const f of PROJECT_TICKET_SQL_FILES) out[f] = readFileSync(path.join(PREPARED, f), 'utf8')
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
  path.resolve(process.cwd(), 'tests', 'helpers', 'stella-project-ticket-gates.ts'),
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
 * of the SQL. The rest guard shapes a mutation can only remove by deleting a
 * whole section — at which point the mutant tests the deletion rather than the
 * property — or restate a stella_0014 invariant this package inherits and does
 * not own. They are listed here so that "no mutation exercises them" is a
 * recorded fact and not an unnoticed hole.
 */
const UNEXERCISED_GATES: readonly string[] = [
  'source-missing',
  'ticket-project-actor-binding',
  // The ACL gates read the signature through a lazy `[\s\S]*?`, so they hold
  // whatever the argument list becomes — which is what makes them a check on
  // the GRANT and not a second, accidental check on the arguments. No mutation
  // can separate them from ticket-project-argument.
  'ticket-project-definer-acl',
  'ticket-project-definer-no-dynamic-sql',
  'ticket-project-definer-no-star',
  'ticket-project-definer-owner',
  'ticket-project-definer-search-path',
  'ticket-project-definer-security',
  'ticket-project-dependency',
  'ticket-project-error-detail',
  'ticket-project-inventory',
  'ticket-project-no-idempotency-argument',
  'ticket-project-rollback-no-cascade',
  'ticket-project-rollback-scope',
  'ticket-project-rollback-single-block',
  'ticket-project-self-verification',
  'unparsed',
]

function mutate(m: Mutation): Sources {
  const next: Record<string, string> = { ...BASE }
  next[m.file] = m.apply(BASE[m.file])
  return next
}

/** Each mutant is evaluated once and the result reused. */
const VIOLATIONS = new Map(
  PROJECT_MUTATIONS.map((m) => [m.id, evaluateProjectTicketGates(mutate(m))] as const),
)

describe('project-binding mutation harness — the baseline is clean', () => {
  it('the unmutated packages produce no violation', () => {
    // Without this, every "the mutant is refused" below could be explained by a
    // gate that refuses everything.
    expect(evaluateProjectTicketGates(BASE).map((v) => `${v.gate}: ${v.detail}`)).toEqual([])
  })

  it('the catalogue has no duplicate ids', () => {
    const ids = PROJECT_MUTATIONS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the ids do not collide with the stella_0014 catalogue', () => {
    // Two catalogues judging two packages, one numbering. Without this, "K-17"
    // would mean different things depending on which file a reader opened.
    const theirs = new Set(TICKET_MUTATIONS.map((m) => m.id))
    for (const m of PROJECT_MUTATIONS) {
      expect(theirs, `${m.id} is already used by the stella_0014 catalogue`).not.toContain(m.id)
    }
  })

  it('every mutation targets a file the gates actually read', () => {
    for (const m of PROJECT_MUTATIONS) expect(PROJECT_TICKET_SQL_FILES, m.id).toContain(m.file)
  })

  it('no two mutations share a description or a rationale', () => {
    expect(new Set(PROJECT_MUTATIONS.map((m) => m.change)).size).toBe(PROJECT_MUTATIONS.length)
    expect(new Set(PROJECT_MUTATIONS.map((m) => m.breaks)).size).toBe(PROJECT_MUTATIONS.length)
  })

  it('every mutation says what it breaks, at length', () => {
    // A finding without a mechanism is a coincidence.
    for (const m of PROJECT_MUTATIONS) {
      expect(m.breaks.length, `${m.id} does not say what it breaks`).toBeGreaterThan(60)
    }
  })
})

describe('project-binding mutation harness — every catalogued mutation is refused', () => {
  it.each(PROJECT_MUTATIONS)('$id ($severity): $change', (m) => {
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
    expect(evaluateProjectTicketGates(BASE)).toEqual([])
  })
})

describe('project-binding mutation harness — coverage', () => {
  it('covers both files of the package', () => {
    const files = new Set(PROJECT_MUTATIONS.map((m) => m.file))
    expect([...files].sort()).toEqual([...PROJECT_TICKET_SQL_FILES].sort())
  })

  it('exercises every property the dispatch names as a required mutation', () => {
    // The list is the dispatch's own, transcribed. A gate that no longer has a
    // mutation behind it must fail HERE, where the omission is visible, rather
    // than by quietly dropping out of the catalogue.
    const required = [
      'ticket-project-argument',
      'ticket-project-comparison',
      'ticket-project-no-default',
      'ticket-project-legacy-dropped',
      'ticket-project-legacy-revoked',
      'ticket-project-error-code',
      'ticket-project-charge-attribution',
      'ticket-project-check-order',
      'ticket-project-rollback-safe',
      'ticket-project-rollback-convergence',
    ]
    const declared = new Set(PROJECT_MUTATIONS.flatMap((m) => m.expectedGate))
    for (const g of required) {
      expect(declared, `no mutation is written against ${g}`).toContain(g)
    }
  })

  it('the four verbs of FASE 2 each have an argument mutation of their own', () => {
    // The dispatch names bind, complete, abort and inspect by name. A catalogue
    // that dropped one would still look thorough.
    for (const { name } of PROJECT_BOUND_FUNCTIONS) {
      expect(
        PROJECT_MUTATIONS.some((m) => m.change.includes(name)),
        `no mutation removes the execution project from ${name}`,
      ).toBe(true)
    }
  })

  it('bind and complete each have their OWN comparison mutation', () => {
    // FASE 2: "No confíes sólo en que bind ya lo comprobó. Complete debe
    // revalidar independientemente." One shared mutation would leave the
    // independence untested — and the two bodies are textually identical at
    // the clause, so an anchor written carelessly hits whichever comes first.
    const comparison = PROJECT_MUTATIONS.filter((m) =>
      m.expectedGate.includes('ticket-project-comparison'),
    )
    expect(comparison.length).toBeGreaterThanOrEqual(2)
    expect(comparison.some((m) => m.change.includes('bind_operation_ticket'))).toBe(true)
    expect(comparison.some((m) => m.change.includes('complete_operation_ticket'))).toBe(true)
  })

  it('every mutation names the gate that must refuse it', () => {
    for (const m of PROJECT_MUTATIONS) {
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
    const exercised = new Set(
      PROJECT_MUTATIONS.flatMap((m) => VIOLATIONS.get(m.id)!.map((v) => v.gate)),
    )
    const unexercised = [...ALL_GATE_NAMES].filter((g) => !exercised.has(g)).sort()
    expect(unexercised).toEqual([...UNEXERCISED_GATES].sort())
  })
})

describe('project-binding contract — the error code is its own', () => {
  it('the mismatch SQLSTATE is none of the five stella_0014 already uses', () => {
    // FASE 4 as an assertion rather than a comment: cross-organization,
    // cross-actor, unknown ticket, expired, different query and exhausted quota
    // must all stay distinguishable from "another project".
    expect(PRE_EXISTING_SQLSTATES).not.toContain(PROJECT_MISMATCH_SQLSTATE)
    expect(PROJECT_MISMATCH_SQLSTATE).toMatch(/^U01\d\d$/)
  })

  it('the forward package raises it once per governed verb, and says the same thing each time', () => {
    const fwd = BASE['stella_0015_project_bound_operation_tickets.sql']
    const raises = fwd.match(new RegExp(`RAISE EXCEPTION[^;]*${PROJECT_MISMATCH_SQLSTATE}[^;]*;`, 'g')) ?? []
    // FIVE, not four, and the fifth is not a leak: the self-verification block
    // raises its own message NAMING the code, because the property it asserts
    // is "each of the four compares the project and raises U0110". Counting
    // raw matches would have made this test agree with itself; it is split so
    // the refusals and the assertion about the refusals stay distinguishable.
    const refusals = raises.filter((r) => r.includes('belongs to a different project'))
    const selfChecks = raises.filter((r) => r.includes('FAILED verification'))
    expect(refusals).toHaveLength(PROJECT_BOUND_FUNCTIONS.length)
    expect(selfChecks).toHaveLength(1)
    expect(refusals.length + selfChecks.length).toBe(raises.length)
    for (const r of refusals) {
      // No identifier crosses the boundary in the message: a refusal that
      // echoed the project the caller supplied would confirm which of its
      // guesses reached a row.
      expect(r).not.toMatch(/%/)
      expect(r.replace(/ERRCODE = '\w+'/, '')).not.toMatch(/\bp_[a-z_]+\b/)
    }
  })

  it('the argument is named identically everywhere the contract refers to it', () => {
    // The package asserts things about itself over this exact string
    // (pg_get_function_arguments LIKE '%p_expected_project_id uuid%'), so a
    // rename in one place and not the other would make a self-verification
    // pass while measuring nothing.
    const fwd = BASE['stella_0015_project_bound_operation_tickets.sql']
    expect(fwd).toContain(PROJECT_ARGUMENT)
    expect(fwd.split(PROJECT_ARGUMENT).length - 1).toBeGreaterThanOrEqual(
      PROJECT_BOUND_FUNCTIONS.length,
    )
  })
})
