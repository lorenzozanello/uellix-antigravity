-- db/prepared/stella_0004_rollback.sql
-- Rollback for stella_0004_role_separation.sql.
--
-- RUN ONLY in a separately authorised local administrative transaction. The
-- transaction must set uellix.rollback_confirmation=rollback-0004:<database>.
-- This package is not a generic psql/SQL-Editor execution artefact.
--
-- ============================================================================
-- THIS ROLLBACK IS PARTIALLY NON-REVERSING, ON PURPOSE
-- ============================================================================
-- stella_0004 did two different kinds of thing, and only one of them should
-- ever be undone automatically.
--
--   REVERSING (undone here, unconditionally):
--     * ownership of the 38 tables and 8 functions returns to `postgres`;
--     * the public-object ACLs stella_0004 created are removed.
--
-- PRESERVED FOR stella_0001 ROLLBACK:
--     * governed role attributes, memberships, schema grants and role-local
--       default privilege suppression remain owned by stella_0001.
--
--   NON-REVERSING BY DEFAULT (a deliberate refusal):
--     * the REVOKE of TRUNCATE / REFERENCES / TRIGGER / MAINTAIN from
--       `authenticated` and `service_role` on the 38 tables;
--     * the repair of `pg_default_acl` for `postgres` and `supabase_admin`.
--
-- Restoring those would re-grant `authenticated` the ability to TRUNCATE an
-- append-only audit trail — TRUNCATE is not governed by RLS and row triggers
-- do not fire on it — and would make every future table in `public` created by
-- `supabase_admin` fully writable by the UNAUTHENTICATED role `anon`. A
-- rollback that reinstates a vulnerability is not a rollback; it is a
-- regression with a reassuring name. This follows the precedent set by
-- stella_0002b_rollback.sql.
--
-- An operator who genuinely needs bit-for-bit restoration — for example to
-- re-run a comparison against an untouched replica — must ask for it a second
-- time and separately:
--
--   -v uellix_rollback_restore_unsafe_defaults=yes
--
-- ============================================================================
-- WHAT THIS SCRIPT WILL NOT DO
-- ============================================================================
--   * It will not run without the exact confirmation token.
--   * It will not run if the inventory has drifted from what stella_0004 left
--     behind: an object that moved since then is a state this script was never
--     designed to reverse, and guessing is worse than stopping.
--   * It uses no CASCADE, no DROP OWNED, no REASSIGN OWNED.
--   * It touches no data, no policy and no trigger.

SET search_path = public;

-- ============================================================
-- 0. Authorisation and drift check
-- ============================================================
DO $$
DECLARE
  expected text;
  provided text := current_setting('uellix.rollback_confirmation', true);
  problem  text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0004 rollback must run as a superuser (current role: %)', current_user;
  END IF;

  -- Binds the authorisation to THIS database, so a token minted for one stack
  -- cannot confirm a rollback on another.
  expected := 'rollback-0004:' || current_database();

  IF provided IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'stella_0004 rollback REFUSED: destructive authorisation missing or wrong. Re-run with -v uellix_rollback_confirmation=rollback-0004:<this database name>';
  END IF;

  -- Drift: the forward script's end state must still be in place.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_0004 rollback REFUSED: uellix_owner does not exist — stella_0004 was never applied here, or was already rolled back';
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO problem
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    AND c.relowner <> 'uellix_owner'::regrole;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 rollback REFUSED: drift — table(s) in public are not owned by uellix_owner: %. Reverse ownership by hand after establishing why', problem;
  END IF;

  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')) <> 38 THEN
    RAISE EXCEPTION 'stella_0004 rollback REFUSED: drift — public no longer holds exactly 38 tables';
  END IF;

  RAISE NOTICE 'stella_0004 rollback: authorised, no drift detected.';
END $$;

-- ============================================================
-- 1. Ownership back to postgres
-- ============================================================
-- ALTER ... OWNER TO transfers the previous owner's ACL entry to the new
-- owner, so this restores `postgres`'s direct privileges as a side effect —
-- the same mechanism that removed them in the forward script.

