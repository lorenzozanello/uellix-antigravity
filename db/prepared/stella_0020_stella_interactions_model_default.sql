-- db/prepared/stella_0020_stella_interactions_model_default.sql
-- G1-B PRECONDITIONS — remove the provider model id the DATABASE was choosing.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: stella_0020_rollback.sql.
--
-- PRECHAIN ADMINISTRATIVE UNIT, registered and pinned by digest in
-- db/hosted/prechain-ownership.ts. NOT a member of HOSTED_CHAIN.
--
-- ============================================================================
-- THE CHANNEL, STATED CORRECTLY
-- ============================================================================
-- THE CORRECTION. An earlier revision of this header said the hosted variant
-- "is generated and authorised through the normal channel (pnpm hosted:generate
-- / the operator runbook)". That was FALSE and it was load-bearing: this
-- package is not in db/hosted/hosted-package-manifest.ts, so `pnpm
-- hosted:generate` produces no artefact for it and `pnpm hosted:verify` does
-- not cover it. An operator following that sentence would have found no
-- artefact and applied the canonical file directly — an UNGOVERNED apply, which
-- is the class of the T1 incident this repository already paid for once.
--
-- IT IS ALSO NOT A CANDIDATE FOR THAT MANIFEST, and the reason is structural
-- rather than a matter of taste: `HOSTED_CHAIN` IS the manifest —
-- `HOSTED_CHAIN = HOSTED_PACKAGE_MANIFEST.map(e => e.name)` — and
-- `WITNESSED_PACKAGES` is that list minus the bootstrap. A manifest entry is
-- therefore a governed CHAIN LINK: it acquires a T-number in
-- db/hosted/authority/window-plan.ts, an authority window, a witness registry
-- entry, a `.governed.sql`, and an applying identity that is `uellix_migrator`
-- and nothing else. It would also move `A1_EXPECTED_PACKAGE_COUNT`, which is
-- `HOSTED_CHAIN.length - 1` — retroactively reclassifying a staging project
-- already certified and recorded at 11/11 as incomplete.
--
-- WHAT IT ACTUALLY IS: a prerequisite applied by the ADMINISTRATIVE hosted
-- session before the certification runs, which is the definition the prechain
-- family already carries (db/hosted/prechain-ownership.ts). That registry pins
-- its bytes by SHA-256, both certification harnesses apply it and refuse on
-- PRECHAIN_ADMIN_PIN_MISMATCH, and
-- docs/ops/staging/STELLA_PRECHAIN_OPERATOR_RUNBOOK.md is its operator
-- procedure. The file below IS the artefact: nothing is derived from it,
-- because nothing in it needs rewriting for managed Supabase — no `auth` schema
-- grant, no superuser precondition, no role creation.
--
-- ============================================================================
-- WHEN: AFTER THE CHAIN, NOT BEFORE IT
-- ============================================================================
-- MEASURED by scripts/pg176-certify.ts, which is how this was found rather than
-- reasoned. Applied before T1 on a freshly provisioned managed project, this
-- package ABORTS:
--
--     stella_0020 aborted: unexpected INSERT grant on
--     public.stella_interactions held by [authenticated, service_role]
--
-- and it is RIGHT to. Those two hold INSERT because managed Supabase grants it
-- by default privilege when a baseline unit creates a table in `public`, and
-- the package that withdraws it is stella_0017 §302/§308 — T8, a CHAIN link. So
-- the dead-default proof in §0.4 is only satisfiable once the chain has run,
-- and the earliest appliable point is after it.
--
-- That is recorded as data, not as a comment: `applyWindow: 'postchain'` in
-- db/hosted/prechain-ownership.ts, which is what both certification harnesses
-- read. On bvyzblhqymxruxdguaee the chain is 11/11 INSTALLED, so the condition
-- already holds there today.
--
-- APPLIED, hosted, through the administrative session, in one transaction:
--   psql "$UELLIX_STAGING_ADMIN_URL" -X -1 -v ON_ERROR_STOP=1 -f <this file>
--
-- APPLIED, locally, through the runner that already opens the owner window:
--   pnpm db:prepared:apply:local stella_0020_stella_interactions_model_default.sql
--
-- NOT YET APPLIED TO ANY DATABASE.
--
-- ============================================================================
-- WHAT IS WRONG, EXACTLY
-- ============================================================================
-- db/migrations/0012_stella_interactions.sql created:
--
--     model_used varchar(100) DEFAULT 'gemini-2.0-flash' NOT NULL
--
-- `gemini-2.0-flash` was retired by Google and now returns 404 NOT_FOUND
-- (lib/stella/config.ts, MODEL HISTORY). The column default is therefore a
-- SECOND SOURCE OF TRUTH for Stella's model target which disagrees with the
-- only real one, `STELLA_DEFAULT_GEMINI_MODEL`.
--
-- ============================================================================
-- WHY THE DEFAULT IS DROPPED AND NOT RETARGETED
-- ============================================================================
-- `model_used` records WHICH MODEL ANSWERED. It is a MEASUREMENT, not a
-- configuration, and a column default is the database inventing a measurement
-- for a row whose writer did not supply one. Retargeting the literal to the
-- current model would keep exactly that property and make it harder to see,
-- because the invented value would then look plausible.
--
-- ============================================================================
-- WHY THIS CHANGES NO BEHAVIOUR
-- ============================================================================
-- Since stella_0017 there is exactly ONE writer of public.stella_interactions:
-- `uellix_stella.settle_reserved_quota`, called by
-- `uellix_stella_ops.complete_operation_ticket`. INSERT was revoked from
-- uellix_writer and uellix_app (stella_0017 §339/§342), and RLS admits no other
-- role. That function:
--
--   * resolves `v_model := COALESCE(p_model_used, 'not-applicable')`, so it
--     never passes NULL, and
--   * names `model_used` explicitly in its INSERT column list, so the DEFAULT
--     clause is unreachable from it even if it did.
--
-- The default is therefore dead in the live system. §0.4 below PROVES that
-- claim against the catalog instead of asserting it, and aborts if a second
-- writer has appeared since this was written.
--
-- The column stays NOT NULL. Dropping the default without dropping the
-- constraint is the whole change: a writer that supplies no model now FAILS
-- (23502) instead of silently recording a retired model id.
--
-- ============================================================================
-- WHO APPLIES IT
-- ============================================================================
-- The SAME measured-owner contract stella_hosted_0008 carries, and for the same
-- reason: `ALTER TABLE` requires ownership of the relation, and this repository
-- has already been bitten once by a package that named the owner instead of
-- measuring it. §0.5 reads pg_class.relowner and admits exactly two outcomes:
--
--   SESSION_IS_OWNER   the session already owns public.stella_interactions.
--                      This is the LOCAL posture: scripts/db-migrate-local.ts
--                      opens `SET ROLE uellix_owner` before it applies a
--                      prepared script, so current_user is already the owner
--                      and no second switch is issued.
--   OWNER_ASSUMABLE    the table is owned by uellix_owner and the session can
--                      act as it or SET ROLE to it. This is the HOSTED posture:
--                      stella_hosted_0001 §399 transfers this one relation to
--                      uellix_owner and grants the membership to postgres
--                      WITH INHERIT FALSE, SET TRUE.
--   anything else      REFUSED, naming the owner it measured.
--
-- ============================================================================
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
-- ============================================================================
--   * It does not drop, rename or retype any column.
--   * It does not relax NOT NULL.
--   * It does not touch a single row.
--   * It does not change any privilege, policy, trigger, owner or role. §2
--     compares the owner and the ACL captured before the change against the
--     ones after it.
--   * It uses no CASCADE and no dynamic DDL built from a variable.
--
-- Idempotent AND convergent: a second application changes nothing.
-- ============================================================================

