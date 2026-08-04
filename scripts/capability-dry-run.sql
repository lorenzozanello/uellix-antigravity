-- scripts/capability-dry-run.sql
--
-- The live assertions of the capability campaign, plus the concurrency and
-- cross-isolation checks, as executable SQL.
--
-- Since the design-risk closure it also carries four blocks named after the
-- risks they close rather than after a capability document — RR10-*, RR13-*,
-- RR14-* and RR02F-*. Those are deliberately NOT folded into the CAP-nn suites:
-- each one exists because a property the design ASSERTED turned out not to be
-- enforced anywhere, and keeping them under the risk id is what makes the
-- evidence findable from the risk register.
--
-- WHY THIS FILE EXISTS. The five capability documents each define a live suite
-- (CAP-01 §11.2 L1..L13, CAP-02 §11.2 L1..L12, CAP-03 §12.2 L1..L14,
-- CAP-04 §10.2 L1..L13, CAP-05 §9.2 L1..L15) and the previous dry run executed
-- them by hand. Evidence produced by hand is evidence that cannot be produced
-- again, so the second reaudit had nothing to re-check. This file is the
-- re-runnable form.
--
-- WHERE IT MAY RUN. A DISPOSABLE container only, seeded from a schema-only dump
-- and started with --network none. It creates fixtures, it takes locks, and it
-- deliberately attempts operations that must be refused. Running it against a
-- stack anyone depends on would be a mistake; the guard below refuses to start
-- unless the marker table planted by the driver is present.
--
-- HOW IT REPORTS. Every assertion records a row in dryrun.results rather than
-- raising, so one failure does not hide the twenty after it. The final SELECT
-- is the verdict.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 0. Refuse to run anywhere that is not the disposable stack
-- ---------------------------------------------------------------------------
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'dryrun' AND tablename = 'disposable_marker') THEN
    RAISE EXCEPTION
      'refusing to run: dryrun.disposable_marker is absent. This script mutates data and must only run in the disposable container created by scripts/capability-dry-run.sh.';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS dryrun.results (
  id     text PRIMARY KEY,
  ok     boolean NOT NULL,
  detail text NOT NULL DEFAULT ''
);
TRUNCATE dryrun.results;

CREATE OR REPLACE FUNCTION dryrun.rec(p_id text, p_ok boolean, p_detail text DEFAULT '')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO dryrun.results VALUES (p_id, p_ok, p_detail)
  ON CONFLICT (id) DO UPDATE SET ok = EXCLUDED.ok, detail = EXCLUDED.detail;
$$;

-- `true` when the statement was refused with 42501 (insufficient_privilege) or
-- with the uniform U0001. Anything else — including success — is a failure, and
-- the SQLSTATE is recorded so a wrong refusal is distinguishable from a right
-- one.
CREATE OR REPLACE FUNCTION dryrun.denied(p_id text, p_role text, p_sql text, p_expect text DEFAULT '42501')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
    EXECUTE p_sql;
    PERFORM dryrun.rec(p_id, false, 'ALLOWED — the statement succeeded');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec(p_id, SQLSTATE = p_expect, 'SQLSTATE ' || SQLSTATE);
  END;
  RESET ROLE;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. Fixtures
-- ---------------------------------------------------------------------------
DO $fixtures$
DECLARE
  c_org_a  constant uuid := '11111111-1111-4111-8111-111111111111';
  c_org_b  constant uuid := '22222222-2222-4222-8222-222222222222';
  c_alice  constant uuid := 'aaaaaaaa-0000-4000-8000-000000000001';  -- invitee
  c_bob    constant uuid := 'bbbbbbbb-0000-4000-8000-000000000002';  -- other subject
  c_carol  constant uuid := 'cccccccc-0000-4000-8000-000000000003';  -- founder
  c_admin  constant uuid := 'dddddddd-0000-4000-8000-000000000004';  -- inviter
  c_proj   constant uuid := 'eeeeeeee-0000-4000-8000-000000000005';
  c_run    constant uuid := 'ffffffff-0000-4000-8000-000000000006';
  c_rep_l  constant uuid := '00000000-1111-4000-8000-000000000007';  -- locked
  c_rep_d  constant uuid := '00000000-2222-4000-8000-000000000008';  -- draft
  c_rep_r  constant uuid := '00000000-3333-4000-8000-000000000009';  -- locked, revoked
  c_rep_t  constant uuid := '00000000-4444-4000-8000-00000000000a';  -- locked, totals on