ALTER TABLE public.audit_logs OWNER TO postgres;
ALTER TABLE public.evidence_items OWNER TO postgres;
ALTER TABLE public.financial_proxies OWNER TO postgres;
ALTER TABLE public.funders OWNER TO postgres;
ALTER TABLE public.fx_rates OWNER TO postgres;
ALTER TABLE public.impact_narratives OWNER TO postgres;
ALTER TABLE public.indicators OWNER TO postgres;
ALTER TABLE public.invitations OWNER TO postgres;
ALTER TABLE public.marketing_leads OWNER TO postgres;
ALTER TABLE public.methodology_review_matrix OWNER TO postgres;
ALTER TABLE public.methodology_review_matrix_items OWNER TO postgres;
ALTER TABLE public.organization_members OWNER TO postgres;
ALTER TABLE public.organizations OWNER TO postgres;
ALTER TABLE public.outcome_funder_allocations OWNER TO postgres;
ALTER TABLE public.outcome_proxy_assignments OWNER TO postgres;
ALTER TABLE public.outcome_taxonomy_mappings OWNER TO postgres;
ALTER TABLE public.outcomes OWNER TO postgres;
ALTER TABLE public.portfolios OWNER TO postgres;
ALTER TABLE public.project_investments OWNER TO postgres;
ALTER TABLE public.projects OWNER TO postgres;
ALTER TABLE public.proxy_sources OWNER TO postgres;
ALTER TABLE public.signup_allowlist OWNER TO postgres;
ALTER TABLE public.sroi_assignment_inputs OWNER TO postgres;
ALTER TABLE public.sroi_calculation_line_items OWNER TO postgres;
ALTER TABLE public.sroi_calculation_runs OWNER TO postgres;
ALTER TABLE public.sroi_filter_sets OWNER TO postgres;
ALTER TABLE public.sroi_report_sections OWNER TO postgres;
ALTER TABLE public.sroi_reports OWNER TO postgres;
ALTER TABLE public.sroi_run_review_items OWNER TO postgres;
ALTER TABLE public.sroi_run_reviews OWNER TO postgres;
ALTER TABLE public.stakeholder_groups OWNER TO postgres;
ALTER TABLE public.stella_interactions OWNER TO postgres;
ALTER TABLE public.stella_suggestion_decisions OWNER TO postgres;
ALTER TABLE public.taxonomy_catalogs OWNER TO postgres;
ALTER TABLE public.taxonomy_codes OWNER TO postgres;
ALTER TABLE public.theory_of_change_links OWNER TO postgres;
ALTER TABLE public.theory_of_change_nodes OWNER TO postgres;
ALTER TABLE public.users OWNER TO postgres;

ALTER FUNCTION public.can_read_evidence_object(text,uuid) OWNER TO postgres;
ALTER FUNCTION public.can_write_evidence_object(text,uuid) OWNER TO postgres;
ALTER FUNCTION public.current_user_is_super_admin() OWNER TO postgres;
ALTER FUNCTION public.current_user_org_ids() OWNER TO postgres;
ALTER FUNCTION public.current_user_role_in_org(uuid) OWNER TO postgres;
ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
ALTER FUNCTION public.handle_update_user() OWNER TO postgres;
ALTER FUNCTION public.uellix_forbid_mutation() OWNER TO postgres;

-- ============================================================
-- 2. Remove only public-object ACLs owned by stella_0004
-- ============================================================
-- Role topology remains in place so the protected 0003 rollback can run next,
-- and stella_0001 can later remove roles only after its dependency guard.

REVOKE ALL ON
  public.audit_logs, public.evidence_items, public.financial_proxies,
  public.funders, public.fx_rates, public.impact_narratives,
  public.indicators, public.invitations, public.marketing_leads,
  public.methodology_review_matrix, public.methodology_review_matrix_items, public.organization_members,
  public.organizations, public.outcome_funder_allocations, public.outcome_proxy_assignments,
  public.outcome_taxonomy_mappings, public.outcomes, public.portfolios,
  public.project_investments, public.projects, public.proxy_sources,
  public.signup_allowlist, public.sroi_assignment_inputs, public.sroi_calculation_line_items,
  public.sroi_calculation_runs, public.sroi_filter_sets, public.sroi_report_sections,
  public.sroi_reports, public.sroi_run_review_items, public.sroi_run_reviews,
  public.stakeholder_groups, public.stella_interactions, public.stella_suggestion_decisions,
  public.taxonomy_catalogs, public.taxonomy_codes, public.theory_of_change_links,
  public.theory_of_change_nodes, public.users