SET search_path = public;
SET lock_timeout = '5s';

-- ============================================================
-- 0. Preconditions — abort before touching anything
-- ============================================================
DO $$
DECLARE
  v_writers text;
  v_owner   name;
  v_acl     text;
BEGIN
  -- 0.1 The target must exist.
  IF to_regclass('public.stella_interactions') IS NULL THEN
    RAISE EXCEPTION
      'stella_0020 aborted: table public.stella_interactions not found — this database is not at the expected baseline.';
  END IF;

  -- 0.2 The column must exist and must still be NOT NULL. Dropping a default
  --     from a nullable column is a different change with a different
  --     consequence, and this package is written for the first one.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'public.stella_interactions'::regclass
      AND a.attname = 'model_used' AND NOT a.attisdropped AND a.attnotnull
  ) THEN
    RAISE EXCEPTION
      'stella_0020 aborted: public.stella_interactions.model_used is absent or is not NOT NULL. This package removes a default from a REQUIRED column; on a nullable one the same statement means something else.';
  END IF;

  -- 0.3 THE PRESTATE OF THE TWO THINGS THIS PACKAGE MUST NOT MOVE.
  SELECT pg_catalog.pg_get_userbyid(c.relowner), COALESCE(c.relacl::text, '')
    INTO v_owner, v_acl
  FROM pg_class c WHERE c.oid = 'public.stella_interactions'::regclass;

  PERFORM set_config('uellix.s0020_owner_pre', v_owner, true);
  PERFORM set_config('uellix.s0020_acl_pre', v_acl, true);

  -- 0.4 THE DEAD-DEFAULT PROOF. The claim in the header is that no principal
  --     can reach the DEFAULT because none of them can INSERT. Measured, not
  --     assumed: if any role outside the governed capability holds INSERT, the
  --     default is NOT dead and dropping it would turn a silently-wrong row
  --     into a hard 23502 in a path nobody has reviewed. Abort and let a human
  --     look.
  --
  --     UNCHANGED BY THE GOVERNANCE FIX, deliberately. `role_table_grants` is
  --     filtered to the CURRENTLY ENABLED roles, so in principle it could miss
  --     a writer neither granted by nor granted to this session — a FALSE PASS
  --     rather than a false abort. That caveat is real and is corroborated
  --     OUTSIDE this package, by the read-only aclexplode query the operator
  --     runs in the R1 preflight, where an unfiltered catalog read costs
  --     nothing. Rewriting the predicate here would change what this package
  --     REFUSES, which is a different decision from the ownership contract this
  --     revision exists to correct, and it belongs in its own review.
  SELECT string_agg(grantee, ', ' ORDER BY grantee) INTO v_writers
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name = 'stella_interactions'
    AND privilege_type = 'INSERT'
    AND grantee NOT IN ('uellix_owner', 'uellix_cap_stella_quota', 'postgres');

  IF v_writers IS NOT NULL THEN
    RAISE EXCEPTION
      'stella_0020 aborted: unexpected INSERT grant on public.stella_interactions held by [%]. The ledger is written only through the governed ticket protocol (stella_0017); an extra writer means the column default is reachable and this change needs review, not application.',
      v_writers;
  END IF;

  -- 0.5 THE IDENTITY DECISION, MEASURED. See the header: two admitted outcomes,
  --     everything else refused by name.
  IF v_owner = current_user THEN
    PERFORM set_config('uellix.s0020_assume_owner', 'no', true);
    RAISE NOTICE 'stella_0020: public.stella_interactions is owned by % and this session IS that role. SESSION_IS_OWNER — the change is issued directly and no role is assumed.', v_owner;

  ELSIF v_owner = 'uellix_owner'
        AND (pg_catalog.pg_has_role(current_user, 'uellix_owner', 'USAGE')
             OR pg_catalog.pg_has_role(current_user, 'uellix_owner', 'SET')) THEN
    PERFORM set_config('uellix.s0020_assume_owner', 'yes', true);
    RAISE NOTICE 'stella_0020: public.stella_interactions is owned by uellix_owner and this session (%) can act as it. OWNER_ASSUMABLE — the change is issued inside a SET LOCAL ROLE window that closes immediately.', current_user;

  ELSE
    RAISE EXCEPTION
      'stella_0020 aborted: public.stella_interactions is owned by % and this session (%) is neither that role nor able to assume it. ALTER TABLE requires ownership of the relation and no privilege substitutes for it.',
      v_owner, current_user;
  END IF;
