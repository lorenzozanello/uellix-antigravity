// tests/hosted/witness-sql.test.ts
//
// GAP C — the translation from a typed witness to a pg_catalog question, and the
// anchoring that makes the registry answerable to the SQL it claims to describe.
//
// Two properties, and the second is the one with teeth.
//
//   1. Every witness KIND has exactly one translation, and every translation
//      resolves the object the way the catalogue reports it — by FULL SIGNATURE
//      for functions, bound to the RELATION for columns and constraints.
//
//   2. Every witness is anchored to the canonical SQL. The classifier is
//      self-consistent whatever the registry says: give stella_0017 its
//      predecessor's five-argument settle and every classification test still
//      passes, more easily. Only the source files can tell anyone the
//      transcription is wrong — and it HAD been wrong, in the one direction no
//      fixture could see (see the note on expire_operation_tickets below).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  PACKAGE_WITNESSES,
  WITNESSED_PACKAGES,
  allWitnesses,
  witnessKey,
  type PackageWitnesses,
  type Witness,
} from '@/db/hosted/package-witnesses'
import {
  anchorWitnessesToCanonicalSql,
  planWitnessSql,
  witnessPredicateSql,
} from '@/db/hosted/witness-sql'

const ROOT = process.cwd()

const readPackageSql = (packageId: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, 'db', 'prepared', `${packageId}.sql`), 'utf8')
  } catch {
    return null
  }
}

/** A deep copy the mutation cases can corrupt without leaking into other tests. */
const cloneRegistry = (): Record<string, PackageWitnesses> =>
  JSON.parse(JSON.stringify(PACKAGE_WITNESSES)) as Record<string, PackageWitnesses>

const fn = (identifier: string): Witness => ({ kind: 'regprocedure', identifier })

const [T1, , , , T5, T6, T7, T8, T9] = WITNESSED_PACKAGES as unknown as [
  string, string, string, string, string, string, string, string, string,
]

