// tests/hosted/authority/structural-identity.test.ts
// COMMIT 3 — structural identity for governed statements.
//
// This file exists because the authority plan needs to say "this window starts
// at THIS statement" in a way that survives an edit two hundred lines above it.
// Three candidate answers were rejected before the ones tested here:
//
//   line numbers      — a comment inserted anywhere above moves every anchor;
//   text prefixes     — `GRANT EXECUTE ON FUNCTION uellix_stella_ops.bind_` is
//                       a prefix of two different overloads;
//   occurrence index  — silently re-points at a different statement the moment
//                       an earlier one is added, which is the exact failure the
//                       index was introduced to paper over.
//
// What is tested instead is a triple: WHICH object, WHICH operation on it, and
// whether the audited CONTENT still hashes the same.

import { describe, expect, it } from 'vitest'

import {
  formatObjectIdentity,
  normalizeArgumentType,
  normalizedExecutableDigest,
  parseStatementIdentity,
  statementIdentityKey,
  UnsupportedStructuralIdentityError,
} from '@/db/hosted/authority/structural-identity'
import { splitSqlStatements } from '@/db/hosted/authority/sql-statements'

/* -------------------------------------------------------------------------- */
/* The lexical splitter                                                        */
/* -------------------------------------------------------------------------- */

describe('splitSqlStatements', () => {
  it('does not treat a semicolon inside a dollar-quoted body as a terminator', () => {
    const sql = [
      'DO $$',
      'BEGIN',
      "  RAISE NOTICE 'a; b';",
      '  PERFORM 1;',
      'END $$;',
      'SELECT 1;',
    ].join('\n')

    const statements = splitSqlStatements(sql)

    expect(statements).toHaveLength(2)
    expect(statements[0].executable).toContain('RAISE NOTICE')
    expect(statements[1].executable).toBe('SELECT 1;')
  })

  it('honours a tagged dollar quote and does not close on a bare $$ inside it', () => {
    const sql = ['DO $outer$', "  SELECT '$$';", '$outer$;', 'SELECT 2;'].join('\n')

    expect(splitSqlStatements(sql)).toHaveLength(2)
  })

  it('does not treat a semicolon inside a string literal or a comment as a terminator', () => {
    const sql = ["SELECT 'a;b' -- and; a comment", '  , 1;', 'SELECT 2;'].join('\n')

    expect(splitSqlStatements(sql)).toHaveLength(2)
  })

  it('does not treat a semicolon inside a quoted identifier as a terminator', () => {
    const sql = ['CREATE TABLE public."odd;name" (id int);', 'SELECT 2;'].join('\n')

    expect(splitSqlStatements(sql)).toHaveLength(2)
  })

  it('numbers statements from zero in file order, which is the only ordering the plan uses', () => {
    const statements = splitSqlStatements('SELECT 1;\nSELECT 2;\nSELECT 3;')

    expect(statements.map((s) => s.index)).toEqual([0, 1, 2])
  })
})

/* -------------------------------------------------------------------------- */
/* Type normalization — the identity half of a routine signature               */
/* -------------------------------------------------------------------------- */

