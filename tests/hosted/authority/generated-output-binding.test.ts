// tests/hosted/authority/generated-output-binding.test.ts
// COMMIT 5 — the two findings the independent review of Commit 4 left open,
// and the mutations that prove each is now closed.
//
// ---------------------------------------------------------------------------
// WHY THESE TWO NEEDED THEIR OWN FILE
// ---------------------------------------------------------------------------
// Both defects were INVISIBLE to the twenty mutations in
// governed-generation.test.ts, and invisible for the same reason: those
// mutations break the SHAPE of a lifecycle — a missing revoke, a swapped target,
// a statement deleted — and both of these leave the shape perfectly intact.
//
//   F-C4-01  the temporary `GRANT CREATE ON SCHEMA` was matched as a substring.
//            A grant naming a DIFFERENT schema, or a different grantee, is in
//            the right position, in the right order, and balances against its
//            own revoke. Every existing check passed it.
//
//   F-C4-02  the concurrency check counted what the INSTALLER could reach. The
//            measured transfer lifecycle grants the capability to uellix_owner
//            and never to the installer, so the check named after the W46
//            mutation could not see that mutation in any of the eleven segments
//            where it is possible.
//
// The mutations below are therefore all BALANCED and all WELL-FORMED. That is
// the point: a check that only fires on malformed output is a check that fires
// on the cases somebody was already going to notice.

import { describe, expect, it } from 'vitest'

import { buildGovernedChain } from '@/db/hosted/authority/governed-publication'
import { validateGeneratedPackage } from '@/db/hosted/authority/generated-output-validator'
import type { AuthorityPlan } from '@/db/hosted/authority/classification-manifest'
import type { GeneratedGovernedPackage } from '@/db/hosted/authority/governed-generator'
import { AuthorityRefusal } from '@/db/hosted/authority/window-contract'

const built = buildGovernedChain()
const { plan, packages } = built

const pkg = (id: string): GeneratedGovernedPackage =>
  packages.find((p) => p.packageId === id) as GeneratedGovernedPackage

/** Rebuilds a package from a mutated statement list, sql and all. */
const rebuild = (
  generated: GeneratedGovernedPackage,
  statements: GeneratedGovernedPackage['statements'],
): GeneratedGovernedPackage => ({
  ...generated,
  statements,
  sql: statements.map((s) => s.sql).join('\n'),
})

/** Replaces exact statement text wherever it appears. */
const replaceStatements = (
  generated: GeneratedGovernedPackage,
  from: string,
  to: string,
): GeneratedGovernedPackage => {
  const statements = generated.statements.map((s) =>
    s.sql.trim() === from ? { ...s, sql: to } : s,
  )
  expect(
    statements.some((s) => s.sql === to),
    `mutation target not present: ${from}`,
  ).toBe(true)
  return rebuild(generated, statements)
}

/* -------------------------------------------------------------------------- */
/* The chain as generated still passes                                         */
/* -------------------------------------------------------------------------- */

describe('the governed chain under the strengthened output validator', () => {
  it('validates unchanged, package by package', () => {
    for (const generated of packages) {
      expect(() => validateGeneratedPackage(plan, generated), generated.packageId).not.toThrow()
    }
  })

  it('reports the two new binding checks among its evidence', () => {
    const checks = validateGeneratedPackage(plan, pkg('T9')).checks.join('\n')
    expect(checks).toMatch(/act in one schema/)
  })
})

/* -------------------------------------------------------------------------- */
/* F-C4-01 — the temporary CREATE is bound, not merely shaped                  */
/* -------------------------------------------------------------------------- */