describe('every witness kind translates to exactly one catalogue question', () => {
  it('resolves a role through pg_roles', () => {
    const r = witnessPredicateSql({ kind: 'role', identifier: 'uellix_cap_grounding' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sql).toBe(`EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'uellix_cap_grounding')`)
  })

  it('resolves a schema through pg_namespace', () => {
    const r = witnessPredicateSql({ kind: 'schema', identifier: 'uellix_stella_ops' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sql).toContain('pg_catalog.pg_namespace')
  })

  it('resolves a relation through to_regclass, schema-qualified', () => {
    const r = witnessPredicateSql({ kind: 'regclass', identifier: 'public.evidence_chunks' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sql).toBe(`(pg_catalog.to_regclass('public.evidence_chunks') IS NOT NULL)`)
  })

  it('resolves a function through to_regprocedure, carrying its WHOLE signature', () => {
    const r = witnessPredicateSql(fn('uellix_stella.settle_reserved_quota(uuid,uuid,character varying,character,character)'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sql).toContain('to_regprocedure')
      // The argument list survives verbatim. If it did not, the five-argument
      // settle and the ten-argument one would resolve to the same question.
      expect(r.sql).toContain('(uuid,uuid,character varying,character,character)')
    }
  })

  it('excludes dropped and system columns, so a column witness cannot fire on either', () => {
    const r = witnessPredicateSql({ kind: 'column', identifier: 'public.stella_interactions.idempotency_key' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sql).toContain('NOT a.attisdropped')
      expect(r.sql).toContain('a.attnum > 0')
    }
  })

  it('binds a constraint to its RELATION, not just to its name', () => {
    const r = witnessPredicateSql({
      kind: 'constraint',
      identifier: 'public.evidence_chunks.evidence_chunks_span_length_check',
    })
    expect(r.ok).toBe(true)
    // Constraint names are unique per table, not per schema: without the relation
    // join a same-named constraint elsewhere would witness a package that never ran.
    if (r.ok) expect(r.sql).toContain(`c.relname = 'evidence_chunks'`)
  })

  it('every predicate the real registry produces is a scalar boolean expression', () => {
    for (const w of allWitnesses()) {
      const r = witnessPredicateSql(w)
      expect(r.ok, witnessKey(w)).toBe(true)
      if (r.ok) {
        expect(r.sql.startsWith('EXISTS (') || r.sql.startsWith('(')).toBe(true)
        expect(r.sql).not.toContain(';')
      }
    }
  })
})

describe('the translator refuses rather than guessing', () => {
  it('refuses a function witness with no argument list — arity is the discriminator', () => {
    const r = witnessPredicateSql(fn('uellix_stella.settle_reserved_quota'))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('WITNESS_SQL_IDENTIFIER_MALFORMED')
      expect(r.detail).toContain('ARITY IS THE DISCRIMINATOR')
    }
  })

  it('refuses an unqualified relation — search_path is empty and nothing may rely on it', () => {
    const r = witnessPredicateSql({ kind: 'regclass', identifier: 'evidence_chunks' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('WITNESS_SQL_IDENTIFIER_MALFORMED')
  })

  it('refuses a column witness that is not schema.table.column', () => {
    const r = witnessPredicateSql({ kind: 'column', identifier: 'public.idempotency_key' })
    expect(r.ok).toBe(false)
  })

  it('refuses an identifier carrying a quote, rather than escaping it into SQL', () => {
    const r = witnessPredicateSql({ kind: 'role', identifier: "uellix'; DROP ROLE x --" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('WITNESS_SQL_IDENTIFIER_MALFORMED')
  })

  it('refuses a semicolon inside an argument list', () => {
    const r = witnessPredicateSql(fn('uellix_stella.f(uuid); SELECT 1'))
    expect(r.ok).toBe(false)
  })

  it('refuses an identifier with surrounding whitespace instead of trimming it', () => {
    const r = witnessPredicateSql({ kind: 'schema', identifier: ' uellix_stella ' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('WITNESS_SQL_IDENTIFIER_UNSAFE')
  })

  it('refuses to plan a package the registry does not declare', () => {
    const r = planWitnessSql(PACKAGE_WITNESSES, [...WITNESSED_PACKAGES, 'stella_9999_invented'])
    expect(r.ok).toBe(false)
  })

  it('plans the nine in HOSTED_CHAIN order, each with every witness it declares', () => {
    const r = planWitnessSql()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.packages.map((p) => p.packageId)).toEqual([...WITNESSED_PACKAGES])
    for (const p of r.packages) {
      const declared = PACKAGE_WITNESSES[p.packageId]!
      expect(p.witnesses.length, p.packageId).toBe(
        declared.requiredPresentWhenInstalled.length + declared.requiredAbsentWhenInstalled.length,
      )
    }
  })
})

describe('the registry is anchored to the SQL it claims to transcribe', () => {
  it('agrees with the canonical corpus on every witness', () => {
    const problems = anchorWitnessesToCanonicalSql(readPackageSql)
    expect(
      problems.map((p) => `${p.kind} ${p.packageId} ${p.witness}: ${p.detail}`),
      'the registry and db/prepared/** disagree',
    ).toEqual([])
  })

  it('expire_operation_tickets is witnessed as (integer) — a DEFAULT does not remove the parameter', () => {
    // THE DEFECT THIS GATE WAS BUILT TO CATCH, pinned so it cannot come back.
    // stella_0014 creates `expire_operation_tickets(p_max integer DEFAULT 1000)`;
    // `oid::regprocedure::text` renders `(integer)`. The registry originally said
    // `()`, a witness that can never be present — so a correctly installed T5
    // would have measured three positives of four, classified
    // PARTIAL_OR_INCONSISTENT, and A1 refuses on partial. Measured against
    // PostgreSQL, never derivable from a fixture that used the same spelling on
    // both sides.
    const t5 = PACKAGE_WITNESSES[T5]!.requiredPresentWhenInstalled.map((w) => w.identifier)
    expect(t5).toContain('uellix_stella_ops.expire_operation_tickets(integer)')
    expect(t5).not.toContain('uellix_stella_ops.expire_operation_tickets()')
  })

  it('reports a package whose source cannot be read, instead of passing it', () => {
    const problems = anchorWitnessesToCanonicalSql((id) => (id === T1 ? null : readPackageSql(id)))
    expect(problems.some((p) => p.kind === 'PACKAGE_SOURCE_MISSING' && p.packageId === T1)).toBe(true)
  })
})

/*
 * THE MUTATIONS.
 *
 * Each one is a plausible edit to db/hosted/package-witnesses.ts that leaves the
 * classifier entirely self-consistent. None of them can be caught by asking
 * "does this registry classify these observations correctly" — the observations
 * would be generated from the same mutated registry. They are caught here,
 * against the corpus.
 */
describe('MUTATIONS — a registry that drifts from the corpus is refused', () => {
  const anchor = (registry: Record<string, PackageWitnesses>) =>
    anchorWitnessesToCanonicalSql(readPackageSql, registry)

  it('T8 witnessed by T7 five-argument settle — the predecessor trap', () => {
    const r = cloneRegistry()
    r[T8] = {
      ...r[T8]!,
      requiredPresentWhenInstalled: [
        fn('uellix_stella.settle_reserved_quota(uuid,uuid,character varying,character,character)'),
      ],
    }
    const problems = anchor(r)
    expect(problems.some((p) => p.kind === 'WITNESS_CREATED_BY_AN_EARLIER_PACKAGE' && p.packageId === T8)).toBe(true)
  })

  it('T9 witnessed by the three-argument bind instead of the four-argument one', () => {
    const r = cloneRegistry()
    r[T9] = {
      ...r[T9]!,
      requiredPresentWhenInstalled: [fn('uellix_stella_ops.bind_operation_ticket(character,uuid,character)')],
    }
    expect(anchor(r).some((p) => p.kind === 'WITNESS_CREATED_BY_AN_EARLIER_PACKAGE' && p.packageId === T9)).toBe(true)
  })

  it('T7 witnesses copied wholesale onto T8', () => {
    const r = cloneRegistry()
    r[T8] = { ...r[T8]!, requiredPresentWhenInstalled: [...PACKAGE_WITNESSES[T7]!.requiredPresentWhenInstalled] }
    const problems = anchor(r).filter((p) => p.packageId === T8)
    expect(problems.some((p) => p.kind === 'WITNESS_NOT_CREATED_BY_ITS_PACKAGE')).toBe(true)
    expect(problems.some((p) => p.kind === 'WITNESS_CREATED_BY_AN_EARLIER_PACKAGE')).toBe(true)
  })

  it("T5 witnessed by a signature its successor DROPS — the survives-its-successors rule", () => {
    const r = cloneRegistry()
    r[T5] = {
      ...r[T5]!,
      requiredPresentWhenInstalled: [fn('uellix_stella_ops.bind_operation_ticket(character,character)')],
    }
    const problems = anchor(r).filter((p) => p.packageId === T5)
    expect(problems.some((p) => p.kind === 'WITNESS_DROPPED_BY_A_LATER_PACKAGE')).toBe(true)
  })

  it("T6's required absences deleted — coexistence would then read as INSTALLED", () => {
    const r = cloneRegistry()
    r[T6] = { ...r[T6]!, requiredAbsentWhenInstalled: [] }
    const problems = anchor(r).filter((p) => p.packageId === T6)
    expect(problems.filter((p) => p.kind === 'UNDECLARED_REQUIRED_ABSENCE')).toHaveLength(4)
  })

  it('a required absence the package does not actually drop', () => {
    const r = cloneRegistry()
    r[T9] = { ...r[T9]!, requiredAbsentWhenInstalled: [fn('uellix_stella_ops.bind_operation_ticket(character,uuid,character)')] }
    // stella_0018 deliberately RE-CREATES the three-argument bind so it raises
    // U0106 unconditionally; demanding its absence contradicts its own source.
    expect(anchor(r).some((p) => p.kind === 'REQUIRED_ABSENCE_NOT_DROPPED' && p.packageId === T9)).toBe(true)
  })

  it('a function witness stripped of its arity refuses at translation time', () => {
    const r = cloneRegistry()
    r[T7] = { ...r[T7]!, requiredPresentWhenInstalled: [fn('uellix_stella.stella_capacity')] }
    const planned = planWitnessSql(r)
    expect(planned.ok).toBe(false)
    if (!planned.ok) expect(planned.code).toBe('WITNESS_SQL_IDENTIFIER_MALFORMED')
    expect(anchor(r).some((p) => p.packageId === T7 && p.kind === 'WITNESS_ABSENT_FROM_SOURCE')).toBe(true)
  })

  it('a non-function witness naming an object its package never creates', () => {
    const r = cloneRegistry()
    r[T1] = {
      ...r[T1]!,
      requiredPresentWhenInstalled: [{ kind: 'role', identifier: 'uellix_cap_stella_ticket' }],
    }
    expect(anchor(r).some((p) => p.kind === 'WITNESS_ABSENT_FROM_SOURCE' && p.packageId === T1)).toBe(true)
  })
})
