// tests/hosted/authority/window-plan.test.ts
// COMMIT 3 — the invariants a plan must satisfy, checked WITHOUT reusing the
// derivation that produced it.
//
// The failure this file exists to prevent is collusion: a generator computes a
// window boundary with algorithm A, a validator re-computes it with algorithm A,
// the two agree, and the suite reports PASS over a plan that is wrong in both
// halves. Sharing the lexical splitter is fine and unavoidable — both sides have
// to agree on what a statement IS. What must NOT be shared is the reasoning that
// decided where a window starts.
//
// So each invariant below is stated as a property of the FINISHED plan, checkable
// against the packages alone:
//
//   1. every governed StatementIdentity is unique within its package;
//   2. the global window counts are what the plan claims;
//   3. every anchor resolves to exactly one statement;
//   4. the canonical order of governed statements is preserved;
//   5. no installer-only class appears inside an elevated window;
//   6. every window's digest sequence is exact.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import { splitSqlStatements } from '@/db/hosted/authority/sql-statements'
import { parseStatementIdentity, statementIdentityKey } from '@/db/hosted/authority/structural-identity'
import {
  AuthorityRefusal,
  statementIdentityKeys,
  type AuthorityWindow,
} from '@/db/hosted/authority/window-contract'
import {
  assertCanonicalSubsequence,
  assertGovernedIdentitiesUnique,
  assertNoInstallerOnlyInElevatedWindow,
  assertNoWindowOverlap,
  assertWindowTotals,
  CHAIN_PACKAGE_FILES,
  INSTALLER_ONLY_CLASSES,
} from '@/db/hosted/authority/window-plan'

/* -------------------------------------------------------------------------- */
/* Invariant 1 — governed identities are unique                                */
/* -------------------------------------------------------------------------- */

