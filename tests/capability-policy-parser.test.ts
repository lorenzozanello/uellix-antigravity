// tests/capability-policy-parser.test.ts
//
// The parser the capability gates are built on, and its NEGATIVE CONTROLS.
//
// WHY THIS FILE EXISTS. tests/capability-isolation.test.ts verifies policies by
// existence regex and by cardinality: "nine CREATE POLICY lines start with
// cap_invitation_", "three of them say AS RESTRICTIVE". Both properties are
// invariant under permutation. Retargeting a policy's TO clause, replacing its
// USING predicate, dropping its WITH CHECK, or attaching it to a different
// table all leave those counts exactly where they were — which is how 22
// security mutations survived a 220/220 run.
//
// A gate can only refuse what it can SEE. So the first thing to build is not a
// stricter regex but a parser that turns each CREATE POLICY into the tuple the
// design actually talks about:
//
//     (name, table, PERMISSIVE|RESTRICTIVE, command, TO roles, USING, WITH CHECK)
//
// and each GRANT into (privilege, columns, object, grantee) — because
// `GRANT INSERT (email), SELECT ON t TO r` is ONE statement conferring TWO
// privileges, and the old check read only as far as the first word.
//
// The tests below are mostly negative controls: each takes a correct statement,
// applies one mutation from the catalogue, and asserts the parser SURFACES the
// difference. A parser that returned the same structure for both would be
// worse than useless — it would make the gates above it look green.

import { describe, it, expect } from 'vitest'
import {
  parsePolicies,
  parseGrants,
  parseRevokes,
  parseDroppedPolicies,
  parseOwnerships,
  parseOwnedStatements,
  parseRlsToggles,
  parseRoleStatements,
  parseDefaultPrivileges,
  parseIndexes,
  unparsedSecurityStatements,
  executedLiterals,
  stripComments,
  normalizeExpr,
} from './helpers/sql-structure'

const GOOD = `
DROP POLICY IF EXISTS cap_invitation_update_invitations ON public.invitations;
CREATE POLICY cap_invitation_update_invitations
ON public.invitations FOR UPDATE TO uellix_cap_invitation
USING (status = 'pending')
WITH CHECK (status = 'accepted' AND accepted_by IS NOT NULL);
`

