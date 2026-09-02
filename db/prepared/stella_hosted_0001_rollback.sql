-- ============================================================================
-- stella_hosted_0001_rollback.sql
-- TRAIN 5B — reverses stella_hosted_0001_managed_role_bootstrap.sql.
-- ============================================================================
--
-- FAIL-CLOSED BY CONSTRUCTION, and the refusals are the point of the file.
--
-- The bootstrap is the FOUNDATION of the hosted chain: it creates the roles the
-- nine derived packages transfer ownership to, and the shim their rewritten
-- bodies call. Dropping it while any of them is installed does not "revert" —
-- it produces a database whose SECURITY DEFINER functions resolve nothing and
-- whose owner does not exist. PostgreSQL would refuse the DROP ROLE anyway, but
-- it would refuse it three quarters of the way through, with a message naming a
-- dependency instead of a reason.
--
--   psql "<staging>" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_hosted_0001_rollback.sql
--
-- Order, if a genuine full revert is wanted:
--   stella_0018_rollback -> 0017 -> 0016 -> 0015 -> 0014 -> 0013
--   grounding_0004_rollback -> grounding_0003_rollback -> grounding_0002_rollback
--   THEN this file.
-- ============================================================================

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Refusals
-- ============================================================
DO $$
DECLARE
  v_installed text;
  v_owned     int;
BEGIN
  -- (R1) No chain package may still be installed. Probed over the OBJECTS each
  --      one publishes rather than over a version table, for the reason
  --      db/prepared-package-order.ts gives: there is no schema_migrations for
  --      prepared packages, so "is it installed?" has to be asked of the
  --      catalog. A version row can be wrong; to_regprocedure cannot.
  SELECT string_agg(t.pkg, ', ' ORDER BY t.pkg) INTO v_installed
  FROM (VALUES
    ('stella_0013', 'uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)'),
    ('stella_0014', 'uellix_stella_ops.issue_operation_ticket(uuid, uuid, character varying, character)'),
    ('stella_0015', 'uellix_stella_ops.bind_operation_ticket(character, uuid, character)'),
    ('stella_0016', 'uellix_stella.stella_capacity(uuid, character)'),
    -- stella_0017 and grounding_0003 were missing from this list. Both
    -- adversarial reviews found it. The refusal was still CORRECT without them —
    -- 0017 implies 0016 is present, and 0003 implies 0002 is present, and both
    -- of those were probed — but the message would have named a package that is
    -- not the most recent one installed, sending the operator to the wrong
    -- rollback first. A refusal whose reason points elsewhere is a refusal that
    -- costs an extra round trip in the one situation where care matters most.
    ('stella_0017', 'uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)'),
    ('stella_0018', 'uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)'),
    ('grounding_0002', 'uellix_grounding.claim_active_document_version(uuid)'),
    ('grounding_0003', 'uellix_grounding.chunks_in_scope(uuid, uuid, uuid)'),
    ('grounding_0004', 'uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid)')
  ) AS t(pkg, sig)
  WHERE to_regprocedure(t.sig) IS NOT NULL;

  IF v_installed IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001_rollback refused: chain package(s) still installed: %. This file drops the roles those packages'' objects are owned by and the shim their bodies call. Roll the chain back first, in reverse order (0018 -> 0013, then grounding 0004 -> 0002).', v_installed;
  END IF;

  -- (R2) None of the five roles may still own anything. Checked explicitly
  --      rather than left to the DROP, so the operator learns WHAT is in the
  --      way instead of reading a dependency list.
  SELECT count(*) INTO v_owned
  FROM pg_class c
  JOIN pg_roles r ON r.oid = c.relowner
  WHERE r.rolname IN ('uellix_owner','uellix_migrator','uellix_app','uellix_writer','uellix_auditor')
    AND c.relnamespace <> to_regnamespace('uellix_bootstrap');

  IF v_owned > 0 THEN
    RAISE EXCEPTION 'stella_hosted_0001_rollback refused: % relation(s) outside uellix_bootstrap are still owned by a role this file drops. Transfer or drop them first; this package will not guess who should inherit them.', v_owned;
  END IF;

  -- (R3) The environment must be declared, exactly as for the forward package.
  --      A rollback is a change like any other, and running one against an
  --      undeclared target is the same mistake in the other direction.
  IF coalesce(current_setting('uellix.bootstrap_environment', true), '') IS DISTINCT FROM 'staging' THEN
    RAISE EXCEPTION 'stella_hosted_0001_rollback refused: uellix.bootstrap_environment must be exactly ''staging''. Set it in the same session.';
  END IF;