FROM uellix_owner, uellix_migrator, uellix_app, uellix_writer, uellix_auditor;

REVOKE ALL ON FUNCTION
  public.can_read_evidence_object(text,uuid), public.can_write_evidence_object(text,uuid),
  public.current_user_is_super_admin(), public.current_user_org_ids(),
  public.current_user_role_in_org(uuid), public.handle_new_user(),
  public.handle_update_user(), public.uellix_forbid_mutation()
FROM uellix_owner, uellix_migrator, uellix_app, uellix_writer, uellix_auditor;

-- ============================================================
-- 3. Optional, separately authorised: restore the unsafe original defaults
-- ============================================================
-- Runs only with -v uellix_rollback_restore_unsafe_defaults=yes. Everything
-- here re-opens a hole that stella_0004 closed, which is why it needs its own
-- authorisation and its own warning.

DO $$
BEGIN
  IF COALESCE(current_setting('uellix.rollback_restore_unsafe_defaults', true), 'no') <> 'yes' THEN
    RAISE NOTICE 'stella_0004 rollback: NOT restoring the unsafe original grants and default privileges (SAFE_NON_REVERSING). authenticated/service_role remain without TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, and pg_default_acl in schema public stays clean. Pass -v uellix_rollback_restore_unsafe_defaults=yes to override.';
    RETURN;
  END IF;

  RAISE WARNING 'stella_0004 rollback: RESTORING UNSAFE DEFAULTS BY EXPLICIT REQUEST. After this transaction, every table created by postgres in schema public will again grant TRUNCATE/REFERENCES/TRIGGER/MAINTAIN to authenticated, every table created by supabase_admin will again grant FULL DML to the unauthenticated role anon, and every new sequence will again grant UPDATE (nextval/setval) to anon.';

  -- pg_default_acl as Supabase ships it.
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT REFERENCES, TRIGGER, TRUNCATE, MAINTAIN ON TABLES TO authenticated';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT UPDATE ON SEQUENCES TO anon, authenticated, service_role';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT SELECT, UPDATE, USAGE ON SEQUENCES TO anon, authenticated, service_role';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role';

  -- The PUBLIC suppression entries for functions and types.
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres       IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres       IN SCHEMA public GRANT USAGE   ON TYPES     TO PUBLIC';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT USAGE   ON TYPES     TO PUBLIC';

  -- NOTE: the per-table Dxtm grants are NOT restored even here. Their original
  -- shape varied table by table (28 tables held the full set, 6 held a subset,
  -- 4 held none), so a blanket re-grant would not be a restoration — it would
  -- be a widening. Reconstruct them from a backup if they are genuinely needed.
  RAISE WARNING 'stella_0004 rollback: per-table TRUNCATE/REFERENCES/TRIGGER/MAINTAIN grants were NOT restored — their original shape was not uniform across the 38 tables and a blanket re-grant would widen rather than restore. Use a backup if that exact ACL is required.';
END $$;

-- ============================================================
-- 4. Restore the schema comment
-- ============================================================
COMMENT ON SCHEMA public IS 'standard public schema';

-- ============================================================
-- 5. Self-verification
-- ============================================================
DO $$
DECLARE
  problem text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO problem
  FROM pg_roles WHERE rolname IN ('uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_writer', 'uellix_auditor');
  IF problem IS DISTINCT FROM 'uellix_app, uellix_auditor, uellix_migrator, uellix_owner, uellix_writer' THEN
    RAISE EXCEPTION 'stella_0004 rollback FAILED: governed topology drifted while ownership rollback ran: %', problem;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO problem
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    AND c.relowner <> 'postgres'::regrole;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 rollback FAILED: table(s) not returned to postgres: %', problem;
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO problem
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proowner <> 'postgres'::regrole;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0004 rollback FAILED: function(s) not returned to postgres: %', problem;
  END IF;

  -- The rollback must not have disturbed the structure either.
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')) <> 38
     OR (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') <> 105
     OR (SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND NOT g.tgisinternal) <> 10 THEN
    RAISE EXCEPTION 'stella_0004 rollback FAILED: structural drift — post-0003 38/105/10 fingerprint broken';
  END IF;

  RAISE NOTICE 'stella_0004 rollback: complete — ownership back to postgres; stella_0001 remains sole authority for role-topology rollback; structure intact.';
END $$;