describe('normalizeArgumentType', () => {
  it('folds the spellings PostgreSQL itself treats as one type', () => {
    expect(normalizeArgumentType('char(64)')).toBe('bpchar')
    expect(normalizeArgumentType('character(64)')).toBe('bpchar')
    expect(normalizeArgumentType('varchar(50)')).toBe('varchar')
    expect(normalizeArgumentType('character varying(50)')).toBe('varchar')
    expect(normalizeArgumentType('integer')).toBe('int4')
    expect(normalizeArgumentType('int')).toBe('int4')
    expect(normalizeArgumentType('uuid')).toBe('uuid')
    expect(normalizeArgumentType('jsonb')).toBe('jsonb')
    expect(normalizeArgumentType('text')).toBe('text')
  })

  it('refuses a form it does not model instead of guessing at it', () => {
    // The rejected alternative was a textual fallback: lowercase whatever
    // arrives and hope two spellings of one type never meet. That produces an
    // identity that compares unequal to itself across a harmless edit, which is
    // worse than a refusal because it fails at generation time with no reason.
    expect(() => normalizeArgumentType('mydomain')).toThrow(UnsupportedStructuralIdentityError)
    expect(() => normalizeArgumentType('numeric(10,2)[]')).toThrow(
      UnsupportedStructuralIdentityError,
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Routine identity — the regression cases the brief names                     */
/* -------------------------------------------------------------------------- */

describe('routine identity distinguishes overloads', () => {
  it('separates the four-argument bind_operation_ticket from the three-argument one', () => {
    const four = parseStatementIdentity(
      'GRANT EXECUTE ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64), varchar(50)) TO uellix_app;',
    )
    const three = parseStatementIdentity(
      'GRANT EXECUTE ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64)) TO uellix_app;',
    )

    expect(formatObjectIdentity(four.object!)).toBe(
      'function:uellix_stella_ops.bind_operation_ticket(bpchar,uuid,bpchar,varchar)',
    )
    expect(formatObjectIdentity(three.object!)).toBe(
      'function:uellix_stella_ops.bind_operation_ticket(bpchar,uuid,bpchar)',
    )
    expect(statementIdentityKey(four)).not.toBe(statementIdentityKey(three))
  })

  it('separates settle_reserved_quota by arity, not by name', () => {
    const wide = parseStatementIdentity(
      'ALTER FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64), uuid, uuid, text, integer, jsonb) OWNER TO uellix_cap_stella_quota;',
    )
    const narrow = parseStatementIdentity(
      'ALTER FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64)) OWNER TO uellix_cap_stella_quota;',
    )

    expect(wide.object!.argumentTypes).toHaveLength(10)
    expect(narrow.object!.argumentTypes).toHaveLength(5)
    expect(statementIdentityKey(wide)).not.toBe(statementIdentityKey(narrow))
  })

  it('ignores argument names — they are documentation, not signature', () => {
    const named = parseStatementIdentity(
      'ALTER FUNCTION uellix_grounding.claim_active_document_version(p_evidence_id uuid) OWNER TO uellix_cap_grounding;',
    )
    const bare = parseStatementIdentity(
      'ALTER FUNCTION uellix_grounding.claim_active_document_version(uuid) OWNER TO uellix_cap_grounding;',
    )

    expect(statementIdentityKey(named)).toBe(statementIdentityKey(bare))
  })

  it('ignores DEFAULT — it is not part of the signature PostgreSQL resolves on', () => {
    const withDefault = parseStatementIdentity(
      'ALTER FUNCTION uellix_stella_ops.expire_operation_tickets(p_max integer DEFAULT 1000) OWNER TO uellix_cap_stella_ticket;',
    )
    const without = parseStatementIdentity(
      'ALTER FUNCTION uellix_stella_ops.expire_operation_tickets(integer) OWNER TO uellix_cap_stella_ticket;',
    )

    expect(statementIdentityKey(withDefault)).toBe(statementIdentityKey(without))
  })

  it('drops OUT arguments, which do not participate in overload resolution', () => {
    const identity = parseStatementIdentity(
      'ALTER FUNCTION uellix_stella.stella_capacity(IN p_org uuid, OUT v_remaining integer) OWNER TO uellix_cap_stella_quota;',
    )

    expect(identity.object!.argumentTypes).toEqual(['uuid'])
  })
})

/* -------------------------------------------------------------------------- */
/* Identifier folding                                                          */
/* -------------------------------------------------------------------------- */

describe('identifier folding follows PostgreSQL, not convenience', () => {
  it('treats foo and "foo" as the same object', () => {
    const bare = parseStatementIdentity('ALTER TABLE public.foo OWNER TO uellix_owner;')
    const quoted = parseStatementIdentity('ALTER TABLE "public"."foo" OWNER TO uellix_owner;')

    expect(statementIdentityKey(bare)).toBe(statementIdentityKey(quoted))
  })

  it('treats foo and "Foo" as different objects, because PostgreSQL does', () => {
    const lower = parseStatementIdentity('ALTER TABLE public.foo OWNER TO uellix_owner;')
    const upper = parseStatementIdentity('ALTER TABLE public."Foo" OWNER TO uellix_owner;')

    expect(statementIdentityKey(lower)).not.toBe(statementIdentityKey(upper))
  })
})

/* -------------------------------------------------------------------------- */
/* The digest                                                                  */
/* -------------------------------------------------------------------------- */

describe('normalizedExecutableDigest', () => {
  it('is unchanged by a comment or by whitespace', () => {
    const a = normalizedExecutableDigest('GRANT SELECT ON public.t TO uellix_app;')
    const b = normalizedExecutableDigest(
      'GRANT   SELECT\n  ON public.t -- who reads this\n  TO uellix_app;',
    )

    expect(a).toBe(b)
  })

  it('changes when executable content changes, even by one grantee', () => {
    const a = normalizedExecutableDigest('GRANT SELECT ON public.t TO uellix_app;')
    const b = normalizedExecutableDigest('GRANT SELECT ON public.t TO uellix_auditor;')

    expect(a).not.toBe(b)
  })

  it('does not normalize away whitespace inside a string literal', () => {
    // `RAISE EXCEPTION 'a  b'` and `RAISE EXCEPTION 'a b'` are different
    // messages. Collapsing runs of spaces everywhere would make an operator's
    // error text mutable without anything noticing.
    const a = normalizedExecutableDigest("DO $$ BEGIN RAISE EXCEPTION 'a  b'; END $$;")
    const b = normalizedExecutableDigest("DO $$ BEGIN RAISE EXCEPTION 'a b'; END $$;")

    expect(a).not.toBe(b)
  })

  it('sees through a comment nested inside a DO body', () => {
    const a = normalizedExecutableDigest('DO $$\nBEGIN\n  PERFORM 1;\nEND $$;')
    const b = normalizedExecutableDigest('DO $$\nBEGIN\n  -- explanatory\n  PERFORM 1;\nEND $$;')

    expect(a).toBe(b)
  })

  it('changes when a DO body changes semantically', () => {
    const a = normalizedExecutableDigest('DO $$\nBEGIN\n  PERFORM 1;\nEND $$;')
    const b = normalizedExecutableDigest('DO $$\nBEGIN\n  PERFORM 2;\nEND $$;')

    expect(a).not.toBe(b)
  })

  it('does not mistake a `--` inside a string for the start of a comment', () => {
    const a = normalizedExecutableDigest("DO $$ BEGIN RAISE NOTICE 'a -- b'; END $$;")
    const b = normalizedExecutableDigest("DO $$ BEGIN RAISE NOTICE 'a'; END $$;")

    expect(a).not.toBe(b)
  })
})

/* -------------------------------------------------------------------------- */
/* DO blocks have no stable object identity                                    */
/* -------------------------------------------------------------------------- */

describe('DO blocks', () => {
  it('identify by the digest of their body, because they name no object', () => {
    const identity = parseStatementIdentity('DO $$\nBEGIN\n  PERFORM 1;\nEND $$;')

    expect(identity.statementClass).toBe('do-block')
    expect(identity.object).toBeNull()
    expect(statementIdentityKey(identity)).toContain('do-block:')
  })

  it('give two textually different but semantically identical blocks one identity', () => {
    const a = parseStatementIdentity('DO $$\nBEGIN\n  PERFORM 1;\nEND $$;')
    const b = parseStatementIdentity('DO $$\nBEGIN\n  -- a note\n  PERFORM   1;\nEND $$;')

    expect(statementIdentityKey(a)).toBe(statementIdentityKey(b))
  })
})

/* -------------------------------------------------------------------------- */
/* Same object, different operation                                            */
/* -------------------------------------------------------------------------- */

describe('StatementIdentity is not ObjectIdentity', () => {
  it('separates two operations on one object', () => {
    const grant = parseStatementIdentity(
      'GRANT EXECUTE ON FUNCTION uellix_grounding.claim_active_document_version(uuid) TO uellix_app;',
    )
    const owner = parseStatementIdentity(
      'ALTER FUNCTION uellix_grounding.claim_active_document_version(uuid) OWNER TO uellix_cap_grounding;',
    )

    expect(formatObjectIdentity(grant.object!)).toBe(formatObjectIdentity(owner.object!))
    expect(statementIdentityKey(grant)).not.toBe(statementIdentityKey(owner))
  })

  it('separates two grantees of the same privilege on the same object', () => {
    const app = parseStatementIdentity('GRANT SELECT ON public.projects TO uellix_app;')
    const auditor = parseStatementIdentity('GRANT SELECT ON public.projects TO uellix_auditor;')

    expect(statementIdentityKey(app)).not.toBe(statementIdentityKey(auditor))
  })
})

/* -------------------------------------------------------------------------- */
/* Subsidiary objects: one identity per object, whoever names it               */
/* -------------------------------------------------------------------------- */

describe('a policy, trigger, column or constraint has ONE identity', () => {
  // Found by running the ownership simulation over the real chain: CREATE and
  // DROP of the same policy were producing different keys, because CREATE reads
  // the `ON table` clause and DROP did not. The ownership ledger then held two
  // entries for one object and every DROP resolved against an unknown one. Two
  // identities for one object is the same defect as one identity for two.

  it('gives CREATE, DROP and COMMENT of a policy the same object identity', () => {
    const created = parseStatementIdentity(
      'CREATE POLICY "evidence_chunks_select" ON public.evidence_chunks FOR SELECT USING (true);',
    )
    const dropped = parseStatementIdentity(
      'DROP POLICY IF EXISTS "evidence_chunks_select" ON public.evidence_chunks;',
    )
    const commented = parseStatementIdentity(
      'COMMENT ON POLICY "evidence_chunks_select" ON public.evidence_chunks IS \'why\';',
    )

    const expected = 'policy:public.evidence_chunks_select@public.evidence_chunks'
    expect(formatObjectIdentity(created.object!)).toBe(expected)
    expect(formatObjectIdentity(dropped.object!)).toBe(expected)
    expect(formatObjectIdentity(commented.object!)).toBe(expected)
  })

  it('separates two policies of the same name on different tables', () => {
    const a = parseStatementIdentity('DROP POLICY IF EXISTS "sel" ON public.a;')
    const b = parseStatementIdentity('DROP POLICY IF EXISTS "sel" ON public.b;')

    expect(statementIdentityKey(a)).not.toBe(statementIdentityKey(b))
  })

  it('gives CREATE, DROP and COMMENT of a trigger the same object identity', () => {
    const created = parseStatementIdentity(
      'CREATE TRIGGER trg_no_update BEFORE UPDATE ON public.evidence_chunks FOR EACH ROW EXECUTE FUNCTION f();',
    )
    const dropped = parseStatementIdentity(
      'DROP TRIGGER IF EXISTS trg_no_update ON public.evidence_chunks;',
    )
    const commented = parseStatementIdentity(
      "COMMENT ON TRIGGER trg_no_update ON public.evidence_chunks IS 'why';",
    )

    const expected = 'trigger:public.trg_no_update@public.evidence_chunks'
    expect(formatObjectIdentity(created.object!)).toBe(expected)
    expect(formatObjectIdentity(dropped.object!)).toBe(expected)
    expect(formatObjectIdentity(commented.object!)).toBe(expected)
  })

  it('reads a three-part column name as a column of its table, not as a table', () => {
    const identity = parseStatementIdentity(
      "COMMENT ON COLUMN public.stella_interactions.idempotency_key IS 'INT-CAP-001';",
    )

    expect(formatObjectIdentity(identity.object!)).toBe(
      'column:public.idempotency_key@public.stella_interactions',
    )
  })

  it('reads a constraint as belonging to its table', () => {
    const identity = parseStatementIdentity(
      "COMMENT ON CONSTRAINT stella_interactions_governed_identity_check ON public.stella_interactions IS 'R1-B';",
    )

    expect(formatObjectIdentity(identity.object!)).toBe(
      'constraint:public.stella_interactions_governed_identity_check@public.stella_interactions',
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Prose never anchors                                                         */
/* -------------------------------------------------------------------------- */

describe('a signature mentioned in prose is not a statement about that signature', () => {
  const SIGNATURE = 'uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64))'

  it('classifies COMMENT ON as a comment, not as an operation on the routine', () => {
    const identity = parseStatementIdentity(
      `COMMENT ON FUNCTION ${SIGNATURE} IS 'superseded by the four-argument form';`,
    )

    expect(identity.statementClass).toBe('comment')
  })

  it('does not read a RAISE message inside a DO block as a statement about the routine', () => {
    const identity = parseStatementIdentity(
      `DO $$ BEGIN RAISE EXCEPTION 'GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO uellix_app'; END $$;`,
    )

    expect(identity.statementClass).toBe('do-block')
    expect(identity.object).toBeNull()
  })

  it('does not read dynamic SQL inside a function body as a statement about the routine', () => {
    const identity = parseStatementIdentity(
      [
        'CREATE OR REPLACE FUNCTION uellix_stella_ops.helper() RETURNS void AS $$',
        'BEGIN',
        `  EXECUTE 'ALTER FUNCTION ${SIGNATURE} OWNER TO uellix_owner';`,
        'END $$ LANGUAGE plpgsql;',
      ].join('\n'),
    )

    expect(identity.statementClass).toBe('create-function')
    expect(formatObjectIdentity(identity.object!)).toBe('function:uellix_stella_ops.helper()')
  })
})
