// tests/stella-category-binding-mutation.test.ts
//
// The gate on the category-binding gates.
//
// A static suite is trustworthy only to the extent that someone has shown it
// goes RED when the property it guards is removed. This file applies every
// catalogued mutation to an in-memory copy of the two stella_0018 packages and
// requires evaluateCategoryBindingGates() to refuse it — and to refuse it for
// the RIGHT reason.
//
// Nothing here writes to db/prepared.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  evaluateCategoryBindingGates,
  CATEGORY_SQL_FILES,
  CATEGORY_FORWARD,
  CATEGORY_ROLLBACK,
  CATEGORY_MISMATCH_SQLSTATE,
  RUNTIME_PRINCIPALS,
  type Sources,
} from './helpers/stella-category-binding-gates'
import {
  CATEGORY_BINDING_MUTATIONS,
  type Mutation,
} from './helpers/stella-category-binding-mutations'
import { GOVERNED_CONSUMPTION_MUTATIONS } from './helpers/stella-governed-consumption-mutations'
import { RESERVED_QUOTA_MUTATIONS } from './helpers/stella-reserved-quota-mutations'
import { PROJECT_MUTATIONS } from './helpers/stella-project-ticket-mutations'
import { MUTATIONS as TICKET_MUTATIONS } from './helpers/stella-ticket-mutations'

const PREPARED = path.resolve(process.cwd(), 'db', 'prepared')

function baseline(): Sources {
  const out: Record<string, string> = {}
  for (const f of CATEGORY_SQL_FILES) out[f] = readFileSync(path.join(PREPARED, f), 'utf8')
  return out
}

const BASE = baseline()

/**
 * Every gate name the evaluator can emit, read out of its own source.
 *
 * Derived rather than listed: a hardcoded list cannot see the name that is not
 * on it, and a gate added without a mutation is exactly what this file exists to
 * make visible.
 */
const GATES_SOURCE = readFileSync(
  path.resolve(process.cwd(), 'tests', 'helpers', 'stella-category-binding-gates.ts'),
  'utf8',
)
// Two spellings, because the evaluator emits gate names two ways: most are the
// first argument of an `add(...)` call, and the three ordering gates come from a
// table of `{ anchor, gate, why }` rows so that the three checks cannot drift
// apart. A reader that only knew the first spelling would report the other three
// as names no gate emits — which is what a first version of this line did.
const ALL_GATE_NAMES: ReadonlySet<string> = new Set([
  ...[...GATES_SOURCE.matchAll(/\badd\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]!),
  ...[...GATES_SOURCE.matchAll(/\bgate:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]!),
])

/**
 * Gates no mutation exercises, written down so growing this list is a visible
 * act rather than a quiet one.
 *
 * The `*-present` pair are properties of the HARNESS (a missing file), not of
 * the SQL. The rest guard shapes a mutation can only remove by deleting a whole
 * section — at which point the mutant tests the deletion rather than the
 * property — or restate for this package an invariant an earlier one owns and
 * an earlier catalogue already exercises.
 */
const UNEXERCISED_GATES: readonly string[] = [
  'category-forward-present',
  'category-rollback-present',
  'category-expected-argument-published',
  'category-governed-bind-granted',
  'category-bind-owner',
  'category-security-definer',
  'category-empty-search-path',
  'category-forward-additive',
  'category-no-project-blind-signature',
  'category-rollback-drops-new-signature',
  'category-rollback-order',
  'category-rollback-verifies-removal',
  'category-unparsed-statement',
  'category-superuser-precondition',
  'category-chain-precondition',
]

function mutate(m: Mutation): Sources {
  const out: Sources = { ...BASE }
  out[m.file] = m.apply(BASE[m.file]!)
  return out
}

describe('stella_0018 — the package is clean as shipped', () => {
  it('produces no violations', () => {
    const violations = evaluateCategoryBindingGates(BASE)
    expect(
      violations.map((x) => `${x.gate}: ${x.detail}`),
      'the shipped package must satisfy its own static contract',
    ).toEqual([])
  })

  it('parses both files without leaving a security statement unread', () => {
    const violations = evaluateCategoryBindingGates(BASE)
    expect(violations.filter((x) => x.gate === 'category-unparsed-statement')).toEqual([])
  })
})

describe('stella_0018 — every mutation dies by its OWN gate', () => {
  it.each(CATEGORY_BINDING_MUTATIONS.map((m) => [m.id, m] as const))('%s', (_id, m) => {
    const mutated = mutate(m)

    // RULE 1. A stale anchor matches nothing, produces an unmutated source, and
    // yields a violation-free run that reads as a pass.
    expect(
      mutated[m.file],
      `${m.id}: the mutation did not change ${m.file} — the anchor is stale`,
    ).not.toBe(BASE[m.file])

    const violations = evaluateCategoryBindingGates(mutated)
    expect(
      violations.length,
      `${m.id} (${m.change}) survived every gate. What it breaks: ${m.breaks}`,
    ).toBeGreaterThan(0)

    // RULE 2. It is not enough that SOMETHING objected.
    const fired = new Set(violations.map((x) => x.gate))
    for (const gate of m.expectedGate) {
      expect(
        fired.has(gate),
        `${m.id}: expected gate '${gate}' to fire; instead: ${[...fired].join(', ')}`,
      ).toBe(true)
    }

    // RULE 3. Detection must not be an accident of the harness failing to read
    // the mutated text.
    expect(
      violations.filter((x) => x.gate === 'category-unparsed-statement'),
      `${m.id}: died by an unparsed statement rather than by a property gate`,
    ).toEqual([])
  })
})