END $$;

-- ============================================================
-- 1. The change. One statement, under the required identity.
-- ============================================================
-- ALTER COLUMN ... DROP DEFAULT on a column that has no default is a no-op in
-- PostgreSQL, never an error — which is what makes this convergent. The block
-- exists because the role window is CONDITIONAL, and a conditional at the top
-- level of a SQL file does not exist.
DO $$
DECLARE
  v_decision text := NULLIF(current_setting('uellix.s0020_assume_owner', true), '');
BEGIN
  IF v_decision IS NULL THEN
    RAISE EXCEPTION
      'stella_0020 aborted: the identity decision from section 0 is not present in this transaction. This block refuses to guess which identity the change needs.';
  END IF;

  IF v_decision = 'yes' THEN
    SET LOCAL ROLE uellix_owner;
  ELSIF v_decision <> 'no' THEN
    RAISE EXCEPTION 'stella_0020 aborted: unrecognised identity decision "%".', v_decision;
  END IF;

  ALTER TABLE public.stella_interactions
    ALTER COLUMN model_used DROP DEFAULT;

  COMMENT ON COLUMN public.stella_interactions.model_used IS
    'The model that ANSWERED, as reported by the adapter. NOT NULL and with NO DEFAULT since prepared stella_0020: the database must never choose or invent Stella''s model. The only writer is uellix_stella.settle_reserved_quota, which resolves COALESCE(p_model_used, ''not-applicable'').';

  IF v_decision = 'yes' THEN
    RESET ROLE;
  END IF;
