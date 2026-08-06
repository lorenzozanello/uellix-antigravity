// tests/stella-governed-consumption-mutation.test.ts
//
// The gate on the governed-consumption gates.
//
// A static suite is trustworthy only to the extent that someone has shown it
// goes RED when the property it guards is removed. This file applies every
// catalogued mutation to an in-memory copy of the two stella_0017 packages and
// requires evaluateGovernedConsumptionGates() to refuse it — and to refuse it
// for the RIGHT reason.
//
// Nothing here writes to db/prepared.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  evaluateGovernedConsumptionGates,
  GOVERNED_SQL_FILES,
  GOVERNED_FORWARD,
  GOVERNED_ROLLBACK,
  GOVERNED_CATEGORIES,
  RUNTIME_PRINCIPALS,
  IDENTITY_CHECK,
  type Sources,
} from './helpers/stella-governed-consumption-gates'
import {
  GOVERNED_CONSUMPTION_MUTATIONS,
  type Mutation,
} from './helpers/stella-governed-consumption-mutations'
import { RESERVED_QUOTA_MUTATIONS } from './helpers/stella-reserved-quota-mutations'
import { PROJECT_MUTATIONS } from './helpers/stella-project-ticket-mutations'
import { MUTATIONS as TICKET_MUTATIONS } from './helpers/stella-ticket-mutations'

const PREPARED = path.resolve(process.cwd(), 'db', 'prepared')

function baseline(): Sources {
  const out: Record<string, string> = {}
  for (const f of GOVERNED_SQL_FILES) out[f] = readFileSync(path.join(PREPARED, f), 'utf8')
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
  path.resolve(process.cwd(), 'tests', 'helpers', 'stella-governed-consumption-gates.ts'),
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
 * property — or restate for this package an invariant an earlier one owns.
 */
const UNEXERCISED_GATES: readonly string[] = [
  'governed-charge-path-preserved',
  'governed-conversion-present',
  'governed-definer-posture',
  'governed-row-lock',
  'governed-sibling-verb-grant',
  'governed-sibling-verb-present',
  'governed-rollback-restores-conversion',
  'governed-ticket-table-untouched',
  'source-missing',
  'unparsed',
]

function mutate(m: Mutation): Sources {
  const out: Sources = { ...BASE }
  out[m.file] = m.apply(BASE[m.file])
  return out
}

describe('stella_0017 — the package is clean as shipped', () => {
  it('produces no violations', () => {
    const violations = evaluateGovernedConsumptionGates(BASE)
    expect(
      violations.map((x) => `${x.gate}: ${x.detail}`),
      'the shipped package must satisfy its own static contract',
    ).toEqual([])
  })

  it('parses both files without leaving a security statement unread', () => {
    const violations = evaluateGovernedConsumptionGates(BASE)
    expect(violations.filter((x) => x.gate === 'unparsed')).toEqual([])
  })
})

describe('stella_0017 — every mutation dies by its OWN gate', () => {
  it.each(GOVERNED_CONSUMPTION_MUTATIONS.map((m) => [m.id, m] as const))(
    '%s',
    (_id, m) => {
      const mutated = mutate(m)

      // RULE 1. A stale anchor matches nothing, produces an unmutated source,
      // and yields a violation-free run that reads as a pass.
      expect(
        mutated[m.file],
        `${m.id}: the mutation did not change ${m.file} — the anchor is stale`,
      ).not.toBe(BASE[m.file])

      const violations = evaluateGovernedConsumptionGates(mutated)
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
        violations.filter((x) => x.gate === 'unparsed'),
        `${m.id}: died by 'unparsed' rather than by a property gate`,
      ).toEqual([])
    },
  )
})