END $$;

-- ============================================================
-- 1. Drop, in dependency order
-- ============================================================
DROP FUNCTION IF EXISTS public.uellix_auth_uid();
DROP FUNCTION IF EXISTS uellix_bootstrap.assert_hosted_capabilities(text);
DROP FUNCTION IF EXISTS uellix_bootstrap.hosted_capability_report();

-- The sentinel row is EVIDENCE OF PROVISIONING, not state this package owns.
-- Dropping the table takes it with it, which is correct for a full revert and
-- is why the refusals above are strict: reaching this line should be a decision,
-- not an accident.
DROP TABLE IF EXISTS uellix_bootstrap.staging_sentinel;
DROP SCHEMA IF EXISTS uellix_bootstrap;

-- Schema privileges, and this is load-bearing rather than tidiness.
-- PostgreSQL refuses to drop a role that still holds one: measured on
-- PostgreSQL 17.6, `DROP ROLE uellix_owner` fails with `role "uellix_owner"
-- cannot be dropped because some objects depend on it / DETAIL: privileges for
-- schema public`. stella_hosted_0001 §2b-bis grants USAGE to all five and
-- CREATE to the owner, so this file revokes what its forward package granted —
-- otherwise stella_hosted_0000_rollback (which owns the DROP ROLEs) becomes
-- inapplicable, and that would only be discovered while trying to undo a
-- half-built staging, which is the worst moment to learn it.
--
-- The grants on schema uellix_bootstrap, its sentinel and the auth shim need no
-- counterpart: those objects were dropped above, and an ACL does not outlive
-- the object it describes.
DO $$
BEGIN
  IF to_regrole('uellix_owner')    IS NOT NULL THEN REVOKE ALL ON SCHEMA public FROM uellix_owner;    END IF;
  IF to_regrole('uellix_migrator') IS NOT NULL THEN REVOKE ALL ON SCHEMA public FROM uellix_migrator; END IF;
  IF to_regrole('uellix_app')      IS NOT NULL THEN REVOKE ALL ON SCHEMA public FROM uellix_app;      END IF;
  IF to_regrole('uellix_writer')   IS NOT NULL THEN REVOKE ALL ON SCHEMA public FROM uellix_writer;   END IF;
  IF to_regrole('uellix_auditor')  IS NOT NULL THEN REVOKE ALL ON SCHEMA public FROM uellix_auditor;  END IF;
END $$;

-- THE FIVE ROLES ARE DELIBERATELY NOT DROPPED HERE (HPO-ODS-W2-03). They are
-- IDENTITY, established by stella_hosted_0000 BEFORE the baseline, and the
-- baseline's own policies (0042, 0045) name uellix_app. Dropping them from the
-- bootstrap's rollback would leave a baseline whose policies reference a
-- missing role. Their removal, and the membership revocations that precede it,
-- belong to db/prepared/stella_hosted_0000_rollback.sql, which refuses while
-- this schema, any owned object or any schema-public privilege remains.

-- ============================================================
-- 2. Postconditions
-- ============================================================
DO $$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO v_left
  FROM (VALUES ('uellix_owner'),('uellix_migrator'),('uellix_app'),('uellix_writer'),('uellix_auditor')) AS r(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name);

  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001_rollback FAILED: role identit(ies) % are missing. This file never drops a role; if they are gone, something outside the governed sequence removed them and the baseline underneath is now inconsistent.', v_left;
  END IF;

  IF to_regnamespace('uellix_bootstrap') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001_rollback FAILED: schema uellix_bootstrap survived.';
  END IF;

  IF to_regprocedure('public.uellix_auth_uid()') IS NOT NULL THEN
    RAISE EXCEPTION 'stella_hosted_0001_rollback FAILED: the auth shim survived. Leaving a SECURITY DEFINER function behind after removing everything that was meant to call it is exactly the residue this rollback exists to prevent.';
  END IF;

  -- NOT reverted, and deliberately: nothing this package granted to
  -- `authenticated`, `anon` or `service_role` needs undoing, because it granted
  -- them nothing. The baseline surface is exactly as it was.
  RAISE NOTICE 'stella_hosted_0001_rollback: complete — bootstrap schema and shim removed, schema-public privileges revoked, no residue of this package. The 5 role identities remain (stella_hosted_0000_rollback owns them). The baseline Supabase grants were never touched and are unchanged.';
END $$;
