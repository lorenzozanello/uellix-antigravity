// tests/stella-reserved-quota-mutation.test.ts
//
// The gate on the reserved-quota gates.
//
// A static suite is trustworthy only to the extent that someone has shown it
// goes RED when the property it guards is removed. This file applies every
// catalogued mutation to an in-memory copy of the two stella_0016 packages and
// requires evaluateReservedQuotaGates() to refuse it — and to refuse it for the
// RIGHT reason.
//
// Nothing here writes to db/prepared.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  evaluateReservedQuotaGates,
  RESERVED_QUOTA_SQL_FILES,
  RESERVED_QUOTA_FORWARD,
  CAPACITY_FUNCTIONS,
  REPUBLISHED_VERBS,
  RESERVATION_INVALID_SQLSTATE,
  PRE_EXISTING_SQLSTATES,
  type Sources,
} from './helpers/stella-reserved-quota-gates'
import { RESERVED_QUOTA_MUTATIONS, type Mutation } from './helpers/stella-reserved-quota-mutations'
import { PROJECT_MUTATIONS } from './helpers/stella-project-ticket-mutations'
import { MUTATIONS as TICKET_MUTATIONS } from './helpers/stella-ticket-mutations'

const PREPARED = path.resolve(process.cwd(), 'db', 'prepared')