describe('assertGovernedIdentitiesUnique', () => {
  it('accepts a package whose governed statements are all distinct', () => {
    const statements = splitSqlStatements(
      ['GRANT USAGE ON SCHEMA s TO a;', 'GRANT USAGE ON SCHEMA s TO b;'].join('\n'),
    )

    expect(() => assertGovernedIdentitiesUnique('T0', statements)).not.toThrow()
  })

  it('refuses two governed statements that share one identity', () => {
    const statements = splitSqlStatements(
      ['GRANT USAGE ON SCHEMA s TO a;', 'GRANT  USAGE  ON SCHEMA s TO a;'].join('\n'),
    )

    expect(() => assertGovernedIdentitiesUnique('T0', statements)).toThrow(
      /AUTHORITY_STATEMENT_IDENTITY_DUPLICATE/,
    )
  })

  it('tolerates duplicate BOOKKEEPING statements, which are never anchors', () => {
    // `SET ROLE uellix_owner` twice in one package is normal and harmless: the
    // plan never anchors on one. Refusing it would force the plan to invent an
    // occurrence index for exactly the statements that least need identity.
    const statements = splitSqlStatements(
      ['SET ROLE uellix_owner;', 'GRANT USAGE ON SCHEMA s TO a;', 'RESET ROLE;', 'SET ROLE uellix_owner;', 'RESET ROLE;'].join('\n'),
    )

    expect(() => assertGovernedIdentitiesUnique('T0', statements)).not.toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/* Invariant 2 — the totals                                                    */
/* -------------------------------------------------------------------------- */

describe('assertWindowTotals', () => {
  const window = (authority: AuthorityWindow['authority'], id: string): AuthorityWindow => ({
    packageId: 'T1',
    windowId: id,
    authority,
    schema: null,
    needsTemporaryMembership: true,
    needsTemporarySchemaCreate: false,
    start: 'x',
    end: 'x',
    expectedStatementCount: 1,
    allowedStatementClasses: [],
    statementDigestSequence: ['d'],
  })

  it('accepts a plan whose counts match what it declares', () => {
    const windows = [window('owner', 'W01'), window('capability', 'W02'), window('transfer', 'W03')]

    expect(() => assertWindowTotals(windows, { owner: 1, capability: 1, transfer: 1 })).not.toThrow()
  })

  it('refuses a plan that has drifted from its declared totals', () => {
    const windows = [window('owner', 'W01'), window('owner', 'W02')]

    expect(() => assertWindowTotals(windows, { owner: 1, capability: 0, transfer: 0 })).toThrow(
      /AUTHORITY_WINDOW_COUNT_TOTALS/,
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Invariant 4 — the canonical order survives derivation                       */
/* -------------------------------------------------------------------------- */

describe('assertCanonicalSubsequence', () => {
  it('accepts derived output that interleaves bookkeeping but keeps canonical order', () => {
    const canonical = ['a', 'b', 'c']
    const derived = ['set-role:uellix_owner', 'a', 'b', 'reset-role', 'set-role:x', 'c']

    expect(() =>
      assertCanonicalSubsequence(canonical, derived, new Set(['set-role:uellix_owner', 'reset-role', 'set-role:x'])),
    ).not.toThrow()
  })

  it('refuses derived output that swaps two canonical statements', () => {
    const canonical = ['a', 'b', 'c']
    const derived = ['a', 'c', 'b']

    expect(() => assertCanonicalSubsequence(canonical, derived, new Set())).toThrow(
      /AUTHORITY_CANONICAL_ORDER_VIOLATION/,
    )
  })

  it('refuses derived output that drops a canonical statement', () => {
    const canonical = ['a', 'b', 'c']
    const derived = ['a', 'c']

    expect(() => assertCanonicalSubsequence(canonical, derived, new Set())).toThrow(
      /AUTHORITY_CANONICAL_ORDER_VIOLATION/,
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Invariant 5 — installer-only statements never sit in an elevated window     */
/* -------------------------------------------------------------------------- */

describe('assertNoInstallerOnlyInElevatedWindow', () => {
  it('names CREATE ROLE and role membership as installer-only', () => {
    expect(INSTALLER_ONLY_CLASSES).toContain('create-role')
    expect(INSTALLER_ONLY_CLASSES).toContain('alter-role')
    expect(INSTALLER_ONLY_CLASSES).toContain('grant-membership')
    expect(INSTALLER_ONLY_CLASSES).toContain('revoke-membership')
  })

  it('refuses a CREATE ROLE inside an owner window', () => {
    const statements = splitSqlStatements(
      ['GRANT USAGE ON SCHEMA s TO a;', 'CREATE ROLE uellix_cap_x;', 'GRANT USAGE ON SCHEMA s TO b;'].join('\n'),
    )

    expect(() => assertNoInstallerOnlyInElevatedWindow('T1/W01', statements)).toThrow(
      /AUTHORITY_INSTALLER_ONLY_IN_ELEVATED_WINDOW/,
    )
  })

  it('refuses a role membership grant inside a capability window', () => {
    const statements = splitSqlStatements(
      ['GRANT EXECUTE ON FUNCTION s.f() TO a;', 'GRANT uellix_owner TO uellix_migrator;'].join('\n'),
    )

    expect(() => assertNoInstallerOnlyInElevatedWindow('T1/W02', statements)).toThrow(
      /AUTHORITY_INSTALLER_ONLY_IN_ELEVATED_WINDOW/,
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Overlap                                                                     */
/* -------------------------------------------------------------------------- */

describe('assertNoWindowOverlap', () => {
  it('accepts adjacent windows', () => {
    expect(() =>
      assertNoWindowOverlap('T1', [
        { windowId: 'W01', startIndex: 0, endIndex: 3 },
        { windowId: 'W02', startIndex: 4, endIndex: 6 },
      ]),
    ).not.toThrow()
  })

  it('refuses windows that share a statement', () => {
    expect(() =>
      assertNoWindowOverlap('T1', [
        { windowId: 'W01', startIndex: 0, endIndex: 4 },
        { windowId: 'W02', startIndex: 4, endIndex: 6 },
      ]),
    ).toThrow(/AUTHORITY_WINDOW_OVERLAP/)
  })
})

/* -------------------------------------------------------------------------- */
/* The real corpus                                                             */
/* -------------------------------------------------------------------------- */

describe('the ten chain packages, as they actually are', () => {
  const parsed = CHAIN_PACKAGE_FILES.map((entry) => ({
    ...entry,
    statements: splitSqlStatements(readFileSync(`db/prepared/${entry.sourceFile}`, 'utf8')),
  }))

  it('maps T1..T10 onto the chain in order', () => {
    expect(parsed.map((p) => p.packageId)).toEqual([
      'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10',
    ])
    expect(parsed[6].sourceFile).toBe('stella_0016_reserved_quota_semantics.sql')
    expect(parsed[8].sourceFile).toBe('stella_0018_category_bound_operation_tickets.sql')
    // T10 is a GROUNDING package sitting after six Stella ones, and the order
    // is the point: the chain is an application sequence, not a taxonomy. M-8's
    // repair could not be renumbered next to grounding_0002 without describing
    // an installation nobody performed.
    expect(parsed[9].sourceFile).toBe('grounding_0005_claim_advisory_lock.sql')
  })

  it('parses every statement of every package — no unmodelled form survives', () => {
    for (const { packageId, statements } of parsed) {
      for (const statement of statements) {
        expect(
          () => parseStatementIdentity(statement.raw),
          `${packageId} statement ${statement.index}: ${statement.executable.slice(0, 120)}`,
        ).not.toThrow()
      }
    }
  })

  it('has no duplicate GOVERNED identity in any package', () => {
    for (const { packageId, statements } of parsed) {
      expect(() => assertGovernedIdentitiesUnique(packageId, statements)).not.toThrow()
    }
  })

  it('confirms the measured claim: the only repeated identities are the T7 SET/RESET ROLE pairs', () => {
    // A_FINAL asserted this. It is re-measured here rather than trusted, because
    // "no duplicates exist" is an observation about today's packages and this
    // test is what turns it into a property of tomorrow's.
    const repeated: string[] = []
    for (const { packageId, statements } of parsed) {
      const seen = new Map<string, number>()
      for (const statement of statements) {
        const key = statementIdentityKey(parseStatementIdentity(statement.raw))
        seen.set(key, (seen.get(key) ?? 0) + 1)
      }
      for (const [key, n] of seen) if (n > 1) repeated.push(`${packageId}:${key}x${n}`)
    }

    expect(repeated.sort()).toEqual(['T7:reset-rolex2', 'T7:set-role:uellix_ownerx2'])
  })

  it('contains 27 ownership transfers, not the 28 a text search reports', () => {
    // The 28th is prose: grounding_0002 line 690 explains, in a comment, that
    // `ALTER FUNCTION ... OWNER TO` requires the new owner to hold CREATE. A
    // plan anchored on text would have counted it and produced a window with a
    // start anchor that is not a statement.
    const transfers = parsed.flatMap(({ statements }) =>
      statements.filter((s) => parseStatementIdentity(s.raw).statementClass === 'owner-transfer'),
    )

    expect(transfers).toHaveLength(27)
  })

  it('groups those transfers into exactly 10 contiguous runs — TRANSFER_WINDOWS', () => {
    // Measured, and stable across every classification variant tried: this is
    // the one window count that does not depend on a debatable boundary rule.
    let runs = 0
    for (const { statements } of parsed) {
      let previousWasTransfer = false
      for (const statement of statements) {
        const isTransfer =
          parseStatementIdentity(statement.raw).statementClass === 'owner-transfer'
        if (isTransfer && !previousWasTransfer) runs += 1
        previousWasTransfer = isTransfer
      }
    }

    expect(runs).toBe(10)
  })

  it('resolves every governed identity to exactly one statement', () => {
    for (const { packageId, statements } of parsed) {
      const keys = statementIdentityKeys(statements)
      const governed = keys.filter((key) => !key.startsWith('set-') && !key.startsWith('reset-'))
      const counts = new Map<string, number>()
      for (const key of governed) counts.set(key, (counts.get(key) ?? 0) + 1)
      for (const [key, n] of counts) {
        expect(n, `${packageId}: ${key} resolves to ${n} statements`).toBe(1)
      }
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Refusals are typed, not stringly                                            */
/* -------------------------------------------------------------------------- */

describe('AuthorityRefusal', () => {
  it('carries a machine-readable code so a caller can branch without parsing prose', () => {
    const refusal = new AuthorityRefusal('AUTHORITY_WINDOW_OVERLAP', 'detail')

    expect(refusal.code).toBe('AUTHORITY_WINDOW_OVERLAP')
    expect(refusal.message).toContain('AUTHORITY_WINDOW_OVERLAP')
  })
})