describe('policy parser — the shape of a correct statement', () => {
  it('extracts every field of a CREATE POLICY', () => {
    const [p] = parsePolicies(GOOD)
    expect(p.name).toBe('cap_invitation_update_invitations')
    expect(p.table).toBe('public.invitations')
    expect(p.permissive).toBe('PERMISSIVE')
    expect(p.command).toBe('UPDATE')
    expect(p.roles).toEqual(['uellix_cap_invitation'])
    expect(p.using).toBe("status = 'pending'")
    expect(p.withCheck).toBe("status = 'accepted' AND accepted_by IS NOT NULL")
  })

  it('does not mistake a DROP POLICY for a CREATE POLICY', () => {
    // The packages always pair the two, so a parser that matched `POLICY`
    // would double every count and make cardinality checks pass for the wrong
    // reason.
    expect(parsePolicies(GOOD)).toHaveLength(1)
  })

  it('reads AS RESTRICTIVE, which sits between the table and the command', () => {
    const p = parsePolicies(`
CREATE POLICY cap_invitation_only_accept
ON public.invitations AS RESTRICTIVE FOR UPDATE TO uellix_cap_invitation
USING (status = 'pending')
WITH CHECK (status = 'accepted');
`)[0]
    expect(p.permissive).toBe('RESTRICTIVE')
    expect(p.command).toBe('UPDATE')
  })

  it('defaults the command to ALL when FOR is absent, as PostgreSQL does', () => {
    const p = parsePolicies(`
CREATE POLICY cap_stripe_rw_events
ON public.stripe_webhook_events TO uellix_cap_stripe
USING (true) WITH CHECK (true);
`)[0]
    expect(p.command).toBe('ALL')
  })

  it('survives a predicate containing parentheses, a subquery and a semicolonless comment', () => {
    // disclosures_select_member is the real shape: a balanced-paren walk is
    // required, because a `[\\s\\S]*?(?=;)` lazy match stops at the first
    // semicolon it meets and a `\\(([^)]*)\\)` capture stops at the first
    // closing paren — here, the one belonging to `SELECT 1 FROM ...(`.
    const p = parsePolicies(`
CREATE POLICY disclosures_select_member
ON public.report_public_disclosures FOR SELECT TO uellix_app
USING (
  EXISTS (
    SELECT 1 FROM public.sroi_reports r
     WHERE r.id = public.report_public_disclosures.report_id
       AND (r.organization_id = ANY(public.current_user_org_ids())
            OR public.current_user_is_super_admin())
  )
);
`)[0]
    expect(p.roles).toEqual(['uellix_app'])
    expect(p.using).toContain('current_user_org_ids()')
    expect(p.using).toContain('report_public_disclosures.report_id')
    expect(p.withCheck).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Negative controls. One mutation each, from the catalogue.
// ---------------------------------------------------------------------------

describe('policy parser — negative controls', () => {
  it('reports an ABSENT TO clause as no roles, not as a role named USING', () => {
    const p = parsePolicies(`
CREATE POLICY cap_invitation_select_users
ON public.users FOR SELECT
USING (id = auth.uid());
`)[0]
    expect(p.roles).toEqual([])
  })

  it('reports TO PUBLIC as the role `public`, distinguishable from a real role', () => {
    // The gate this feeds must refuse it. The old check — "the statement
    // matches /TO \\w+/" — is SATISFIED by TO PUBLIC, so the explicit form of
    // the defect stella_0005c repaired passed as a fix for it.
    const p = parsePolicies(`
CREATE POLICY cap_invitation_select_users
ON public.users FOR SELECT TO PUBLIC
USING (id = auth.uid());
`)[0]
    expect(p.roles).toEqual(['public'])
  })

  it('distinguishes a retargeted TO clause', () => {
    const p = parsePolicies(GOOD.replace('TO uellix_cap_invitation', 'TO uellix_app'))[0]
    expect(p.roles).toEqual(['uellix_app'])
  })

  it('reads a multi-role TO clause as every role it names', () => {
    const p = parsePolicies(GOOD.replace('TO uellix_cap_invitation', 'TO uellix_cap_invitation, uellix_app'))[0]
    expect(p.roles).toEqual(['uellix_cap_invitation', 'uellix_app'])
  })

  it('distinguishes RESTRICTIVE downgraded to PERMISSIVE', () => {
    const restrictive = `CREATE POLICY p ON public.t AS RESTRICTIVE FOR SELECT TO r USING (true);`
    expect(parsePolicies(restrictive)[0].permissive).toBe('RESTRICTIVE')
    expect(parsePolicies(restrictive.replace(' AS RESTRICTIVE', ''))[0].permissive).toBe('PERMISSIVE')
    expect(parsePolicies(restrictive.replace('RESTRICTIVE', 'PERMISSIVE'))[0].permissive).toBe('PERMISSIVE')
  })

  it('reports a REMOVED USING clause as null, not as the WITH CHECK next to it', () => {
    const p = parsePolicies(`
CREATE POLICY cap_invitation_update_invitations
ON public.invitations FOR UPDATE TO uellix_cap_invitation
WITH CHECK (status = 'accepted' AND accepted_by IS NOT NULL);
`)[0]
    expect(p.using).toBeNull()
    expect(p.withCheck).toBe("status = 'accepted' AND accepted_by IS NOT NULL")
  })

  it('reports a REMOVED WITH CHECK as null while keeping USING intact', () => {
    const p = parsePolicies(GOOD.replace(/\nWITH CHECK \([\s\S]*?\);/, ';'))[0]
    expect(p.using).toBe("status = 'pending'")
    expect(p.withCheck).toBeNull()
  })

  it('distinguishes a SUBSTITUTED predicate from the original', () => {
    const weakened = parsePolicies(GOOD.replace("USING (status = 'pending')", 'USING (true)'))[0]
    expect(weakened.using).toBe('true')
    expect(weakened.using).not.toBe(parsePolicies(GOOD)[0].using)
  })

  it('distinguishes an actor unbound from the audit predicate', () => {
    const bound = `CREATE POLICY p ON public.audit_logs FOR INSERT TO r WITH CHECK (actor_user_id IS NOT NULL AND entity_type = 'x');`
    const unbound = bound.replace('actor_user_id IS NOT NULL AND ', '')
    expect(parsePolicies(bound)[0].withCheck).not.toBe(parsePolicies(unbound)[0].withCheck)
    expect(parsePolicies(unbound)[0].withCheck).not.toContain('actor_user_id')
  })

  it('distinguishes an organisation unbound from a tenancy predicate', () => {
    const bound = `CREATE POLICY p ON public.t FOR SELECT TO r USING (organization_id = ANY(public.current_user_org_ids()));`
    const unbound = `CREATE POLICY p ON public.t FOR SELECT TO r USING (true);`
    expect(parsePolicies(bound)[0].using).not.toBe(parsePolicies(unbound)[0].using)
  })

  it('reports the table a policy is attached to, so a policy moved to the wrong one is visible', () => {
    const moved = parsePolicies(GOOD.replace('ON public.invitations FOR UPDATE', 'ON public.organization_members FOR UPDATE'))[0]
    expect(moved.table).toBe('public.organization_members')
    expect(moved.name).toBe('cap_invitation_update_invitations')
  })

  it('normalizes whitespace so reformatting is not a difference, but a token is', () => {
    expect(normalizeExpr("status\n  =   'pending'")).toBe(normalizeExpr("status = 'pending'"))
    expect(normalizeExpr("status = 'pending'")).not.toBe(normalizeExpr("status = 'accepted'"))
  })

  it('ignores a CREATE POLICY that only appears inside a line comment', () => {
    const p = parsePolicies(`
-- CREATE POLICY cap_ghost ON public.t FOR SELECT TO r USING (true);
CREATE POLICY cap_real ON public.t FOR SELECT TO r USING (true);
`)
    expect(p.map((x) => x.name)).toEqual(['cap_real'])
  })
})

// ---------------------------------------------------------------------------
// Grants. The other half the old suite read only the first word of.
// ---------------------------------------------------------------------------

describe('grant parser', () => {
  it('splits a column-scoped grant into privilege and column list', () => {
    const [g] = parseGrants(`GRANT INSERT (email, company_name) ON public.marketing_leads TO uellix_cap_lead;`)
    expect(g.privileges).toEqual([{ privilege: 'INSERT', columns: ['email', 'company_name'] }])
    expect(g.object).toBe('public.marketing_leads')
    expect(g.grantees).toEqual(['uellix_cap_lead'])
  })

  it('splits a FUSED grant into its separate privileges — the CAP-04 mutation', () => {
    // `GRANT INSERT (...), SELECT ON public.marketing_leads TO uellix_cap_lead`
    // confers SELECT on a definer whose defining property is that it cannot
    // read. The old gate captured the privilege list as one string and asserted
    // /^INSERT/, which this satisfies.
    const [g] = parseGrants(
      `GRANT INSERT (email, company_name), SELECT ON public.marketing_leads TO uellix_cap_lead;`,
    )
    expect(g.privileges.map((p) => p.privilege)).toEqual(['INSERT', 'SELECT'])
    expect(g.privileges[1].columns).toBeNull()
  })

  it('reads a multi-privilege table grant', () => {
    const [g] = parseGrants(`GRANT SELECT, INSERT, UPDATE ON public.capability_verification_hits TO uellix_cap_verification;`)
    expect(g.privileges.map((p) => p.privilege)).toEqual(['SELECT', 'INSERT', 'UPDATE'])
    expect(g.privileges.every((p) => p.columns === null)).toBe(true)
  })

  it('reads a grant that spans lines, as every real one in the packages does', () => {
    const [g] = parseGrants(`
GRANT SELECT (id, organization_id, email, role, status, token_hash, expires_at,
              invited_by, accepted_by)
  ON public.invitations TO uellix_cap_invitation;
`)
    expect(g.privileges[0].columns).toEqual([
      'id', 'organization_id', 'email', 'role', 'status', 'token_hash',
      'expires_at', 'invited_by', 'accepted_by',
    ])
  })

  it('classifies a function grant, keeping the argument list out of the object name', () => {
    const [g] = parseGrants(`GRANT EXECUTE ON FUNCTION uellix_capability.submit_lead(text, text, text, text) TO uellix_app;`)
    expect(g.objectType).toBe('FUNCTION')
    expect(g.object).toBe('uellix_capability.submit_lead')
    expect(g.grantees).toEqual(['uellix_app'])
  })

  it('classifies a schema grant', () => {
    const [g] = parseGrants(`GRANT USAGE ON SCHEMA auth TO uellix_cap_invitation;`)
    expect(g.objectType).toBe('SCHEMA')
    expect(g.object).toBe('auth')
  })

  it('reads REVOKE separately from GRANT, so one is never counted as the other', () => {
    const sql = `
REVOKE ALL ON FUNCTION uellix_capability.submit_lead(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uellix_capability.submit_lead(text, text, text, text) TO uellix_app;
`
    expect(parseGrants(sql)).toHaveLength(1)
    const [r] = parseRevokes(sql)
    expect(r.grantees).toEqual(['public'])
    expect(r.privileges.map((p) => p.privilege)).toEqual(['ALL'])
  })

  it('does not read a GRANT that only appears inside a comment', () => {
    expect(parseGrants(`-- GRANT SELECT ON public.t TO r;\nGRANT INSERT ON public.t TO r;`)).toHaveLength(1)
  })

  it('does not read the word GRANT inside a string literal', () => {
    // Postcondition messages in these packages quote the statements they check.
    expect(
      parseGrants(`RAISE EXCEPTION 'GRANT SELECT ON public.t TO r is forbidden';`),
    ).toHaveLength(0)
  })
})

// ===========================================================================
// The lexical model, and the eight confirmed evasions as PARSER-level controls.
// ===========================================================================
//
// tests/capability-mutation.test.ts proves the GATES refuse each evasion. That
// is the claim that matters operationally, and it is also the claim that can be
// satisfied for the wrong reason: a mutant can be refused by a bystander gate
// while the parser still cannot see the statement. So each evasion is asserted
// TWICE — once against the gates, once here against the structure the gates are
// built on. If the parser regresses, this file goes red before the other one
// has a chance to go green by accident.

describe('lexer — identifiers', () => {
  it('folds an unquoted identifier to lower case, as PostgreSQL does', () => {
    const [g] = parseGrants(`GRANT SELECT ON PUBLIC.Marketing_Leads TO Uellix_Cap_Lead;`)
    expect(g.object).toBe('public.marketing_leads')
    expect(g.grantees).toEqual(['uellix_cap_lead'])
  })

  it('E-02: reads a DOUBLE-QUOTED grantee as the same role as the bare spelling', () => {
    const quoted = parseGrants(`GRANT SELECT ON public.marketing_leads TO "uellix_cap_lead";`)[0]
    const bare = parseGrants(`GRANT SELECT ON public.marketing_leads TO uellix_cap_lead;`)[0]
    expect(quoted.grantees).toEqual(bare.grantees)
    expect(quoted.grantees).toEqual(['uellix_cap_lead'])
  })

  it('keeps the CASE of a quoted identifier, so "RoleName" is not rolename', () => {
    // The direction that matters: quoting is not decoration, it SUPPRESSES the
    // fold. A policy naming "Uellix_Cap_Invitation" protects a role no definer
    // ever assumes, and a case-insensitive comparison would call it correct.
    const [g] = parseGrants(`GRANT SELECT ON public.t TO "RoleName";`)
    expect(g.grantees).toEqual(['RoleName'])
    expect(g.grantees).not.toEqual(['rolename'])
  })

  it('reads a schema-qualified name with BOTH parts quoted', () => {
    const [g] = parseGrants(`GRANT SELECT ON "public"."marketing_leads" TO r;`)
    expect(g.object).toBe('public.marketing_leads')
  })

  it('unescapes a doubled quote inside a quoted identifier', () => {
    const [g] = parseGrants(`GRANT SELECT ON public.t TO "odd""name";`)
    expect(g.grantees).toEqual(['odd"name'])
  })

  it('E-07: reads a CREATE POLICY whose name, schema, table and role are all quoted', () => {
    const [p] = parsePolicies(
      `CREATE POLICY "cap_escape_policy" ON "public"."organizations" FOR SELECT TO "uellix_cap_verification" USING (true);`,
    )
    expect(p.name).toBe('cap_escape_policy')
    expect(p.table).toBe('public.organizations')
    expect(p.roles).toEqual(['uellix_cap_verification'])
    expect(p.using).toBe('true')
  })

  it('reads a DROP POLICY with a quoted name', () => {
    expect(parseDroppedPolicies(`DROP POLICY IF EXISTS "cap ghost" ON "public"."t";`)).toEqual([
      { name: 'cap ghost', table: 'public.t' },
    ])
  })
})

describe('lexer — strings', () => {
  it('does not close an E-string on a backslash-escaped quote', () => {
    // `E'it\\'s'` continues past the apostrophe. A masker that stopped there
    // desynchronised to end of file, and every statement after it went quiet.
    const sql = `RAISE EXCEPTION E'it\\'s not a grant';\nGRANT SELECT ON public.t TO r;`
    expect(parseGrants(sql)).toHaveLength(1)
  })

  it('does not treat an E that ends an identifier as a string prefix', () => {
    // `some_value'x'` is an identifier followed by a literal, not an E-string.
    // Reading it as one swallows the closing quote and shifts every subsequent
    // token by one.
    const sql = `SELECT some_value'x';\nGRANT SELECT ON public.t TO r;`
    expect(parseGrants(sql)).toHaveLength(1)
  })

  it('treats a tagged dollar quote as one opaque literal for the enclosing statement', () => {
    const sql = `CREATE OR REPLACE FUNCTION f() RETURNS void AS $body$ BEGIN RAISE NOTICE 'a;b'; END $body$;\nGRANT SELECT ON public.t TO r;`
    expect(parseGrants(sql)).toHaveLength(1)
  })

  it('handles two dollar-quoted bodies in one file without merging them', () => {
    const sql = `
DO $$ BEGIN PERFORM 1; END $$;
DO $$ BEGIN GRANT SELECT ON public.t TO r; END $$;
`
    expect(parseGrants(sql).map((g) => g.object)).toEqual(['public.t'])
  })

  it('does not read a GRANT that only appears inside a single-quoted string', () => {
    expect(parseGrants(`SELECT 'GRANT SELECT ON public.t TO r';`)).toHaveLength(0)
  })
})

describe('lexer — comments', () => {
  it('E-08: NESTS block comments, as PostgreSQL does', () => {
    // The whole statement is commented out. A non-nesting reader believes the
    // comment closed at the inner `*/` and that the REVOKE survived.
    const sql = `/* outer /* inner */ REVOKE SELECT ON public.t FROM r; */`
    expect(parseRevokes(sql)).toHaveLength(0)
    expect(stripComments(sql).trim()).toBe('')
  })

  it('E-08 control: the same REVOKE outside a comment IS read', () => {
    expect(parseRevokes(`REVOKE SELECT ON public.t FROM r;`)).toHaveLength(1)
  })

  it('keeps code that follows a nested block comment', () => {
    const sql = `/* a /* b */ c */ GRANT SELECT ON public.t TO r;`
    expect(parseGrants(sql)).toHaveLength(1)
  })

  it('does not treat a comment-like sequence inside a string as a comment', () => {
    const sql = `SELECT '-- not a comment';\nGRANT SELECT ON public.t TO r;`
    expect(parseGrants(sql)).toHaveLength(1)
  })

  it('strips comments INSIDE a function body, because prose is not the rule', () => {
    // A dollar body is a string to the enclosing statement and SOURCE to
    // PostgreSQL. CAP-03 explains at length why a branch was removed; a view
    // that kept the prose would report the branch as still present.
    const sql = `CREATE OR REPLACE FUNCTION f() RETURNS void AS $$\nBEGIN\n  -- client_reference_id was removed\n  PERFORM 1;\nEND\n$$;`
    expect(stripComments(sql)).not.toContain('client_reference_id')
    expect(stripComments(sql)).toHaveLength(sql.length)
  })

  it('preserves length, so the mask-desync invariant means something', () => {
    const sql = `-- x\n/* y /* z */ */\nGRANT SELECT ON public.t TO r;`
    expect(stripComments(sql)).toHaveLength(sql.length)
  })
})

describe('parser — executable bodies', () => {
  it('E-01: reads DDL written DIRECTLY inside a DO block', () => {
    const [g] = parseGrants(`DO $$\nBEGIN\n  GRANT SELECT ON public.marketing_leads TO uellix_cap_lead;\nEND\n$$;`)
    expect(g.object).toBe('public.marketing_leads')
    expect(g.grantees).toEqual(['uellix_cap_lead'])
    expect(g.origin).toBe('do-block')
  })

  it('reads DDL executed from a self-contained literal', () => {
    const [g] = parseGrants(
      `DO $$\nBEGIN\n  EXECUTE 'GRANT SELECT ON public.marketing_leads TO uellix_cap_lead';\nEND\n$$;`,
    )
    expect(g.grantees).toEqual(['uellix_cap_lead'])
    expect(g.origin).toBe('executed-literal')
  })

  it('reads DDL executed from a literal inside a conditional branch', () => {
    // Statement splitting on `;` alone would read
    // `IF … THEN EXECUTE '…'` as one statement whose first word is IF.
    const [g] = parseGrants(
      `DO $$\nBEGIN\n  IF true THEN EXECUTE 'GRANT SELECT ON public.t TO r'; END IF;\nEND\n$$;`,
    )
    expect(g.object).toBe('public.t')
  })

  it('reads DDL inside a FUNCTION body, not only inside a DO block', () => {
    const [g] = parseGrants(
      `CREATE OR REPLACE FUNCTION f() RETURNS void AS $$\nBEGIN\n  GRANT SELECT ON public.t TO r;\nEND\n$$ LANGUAGE plpgsql;`,
    )
    expect(g.origin).toBe('function-body')
  })

  it('F-08: refuses EXECUTE format(...) instead of ignoring it', () => {
    const u = unparsedSecurityStatements(
      `DO $$\nBEGIN\n  EXECUTE format('GRANT SELECT ON public.t TO %I', 'r');\nEND\n$$;`,
    )
    expect(u).toHaveLength(1)
    expect(u[0].reason).toBe('dynamic-sql')
  })

  it('F-09: refuses EXECUTE of a variable built by concatenation', () => {
    const u = unparsedSecurityStatements(
      `DO $$\nDECLARE v_sql text;\nBEGIN\n  v_sql := 'GRANT ' || 'SELECT ON public.t TO r';\n  EXECUTE v_sql;\nEND\n$$;`,
    )
    expect(u.map((x) => x.reason)).toEqual(['dynamic-sql'])
  })

  it('refuses EXECUTE of a concatenation written inline', () => {
    const u = unparsedSecurityStatements(
      `DO $$\nBEGIN\n  EXECUTE 'GRANT SELECT ON public.t TO ' || quote_ident('r');\nEND\n$$;`,
    )
    expect(u.map((x) => x.reason)).toEqual(['dynamic-sql'])
  })

  it('accepts EXECUTE of a literal with an INTO clause without calling it dynamic', () => {
    expect(
      unparsedSecurityStatements(`DO $$\nDECLARE n int;\nBEGIN\n  EXECUTE 'SELECT 1' INTO n;\nEND\n$$;`),
    ).toEqual([])
  })

  it('does not mistake ON CONFLICT DO NOTHING for a DO block', () => {
    expect(
      unparsedSecurityStatements(`INSERT INTO public.t (a) VALUES (1) ON CONFLICT DO NOTHING;`),
    ).toEqual([])
  })

  it('reports the contents of every executed literal', () => {
    expect(
      executedLiterals(`DO $$ BEGIN EXECUTE 'CREATE ROLE r'; EXECUTE 'DROP ROLE r'; END $$;`),
    ).toEqual(['CREATE ROLE r', 'DROP ROLE r'])
  })
})

describe('parser — every statement, not only the first', () => {
  it('E-05: reads BOTH ALTER ROLE statements, including the quoted second one', () => {
    const stmts = parseRoleStatements(
      `ALTER ROLE uellix_cap_lead NOSUPERUSER NOBYPASSRLS;\nALTER ROLE "uellix_cap_lead" BYPASSRLS SUPERUSER;`,
    )
    expect(stmts).toHaveLength(2)
    expect(stmts.map((s) => s.role)).toEqual(['uellix_cap_lead', 'uellix_cap_lead'])
    expect(stmts[1].attributes).toEqual(['BYPASSRLS', 'SUPERUSER'])
  })

  it('reads a CREATE ROLE issued from inside a DO block', () => {
    const [s] = parseRoleStatements(`DO $$ BEGIN EXECUTE 'CREATE ROLE uellix_cap_lead NOLOGIN'; END $$;`)
    expect(s.verb).toBe('CREATE')
    expect(s.role).toBe('uellix_cap_lead')
    expect(s.attributes).toEqual(['NOLOGIN'])
  })

  it('separates ALTER ROLE … SET <guc> from an attribute list', () => {
    const [s] = parseRoleStatements(`ALTER ROLE uellix_stripe SET statement_timeout = '10s';`)
    expect(s.attributes).toEqual([])
  })

  it('E-03: splits a multi-member GRANT into one membership per member', () => {
    const grants = parseGrants(`GRANT uellix_owner, uellix_writer TO uellix_cap_lead;`)
    expect(grants).toHaveLength(2)
    expect(grants.map((g) => g.object)).toEqual(['uellix_owner', 'uellix_writer'])
    for (const g of grants) {
      expect(g.objectType).toBe('ROLE')
      expect(g.grantees).toEqual(['uellix_cap_lead'])
    }
  })

  it('reads a membership granted to several grantees at once', () => {
    const grants = parseGrants(`GRANT uellix_owner TO a, b;`)
    expect(grants).toHaveLength(1)
    expect(grants[0].grantees).toEqual(['a', 'b'])
  })

  it('records WITH ADMIN OPTION on a membership and WITH GRANT OPTION on a privilege', () => {
    expect(parseGrants(`GRANT uellix_owner TO r WITH ADMIN OPTION;`)[0].adminOption).toBe(true)
    expect(parseGrants(`GRANT SELECT ON public.t TO r WITH GRANT OPTION;`)[0].grantOption).toBe(true)
    expect(parseGrants(`GRANT SELECT ON public.t TO r;`)[0].grantOption).toBe(false)
  })

  it('reads REVOKE GRANT OPTION FOR without losing the privilege list', () => {
    const [r] = parseRevokes(`REVOKE GRANT OPTION FOR SELECT ON public.t FROM r;`)
    expect(r.privileges.map((p) => p.privilege)).toEqual(['SELECT'])
    expect(r.grantOption).toBe(true)
  })
})

describe('parser — ownership, RLS and default privileges', () => {
  it('E-06: reads REASSIGN OWNED, which no previous pattern contained', () => {
    const [o] = parseOwnedStatements(`REASSIGN OWNED BY uellix_owner TO uellix_cap_lead;`)
    expect(o.verb).toBe('REASSIGN')
    expect(o.from).toEqual(['uellix_owner'])
    expect(o.to).toBe('uellix_cap_lead')
  })

  it('reads DROP OWNED BY', () => {
    const [o] = parseOwnedStatements(`DROP OWNED BY uellix_cap_lead;`)
    expect(o.verb).toBe('DROP')
    expect(o.to).toBeNull()
  })

  it('E-04: reads DISABLE ROW LEVEL SECURITY through a quoted, qualified table', () => {
    const [t] = parseRlsToggles(`ALTER TABLE "public"."marketing_leads" DISABLE ROW LEVEL SECURITY;`)
    expect(t).toEqual({ table: 'public.marketing_leads', action: 'DISABLE', origin: 'file' })
  })

  it('distinguishes all four RLS verbs, in order', () => {
    const toggles = parseRlsToggles(`
ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.t FORCE ROW LEVEL SECURITY;
ALTER TABLE public.t NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.t DISABLE ROW LEVEL SECURITY;
`)
    expect(toggles.map((t) => t.action)).toEqual(['ENABLE', 'FORCE', 'NO FORCE', 'DISABLE'])
  })

  it('reads ALTER TABLE … OWNER TO and keeps a function\'s argument list out of its name', () => {
    expect(parseOwnerships(`ALTER TABLE public.marketing_leads OWNER TO uellix_cap_lead;`)).toEqual([
      { objectType: 'TABLE', object: 'public.marketing_leads', owner: 'uellix_cap_lead', origin: 'file' },
    ])
    expect(parseOwnerships(`ALTER FUNCTION uellix_capability.f(text, text) OWNER TO r;`)[0].object).toBe(
      'uellix_capability.f',
    )
  })

  it('reads an ownership change made from inside a DO block', () => {
    const [o] = parseOwnerships(`DO $$ BEGIN ALTER TABLE public.t OWNER TO r; END $$;`)
    expect(o.origin).toBe('do-block')
  })

  it('F-01: reads ALTER DEFAULT PRIVILEGES, including its schema and its grantee', () => {
    const [d] = parseDefaultPrivileges(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA uellix_capability GRANT EXECUTE ON FUNCTIONS TO PUBLIC;`,
    )
    expect(d.action).toBe('GRANT')
    expect(d.inSchemas).toEqual(['uellix_capability'])
    expect(d.privileges).toEqual(['EXECUTE'])
    expect(d.grantees).toEqual(['public'])
  })

  it('does not report an ALTER DEFAULT PRIVILEGES as an ordinary GRANT', () => {
    // Otherwise the privilege contract would try to match a signature for a
    // privilege that has not been conferred on anything yet.
    expect(
      parseGrants(`ALTER DEFAULT PRIVILEGES IN SCHEMA s GRANT EXECUTE ON FUNCTIONS TO PUBLIC;`),
    ).toHaveLength(0)
  })

  it('reads index uniqueness, which a design argument rests on', () => {
    expect(parseIndexes(`CREATE UNIQUE INDEX IF NOT EXISTS uq_x ON public.t (a, b);`)).toEqual([
      { name: 'uq_x', table: 'public.t', unique: true },
    ])
    expect(parseIndexes(`CREATE INDEX IF NOT EXISTS uq_x ON public.t (a);`)[0].unique).toBe(false)
  })
})

describe('parser — fail closed', () => {
  it('the ten real packages contain nothing the parser cannot read', () => {
    // Asserted in tests/capability-policy-contract.test.ts against the files on
    // disk. Here the property is stated on a synthetic package so the test does
    // not depend on the working tree.
    expect(
      unparsedSecurityStatements(`
SET search_path = public;
CREATE POLICY p ON public.t AS RESTRICTIVE FOR SELECT TO r USING (true);
GRANT SELECT (a, b) ON public.t TO r;
REVOKE ALL ON FUNCTION s.f(text) FROM PUBLIC;
ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;
ALTER ROLE r NOLOGIN NOINHERIT NOSUPERUSER;
ALTER FUNCTION s.f(text) OWNER TO r;
DROP POLICY IF EXISTS p ON public.t;
CREATE UNIQUE INDEX IF NOT EXISTS i ON public.t (a);
COMMENT ON TABLE public.t IS 'GRANT SELECT ON public.t TO nobody';
`),
    ).toEqual([])
  })

  it('F-13: refuses ALTER POLICY, which rewrites a tuple the contract reads from CREATE', () => {
    const u = unparsedSecurityStatements(`ALTER POLICY p ON public.t TO uellix_app;`)
    expect(u).toHaveLength(1)
    expect(u[0].reason).toBe('unmodelled-form')
  })

  it('refuses SECURITY LABEL', () => {
    expect(
      unparsedSecurityStatements(`SECURITY LABEL FOR selinux ON TABLE public.t IS 'x';`)[0].reason,
    ).toBe('unmodelled-form')
  })

  it('refuses an ALTER ROLE carrying an attribute the model does not know', () => {
    const u = unparsedSecurityStatements(`ALTER ROLE r NOSUPERUSER SOMETHINGNEW;`)
    expect(u).toHaveLength(1)
    expect(u[0].detail).toContain('SOMETHINGNEW')
  })

  it('refuses a CREATE POLICY carrying a clause the model does not know', () => {
    expect(
      unparsedSecurityStatements(`CREATE POLICY p ON public.t FOR SELECT TO r NOSUCHCLAUSE (true);`)[0]
        .reason,
    ).toBe('unmodelled-form')
  })

  it('refuses a GRANT with no TO clause instead of skipping it', () => {
    // The old parser had `if (tailAt === -1) continue` — a statement it could
    // not finish reading became a statement that was not there.
    const u = unparsedSecurityStatements(`GRANT SELECT ON public.t;`)
    expect(u).toHaveLength(1)
    expect(u[0].reason).toBe('incomplete-statement')
  })

  it('refuses an ALTER TABLE that mentions OWNER in a shape it cannot read', () => {
    expect(
      unparsedSecurityStatements(`ALTER TABLE public.t OWNER;`)[0].reason,
    ).toBe('unmodelled-form')
  })

  it('lets ordinary non-security DDL through without a finding', () => {
    expect(
      unparsedSecurityStatements(`ALTER TABLE public.t ADD COLUMN a text NOT NULL DEFAULT '';`),
    ).toEqual([])
  })

  it('refuses CREATE RULE and CREATE TRIGGER, which change what runs on a protected table', () => {
    // A rewrite rule changes the query the server ends up executing; a trigger
    // runs code with the table owner's authority. Neither is expressible in the
    // capability contract and neither appears in any of the ten packages, so
    // both are refusals rather than statements nobody looks at.
    expect(
      unparsedSecurityStatements(`CREATE RULE r AS ON SELECT TO public.t DO INSTEAD SELECT 1;`)[0]
        .reason,
    ).toBe('unmodelled-form')
    expect(
      unparsedSecurityStatements(
        `CREATE TRIGGER g BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f();`,
      )[0].reason,
    ).toBe('unmodelled-form')
  })

  it('a non-opener costs one TOKEN, never a statement', () => {
    // The skip contract. `ON CONFLICT DO NOTHING` and `CREATE TABLE` leave the
    // classifier without producing a record, and the scanner then advances one
    // token — so a security statement sitting in the same text is still found.
    // The old parser's skips discarded whole statements instead.
    const sql = `
CREATE TABLE public.t (a int);
INSERT INTO public.t (a) VALUES (1) ON CONFLICT DO NOTHING;
GRANT SELECT ON public.t TO r;
`
    expect(parseGrants(sql).map((g) => g.object)).toEqual(['public.t'])
    expect(unparsedSecurityStatements(sql)).toEqual([])
  })

  it('never puts a string literal in a finding, so a token or a URL cannot leak', () => {
    const u = unparsedSecurityStatements(
      `DO $$ BEGIN EXECUTE format('GRANT SELECT ON t TO %I', 'sk_live_do_not_log_me'); END $$;`,
    )
    expect(u).toHaveLength(1)
    for (const field of [u[0].lead, u[0].detail, u[0].reason])
      expect(field).not.toContain('sk_live_do_not_log_me')
  })

  it('reports a finding with a line number, so it can be found in the file', () => {
    const u = unparsedSecurityStatements(`-- header\n-- header\nALTER POLICY p ON public.t TO r;`)
    expect(u[0].line).toBe(3)
  })
})

// ===========================================================================
// The adversarial round AGAINST this parser.
// ===========================================================================
//
// Two read-only reviewers attacked the rewritten reader. Three of their
// findings were BLOCKERs of exactly the shape the rewrite existed to close —
// a spelling PostgreSQL accepts, producing SILENCE rather than a finding. Each
// is pinned here as well as in the mutation catalogue, because a defect a
// reviewer found and nothing pins is a defect with a half-life.

describe('parser — the adversarial round', () => {
  it('A-01: decodes an E-string hex escape, so \\x47RANT is a GRANT', () => {
    // The decoder knew \n, \t and \r and dropped the backslash from the rest,
    // so this decoded to the text `x47RANT …`, whose first word opens nothing.
    // No statement, and — worse — no finding.
    const [g] = parseGrants(
      `DO $$ BEGIN EXECUTE E'\\x47RANT SELECT ON public.marketing_leads TO uellix_cap_lead'; END $$;`,
    )
    expect(g, 'the hex-escaped GRANT was not read at all').toBeDefined()
    expect(g.object).toBe('public.marketing_leads')
    expect(g.grantees).toEqual(['uellix_cap_lead'])
  })

  it('decodes octal and \\u escapes, and leaves an unknown escape as its character', () => {
    expect(executedLiterals(`DO $$ BEGIN EXECUTE E'\\107RANT'; END $$;`)).toEqual(['GRANT'])
    expect(executedLiterals(`DO $$ BEGIN EXECUTE E'\\u0047RANT'; END $$;`)).toEqual(['GRANT'])
    expect(executedLiterals(`DO $$ BEGIN EXECUTE E'\\qRANT'; END $$;`)).toEqual(['qRANT'])
    // The escape that must NOT close the string.
    expect(executedLiterals(`DO $$ BEGIN EXECUTE E'it\\'s'; END $$;`)).toEqual(["it's"])
  })

  it('A-06: refuses a U& string instead of decoding it approximately', () => {
    // An approximate decode is worse than none: the near miss re-lexes as a
    // word that opens nothing, which is how a statement disappears.
    const u = unparsedSecurityStatements(
      `DO $$ BEGIN EXECUTE U&'\\0047RANT SELECT ON public.t TO r'; END $$;`,
    )
    expect(u.length).toBeGreaterThan(0)
    expect(u[0].reason).toBe('unmodelled-form')
  })

  it('A-06: refuses a U& IDENTIFIER rather than reading a different object', () => {
    // Lexed naively `U&"x"` becomes the word U, the operator & and an
    // identifier — so the statement the parser judges names a different role
    // from the one PostgreSQL applies.
    const u = unparsedSecurityStatements(`GRANT SELECT ON public.t TO U&"uellix_app";`)
    expect(u.map((x) => x.reason)).toContain('unmodelled-form')
    expect(parseGrants(`GRANT SELECT ON public.t TO U&"uellix_app";`)).toEqual([])
  })

  it('A-02: descends into a function body written with single quotes, and refuses the form', () => {
    const sql =
      `CREATE OR REPLACE FUNCTION uellix_capability.helper() RETURNS void\n` +
      `LANGUAGE plpgsql SECURITY DEFINER AS\n` +
      `'BEGIN GRANT SELECT ON public.marketing_leads TO uellix_cap_lead; END';`
    // Both halves matter. The GRANT must be SEEN...
    const [g] = parseGrants(sql)
    expect(g, 'the body was not descended into').toBeDefined()
    expect(g.grantees).toEqual(['uellix_cap_lead'])
    // ...and the form itself refused, because the SECURITY DEFINER gate finds
    // functions with a regex anchored on the dollar-quoted form, so a function
    // written this way is outside that inventory too.
    expect(unparsedSecurityStatements(sql).map((u) => u.reason)).toContain('unmodelled-form')
  })

  it('B-06: reports an unterminated literal instead of swallowing the rest of the file', () => {
    // Everything after the stray quote is one string token, so every statement
    // below it is invisible. Silence over the tail of a file is the single
    // worst outcome available to this parser.
    const sql = `SELECT 'oops;\nREVOKE SELECT ON public.t FROM r;\nGRANT SELECT ON public.t TO r;`
    const u = unparsedSecurityStatements(sql)
    expect(u.map((x) => x.reason)).toContain('unterminated-body')
  })

  it('B-06: reports an unterminated TAGGED dollar quote, which a $$ parity count cannot see', () => {
    const u = unparsedSecurityStatements(`CREATE FUNCTION f() RETURNS void AS $body$ BEGIN NULL;`)
    expect(u.map((x) => x.reason)).toContain('unterminated-body')
  })

  it('B-07: reads CREATE SCHEMA … AUTHORIZATION as the ownership statement it is', () => {
    // Schema ownership confers CREATE and DROP over everything in it. The
    // classifier returned early here with a comment claiming AUTHORIZATION was
    // read elsewhere, and nothing read it.
    expect(parseOwnerships(`CREATE SCHEMA IF NOT EXISTS uellix_capability AUTHORIZATION uellix_owner;`)).toEqual([
      { objectType: 'SCHEMA', object: 'uellix_capability', owner: 'uellix_owner', origin: 'file' },
    ])
  })

  it('B-09: refuses an ALTER … OWNER TO whose object name it cannot read', () => {
    const u = unparsedSecurityStatements(`ALTER LARGE OBJECT 12345 OWNER TO uellix_cap_lead;`)
    expect(u.map((x) => x.reason)).toContain('incomplete-statement')
  })

  it('B-09: refuses a grantee list that does not read to its end, instead of truncating it', () => {
    const u = unparsedSecurityStatements(`GRANT SELECT ON public.t TO a, 42, b;`)
    expect(u.map((x) => x.reason)).toContain('incomplete-statement')
    expect(parseGrants(`GRANT SELECT ON public.t TO a, 42, b;`)).toEqual([])
  })

  it('A-04: refuses executable bodies nested deeper than it reads', () => {
    // Six levels. The depth cap is a backstop against pathological nesting, and
    // a backstop that returns SILENTLY is a fail-open.
    let sql = 'GRANT SELECT ON public.t TO r;'
    for (let i = 0; i < 6; i++) sql = `DO $l${i}$ BEGIN ${sql} END $l${i}$;`
    const u = unparsedSecurityStatements(sql)
    expect(u.map((x) => x.reason)).toContain('unmodelled-form')
  })

  it('A-03: reads a role statement for a role that is not a capability role', () => {
    // The parser always could; nothing CONSUMED it. Pinned here so the parser
    // half cannot regress silently while the gate half looks intact.
    const [s] = parseRoleStatements(`ALTER ROLE uellix_writer BYPASSRLS;`)
    expect(s.role).toBe('uellix_writer')
    expect(s.attributes).toEqual(['BYPASSRLS'])
  })
})