describe('stella_0018 — the catalogue itself', () => {
  it('gives every mutation a unique id, disjoint from the four earlier catalogues', () => {
    const mine = CATEGORY_BINDING_MUTATIONS.map((m) => m.id)
    expect(new Set(mine).size).toBe(mine.length)

    const earlier = new Set([
      ...TICKET_MUTATIONS.map((m) => m.id),
      ...PROJECT_MUTATIONS.map((m) => m.id),
      ...RESERVED_QUOTA_MUTATIONS.map((m) => m.id),
      ...GOVERNED_CONSUMPTION_MUTATIONS.map((m) => m.id),
    ])
    const collisions = mine.filter((id) => earlier.has(id))
    expect(collisions, `ids reused from an earlier catalogue: ${collisions.join(', ')}`).toEqual([])
  })

  it('continues the numbering rather than restarting it', () => {
    // The five catalogues share one id space so that "K-86" can only ever mean
    // one thing. This asserts the CONTINUATION rather than a literal first id:
    // every id here must sit above every id of the four earlier sets.
    const highestEarlier = Math.max(
      ...[
        ...TICKET_MUTATIONS,
        ...PROJECT_MUTATIONS,
        ...RESERVED_QUOTA_MUTATIONS,
        ...GOVERNED_CONSUMPTION_MUTATIONS,
      ].map((m) => Number(m.id.replace('K-', ''))),
    )
    for (const m of CATEGORY_BINDING_MUTATIONS) {
      expect(
        Number(m.id.replace('K-', '')),
        `${m.id} does not continue the shared numbering`,
      ).toBeGreaterThan(highestEarlier)
    }
  })

  it('names only gates the evaluator can actually emit', () => {
    const unknown = CATEGORY_BINDING_MUTATIONS.flatMap((m) =>
      m.expectedGate.filter((g) => !ALL_GATE_NAMES.has(g)).map((g) => `${m.id} -> ${g}`),
    )
    expect(unknown, `expectedGate names no gate emits: ${unknown.join(', ')}`).toEqual([])
  })

  it('leaves no gate unexercised without saying so out loud', () => {
    const exercised = new Set(CATEGORY_BINDING_MUTATIONS.flatMap((m) => m.expectedGate))
    const orphans = [...ALL_GATE_NAMES].filter(
      (g) => !exercised.has(g) && !UNEXERCISED_GATES.includes(g),
    )
    expect(
      orphans,
      `gate(s) with no mutation and no entry in UNEXERCISED_GATES: ${orphans.join(', ')}`,
    ).toEqual([])
  })

  it('targets only the two files of this package', () => {
    for (const m of CATEGORY_BINDING_MUTATIONS) {
      expect([CATEGORY_FORWARD, CATEGORY_ROLLBACK]).toContain(m.file)
    }
  })

  it('explains what each mutation breaks in more than a sentence fragment', () => {
    for (const m of CATEGORY_BINDING_MUTATIONS) {
      expect(m.breaks.length, `${m.id}: the consequence is not written down`).toBeGreaterThan(120)
      expect(m.clause.length, `${m.id}: no clause of the brief is named`).toBeGreaterThan(10)
    }
  })
})

describe('stella_0018 — the shape the contract publishes', () => {
  it('withdraws BOTH ungoverned routes from uellix_app by name', () => {
    // By NAME, and the reason is the one stella_0017 §1 records: `uellix_app`
    // holds both grants EXPLICITLY (stella_0016 §7), so a REVOKE FROM PUBLIC is
    // a no-op over it and a package that only wrote that one would verify clean
    // over an open database.
    expect(BASE[CATEGORY_FORWARD]).toContain(
      'REVOKE EXECUTE ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64))\n  FROM uellix_app;',
    )
    expect(BASE[CATEGORY_FORWARD]).toContain(
      'REVOKE EXECUTE ON FUNCTION uellix_stella.consume_stella_capacity(uuid, uuid, varchar(50), char(64))\n  FROM uellix_app;',
    )
  })

  it('asks about every runtime principal, not only the one that holds the grant today', () => {
    for (const role of RUNTIME_PRINCIPALS) {
      expect(
        BASE[CATEGORY_FORWARD]!.includes(`'${role}'`),
        `${role} is not among the principals the self-verification interrogates`,
      ).toBe(true)
    }
  })

  it('raises its own SQLSTATE and does not reuse an existing one', () => {
    expect(BASE[CATEGORY_FORWARD]).toContain(`ERRCODE = '${CATEGORY_MISMATCH_SQLSTATE}'`)
    // U0110 is the project mismatch and U0111 the reservation refusal. Reusing
    // either would make an operator's log unable to tell a cross-project
    // presentation from a cross-capability one — six causes, six responses.
    for (const taken of ['U0110', 'U0111']) {
      const raisedForCategory = new RegExp(
        `issued for a different capability'[^\\n]*ERRCODE = '${taken}'`,
      )
      expect(raisedForCategory.test(BASE[CATEGORY_FORWARD]!)).toBe(false)
    }
  })

  it('is additive: it drops nothing and keeps the three-argument signature alive', () => {
    expect(BASE[CATEGORY_FORWARD]).not.toMatch(/DROP\s+FUNCTION/)
    expect(BASE[CATEGORY_FORWARD]).toContain(
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.bind_operation_ticket(\n  p_ticket_id char(64),\n  p_expected_project_id uuid,\n  p_query_hash char(64)\n)',
    )
  })

  it('says out loud that its rollback reopens both defects', () => {
    // A rollback whose consequence is not written down is a rollback somebody
    // will run expecting a neutral revert.
    expect(BASE[CATEGORY_ROLLBACK]).toMatch(/restores R6a and R6b/)
  })
})
