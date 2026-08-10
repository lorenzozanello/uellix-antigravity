// tests/hosted/rewrite-rules.test.ts
// TRAIN 5B — the enumerated rewrite set that turns a canonical prepared package
// into its managed-Supabase variant.
//
// The rules are tested BEFORE the generator, because the generator is a loop and
// the rules are the contract. A rule that silently matched nothing would produce
// a "hosted" package still carrying a rolsuper guard, and the only thing that
// catches that is an assertion on the rule itself.

import { describe, expect, it } from 'vitest'
import {
  HOSTED_REWRITE_RULES,
  rewriteForManagedSupabase,
} from '@/db/hosted/rewrite-rules'

const RULE_IDS = HOSTED_REWRITE_RULES.map((r) => r.id)

describe('HOSTED_REWRITE_RULES — the set itself', () => {
  it('is exactly the seven enumerated rules, in a fixed order', () => {
    // COMMIT 5.1 added the last two, both from engine measurement:
    //   capability-member-count      the zero-member postcondition is
    //                                unsatisfiable under RR-02 (E-04)
    //   auth-users-privilege-probe   the negative auth.users assertion cannot
    //                                resolve the name without USAGE on schema
    //                                auth, which RR-09 makes ungrantable (E-02)
    expect(RULE_IDS).toEqual([
      'superuser-precondition',
      'auth-schema-grant',
      'auth-uid-precondition',
      'auth-uid-call',
      'capability-role-attributes',
      'capability-member-count',
      'auth-users-privilege-probe',
    ])
  })

  it('gives every rule a non-empty rationale — a rewrite nobody can justify is a rewrite nobody can review', () => {
    for (const rule of HOSTED_REWRITE_RULES) {
      expect(rule.why.length).toBeGreaterThan(40)
    }
  })
})

describe('superuser-precondition', () => {
  const SOURCE = [
    'DO $$',
    'BEGIN',
    '  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN',
    "    RAISE EXCEPTION 'stella_0013 aborted: must run as a SUPERUSER (current_user=%). It creates a role.', current_user;",
    '  END IF;',
    'END $$;',
  ].join('\n')

  it('replaces the guard with a capability assertion naming the package', () => {
    const { sql, counts } = rewriteForManagedSupabase('stella_0013_grounded_query_quota', SOURCE)

    expect(counts['superuser-precondition']).toBe(1)
    expect(sql).not.toContain('rolsuper')
    expect(sql).toContain(
      "PERFORM uellix_bootstrap.assert_hosted_capabilities('stella_0013_grounded_query_quota');",
    )
  })

  it('preserves the original abort message verbatim, as a comment', () => {
    const { sql } = rewriteForManagedSupabase('stella_0013_grounded_query_quota', SOURCE)

    expect(sql).toContain(
      '--   stella_0013 aborted: must run as a SUPERUSER (current_user=%). It creates a role.',
    )
  })

  it('is a no-op on already-rewritten SQL — the second pass must find nothing', () => {
    const once = rewriteForManagedSupabase('stella_0013_grounded_query_quota', SOURCE)
    const twice = rewriteForManagedSupabase('stella_0013_grounded_query_quota', once.sql)

    expect(twice.counts['superuser-precondition']).toBe(0)
    expect(twice.sql).toBe(once.sql)
  })
})

describe('auth-schema-grant', () => {
  const SOURCE = [
    'GRANT USAGE ON SCHEMA auth TO uellix_cap_stella_quota;',
    'GRANT EXECUTE ON FUNCTION auth.uid() TO uellix_cap_stella_quota;',
  ].join('\n')

  it('collapses both grants into one EXECUTE on the shim, keeping the role', () => {
    const { sql, counts } = rewriteForManagedSupabase('stella_0013_grounded_query_quota', SOURCE)

    expect(counts['auth-schema-grant']).toBe(1)
    expect(sql).not.toContain('GRANT USAGE ON SCHEMA auth')
    expect(sql).not.toContain('GRANT EXECUTE ON FUNCTION auth.uid()')
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.uellix_auth_uid() TO uellix_cap_stella_quota;',
    )
  })
})