END $$;

-- ============================================================
-- 2. Postconditions — assert the end state
-- ============================================================
DO $$
DECLARE
  v_default   text;
  v_notnull   boolean;
  v_owner_pre text := NULLIF(current_setting('uellix.s0020_owner_pre', true), '');
  v_acl_pre   text := current_setting('uellix.s0020_acl_pre', true);
  v_owner_now text;
  v_acl_now   text;
BEGIN
  IF current_user <> session_user THEN
    RAISE EXCEPTION
      'stella_0020 FAILED verification: the session is still acting as % rather than %. The change block issues RESET ROLE in the same block that opened the window.',
      current_user, session_user;
  END IF;

  SELECT pg_get_expr(d.adbin, d.adrelid), a.attnotnull
    INTO v_default, v_notnull
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.stella_interactions'::regclass
    AND a.attname = 'model_used'
    AND NOT a.attisdropped;

  IF v_default IS NOT NULL THEN
    RAISE EXCEPTION 'stella_0020 postcondition failed: model_used still has a default (%)', v_default;
  END IF;
  IF v_notnull IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'stella_0020 postcondition failed: model_used is no longer NOT NULL — the constraint must survive the default';
  END IF;

  SELECT pg_catalog.pg_get_userbyid(c.relowner), COALESCE(c.relacl::text, '')
    INTO v_owner_now, v_acl_now
  FROM pg_class c WHERE c.oid = 'public.stella_interactions'::regclass;

  IF v_owner_pre IS NULL THEN
    RAISE EXCEPTION 'stella_0020 postcondition failed: the owner measured before the change is not present in this transaction.';
  END IF;
  IF v_owner_now <> v_owner_pre THEN
    RAISE EXCEPTION
      'stella_0020 postcondition failed: public.stella_interactions is now owned by % and was owned by % when this package started.',
      v_owner_now, v_owner_pre;
  END IF;
  IF v_acl_now IS DISTINCT FROM v_acl_pre THEN
    RAISE EXCEPTION
      'stella_0020 postcondition failed: the ACL of public.stella_interactions changed from [%] to [%]. This package changes no privilege.',
      v_acl_pre, v_acl_now;
  END IF;

  RAISE NOTICE 'stella_0020: public.stella_interactions.model_used = NOT NULL, no default. OK.';
END $$;