describe('F-C4-01: the temporary schema CREATE binds a schema and a grantee', () => {
  // The transfer segment of T9: uellix_stella_ops, target uellix_cap_stella_ticket.
  const GRANT = 'GRANT CREATE ON SCHEMA uellix_stella_ops TO uellix_cap_stella_ticket;'
  const REVOKE = 'REVOKE CREATE ON SCHEMA uellix_stella_ops FROM uellix_cap_stella_ticket;'

  it('refuses the correct target opened on the WRONG schema', () => {
    // Balanced — grant and revoke move together — so the cleanup checker is
    // satisfied and the case-G order is intact. Only a check that compares the
    // schema against the one the segment's own ALTERs act in can see this.
    let broken = replaceStatements(
      pkg('T9'),
      GRANT,
      'GRANT CREATE ON SCHEMA public TO uellix_cap_stella_ticket;',
    )
    broken = replaceStatements(
      broken,
      REVOKE,
      'REVOKE CREATE ON SCHEMA public FROM uellix_cap_stella_ticket;',
    )

    expect(() => validateGeneratedPackage(plan, broken)).toThrow(
      /AUTHORITY_TEMPORARY_CREATE_BINDING_MISMATCH/,
    )
  })

  it('refuses the correct schema opened for the WRONG grantee', () => {
    // The other capability role. Also balanced, also in order — and it hands
    // CREATE on uellix_stella_ops to a role whose lifecycle is not even open.
    let broken = replaceStatements(
      pkg('T9'),
      GRANT,
      'GRANT CREATE ON SCHEMA uellix_stella_ops TO uellix_cap_stella_quota;',
    )
    broken = replaceStatements(
      broken,
      REVOKE,
      'REVOKE CREATE ON SCHEMA uellix_stella_ops FROM uellix_cap_stella_quota;',
    )

    expect(() => validateGeneratedPackage(plan, broken)).toThrow(
      /AUTHORITY_TEMPORARY_CREATE_BINDING_MISMATCH/,
    )
  })

  it('refuses a transfer segment whose statements span two schemas', () => {
    // Nothing about the OUTPUT changes here: the mutation is in the plan, which
    // is what decides how many schemas a segment covers. `requiredTemporary
    // SchemaCreate` is derived from the segment's FIRST statement alone, so a
    // second schema would be transferred with no CREATE open for it at all.
    const transfer = plan.segments.find(
      (s) => s.packageId === 'T9' && s.authorityClass === 'OWNER_TRANSFER',
    )
    expect(transfer).toBeDefined()

    const window = plan.windows.find((w) => w.windowId === transfer!.classificationWindowId)!
    const members = window.members.map((row, i) =>
      i === window.members.length - 1 && row.identity.object !== null
        ? { ...row, identity: { ...row.identity, object: { ...row.identity.object, schema: 'public' } } }
        : row,
    )
    const mutatedPlan: AuthorityPlan = {
      ...plan,
      windows: plan.windows.map((w) => (w.windowId === window.windowId ? { ...w, members } : w)),
    }

    expect(() => validateGeneratedPackage(mutatedPlan, pkg('T9'))).toThrow(
      /AUTHORITY_TRANSFER_SEGMENT_MULTIPLE_SCHEMAS/,
    )
  })

  it('refuses a transfer that opens no temporary CREATE at all', () => {
    const generated = pkg('T9')
    const statements = generated.statements.filter(
      (s) => s.sql.trim() !== GRANT || s.segmentId === null,
    )
    // Removing only the grant unbalances the window, which an existing check
    // already catches; removing BOTH leaves a transfer with no CREATE, which is
    // what PostgreSQL refuses at apply time (S1-DEFECT-001).
    const both = statements.filter((s) => s.sql.trim() !== REVOKE)

    expect(() => validateGeneratedPackage(plan, rebuild(generated, both))).toThrow(AuthorityRefusal)
  })
})

/* -------------------------------------------------------------------------- */
/* F-C4-02 — concurrency counted over every member, not only the installer     */
/* -------------------------------------------------------------------------- */

describe('F-C4-02: open capability memberships are counted whoever holds them', () => {
  it('refuses quota and ticket standing open at the same time in W46', () => {
    // THE MUTATION THE OLD CHECK COULD NOT SEE. Nothing is added and nothing is
    // removed: the quota revoke is MOVED to after the ticket grant. The package
    // still balances perfectly, the case-G order of each segment is intact, and
    // for the length of two statements uellix_owner can become both capability
    // roles at once.
    const generated = pkg('T8')
    const QUOTA_REVOKE = 'REVOKE uellix_cap_stella_quota FROM uellix_owner;'
    const TICKET_GRANT =
      'GRANT uellix_cap_stella_ticket TO uellix_owner WITH INHERIT FALSE, SET TRUE;'

    const at = generated.statements.findIndex((s) => s.sql.trim() === QUOTA_REVOKE)
    const ticketAt = generated.statements.findIndex((s) => s.sql.trim() === TICKET_GRANT)
    expect(at).toBeGreaterThan(-1)
    expect(ticketAt).toBeGreaterThan(at)

    const moved = generated.statements.filter((_, i) => i !== at)
    const insertAt = moved.findIndex((s) => s.sql.trim() === TICKET_GRANT) + 1
    const statements = [
      ...moved.slice(0, insertAt),
      generated.statements[at],
      ...moved.slice(insertAt),
    ]

    expect(() => validateGeneratedPackage(plan, rebuild(generated, statements))).toThrow(
      /AUTHORITY_CONCURRENT_CAPABILITY_LIFECYCLES/,
    )
  })

  it('refuses a temporary capability membership no segment declares', () => {
    // A single extra grant, revoked before the package ends so the cleanup
    // checker stays quiet. The old check would have seen an installer that
    // reaches one capability — which is what a capability window looks like.
    const generated = pkg('T1')
    const statements = [
      ...generated.statements,
      {
        origin: 'authority' as const,
        sql: 'GRANT uellix_cap_stella_ticket TO uellix_owner WITH INHERIT FALSE, SET TRUE;',
        sourceIndex: null,
        segmentId: 'mutation',
      },
      {
        origin: 'authority' as const,
        sql: 'REVOKE uellix_cap_stella_ticket FROM uellix_owner;',
        sourceIndex: null,
        segmentId: 'mutation',
      },
    ]

    expect(() => validateGeneratedPackage(plan, rebuild(generated, statements))).toThrow(
      /AUTHORITY_UNDECLARED_CAPABILITY_MEMBERSHIP/,
    )
  })

  it('still refuses a runtime principal reaching a capability', () => {
    // The pre-existing property, kept: the rewrite must not have traded one
    // reachability check for the other.
    const generated = pkg('T9')
    const statements = generated.statements.map((s) =>
      s.sql.trim() === 'GRANT uellix_cap_stella_ticket TO uellix_migrator WITH INHERIT FALSE, SET TRUE;'
        ? { ...s, sql: 'GRANT uellix_cap_stella_ticket TO uellix_app WITH INHERIT FALSE, SET TRUE;' }
        : s,
    )

    expect(() => validateGeneratedPackage(plan, rebuild(generated, statements))).toThrow(
      AuthorityRefusal,
    )
  })
})
