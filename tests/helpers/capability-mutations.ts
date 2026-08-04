// tests/helpers/capability-mutations.ts
//
// The mutation catalogue: every security property the capability design claims,
// expressed as the edit that would break it.
//
// M-* are the twenty-two mutations that survived a 220/220 run of
// tests/capability-isolation.test.ts. Each one is recorded with the reason it
// survived, because "the suite counts policies" is not a reason — the reason is
// always a specific structural blindness, and naming it is what stops the same
// blindness returning in a different gate.
//
// N-* are added here. They are not padding: each covers a property the M-*
// mutations do not reach (ordering, role attributes, function volatility,
// rollback symmetry), chosen so that no single gate accounts for more than a
// handful of kills.
//
// RULE. A mutation counts as DETECTED only when evaluateCapabilityGates()
// returns a violation for it. It does NOT count as detected because the mutated
// SQL would fail to compile — unless compiling is itself the protected property,
// which is true for none of these.

export type Severity = 'BLOCKER' | 'MAJOR'

export interface Mutation {
  readonly id: string
  readonly capability: 'CAP-01' | 'CAP-02' | 'CAP-03' | 'CAP-04' | 'CAP-05' | 'CROSS'
  readonly file: string
  /** What the edit does, in one line. */
  readonly change: string
  /** The security property it breaks. */
  readonly breaks: string
  readonly severity: Severity
  /** Why tests/capability-isolation.test.ts does not see it. Empty for N-*. */
  readonly survivedBecause: string
  /**
   * The gate that must refuse this mutation.
   *
   * Without it the harness asserts only `violations.length > 0`, which is a
   * strictly weaker claim than it appears: a mutation can be caught by a gate
   * that has nothing to do with the property it tests, and the day the RIGHT
   * gate is weakened the suite stays green because the wrong one still fires.
   * That was not hypothetical — N-08 tests "the first read takes the lock" and
   * was caught by `cap01-order-replay`, not by `cap01-order-unlocked-read`,
   * which turned out to be definitionally true.
   *
   * Where two gates are both correct answers, list both.
   */
  readonly expectedGate: readonly string[]
  readonly apply: (sql: string) => string
}

/**
 * A LITERAL replacement that MUST match, so a stale anchor fails loudly.
 *
 * The replacement is supplied as a function, not as a string, and that is not
 * style. `String.prototype.replace` treats `$&`, `` $` ``, `$'` and `$1` in a
 * string replacement as substitution patterns — and these packages are full of
 * anchored regex literals like `'^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'`, whose
 * trailing `$'` means "everything after the match". Passing that as a string
 * grew a 35 KB file to 47 KB and produced a mutant nobody wrote. The
 * `mask-desync` gate caught it, which is the only reason it is documented here
 * rather than shipped.
 */
const sub = (find: string, replace: string) => (sql: string): string => {
  if (!sql.includes(find)) throw new Error(`mutation anchor not found: ${JSON.stringify(find.slice(0, 80))}`)
  return sql.replace(find, () => replace)
}

/**
 * Insert `extra` immediately BEFORE a literal anchor that must exist.
 *
 * Appending to the end of a file would also "change the text", but it would
 * change it somewhere no reviewer looks and somewhere no owner window is open.
 * Every evasion below lands inside the package's own `SET ROLE uellix_owner`
 * section — where a real one would have to land to do anything.
 */
const before = (anchor: string, extra: string) => (sql: string): string => {
  if (!sql.includes(anchor)) throw new Error(`mutation anchor not found: ${JSON.stringify(anchor.slice(0, 80))}`)
  return sql.replace(anchor, () => `${extra}\n${anchor}`)
}

const CAP01 = 'stella_0006_invitation_capability.sql'
const CAP02 = 'stella_0007_public_verification_capability.sql'
const CAP03 = 'stella_0008_stripe_webhook_identity.sql'
const CAP04 = 'stella_0009_public_lead_capability.sql'
const CAP05 = 'stella_0010_organization_bootstrap_capability.sql'
const RB01 = 'stella_0006_rollback.sql'
const RB02 = 'stella_0007_rollback.sql'
const CAP06 = 'stella_0011_organization_column_acl.sql'
const RB06 = 'stella_0011_rollback.sql'
const CAP07 = 'stella_0012_super_admin_column_acl.sql'
const RB07 = 'stella_0012_rollback.sql'

