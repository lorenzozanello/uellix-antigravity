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
