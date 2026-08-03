-- scripts/capability-dry-run.sql
--
-- The 67 live assertions of the capability campaign, plus the concurrency and
-- cross-isolation checks, as executable SQL.
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

  DELETE FROM public.report_public_disclosures WHERE report_id = '00000000-1111-4000-8000-000000000007';
  SELECT count(*) INTO v_n FROM uellix_capability.verify_report('hash_locked');
  PERFORM dryrun.rec('CAP02-L1', v_n = 0, 'rows=' || v_n);
  INSERT INTO public.report_public_disclosures (report_id, approved_by)
  VALUES ('00000000-1111-4000-8000-000000000007', 'dddddddd-0000-4000-8000-000000000004');

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
  v_r := uellix_capability.stripe_begin_event('evt_1', 'customer.subscription.updated');
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
  v_r := uellix_capability.stripe_begin_event('evt_1', 'customer.subscription.updated');
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
  PERFORM uellix_capability.stripe_begin_event('evt_2', 'customer.subscription.updated');
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
  PERFORM uellix_capability.stripe_begin_event('evt_3', 'customer.subscription.updated');
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
  PERFORM uellix_capability.stripe_begin_event('evt_4', 'customer.subscription.updated');
  UPDATE public.stripe_webhook_events SET received_at = now() - interval '20 minutes' WHERE event_id = 'evt_4';
  v_r := uellix_capability.stripe_begin_event('evt_4', 'customer.subscription.updated');
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
      ('uellix_cap_bootstrap',    'uellix_capability.stripe_begin_event(text,text)'),
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
      ('uellix_cap_bootstrap',    'public.stripe_webhook_events')
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