export const MUTATIONS: readonly Mutation[] = [
  // =========================================================================
  // M-01 … M-22 — the survivors
  // =========================================================================

  {
    id: 'M-01',
    capability: 'CAP-01',
    file: CAP01,
    change: 'the RESTRICTIVE cap_invitation_only_accept is retargeted to uellix_app',
    breaks:
      'the only bound that cannot be OR-ed away by the {public} baseline policies. Retargeted, the definer can drive ANY invitation transition — revoke, reopen, reassign — while the permissive policy that appears to bound it is satisfied by a baseline policy the caller already matches.',
    severity: 'BLOCKER',
    survivedBecause:
      'the suite counts three AS RESTRICTIVE policies and checks each statement matches /TO \\w+/. Both still hold; only the role changed, and no gate read it.',
    expectedGate: ['policy-to'],
    apply: sub(
      'ON public.invitations AS RESTRICTIVE FOR UPDATE TO uellix_cap_invitation',
      'ON public.invitations AS RESTRICTIVE FOR UPDATE TO uellix_app',
    ),
  },
  {
    id: 'M-02',
    capability: 'CAP-01',
    file: CAP01,
    change: 'the WITH CHECK of cap_invitation_update_invitations is removed',
    breaks:
      'the post-image bound on the accepted row. Without it the permissive policy admits any new status the column ACL permits, and accepted_by may be left NULL — so an acceptance need not record who accepted.',
    severity: 'MAJOR',
    survivedBecause:
      'the policy still exists, still names its role, and the nine/three counts are unchanged. No gate ever read a WITH CHECK.',
    expectedGate: ['policy-with-check'],
    apply: sub(
      `ON public.invitations FOR UPDATE TO uellix_cap_invitation
USING (status = 'pending')
WITH CHECK (status = 'accepted' AND accepted_by IS NOT NULL);`,
      `ON public.invitations FOR UPDATE TO uellix_cap_invitation
USING (status = 'pending');`,
    ),
  },
  {
    id: 'M-03',
    capability: 'CAP-01',
    file: CAP01,
    change: "the RESTRICTIVE cap_invitation_only_accept relaxes USING to (true)",
    breaks:
      'the pre-image bound. `USING (status = \'pending\')` is what makes pending→accepted the ONLY transition; relaxed to true, the restrictive policy stops restricting and an already-revoked invitation becomes updatable.',
    severity: 'BLOCKER',
    survivedBecause: 'the RESTRICTIVE count is unchanged and no gate compared the predicate.',
    expectedGate: ['policy-using'],
    apply: sub(
      `ON public.invitations AS RESTRICTIVE FOR UPDATE TO uellix_cap_invitation
USING (status = 'pending')`,
      `ON public.invitations AS RESTRICTIVE FOR UPDATE TO uellix_cap_invitation
USING (true)`,
    ),
  },
  {
    id: 'M-04',
    capability: 'CAP-01',
    file: CAP01,
    change: 'cap_invitation_select_users stops binding the row to auth.uid()',
    breaks:
      'the caller-own-row bound on public.users. The definer holds SELECT (id, email) on the whole table; the policy is the only thing that stops the body reading anyone\'s address, which turns the accept endpoint into an e-mail oracle.',
    severity: 'MAJOR',
    survivedBecause: 'a policy named its role and existed; that was the whole test.',
    expectedGate: ['policy-using'],
    apply: sub(
      `ON public.users FOR SELECT TO uellix_cap_invitation
USING (id = auth.uid());`,
      `ON public.users FOR SELECT TO uellix_cap_invitation
USING (true);`,
    ),
  },
  {
    id: 'M-05',
    capability: 'CAP-01',
    file: CAP01,
    change: "cap_invitation_insert_members drops role <> 'super_admin'",
    breaks:
      'the database-layer refusal of a super_admin membership. The check exists in createInvitation() too, and the duplication is the point: this is the copy that survives a rewrite of the application one.',
    severity: 'MAJOR',
    survivedBecause: 'the WITH CHECK was never parsed, only the policy name counted.',
    expectedGate: ['policy-with-check'],
    apply: sub(
      `ON public.organization_members FOR INSERT TO uellix_cap_invitation
WITH CHECK (status = 'active' AND role <> 'super_admin');`,
      `ON public.organization_members FOR INSERT TO uellix_cap_invitation
WITH CHECK (status = 'active');`,
    ),
  },
  {
    id: 'M-06',
    capability: 'CAP-01',
    file: CAP01,
    change: 'cap_invitation_insert_audit stops requiring a non-NULL actor',
    breaks:
      'attribution. stella_0005c bound audit rows written by a human-facing runtime to the session user; a NULL actor makes an acceptance unattributable and collides with the CAP-03 mirror policy that requires NULL.',
    severity: 'MAJOR',
    survivedBecause: 'no gate read this WITH CHECK; only CAP-03\'s equivalent had a bespoke assertion.',
    expectedGate: ['policy-with-check'],
    apply: sub(
      `WITH CHECK (
  actor_user_id IS NOT NULL
  AND entity_type IN ('invitation','organization_member')`,
      `WITH CHECK (
  entity_type IN ('invitation','organization_member')`,
    ),
  },

  {
    id: 'M-07',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the RESTRICTIVE cap_verification_only_locked relaxes to (true)',
    breaks:
      'the locked-only bound on the public read path. The permissive twin is OR-ed with the {public} baseline policies, so this restrictive one is the real gate: relaxed, a DRAFT report becomes publicly verifiable.',
    severity: 'BLOCKER',
    survivedBecause:
      'the CAP-02 gate asserts restrictiveCount is 2 and that each restrictive name is dropped by the rollback. Both hold after the edit; the predicate itself was never compared to anything.',
    expectedGate: ['policy-using'],
    apply: sub(
      `ON public.sroi_reports AS RESTRICTIVE FOR SELECT TO uellix_cap_verification
USING (status = 'locked');`,
      `ON public.sroi_reports AS RESTRICTIVE FOR SELECT TO uellix_cap_verification
USING (true);`,
    ),
  },
  {
    id: 'M-08',
    capability: 'CAP-02',
    file: CAP02,
    change: 'show_issued_on defaults to true',
    breaks:
      'publication is opt-in. Approving a disclosure without setting any flag is supposed to publish authenticity and nothing else; with this default it also publishes the lock date of a report whose owner never chose to reveal it.',
    severity: 'BLOCKER',
    survivedBecause:
      'the flag gate iterated FOUR names. show_issued_on and show_report_variant were added in round 2 and no gate followed them.',
    expectedGate: ['cap02-flag-default'],
    apply: sub(
      'show_issued_on         boolean     NOT NULL DEFAULT false',
      'show_issued_on         boolean     NOT NULL DEFAULT true',
    ),
  },
  {
    id: 'M-09',
    capability: 'CAP-02',
    file: CAP02,
    change: 'disclosures_insert_admin stops pinning approved_by to auth.uid()',
    breaks:
      'the table COMMENT\'s claim that each row is one human decision WITH ITS AUTHOR. An admin can record a colleague as the approver of a publication they did not approve.',
    severity: 'MAJOR',
    survivedBecause:
      'disclosures_* policies are not cap_*-prefixed, so policyCount never counted them and nothing else looked.',
    expectedGate: ['policy-with-check'],
    apply: sub('  approved_by = auth.uid()\n  AND EXISTS (', '  EXISTS ('),
  },
  {
    id: 'M-10',
    capability: 'CAP-02',
    file: CAP02,
    change: 'disclosures_select_member is widened to TO PUBLIC',
    breaks:
      'tenancy on the internal read of publication decisions. TO PUBLIC applies the policy to every role including anon, so the predicate — which is satisfied for a super admin — becomes the only barrier.',
    severity: 'MAJOR',
    survivedBecause:
      'the "no policy without a TO clause" gate asserts the statement matches /\\bTO\\s+\\w+/i, and `TO PUBLIC` matches it. The gate written to prevent the stella_0005c defect accepts its explicit form.',
    expectedGate: ['policy-to-widened'],
    apply: sub(
      'ON public.report_public_disclosures FOR SELECT TO uellix_app',
      'ON public.report_public_disclosures FOR SELECT TO PUBLIC',
    ),
  },
  {
    id: 'M-11',
    capability: 'CAP-02',
    file: CAP02,
    change: 'disclosures_update_admin is deleted outright',
    breaks:
      'revocation. With no UPDATE policy the runtime cannot revoke a disclosure at all — and the revoked_by pinning goes with it, so the failure is silent until someone needs to un-publish.',
    severity: 'MAJOR',
    survivedBecause: 'nothing in the suite knew this policy existed.',
    expectedGate: ['policy-inventory'],
    apply: (sql) => {
      const start = sql.indexOf('DROP POLICY IF EXISTS disclosures_update_admin')
      const end = sql.indexOf('-- The runtime\'s DML surface on the new table')
      if (start === -1 || end === -1 || end < start) throw new Error('M-11 anchors not found')
      return sql.slice(0, start) + sql.slice(end)
    },
  },

  {
    id: 'M-12',
    capability: 'CAP-03',
    file: CAP03,
    change: 'cap_stripe_insert_audit drops the stripe. action-prefix guard',
    breaks:
      'the disjointness of the two audit policies. The CAP-03 and uellix_app policies are disjoint by role AND by action prefix; without the prefix the webhook identity can write an audit row claiming any action, with a NULL actor.',
    severity: 'MAJOR',
    survivedBecause:
      'the bespoke assertion checked only that the predicate contains `actor_user_id IS NULL`. Everything else in the clause was invisible.',
    expectedGate: ['policy-with-check'],
    apply: sub(
      `  actor_user_id IS NULL
  AND entity_type = 'organization'
  AND pg_catalog.left(action, 7) = 'stripe.'`,
      `  actor_user_id IS NULL
  AND entity_type = 'organization'`,
    ),
  },
  {
    id: 'M-13',
    capability: 'CAP-03',
    file: CAP03,
    change: "the 'organization' match kind returns to stripe_apply_subscription",
    breaks:
      'DP-CAP-15. That branch resolves the organisation from session.client_reference_id, which a Payment Link accepts as a buyer-supplied parameter. Any subscriber can bind their Stripe customer to an organisation that has never subscribed, and receive its quota.',
    severity: 'BLOCKER',
    survivedBecause: 'no gate read the allowlist; the suite checked SQLSTATE handling and grants only.',
    expectedGate: ['cap03-match-kind'],
    // BOTH halves, and the second is the point. Widening the allowlist alone is
    // a no-op in effect: the resolution query has two arms, so a match_kind of
    // 'organization' makes both false, array_agg returns NULL and the function
    // refuses anyway. The adversarial review caught the catalogue claiming a
    // vulnerability its own edit did not restore — a mutation that dies for the
    // wrong reason still counts as caught, which is exactly how a matrix starts
    // lying. The resolution arm is re-added so the mutant is the vulnerability
    // it says it is.
    apply: (sql) =>
      sub(
        `      OR (p_match_kind = 'subscription' AND o.stripe_subscription_id = p_match_value);`,
        `      OR (p_match_kind = 'subscription' AND o.stripe_subscription_id = p_match_value)
      OR (p_match_kind = 'organization'  AND o.id = p_match_value::uuid);`,
      )(
        sub(
          `  IF p_match_kind NOT IN ('customer','subscription')`,
          `  IF p_match_kind NOT IN ('customer','subscription','organization')`,
        )(sql),
      ),
  },
  {
    id: 'M-14',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the claimed-event guard is removed from stripe_apply_subscription',
    breaks:
      'the link between a signed webhook and the change it authorises. Without it, anything holding EXECUTE can apply a quota change for an event no signed delivery ever asked for — the whole point of stripe_begin_event.',
    severity: 'BLOCKER',
    survivedBecause: 'the suite verified the function existed, was SECURITY DEFINER and had an EXCEPTION block.',
    expectedGate: ['cap03-claimed-event'],
    // Re-anchored when RR-CAP-14 widened the claim check with the address
    // correlation. Deleting the whole guard is still the mutation; it is just
    // six lines longer than it was.
    apply: sub(
      `  IF NOT EXISTS (
    SELECT 1 FROM public.stripe_webhook_events e
     WHERE e.event_id = p_event_id
       AND e.status = 'processing'`,
      `  IF NOT EXISTS (
    SELECT 1 FROM public.stripe_webhook_events e
     WHERE true`,
    ),
  },
  {
    id: 'M-15',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the UPDATE grant on organizations gains the country column',
    breaks:
      'the blast radius of the webhook definer. The column ACL is the bound that survives a rewritten body; the policy is USING (true), so the grant IS the boundary.',
    severity: 'MAJOR',
    survivedBecause:
      'the bespoke gate asserted only that name, slug and status are absent from the list. Any other column could be added freely.',
    expectedGate: ['grant-extra'],
    apply: sub(
      `GRANT UPDATE (stripe_customer_id, stripe_subscription_id, stripe_price_id,
              stella_monthly_quota, stella_plan_label, updated_at)
  ON public.organizations TO uellix_cap_stripe;`,
      `GRANT UPDATE (stripe_customer_id, stripe_subscription_id, stripe_price_id,
              stella_monthly_quota, stella_plan_label, updated_at, country)
  ON public.organizations TO uellix_cap_stripe;`,
    ),
  },
  {
    id: 'M-16',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the audit INSERT grant loses actor_user_id',
    breaks:
      'the declared privilege surface, which is the thing the grant contract exists to fix in place. Measured effect, corrected after adversarial review: this is NOT a privilege escalation — stripe_apply_subscription names actor_user_id explicitly, so removing it from the grant makes the function fail 42501 at run time, inside a live webhook. It is a contract drift with an availability consequence, and it belongs in the matrix for the same reason M-15 does: an undeclared change to a column list must not pass.',
    severity: 'MAJOR',
    survivedBecause: 'no gate compared the column list of any grant.',
    expectedGate: ['grant-missing'],
    apply: sub(
      `GRANT INSERT (organization_id, actor_user_id, entity_type, entity_id, action,
              before_json, after_json, reason)
  ON public.audit_logs TO uellix_cap_stripe;`,
      `GRANT INSERT (organization_id, entity_type, entity_id, action,
              before_json, after_json, reason)
  ON public.audit_logs TO uellix_cap_stripe;`,
    ),
  },

  {
    id: 'M-17',
    capability: 'CAP-04',
    file: CAP04,
    change: 'the definer grant fuses INSERT with SELECT in one statement',
    breaks:
      'the defining property of CAP-04: the capability that writes leads cannot enumerate them. With SELECT the anonymous endpoint becomes a membership oracle for every address in the table.',
    severity: 'BLOCKER',
    survivedBecause:
      'the gate captured the privilege list as ONE string and asserted it matches /^INSERT/. `INSERT (…), SELECT` satisfies that. The package postcondition would catch it live — but this suite is the offline gate, and it passed.',
    expectedGate: ['cap04-no-read'],
    apply: sub(
      `GRANT INSERT (email, company_name, sroi_result, source, lead_status, consent_version)
  ON public.marketing_leads TO uellix_cap_lead;`,
      `GRANT INSERT (email, company_name, sroi_result, source, lead_status, consent_version), SELECT
  ON public.marketing_leads TO uellix_cap_lead;`,
    ),
  },
  {
    id: 'M-18',
    capability: 'CAP-04',
    file: CAP04,
    change: "cap_lead_insert stops pinning lead_status to 'new'",
    breaks:
      'the constant status. The body writes \'new\', but the policy is what holds if the body is rewritten; without it a lead can be inserted already marked qualified.',
    severity: 'MAJOR',
    survivedBecause: 'policyCount for CAP-04 is 2 and stayed 2.',
    expectedGate: ['policy-with-check'],
    apply: sub(
      `ON public.marketing_leads FOR INSERT TO uellix_cap_lead
WITH CHECK (lead_status = 'new');`,
      `ON public.marketing_leads FOR INSERT TO uellix_cap_lead
WITH CHECK (true);`,
    ),
  },
  {
    id: 'M-19',
    capability: 'CAP-04',
    file: CAP04,
    change: 'the source allowlist gains a free-text value',
    breaks:
      'the fixed list that closes content injection into whatever consumes `source` downstream. An allowlist with an escape hatch is a varchar(100) again.',
    severity: 'MAJOR',
    survivedBecause:
      'the CAP-04 assertions cover the grant shape, RETURNS void, the ON CONFLICT form and the absence of a status parameter. The body\'s validation logic was never inspected, so any allowlist would have passed.',
    expectedGate: ['cap04-source-allowlist'],
    apply: sub(
      `OR p_source NOT IN ('sroi_calculator','landing_hero','pricing','demo_request','contact_form') THEN`,
      `OR p_source NOT IN ('sroi_calculator','landing_hero','pricing','demo_request','contact_form','other') THEN`,
    ),
  },
  {
    id: 'M-20',
    capability: 'CAP-04',
    file: CAP04,
    change: 'cap_lead_deny_runtime relaxes USING (false) to USING (true)',
    breaks:
      'the durable half of the net reduction. Stated precisely after adversarial review: with WITH CHECK (false) intact, writes stay denied, and reads stay denied anyway because no permissive policy on this table names uellix_app — RLS denies by default. So this is a defence-in-depth removal, not an open door TODAY. What it removes is the guarantee that survives re-applying stella_0004 §6b, which unconditionally restores the runtime grant and passes its own postcondition. The bound stops being durable, which is the only reason the policy exists.',
    severity: 'MAJOR',
    survivedBecause: 'it is still RESTRICTIVE, still FOR ALL, still named uellix_app. Only the predicate changed.',
    expectedGate: ['policy-using'],
    apply: sub(
      `ON public.marketing_leads AS RESTRICTIVE FOR ALL TO uellix_app
USING (false) WITH CHECK (false);`,
      `ON public.marketing_leads AS RESTRICTIVE FOR ALL TO uellix_app
USING (true) WITH CHECK (false);`,
    ),
  },

  {
    id: 'M-21',
    capability: 'CAP-05',
    file: CAP05,
    change: 'the idempotency claim reverts to SELECT … FOR UPDATE on a row that does not exist yet',
    breaks:
      'serialisation of concurrent bootstraps — and more than that. FOR UPDATE locks nothing when the row is absent, so both callers proceed; but the replacement also never INSERTS the attempts row, so the key is never claimed at all, not even in the sequential case. Idempotency and serialisation go together, which is why the claim is one statement.',
    severity: 'BLOCKER',
    survivedBecause:
      'the suite has no gate on the claim at all — the CAP-05 assertions are about the signature, the subject, the slug and the reserved list.',
    expectedGate: ['cap05-claim-atomic'],
    apply: sub(
      `  INSERT INTO public.capability_bootstrap_attempts (user_id, idempotency_key)
  VALUES (v_subject, p_idempotency_key)
  ON CONFLICT ON CONSTRAINT capability_bootstrap_attempts_pkey DO NOTHING
  RETURNING true INTO v_claimed;`,
      `  SELECT true INTO v_claimed
    FROM public.capability_bootstrap_attempts a
   WHERE a.user_id = v_subject AND a.idempotency_key = p_idempotency_key
     FOR UPDATE;
  v_claimed := NOT v_claimed IS TRUE;`,
    ),
  },
  {
    id: 'M-22',
    capability: 'CAP-05',
    file: CAP05,
    change: 'the RESTRICTIVE cap_bootstrap_only_founder stops pinning the founding role',
    breaks:
      'the answer to members_insert_admin. Only organization_admin, only active — relaxed, the bootstrap definer can insert a membership with any role the column ACL admits.',
    severity: 'MAJOR',
    survivedBecause: 'restrictiveCount for CAP-05 stayed at 3, and the bespoke gate read the PERMISSIVE twin only.',
    expectedGate: ['policy-with-check'],
    apply: sub(
      `ON public.organization_members AS RESTRICTIVE FOR INSERT TO uellix_cap_bootstrap
WITH CHECK (role = 'organization_admin' AND status = 'active');`,
      `ON public.organization_members AS RESTRICTIVE FOR INSERT TO uellix_cap_bootstrap
WITH CHECK (status = 'active');`,
    ),
  },

  // =========================================================================
  // N-01 … N-23 — added by this unit
  // =========================================================================

  {
    id: 'N-01',
    capability: 'CAP-01',
    file: CAP01,
    change: 'cap_invitation_select_users is attached to public.organizations instead',
    breaks: 'the policy binds nothing on the table it was written for, and RLS on public.users falls back to the baseline.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-table'],
    apply: sub(
      `CREATE POLICY cap_invitation_select_users
ON public.users FOR SELECT TO uellix_cap_invitation`,
      `CREATE POLICY cap_invitation_select_users
ON public.organizations FOR SELECT TO uellix_cap_invitation`,
    ),
  },
  {
    id: 'N-02',
    capability: 'CAP-05',
    file: CAP05,
    change: 'cap_bootstrap_insert_audit loses its TO clause entirely',
    breaks: 'a policy with no TO is TO PUBLIC — the exact defect stella_0005c had to repair.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-to-absent'],
    apply: sub(
      'ON public.audit_logs FOR INSERT TO uellix_cap_bootstrap\nWITH CHECK (\n  actor_user_id IS NOT NULL',
      'ON public.audit_logs FOR INSERT\nWITH CHECK (\n  actor_user_id IS NOT NULL',
    ),
  },
  {
    id: 'N-03',
    capability: 'CAP-04',
    file: CAP04,
    change: 'cap_lead_deny_runtime is downgraded from RESTRICTIVE to PERMISSIVE',
    breaks: 'a permissive USING (false) is OR-ed with every other permissive policy and denies nothing.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-mode'],
    apply: sub(
      'ON public.marketing_leads AS RESTRICTIVE FOR ALL TO uellix_app',
      'ON public.marketing_leads FOR ALL TO uellix_app',
    ),
  },
  {
    id: 'N-04',
    capability: 'CAP-01',
    file: CAP01,
    change: 'the recipient e-mail comparison is removed',
    breaks: 'anyone holding a token can accept an invitation addressed to somebody else.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap01-email-check'],
    apply: sub(
      `  IF v_subject_email IS NULL
     OR v_subject_email <> pg_catalog.lower(pg_catalog.btrim(v_inv_email)) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;`,
      '',
    ),
  },
  {
    id: 'N-05',
    capability: 'CAP-01',
    file: CAP01,
    change: "the e-mail is taken from request.jwt.claims instead of public.users",
    breaks: 'the claim is asserted by the identity provider and may be unverified; the whole point is to compare against a row the database owns.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap01-no-jwt-email'],
    apply: sub(
      `  SELECT pg_catalog.lower(pg_catalog.btrim(u.email))
    INTO v_subject_email
    FROM public.users u
   WHERE u.id = v_subject;`,
      `  v_subject_email := pg_catalog.lower(pg_catalog.btrim(
    pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'email'));`,
    ),
  },
  {
    id: 'N-06',
    capability: 'CAP-01',
    file: CAP01,
    change: 'the expiry check is removed',
    breaks: 'an expired token is accepted, so a deadline the product states is not enforced anywhere.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap01-expiry'],
    apply: sub(
      `  IF v_inv_expires_at <= (pg_catalog.now() AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;`,
      '',
    ),
  },
  {
    id: 'N-07',
    capability: 'CAP-01',
    file: CAP01,
    change: 'the FOR UPDATE lock is dropped from the pending path',
    breaks: 'two concurrent acceptances of the same invitation both pass every check and both insert a membership.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap01-order-lock-present'],
    apply: sub(
      `  SELECT i.status INTO v_inv_status
    FROM public.invitations i
   WHERE i.id = v_inv_id
     FOR UPDATE;`,
      `  SELECT i.status INTO v_inv_status
    FROM public.invitations i
   WHERE i.id = v_inv_id;`,
    ),
  },
  {
    id: 'N-08',
    capability: 'CAP-01',
    file: CAP01,
    change: 'the first read of the invitation takes the lock, moving it before the replay branch',
    breaks:
      "the idempotent replay. FOR UPDATE is filtered by the UPDATE policy's USING (status='pending'), so a locking read of an accepted row returns NOT FOUND and a user reloading the accept page gets a refusal instead of their membership.",
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap01-order-unlocked-read'],
    apply: sub(
      `    FROM public.invitations i
   WHERE i.token_hash = v_hash;`,
      `    FROM public.invitations i
   WHERE i.token_hash = v_hash
     FOR UPDATE;`,
    ),
  },
  {
    id: 'N-09',
    capability: 'CAP-05',
    file: CAP05,
    change: 'bootstrap_organization accepts an owner_user_id and uses it as the subject',
    breaks: 'the owner becomes caller-controlled: anyone with EXECUTE can create an organisation owned by another person.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap05-no-authority-param'],
    apply: (sql) =>
      sub(
        '  p_idempotency_key uuid,\n  p_name            text,',
        '  p_idempotency_key uuid,\n  p_owner_user_id   uuid,\n  p_name            text,',
      )(sub('  v_subject := auth.uid();', '  v_subject := p_owner_user_id;')(sql)),
  },
  {
    id: 'N-10',
    capability: 'CAP-05',
    file: CAP05,
    change: 'p_actor is reintroduced and trusted when auth.uid() is NULL',
    breaks: 'the identity stops being proven and becomes asserted — the exact reason a technical bootstrap role was rejected.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap05-no-actor'],
    apply: (sql) =>
      sub(
        '  p_idempotency_key uuid,\n  p_name            text,',
        '  p_idempotency_key uuid,\n  p_actor           uuid,\n  p_name            text,',
      )(sub('  v_subject := auth.uid();', '  v_subject := COALESCE(auth.uid(), p_actor);')(sql)),
  },
  {
    id: 'N-11',
    capability: 'CAP-05',
    file: CAP05,
    change: 'the key is claimed AFTER the organisation is created',
    breaks:
      'the loser of a concurrent race keeps an organisation it can never reach through the idempotency key, and the single-membership index is the only thing left holding the line.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap05-claim-order'],
    apply: (sql) => {
      const claimStart = sql.indexOf('  INSERT INTO public.capability_bootstrap_attempts (user_id, idempotency_key)')
      const claimEnd = sql.indexOf('  -- One active membership per subject.')
      const orgEnd = sql.indexOf('  RETURNING id INTO v_org_id;')
      if (claimStart === -1 || claimEnd === -1 || orgEnd === -1) throw new Error('N-11 anchors not found')
      const block = sql.slice(claimStart, claimEnd)
      const without = sql.slice(0, claimStart) + sql.slice(claimEnd)
      const at = without.indexOf('  RETURNING id INTO v_org_id;') + '  RETURNING id INTO v_org_id;\n'.length
      return without.slice(0, at) + '\n' + block + without.slice(at)
    },
  },
  {
    id: 'N-12',
    capability: 'CAP-03',
    file: CAP03,
    change: "stripe_apply_subscription marks the event 'failed' inside the transaction it then aborts",
    breaks:
      'the RAISE rolls the UPDATE back, so the event stays in processing with a NULL error code and every retry gets in_progress until the lease expires — silent loss.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap03-failure-transaction'],
    apply: sub(
      `  IF v_org_ids IS NULL OR pg_catalog.array_length(v_org_ids, 1) <> 1 THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;`,
      `  IF v_org_ids IS NULL OR pg_catalog.array_length(v_org_ids, 1) <> 1 THEN
    UPDATE public.stripe_webhook_events
       SET status = 'failed'
     WHERE event_id = p_event_id;
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;`,
    ),
  },
  {
    id: 'N-13',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the webhook definer gains DELETE on stripe_webhook_events',
    breaks: 'the capability can erase the record of what it did, which is the one thing the retained table exists for.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['grant-extra'],
    apply: sub(
      'GRANT SELECT, INSERT ON public.stripe_webhook_events TO uellix_cap_stripe;',
      'GRANT SELECT, INSERT, DELETE ON public.stripe_webhook_events TO uellix_cap_stripe;',
    ),
  },
  {
    id: 'N-14',
    capability: 'CAP-04',
    file: CAP04,
    change: 'submit_lead adds RETURNING to its insert',
    breaks:
      'RETURNING makes the named columns part of the statement\'s SELECT requirement, so the SELECT-less definer is no longer possible AND a duplicate becomes distinguishable from a new lead.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap04-no-returning'],
    apply: sub('  ON CONFLICT DO NOTHING;', '  ON CONFLICT DO NOTHING\n  RETURNING id;'),
  },
  {
    id: 'N-15',
    capability: 'CAP-04',
    file: CAP04,
    change: 'submit_lead returns boolean instead of void',
    breaks: 'a return value is a channel: it reveals whether the row already existed, which is the enumeration RETURNS void exists to refuse.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap04-returns-void'],
    apply: sub(
      `  p_source       text
) RETURNS void`,
      `  p_source       text
) RETURNS boolean`,
    ),
  },
  {
    id: 'N-16',
    capability: 'CAP-02',
    file: CAP02,
    change: 'verify_report is declared VOLATILE instead of STABLE',
    breaks: 'the planner stops refusing a write in the public read path, so a later edit that added one would be accepted at creation time.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap02-stable'],
    apply: sub(
      '  currency           text\n)\nLANGUAGE sql\nSECURITY DEFINER\nSTABLE',
      '  currency           text\n)\nLANGUAGE sql\nSECURITY DEFINER\nVOLATILE',
    ),
  },
  {
    id: 'N-17',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the read capability is granted SELECT on evidence_items',
    breaks: 'the public verification surface reaches private evidence — the exclusion that defines CAP-02.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap02-private-data'],
    apply: sub(
      'GRANT SELECT (id, name) ON public.organizations TO uellix_cap_verification;',
      'GRANT SELECT (id, name) ON public.organizations TO uellix_cap_verification;\nGRANT SELECT (id) ON public.evidence_items TO uellix_cap_verification;',
    ),
  },
  {
    id: 'N-18',
    capability: 'CAP-04',
    file: CAP04,
    change: "submit_lead's search_path becomes 'public, pg_temp'",
    breaks:
      'a caller who can create temporary objects can shadow a function or operator the body resolves, and the SECURITY DEFINER then runs their version with the definer\'s privileges.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['definer-search-path'],
    apply: sub(
      `) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
  SET search_path = ''`,
      `) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
  SET search_path = 'public, pg_temp'`,
    ),
  },
  {
    id: 'N-19',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the Stripe definer role is given BYPASSRLS',
    breaks: 'every policy in the package becomes decoration; the column ACL is all that is left.',
    severity: 'BLOCKER',
    survivedBecause: '',
    // Targets the DEFINER's attribute line, not the first textual occurrence:
    // the first `NOBYPASSRLS` in this file sits inside the header prose, and
    // editing prose is not a mutation of anything.
    expectedGate: ['role-attributes'],
    apply: sub(
      '  NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;',
      '  NOLOGIN NOINHERIT BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;',
    ),
  },
  {
    id: 'N-20',
    capability: 'CAP-01',
    file: CAP01,
    change: 'the invitation definer role is granted to uellix_owner',
    breaks:
      'SET ROLE authorisation is transitive, so uellix_migrator — a LOGIN role that can SET ROLE to uellix_owner — reaches the capability role in two statements, and the claim that no connection string resolves to a capability role becomes false.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['role-membership'],
    apply: sub(
      'GRANT USAGE ON SCHEMA auth TO uellix_cap_invitation;',
      'GRANT USAGE ON SCHEMA auth TO uellix_cap_invitation;\nGRANT uellix_cap_invitation TO uellix_owner WITH INHERIT FALSE, SET TRUE;',
    ),
  },
  {
    id: 'N-21',
    capability: 'CAP-02',
    file: CAP02,
    change: 'show_report_variant defaults to true',
    breaks:
      'which of funder / methodological / audit was produced is itself a disclosure; a default of true publishes it for every report whose owner set no flag.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap02-flag-default'],
    apply: sub(
      'show_report_variant    boolean     NOT NULL DEFAULT false',
      'show_report_variant    boolean     NOT NULL DEFAULT true',
    ),
  },
  {
    id: 'N-22',
    capability: 'CAP-03',
    file: CAP03,
    change: 'client_reference_id returns as a parameter of stripe_apply_subscription',
    breaks: 'RR-CAP-10 / DP-CAP-15: a buyer-supplied field becomes an authority the capability acts on.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap03-client-reference'],
    apply: sub(
      '  p_plan_label             text\n) RETURNS void',
      '  p_plan_label             text,\n  p_client_reference_id    text\n) RETURNS void',
    ),
  },
  {
    id: 'N-23',
    capability: 'CAP-02',
    file: RB02,
    change: 'the CAP-02 rollback stops dropping cap_verification_only_live',
    breaks:
      'a rolled-back capability leaves a RESTRICTIVE policy behind naming a role the rollback then drops, so the table is left with a policy referencing nothing.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['rollback-policy'],
    apply: sub(
      'DROP POLICY IF EXISTS cap_verification_only_live          ON public.report_public_disclosures;',
      '',
    ),
  },

  // =========================================================================
  // N-24 … N-45 — found by the adversarial review of the gates themselves
  // =========================================================================
  // Two independent read-only reviewers were asked to escape the gates above.
  // Between them they found eleven classes that passed untouched. Every one is
  // here, with the gate that now refuses it. The catalogue grew because the
  // gates did; a mutation catalogue that only ever contains mutations its
  // author already gated is an agreement between two files, not a measurement.

  {
    id: 'N-24',
    capability: 'CAP-01',
    file: CAP01,
    change: 'accept_invitation is left owned by uellix_owner instead of its capability role',
    breaks:
      'the definition of SECURITY DEFINER: the function executes as its OWNER. Owned by uellix_owner it runs with the privileges of the role that owns every table in public, and — there being no FORCE ROW LEVEL SECURITY anywhere in the campaign — an owner is RLS-exempt. Every column grant and every policy in the package becomes decoration.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['ownership-extra'],
    apply: sub(
      'ALTER FUNCTION uellix_capability.accept_invitation(text) OWNER TO uellix_cap_invitation;',
      'ALTER FUNCTION uellix_capability.accept_invitation(text) OWNER TO uellix_owner;',
    ),
  },
  {
    id: 'N-25',
    capability: 'CAP-04',
    file: CAP04,
    change: 'the ownership transfer of submit_lead is deleted outright',
    breaks:
      'the same property as N-24 by omission rather than by retargeting: the function stays owned by the superuser that created it, so the anonymous write path runs as superuser.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['ownership-missing'],
    apply: sub(
      'ALTER FUNCTION uellix_capability.submit_lead(text, text, text, text) OWNER TO uellix_cap_lead;',
      '',
    ),
  },
  {
    id: 'N-26',
    capability: 'CAP-04',
    file: CAP04,
    change: 'marketing_leads is re-owned to the lead definer',
    breaks:
      'the table owner is RLS-exempt without FORCE ROW LEVEL SECURITY, and an owner holds implicit full DML. The definer whose defining property is that it cannot read gains SELECT on every lead.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['ownership-extra'],
    apply: sub(
      'GRANT INSERT (email, company_name, sroi_result, source, lead_status, consent_version)',
      'ALTER TABLE public.marketing_leads OWNER TO uellix_cap_lead;\nGRANT INSERT (email, company_name, sroi_result, source, lead_status, consent_version)',
    ),
  },
  {
    id: 'N-27',
    capability: 'CAP-02',
    file: CAP02,
    change: 'report_public_disclosures never enables row level security',
    breaks:
      'every one of the five policies on that table at once. uellix_writer holds TABLE-WIDE SELECT on it, and the tenancy predicate of disclosures_select_member is the only thing between that grant and every organisation\'s publication decisions.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['rls-not-enabled'],
    apply: sub('ALTER TABLE public.report_public_disclosures ENABLE ROW LEVEL SECURITY;', ''),
  },
  {
    id: 'N-28',
    capability: 'CAP-03',
    file: CAP03,
    change: 'a SECOND ALTER ROLE grants BYPASSRLS to the Stripe definer',
    breaks:
      'the same property N-19 breaks, by a route N-19 does not take: appending a statement rather than editing the first one. Reading only the first ALTER ROLE per role is how a gate that looks correct measures nothing.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['role-attributes'],
    apply: sub(
      'RESET ROLE;',
      'ALTER ROLE uellix_cap_stripe BYPASSRLS;\nRESET ROLE;',
    ),
  },
  {
    id: 'N-29',
    capability: 'CAP-04',
    file: CAP04,
    change: 'the lead definer becomes INHERIT',
    breaks:
      'the isolation of a role that must hold only what it is granted. With INHERIT it also holds whatever any role it is a member of holds — which, combined with a membership grant, is a complete escalation.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['role-attributes'],
    apply: sub(
      '  NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;',
      '  NOLOGIN INHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;',
    ),
  },
  {
    id: 'N-30',
    capability: 'CAP-05',
    file: CAP05,
    change: 'the bootstrap definer is made a MEMBER of uellix_owner',
    breaks:
      'the inbound direction of role membership. N-20 hands the capability role to someone else; this hands someone else TO the capability role, which is the direction that grants it the table owner\'s privileges and with them the ownership-based RLS exemption.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['role-membership'],
    apply: sub(
      'GRANT USAGE ON SCHEMA auth TO uellix_cap_bootstrap;',
      'GRANT USAGE ON SCHEMA auth TO uellix_cap_bootstrap;\nGRANT uellix_owner TO uellix_cap_bootstrap;',
    ),
  },
  {
    id: 'N-31',
    capability: 'CAP-04',
    file: CAP04,
    change: 'EXECUTE on submit_lead is granted WITH GRANT OPTION',
    breaks:
      'the REVOKE ... FROM PUBLIC that every capability function depends on. With the grant option, uellix_app can re-grant EXECUTE to anon, and an anonymous write path exists that no REVOKE in this package can close.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['grant-extra'],
    apply: sub(
      'GRANT EXECUTE ON FUNCTION uellix_capability.submit_lead(text, text, text, text) TO uellix_app;',
      'GRANT EXECUTE ON FUNCTION uellix_capability.submit_lead(text, text, text, text) TO uellix_app WITH GRANT OPTION;',
    ),
  },
  {
    id: 'N-32',
    capability: 'CAP-01',
    file: CAP01,
    change: 'the uniform refusal interpolates SQLERRM into its message',
    breaks:
      'the single property the whole enumeration argument rests on. The reachable case is named in the package itself: a 23505 on user_single_active_membership, whose DETAIL reads «Key (user_id)=(…) already exists» — a real user id, returned to whoever called.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['definer-sqlerrm'],
    apply: sub(
      "    RAISE LOG 'accept_invitation refused with SQLSTATE %', SQLSTATE;\n    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';",
      "    RAISE EXCEPTION 'capability request denied: %', SQLERRM USING ERRCODE = 'U0001';",
    ),
  },
  {
    id: 'N-33',
    capability: 'CAP-04',
    file: CAP04,
    change: 'submit_lead builds its INSERT as a string and EXECUTEs the variable',
    breaks:
      'SQL injection into a SECURITY DEFINER reachable by fully anonymous traffic. EXECUTE of a variable is the form a gate that only looks for EXECUTE format( and EXECUTE literal || cannot see.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['definer-dynamic-sql'],
    apply: sub(
      `  INSERT INTO public.marketing_leads
    (email, company_name, sroi_result, source, lead_status, consent_version)
  VALUES
    (v_email, v_company, v_sroi, p_source, 'new', NULL)
  ON CONFLICT DO NOTHING;`,
      `  v_sql := 'INSERT INTO public.marketing_leads (email, source, lead_status) VALUES ('''
           || v_email || ''',''' || p_source || ''',''new'') ON CONFLICT DO NOTHING';
  EXECUTE v_sql;`,
    ),
  },
  {
    id: 'N-34',
    capability: 'CAP-04',
    file: CAP04,
    change: 'SELECT is granted to the lead definer from inside an EXECUTE string literal',
    breaks:
      'the defining property of CAP-04, by the one route a parser that masks string literals cannot see. These packages already build DDL that way, so the route is not exotic.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['grant-extra'],
    apply: sub(
      'RESET ROLE;',
      "DO $inject$ BEGIN\n  EXECUTE 'GRANT SELECT ON public.marketing_leads TO uellix_cap_lead';\nEND $inject$;\nRESET ROLE;",
    ),
  },
  {
    id: 'N-35',
    capability: 'CAP-04',
    file: CAP04,
    change: 'the REVOKE that makes the package a net reduction is block-commented out',
    breaks:
      'the net reduction itself: uellix_writer — and therefore uellix_app — keeps SELECT, INSERT, UPDATE and DELETE on the lead table. The statement is removed from the applied SQL while remaining visible to any gate that strips only -- comments.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap04-net-reduction'],
    apply: sub(
      'REVOKE SELECT, INSERT, UPDATE, DELETE ON public.marketing_leads FROM uellix_writer;',
      '/* REVOKE SELECT, INSERT, UPDATE, DELETE ON public.marketing_leads FROM uellix_writer; */',
    ),
  },
  {
    id: 'N-36',
    capability: 'CAP-04',
    file: 'stella_0009_rollback.sql',
    change: 'the rollback plants an open policy on marketing_leads',
    breaks:
      'everything the campaign claims about policies never reaching a public role — in a file that runs as superuser during an incident, when nobody is reading it line by line.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['rollback-policy-created'],
    apply: sub(
      'CREATE POLICY anon_insert_marketing_leads',
      'CREATE POLICY leads_open ON public.marketing_leads FOR ALL TO PUBLIC USING (true) WITH CHECK (true);\n\nCREATE POLICY anon_insert_marketing_leads',
    ),
  },
  {
    id: 'N-37',
    capability: 'CAP-05',
    file: 'stella_0010_rollback.sql',
    change: 'the rollback grants EXECUTE on the bootstrap function to PUBLIC',
    breaks:
      'the containment of a capability that is being REMOVED. A rollback that confers is a rollback nobody audits.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['rollback-grant'],
    apply: sub(
      'DROP FUNCTION IF EXISTS uellix_capability.bootstrap_organization(uuid, text, text, text, text, text);',
      'GRANT EXECUTE ON FUNCTION uellix_capability.bootstrap_organization(uuid, text, text, text, text, text) TO PUBLIC;\nDROP FUNCTION IF EXISTS uellix_capability.bootstrap_organization(uuid, text, text, text, text, text);',
    ),
  },
  {
    id: 'N-38',
    capability: 'CAP-02',
    file: CAP02,
    change: 'a SEVENTH publication flag is added, defaulting to true',
    breaks:
      'opt-in publication, one flag past where the gate was looking. This is the M-08 finding recurring: a gate that walks a hardcoded list of names cannot see the name that is not on it.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap02-flag-count'],
    apply: sub(
      '  show_report_variant    boolean     NOT NULL DEFAULT false,',
      '  show_report_variant    boolean     NOT NULL DEFAULT false,\n  show_funder_names      boolean     NOT NULL DEFAULT true,',
    ),
  },
  {
    id: 'N-39',
    capability: 'CAP-02',
    file: CAP02,
    change: 'verify_report returns the totals unconditionally',
    breaks:
      'the flags themselves. Pinning the column DEFAULTS says nothing about whether anything reads them; the figures are published for every disclosure while every default-related gate stays green.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap02-flag-honoured'],
    apply: sub(
      'CASE WHEN d.show_totals THEN run.total_investment END',
      'run.total_investment',
    ),
  },
  {
    id: 'N-40',
    capability: 'CAP-05',
    file: CAP05,
    change: "the founding membership is inserted as 'viewer' while the audit row still says organization_admin",
    breaks:
      'the founding role, and it demonstrates why a substring gate is not a gate: the literal survives in the audit payload two statements later, so anything looking for it in the file is satisfied.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap05-founding-role'],
    apply: sub(
      "    (v_org_id, v_subject, 'organization_admin', 'active', pg_catalog.now())",
      "    (v_org_id, v_subject, 'viewer', 'active', pg_catalog.now())",
    ),
  },
  {
    id: 'N-41',
    capability: 'CAP-05',
    file: CAP05,
    change: 'the reserved-slug denylist stops being consulted',
    breaks:
      "the refusal of slugs that collide with the application's own routes. An organisation addressable at /api or /admin is a routing ambiguity with a security shape.",
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap05-reserved-slugs'],
    apply: sub(
      "  IF v_slug !~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$' OR v_slug = ANY(c_reserved) THEN",
      "  IF v_slug !~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$' THEN",
    ),
  },
  {
    id: 'N-42',
    capability: 'CAP-04',
    file: CAP04,
    change: 'the REVOKE on submit_lead takes UPDATE instead of ALL',
    breaks:
      'the closing of the implicit default. A function created with a NULL proacl is EXECUTE TO PUBLIC; revoking UPDATE removes nothing, while satisfying any check that reads only the object and the grantee.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['function-revoke'],
    apply: sub(
      'REVOKE ALL ON FUNCTION uellix_capability.submit_lead(text, text, text, text) FROM PUBLIC;',
      'REVOKE UPDATE ON FUNCTION uellix_capability.submit_lead(text, text, text, text) FROM PUBLIC;',
    ),
  },
  {
    id: 'N-43',
    capability: 'CAP-01',
    file: CAP01,
    change: 'the package quietly drops a pre-existing policy it did not create',
    breaks:
      'a tenancy boundary owned by another migration. Only CAP-04 declares retirements; any other package removing a policy is doing something nobody reviewed.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-retired'],
    apply: sub(
      'DROP POLICY IF EXISTS cap_invitation_select_invitations ON public.invitations;',
      'DROP POLICY IF EXISTS invitations_select_member ON public.invitations;\nDROP POLICY IF EXISTS cap_invitation_select_invitations ON public.invitations;',
    ),
  },
  {
    id: 'N-44',
    capability: 'CAP-04',
    file: CAP04,
    change: 'the WHEN query_canceled branch is removed',
    breaks:
      "the uniform refusal under timeout. PL/pgSQL's WHEN OTHERS does not match 57014, so a statement_timeout firing mid-call reaches the caller as query_canceled with PostgreSQL's own message.",
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['definer-query-canceled'],
    apply: sub(
      "  WHEN query_canceled THEN\n    RAISE LOG 'capability call cancelled (57014)';\n    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';\n  WHEN OTHERS THEN\n    RAISE LOG 'submit_lead refused with SQLSTATE %', SQLSTATE;",
      "  WHEN OTHERS THEN\n    RAISE LOG 'submit_lead refused with SQLSTATE %', SQLSTATE;",
    ),
  },
  {
    id: 'N-45',
    capability: 'CAP-01',
    file: CAP01,
    change: 'the token-hash index loses its UNIQUE',
    breaks:
      "«provably single-row by construction» for the token lookup. SELECT … INTO on a duplicate token_hash takes an ARBITRARY row, and the line below still drops the non-unique index this one replaced.",
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['index-uniqueness'],
    apply: sub(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_token_hash',
      'CREATE INDEX IF NOT EXISTS uq_invitations_token_hash',
    ),
  },

  // =========================================================================
  // E-01 … E-08 — the eight PostgreSQL-equivalent EVASIONS
  // =========================================================================
  //
  // These are not new properties. Every one of them breaks a property the
  // catalogue above already covers — and every one was spelled the way
  // PostgreSQL ALSO accepts, which the mask-and-regex parser could not read.
  // Each therefore has a double duty: it must be refused by the gate that owns
  // the property, and its refusal must prove the parser sees the spelling.

  {
    id: 'E-01',
    capability: 'CAP-04',
    file: CAP04,
    change: 'a GRANT SELECT is written directly inside a DO block body',
    breaks:
      'the INSERT-only capability, through a body the old parser masked wholesale. PL/pgSQL executes utility commands written out in a block exactly as it executes them at file level; the previous parser made the body opaque so the statement was not merely unparsed, it was absent.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap04-no-read', 'grant-extra'],
    apply: before(
      'RESET ROLE;',
      "DO $$\nBEGIN\n  GRANT SELECT ON public.marketing_leads TO uellix_cap_lead;\nEND\n$$;",
    ),
  },
  {
    id: 'E-02',
    capability: 'CAP-01',
    file: CAP01,
    change: 'a widening UPDATE grant names its grantee as a double-quoted identifier',
    breaks:
      'the column-scoped UPDATE bound on invitations. `"uellix_app"` and `uellix_app` are the SAME role in PostgreSQL and were two different things to a parser whose every grantee pattern was [A-Za-z_][\\w$]*.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['grant-extra'],
    apply: before('RESET ROLE;', 'GRANT UPDATE ON public.invitations TO "uellix_app";'),
  },
  {
    id: 'E-03',
    capability: 'CAP-04',
    file: CAP04,
    change: 'one GRANT confers TWO role memberships on the capability role',
    breaks:
      'the isolation of the definer. Membership in uellix_owner is the table owner\'s privileges and, with no FORCE ROW LEVEL SECURITY anywhere in the campaign, the ownership RLS exemption. The old parser required the member list to be a single bare identifier and dropped the whole statement on a bare `continue` when it was not — so a two-member GRANT produced ZERO memberships, not two.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['role-membership'],
    apply: before('RESET ROLE;', 'GRANT uellix_owner, uellix_writer TO uellix_cap_lead;'),
  },
  {
    id: 'E-04',
    capability: 'CAP-02',
    file: CAP02,
    change: 'row level security is switched off through a schema-qualified quoted table name',
    breaks:
      'every policy on report_public_disclosures at once. The toggle gate matched `ALTER TABLE ([\\w.]+)`, which cannot read `"public"."report_public_disclosures"`, so the statement that disables the entire access-control surface matched nothing.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['rls-disabled'],
    apply: before(
      'RESET ROLE;',
      'ALTER TABLE "public"."report_public_disclosures" DISABLE ROW LEVEL SECURITY;',
    ),
  },
  {
    id: 'E-05',
    capability: 'CAP-03',
    file: CAP03,
    change: 'a second ALTER ROLE, with the role quoted, restores SUPERUSER and BYPASSRLS',
    breaks:
      'the seven negative attributes the capability role is defined by. The gate read every ALTER ROLE for the role and let the last one win — but it anchored on the BARE name, so quoting the role made the reverting statement invisible to the check written to find exactly it.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['role-attributes'],
    apply: before('RESET ROLE;', 'ALTER ROLE "uellix_cap_stripe" BYPASSRLS SUPERUSER;'),
  },
  {
    id: 'E-06',
    capability: 'CAP-05',
    file: CAP05,
    change: 'REASSIGN OWNED hands the owner\'s entire catalogue to the capability role',
    breaks:
      'ownership as a bounded property. One statement re-owns every object uellix_owner holds — not one function but every table in public — and ownership is RLS exemption. REASSIGN OWNED appeared in no pattern in the suite, in either direction.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['ownership-reassigned'],
    apply: before('RESET ROLE;', 'REASSIGN OWNED BY uellix_owner TO uellix_cap_bootstrap;'),
  },
  {
    id: 'E-07',
    capability: 'CAP-02',
    file: CAP02,
    change: 'an undeclared policy is created with its name, schema, table and role all quoted',
    breaks:
      'the closed policy inventory. Every identifier in the statement is spelled the second way PostgreSQL accepts, and the policy parser recognised none of them — so a policy granting the verification role unrestricted SELECT on organizations was not an undeclared policy, it was no policy at all.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-inventory'],
    apply: before(
      'RESET ROLE;',
      'CREATE POLICY "cap_escape_policy"\nON "public"."organizations"\nFOR SELECT\nTO "uellix_cap_verification"\nUSING (true);',
    ),
  },
  {
    id: 'E-08',
    capability: 'CAP-04',
    file: CAP04,
    change: 'a NESTED block comment swallows the REVOKE that makes CAP-04 a net reduction',
    breaks:
      'the one statement that removes privilege from the runtime. PostgreSQL NESTS /* */; the masker did not, so it believed the comment closed at the inner `*/` and that the REVOKE survived. The server executes nothing and the gate that requires the REVOKE stays green — the exact inversion a fail-closed parser exists to prevent.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap04-net-reduction'],
    apply: sub(
      'REVOKE SELECT, INSERT, UPDATE, DELETE ON public.marketing_leads FROM uellix_writer;',
      '/* outer /* inner */ REVOKE SELECT, INSERT, UPDATE, DELETE ON public.marketing_leads FROM uellix_writer; */',
    ),
  },

  // =========================================================================
  // F-01 … F-14 — the additional equivalences
  // =========================================================================
  //
  // Same construction, different constructs: default privileges, whole-owner
  // statements, the second half of an RLS pair, dynamic SQL in each of its
  // three unresolvable forms, and a rollback used as the delivery vehicle.

  {
    id: 'F-01',
    capability: 'CAP-01',
    file: CAP01,
    change: 'ALTER DEFAULT PRIVILEGES grants EXECUTE on future functions to PUBLIC',
    breaks:
      'the closing of the implicit EXECUTE default, for everything created AFTERWARDS. It confers nothing today, so no privilege gate reads it, and it re-opens for the next capability function exactly what `REVOKE ALL … FROM PUBLIC` closes for this one.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['default-privileges'],
    apply: before(
      'RESET ROLE;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA uellix_capability GRANT EXECUTE ON FUNCTIONS TO PUBLIC;',
    ),
  },
  {
    id: 'F-02',
    capability: 'CAP-03',
    file: CAP03,
    change: 'DROP OWNED BY removes the capability role\'s objects and privileges wholesale',
    breaks:
      'the contract by DELETION rather than by grant. Every gate in the suite asks whether the right things are conferred; none asks whether something removed them, and a package that empties a role in one statement leaves an inventory nothing compares against.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['ownership-dropped'],
    apply: before('RESET ROLE;', 'DROP OWNED BY uellix_cap_stripe;'),
  },
  {
    id: 'F-03',
    capability: 'CAP-05',
    file: CAP05,
    change: 'FORCE ROW LEVEL SECURITY is set and then immediately reverted with NO FORCE',
    breaks:
      'the ordering property of an RLS pair. Read as a set, ENABLE is present and the table looks protected; read in sequence, the last statement restores the owner\'s exemption on the table that records every bootstrap attempt.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['rls-disabled'],
    apply: before(
      'RESET ROLE;',
      'ALTER TABLE public.capability_bootstrap_attempts FORCE ROW LEVEL SECURITY;\n' +
        'ALTER TABLE public.capability_bootstrap_attempts NO FORCE ROW LEVEL SECURITY;',
    ),
  },
  {
    id: 'F-04',
    capability: 'CAP-05',
    file: CAP05,
    change: 'cap_bootstrap_select_orgs is re-attached to a quoted "public"."users"',
    breaks:
      'the table half of the policy tuple. The policy keeps its name, its mode, its command and its role, so every cardinality and naming check is unchanged; only the object it protects moved, and it moved behind a spelling the table pattern could not read.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-table'],
    apply: sub(
      'CREATE POLICY cap_bootstrap_select_orgs\nON public.organizations FOR SELECT TO uellix_cap_bootstrap',
      'CREATE POLICY cap_bootstrap_select_orgs\nON "public"."users" FOR SELECT TO uellix_cap_bootstrap',
    ),
  },
  {
    id: 'F-05',
    capability: 'CAP-01',
    file: CAP01,
    change: 'a policy names a quoted role whose CASE differs from the capability role',
    breaks:
      'role identity itself. `"Uellix_Cap_Invitation"` is a DIFFERENT role from uellix_cap_invitation — PostgreSQL folds only unquoted names — so the policy protects nothing the definer ever assumes, while a case-insensitive comparison reports it as correct.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-to'],
    apply: sub(
      'CREATE POLICY cap_invitation_select_members\nON public.organization_members FOR SELECT TO uellix_cap_invitation',
      'CREATE POLICY cap_invitation_select_members\nON public.organization_members FOR SELECT TO "Uellix_Cap_Invitation"',
    ),
  },
  {
    id: 'F-06',
    capability: 'CAP-04',
    file: CAP04,
    change: 'the lead INSERT grant gains WITH GRANT OPTION',
    breaks:
      'the terminality of the privilege. The definer may now re-grant INSERT on marketing_leads to anyone it can name, which makes the package\'s privilege inventory a lower bound rather than a description.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['grant-extra'],
    apply: sub(
      '  ON public.marketing_leads TO uellix_cap_lead;',
      '  ON public.marketing_leads TO uellix_cap_lead WITH GRANT OPTION;',
    ),
  },
  {
    id: 'F-07',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the verification role is made a member of uellix_writer WITH ADMIN OPTION',
    breaks:
      'the read-only shape of the verification identity, and then makes the breach self-propagating: ADMIN OPTION lets the capability role grant that same membership onward without any further statement in any package.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['role-membership'],
    apply: before('RESET ROLE;', 'GRANT uellix_writer TO uellix_cap_verification WITH ADMIN OPTION;'),
  },
  {
    id: 'F-08',
    capability: 'CAP-04',
    file: CAP04,
    change: 'a DO block builds its GRANT with EXECUTE format(...)',
    breaks:
      'the resolvability of executed DDL. The old parser appended `EXECUTE \'literal\'` to the source and understood nothing else, so wrapping the identical statement in format() removed it from view. It cannot be resolved from the file, and the only safe reading of an unresolvable DDL string is that it might be the dangerous one.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['unparsed-security-statement'],
    apply: before(
      'RESET ROLE;',
      "DO $$\nBEGIN\n  EXECUTE format('GRANT SELECT ON public.marketing_leads TO %I', 'uellix_cap_lead');\nEND\n$$;",
    ),
  },
  {
    id: 'F-09',
    capability: 'CAP-05',
    file: CAP05,
    change: 'a DO block concatenates its DDL into a variable and executes the variable',
    breaks:
      'the same resolvability property by the third route. Neither half of the concatenation is a security statement and the EXECUTE names only a variable, so nothing in the file is a GRANT — which is exactly why the statement has to be refused rather than parsed.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['unparsed-security-statement'],
    apply: before(
      'RESET ROLE;',
      "DO $$\nDECLARE\n  v_sql text;\nBEGIN\n  v_sql := 'GRANT SELECT' || ' ON public.users TO uellix_cap_bootstrap';\n  EXECUTE v_sql;\nEND\n$$;",
    ),
  },
  {
    id: 'F-10',
    capability: 'CAP-01',
    file: CAP01,
    change: 'the REVOKE that closes accept_invitation to PUBLIC is commented out',
    breaks:
      'the default EXECUTE grant on a SECURITY DEFINER owned by the capability role. A function created with a NULL proacl is executable by PUBLIC; the REVOKE is the only statement that closes it, and two dashes remove it while leaving the line legible to anyone skimming the diff.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['function-revoke'],
    apply: sub(
      'REVOKE ALL ON FUNCTION uellix_capability.accept_invitation(text) FROM PUBLIC;',
      '-- REVOKE ALL ON FUNCTION uellix_capability.accept_invitation(text) FROM PUBLIC;',
    ),
  },
  {
    id: 'F-11',
    capability: 'CAP-05',
    file: CAP05,
    change: 'a later ALTER ROLE restores LOGIN and CREATEROLE on the bootstrap role',
    breaks:
      'two of the seven negative attributes, by a statement that comes AFTER the one declaring them. The declaring statement is still there and still correct; PostgreSQL applies both in order, and only the second one is in force.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['role-attributes'],
    apply: before('RESET ROLE;', 'ALTER ROLE uellix_cap_bootstrap LOGIN CREATEROLE;'),
  },
  {
    id: 'F-12',
    capability: 'CAP-01',
    file: RB01,
    change: 'the CAP-01 rollback confers a table privilege on the runtime while undoing the package',
    breaks:
      'the rule that a rollback restores and never adds. It runs as superuser during an incident, when nobody is reading, and CAP-01\'s rollback is declared to confer nothing at all.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['rollback-grant'],
    apply: before('RESET ROLE;', 'GRANT SELECT ON public.invitations TO uellix_app;'),
  },
  {
    id: 'F-13',
    capability: 'CAP-04',
    file: CAP04,
    change: 'ALTER POLICY retargets a policy the contract pins by its CREATE',
    breaks:
      'the assumption that a policy is what its CREATE says. ALTER POLICY rewrites TO, USING and WITH CHECK in place; the contract compares CREATE statements, so the tuple it validates and the tuple in the catalogue are two different things.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['unparsed-security-statement'],
    apply: before('RESET ROLE;', 'ALTER POLICY cap_lead_insert ON public.marketing_leads TO uellix_app;'),
  },
  {
    id: 'F-14',
    capability: 'CAP-04',
    file: CAP04,
    change: 'a DO block re-owns marketing_leads to the capability role',
    breaks:
      'ownership as the RLS exemption it is, from inside an executable body. The table\'s owner is exempt from its own policies while no FORCE ROW LEVEL SECURITY exists anywhere in the campaign, so this one line makes every CAP-04 policy inert for the definer and hands it implicit SELECT.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['ownership-extra'],
    apply: before(
      'RESET ROLE;',
      'DO $$\nBEGIN\n  ALTER TABLE public.marketing_leads OWNER TO uellix_cap_lead;\nEND\n$$;',
    ),
  },

  // =========================================================================
  // A-01 … A-06 — the adversarial round against the NEW parser
  // =========================================================================
  //
  // Reviewer A attacked the rewritten reader rather than the packages and
  // found three BLOCKERs, all of them the same shape as the eight it was
  // written to close: a spelling PostgreSQL accepts and the parser did not
  // read, producing SILENCE rather than a finding. They are catalogued here
  // because a defect the reviewer found and nothing pins is a defect with a
  // half-life.

  {
    id: 'A-01',
    capability: 'CAP-04',
    file: CAP04,
    change: "the GRANT is hidden behind an E-string hex escape (E'\\x47RANT …')",
    breaks:
      "the INSERT-only capability, through the parser's own decoder. \\x47 is the letter G: PostgreSQL executes a GRANT while a decoder that knows only \\n, \\t and \\r yields the text `x47RANT`, whose first word opens nothing — so the scanner recorded no statement AND raised no finding.",
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap04-no-read', 'grant-extra'],
    apply: before(
      'RESET ROLE;',
      "DO $$\nBEGIN\n  EXECUTE E'\\x47RANT SELECT ON public.marketing_leads TO uellix_cap_lead';\nEND\n$$;",
    ),
  },
  {
    id: 'A-02',
    capability: 'CAP-04',
    file: CAP04,
    change: 'a SECURITY DEFINER helper is defined with a single-quoted body instead of $$',
    breaks:
      "the descent into function bodies, and the SECURITY DEFINER inventory with it. `AS '…'` is as valid as `AS $$…$$`; the scanner descended only into dollar-quoted bodies and the definer gate finds functions with a regex anchored on `AS $$`, so the function was outside both.",
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['unparsed-security-statement'],
    apply: before(
      'RESET ROLE;',
      "CREATE OR REPLACE FUNCTION uellix_capability.helper() RETURNS void\n" +
        "LANGUAGE plpgsql SECURITY DEFINER AS\n" +
        "'BEGIN EXECUTE ''GRANT SELECT ON public.marketing_leads TO uellix_cap_lead''; END';",
    ),
  },
  {
    id: 'A-03',
    capability: 'CAP-04',
    file: CAP04,
    change: 'the RUNTIME role, not a capability role, is given BYPASSRLS',
    breaks:
      'cap_lead_deny_runtime, the RESTRICTIVE USING (false) the package calls its durable half. The role-attribute gate iterated the five capability roles and filtered every other role out, so a statement naming uellix_writer was parsed and then consumed by nothing.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['role-dangerous-attribute'],
    apply: before('RESET ROLE;', 'ALTER ROLE uellix_writer BYPASSRLS;'),
  },
  {
    id: 'A-04',
    capability: 'CAP-05',
    file: CAP05,
    change: 'the package creates a login superuser under a name no contract mentions',
    breaks:
      'the closed role inventory. Nothing in the suite asked which roles a package may touch, only what the five declared ones look like, so an entirely new role was outside every check the campaign has.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['role-foreign', 'role-dangerous-attribute'],
    apply: before('RESET ROLE;', "CREATE ROLE uellix_backdoor LOGIN SUPERUSER;"),
  },
  {
    id: 'A-05',
    capability: 'CAP-01',
    file: RB01,
    change: 'the rollback grants BYPASSRLS to the capability role before dropping it',
    breaks:
      'the assumption that role attributes only matter in a forward file. A rollback runs as superuser during an incident; between this statement and the DROP ROLE the definer is exempt from every policy the campaign wrote for it.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['role-dangerous-attribute'],
    apply: before('RESET ROLE;', 'ALTER ROLE uellix_cap_invitation BYPASSRLS;'),
  },
  {
    id: 'A-06',
    capability: 'CAP-02',
    file: CAP02,
    change: 'a policy names its role through a U& Unicode-escaped identifier',
    breaks:
      'identifier identity itself. `U&"…"` lexed naively becomes the word U, the operator & and an identifier — so the statement the parser judges names a different object from the one PostgreSQL applies. Approximate decoding would be worse than none: a near miss re-lexes as a word that opens nothing.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['unparsed-security-statement'],
    apply: before(
      'RESET ROLE;',
      'CREATE POLICY cap_verification_escape\nON public.organizations FOR SELECT\nTO U&"uellix_cap_verification"\nUSING (true);',
    ),
  },
  {
    id: 'A-07',
    capability: 'CAP-05',
    file: CAP05,
    change: 'the idempotency key is locked with FOR UPDATE before it is claimed',
    breaks:
      'the claim-first ordering, by restoring the exact model CAP-05 documented for three revisions and that does not work: SELECT … FOR UPDATE locks nothing when the row does not exist, so two concurrent callers both proceed. Reviewer B showed the gate that forbids it could not be reached by any mutation in the catalogue — it was on the unexercised list looking like a gate that merely lacked one.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap05-claim-first'],
    apply: sub(
      '  INSERT INTO public.capability_bootstrap_attempts (user_id, idempotency_key)',
      '  PERFORM 1 FROM public.capability_bootstrap_attempts a\n' +
        '   WHERE a.user_id = v_subject AND a.idempotency_key = p_idempotency_key\n' +
        '     FOR UPDATE;\n\n' +
        '  INSERT INTO public.capability_bootstrap_attempts (user_id, idempotency_key)',
    ),
  },

  // =========================================================================
  // R-* — the design-risk closure (RR-CAP-10, 13, 14, 02-F) and the gates it
  // added. Every one of these is a property that DID NOT EXIST before this
  // unit, so "no mutation reaches it" would have meant the repair was
  // uncontracted — the same shape of hole the repairs were closing.
  // =========================================================================

  // --- RR-CAP-02-F: the trigger is code on a protected table ---------------
  {
    id: 'R-01',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the disclosure audit trigger is retargeted to sroi_reports',
    breaks:
      'the trail follows the wrong rows. Publishing a report would produce no event, and editing an unrelated report would produce one.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['trigger-shape'],
    apply: sub(
      'AFTER INSERT OR UPDATE ON public.report_public_disclosures\nFOR EACH ROW EXECUTE FUNCTION public.uellix_audit_report_disclosure();',
      'AFTER INSERT OR UPDATE ON public.sroi_reports\nFOR EACH ROW EXECUTE FUNCTION public.uellix_audit_report_disclosure();',
    ),
  },
  {
    id: 'R-02',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the audit trigger fires BEFORE instead of AFTER',
    breaks:
      'the audit row is written for a change that has not happened yet. A later constraint or policy failure rolls the disclosure back, and the trail records a publication nobody can see.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['trigger-shape'],
    apply: sub(
      'CREATE TRIGGER trg_report_disclosure_audit\nAFTER INSERT OR UPDATE',
      'CREATE TRIGGER trg_report_disclosure_audit\nBEFORE INSERT OR UPDATE',
    ),
  },
  {
    id: 'R-03',
    capability: 'CAP-02',
    file: CAP02,
    change: 'FOR EACH ROW is dropped from the audit trigger',
    breaks:
      'a statement-level trigger has no NEW, so a multi-row UPDATE produces ONE event with no row to describe. Ten certificates revoked in one statement leave one line.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['trigger-shape'],
    apply: sub(
      'FOR EACH ROW EXECUTE FUNCTION public.uellix_audit_report_disclosure();',
      'FOR EACH STATEMENT EXECUTE FUNCTION public.uellix_audit_report_disclosure();',
    ),
  },
  {
    id: 'R-04',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the audit trigger executes a different function',
    breaks:
      'the trigger still exists, still fires, and records whatever the substituted function records — which may be nothing at all.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['trigger-shape'],
    apply: sub(
      'FOR EACH ROW EXECUTE FUNCTION public.uellix_audit_report_disclosure();',
      'FOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();',
    ),
  },
  {
    id: 'R-05',
    capability: 'CAP-02',
    file: CAP02,
    change: 'a WHEN clause is added to the audit trigger',
    breaks:
      'the blind spot an audit trail must not have. `WHEN (NEW.show_totals)` looks like an optimisation and silently stops recording every publication that discloses nothing but authenticity.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['trigger-when'],
    apply: sub(
      'AFTER INSERT OR UPDATE ON public.report_public_disclosures\nFOR EACH ROW EXECUTE',
      'AFTER INSERT OR UPDATE ON public.report_public_disclosures\nFOR EACH ROW WHEN (NEW.show_totals) EXECUTE',
    ),
  },
  {
    id: 'R-06',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the audit trigger is never created',
    breaks:
      'RR-CAP-02-F itself: publishing, revoking and republishing leave no record of who decided what.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['trigger-missing'],
    apply: sub(
      'CREATE TRIGGER trg_report_disclosure_audit\nAFTER INSERT OR UPDATE ON public.report_public_disclosures\nFOR EACH ROW EXECUTE FUNCTION public.uellix_audit_report_disclosure();',
      '-- trigger removed',
    ),
  },
  {
    id: 'R-07',
    capability: 'CAP-02',
    file: CAP02,
    change: 'an undeclared trigger is planted on the disclosure table',
    breaks:
      'the inventory. Arbitrary code attached to a protected table, added by a package, that no contract describes — which is how a trigger that rewrites NEW gets in.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['trigger-extra'],
    apply: before(
      'DROP TRIGGER IF EXISTS trg_report_disclosures_append_only',
      'CREATE TRIGGER trg_backdoor BEFORE INSERT ON public.report_public_disclosures\nFOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();',
    ),
  },
  {
    id: 'R-08',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the DROP TRIGGER IF EXISTS before the audit trigger is removed',
    breaks:
      'convergence. A second apply raises 42710 — or, on a server that tolerates it, stacks a second trigger and every publication writes two audit rows.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['trigger-not-convergent'],
    apply: sub(
      'DROP TRIGGER IF EXISTS trg_report_disclosure_audit ON public.report_public_disclosures;\nCREATE TRIGGER trg_report_disclosure_audit',
      'CREATE TRIGGER trg_report_disclosure_audit',
    ),
  },
  {
    id: 'R-09',
    capability: 'CAP-02',
    file: RB02,
    change: 'the rollback drops the audit trigger from the retained rows',
    breaks:
      'the traceability of decisions the rollback deliberately KEEPS. uellix_owner is the table owner — exempt from RLS, holding implicit UPDATE, reachable by SET ROLE from a LOGIN role — so with the trigger gone it can flip revoked_at, show_* or public_summary on any retained decision with zero trace, and a later re-apply turns those altered rows back into live certificates.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['rollback-trigger-retained'],
    apply: before(
      '-- (nothing dropped here: see above)',
      'DROP TRIGGER IF EXISTS trg_report_disclosure_audit ON public.report_public_disclosures;',
    ),
  },
  {
    id: 'R-10',
    capability: 'CAP-02',
    file: RB02,
    change: 'the rollback also drops the append-only protection of the retained rows',
    breaks:
      'the reason the table survives. The rollback keeps every human decision to publish and then makes them erasable by the owner.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['rollback-trigger-retained'],
    apply: before(
      'REVOKE INSERT, UPDATE ON public.report_public_disclosures FROM uellix_writer;',
      'DROP TRIGGER IF EXISTS trg_report_disclosures_append_only ON public.report_public_disclosures;',
    ),
  },
  {
    id: 'R-11',
    capability: 'CAP-02',
    file: RB02,
    change: 'the rollback CREATES a trigger',
    breaks:
      'the rule that a rollback plants nothing. These files run as superuser during an incident, when nobody is reading them.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['rollback-trigger-created'],
    apply: before(
      'REVOKE INSERT, UPDATE ON public.report_public_disclosures FROM uellix_writer;',
      'CREATE TRIGGER trg_rollback_backdoor AFTER INSERT ON public.report_public_disclosures\nFOR EACH ROW EXECUTE FUNCTION public.uellix_forbid_mutation();',
    ),
  },

  // --- RR-CAP-02-F: what the trail records ---------------------------------
  {
    id: 'R-12',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the trigger function stops writing audit_logs',
    breaks:
      'everything. The trigger fires, the function runs, and nothing is recorded — which is indistinguishable from the pre-repair state except that a trigger now exists to point at.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap02-audit-writes'],
    apply: sub('  INSERT INTO public.audit_logs\n    (organization_id, actor_user_id, entity_type, entity_id, action,\n     before_json, after_json, reason)\n  VALUES\n    (v_org_id, auth.uid()', '  PERFORM (v_org_id, auth.uid()'),
  },
  {
    id: 'R-13',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the trigger function is made SECURITY DEFINER',
    breaks:
      'the pinning of the actor. As a definer it writes audit rows with the definer owner’s privileges, so audit_logs’ own policy no longer proves actor_user_id = auth.uid(): the trail becomes self-asserted.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap02-audit-caller-rights'],
    apply: sub(
      'RETURNS trigger\nLANGUAGE plpgsql\n  SET search_path = \'\'',
      'RETURNS trigger\nLANGUAGE plpgsql\nSECURITY DEFINER\n  SET search_path = \'\'',
    ),
  },
  {
    id: 'R-14',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the summary is stored as text instead of as a digest',
    breaks:
      'the rule that audit_logs holds no payload. It also turns the trail into a second copy of free text a person wrote, with a different retention story from the row it came from.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap02-audit-digest'],
    apply: sub(
      "    'summarySha256',          CASE WHEN NEW.public_summary IS NULL THEN NULL\n                                   ELSE pg_catalog.encode(\n                                     pg_catalog.sha256(\n                                       pg_catalog.convert_to(NEW.public_summary, 'UTF8')), 'hex') END,",
      "    'summary', NEW.public_summary,",
    ),
  },
  {
    id: 'R-15',
    capability: 'CAP-02',
    file: CAP02,
    change: 'revocation is folded into the generic update action',
    breaks:
      '"how many certificates were withdrawn, and when" — answerable only by diffing every pair of rows once the transition is no longer named.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap02-audit-transitions'],
    apply: sub("      v_action := 'report.disclosure.revoked';", "      v_action := 'report.disclosure.touched';"),
  },

  // --- RR-CAP-13: the verification identity cannot enumerate ---------------
  {
    id: 'R-16',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the RESTRICTIVE bound on organizations becomes USING (true)',
    breaks:
      'RR-CAP-13. The verification identity can read the name of every organisation on the platform, published or not — the customer list, one SELECT from a body that no longer has to cooperate.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-using'],
    apply: sub(
      'ON public.organizations AS RESTRICTIVE FOR SELECT TO uellix_cap_verification\nUSING (\n  EXISTS (\n    SELECT 1 FROM public.sroi_reports r\n      JOIN public.report_public_disclosures d ON d.report_id = r.id\n     WHERE r.organization_id = public.organizations.id',
      'ON public.organizations AS RESTRICTIVE FOR SELECT TO uellix_cap_verification\nUSING (\n  true OR EXISTS (\n    SELECT 1 FROM public.sroi_reports r\n      JOIN public.report_public_disclosures d ON d.report_id = r.id\n     WHERE r.organization_id = public.organizations.id',
    ),
  },
  {
    id: 'R-17',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the run bound stops requiring a live disclosure',
    breaks:
      'revocation. Withdrawing a certificate would leave its figures readable by the public verification identity, which is the state the whole capability exists to make impossible.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-using'],
    apply: sub(
      "     WHERE r.calculation_run_id = public.sroi_calculation_runs.id\n       AND r.status = 'locked'\n       AND d.revoked_at IS NULL",
      "     WHERE r.calculation_run_id = public.sroi_calculation_runs.id\n       AND r.status = 'locked'",
    ),
  },
  {
    id: 'R-18',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the RESTRICTIVE run bound is deleted outright',
    breaks:
      'the same property, by omission rather than by predicate. sroi_calculation_runs goes back to USING (true) with no companion.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-inventory'],
    apply: sub('DROP POLICY IF EXISTS cap_verification_only_published_run ON public.sroi_calculation_runs;\nCREATE POLICY cap_verification_only_published_run', 'DROP POLICY IF EXISTS cap_verification_only_published_run ON public.sroi_calculation_runs;\nCREATE POLICY cap_verification_unused_name'),
  },

  // --- RR-CAP-14: the Stripe identity reaches one organisation -------------
  {
    id: 'R-19',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the RESTRICTIVE UPDATE bound is retargeted to uellix_app',
    breaks:
      'the tenancy bound, without removing anything a reviewer counts. The definer keeps its permissive USING (true) and the restriction now applies to a role that never touches this table.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-to'],
    apply: sub(
      'ON public.organizations AS RESTRICTIVE FOR UPDATE TO uellix_cap_stripe',
      'ON public.organizations AS RESTRICTIVE FOR UPDATE TO uellix_app',
    ),
  },
  {
    id: 'R-20',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the claimed-event bound is downgraded to PERMISSIVE',
    breaks:
      'the only kind of policy that cannot be OR-ed away. As a permissive policy it is combined with the {public} baseline ones and stops bounding anything.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-mode'],
    apply: sub(
      'ON public.organizations AS RESTRICTIVE FOR UPDATE TO uellix_cap_stripe\nUSING (\n  EXISTS (\n    SELECT 1 FROM public.stripe_webhook_events e',
      'ON public.organizations FOR UPDATE TO uellix_cap_stripe\nUSING (\n  EXISTS (\n    SELECT 1 FROM public.stripe_webhook_events e',
    ),
  },
  {
    id: 'R-21',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the bound stops requiring the event to be in the processing state',
    breaks:
      '"the event was claimed". Any completed event from months ago would keep the organisation reachable, so the window the bound defines never closes.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-with-check'],
    apply: sub(
      "WITH CHECK (\n  EXISTS (\n    SELECT 1 FROM public.stripe_webhook_events e\n     WHERE e.event_id = NULLIF(pg_catalog.current_setting('app.stripe_event_id', true), '')\n       AND e.status = 'processing'",
      "WITH CHECK (\n  EXISTS (\n    SELECT 1 FROM public.stripe_webhook_events e\n     WHERE e.event_id = NULLIF(pg_catalog.current_setting('app.stripe_event_id', true), '')\n       AND true",
    ),
  },
  {
    id: 'R-22',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the claim stops recording the Stripe address',
    breaks:
      'the anchor the RESTRICTIVE policy reads. With both columns NULL the policy matches nothing and the capability fails closed — but a subsequent edit that relaxes the policy would then have nothing to fall back on.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap03-claim-identity'],
    apply: sub(
      '    (event_id, event_type, status, attempts, stripe_customer_id, stripe_subscription_id)',
      '    (event_id, event_type, status, attempts)',
    ),
  },
  {
    id: 'R-23',
    capability: 'CAP-03',
    file: CAP03,
    change: 'an existing event id may be re-claimed under a different address',
    breaks:
      'the immutability of the claim. The event row is the tenancy anchor; if its address can be rewritten by re-claiming, the anchor is a parameter.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap03-claim-identity'],
    apply: sub(
      '     AND e.stripe_customer_id     IS NOT DISTINCT FROM p_stripe_customer_id\n     AND e.stripe_subscription_id IS NOT DISTINCT FROM p_stripe_subscription_id',
      '     AND true',
    ),
  },
  {
    id: 'R-24',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the capability regains UPDATE on the claimed Stripe address',
    breaks:
      'the same anchor from the ACL side. A column the capability can rewrite cannot bound the capability.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['grant-extra'],
    apply: sub(
      'GRANT UPDATE (status, attempts, received_at, completed_at, failed_at,\n              last_error_code, organization_id)',
      'GRANT UPDATE (status, attempts, received_at, completed_at, failed_at,\n              last_error_code, organization_id, stripe_customer_id)',
    ),
  },

  // --- RR-CAP-10: the organizations column ACL -----------------------------
  {
    id: 'R-25',
    capability: 'CROSS',
    file: CAP06,
    change: 'the quota column is added back to the runtime UPDATE grant',
    breaks:
      'RR-CAP-10 in one word, inside a parenthesis, in a diff that reads like formatting. Every organisation admin can set their own quota through the ORM again.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap06-quota-excluded', 'grant-extra'],
    apply: sub(
      '  sector,\n  updated_at,\n  white_label_enabled\n) ON public.organizations TO uellix_writer;',
      '  sector,\n  stella_monthly_quota,\n  updated_at,\n  white_label_enabled\n) ON public.organizations TO uellix_writer;',
    ),
  },
  {
    id: 'R-26',
    capability: 'CROSS',
    file: CAP06,
    change: 'the table-level UPDATE is revoked from uellix_writer only',
    breaks:
      'the half of the repair that is always forgotten. `authenticated` is PostgREST’s role: the quota stays writable from a browser holding nothing but the user’s own JWT, and no ORM call site shows it.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap06-revoke'],
    apply: sub(
      'REVOKE UPDATE ON public.organizations FROM authenticated, uellix_writer, anon, PUBLIC;',
      'REVOKE UPDATE ON public.organizations FROM uellix_writer, anon, PUBLIC;',
    ),
  },
  {
    id: 'R-27',
    capability: 'CROSS',
    file: CAP06,
    change: 'the definer stops checking that the caller is a platform super_admin',
    breaks:
      'the boundary the whole package moves the quota behind. The RESTRICTIVE policy still refuses, so this is defence in depth failing on one side — which is exactly the condition nobody notices.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap06-super-admin-check'],
    apply: sub(
      '  IF NOT public.current_user_is_super_admin() THEN\n    RAISE EXCEPTION \'capability request denied\' USING ERRCODE = \'U0001\';\n  END IF;\n\n  -- NULL IS A VALUE HERE',
      '  -- NULL IS A VALUE HERE',
    ),
  },
  {
    id: 'R-28',
    capability: 'CROSS',
    file: CAP06,
    change: 'the RESTRICTIVE super-admin bound becomes USING (true)',
    breaks:
      'the other side of the same boundary. With the body check present this is invisible in behaviour and fatal the day the body is rewritten.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-using'],
    apply: sub(
      'ON public.organizations AS RESTRICTIVE FOR UPDATE TO uellix_cap_platform\nUSING (public.current_user_is_super_admin())',
      'ON public.organizations AS RESTRICTIVE FOR UPDATE TO uellix_cap_platform\nUSING (true)',
    ),
  },
  {
    id: 'R-29',
    capability: 'CROSS',
    file: CAP06,
    change: 'the quota change stops writing an audit row',
    breaks:
      'the atomicity the package exists to introduce. The previous code wrote the UPDATE and the audit as two awaited calls; a definer that only updates reproduces that gap inside one transaction.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap06-audit-atomic'],
    apply: sub(
      "  INSERT INTO public.audit_logs\n    (organization_id, actor_user_id, entity_type, entity_id, action,\n     before_json, after_json, reason)\n  VALUES\n    (p_organization_id, auth.uid(), 'organization', p_organization_id,\n     'platform.stella_service.updated',",
      "  PERFORM\n    (p_organization_id, auth.uid(), 'organization', p_organization_id,\n     'platform.stella_service.updated',",
    ),
  },
  {
    id: 'R-30',
    capability: 'CROSS',
    file: CAP06,
    change: 'the organisation status accepts any value',
    breaks:
      'the fixed vocabulary of a column that has no CHECK constraint. A platform admin could set a state nothing handles — including one that is not "suspended" and therefore reads as active everywhere.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap06-status-allowlist'],
    apply: sub(
      "  IF p_organization_id IS NULL OR p_status NOT IN ('active','suspended') THEN",
      '  IF p_organization_id IS NULL THEN',
    ),
  },
  {
    id: 'R-31',
    capability: 'CROSS',
    file: CAP06,
    change: 'the platform definer is given LOGIN',
    breaks:
      'the containment of a role that can move any quota on the platform. A NOLOGIN definer is reachable only through its functions; a LOGIN one is reachable by anyone holding a password.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['role-attributes'],
    apply: sub(
      'ALTER ROLE uellix_cap_platform\n  NOLOGIN NOINHERIT NOBYPASSRLS',
      'ALTER ROLE uellix_cap_platform\n  LOGIN NOINHERIT NOBYPASSRLS',
    ),
  },
  {
    id: 'R-32',
    capability: 'CROSS',
    file: RB06,
    change: 'the rollback keeps the narrowed column grant instead of restoring the table grant',
    breaks:
      'the meaning of "rollback". The database ends in a state neither script describes, and the operator who ran it during an incident believes the write surface is the pre-package one.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['rollback-grant'],
    apply: sub(
      'GRANT UPDATE ON public.organizations TO authenticated;',
      'GRANT UPDATE (country, sector) ON public.organizations TO authenticated;',
    ),
  },
  {
    id: 'R-33',
    capability: 'CROSS',
    file: RB06,
    change: 'the rollback leaves the RESTRICTIVE super-admin policy behind',
    breaks:
      'the worst kind of residue. A RESTRICTIVE policy is ANDed into every statement by a role of that name, so a role recreated later inherits an invisible deny nothing in the catalogue explains.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['rollback-policy'],
    apply: sub(
      'DROP POLICY IF EXISTS cap_platform_only_super_admin      ON public.organizations;',
      '-- left in place',
    ),
  },


  // =========================================================================
  // P-* — negative evidence for gates that were the SOLE protection of an
  // authorisation boundary and had none.
  //
  // These are not new properties. They are properties the gates already
  // asserted and that no mutation had ever tried to break, which is a weaker
  // claim than it reads: an assertion nobody has attacked is an assertion
  // nobody has measured. RR-CAP-12's residual is allowed to contain
  // documentary, counting and fail-safe gates; it is not allowed to contain
  // the only thing standing between a caller and a boundary.
  // =========================================================================

  {
    id: 'P-01',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the disclosure audit function is renamed, so the contract finds nothing',
    breaks:
      'the whole of RR-CAP-02-F by omission. The trigger contract still names a function; nothing creates it.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap02-audit-function'],
    apply: sub(
      'CREATE OR REPLACE FUNCTION public.uellix_audit_report_disclosure()\nRETURNS trigger',
      'CREATE OR REPLACE FUNCTION public.uellix_audit_disclosure_v2()\nRETURNS trigger',
    ),
  },
  {
    id: 'P-02',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the audit row is written with a NULL actor',
    breaks:
      'attribution. The trail records that a certificate was published and refuses to say by whom — and audit_logs is append-only, so it can never be corrected.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap02-audit-actor'],
    apply: sub(
      "    (v_org_id, auth.uid(), 'report_public_disclosure', NEW.report_id, v_action,",
      "    (v_org_id, NULL, 'report_public_disclosure', NEW.report_id, v_action,",
    ),
  },
  {
    id: 'P-03',
    capability: 'CROSS',
    file: CAP06,
    change: 'the status function is renamed out of the contract',
    breaks:
      'the only path to organizations.status after creation. With the column revoked from the runtime and the function gone, suspension becomes unreachable — a fail-closed outage, but an unannounced one.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap06-function'],
    apply: sub(
      'CREATE OR REPLACE FUNCTION uellix_capability.admin_set_organization_status(',
      'CREATE OR REPLACE FUNCTION uellix_capability.admin_set_org_status_v2(',
    ),
  },
  {
    id: 'P-04',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the Stripe capability is granted a read of sroi_reports',
    breaks:
      'the blast radius. A billing identity that can read impact reports is a billing identity that can be repurposed, and nothing in CAP-03 would ever exercise the grant.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap03-blast-radius'],
    apply: before(
      'GRANT SELECT, INSERT ON public.stripe_webhook_events TO uellix_cap_stripe;',
      'GRANT SELECT ON public.sroi_reports TO uellix_cap_stripe;',
    ),
  },
  {
    id: 'P-05',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the LOGIN identity receives a table privilege directly',
    breaks:
      'the separation the package is built on. uellix_stripe holds EXECUTE on three functions and nothing else precisely so that a leaked webhook credential is not a customer list.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap03-login-identity'],
    apply: before(
      'GRANT SELECT, INSERT ON public.stripe_webhook_events TO uellix_cap_stripe;',
      'GRANT SELECT ON public.organizations TO uellix_stripe;',
    ),
  },
  {
    id: 'P-06',
    capability: 'CAP-03',
    file: CAP03,
    change: 'a payload column is added to the event table',
    breaks:
      '"it stores no Stripe payload, ever". A Stripe event carries payment and customer data Stripe already custodies; copying it here creates a second custodian with no retention story.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap03-no-payload'],
    apply: sub(
      '  last_error_code text,\n  organization_id uuid REFERENCES public.organizations(id),',
      '  last_error_code text,\n  payload         jsonb,\n  organization_id uuid REFERENCES public.organizations(id),',
    ),
  },
  {
    id: 'P-07',
    capability: 'CAP-03',
    file: CAP03,
    change: 'event_id stops being the PRIMARY KEY',
    breaks:
      'idempotency. Without the constraint the claim degenerates into check-then-act, and two concurrent Stripe deliveries of the same event both pass.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap03-event-pk'],
    apply: sub(
      '  event_id        text        PRIMARY KEY,',
      '  event_id        text        NOT NULL,',
    ),
  },
  {
    id: 'P-08',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the organisation resolution accepts more than one row',
    breaks:
      'tenancy. `< 1` passes when the match returned two organisations, and the function then applies the change to whichever one array_agg happened to order first.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap03-single-org'],
    apply: sub(
      'SELECT pg_catalog.array_agg(o.id) INTO v_org_ids',
      'SELECT (SELECT o.id LIMIT 1) INTO v_org_ids',
    ),
  },
  {
    id: 'P-09',
    capability: 'CAP-01',
    file: CAP01,
    change: 'a non-pending invitation is no longer refused',
    breaks:
      'the state machine. A revoked or already-accepted invitation becomes usable again, which is the difference between withdrawing access and appearing to.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap01-status'],
    apply: sub("IF v_inv_status <> 'pending' THEN", 'IF false THEN'),
  },
  {
    id: 'P-10',
    capability: 'CAP-01',
    file: CAP01,
    change: 'the token is compared without being hashed',
    breaks:
      'the reason token_hash exists. A read of the invitations table — by a backup, an auditor, or a log — becomes a set of usable invitation tokens.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap01-token-hash'],
    apply: sub(
      'pg_catalog.sha256(pg_catalog.convert_to(p_token',
      'pg_catalog.lower(pg_catalog.convert_to(p_token',
    ),
  },
  {
    id: 'P-11',
    capability: 'CAP-02',
    file: CAP02,
    change: 'verify_report stops requiring a locked report',
    breaks:
      'the bound the RESTRICTIVE policy and the body were supposed to state twice. A draft with a disclosure row would verify, publishing figures that were never finalised.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap02-locked'],
    apply: sub(
      "  WHERE r.verification_hash = p_hash\n    AND r.status = 'locked'\n    AND d.revoked_at IS NULL",
      '  WHERE r.verification_hash = p_hash\n    AND d.revoked_at IS NULL',
    ),
  },
  {
    id: 'P-12',
    capability: 'CAP-02',
    file: CAP02,
    change: 'verify_report ignores revocation',
    breaks:
      'withdrawal. A revoked certificate keeps verifying, so revocation becomes a UI state with no effect on the thing that circulated.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap02-revoked'],
    apply: sub(
      "    AND r.status = 'locked'\n    AND d.revoked_at IS NULL\n$$;",
      "    AND r.status = 'locked'\n$$;",
    ),
  },
  {
    id: 'P-13',
    capability: 'CAP-05',
    file: CAP05,
    change: 'the signup allowlist gate is read from the wrong table',
    breaks:
      'who may create an organisation at all. The bootstrap becomes open to any authenticated subject, which is the one thing the allowlist exists to prevent.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap05-allowlist'],
    apply: sub('FROM public.signup_allowlist s', 'FROM public.users s'),
  },


  {
    id: 'P-14',
    capability: 'CAP-01',
    file: CAP01,
    change: 'the subject is taken from a parameter instead of from auth.uid()',
    breaks:
      'the whole authorisation model of CAP-01. The subject stops being proven by the session and becomes something the caller asserts.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap01-subject'],
    apply: sub('v_subject := auth.uid();', 'v_subject := p_token::uuid;'),
  },
  {
    id: 'P-15',
    capability: 'CAP-01',
    file: CAP01,
    change: 'the single-active-membership guard reads the wrong status',
    breaks:
      'the invariant that a user holds one active membership. A subject with a suspended membership acquires a second, and every org-scoped policy that uses current_user_org_ids() then answers for two tenants.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap01-single-membership'],
    apply: sub("m.status = 'active'", "m.status = 'whatever'"),
  },
  {
    id: 'P-16',
    capability: 'CAP-02',
    file: CAP02,
    change: 'verify_report reads a column outside the disclosure surface',
    breaks:
      'the minimality argument. The public read path names the organisation slug, which no disclosure flag gates and which identifies the tenant whatever the booleans say.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap02-minimal'],
    apply: sub(
      '    CASE WHEN d.show_organization_name THEN o.name::text END,',
      '    CASE WHEN d.show_organization_name THEN o.slug::text END,',
    ),
  },
  {
    id: 'P-17',
    capability: 'CAP-02',
    file: CAP02,
    change: 'verify_report writes',
    breaks:
      'the property that makes the anonymous read path safe. A STABLE function cannot write; this turns the one endpoint reachable without any credential into a write path.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap02-readonly'],
    apply: sub(
      '  FROM public.sroi_reports r\n  JOIN public.report_public_disclosures d ON d.report_id = r.id',
      '  FROM public.sroi_reports r\n  JOIN public.report_public_disclosures d ON d.report_id = r.id\n  CROSS JOIN (DELETE FROM public.audit_logs RETURNING 1) w',
    ),
  },
  {
    id: 'P-18',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the event claim stops being an atomic upsert',
    breaks:
      'the idempotency key doing its job. DO NOTHING never returns a row, so nothing is ever claimed and the lease logic is dead code.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap03-claim-atomic'],
    apply: sub('ON CONFLICT (event_id) DO UPDATE', 'ON CONFLICT (event_id) DO NOTHING --'),
  },
  {
    id: 'P-19',
    capability: 'CAP-04',
    file: CAP04,
    change: 'the lead submission accepts a campaign attribution from the caller',
    breaks:
      'the rule that attribution is server-derived. An anonymous endpoint that records a caller-supplied campaign is an anonymous endpoint that writes analytics for anybody.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap04-server-derived'],
    apply: sub('  p_source       text\n) RETURNS void', '  p_source       text,\n  p_campaign     text\n) RETURNS void'),
  },
  {
    id: 'P-20',
    capability: 'CAP-05',
    file: CAP05,
    change: 'the bootstrap names a billing column',
    breaks:
      'the proposition that founding an organisation cannot choose its plan. It is the other half of RR-CAP-10: closing the ORM path is worth nothing if the bootstrap can set the quota on the way in.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap05-no-plan'],
    apply: sub(
      '  v_org_id    uuid;',
      "  v_org_id    uuid;\n  v_quota     text := 'stella_monthly_quota';",
    ),
  },
  {
    id: 'P-21',
    capability: 'CAP-05',
    file: CAP05,
    change: 'slug uniqueness goes back to check-then-act',
    breaks:
      'atomicity under contention. Two concurrent bootstraps both read "free" and one gets a unique-violation the handler turns into a uniform refusal — after creating a membership.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap05-slug-atomic'],
    apply: sub(
      'ON CONFLICT ON CONSTRAINT organizations_slug_unique DO NOTHING',
      'ON CONFLICT DO NOTHING',
    ),
  },
  {
    id: 'P-22',
    capability: 'CAP-04',
    file: CAP04,
    change: 'lead_status stops being pinned in the body',
    breaks:
      'the constant the capability is built on. With no parameter and no constant, the column takes its default — and a lead that arrives already qualified is a lead nobody reviewed.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap04-status-constant'],
    // The FIRST `'new'` in the file is the column DEFAULT, not the constant the
    // body pins. Anchoring on it would mutate the schema and leave the property
    // intact — a mutation that changes text without changing the claim.
    apply: sub(
      "    (v_email, v_company, v_sroi, p_source, 'new', NULL)",
      '    (v_email, v_company, v_sroi, p_source, v_status, NULL)',
    ),
  },
  {
    id: 'P-23',
    capability: 'CROSS',
    file: CAP06,
    change: 'a capability function stops being SECURITY DEFINER',
    breaks:
      'the only reason the function can reach a column its caller cannot. As INVOKER it runs with uellix_app’s privileges, which this very package revoked — a fail-closed outage, and a definer boundary that silently no longer exists.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['definer-security'],
    apply: sub(
      ') RETURNS void\nLANGUAGE plpgsql\nSECURITY DEFINER\nVOLATILE\n  SET search_path = \'\'\nAS $$\nDECLARE\n  v_before jsonb;',
      ') RETURNS void\nLANGUAGE plpgsql\nVOLATILE\n  SET search_path = \'\'\nAS $$\nDECLARE\n  v_before jsonb;',
    ),
  },
  {
    id: 'P-24',
    capability: 'CROSS',
    file: CAP06,
    change: 'the definer reads the organisation with SELECT *',
    breaks:
      'the column bound. SELECT * over a table whose grant is five columns fails at run time — and if the grant is ever widened, it silently starts reading everything.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['definer-select-star'],
    apply: sub(
      '  SELECT o.status INTO v_before\n    FROM public.organizations o',
      '  SELECT * INTO v_before\n    FROM public.organizations o',
    ),
  },
  {
    id: 'P-25',
    capability: 'CROSS',
    file: CAP06,
    change: 'the platform definer is named in another capability’s grant',
    breaks:
      'capability isolation. One definer holding another’s privileges collapses five separately revocable surfaces into one.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['role-crossgrant'],
    apply: before(
      'DROP POLICY IF EXISTS cap_platform_select_orgs ON public.organizations;',
      'GRANT SELECT (id, name) ON public.organizations TO uellix_cap_verification;',
    ),
  },
  {
    id: 'P-26',
    capability: 'CROSS',
    file: CAP06,
    change: 'the RESTRICTIVE super-admin bound is written FOR SELECT instead of FOR UPDATE',
    breaks:
      'the command it bounds. Reads stay narrow and every UPDATE by the definer becomes unbounded — the policy is still there, still RESTRICTIVE, still named after the boundary it no longer guards.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-command'],
    apply: sub(
      'CREATE POLICY cap_platform_only_super_admin\nON public.organizations AS RESTRICTIVE FOR UPDATE TO uellix_cap_platform',
      'CREATE POLICY cap_platform_only_super_admin\nON public.organizations AS RESTRICTIVE FOR SELECT TO uellix_cap_platform',
    ),
  },
  {
    id: 'P-27',
    capability: 'CROSS',
    file: RB06,
    change: 'the rollback does not drop the platform definer role',
    breaks:
      'the teardown. A role that can move any quota on the platform survives the removal of the only functions that were supposed to be able to use it.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['rollback-role'],
    apply: sub("    EXECUTE 'DROP ROLE uellix_cap_platform';", '    NULL;'),
  },
  {
    id: 'P-28',
    capability: 'CROSS',
    file: RB06,
    change: 'the rollback leaves one of the two definer functions behind',
    breaks:
      'the same teardown from the other side: a SECURITY DEFINER function whose owner the rollback then drops.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['rollback-function'],
    apply: sub(
      'DROP FUNCTION IF EXISTS uellix_capability.admin_set_stella_service(uuid, integer, text);',
      '-- left in place',
    ),
  },
  {
    id: 'P-29',
    capability: 'CROSS',
    file: RB06,
    change: 'the rollback uses CASCADE',
    breaks:
      'the blast radius of a script that runs as superuser during an incident. CASCADE drops whatever happens to depend on the object, and nobody is reading the output at that moment.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['rollback-cascade'],
    apply: sub(
      'DROP FUNCTION IF EXISTS uellix_capability.admin_set_organization_status(uuid, text);',
      'DROP FUNCTION IF EXISTS uellix_capability.admin_set_organization_status(uuid, text) CASCADE;',
    ),
  },
  {
    id: 'P-30',
    capability: 'CROSS',
    file: RB06,
    change: 'the rollback disables row level security on organizations',
    breaks:
      'every tenancy bound in the schema, in the file least likely to be read. One statement, in a rollback, and 107 policies stop applying.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['rollback-rls'],
    apply: before(
      'REVOKE UPDATE ON public.organizations FROM authenticated, uellix_writer;',
      'ALTER TABLE public.organizations DISABLE ROW LEVEL SECURITY;',
    ),
  },
  {
    id: 'P-31',
    capability: 'CROSS',
    file: RB06,
    change: 'the rollback re-owns a table to the definer it is about to drop',
    breaks:
      'ownership, which is RLS exemption in a schema with no FORCE ROW LEVEL SECURITY. Re-owning organizations hands the new owner a bypass of every policy on it.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['rollback-ownership'],
    apply: before(
      'REVOKE UPDATE ON public.organizations FROM authenticated, uellix_writer;',
      'ALTER TABLE public.organizations OWNER TO uellix_cap_platform;',
    ),
  },


  {
    id: 'P-32',
    capability: 'CAP-05',
    file: CAP05,
    change: 'the bootstrap single-membership guard reads the wrong status',
    breaks:
      'the invariant that founding an organisation requires having none. A subject with a suspended membership founds a second organisation and holds two.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap05-single-membership'],
    apply: sub(
      "     WHERE m.user_id = v_subject AND m.status = 'active'",
      "     WHERE m.user_id = v_subject AND m.status = 'any'",
    ),
  },
  {
    id: 'P-33',
    capability: 'CAP-04',
    file: CAP04,
    change: 'one of the two dead PostgREST-era lead policies is left in place',
    breaks:
      'the net reduction the package claims. anon keeps a direct INSERT path into marketing_leads that bypasses the capability entirely — the allowlist, the status constant and the rate limit with it.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap04-retire-dead-policies'],
    apply: sub(
      'DROP POLICY IF EXISTS anon_insert_marketing_leads          ON public.marketing_leads;',
      '-- left in place',
    ),
  },


  {
    id: 'R-34',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the sroi_reports visibility trigger is never created',
    breaks:
      'the OTHER half of public visibility. Locking a report with a live disclosure takes a certificate public, and unlocking it takes it dark, with nothing written to the audited table — so "publishing cannot happen without a trace" becomes true of the wrong table.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['trigger-missing'],
    apply: sub(
      'CREATE TRIGGER trg_report_visibility_audit\nAFTER UPDATE ON public.sroi_reports\nFOR EACH ROW EXECUTE FUNCTION public.uellix_audit_report_visibility();',
      '-- visibility trigger removed',
    ),
  },
  {
    id: 'R-35',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the row bound stops being correlated to the event being applied',
    breaks:
      'the difference between "this event" and "some event". With org B’s event in flight, the transaction handling org A’s event satisfies RLS for B’s row — which is exactly the cross-tenant write the bound was written to stop.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['policy-using'],
    apply: sub(
      "ON public.organizations AS RESTRICTIVE FOR SELECT TO uellix_cap_stripe\nUSING (\n  EXISTS (\n    SELECT 1 FROM public.stripe_webhook_events e\n     WHERE e.event_id = NULLIF(pg_catalog.current_setting('app.stripe_event_id', true), '')\n       AND e.status = 'processing'",
      "ON public.organizations AS RESTRICTIVE FOR SELECT TO uellix_cap_stripe\nUSING (\n  EXISTS (\n    SELECT 1 FROM public.stripe_webhook_events e\n     WHERE e.status = 'processing'",
    ),
  },
  {
    id: 'R-36',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the body stops requiring the claimed event to carry the address it matches on',
    breaks:
      'the correlation between the signed event and the organisation it moves. The two identity columns become decoration: read by the policy, ignored by the function.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap03-claim-correlated'],
    apply: sub(
      "       AND ( (p_match_kind = 'customer'\n              AND e.stripe_customer_id IS NOT NULL\n              AND e.stripe_customer_id = p_match_value)\n          OR (p_match_kind = 'subscription'\n              AND e.stripe_subscription_id IS NOT NULL\n              AND e.stripe_subscription_id = p_match_value) )\n",
      '',
    ),
  },
  {
    id: 'R-37',
    capability: 'CAP-03',
    file: CAP03,
    change: 'a customer-addressed event may null out the subscription link',
    breaks:
      'the organisation’s reachability. Detaching stripe_subscription_id removes it from the subscription branch of the bound forever, and DP-CAP-15 forbids a webhook from re-binding it.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap03-subscription-coalesce'],
    apply: sub(
      'stripe_subscription_id = COALESCE(p_stripe_subscription_id, stripe_subscription_id),',
      'stripe_subscription_id = p_stripe_subscription_id,',
    ),
  },
  {
    id: 'R-38',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the request id is copied into the audit row unfiltered',
    breaks:
      'the rule that audit_logs holds no payload. app.request_id is a custom GUC any role can set, so an unfiltered copy is a free-text channel into a table nothing can ever correct.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap02-audit-request-id'],
    apply: sub(
      "    'requestId',              (SELECT CASE WHEN v ~ '^[A-Za-z0-9_.:-]{1,64}$' THEN v END\n                                 FROM (SELECT NULLIF(pg_catalog.current_setting('app.request_id', true), '') AS v) g));",
      "    'requestId',              NULLIF(pg_catalog.current_setting('app.request_id', true), ''));",
    ),
  },
  {
    id: 'R-39',
    capability: 'CAP-02',
    file: CAP02,
    change: 'the owner default ACL is left in place on the disclosure table',
    breaks:
      'the column-scoped INSERT grant, entirely. ALTER DEFAULT PRIVILEGES already gave uellix_writer table-level SELECT+INSERT when the table was created, and ACLs are additive — so an organisation admin can set approved_at, created_at or a pre-filled revoked_at, and "one human decision with author and timestamp" stops holding.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['default-acl-not-revoked'],
    apply: sub(
      'REVOKE ALL ON public.report_public_disclosures FROM uellix_writer, uellix_auditor;',
      '-- default ACL left in place',
    ),
  },
  {
    id: 'R-40',
    capability: 'CROSS',
    file: CAP06,
    change: 'the eight runtime columns are re-granted to authenticated',
    breaks:
      'the surface the package exists to close. authenticated is PostgREST’s role: a browser holding nothing but the user’s own JWT could rewrite base_currency — an input to the FX/NPV engine — with no application-layer validation at all.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['grant-extra'],
    apply: sub(
      ') ON public.organizations TO uellix_writer;',
      ') ON public.organizations TO uellix_writer;\nGRANT UPDATE (country) ON public.organizations TO authenticated;',
    ),
  },


  // =========================================================================
  // S-* — the self-escalation that made stella_0011's boundary decorative, and
  // the Stripe contention that could lose an event.
  //
  // S-01..S-08 exist because the final reaudit returned BLOCKED_QUOTA: the
  // quota was moved behind current_user_is_super_admin(), and the runtime
  // could write the one column that predicate reads. A boundary is only as
  // good as the cheapest way to satisfy it.
  // =========================================================================

  {
    id: 'S-01',
    capability: 'CROSS',
    file: CAP07,
    change: 'the table-level UPDATE on public.users is not revoked',
    breaks:
      'everything downstream of it. `UPDATE public.users SET is_super_admin = true WHERE id = auth.uid()` passes the ACL and passes users_update_own, whose bound is the ROW — and the row is the privilege. The caller becomes a platform super_admin, which satisfies 114 policy predicates and the RESTRICTIVE bound stella_0011 depends on.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap07-revoke'],
    apply: sub(
      'REVOKE UPDATE ON public.users FROM authenticated, uellix_writer, anon, PUBLIC;',
      '-- table-level UPDATE left in place',
    ),
  },
  {
    id: 'S-02',
    capability: 'CROSS',
    file: CAP07,
    change: 'is_super_admin is added back to the runtime UPDATE grant',
    breaks:
      'the same boundary in one word, inside a parenthesis, in a diff that reads like an alphabetical insertion.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap07-authority-column'],
    apply: sub(
      '  avatar_url,\n  email,\n  full_name,\n  updated_at\n) ON public.users TO uellix_writer;',
      '  avatar_url,\n  email,\n  full_name,\n  is_super_admin,\n  updated_at\n) ON public.users TO uellix_writer;',
    ),
  },
  {
    id: 'S-03',
    capability: 'CROSS',
    file: CAP07,
    change: 'role is added back to the membership UPDATE grant',
    breaks:
      'what CAP-01 and CAP-05 are built to forbid. CAP-01 carries `role <> \'super_admin\'` as a RESTRICTIVE check and CAP-05 pins the founder to organization_admin; with this column writable an organisation admin mints the membership both packages refuse to create.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap07-authority-column'],
    apply: sub(
      '  status,\n  updated_at\n) ON public.organization_members TO uellix_writer;',
      '  role,\n  status,\n  updated_at\n) ON public.organization_members TO uellix_writer;',
    ),
  },
  {
    id: 'S-04',
    capability: 'CROSS',
    file: CAP07,
    change: 'organization_id is added back to the membership UPDATE grant',
    breaks:
      'tenancy of the membership itself. Today `members_update_admin`’s WITH CHECK blocks moving a membership to another organisation; that is a policy, and this campaign’s whole argument is that the ACL is the durable layer.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap07-authority-column'],
    apply: sub(
      '  status,\n  updated_at\n) ON public.organization_members TO uellix_writer;',
      '  organization_id,\n  status,\n  updated_at\n) ON public.organization_members TO uellix_writer;',
    ),
  },
  {
    id: 'S-05',
    capability: 'CROSS',
    file: CAP07,
    change: 'the package revokes INSERT as well',
    breaks:
      'sign-up and both membership paths. It is the over-correction this package explicitly refuses: a REVOKE that looks stricter and takes the product down on the first new account.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['cap07-insert-preserved'],
    apply: sub(
      'REVOKE UPDATE ON public.users FROM authenticated, uellix_writer, anon, PUBLIC;',
      'REVOKE UPDATE, INSERT ON public.users FROM authenticated, uellix_writer, anon, PUBLIC;',
    ),
  },
  {
    id: 'S-06',
    capability: 'CROSS',
    file: CAP07,
    change: 'the repair is attempted with a policy instead of a column ACL',
    breaks:
      'the one thing RR-CAP-10 documents at length: RLS evaluates a row twice and is never handed the statement’s target list, so no policy expression can mean "this column changed". A policy here would look like a fix and stop nothing.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap07-acl-not-policy'],
    apply: before(
      'COMMENT ON COLUMN public.users.is_super_admin IS',
      "CREATE POLICY users_no_self_promote ON public.users AS RESTRICTIVE FOR UPDATE TO uellix_writer\nUSING (id = auth.uid());",
    ),
  },
  {
    id: 'S-07',
    capability: 'CROSS',
    file: CAP07,
    change: 'the membership revoke forgets authenticated',
    breaks:
      'the PostgREST half, which is the half that gets forgotten. A browser holding nothing but the user’s own JWT keeps table-level UPDATE on organization_members.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap07-revoke'],
    apply: sub(
      'REVOKE UPDATE ON public.organization_members FROM authenticated, uellix_writer, anon, PUBLIC;',
      'REVOKE UPDATE ON public.organization_members FROM uellix_writer, anon, PUBLIC;',
    ),
  },
  {
    id: 'S-08',
    capability: 'CROSS',
    file: RB07,
    change: 'the rollback does not restore the table-level UPDATE it removed',
    breaks:
      'the meaning of "rollback". The database ends in a state neither script describes, and an operator who ran it during an incident believes the write surface is the pre-package one.',
    severity: 'MAJOR',
    survivedBecause: '',
    expectedGate: ['rollback-grant'],
    apply: sub(
      'GRANT UPDATE ON public.users TO authenticated;',
      'GRANT UPDATE (email) ON public.users TO authenticated;',
    ),
  },

  // --- Stripe contention ---------------------------------------------------
  {
    id: 'S-09',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the lock_not_available handler is removed',
    breaks:
      'retry semantics. A 3s lock_timeout during a concurrent claim falls through to WHEN OTHERS and returns U0001 — indistinguishable from a malformed event. If the handler answers 4xx, Stripe stops retrying and the subscription change never lands.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap03-contention-retryable'],
    apply: sub(
      "  WHEN lock_not_available THEN\n    RAISE LOG 'stripe_begin_event contended on the event row (55P03)';\n    RETURN 'in_progress';\n",
      '',
    ),
  },
  {
    id: 'S-10',
    capability: 'CAP-03',
    file: CAP03,
    change: 'the serialization_failure handler is removed',
    breaks:
      'the same property under a different transaction isolation. 40001 is transient by definition and leaves the row untouched; collapsing it into a client error loses the event.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap03-contention-retryable'],
    apply: sub(
      "  WHEN serialization_failure THEN\n    RAISE LOG 'stripe_begin_event lost a serialisation conflict (40001)';\n    RETURN 'in_progress';\n",
      '',
    ),
  },
  {
    id: 'S-11',
    capability: 'CAP-03',
    file: CAP03,
    change: 'WHEN OTHERS answers in_progress',
    breaks:
      'the opposite half. Answering "retry" to every unexpected error turns a permanent defect into an infinite retry loop — the same silent loss wearing the opposite mask, which is why the handlers are enumerated rather than generic.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap03-contention-retryable'],
    apply: sub(
      "  WHEN OTHERS THEN\n    RAISE LOG 'stripe_begin_event refused with SQLSTATE %', SQLSTATE;\n    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';",
      "  WHEN OTHERS THEN\n    RAISE LOG 'stripe_begin_event refused with SQLSTATE %', SQLSTATE;\n    RETURN 'in_progress';",
    ),
  },


  {
    id: 'S-12',
    capability: 'CROSS',
    file: CAP07,
    change: 'the value bound is retargeted away from the runtime principals',
    breaks:
      'the only bound a column ACL cannot express. INSERT column privileges say which columns may be written, never which VALUES — so with this policy pointed elsewhere an organisation admin can DELETE a member and re-INSERT them as super_admin, which is exactly what CAP-01 and CAP-05 refuse to do for their own definers.',
    severity: 'BLOCKER',
    survivedBecause: '',
    expectedGate: ['cap07-super-admin-value'],
    apply: sub(
      'ON public.organization_members AS RESTRICTIVE FOR INSERT TO uellix_app, authenticated',
      'ON public.organization_members AS RESTRICTIVE FOR INSERT TO uellix_cap_invitation',
    ),
  },

]

export const PREVIOUSLY_SURVIVING = MUTATIONS.filter((m) => m.id.startsWith('M-'))
export const NEW_MUTATIONS = MUTATIONS.filter((m) => m.id.startsWith('N-'))
/** The eight PostgreSQL-equivalent spellings the reaudit confirmed as escapes. */
export const EVASION_MUTATIONS = MUTATIONS.filter((m) => m.id.startsWith('E-'))
/** The additional equivalences added alongside the fail-closed parser. */
export const FAIL_CLOSED_MUTATIONS = MUTATIONS.filter((m) => m.id.startsWith('F-'))
/** What the adversarial review of the NEW parser found, pinned. */
export const ADVERSARIAL_MUTATIONS = MUTATIONS.filter((m) => m.id.startsWith('A-'))