function baseline(): Sources {
  const out: Record<string, string> = {}
  for (const f of RESERVED_QUOTA_SQL_FILES) out[f] = readFileSync(path.join(PREPARED, f), 'utf8')
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
  path.resolve(process.cwd(), 'tests', 'helpers', 'stella-reserved-quota-gates.ts'),
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
 * property — or restate an invariant an earlier package owns and this one
 * inherits. They are listed here so that "no mutation exercises them" is a
 * recorded fact and not an unnoticed hole.
 */
const UNEXERCISED_GATES: readonly string[] = [
  'capacity-actor-binding',
  'capacity-charge-shape',
  'capacity-complete-row-lock',
  'capacity-conversion-error-code',
  'capacity-conversion-does-not-compete',
  'capacity-conversion-surface',
  'capacity-definer-no-dynamic-sql',
  'capacity-definer-no-star',
  'capacity-definer-search-path',
  'capacity-definer-security',
  'capacity-error-detail',
  'capacity-inventory',
  'capacity-read-takes-no-lock',
  'capacity-rollback-no-cascade',
  'capacity-rollback-single-block',
  'capacity-scope-check',
  'capacity-self-verification',
  'capacity-sibling-surface',
  'capacity-verb-republished',
  'source-missing',
  'unparsed',
]

function mutate(m: Mutation): Sources {
  const next: Record<string, string> = { ...BASE }
  next[m.file] = m.apply(BASE[m.file])
  return next
}

/** Each mutant is evaluated once and the result reused. */
const VIOLATIONS = new Map(
  RESERVED_QUOTA_MUTATIONS.map((m) => [m.id, evaluateReservedQuotaGates(mutate(m))] as const),
)

describe('reserved-quota mutation harness — the baseline is clean', () => {
  it('the unmutated packages produce no violation', () => {
    // Without this, every "the mutant is refused" below could be explained by a
    // gate that refuses everything.
    expect(evaluateReservedQuotaGates(BASE).map((v) => `${v.gate}: ${v.detail}`)).toEqual([])
  })

  it('the catalogue has no duplicate ids', () => {
    const ids = RESERVED_QUOTA_MUTATIONS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the ids do not collide with the two earlier catalogues', () => {
    // Three catalogues judging three packages, one numbering. Without this,
    // "K-17" would mean different things depending on which file a reader
    // opened.
    const theirs = new Set([
      ...TICKET_MUTATIONS.map((m) => m.id),
      ...PROJECT_MUTATIONS.map((m) => m.id),
    ])
    for (const m of RESERVED_QUOTA_MUTATIONS) {
      expect(theirs, `${m.id} is already used by an earlier catalogue`).not.toContain(m.id)
    }
  })

  it('every mutation targets a file the gates actually read', () => {
    for (const m of RESERVED_QUOTA_MUTATIONS) {
      expect(RESERVED_QUOTA_SQL_FILES, m.id).toContain(m.file)
    }
  })

  it('no two mutations share a description or a rationale', () => {
    expect(new Set(RESERVED_QUOTA_MUTATIONS.map((m) => m.change)).size).toBe(
      RESERVED_QUOTA_MUTATIONS.length,
    )
    expect(new Set(RESERVED_QUOTA_MUTATIONS.map((m) => m.breaks)).size).toBe(
      RESERVED_QUOTA_MUTATIONS.length,
    )
  })

  it('every mutation says what it breaks, at length', () => {
    // A finding without a mechanism is a coincidence.
    for (const m of RESERVED_QUOTA_MUTATIONS) {
      expect(m.breaks.length, `${m.id} does not say what it breaks`).toBeGreaterThan(60)
    }
  })
})

describe('reserved-quota mutation harness — every catalogued mutation is refused', () => {
  it.each(RESERVED_QUOTA_MUTATIONS)('$id ($severity): $change', (m) => {
    const mutated = mutate(m)

    // Rule 1: the edit landed.
    expect(mutated[m.file], `${m.id} is a no-op — its anchor matched nothing`).not.toBe(
      BASE[m.file],
    )

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
    expect(evaluateReservedQuotaGates(BASE)).toEqual([])
  })
})

describe('reserved-quota mutation harness — coverage', () => {
  it('covers both files of the package', () => {
    const files = new Set(RESERVED_QUOTA_MUTATIONS.map((m) => m.file))
    expect([...files].sort()).toEqual([...RESERVED_QUOTA_SQL_FILES].sort())
  })

  it('exercises every property the dispatch names as a required mutation', () => {
    // The list is the dispatch's FASE 11, transcribed. A gate that no longer
    // has a mutation behind it must fail HERE, where the omission is visible,
    // rather than by quietly dropping out of the catalogue.
    const required = [
      'capacity-reservation-counted',       // reservas eliminadas del conteo
      'capacity-expiry-in-predicate',       // expiracion eliminada / ticket expirado sigue contando
      'capacity-conversion-proves-reservation', // categoria ignorada
      'capacity-no-period-filter',          // periodo ignorado
      'capacity-complete-does-not-compete', // complete vuelve a llamar consumo competitivo
      'capacity-complete-settles',          // complete no elimina reserva
      'capacity-limit-enforced',            // sibling consume ignorando reservas / limite no comprobado
      'capacity-advisory-lock',             // lock eliminado
      'capacity-idempotent',                // idempotencia eliminada
      'capacity-verb-signature',            // firma antigua ejecutable
      'capacity-rollback-safe',             // rollback reintroduce R1
      'capacity-dependency',                // guard de orden eliminado
      'capacity-rollback-convergence',
      'capacity-rollback-preserves-charges',
      'capacity-rollback-scope',
      'capacity-conversion-grant-scope',
      'capacity-policy-scope',
      'capacity-column-grant',
      'capacity-period-generated',
    ]
    const declared = new Set(RESERVED_QUOTA_MUTATIONS.flatMap((m) => m.expectedGate))
    for (const g of required) {
      expect(declared, `no mutation is written against ${g}`).toContain(g)
    }
  })

  it('each of the three governed functions has a mutation of its own', () => {
    for (const { name } of CAPACITY_FUNCTIONS) {
      expect(
        RESERVED_QUOTA_MUTATIONS.some((m) => m.change.includes(name)),
        `no mutation breaks ${name}`,
      ).toBe(true)
    }
  })

  it('each republished verb has a mutation of its own', () => {
    // bind and complete are replaced IN PLACE. A catalogue that only broke the
    // three new functions would leave the two that actually carry the protocol
    // untested.
    for (const name of REPUBLISHED_VERBS) {
      expect(
        RESERVED_QUOTA_MUTATIONS.some((m) => m.change.includes(name)),
        `no mutation breaks the republished ${name}`,
      ).toBe(true)
    }
  })

  it('the reservation count is attacked from BOTH causes of R1', () => {
    // Cause (1) is the arithmetic — reservations absent from the subtraction.
    // Cause (2) is the visibility — the count running under an actor-scoped
    // policy. One mutation cannot express both, and a catalogue that covered
    // only the first would leave the defect that was found by reproducing the
    // first entirely untested.
    expect(
      RESERVED_QUOTA_MUTATIONS.some((m) => m.expectedGate.includes('capacity-reservation-counted')),
    ).toBe(true)
    expect(
      RESERVED_QUOTA_MUTATIONS.some((m) => m.expectedGate.includes('capacity-policy-scope')),
    ).toBe(true)
  })

  it('every mutation names the gate that must refuse it', () => {
    for (const m of RESERVED_QUOTA_MUTATIONS) {
      expect(m.expectedGate.length, `${m.id} names no gate`).toBeGreaterThan(0)
      for (const g of m.expectedGate) {
        expect(g, `${m.id}`).toMatch(/^[a-z0-9-]+$/)
        expect(
          ALL_GATE_NAMES,
          `${m.id} declares gate ${g}, which no add()/require_() emits`,
        ).toContain(g)
      }
    }
  })

  it('names every gate that no mutation exercises, so the list cannot grow quietly', () => {
    // "0 of N mutations survive" says nothing about the gates no mutation
    // touches. A gate that has never gone red is indistinguishable from a gate
    // that cannot. This does not demand a mutation per gate — it demands that
    // the unexercised set be WRITTEN DOWN.
    const exercised = new Set(
      RESERVED_QUOTA_MUTATIONS.flatMap((m) => VIOLATIONS.get(m.id)!.map((v) => v.gate)),
    )
    const unexercised = [...ALL_GATE_NAMES].filter((g) => !exercised.has(g)).sort()
    expect(unexercised).toEqual([...UNEXERCISED_GATES].sort())
  })
})

describe('reserved-quota contract — the conversion refusal is its own code', () => {
  it('the reservation SQLSTATE is none of the seven the campaign already uses', () => {
    // A caller that has to tell "your reservation expired" from "that is not
    // your ticket" cannot act on one code for both.
    expect(PRE_EXISTING_SQLSTATES).not.toContain(RESERVATION_INVALID_SQLSTATE)
    expect(RESERVATION_INVALID_SQLSTATE).toMatch(/^U01\d\d$/)
  })

  it('the conversion refuses with one message and echoes no identifier', () => {
    const fwd = BASE[RESERVED_QUOTA_FORWARD]
    const raises =
      fwd.match(new RegExp(`RAISE EXCEPTION[^;]*${RESERVATION_INVALID_SQLSTATE}[^;]*;`, 'g')) ?? []
    expect(raises.length).toBeGreaterThanOrEqual(3)
    for (const r of raises) {
      // No identifier crosses the boundary in the message: a refusal that
      // echoed the ticket the caller supplied would confirm which of its
      // guesses reached a row.
      expect(r).not.toMatch(/%/)
      expect(r.replace(/ERRCODE = '\w+'/, '')).not.toMatch(/\bp_[a-z_]+\b/)
    }
  })

  it('the conversion is granted to the ticket definer and to nobody else', () => {
    // The security property of this package, as a text assertion over the file
    // rather than a claim in a comment.
    const fwd = BASE[RESERVED_QUOTA_FORWARD]
    const grants =
      fwd.match(/GRANT EXECUTE ON FUNCTION uellix_stella\.settle_reserved_quota[\s\S]*?;/g) ?? []
    expect(grants).toHaveLength(1)
    expect(grants[0]).toContain('uellix_cap_stella_ticket')
    expect(grants[0]).not.toContain('uellix_app')
  })
})
