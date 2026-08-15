// tests/hosted/authority/governed-generation.test.ts
// COMMIT 4 — the generated chain, and the twenty mutations it refuses.
//
// The tests that matter here are the ones that BREAK something. A generation
// test that only asserts "nine files were produced" would have passed over both
// of the real defects this commit found:
//
//   the plan recorded a transfer segment's executor as its DESTINATION, when
//   the measured case-G lifecycle runs the ALTERs as uellix_owner — the SQL was
//   right and the field describing it was not;
//
//   the output validator aligned the generator's emission list with the parsed
//   statements BY POSITION, and comment-only authority lines produce no
//   statement, so it reported a role mismatch that did not exist.
//
// Both were found by a check that re-derives the answer from the bytes instead
// of asking the generator what it meant. That is what the mutation cases below
// are for.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  assertDeterministicGeneration,
  buildGovernedChain,
  governedArtefactDir,
  verifyGovernedChain,
} from '@/db/hosted/authority/governed-publication'
import { generateGovernedPackage } from '@/db/hosted/authority/governed-generator'
import { validateGeneratedPackage } from '@/db/hosted/authority/generated-output-validator'
import { resolveExecutionDispositions } from '@/db/hosted/authority/execution-disposition'
import { segmentRows } from '@/db/hosted/authority/classification-manifest'
import { splitSqlStatements } from '@/db/hosted/authority/sql-statements'
import { parseStatementIdentity } from '@/db/hosted/authority/structural-identity'
import { GOVERNED_PINS } from '@/db/hosted/authority/governed-manifest'
import { AuthorityRefusal } from '@/db/hosted/authority/window-contract'
import path from 'node:path'

const built = buildGovernedChain()
const { plan, packages } = built
const dispositions = resolveExecutionDispositions(plan)

const pkg = (id: string) => packages.find((p) => p.packageId === id)!
const revalidate = (generated: (typeof packages)[number]) => validateGeneratedPackage(plan, generated)

/* -------------------------------------------------------------------------- */
/* The chain that was produced                                                 */
/* -------------------------------------------------------------------------- */

