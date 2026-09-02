// tests/hosted/authority/window-contract.test.ts
// COMMIT 3 — what a pinned authority window promises, and what breaks it.
//
// The contract deliberately pins FOUR things about a window and not two:
//
//   start / end anchors    WHERE it is, structurally;
//   expectedStatementCount HOW MANY statements it governs;
//   allowedStatementClasses WHAT KINDS may appear;
//   statementDigestSequence WHICH statements, in WHICH order, with WHICH bodies.
//
// Count plus classes is the tempting economy, and it is not enough. It cannot
// see a same-class replacement (swap one GRANT for another GRANT), it cannot see
// a reorder (the count and the classes are identical), and it cannot see a body
// mutation inside a DO block. Each of those is a real authority change. The
// digest sequence is what closes all three, so it is pinned even though it is
// the least readable field in the manifest.

import { describe, expect, it } from 'vitest'

import {
  AuthorityRefusal,
  resolveAnchor,
  resolveWindow,
  type AuthorityWindow,
} from '@/db/hosted/authority/window-contract'
import { splitSqlStatements } from '@/db/hosted/authority/sql-statements'
import {
  normalizedExecutableDigest,
  parseStatementIdentity,
  statementIdentityKey,
} from '@/db/hosted/authority/structural-identity'

/* -------------------------------------------------------------------------- */
/* A fixture package, small enough to reason about by eye                      */
/* -------------------------------------------------------------------------- */

const FIXTURE = [
  'REVOKE ALL ON SCHEMA uellix_grounding FROM PUBLIC;',
  'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_app;',
  'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_cap_grounding;',
  'GRANT SELECT ON public.evidence_items TO uellix_cap_grounding;',
].join('\n')

function digestsOf(sql: string, from: number, to: number): string[] {
  return splitSqlStatements(sql)
    .slice(from, to + 1)
    .map((s) => normalizedExecutableDigest(s.raw))
}

function keyAt(sql: string, index: number): string {
  const statement = splitSqlStatements(sql)[index]
  return statementIdentityKey(parseStatementIdentity(statement.raw))
}