describe('auth-uid-call', () => {
  it('rewrites an assignment inside a SECURITY DEFINER body', () => {
    const { sql, counts } = rewriteForManagedSupabase('x', '  v_actor := auth.uid();')

    expect(counts['auth-uid-call']).toBe(1)
    expect(sql).toBe('  v_actor := public.uellix_auth_uid();')
  })

  it('rewrites a policy predicate — a definer INSERT evaluates it as the capability role', () => {
    const { sql } = rewriteForManagedSupabase('x', '  created_by = auth.uid()')

    expect(sql).toBe('  created_by = public.uellix_auth_uid()')
  })

  it('NEVER rewrites a comment — the historical rationale must survive intact', () => {
    const line = "-- USAGE on schema auth so `auth.uid()` RESOLVES — nothing more."
    const { sql, counts } = rewriteForManagedSupabase('x', line)

    expect(counts['auth-uid-call']).toBe(0)
    expect(sql).toBe(line)
  })

  it('NEVER rewrites inside a string literal — a RAISE message is prose, not a call', () => {
    const line =
      "    RAISE EXCEPTION 'stella_0014 FAILED verification: the USAGE on schema auth exists so that auth.uid() resolves';"
    const { sql, counts } = rewriteForManagedSupabase('x', line)

    expect(counts['auth-uid-call']).toBe(0)
    expect(sql).toBe(line)
  })

  it('rewrites a REAL call that shares its line with a message literal', () => {
    // Adversarial review B: the first version excluded the whole line if it
    // contained any quote, so this call would have been skipped in silence and
    // failed only at runtime, inside a definer, as a permission error.
    const line = "    RAISE NOTICE 'actor=%', auth.uid();"
    const { sql, counts } = rewriteForManagedSupabase('x', line)

    expect(counts['auth-uid-call']).toBe(1)
    expect(sql).toBe("    RAISE NOTICE 'actor=%', public.uellix_auth_uid();")
  })

  it('still leaves the occurrence INSIDE that same message untouched', () => {
    const line = "    RAISE NOTICE 'auth.uid() was null', auth.uid();"
    const { sql, counts } = rewriteForManagedSupabase('x', line)

    expect(counts['auth-uid-call']).toBe(1)
    expect(sql).toBe("    RAISE NOTICE 'auth.uid() was null', public.uellix_auth_uid();")
  })

  it('handles a doubled quote — SQL escapes a literal quote as two, and parity must survive it', () => {
    const line = "    v_actor := auth.uid(); -- it''s the session"
    const { counts } = rewriteForManagedSupabase('x', line)

    expect(counts['auth-uid-call']).toBe(1)
  })

  it('NEVER rewrites a GRANT line — that surface belongs to auth-schema-grant alone', () => {
    const line = 'GRANT EXECUTE ON FUNCTION auth.uid() TO some_role_the_grant_rule_missed;'
    const { counts } = rewriteForManagedSupabase('x', line)

    expect(counts['auth-uid-call']).toBe(0)
  })
})