describe('the governed chain', () => {
  it('is eleven packages, published and matching a fresh regeneration', () => {
    // TEN since M-8, ELEVEN since M-2. grounding_0005 was the first chain
    // package whose classification windows are AUTHORED rather than recovered;
    // stella_0019 is the second, and the first whose authored window is OWNER
    // class rather than CAPABILITY — it repairs a BASELINE function owned by
    // uellix_owner, so there is no capability role to become. Both go through
    // every gate below unchanged, which is the property the split between
    // recovered and authored boundaries was designed to preserve.
    expect(packages).toHaveLength(11)
    expect(verifyGovernedChain()).toEqual([])
  })

  it('consumes 54 windows, 62 segments and 11 transfer segments', () => {
    // 51 recovered + 3 authored; 59 + 3. TRANSFERS DID NOT MOVE, and that is
    // the load-bearing half of this line — now twice over. grounding_0005
    // republishes a function the capability role ALREADY owns and stella_0019
    // republishes one uellix_owner ALREADY owns; `CREATE OR REPLACE` preserves
    // the owner in both cases, so a package that repairs a routine adds no
    // ownership transfer at all. A twelfth transfer here would mean a repair
    // had moved an object between owners, which is not something either is
    // allowed to do — and stella_0019's §2 measures the owner before and after
    // rather than trusting this count alone.
    expect(plan.windows).toHaveLength(54)
    expect(plan.segments).toHaveLength(62)
    expect(plan.segments.filter((s) => s.authorityClass === 'OWNER_TRANSFER')).toHaveLength(11)
  })

  it('carries every canonical statement except the replaced bookkeeping', () => {
    // 385 parsed statements, 18 of them the canonical SET ROLE / RESET ROLE the
    // governed output replaces outright.
    //
    // 372 -> 378 is grounding_0005's six: two SET, its §0 precondition block,
    // the CREATE OR REPLACE, the COMMENT and its §2 self-verification block.
    // The SIXTEEN did not move there: that package states no canonical SET ROLE
    // bookkeeping of its own — it was written for a chain that already derives
    // its authority — so there was nothing new to replace.
    //
    // 378 -> 385 is stella_0019's seven: two SET, its §0 precondition block, a
    // SET ROLE, the CREATE OR REPLACE, a RESET ROLE and its §2 self-verification
    // block. It issues NO COMMENT — unlike M-8 there is no stale one to correct.
    // And SIXTEEN -> EIGHTEEN is exactly that SET ROLE / RESET ROLE pair: this
    // package DOES state its own owner window, in the shape grounding_0002 §2
    // uses, so that the canonical file is applicable on its own as superuser
    // and the governed derivation has a window to replace rather than invent.
    const canonical = packages.reduce((n, p) => n + p.counts.generatedExecutable, 0)
    const input = packages.reduce((n, p) => n + p.counts.canonicalExecutable, 0)

    expect(input).toBe(385)
    expect(canonical).toBe(367)
    expect(input - canonical).toBe(18)
  })

  it('opens 65 temporary membership lifecycles: 62 segments plus 3 owner contexts', () => {
    const memberships = packages.reduce((n, p) => n + p.counts.temporaryMembershipLifecycles, 0)
    const contexts = packages.reduce((n, p) => n + p.counts.canonicalContext, 0)

    expect(contexts).toBe(3)
    expect(memberships).toBe(plan.segments.length + contexts)
  })

  // UNMOVED by M-2: stella_0019's W54 is OWNER class and creates nothing in a
  // schema uellix_owner does not already hold CREATE on, so
  // requiredTemporarySchemaCreate resolves to null and no lifecycle opens.
  it('opens 15 temporary schema CREATE lifecycles: 11 transfers plus 4 capability segments', () => {
    const creates = packages.reduce((n, p) => n + p.counts.temporarySchemaCreateLifecycles, 0)
    const capabilityCreates = plan.segments.filter(
      (s) => s.authorityClass === 'CAPABILITY' && s.requiredTemporarySchemaCreate !== null,
    )

    // W52.S1 is M-8's, and the list is where the design decision shows: its
    // sibling W53.S1 writes the COMMENT and is NOT here. One window per
    // statement costs an extra open/close and keeps CREATE on uellix_grounding
    // scoped to the single statement PostgreSQL will not run without it.
    expect(capabilityCreates.map((s) => s.segmentId)).toEqual(['W38.S2', 'W44.S1', 'W49.S1', 'W52.S1'])
    expect(creates).toBe(11 + 4)
  })

  it('transfers 27 functions, every one to the destination its segment declares', () => {
    const transfers = plan.segments
      .filter((s) => s.authorityClass === 'OWNER_TRANSFER')
      .flatMap((s) => segmentRows(plan, s).map((r) => ({ s, r })))

    expect(transfers).toHaveLength(27)
    for (const { s, r } of transfers) {
      expect(r.identity.object!.objectClass).toBe('function')
      expect(r.ownerDestination).toBe(s.ownerDestination)
      expect(s.executor).toBe('uellix_owner')
    }
  })

  it('is deterministic: two independent generations are byte-identical', () => {
    expect(() => assertDeterministicGeneration()).not.toThrow()
  })

  it('pins the source, the plan and the output separately', () => {
    expect(GOVERNED_PINS).toHaveLength(11)
    for (const generated of packages) {
      const pin = GOVERNED_PINS.find((p) => p.packageId === generated.packageId)!
      expect(pin.sourceDigest).toBe(generated.sourceDigest)
      expect(pin.generatedDigest).toBe(generated.generatedDigest)
    }
  })

  it('writes nothing outside the governed directory', () => {
    for (const generated of packages) {
      const file = path.join(governedArtefactDir(), generated.fileName)
      expect(readFileSync(file, 'utf8')).toBe(generated.sql)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The three canonical owner contexts                                          */
/* -------------------------------------------------------------------------- */

describe('the canonical owner-context obligations', () => {
  it('creates all three tables as uellix_owner, never as the installer', () => {
    // The failure this prevents is silent: CREATE TABLE makes the executing
    // role the owner, so running these unelevated would produce three tables
    // owned by postgres and nothing would error.
    const contexts = dispositions.filter((d) => d.kind === 'CANONICAL_ROLE_CONTEXT')

    expect(contexts.map((c) => `${c.packageId}:${c.statementIdentity}`)).toEqual([
      'T1:create-table:table:public.evidence_document_versions',
      'T2:create-table:table:public.evidence_chunks',
      'T5:create-table:table:uellix_stella_ops.operation_tickets',
    ])
    for (const context of contexts) expect(context.requiredExecutor).toBe('uellix_owner')
  })

  it('surrounds each of them with an owner window in the emitted SQL', () => {
    for (const id of ['T1', 'T2', 'T5']) {
      const generated = pkg(id)
      const at = generated.statements.findIndex(
        (s) => s.origin === 'canonical' && s.sql.includes('CREATE TABLE IF NOT EXISTS'),
      )
      const before = generated.statements.slice(0, at).map((s) => s.sql)

      expect(before.some((sql) => sql.includes('SET ROLE uellix_owner;'))).toBe(true)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* W46 and W47                                                                 */
/* -------------------------------------------------------------------------- */

describe('the multi-role windows survive generation', () => {
  it('W46 transfers quota fully, closes, and only then opens ticket', () => {
    const generated = pkg('T8')
    const emitted = generated.statements.map((s) => s.sql)
    const quotaOpen = emitted.findIndex((s) => s.includes('GRANT uellix_cap_stella_quota TO uellix_owner'))
    const quotaClose = emitted.findIndex((s) => s.includes('REVOKE uellix_cap_stella_quota FROM uellix_owner'))
    const ticketOpen = emitted.findIndex((s) => s.includes('GRANT uellix_cap_stella_ticket TO uellix_owner'))

    expect(quotaOpen).toBeGreaterThan(-1)
    expect(quotaClose).toBeGreaterThan(quotaOpen)
    expect(ticketOpen).toBeGreaterThan(quotaClose)
  })

  it('W47 keeps all six capability segments, alternating as the canonical order does', () => {
    const segments = plan.segments.filter((s) => s.classificationWindowId === 'W47')

    expect(segments.map((s) => s.executor)).toEqual([
      'uellix_cap_stella_quota',
      'uellix_cap_stella_ticket',
      'uellix_cap_stella_quota',
      'uellix_cap_stella_ticket',
      'uellix_cap_stella_quota',
      'uellix_cap_stella_ticket',
    ])
  })

  it('emits six SET ROLE transitions for W47, not one', () => {
    const generated = pkg('T8')
    const w47 = generated.statements.filter((s) => s.segmentId?.startsWith('W47.'))
    const sets = w47.filter((s) => s.sql.startsWith('SET ROLE uellix_cap_'))

    expect(sets).toHaveLength(6)
  })
})

/* -------------------------------------------------------------------------- */
/* The generated SQL, checked statically                                       */
/* -------------------------------------------------------------------------- */

describe('static checks over the emitted SQL', () => {
  it('leaves no unresolved placeholder in anything the generator emitted', () => {
    // Scoped to AUTHORITY statements on purpose: a canonical PL/pgSQL body may
    // legitimately contain `format('%I', ...)`, and flagging that would be a
    // false positive on the packages' own code.
    for (const generated of packages) {
      for (const statement of generated.statements.filter((s) => s.origin === 'authority')) {
        expect(statement.sql, `${generated.packageId}: ${statement.sql}`).not.toMatch(/%[IsL]\b/)
        expect(statement.sql, `${generated.packageId}: ${statement.sql}`).not.toMatch(/\bSCHEMA\s*;/)
      }
    }
  })

  it('never names a session principal as a grantee, anywhere', () => {
    for (const generated of packages) {
      expect(generated.sql, generated.packageId).not.toMatch(/\bTO\s+CURRENT_(USER|ROLE)\b/i)
      expect(generated.sql, generated.packageId).not.toMatch(/\bTO\s+SESSION_USER\b/i)
    }
  })

  it('balances SET ROLE against RESET ROLE in every package', () => {
    for (const generated of packages) {
      const statements = splitSqlStatements(generated.sql).map((s) =>
        parseStatementIdentity(s.raw),
      )
      const sets = statements.filter((s) => s.statementClass === 'set-role').length
      const resets = statements.filter((s) => s.statementClass === 'reset-role').length

      expect(sets, generated.packageId).toBe(resets)
    }
  })

  it('passes its own output validator, package by package', () => {
    for (const generated of packages) {
      expect(() => revalidate(generated), generated.packageId).not.toThrow()
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Mutations — each one must be refused                                        */
/* -------------------------------------------------------------------------- */

describe('self red-team', () => {
  const mutate = (id: string, from: string, to: string) => {
    const generated = pkg(id)
    const statements = generated.statements.map((s) =>
      s.sql.includes(from) ? { ...s, sql: s.sql.replace(from, to) } : s,
    )
    return { ...generated, statements, sql: statements.map((s) => s.sql).join('\n') }
  }

  it('1/6: a transfer whose target capability is swapped', () => {
    const broken = mutate('T9', 'GRANT uellix_cap_stella_ticket TO uellix_owner', 'GRANT uellix_cap_stella_quota TO uellix_owner')
    expect(() => revalidate(broken)).toThrow(AuthorityRefusal)
  })

  it('4: a transfer that never revokes its temporary membership', () => {
    const generated = pkg('T9')
    const statements = generated.statements.filter(
      (s) => !s.sql.startsWith('REVOKE uellix_cap_stella_ticket FROM uellix_owner'),
    )
    const broken = { ...generated, statements, sql: statements.map((s) => s.sql).join('\n') }

    expect(() => revalidate(broken)).toThrow(/AUTHORITY_CLEANUP_INCOMPLETE/)
  })

  it('5: a transfer that never revokes its temporary schema CREATE', () => {
    const generated = pkg('T9')
    const statements = generated.statements.filter((s) => !s.sql.startsWith('REVOKE CREATE ON SCHEMA'))
    const broken = { ...generated, statements, sql: statements.map((s) => s.sql).join('\n') }

    expect(() => revalidate(broken)).toThrow(/AUTHORITY_CLEANUP_INCOMPLETE/)
  })

  it('8: a temporary membership granted WITH SET FALSE', () => {
    const broken = mutate('T9', 'WITH INHERIT FALSE, SET TRUE;', 'WITH INHERIT FALSE, SET FALSE;')
    expect(() => revalidate(broken)).toThrow(AuthorityRefusal)
  })

  it('10: a runtime principal as the temporary member', () => {
    const broken = mutate('T9', 'TO uellix_migrator WITH INHERIT FALSE', 'TO uellix_app WITH INHERIT FALSE')
    expect(() => revalidate(broken)).toThrow(AuthorityRefusal)
  })

  it('11: an owner-context CREATE TABLE demoted to the installer', () => {
    const generated = pkg('T1')
    const at = generated.statements.findIndex(
      (s) => s.origin === 'canonical' && s.sql.includes('CREATE TABLE IF NOT EXISTS public.evidence_document_versions'),
    )
    // Close the owner window one statement early: the CREATE TABLE then runs
    // unelevated and PostgreSQL would silently make the installer its owner.
    const statements = [
      ...generated.statements.slice(0, at),
      { origin: 'authority' as const, sql: 'RESET ROLE;', sourceIndex: null, segmentId: 'mutation' },
      ...generated.statements.slice(at),
    ]
    const broken = { ...generated, statements, sql: statements.map((s) => s.sql).join('\n') }

    expect(() => revalidate(broken)).toThrow(AuthorityRefusal)
  })

  it('12: an authority GRANT the event model does not understand', () => {
    const generated = pkg('T9')
    const statements = [
      { origin: 'authority' as const, sql: 'GRANT ALL ON DATABASE postgres TO uellix_app;', sourceIndex: null, segmentId: 'mutation' },
      ...generated.statements,
    ]
    const broken = { ...generated, statements, sql: statements.map((s) => s.sql).join('\n') }

    expect(() => revalidate(broken)).toThrow(AuthorityRefusal)
  })

  it('13: a dynamic CURRENT_USER grantee injected into the output', () => {
    const generated = pkg('T9')
    const statements = [
      ...generated.statements,
      { origin: 'authority' as const, sql: 'GRANT uellix_owner TO CURRENT_USER;', sourceIndex: null, segmentId: 'mutation' },
    ]
    const broken = { ...generated, statements, sql: statements.map((s) => s.sql).join('\n') }

    expect(() => revalidate(broken)).toThrow(/AUTHORITY_MEMBERSHIP_SELF_REFERENCE/)
  })

  it('14: two canonical statements swapped', () => {
    const generated = pkg('T9')
    const canonicalPositions = generated.statements
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.origin === 'canonical')
    const [a, b] = canonicalPositions.slice(-2)
    const statements = [...generated.statements]
    const tmp = statements[a.i]
    statements[a.i] = statements[b.i]
    statements[b.i] = tmp
    const broken = { ...generated, statements, sql: statements.map((s) => s.sql).join('\n') }

    expect(() => revalidate(broken)).toThrow(/AUTHORITY_CANONICAL_ORDER_VIOLATION|AUTHORITY_EXECUTOR_ROLE_MISMATCH|AUTHORITY_EXECUTION_CONTEXT_UNRESOLVED/)
  })

  it('15: a canonical statement deleted', () => {
    const generated = pkg('T9')
    const at = generated.statements.map((s, i) => ({ s, i })).filter(({ s }) => s.origin === 'canonical').slice(-1)[0].i
    const statements = generated.statements.filter((_, i) => i !== at)
    const broken = { ...generated, statements, sql: statements.map((s) => s.sql).join('\n') }

    expect(() => revalidate(broken)).toThrow(/AUTHORITY_CANONICAL_ORDER_VIOLATION/)
  })

  it('16: a same-class canonical statement added', () => {
    const generated = pkg('T9')
    const statements = [
      ...generated.statements,
      {
        origin: 'canonical' as const,
        sql: 'COMMENT ON FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, varchar(50), char(64)) IS \'injected\';',
        sourceIndex: 999,
        segmentId: null,
      },
    ]
    const broken = { ...generated, statements, sql: statements.map((s) => s.sql).join('\n') }

    expect(() => revalidate(broken)).toThrow(AuthorityRefusal)
  })

  it('18: publication is all-or-nothing when generation fails midway', () => {
    // The set on disk must be the previous complete one, never a mixture.
    expect(() => buildGovernedChain({ failAfterPackages: 4 })).toThrow(AuthorityRefusal)
    expect(verifyGovernedChain()).toEqual([])
  })

  it('19: the plan digest moves when an executor changes', () => {
    // Pins bind three independent things; this is the one that catches a plan
    // change over byte-identical inputs.
    const mutatedPlan = {
      ...plan,
      segments: plan.segments.map((s) =>
        s.segmentId === 'W47.S1' ? { ...s, executor: 'uellix_cap_stella_ticket' } : s,
      ),
    }

    expect(() => generateGovernedPackage(mutatedPlan, 'T8', dispositions)).not.toThrow()
    const regenerated = generateGovernedPackage(mutatedPlan, 'T8', dispositions)
    expect(() => validateGeneratedPackage(plan, regenerated)).toThrow(AuthorityRefusal)
  })
})