/** The window covering statements 0..2 of FIXTURE, pinned every way it can be. */
function fixtureWindow(overrides: Partial<AuthorityWindow> = {}): AuthorityWindow {
  return {
    packageId: 'T0',
    windowId: 'W01',
    authority: 'owner',
    schema: 'uellix_grounding',
    needsTemporaryMembership: true,
    needsTemporarySchemaCreate: false,
    start: keyAt(FIXTURE, 0),
    end: keyAt(FIXTURE, 2),
    expectedStatementCount: 3,
    allowedStatementClasses: ['revoke-privilege', 'grant-privilege'],
    statementDigestSequence: digestsOf(FIXTURE, 0, 2),
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/* Anchor cardinality                                                          */
/* -------------------------------------------------------------------------- */

describe('anchor resolution is exactly-one or nothing', () => {
  it('resolves a unique anchor to its position', () => {
    const statements = splitSqlStatements(FIXTURE)

    expect(resolveAnchor(statements, keyAt(FIXTURE, 1), 'start')).toBe(1)
  })

  it('refuses when the anchor matches nothing', () => {
    const statements = splitSqlStatements(FIXTURE)

    expect(() => resolveAnchor(statements, 'grant-privilege:table:public.nope:SELECT:x', 'start'))
      .toThrow(/AUTHORITY_WINDOW_START_ANCHOR_MISSING/)
  })

  it('refuses when the anchor matches more than one statement, never first-match', () => {
    // Two textually identical statements. First-match would silently pick the
    // earlier one and produce a window that looks resolved and is not.
    const ambiguous = ['SET ROLE uellix_owner;', 'SELECT 1;', 'SET ROLE uellix_owner;'].join('\n')
    const statements = splitSqlStatements(ambiguous)

    expect(() => resolveAnchor(statements, 'set-role:uellix_owner', 'start')).toThrow(
      /AUTHORITY_WINDOW_START_ANCHOR_AMBIGUOUS/,
    )
  })

  it('names the END anchor when it is the end that is missing', () => {
    const statements = splitSqlStatements(FIXTURE)

    expect(() => resolveAnchor(statements, 'reset-role', 'end')).toThrow(
      /AUTHORITY_WINDOW_END_ANCHOR_MISSING/,
    )
  })
})

/* -------------------------------------------------------------------------- */
/* The window resolves, and every pinned field is load-bearing                 */
/* -------------------------------------------------------------------------- */

describe('resolveWindow', () => {
  it('accepts the package it was pinned against', () => {
    const resolved = resolveWindow(splitSqlStatements(FIXTURE), fixtureWindow())

    expect(resolved.startIndex).toBe(0)
    expect(resolved.endIndex).toBe(2)
    expect(resolved.statements).toHaveLength(3)
  })

  it('accepts a comment-only and whitespace-only edit — the digest is over executable text', () => {
    const edited = [
      '-- a newly added explanatory line',
      'REVOKE ALL ON SCHEMA uellix_grounding FROM PUBLIC;',
      'GRANT   USAGE ON SCHEMA uellix_grounding',
      '  TO uellix_app;  -- who and why',
      'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_cap_grounding;',
      'GRANT SELECT ON public.evidence_items TO uellix_cap_grounding;',
    ].join('\n')

    expect(() => resolveWindow(splitSqlStatements(edited), fixtureWindow())).not.toThrow()
  })

  it('refuses a statement inserted inside the window', () => {
    const edited = [
      'REVOKE ALL ON SCHEMA uellix_grounding FROM PUBLIC;',
      'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_app;',
      'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_writer;',
      'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_cap_grounding;',
      'GRANT SELECT ON public.evidence_items TO uellix_cap_grounding;',
    ].join('\n')

    expect(() => resolveWindow(splitSqlStatements(edited), fixtureWindow())).toThrow(
      /AUTHORITY_WINDOW_COUNT_DRIFT/,
    )
  })

  it('refuses an inserted statement even when its class is allowed', () => {
    // The insertion is a `grant-privilege`, which the window explicitly permits.
    // Class checking alone would wave it through; the count and the digest
    // sequence are what refuse it.
    const window = fixtureWindow({ expectedStatementCount: 4 })
    const edited = [
      'REVOKE ALL ON SCHEMA uellix_grounding FROM PUBLIC;',
      'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_app;',
      'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_writer;',
      'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_cap_grounding;',
    ].join('\n')

    expect(() => resolveWindow(splitSqlStatements(edited), window)).toThrow(
      /AUTHORITY_WINDOW_DIGEST_DRIFT/,
    )
  })

  it('refuses a statement removed from the window', () => {
    const edited = [
      'REVOKE ALL ON SCHEMA uellix_grounding FROM PUBLIC;',
      'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_cap_grounding;',
      'GRANT SELECT ON public.evidence_items TO uellix_cap_grounding;',
    ].join('\n')

    expect(() => resolveWindow(splitSqlStatements(edited), fixtureWindow())).toThrow(
      /AUTHORITY_WINDOW_COUNT_DRIFT/,
    )
  })

  it('refuses a reorder inside the window, which count and classes cannot see', () => {
    const edited = [
      'REVOKE ALL ON SCHEMA uellix_grounding FROM PUBLIC;',
      'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_cap_grounding;',
      'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_app;',
      'GRANT SELECT ON public.evidence_items TO uellix_cap_grounding;',
    ].join('\n')
    const window = fixtureWindow({ end: keyAt(edited, 2) })

    expect(() => resolveWindow(splitSqlStatements(edited), window)).toThrow(
      /AUTHORITY_WINDOW_DIGEST_DRIFT/,
    )
  })

  it('refuses a same-class replacement, which the count cannot see', () => {
    const edited = [
      'REVOKE ALL ON SCHEMA uellix_grounding FROM PUBLIC;',
      'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_app;',
      'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_writer;',
      'GRANT SELECT ON public.evidence_items TO uellix_cap_grounding;',
    ].join('\n')
    const window = fixtureWindow({ end: keyAt(edited, 2) })

    expect(() => resolveWindow(splitSqlStatements(edited), window)).toThrow(
      /AUTHORITY_WINDOW_DIGEST_DRIFT/,
    )
  })

  it('refuses a class the window does not permit, before it looks at digests', () => {
    const window = fixtureWindow({ allowedStatementClasses: ['grant-privilege'] })

    expect(() => resolveWindow(splitSqlStatements(FIXTURE), window)).toThrow(
      /AUTHORITY_WINDOW_CLASS_DRIFT/,
    )
  })
})

/* -------------------------------------------------------------------------- */
/* A body mutation is a window change                                          */
/* -------------------------------------------------------------------------- */

describe('body mutation', () => {
  const BODY = [
    'DO $$',
    'BEGIN',
    '  PERFORM 1;',
    'END $$;',
    'GRANT USAGE ON SCHEMA uellix_grounding TO uellix_app;',
  ].join('\n')

  function bodyWindow(sql: string): AuthorityWindow {
    return {
      packageId: 'T0',
      windowId: 'W02',
      authority: 'owner',
        schema: 'uellix_grounding',
      needsTemporaryMembership: true,
      needsTemporarySchemaCreate: false,
      start: keyAt(sql, 0),
      end: keyAt(sql, 1),
      expectedStatementCount: 2,
      allowedStatementClasses: ['do-block', 'grant-privilege'],
      statementDigestSequence: digestsOf(sql, 0, 1),
    }
  }

  it('accepts a comment added inside the DO body', () => {
    const edited = BODY.replace('  PERFORM 1;', '  -- explains why\n  PERFORM 1;')

    expect(() => resolveWindow(splitSqlStatements(edited), bodyWindow(BODY))).not.toThrow()
  })

  it('refuses a semantic change inside the DO body', () => {
    const edited = BODY.replace('PERFORM 1;', 'PERFORM 2;')

    // The DO block's identity IS its body digest, so a changed body no longer
    // answers to the pinned start anchor at all. Either refusal is fail-closed;
    // this asserts it is one of them and never silent acceptance.
    expect(() => resolveWindow(splitSqlStatements(edited), bodyWindow(BODY))).toThrow(
      AuthorityRefusal,
    )
  })
})