describe('capability-role-attributes', () => {
  // The statement, exactly as the three capability packages write it.
  const CANONICAL = [
    'ALTER ROLE uellix_cap_grounding',
    '  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;',
  ].join('\n')

  const executableLines = (sql: string): string =>
    sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n')

  it('fires once, and leaves no privileged keyword in anything executable', () => {
    const { sql, counts } = rewriteForManagedSupabase('grounding_0002_document_versions', CANONICAL)

    expect(counts['capability-role-attributes']).toBe(1)
    // The prose keeps naming them — that is the record of what was replaced and
    // why — so only the statements are checked.
    for (const attribute of ['NOSUPERUSER', 'NOCREATEDB', 'NOREPLICATION', 'NOBYPASSRLS']) {
      expect(executableLines(sql), attribute).not.toContain(attribute)
    }
  })

  it('still SETS the three a CREATEROLE installer may set', () => {
    const { sql } = rewriteForManagedSupabase('grounding_0002_document_versions', CANONICAL)

    expect(sql).toContain('ALTER ROLE uellix_cap_grounding NOLOGIN NOCREATEROLE NOINHERIT;')
  })

  it('ASSERTS the four it may not, and asserts them BEFORE the alter', () => {
    const { sql } = rewriteForManagedSupabase('grounding_0002_document_versions', CANONICAL)

    for (const column of ['rolsuper', 'rolcreatedb', 'rolreplication', 'rolbypassrls']) {
      expect(sql, column).toContain(`r.${column}`)
    }
    expect(sql).toContain('grounding_0002_document_versions aborted')
    // ORDER IS THE POINT. On a widened role the ALTER would itself be refused,
    // with a permission error naming nothing the operator can act on.
    expect(sql.indexOf('v_widened')).toBeLessThan(
      sql.indexOf('ALTER ROLE uellix_cap_grounding NOLOGIN'),
    )
  })

  it('carries the role name through — it never rewrites one package as another', () => {
    const { sql } = rewriteForManagedSupabase(
      'stella_0014_operation_tickets',
      CANONICAL.replace(/uellix_cap_grounding/g, 'uellix_cap_stella_ticket'),
    )

    expect(sql).toContain("rolname = 'uellix_cap_stella_ticket'")
    expect(sql).not.toContain('uellix_cap_grounding')
  })

  it('is a no-op on already-rewritten SQL — the second pass must find nothing', () => {
    const once = rewriteForManagedSupabase('grounding_0002_document_versions', CANONICAL)
    const twice = rewriteForManagedSupabase('grounding_0002_document_versions', once.sql)

    expect(twice.counts['capability-role-attributes']).toBe(0)
    expect(twice.sql).toBe(once.sql)
  })

  it('MUTATION: a DIFFERENT ALTER ROLE is not eaten — the anchor is the whole statement', () => {
    // Were the pattern loosened to `ALTER ROLE`, this would be silently replaced
    // and the package would lose a statement nobody reviewed. Same reasoning as
    // the superuser guard's exact-shape anchor.
    const { counts, sql } = rewriteForManagedSupabase(
      'grounding_0002_document_versions',
      'ALTER ROLE uellix_cap_grounding CONNECTION LIMIT 0;',
    )

    expect(counts['capability-role-attributes']).toBe(0)
    expect(sql).toBe('ALTER ROLE uellix_cap_grounding CONNECTION LIMIT 0;')
  })

  it('MUTATION: a second capability role changes the count, and the manifest pins it', () => {
    // A new capability package added without re-reading this rule fires it twice;
    // the generator compares against the pinned count and throws rather than
    // shipping. This is the mechanism, exercised.
    const twice = `${CANONICAL}\n\n${CANONICAL.replace(/uellix_cap_grounding/g, 'uellix_cap_other')}`

    expect(
      rewriteForManagedSupabase('grounding_0002_document_versions', twice).counts[
        'capability-role-attributes'
      ],
    ).toBe(2)
  })
})

describe('auth-uid-precondition', () => {
  it('asks about the SHIM, because the installer cannot ask about auth.uid() at all', () => {
    // COMMIT 5.1 replaced a conjunction with a substitution, and the reason is
    // measured rather than stylistic. The conjunction's second half —
    // `to_regprocedure('auth.uid()')` — resolves a name in schema auth, which
    // needs USAGE on that schema; schema auth belongs to supabase_auth_admin
    // and RR-09 is exactly that `postgres` holds its USAGE without grant
    // option. On PG 17.6 the package stopped at `permission denied for schema
    // auth`, from its own precondition. It only ever worked because the
    // installer was assumed to be the baseline owner.
    //
    // The fact is not lost: stella_hosted_0001 §0 E5/E5b/E5c assert that
    // auth.uid() exists and is reachable, once, by a principal that can ask.
    const source = "  IF to_regprocedure('auth.uid()') IS NULL THEN"
    const { sql, counts } = rewriteForManagedSupabase('x', source)

    expect(counts['auth-uid-precondition']).toBe(1)
    expect(sql).toContain("to_regprocedure('public.uellix_auth_uid()') IS NULL")
    expect(sql).not.toContain("to_regprocedure('auth.uid()')")
  })
})

describe('the rewrite as a whole', () => {
  it('reports a count for every rule, including the ones that matched nothing', () => {
    const { counts } = rewriteForManagedSupabase('x', 'SELECT 1;')

    expect(Object.keys(counts).sort()).toEqual([...RULE_IDS].sort())
    for (const id of RULE_IDS) expect(counts[id]).toBe(0)
  })

  it('never emits CRLF — db/prepared/** is pinned to LF by .gitattributes', () => {
    const { sql } = rewriteForManagedSupabase(
      'x',
      '  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN\r\n' +
        "    RAISE EXCEPTION 'x aborted: nope.', current_user;\r\n" +
        '  END IF;\r\n',
    )

    expect(sql).not.toContain('\r')
  })
})
