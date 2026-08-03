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

const CAP01 = 'stella_0006_invitation_capability.sql'
const CAP02 = 'stella_0007_public_verification_capability.sql'
const CAP03 = 'stella_0008_stripe_webhook_identity.sql'
const CAP04 = 'stella_0009_public_lead_capability.sql'
const CAP05 = 'stella_0010_organization_bootstrap_capability.sql'
const RB02 = 'stella_0007_rollback.sql'

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
    apply: sub(
      `  IF NOT EXISTS (
    SELECT 1 FROM public.stripe_webhook_events e
     WHERE e.event_id = p_event_id AND e.status = 'processing'
  ) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;
`,
      '',
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
]

export const PREVIOUSLY_SURVIVING = MUTATIONS.filter((m) => m.id.startsWith('M-'))
export const NEW_MUTATIONS = MUTATIONS.filter((m) => m.id.startsWith('N-'))