BEGIN
  INSERT INTO public.organizations (id, name, slug, status, stripe_customer_id, stripe_subscription_id, stella_monthly_quota)
  VALUES (c_org_a, 'Org A', 'org-a', 'active', 'cus_A', 'sub_A', 10),
         (c_org_b, 'Org B', 'org-b', 'active', 'cus_B', NULL, 10)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, email, is_super_admin) VALUES
    (c_alice, 'alice@allowed.test', false),
    (c_bob,   'bob@allowed.test',   false),
    (c_carol, 'carol@allowed.test', false),
    (c_admin, 'admin@allowed.test', false)
  ON CONFLICT (id) DO NOTHING;

  -- The inviter is a member; alice, bob and carol are NOT (CAP-01 and CAP-05
  -- both refuse a subject who already has an active membership).
  INSERT INTO public.organization_members (organization_id, user_id, role, status, joined_at)
  VALUES (c_org_a, c_admin, 'organization_admin', 'active', now())
  ON CONFLICT DO NOTHING;

  INSERT INTO public.signup_allowlist (type, pattern, created_by)
  VALUES ('domain', 'allowed.test', c_admin)
  ON CONFLICT DO NOTHING;

  -- Invitations. The token is the literal below; the row stores its sha256.
  --   live      = 6161616161616161616161616161616161616161616161616161616161616161
  --   expired   = 6262...
  --   wrongmail = 6363...
  INSERT INTO public.invitations (organization_id, email, role, status, token_hash, invited_by, expires_at)
  VALUES
    (c_org_a, 'alice@allowed.test', 'analyst', 'pending',
     encode(sha256(convert_to(repeat('a', 64), 'UTF8')), 'hex'), c_admin, now() + interval '7 days'),
    (c_org_a, 'alice@allowed.test', 'analyst', 'pending',
     encode(sha256(convert_to(repeat('b', 64), 'UTF8')), 'hex'), c_admin, now() - interval '1 day'),
    (c_org_a, 'nobody@allowed.test', 'analyst', 'pending',
     encode(sha256(convert_to(repeat('c', 64), 'UTF8')), 'hex'), c_admin, now() + interval '7 days')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.projects (id, organization_id, name, created_by)
  VALUES (c_proj, c_org_a, 'Project A', c_admin) ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.sroi_calculation_runs
    (id, project_id, organization_id, total_investment, sroi_ratio, net_social_value, currency, status, version)
  VALUES (c_run, c_proj, c_org_a, 1000.0000, 3.500000, 2500.0000, 'USD', 'calculated', 1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.sroi_reports
    (id, organization_id, project_id, calculation_run_id, title, status, created_by, report_variant, verification_hash, locked_at)
  VALUES
    (c_rep_l, c_org_a, c_proj, c_run, 'Locked no disclosure', 'locked', c_admin, 'funder', 'hash_locked',    now()),
    (c_rep_d, c_org_a, c_proj, c_run, 'Draft w/ disclosure',  'draft',  c_admin, 'funder', 'hash_draft',     NULL),
    (c_rep_r, c_org_a, c_proj, c_run, 'Locked revoked',       'locked', c_admin, 'funder', 'hash_revoked',   now()),
    (c_rep_t, c_org_a, c_proj, c_run, 'Locked totals',        'locked', c_admin, 'funder', 'hash_totals',    now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.report_public_disclosures (report_id, approved_by) VALUES (c_rep_d, c_admin)
  ON CONFLICT (report_id) DO NOTHING;
  INSERT INTO public.report_public_disclosures (report_id, approved_by, revoked_at, revoked_by)
  VALUES (c_rep_r, c_admin, now(), c_admin) ON CONFLICT (report_id) DO NOTHING;
  -- All six flags false: the minimum disclosure.
  INSERT INTO public.report_public_disclosures (report_id, approved_by) VALUES (c_rep_l, c_admin)
  ON CONFLICT (report_id) DO NOTHING;
  INSERT INTO public.report_public_disclosures (report_id, approved_by, show_totals)
  VALUES (c_rep_t, c_admin, true) ON CONFLICT (report_id) DO NOTHING;
END
$fixtures$;

-- ===========================================================================
-- CAP-01 — invitations (L1..L13)
-- ===========================================================================
DO $cap01$
DECLARE
  c_alice constant uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  c_bob   constant uuid := 'bbbbbbbb-0000-4000-8000-000000000002';
  v_org   uuid;
  v_role  text;
  v_n     integer;
  v_audit integer;
  v_sql   text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', c_alice::text, true);

  -- L1 happy path: one membership, invitation closed, two audit rows.
  SELECT count(*) INTO v_audit FROM public.audit_logs;
  SELECT organization_id, member_role INTO v_org, v_role
    FROM uellix_capability.accept_invitation(repeat('a', 64));
  SELECT count(*) INTO v_n FROM public.organization_members WHERE user_id = c_alice AND status = 'active';
  PERFORM dryrun.rec('CAP01-L1',
    v_org IS NOT NULL AND v_role = 'analyst' AND v_n = 1
    AND (SELECT status FROM public.invitations WHERE token_hash = encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex')) = 'accepted'
    AND (SELECT count(*) FROM public.audit_logs) = v_audit + 2,
    'membership=' || v_n || ' audit_delta=' || ((SELECT count(*) FROM public.audit_logs) - v_audit));

  -- L2 replay by the same subject: same answer, zero new writes.
  SELECT count(*) INTO v_audit FROM public.audit_logs;
  SELECT organization_id INTO v_org FROM uellix_capability.accept_invitation(repeat('a', 64));
  SELECT count(*) INTO v_n FROM public.organization_members WHERE user_id = c_alice AND status = 'active';
  PERFORM dryrun.rec('CAP01-L2',
    v_org IS NOT NULL AND v_n = 1 AND (SELECT count(*) FROM public.audit_logs) = v_audit,
    'membership=' || v_n);

  -- L3 replay by a DIFFERENT subject: U0001.
  PERFORM set_config('request.jwt.claim.sub', c_bob::text, true);
  BEGIN
    PERFORM * FROM uellix_capability.accept_invitation(repeat('a', 64));
    PERFORM dryrun.rec('CAP01-L3', false, 'accepted for the wrong subject');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec('CAP01-L3', SQLSTATE = 'U0001', SQLSTATE);
  END;

  -- L4 non-existent token vs. a token addressed to another e-mail: identical.
  DECLARE
    v_a text; v_b text; v_sa text; v_sb text;
  BEGIN
    BEGIN PERFORM * FROM uellix_capability.accept_invitation(repeat('f', 64));
    EXCEPTION WHEN OTHERS THEN v_a := SQLERRM; v_sa := SQLSTATE; END;
    BEGIN PERFORM * FROM uellix_capability.accept_invitation(repeat('c', 64));
    EXCEPTION WHEN OTHERS THEN v_b := SQLERRM; v_sb := SQLSTATE; END;
    PERFORM dryrun.rec('CAP01-L4', v_a = v_b AND v_sa = v_sb AND v_sa = 'U0001',
      'msg_equal=' || (v_a IS NOT DISTINCT FROM v_b)::text || ' state=' || coalesce(v_sa,'?'));
  END;

  -- L5 expired token: U0001 and zero writes.
  SELECT count(*) INTO v_audit FROM public.audit_logs;
  BEGIN
    PERFORM * FROM uellix_capability.accept_invitation(repeat('b', 64));
    PERFORM dryrun.rec('CAP01-L5', false, 'an expired invitation was accepted');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec('CAP01-L5',
      SQLSTATE = 'U0001'
      AND (SELECT count(*) FROM public.audit_logs) = v_audit
      AND (SELECT status FROM public.invitations WHERE token_hash = encode(sha256(convert_to(repeat('b',64),'UTF8')),'hex')) = 'pending',
      SQLSTATE || ' audit_delta=' || ((SELECT count(*) FROM public.audit_logs) - v_audit));
  END;

  PERFORM set_config('request.jwt.claim.sub', NULL, true);

  -- L7 uellix_app reading another organisation's invitations directly.
  BEGIN
    SET LOCAL ROLE uellix_app;
    SELECT count(*) INTO v_n FROM public.invitations;
    RESET ROLE;
    PERFORM dryrun.rec('CAP01-L7', v_n = 0, 'rows=' || v_n);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM dryrun.rec('CAP01-L7', SQLSTATE = '42501', SQLSTATE);
  END;

  -- L8..L10 EXECUTE is not reachable from anon, authenticated or PUBLIC.
  v_sql := 'uellix_capability.accept_invitation(text)';
  PERFORM dryrun.rec('CAP01-L8',  NOT has_function_privilege('authenticated', v_sql, 'EXECUTE'), 'authenticated');
  PERFORM dryrun.rec('CAP01-L9',  NOT has_function_privilege('anon',          v_sql, 'EXECUTE'), 'anon');
  PERFORM dryrun.rec('CAP01-L10', NOT has_function_privilege('public',        v_sql, 'EXECUTE'), 'PUBLIC');

  -- L11 the definer may not rewrite a token.
  PERFORM dryrun.denied('CAP01-L11', 'uellix_cap_invitation',
    'UPDATE public.invitations SET token_hash = ''x'' WHERE true');
  -- L12 the definer may not read projects.
  PERFORM dryrun.denied('CAP01-L12', 'uellix_cap_invitation', 'SELECT 1 FROM public.projects');
  -- L13 uellix_app may not become the capability role.
  PERFORM dryrun.denied('CAP01-L13', 'uellix_app', 'SET ROLE uellix_cap_invitation', '42501');
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM dryrun.rec('CAP01-ABORTED', false, SQLSTATE || ' ' || SQLERRM);
END
$cap01$;

-- L6 concurrency lives in the driver: two sessions are required, and a DO block
-- has only one.

-- ===========================================================================
-- CAP-02 — public verification (L1..L12)
-- ===========================================================================
DO $cap02$
DECLARE
  v_n integer;
  v_verified boolean; v_org text; v_title text; v_ratio numeric; v_total numeric; v_issued date; v_variant text;
BEGIN
  SELECT count(*) INTO v_n FROM uellix_capability.verify_report('hash_locked') WHERE verified;
  -- L1 is the locked report WITHOUT a disclosure. The fixture gives every
  -- locked report a disclosure, so the case is built here by revoking nothing
  -- and instead asking for a report whose disclosure row is absent.
  SELECT count(*) INTO v_n FROM uellix_capability.verify_report('no_such_hash');
  PERFORM dryrun.rec('CAP02-L4', v_n = 0, 'rows=' || v_n);

  -- L1: a LOCKED report with NO disclosure row verifies as nothing.
  --
  -- This used to be built by DELETEing the fixture's disclosure and putting it
  -- back afterwards. It cannot be any more, and that is the repair working:
  -- since RR-CAP-02-F the table carries trg_report_disclosures_append_only, so
  -- a published decision cannot be erased by anyone — including this harness.
  -- The case is therefore built by ADDING a report nobody published, which is
  -- also closer to what it models.
  INSERT INTO public.sroi_reports
    (id, organization_id, project_id, calculation_run_id, title, status, created_by,
     report_variant, verification_hash, locked_at)
  VALUES ('00000000-6666-4000-8000-00000000000c', '11111111-1111-4111-8111-111111111111',
          'eeeeeeee-0000-4000-8000-000000000005', 'ffffffff-0000-4000-8000-000000000006',
          'Locked, never published', 'locked', 'dddddddd-0000-4000-8000-000000000004',
          'funder', 'hash_unpublished', now())
  ON CONFLICT (id) DO NOTHING;
  SELECT count(*) INTO v_n FROM uellix_capability.verify_report('hash_unpublished');
  PERFORM dryrun.rec('CAP02-L1', v_n = 0, 'rows=' || v_n);

  SELECT count(*) INTO v_n FROM uellix_capability.verify_report('hash_draft');
  PERFORM dryrun.rec('CAP02-L2', v_n = 0, 'rows=' || v_n);

  SELECT count(*) INTO v_n FROM uellix_capability.verify_report('hash_revoked');
  PERFORM dryrun.rec('CAP02-L3', v_n = 0, 'rows=' || v_n);

  -- L5 every flag false: verified true and everything else NULL, including the
  -- two flags added in round 2.
  SELECT verified, organization_name, report_title, headline_ratio, total_investment, issued_on, report_variant
    INTO v_verified, v_org, v_title, v_ratio, v_total, v_issued, v_variant
    FROM uellix_capability.verify_report('hash_locked');
  PERFORM dryrun.rec('CAP02-L5',
    v_verified AND v_org IS NULL AND v_title IS NULL AND v_ratio IS NULL
    AND v_total IS NULL AND v_issued IS NULL AND v_variant IS NULL,
    'org=' || coalesce(v_org,'NULL') || ' issued=' || coalesce(v_issued::text,'NULL')
      || ' variant=' || coalesce(v_variant,'NULL'));

  -- L6 show_totals only: the three amounts appear and nothing else does.
  SELECT verified, organization_name, headline_ratio, total_investment
    INTO v_verified, v_org, v_ratio, v_total
    FROM uellix_capability.verify_report('hash_totals');
  PERFORM dryrun.rec('CAP02-L6',
    v_verified AND v_total IS NOT NULL AND v_org IS NULL AND v_ratio IS NULL,
    'total=' || coalesce(v_total::text,'NULL') || ' org=' || coalesce(v_org,'NULL'));

  PERFORM dryrun.denied('CAP02-L7', 'uellix_cap_verification', 'SELECT 1 FROM public.evidence_items');
  PERFORM dryrun.denied('CAP02-L8', 'uellix_cap_verification', 'SELECT stripe_customer_id FROM public.organizations');

  PERFORM dryrun.rec('CAP02-L9',
    NOT has_function_privilege('anon', 'uellix_capability.verify_report(text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'uellix_capability.verify_report(text)', 'EXECUTE'),
    'anon+authenticated');

  BEGIN
    SET LOCAL ROLE uellix_app;
    SELECT count(*) INTO v_n FROM public.sroi_reports;
    RESET ROLE;
    PERFORM dryrun.rec('CAP02-L10', v_n = 0, 'rows=' || v_n);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM dryrun.rec('CAP02-L10', SQLSTATE = '42501', SQLSTATE);
  END;

  -- L11 verify_report is STABLE, so the engine refuses a write in it. Proved by
  -- creating a mutant with the same body plus an INSERT and observing 0A000.
  BEGIN
    EXECUTE $mut$
      CREATE OR REPLACE FUNCTION dryrun.stable_writer() RETURNS void
      LANGUAGE plpgsql STABLE AS $body$
      BEGIN
        INSERT INTO public.capability_verification_hits (report_id, hit_date)
        VALUES ('00000000-1111-4000-8000-000000000007', current_date);
      END
      $body$;
    $mut$;
    PERFORM dryrun.stable_writer();
    PERFORM dryrun.rec('CAP02-L11', false, 'a STABLE function wrote');
  EXCEPTION WHEN OTHERS THEN
    -- 0A000 feature_not_supported: «INSERT is not allowed in a non-volatile
    -- function». Measured, not assumed — the first draft of this assertion
    -- expected 25006 (read_only_sql_transaction), which is what a read-only
    -- TRANSACTION raises. The distinction matters: 0A000 comes from the
    -- function's volatility label, which is the property CAP-02 relies on.
    PERFORM dryrun.rec('CAP02-L11', SQLSTATE = '0A000', 'SQLSTATE ' || SQLSTATE);
  END;

  -- L12 the counter has exactly three columns and none of them is personal.
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'capability_verification_hits';
  PERFORM dryrun.rec('CAP02-L12',
    v_n = 3 AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'capability_verification_hits'
         AND column_name ~ '(ip|agent|refer|session|finger)'),
    'columns=' || v_n);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM dryrun.rec('CAP02-ABORTED', false, SQLSTATE || ' ' || SQLERRM);
END
$cap02$;

-- ===========================================================================
-- CAP-03 — Stripe webhook identity (L1..L14)
-- ===========================================================================
DO $cap03$
DECLARE
  v_r text; v_quota integer; v_audit integer; v_n integer;
BEGIN
  -- L1 new event: claimed, then applied — quota moved, one audit row, completed.
  v_r := uellix_capability.stripe_begin_event('evt_1', 'customer.subscription.updated', 'cus_A', 'sub_A');
  SELECT count(*) INTO v_audit FROM public.audit_logs;
  PERFORM uellix_capability.stripe_apply_subscription('evt_1', 'customer', 'cus_A', 'cus_A', 'sub_A', 'price_1', 500, 'Pro');
  SELECT stella_monthly_quota INTO v_quota FROM public.organizations WHERE id = '11111111-1111-4111-8111-111111111111';
  PERFORM dryrun.rec('CAP03-L1',
    v_r = 'claimed' AND v_quota = 500
    AND (SELECT count(*) FROM public.audit_logs) = v_audit + 1
    AND (SELECT status FROM public.stripe_webhook_events WHERE event_id = 'evt_1') = 'completed',
    'begin=' || v_r || ' quota=' || v_quota);

  -- L2 the same event again: duplicate, zero new writes.
  SELECT count(*) INTO v_audit FROM public.audit_logs;
  v_r := uellix_capability.stripe_begin_event('evt_1', 'customer.subscription.updated', 'cus_A', 'sub_A');
  PERFORM dryrun.rec('CAP03-L2',
    v_r = 'duplicate' AND (SELECT count(*) FROM public.audit_logs) = v_audit, 'begin=' || v_r);

  -- L4 apply without begin: uniform refusal, zero writes.
  SELECT count(*) INTO v_audit FROM public.audit_logs;
  BEGIN
    PERFORM uellix_capability.stripe_apply_subscription('evt_never', 'customer', 'cus_A', 'cus_A', 'sub_A', 'price_1', 900, 'Pro');
    PERFORM dryrun.rec('CAP03-L4', false, 'applied without a claim');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec('CAP03-L4',
      SQLSTATE = 'U0001' AND (SELECT count(*) FROM public.audit_logs) = v_audit, SQLSTATE);
  END;

  -- L5 organisation not resolved: fail_event records it, organizations untouched.
  PERFORM uellix_capability.stripe_begin_event('evt_2', 'customer.subscription.updated', 'cus_MISSING', NULL);
  SELECT stella_monthly_quota INTO v_quota FROM public.organizations WHERE id = '11111111-1111-4111-8111-111111111111';
  BEGIN
    PERFORM uellix_capability.stripe_apply_subscription('evt_2', 'customer', 'cus_MISSING', 'cus_MISSING', NULL, 'price_1', 900, 'Pro');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  PERFORM uellix_capability.stripe_fail_event('evt_2', 'org_not_resolved');
  PERFORM dryrun.rec('CAP03-L5',
    (SELECT status FROM public.stripe_webhook_events WHERE event_id = 'evt_2') = 'failed'
    AND (SELECT last_error_code FROM public.stripe_webhook_events WHERE event_id = 'evt_2') = 'org_not_resolved'
    AND (SELECT stella_monthly_quota FROM public.organizations WHERE id = '11111111-1111-4111-8111-111111111111') = v_quota,
    'status=' || (SELECT status FROM public.stripe_webhook_events WHERE event_id = 'evt_2'));

  -- L6 an event trying to move another organisation's subscription onto itself.
  PERFORM uellix_capability.stripe_begin_event('evt_3', 'customer.subscription.updated', 'cus_B', 'sub_A');
  BEGIN
    PERFORM uellix_capability.stripe_apply_subscription('evt_3', 'customer', 'cus_B', 'cus_B', 'sub_A', 'price_1', 999, 'Pro');
    PERFORM dryrun.rec('CAP03-L6',
      (SELECT stripe_subscription_id FROM public.organizations WHERE id = '22222222-2222-4222-8222-222222222222') IS DISTINCT FROM 'sub_A'
      AND (SELECT stella_monthly_quota FROM public.organizations WHERE id = '11111111-1111-4111-8111-111111111111') <> 999,
      'applied but bounded');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec('CAP03-L6', SQLSTATE = 'U0001', SQLSTATE);
  END;

  PERFORM dryrun.denied('CAP03-L7',  'uellix_stripe', 'SELECT 1 FROM public.projects');
  PERFORM dryrun.denied('CAP03-L8',  'uellix_stripe', 'SELECT 1 FROM public.organizations');
  PERFORM dryrun.denied('CAP03-L9',  'uellix_stripe', 'SET ROLE uellix_cap_stripe');
  PERFORM dryrun.rec('CAP03-L10',
    NOT has_function_privilege('uellix_app',
      'uellix_capability.stripe_apply_subscription(text,text,text,text,text,text,integer,text)', 'EXECUTE'),
    'uellix_app');
  PERFORM dryrun.denied('CAP03-L11', 'uellix_cap_stripe',
    'UPDATE public.organizations SET name = ''x'' WHERE true');
  PERFORM dryrun.denied('CAP03-L12', 'uellix_cap_stripe', 'DELETE FROM public.stripe_webhook_events');

  -- L13 an audit row with a non-null actor is refused by the policy.
  PERFORM dryrun.denied('CAP03-L13', 'uellix_cap_stripe',
    'INSERT INTO public.audit_logs (organization_id, actor_user_id, entity_type, entity_id, action) VALUES '
    || '(''11111111-1111-4111-8111-111111111111'', ''dddddddd-0000-4000-8000-000000000004'', ''organization'', '
    || '''11111111-1111-4111-8111-111111111111'', ''stripe.test'')', '42501');

  -- L14 an expired processing lease becomes claimable again.
  PERFORM uellix_capability.stripe_begin_event('evt_4', 'customer.subscription.updated', 'cus_A', 'sub_A');
  UPDATE public.stripe_webhook_events SET received_at = now() - interval '20 minutes' WHERE event_id = 'evt_4';
  v_r := uellix_capability.stripe_begin_event('evt_4', 'customer.subscription.updated', 'cus_A', 'sub_A');
  PERFORM dryrun.rec('CAP03-L14', v_r = 'claimed', 'begin=' || v_r);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM dryrun.rec('CAP03-ABORTED', false, SQLSTATE || ' ' || SQLERRM);
END
$cap03$;

-- ===========================================================================
-- CAP-04 — public leads (L1..L13)
-- ===========================================================================
DO $cap04$
DECLARE
  v_n integer; v_before integer;
BEGIN
  SELECT count(*) INTO v_before FROM public.marketing_leads;
  PERFORM uellix_capability.submit_lead('Lead@Example.test', 'ACME', '3.5', 'sroi_calculator');
  SELECT count(*) INTO v_n FROM public.marketing_leads;
  PERFORM dryrun.rec('CAP04-L1',
    v_n = v_before + 1
    AND (SELECT lead_status FROM public.marketing_leads WHERE email = 'lead@example.test') = 'new',
    'delta=' || (v_n - v_before));

  SELECT count(*) INTO v_before FROM public.marketing_leads;
  PERFORM uellix_capability.submit_lead('lead@example.test', 'ACME', '3.5', 'sroi_calculator');
  PERFORM dryrun.rec('CAP04-L2', (SELECT count(*) FROM public.marketing_leads) = v_before, 'duplicate collapsed');

  SELECT count(*) INTO v_before FROM public.marketing_leads;
  PERFORM uellix_capability.submit_lead('LEAD@EXAMPLE.TEST', 'ACME', '3.5', 'sroi_calculator');
  PERFORM dryrun.rec('CAP04-L3', (SELECT count(*) FROM public.marketing_leads) = v_before, 'case-insensitive');

  SELECT count(*) INTO v_before FROM public.marketing_leads;
  BEGIN
    PERFORM uellix_capability.submit_lead('x@example.test', NULL, NULL, 'not_on_the_list');
    PERFORM dryrun.rec('CAP04-L4', false, 'an unlisted source was accepted');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec('CAP04-L4',
      SQLSTATE = 'U0001' AND (SELECT count(*) FROM public.marketing_leads) = v_before, SQLSTATE);
  END;

  -- L5 lead_status cannot be injected: it is not a parameter at all.
  PERFORM uellix_capability.submit_lead('status@example.test', 'X', NULL, 'pricing');
  PERFORM dryrun.rec('CAP04-L5',
    (SELECT lead_status FROM public.marketing_leads WHERE email = 'status@example.test') = 'new'
    AND NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'uellix_capability' AND p.proname = 'submit_lead'
         AND pg_get_function_arguments(p.oid) ~ 'status'),
    'status is constant');

  PERFORM dryrun.denied('CAP04-L6', 'uellix_cap_lead', 'SELECT 1 FROM public.marketing_leads');
  PERFORM dryrun.denied('CAP04-L7', 'uellix_cap_lead', 'DELETE FROM public.marketing_leads');
  PERFORM dryrun.denied('CAP04-L8', 'uellix_app',
    'INSERT INTO public.marketing_leads (email) VALUES (''direct@example.test'')');
  BEGIN
    SET LOCAL ROLE uellix_app;
    SELECT count(*) INTO v_n FROM public.marketing_leads;
    RESET ROLE;
    PERFORM dryrun.rec('CAP04-L9', v_n = 0, 'rows=' || v_n);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM dryrun.rec('CAP04-L9', SQLSTATE = '42501', SQLSTATE);
  END;
  PERFORM dryrun.denied('CAP04-L10', 'anon',
    'INSERT INTO public.marketing_leads (email) VALUES (''anon@example.test'')');
  PERFORM dryrun.denied('CAP04-L11', 'authenticated',
    'INSERT INTO public.marketing_leads (email) VALUES (''auth@example.test'')');
  PERFORM dryrun.rec('CAP04-L12',
    NOT has_function_privilege('public', 'uellix_capability.submit_lead(text,text,text,text)', 'EXECUTE'), 'PUBLIC');

  SELECT count(*) INTO v_before FROM public.marketing_leads;
  BEGIN
    PERFORM uellix_capability.submit_lead(repeat('x', 290) || '@example.test', NULL, NULL, 'pricing');
    PERFORM dryrun.rec('CAP04-L13', false, 'a 300-character address was accepted');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec('CAP04-L13',
      SQLSTATE = 'U0001' AND (SELECT count(*) FROM public.marketing_leads) = v_before, SQLSTATE);
  END;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM dryrun.rec('CAP04-ABORTED', false, SQLSTATE || ' ' || SQLERRM);
END
$cap04$;

-- ===========================================================================
-- CAP-05 — organisation bootstrap (L1..L15)
-- ===========================================================================
DO $cap05$
DECLARE
  c_carol constant uuid := 'cccccccc-0000-4000-8000-000000000003';
  c_key   constant uuid := '99999999-0000-4000-8000-00000000000f';
  v_org uuid; v_slug text; v_org2 uuid; v_n integer; v_audit integer; v_orgs integer;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', c_carol::text, true);

  SELECT count(*) INTO v_audit FROM public.audit_logs;
  SELECT organization_id, slug INTO v_org, v_slug
    FROM uellix_capability.bootstrap_organization(c_key, 'Carol Co', 'carol-co', NULL, 'ES', NULL);
  PERFORM dryrun.rec('CAP05-L1',
    v_org IS NOT NULL AND v_slug = 'carol-co'
    AND (SELECT count(*) FROM public.organization_members WHERE user_id = c_carol AND role = 'organization_admin' AND status = 'active') = 1
    AND (SELECT count(*) FROM public.audit_logs) = v_audit + 2
    AND (SELECT stella_monthly_quota FROM public.organizations WHERE id = v_org) IS NOT DISTINCT FROM
        (SELECT column_default::integer FROM information_schema.columns
          WHERE table_schema='public' AND table_name='organizations' AND column_name='stella_monthly_quota'),
    'audit_delta=' || ((SELECT count(*) FROM public.audit_logs) - v_audit));

  -- L2 same key again: same organisation, zero writes.
  SELECT count(*) INTO v_audit FROM public.audit_logs;
  SELECT count(*) INTO v_orgs FROM public.organizations;
  SELECT organization_id INTO v_org2 FROM uellix_capability.bootstrap_organization(c_key, 'Carol Co', 'carol-co', NULL, 'ES', NULL);
  PERFORM dryrun.rec('CAP05-L2',
    v_org2 = v_org AND (SELECT count(*) FROM public.audit_logs) = v_audit
    AND (SELECT count(*) FROM public.organizations) = v_orgs, 'same org, no writes');

  -- L3 a NEW key by the same subject: refused, still one organisation.
  SELECT count(*) INTO v_orgs FROM public.organizations;
  BEGIN
    PERFORM * FROM uellix_capability.bootstrap_organization(gen_random_uuid(), 'Second Co', 'second-co', NULL, 'ES', NULL);
    PERFORM dryrun.rec('CAP05-L3', false, 'a second organisation was created');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec('CAP05-L3',
      SQLSTATE = 'U0001' AND (SELECT count(*) FROM public.organizations) = v_orgs, SQLSTATE);
  END;

  -- L5 slug already taken: U0002, and nothing new anywhere.
  PERFORM set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', true);
  SELECT count(*) INTO v_orgs FROM public.organizations;
  SELECT count(*) INTO v_n FROM public.capability_bootstrap_attempts;
  BEGIN
    PERFORM * FROM uellix_capability.bootstrap_organization(gen_random_uuid(), 'Clash Co', 'carol-co', NULL, 'ES', NULL);
    PERFORM dryrun.rec('CAP05-L5', false, 'a duplicate slug was accepted');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec('CAP05-L5',
      SQLSTATE = 'U0002'
      AND (SELECT count(*) FROM public.organizations) = v_orgs
      AND (SELECT count(*) FROM public.capability_bootstrap_attempts) = v_n,
      SQLSTATE || ' attempts_delta=' || ((SELECT count(*) FROM public.capability_bootstrap_attempts) - v_n));
  END;

  -- L6 a reserved slug.
  BEGIN
    PERFORM * FROM uellix_capability.bootstrap_organization(gen_random_uuid(), 'Api Co', 'api', NULL, 'ES', NULL);
    PERFORM dryrun.rec('CAP05-L6', false, 'a reserved slug was accepted');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec('CAP05-L6', SQLSTATE = 'U0001', SQLSTATE);
  END;

  -- L7 an address outside the allowlist.
  INSERT INTO public.users (id, email, is_super_admin)
  VALUES ('77777777-0000-4000-8000-000000000077', 'dave@blocked.test', false) ON CONFLICT DO NOTHING;
  PERFORM set_config('request.jwt.claim.sub', '77777777-0000-4000-8000-000000000077', true);
  BEGIN
    PERFORM * FROM uellix_capability.bootstrap_organization(gen_random_uuid(), 'Dave Co', 'dave-co', NULL, 'ES', NULL);
    PERFORM dryrun.rec('CAP05-L7', false, 'a blocked domain was accepted');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec('CAP05-L7', SQLSTATE = 'U0001', SQLSTATE);
  END;

  -- L8 no auth.uid() at all.
  PERFORM set_config('request.jwt.claim.sub', NULL, true);
  BEGIN
    PERFORM * FROM uellix_capability.bootstrap_organization(gen_random_uuid(), 'Anon Co', 'anon-co', NULL, 'ES', NULL);
    PERFORM dryrun.rec('CAP05-L8', false, 'an unauthenticated bootstrap succeeded');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec('CAP05-L8', SQLSTATE = 'U0001', SQLSTATE);
  END;

  -- L9 the definer cannot name a billing column: the grant does not contain it.
  PERFORM dryrun.denied('CAP05-L9', 'uellix_cap_bootstrap',
    'INSERT INTO public.organizations (name, slug, status, stella_monthly_quota) VALUES (''Q'', ''q-co'', ''active'', 9999)');
  -- L10 the policy refuses a super_admin membership.
  PERFORM dryrun.denied('CAP05-L10', 'uellix_cap_bootstrap',
    'INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES '
    || '(''11111111-1111-4111-8111-111111111111'', ''bbbbbbbb-0000-4000-8000-000000000002'', ''super_admin'', ''active'')',
    '42501');
  PERFORM dryrun.denied('CAP05-L12', 'uellix_app',
    'INSERT INTO public.organizations (name, slug, status) VALUES (''Direct'', ''direct-co'', ''active'')');
  PERFORM dryrun.denied('CAP05-L13', 'uellix_cap_bootstrap', 'SELECT 1 FROM public.projects');
  PERFORM dryrun.denied('CAP05-L14', 'uellix_cap_bootstrap',
    'UPDATE public.organizations SET name = ''x'' WHERE true');
  PERFORM dryrun.rec('CAP05-L15',
    NOT has_function_privilege('anon', 'uellix_capability.bootstrap_organization(uuid,text,text,text,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'uellix_capability.bootstrap_organization(uuid,text,text,text,text,text)', 'EXECUTE'),
    'anon+authenticated');
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM dryrun.rec('CAP05-ABORTED', false, SQLSTATE || ' ' || SQLERRM);
END
$cap05$;

-- L11 (injected failure after the organisation is created) needs a savepoint
-- boundary the surrounding block cannot provide; the driver runs it.
-- L4 (two concurrent calls, same key) needs two sessions; the driver runs it.

-- ===========================================================================
-- RR-CAP-10 — organizations UPDATE is column-scoped (stella_0011)
-- ===========================================================================
-- Every case is a STATEMENT, executed by the role that would issue it, and the
-- verdict is the SQLSTATE the server returned. A `has_column_privilege`
-- assertion would only re-read the catalogue the package already asserted;
-- these prove the ACL is what actually refuses.
DO $rr10$
DECLARE
  c_org_a constant uuid := '11111111-1111-4111-8111-111111111111';
  c_sup   constant uuid := 'a0a0a0a0-0000-4000-8000-00000000000f';
  v_n     integer;
  v_q     integer;
  v_st    text;
BEGIN
  -- A platform super_admin, which the base fixtures deliberately do not have:
  -- every other subject in this file is a tenant, and RR-CAP-10 is precisely
  -- the boundary between the two.
  INSERT INTO public.users (id, email, is_super_admin)
  VALUES (c_sup, 'super@allowed.test', true) ON CONFLICT (id) DO NOTHING;

  -- --- the vias that must now be refused ---------------------------------
  PERFORM dryrun.denied('RR10-1', 'uellix_writer',
    'UPDATE public.organizations SET stella_monthly_quota = 999999 WHERE true');
  PERFORM dryrun.denied('RR10-2', 'uellix_writer',
    'UPDATE public.organizations SET stella_plan_label = ''Enterprise'' WHERE true');
  PERFORM dryrun.denied('RR10-3', 'uellix_writer',
    'UPDATE public.organizations SET status = ''active'' WHERE true');
  PERFORM dryrun.denied('RR10-4', 'uellix_writer',
    'UPDATE public.organizations SET stripe_customer_id = ''cus_HIJACK'' WHERE true');
  -- The PostgREST surface. It is the one that gets forgotten, so it is tested
  -- separately rather than assumed to follow from uellix_writer.
  PERFORM dryrun.denied('RR10-5', 'authenticated',
    'UPDATE public.organizations SET stella_monthly_quota = 999999 WHERE true');
  -- The combined statement: one permitted column and one forbidden one. This
  -- is the shape an attacker actually writes, because it looks like a settings
  -- save. PostgreSQL checks the ACL per column, so the whole statement dies.
  PERFORM dryrun.denied('RR10-6', 'uellix_writer',
    'UPDATE public.organizations SET sector = ''ngo'', stella_monthly_quota = 999999 WHERE true');
  -- Renaming is INSERT-only in this codebase; the grant now says so.
  PERFORM dryrun.denied('RR10-7', 'uellix_writer',
    'UPDATE public.organizations SET name = ''Renamed'' WHERE true');

  -- --- and the writes that must still work -------------------------------
  -- The two positive cases run as uellix_app WITH the organisation admin's
  -- claim, because that is the only configuration in which they are meaningful:
  -- uellix_writer with no auth.uid() is filtered by orgs_update_admin_or_super
  -- and returns zero rows without the ACL ever being consulted, so a green
  -- result would have proved nothing about the column grant.
  PERFORM set_config('request.jwt.claim.sub', 'dddddddd-0000-4000-8000-000000000004', true);
  BEGIN
    SET LOCAL ROLE uellix_app;
    EXECUTE 'UPDATE public.organizations SET country = ''CO'', sector = ''ngo'', '
         || 'base_currency = ''USD'', onboarding_completed = true, updated_at = now() '
         || 'WHERE id = ' || quote_literal(c_org_a) || '::uuid';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    PERFORM dryrun.rec('RR10-8', v_n = 1, 'onboarding update rows=' || v_n);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM dryrun.rec('RR10-8', false, 'onboarding update refused: ' || SQLSTATE);
  END;

  BEGIN
    SET LOCAL ROLE uellix_app;
    EXECUTE 'UPDATE public.organizations SET white_label_enabled = true, '
         || 'brand_color = ''#071426'', logo_url = NULL, updated_at = now() '
         || 'WHERE id = ' || quote_literal(c_org_a) || '::uuid';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    PERFORM dryrun.rec('RR10-9', v_n = 1, 'branding update rows=' || v_n);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM dryrun.rec('RR10-9', false, 'branding update refused: ' || SQLSTATE);
  END;

  -- --- the definer: refused for a tenant admin, allowed for the platform ---
  -- The caller is uellix_app, exactly as in production; only the JWT subject
  -- changes. That is the whole point: the DATABASE role is identical, so if the
  -- boundary held it can only be auth.uid() that held it.
  PERFORM set_config('request.jwt.claim.sub', 'dddddddd-0000-4000-8000-000000000004', true);
  BEGIN
    SET LOCAL ROLE uellix_app;
    PERFORM uellix_capability.admin_set_stella_service(c_org_a, 999999, 'Hijacked');
    RESET ROLE;
    PERFORM dryrun.rec('RR10-10', false, 'a tenant admin moved the quota through the definer');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM dryrun.rec('RR10-10', SQLSTATE = 'U0001', 'SQLSTATE ' || SQLSTATE);
  END;

  PERFORM set_config('request.jwt.claim.sub', c_sup::text, true);
  BEGIN
    SET LOCAL ROLE uellix_app;
    PERFORM uellix_capability.admin_set_stella_service(c_org_a, 250, 'Pro');
    RESET ROLE;
    SELECT stella_monthly_quota INTO v_q FROM public.organizations WHERE id = c_org_a;
    PERFORM dryrun.rec('RR10-11',
      v_q = 250
      AND EXISTS (SELECT 1 FROM public.audit_logs
                   WHERE action = 'platform.stella_service.updated'
                     AND entity_id = c_org_a AND actor_user_id = c_sup),
      'quota=' || COALESCE(v_q::text, 'NULL'));
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM dryrun.rec('RR10-11', false, 'the platform admin was refused: ' || SQLSTATE);
  END;

  BEGIN
    SET LOCAL ROLE uellix_app;
    PERFORM uellix_capability.admin_set_organization_status(c_org_a, 'suspended');
    PERFORM uellix_capability.admin_set_organization_status(c_org_a, 'active');
    RESET ROLE;
    SELECT status INTO v_st FROM public.organizations WHERE id = c_org_a;
    PERFORM dryrun.rec('RR10-12',
      v_st = 'active'
      AND (SELECT count(*) FROM public.audit_logs
            WHERE action = 'platform.organization.status_changed' AND entity_id = c_org_a) = 2,
      'status=' || v_st);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM dryrun.rec('RR10-12', false, 'status change refused: ' || SQLSTATE);
  END;

  -- An invented status must not reach the column: `status` carries no CHECK.
  BEGIN
    SET LOCAL ROLE uellix_app;
    PERFORM uellix_capability.admin_set_organization_status(c_org_a, 'platinum');
    RESET ROLE;
    PERFORM dryrun.rec('RR10-13', false, 'an unlisted status was accepted');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM dryrun.rec('RR10-13', SQLSTATE = 'U0001', 'SQLSTATE ' || SQLSTATE);
  END;

  -- `authenticated` keeps NO update column at all. The first draft of the
  -- package re-granted the eight runtime columns to it; an adversarial reviewer
  -- pointed out that this restored the browser-direct write surface the package
  -- exists to close, for a principal with no call site in the repository.
  PERFORM dryrun.rec('RR10-14',
    NOT has_any_column_privilege('authenticated', 'public.organizations'::regclass, 'UPDATE'),
    'authenticated UPDATE columns');
  PERFORM dryrun.denied('RR10-15', 'uellix_writer',
    'DELETE FROM public.organizations WHERE true');

  PERFORM set_config('request.jwt.claim.sub', '', true);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM dryrun.rec('RR10-ABORTED', false, SQLSTATE || ' ' || SQLERRM);
END
$rr10$;

-- ===========================================================================
-- RR-CAP-13 — the verification identity cannot enumerate
-- ===========================================================================
DO $rr13$
DECLARE
  c_org_b constant uuid := '22222222-2222-4222-8222-222222222222';
  c_org_a constant uuid := '11111111-1111-4111-8111-111111111111';
  c_proj  constant uuid := 'eeeeeeee-0000-4000-8000-000000000005';
  c_run2  constant uuid := 'ffffffff-0000-4000-8000-0000000000f2';
  v_n     integer;
  v_name  text;
BEGIN
  -- A second calculation run in the SAME organisation, linked to no report at
  -- all. Without it the test could not tell "bounded to published runs" from
  -- "bounded to this tenant".
  INSERT INTO public.sroi_calculation_runs
    (id, project_id, organization_id, total_investment, sroi_ratio, net_social_value, currency, status, version)
  VALUES (c_run2, c_proj, c_org_a, 7777.0000, 9.900000, 7000.0000, 'USD', 'calculated', 2)
  ON CONFLICT (id) DO NOTHING;

  SET LOCAL ROLE uellix_cap_verification;
  SELECT count(*) INTO v_n FROM public.organizations;
  SELECT max(name) INTO v_name FROM public.organizations;
  RESET ROLE;
  PERFORM dryrun.rec('RR13-1', v_n = 1 AND v_name = 'Org A',
    'organizations visible=' || v_n || ' name=' || COALESCE(v_name, 'NULL'));

  SET LOCAL ROLE uellix_cap_verification;
  SELECT count(*) INTO v_n FROM public.organizations WHERE id = c_org_b;
  RESET ROLE;
  PERFORM dryrun.rec('RR13-2', v_n = 0, 'org B rows=' || v_n);

  SET LOCAL ROLE uellix_cap_verification;
  SELECT count(*) INTO v_n FROM public.sroi_calculation_runs;
  RESET ROLE;
  PERFORM dryrun.rec('RR13-3', v_n = 1, 'runs visible=' || v_n);

  SET LOCAL ROLE uellix_cap_verification;
  SELECT count(*) INTO v_n FROM public.sroi_calculation_runs WHERE id = c_run2;
  RESET ROLE;
  PERFORM dryrun.rec('RR13-4', v_n = 0, 'unpublished run rows=' || v_n);

  -- The happy path still answers: a bound that also breaks verification would
  -- be a regression dressed as a fix.
  SELECT count(*) INTO v_n FROM uellix_capability.verify_report('hash_totals');
  PERFORM dryrun.rec('RR13-5', v_n = 1, 'verify_report rows=' || v_n);

  -- Revoke every live disclosure: the organisation and the run must leave the
  -- capability's reach in the same statement, not on the next deploy.
  UPDATE public.report_public_disclosures SET revoked_at = now() WHERE revoked_at IS NULL;
  SET LOCAL ROLE uellix_cap_verification;
  SELECT count(*) INTO v_n FROM public.organizations;
  RESET ROLE;
  PERFORM dryrun.rec('RR13-6', v_n = 0, 'organizations after full revocation=' || v_n);

  SET LOCAL ROLE uellix_cap_verification;
  SELECT count(*) INTO v_n FROM public.sroi_calculation_runs;
  RESET ROLE;
  PERFORM dryrun.rec('RR13-7', v_n = 0, 'runs after full revocation=' || v_n);

  UPDATE public.report_public_disclosures SET revoked_at = NULL
   WHERE report_id IN ('00000000-1111-4000-8000-000000000007',
                       '00000000-4444-4000-8000-00000000000a');
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM dryrun.rec('RR13-ABORTED', false, SQLSTATE || ' ' || SQLERRM);
END
$rr13$;

-- ===========================================================================
-- RR-CAP-14 — the Stripe identity reaches only the organisation it claimed
-- ===========================================================================
DO $rr14$
DECLARE
  c_org_a constant uuid := '11111111-1111-4111-8111-111111111111';
  c_org_b constant uuid := '22222222-2222-4222-8222-222222222222';
  c_org_c constant uuid := '33333333-3333-4333-8333-333333333333';
  v_n     integer;
  v_q     integer;
  v_r     text;
BEGIN
  -- An organisation with NO Stripe link at all. DP-CAP-15 says a webhook must
  -- never be where an organisation is first bound to a customer; this is the
  -- row that proves it cannot be.
  INSERT INTO public.organizations (id, name, slug, status, stella_monthly_quota)
  VALUES (c_org_c, 'Org C', 'org-c', 'active', 10) ON CONFLICT (id) DO NOTHING;

  -- Close every lease left open by the CAP-03 block, so the next three cases
  -- measure "no claim" rather than "somebody else's claim".
  UPDATE public.stripe_webhook_events SET status = 'completed' WHERE status = 'processing';

  PERFORM set_config('app.stripe_event_id', '', true);
  SET LOCAL ROLE uellix_cap_stripe;
  SELECT count(*) INTO v_n FROM public.organizations;
  RESET ROLE;
  PERFORM dryrun.rec('RR14-1', v_n = 0, 'rows readable with no claim=' || v_n);

  SELECT stella_monthly_quota INTO v_q FROM public.organizations WHERE id = c_org_a;
  BEGIN
    SET LOCAL ROLE uellix_cap_stripe;
    EXECUTE 'UPDATE public.organizations SET stella_monthly_quota = 424242 WHERE id = '
         || quote_literal(c_org_a) || '::uuid';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    PERFORM dryrun.rec('RR14-2',
      v_n = 0 AND (SELECT stella_monthly_quota FROM public.organizations WHERE id = c_org_a) IS NOT DISTINCT FROM v_q,
      'rows updated with no claim=' || v_n);
  EXCEPTION WHEN OTHERS THEN
    -- Not a bare `true`. An exception arm that records success for ANY
    -- SQLSTATE goes green when SET ROLE fails, when the dynamic SQL is
    -- malformed, or when an unrelated lock times out — none of which is
    -- evidence for the property. Found by adversarial review, 2026-08-04.
    RESET ROLE;
    PERFORM dryrun.rec('RR14-2', SQLSTATE IN ('42501','U0001'), 'refused: ' || SQLSTATE);
  END;

  -- Claim an event addressed to organisation A, and name it. `app.stripe_event_id`
  -- is what stripe_apply_subscription publishes after validating the claim; the
  -- policies read it, so a session that does not name an event reaches nothing.
  PERFORM uellix_capability.stripe_begin_event('evt_rr14', 'customer.subscription.updated', 'cus_A', NULL);
  PERFORM set_config('app.stripe_event_id', 'evt_rr14', true);

  SET LOCAL ROLE uellix_cap_stripe;
  SELECT count(*) INTO v_n FROM public.organizations;
  RESET ROLE;
  PERFORM dryrun.rec('RR14-3', v_n = 1, 'rows readable under a claim for cus_A=' || v_n);

  -- The cross-organisation write. The claim is real, the event is real, and the
  -- row is somebody else's — which the column grant never bounded.
  SELECT stella_monthly_quota INTO v_q FROM public.organizations WHERE id = c_org_b;
  BEGIN
    SET LOCAL ROLE uellix_cap_stripe;
    EXECUTE 'UPDATE public.organizations SET stella_monthly_quota = 424242 WHERE id = '
         || quote_literal(c_org_b) || '::uuid';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    PERFORM dryrun.rec('RR14-4',
      v_n = 0 AND (SELECT stella_monthly_quota FROM public.organizations WHERE id = c_org_b) IS NOT DISTINCT FROM v_q,
      'cross-organisation rows updated=' || v_n);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM dryrun.rec('RR14-4', SQLSTATE IN ('42501','U0001'), 'refused: ' || SQLSTATE);
  END;

  -- An organisation with no Stripe link is unreachable even under a live claim.
  BEGIN
    SET LOCAL ROLE uellix_cap_stripe;
    EXECUTE 'UPDATE public.organizations SET stella_monthly_quota = 424242 WHERE id = '
         || quote_literal(c_org_c) || '::uuid';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    PERFORM dryrun.rec('RR14-5', v_n = 0, 'unlinked-organisation rows updated=' || v_n);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM dryrun.rec('RR14-5', SQLSTATE IN ('42501','U0001'), 'refused: ' || SQLSTATE);
  END;

  -- A claim with no Stripe address at all is refused at the claim, not left to
  -- fail silently later.
  BEGIN
    PERFORM uellix_capability.stripe_begin_event('evt_rr14_blank', 'customer.subscription.updated', NULL, NULL);
    PERFORM dryrun.rec('RR14-6', false, 'an event was claimed with no Stripe address');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec('RR14-6', SQLSTATE = 'U0001', 'SQLSTATE ' || SQLSTATE);
  END;

  -- Re-claiming an existing event id under a DIFFERENT address.
  --
  -- The row is forced into a RE-CLAIMABLE state first, and that is the whole
  -- point of the fixture. Without it the ON CONFLICT WHERE clause is already
  -- false on its FIRST conjunct (the row was claimed seconds ago, so the
  -- 15-minute lease has not expired), the two identity conjuncts are never
  -- evaluated, and the test passes with them deleted. An adversarial reviewer
  -- demonstrated exactly that: the assertion named a property it did not
  -- reach. Now the lease is out of the way and the identity check is the only
  -- thing that can refuse.
  UPDATE public.stripe_webhook_events SET status = 'failed' WHERE event_id = 'evt_rr14';
  BEGIN
    PERFORM uellix_capability.stripe_begin_event('evt_rr14', 'customer.subscription.updated', 'cus_B', NULL);
    PERFORM dryrun.rec('RR14-7', false, 'an event was re-addressed to another customer');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec('RR14-7',
      SQLSTATE = 'U0001'
      AND (SELECT stripe_customer_id FROM public.stripe_webhook_events WHERE event_id = 'evt_rr14') = 'cus_A',
      'SQLSTATE ' || SQLSTATE);
  END;
  UPDATE public.stripe_webhook_events SET status = 'processing', received_at = now()
   WHERE event_id = 'evt_rr14';

  -- THE CONCURRENT-EVENT HOLE, which is why the bound names ONE event.
  --
  -- Two adversarial reviewers found this independently: with an uncorrelated
  -- `EXISTS (… WHERE status='processing' …)`, the transaction handling org A's
  -- event satisfies RLS for org B's row as soon as B's event is also in flight
  -- — which is routine, because Stripe delivers concurrently. Everything else
  -- in this block tests the single-event case and cannot see it.
  PERFORM uellix_capability.stripe_begin_event('evt_rr14_b', 'customer.subscription.updated', 'cus_B', NULL);
  PERFORM set_config('app.stripe_event_id', 'evt_rr14', true);
  SELECT stella_monthly_quota INTO v_q FROM public.organizations WHERE id = c_org_b;
  BEGIN
    SET LOCAL ROLE uellix_cap_stripe;
    EXECUTE 'UPDATE public.organizations SET stella_monthly_quota = 313131 WHERE id = '
         || quote_literal(c_org_b) || '::uuid';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    PERFORM dryrun.rec('RR14-9',
      v_n = 0 AND (SELECT stella_monthly_quota FROM public.organizations WHERE id = c_org_b) IS NOT DISTINCT FROM v_q,
      'rows updated for another in-flight event=' || v_n);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM dryrun.rec('RR14-9', SQLSTATE IN ('42501','U0001'), 'refused: ' || SQLSTATE);
  END;

  -- …and the body refuses the same shape even before RLS gets a say: applying
  -- evt_rr14 while naming cus_B must fail, because evt_rr14 is not addressed
  -- to cus_B.
  BEGIN
    PERFORM uellix_capability.stripe_apply_subscription(
      'evt_rr14', 'customer', 'cus_B', 'cus_B', NULL, 'price_x', 999999, 'Enterprise');
    PERFORM dryrun.rec('RR14-10', false, 'an event was applied against an address it does not carry');
  EXCEPTION WHEN OTHERS THEN
    PERFORM dryrun.rec('RR14-10',
      SQLSTATE = 'U0001'
      AND (SELECT stella_monthly_quota FROM public.organizations WHERE id = c_org_b) IS NOT DISTINCT FROM v_q,
      'SQLSTATE ' || SQLSTATE);
  END;
  UPDATE public.stripe_webhook_events SET status = 'completed' WHERE event_id = 'evt_rr14_b';

  -- Replay is still idempotent under the new signature.
  PERFORM uellix_capability.stripe_apply_subscription('evt_rr14', 'customer', 'cus_A', 'cus_A', 'sub_A', 'price_9', 700, 'Team');
  v_r := uellix_capability.stripe_begin_event('evt_rr14', 'customer.subscription.updated', 'cus_A', NULL);
  SELECT count(*) INTO v_n FROM public.stripe_webhook_events WHERE event_id = 'evt_rr14';
  PERFORM dryrun.rec('RR14-8', v_r = 'duplicate' AND v_n = 1, 'replay=' || v_r || ' rows=' || v_n);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM dryrun.rec('RR14-ABORTED', false, SQLSTATE || ' ' || SQLERRM);
END
$rr14$;

-- ===========================================================================
-- RR-CAP-02-F — publishing and revoking leave a trace, or do not happen
-- ===========================================================================
DO $rr02f$
DECLARE
  c_org_a constant uuid := '11111111-1111-4111-8111-111111111111';
  c_proj  constant uuid := 'eeeeeeee-0000-4000-8000-000000000005';
  c_run   constant uuid := 'ffffffff-0000-4000-8000-000000000006';
  c_admin constant uuid := 'dddddddd-0000-4000-8000-000000000004';
  c_rep   constant uuid := '00000000-5555-4000-8000-00000000000b';
  c_text  constant text  := 'A public summary that must not appear in the audit log.';
  v_n     integer;
  v_a     jsonb;
BEGIN
  INSERT INTO public.sroi_reports
    (id, organization_id, project_id, calculation_run_id, title, status, created_by,
     report_variant, verification_hash, locked_at)
  VALUES (c_rep, c_org_a, c_proj, c_run, 'Audited lifecycle', 'locked', c_admin,
          'funder', 'hash_audit', now())
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', c_admin::text, true);

  -- publish
  INSERT INTO public.report_public_disclosures (report_id, approved_by, public_summary)
  VALUES (c_rep, c_admin, c_text);
  SELECT count(*) INTO v_n FROM public.audit_logs
   WHERE entity_id = c_rep AND action = 'report.disclosure.published';
  PERFORM dryrun.rec('RR02F-1', v_n = 1, 'published events=' || v_n);

  -- the digest, not the text
  SELECT after_json INTO v_a FROM public.audit_logs
   WHERE entity_id = c_rep AND action = 'report.disclosure.published';
  PERFORM dryrun.rec('RR02F-2',
    v_a ? 'summarySha256'
    AND v_a->>'summarySha256' = encode(sha256(convert_to(c_text, 'UTF8')), 'hex')
    AND position('must not appear' in v_a::text) = 0
    AND v_a->>'showTotals' = 'false' AND v_a->>'live' = 'true',
    'keys=' || (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(v_a) k));

  -- a visibility change
  UPDATE public.report_public_disclosures SET show_totals = true, updated_at = now()
   WHERE report_id = c_rep;
  SELECT count(*) INTO v_n FROM public.audit_logs
   WHERE entity_id = c_rep AND action = 'report.disclosure.visibility_changed';
  PERFORM dryrun.rec('RR02F-3', v_n = 1, 'visibility events=' || v_n);

  -- a summary change is a visibility change too: the digest is part of the
  -- state, so a rewritten summary cannot pass as an incidental touch.
  UPDATE public.report_public_disclosures SET public_summary = 'Rewritten.', updated_at = now()
   WHERE report_id = c_rep;
  SELECT count(*) INTO v_n FROM public.audit_logs
   WHERE entity_id = c_rep AND action = 'report.disclosure.visibility_changed';
  PERFORM dryrun.rec('RR02F-4', v_n = 2, 'visibility events after summary change=' || v_n);

  -- revoke, then reinstate
  UPDATE public.report_public_disclosures SET revoked_at = now(), revoked_by = c_admin
   WHERE report_id = c_rep;
  UPDATE public.report_public_disclosures SET revoked_at = NULL, revoked_by = NULL
   WHERE report_id = c_rep;
  SELECT count(*) INTO v_n FROM public.audit_logs
   WHERE entity_id = c_rep AND action IN ('report.disclosure.revoked','report.disclosure.reinstated');
  PERFORM dryrun.rec('RR02F-5', v_n = 2, 'revoked+reinstated events=' || v_n);

  -- ATOMICITY. The audit write is made impossible and the publication must go
  -- with it. Testing this by breaking the audit path is the only way to
  -- observe the rollback; asserting "they are in one transaction" from the
  -- source would be reading the code back to itself.
  REVOKE INSERT ON public.audit_logs FROM uellix_writer;
  BEGIN
    SET LOCAL ROLE uellix_app;
    EXECUTE 'UPDATE public.report_public_disclosures SET show_report_title = true, updated_at = now() '
         || 'WHERE report_id = ' || quote_literal(c_rep) || '::uuid';
    RESET ROLE;
    PERFORM dryrun.rec('RR02F-6', false, 'the change committed without an audit row');
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM dryrun.rec('RR02F-6',
      SQLSTATE = '42501'
      AND (SELECT show_report_title FROM public.report_public_disclosures WHERE report_id = c_rep) = false,
      'SQLSTATE ' || SQLSTATE);
  END;
  GRANT INSERT ON public.audit_logs TO uellix_writer;

  -- The trail is not modifiable and not erasable by the runtime.
  PERFORM dryrun.denied('RR02F-7', 'uellix_app',
    'UPDATE public.audit_logs SET action = ''rewritten'' WHERE true');
  PERFORM dryrun.denied('RR02F-8', 'uellix_app', 'DELETE FROM public.audit_logs');
  -- Nor is the decision itself: the append-only trigger refuses the owner too.
  -- The OWNER, not a grantee: RLS exempts the owner and the DELETE privilege is
  -- implicit, so the trigger is the only thing left to refuse. It raises
  -- SQLSTATE 42501 with its own message, which is what distinguishes "the
  -- trigger fired" from "the role never had DELETE".
  PERFORM dryrun.denied('RR02F-9', 'uellix_owner',
    'DELETE FROM public.report_public_disclosures WHERE true', '42501');

  -- The OTHER half of "is this certificate visible". Public visibility is
  -- `sroi_reports.status = 'locked' AND revoked_at IS NULL`, and only the second
  -- conjunct lives on the audited table. An adversarial reviewer walked through
  -- the gap: sroi_reports_update admits `analyst`, so a certificate could be
  -- taken live or dark with nothing written to report_public_disclosures.
  SELECT count(*) INTO v_n FROM public.audit_logs
   WHERE entity_id = c_rep AND action = 'report.disclosure.visibility_changed';
  UPDATE public.sroi_reports SET status = 'draft' WHERE id = c_rep;
  UPDATE public.sroi_reports SET status = 'locked' WHERE id = c_rep;
  PERFORM dryrun.rec('RR02F-10',
    (SELECT count(*) FROM public.audit_logs
      WHERE entity_id = c_rep AND action = 'report.disclosure.visibility_changed') = v_n + 2,
    'status-change events=' ||
      ((SELECT count(*) FROM public.audit_logs
         WHERE entity_id = c_rep AND action = 'report.disclosure.visibility_changed') - v_n));

  -- …and a report NOBODY published produces no noise: locking one is an
  -- ordinary domain action, not a publication event.
  SELECT count(*) INTO v_n FROM public.audit_logs WHERE action = 'report.disclosure.visibility_changed';
  UPDATE public.sroi_reports SET status = 'draft'
   WHERE id = '00000000-6666-4000-8000-00000000000c';
  UPDATE public.sroi_reports SET status = 'locked'
   WHERE id = '00000000-6666-4000-8000-00000000000c';
  PERFORM dryrun.rec('RR02F-11',
    (SELECT count(*) FROM public.audit_logs WHERE action = 'report.disclosure.visibility_changed') = v_n,
    'noise events=' ||
      ((SELECT count(*) FROM public.audit_logs WHERE action = 'report.disclosure.visibility_changed') - v_n));

  PERFORM set_config('request.jwt.claim.sub', '', true);
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM dryrun.rec('RR02F-ABORTED', false, SQLSTATE || ' ' || SQLERRM);
END
$rr02f$;

-- ===========================================================================
-- Cross-capability isolation: no definer reaches another capability's surface
-- ===========================================================================
DO $isolation$
DECLARE
  rec record;
  v_bad text := '';
BEGIN
  FOR rec IN
    SELECT role_name, obj FROM (VALUES
      ('uellix_cap_invitation',   'uellix_capability.verify_report(text)'),
      ('uellix_cap_invitation',   'uellix_capability.submit_lead(text,text,text,text)'),
      ('uellix_cap_verification', 'uellix_capability.accept_invitation(text)'),
      ('uellix_cap_verification', 'uellix_capability.bootstrap_organization(uuid,text,text,text,text,text)'),
      ('uellix_cap_stripe',       'uellix_capability.accept_invitation(text)'),
      ('uellix_cap_lead',         'uellix_capability.verify_report(text)'),
      ('uellix_cap_bootstrap',    'uellix_capability.stripe_begin_event(text,text,text,text)'),
      ('uellix_cap_platform',     'uellix_capability.verify_report(text)'),
      ('uellix_cap_platform',     'uellix_capability.stripe_apply_subscription(text,text,text,text,text,text,integer,text)'),
      ('uellix_cap_verification', 'uellix_capability.admin_set_stella_service(uuid,integer,text)'),
      ('uellix_cap_stripe',       'uellix_capability.admin_set_stella_service(uuid,integer,text)'),
      ('uellix_cap_bootstrap',    'uellix_capability.admin_set_organization_status(uuid,text)'),
      ('authenticated',           'uellix_capability.admin_set_stella_service(uuid,integer,text)'),
      ('uellix_stripe',           'uellix_capability.accept_invitation(text)'),
      ('uellix_stripe',           'uellix_capability.submit_lead(text,text,text,text)')
    ) AS t(role_name, obj)
  LOOP
    IF has_function_privilege(rec.role_name, rec.obj, 'EXECUTE') THEN
      v_bad := v_bad || rec.role_name || '->' || rec.obj || ' ';
    END IF;
  END LOOP;
  PERFORM dryrun.rec('ISO-EXECUTE', v_bad = '', COALESCE(NULLIF(v_bad, ''), 'no cross-capability EXECUTE'));

  -- No capability definer holds any privilege on another capability's table.
  v_bad := '';
  FOR rec IN
    SELECT role_name, tbl FROM (VALUES
      ('uellix_cap_invitation',   'public.marketing_leads'),
      ('uellix_cap_invitation',   'public.stripe_webhook_events'),
      ('uellix_cap_verification', 'public.invitations'),
      ('uellix_cap_verification', 'public.marketing_leads'),
      ('uellix_cap_stripe',       'public.marketing_leads'),
      ('uellix_cap_stripe',       'public.invitations'),
      ('uellix_cap_lead',         'public.organizations'),
      ('uellix_cap_lead',         'public.users'),
      ('uellix_cap_bootstrap',    'public.marketing_leads'),
      ('uellix_cap_bootstrap',    'public.stripe_webhook_events'),
      ('uellix_cap_platform',     'public.invitations'),
      ('uellix_cap_platform',     'public.marketing_leads'),
      ('uellix_cap_platform',     'public.stripe_webhook_events'),
      ('uellix_cap_platform',     'public.sroi_reports'),
      ('uellix_cap_verification', 'public.stripe_webhook_events')
    ) AS t(role_name, tbl)
  LOOP
    IF has_any_column_privilege(rec.role_name, rec.tbl::regclass, 'SELECT')
       OR has_any_column_privilege(rec.role_name, rec.tbl::regclass, 'INSERT')
       OR has_any_column_privilege(rec.role_name, rec.tbl::regclass, 'UPDATE')
       OR has_table_privilege(rec.role_name, rec.tbl, 'DELETE') THEN
      v_bad := v_bad || rec.role_name || '->' || rec.tbl || ' ';
    END IF;
  END LOOP;
  PERFORM dryrun.rec('ISO-TABLES', v_bad = '', COALESCE(NULLIF(v_bad, ''), 'no cross-capability table privilege'));

  -- No capability role has a member, and none can log in.
  PERFORM dryrun.rec('ISO-ROLES',
    NOT EXISTS (
      SELECT 1 FROM pg_roles r
       WHERE r.rolname LIKE 'uellix_cap%'
         AND (r.rolcanlogin OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolsuper))
    AND NOT EXISTS (
      SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
       WHERE r.rolname LIKE 'uellix_cap%'),
    'attributes and membership');
END
$isolation$;

\echo ''
\echo '=== dry-run results ==='
SELECT id, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, detail
  FROM dryrun.results ORDER BY id;
\echo ''
SELECT count(*) FILTER (WHERE ok) AS passed,
       count(*) FILTER (WHERE NOT ok) AS failed,
       count(*) AS total
  FROM dryrun.results;