describe('stella_0017 — the catalogue itself', () => {
  it('gives every mutation a unique id, disjoint from the three earlier catalogues', () => {
    const mine = GOVERNED_CONSUMPTION_MUTATIONS.map((m) => m.id)
    expect(new Set(mine).size).toBe(mine.length)

    const earlier = new Set([
      ...TICKET_MUTATIONS.map((m) => m.id),
      ...PROJECT_MUTATIONS.map((m) => m.id),
      ...RESERVED_QUOTA_MUTATIONS.map((m) => m.id),
    ])
    const collisions = mine.filter((id) => earlier.has(id))
    expect(collisions, `ids reused from an earlier catalogue: ${collisions.join(', ')}`).toEqual([])
  })

  it('names only gates the evaluator can actually emit', () => {
    const unknown = GOVERNED_CONSUMPTION_MUTATIONS.flatMap((m) =>
      m.expectedGate.filter((g) => !ALL_GATE_NAMES.has(g)).map((g) => `${m.id} -> ${g}`),
    )
    expect(unknown, `expectedGate names no gate emits: ${unknown.join(', ')}`).toEqual([])
  })

  it('leaves no gate unexercised without saying so out loud', () => {
    const exercised = new Set(GOVERNED_CONSUMPTION_MUTATIONS.flatMap((m) => m.expectedGate))
    const orphans = [...ALL_GATE_NAMES].filter(
      (g) => !exercised.has(g) && !UNEXERCISED_GATES.includes(g),
    )
    expect(
      orphans,
      `gate(s) with no mutation and no entry in UNEXERCISED_GATES: ${orphans.join(', ')}`,
    ).toEqual([])
  })

  it('targets only the two files of this package', () => {
    for (const m of GOVERNED_CONSUMPTION_MUTATIONS) {
      expect([GOVERNED_FORWARD, GOVERNED_ROLLBACK]).toContain(m.file)
    }
  })

  it('explains what each mutation breaks in more than a sentence fragment', () => {
    for (const m of GOVERNED_CONSUMPTION_MUTATIONS) {
      expect(m.breaks.length, `${m.id}: the consequence is not written down`).toBeGreaterThan(120)
      expect(m.clause.length, `${m.id}: no clause of the brief is named`).toBeGreaterThan(10)
    }
  })
})

describe('stella_0017 — the shape the contract publishes', () => {
  it('revokes the ledger write from every runtime principal, by name', () => {
    for (const role of RUNTIME_PRINCIPALS) {
      expect(
        BASE[GOVERNED_FORWARD].includes(
          `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM ${role}`,
        ),
        `${role} keeps its write privileges`,
      ).toBe(true)
    }
  })

  it('names the governed-identity CHECK and adds it NOT VALID', () => {
    expect(BASE[GOVERNED_FORWARD]).toContain(IDENTITY_CHECK)
    expect(BASE[GOVERNED_FORWARD]).toContain('CHECK (idempotency_key IS NOT NULL) NOT VALID')
  })

  it('keeps the vocabulary at the same seven categories the ticket already carried', () => {
    // The generalisation is NOT a new vocabulary — it is the same seven values
    // stella_0013 and stella_0014 published. A package that added an eighth
    // would be one whose ledger CHECK could not record what its ticket admits.
    for (const category of GOVERNED_CATEGORIES) {
      expect(
        BASE[GOVERNED_FORWARD].includes(`'${category}'`),
        `${category} is missing from the governed array`,
      ).toBe(true)
    }
  })

  it('never lets the payload reach the idempotency-key derivation', () => {
    const key = BASE[GOVERNED_FORWARD].match(/v_key := [\s\S]{0,500}?'hex'\);/)?.[0]
    expect(key, 'the key derivation was not found').toBeTruthy()
    for (const arg of ['p_response_json', 'p_model_used', 'p_tokens_used', 'p_pipeline_step']) {
      expect(key!.includes(arg), `${arg} is part of the idempotency key`).toBe(false)
    }
  })

  it('leaves no GRANT of INSERT on the ledger anywhere in the rollback', () => {
    expect(/GRANT[^\n;]*\bINSERT\b[^\n;]*ON public\.stella_interactions/.test(BASE[GOVERNED_ROLLBACK])).toBe(false)
  })
})
