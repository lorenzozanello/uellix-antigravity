-- db/prepared/stella_0006_invitation_capability.sql
-- CAP-01 — accept an invitation by token, as a narrow capability.
--
-- PREPARED ONLY — NOT A MIGRATION. Lives in db/prepared/ so drizzle-kit never
-- applies it. Rollback: stella_0006_rollback.sql.
--
-- SOURCE OF TRUTH: docs/ops/capabilities/CAP_01_INVITATIONS.md
-- COMMON MODEL:    docs/ops/DATABASE_CAPABILITY_MODEL.md
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. THE CAPABILITY IS NOT ENABLED.
--
-- ============================================================================
-- WHY THIS RUNS AS SUPERUSER (same reason as stella_0004)
-- ============================================================================
-- The normal contract for a prepared script is `uellix_migrator` + an explicit
-- `SET ROLE uellix_owner`. This one cannot follow it: it CREATEs a role, and
-- `uellix_owner` is NOCREATEROLE by design.
--
-- Granting CREATEROLE to uellix_owner would defeat the separation stella_0004
-- established: on PostgreSQL 16+ a non-superuser CREATEROLE role receives
-- ADMIN OPTION automatically on every role it creates, and with that ADMIN
-- OPTION it can grant itself SET on those roles. The separation would exist on
-- paper only. stella_0004 checks exactly this and aborts.
--
-- The script therefore has THREE windows, in this order, and the boundaries
-- are load-bearing rather than cosmetic:
--
--   1. superuser        — preconditions, CREATE ROLE, schema, schema grants
--   2. SET ROLE owner   — DDL on public, the function, its ownership transfer,
--                         the definer's table grants, the policies
--   3. superuser again  — the function's own ACL, then postconditions
--
-- Window 3 is separate on purpose. Once the function belongs to
-- uellix_cap_invitation, `uellix_owner` can no longer GRANT on it: the
-- membership it holds is INHERIT FALSE, so it does not carry that role's
-- rights outside an explicit SET ROLE. Doing the ACL as superuser is
-- unambiguous and needs no second role switch.
--
-- HOW TO APPLY (local, disposable rehearsal only):
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0006_invitation_capability.sql
--
-- ============================================================================
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
-- ============================================================================
--   * It does not set, read or contain a password. uellix_cap_invitation is
--     NOLOGIN; there is no credential to leak.
--   * It does not grant anything to `anon`, `authenticated`, `service_role`,
--     `PUBLIC`, or `uellix_writer`.
--   * It does not grant uellix_app membership in any role.
--   * It does not touch the 10 append-only triggers or any of the 107
--     pre-existing policies.
--   * It does not drop or alter any pre-existing policy, grant or column.
--   * It uses no CASCADE, and no dynamic SQL other than the fixed-literal
--     CREATE ROLE that stella_0004 established as the house pattern.
--   * It does not enable the capability: lib/invitations/service.ts is
--     unchanged and still fails closed.
--
-- Every statement is idempotent AND convergent: a second application produces
-- the same state and changes nothing.
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions — abort before touching anything
-- ============================================================

DO $$
BEGIN
  -- 0.1 Superuser, for the CREATE ROLE window only.
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      'stella_0006 must run as a superuser (it creates a role); current_user is %. '
      'See the header: granting CREATEROLE to uellix_owner would undo stella_0004.',
      current_user;
  END IF;

  -- 0.2 The role separation must already be in place. Without it there is no
  -- uellix_owner to own the capability objects and no uellix_app to grant
  -- EXECUTE to, and every later statement would silently do the wrong thing.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_0006 requires stella_0004 (uellix_owner is absent).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN
    RAISE EXCEPTION 'stella_0006 requires stella_0004 (uellix_app is absent).';
  END IF;

  -- 0.3 The post-stella_0005c shape this script was written against.
  --
  -- The counts EXCLUDE everything the capability campaign introduces, so the
  -- five packages stay mutually independent: applying stella_0007 first must
  -- not make stella_0006's precondition fail. Pinning the raw global total
  -- would have coupled them into an implicit ordering that the design
  -- explicitly does not have.
  IF (SELECT count(*) FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename NOT IN ('report_public_disclosures','capability_verification_hits',
                               'stripe_webhook_events','capability_bootstrap_attempts')) <> 38 THEN
    RAISE EXCEPTION 'Expected 38 non-capability tables in public, found %.',
      (SELECT count(*) FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN ('report_public_disclosures','capability_verification_hits',
                                'stripe_webhook_events','capability_bootstrap_attempts'));
  END IF;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND pg_catalog.left(policyname, 4) <> 'cap_'
         AND pg_catalog.left(policyname, 12) <> 'disclosures_'
         AND policyname NOT IN ('anon_insert_marketing_leads',
                                'authenticated_insert_marketing_leads')) <> 105 THEN
    RAISE EXCEPTION 'Expected 105 baseline policies in public, found %.',
      (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public'
          AND pg_catalog.left(policyname, 4) <> 'cap_'
          AND pg_catalog.left(policyname, 12) <> 'disclosures_'
          AND policyname NOT IN ('anon_insert_marketing_leads',
                                 'authenticated_insert_marketing_leads'));
  END IF;

  -- 0.4 The tables this capability touches must exist with RLS ENABLED.
  -- A table with RLS off would make every policy below decorative.
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('invitations','organization_members','audit_logs','users')
      AND c.relrowsecurity IS FALSE
  ) THEN
    RAISE EXCEPTION 'stella_0006 requires RLS enabled on invitations, organization_members, audit_logs and users.';
  END IF;

  -- 0.5 token_hash must already be unique in practice, or the UNIQUE index
  -- below fails halfway through. Report the COUNT, never a value: a duplicated
  -- token hash is still a token hash.
  IF EXISTS (
    SELECT 1 FROM public.invitations GROUP BY token_hash HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'stella_0006 cannot create a UNIQUE index on invitations.token_hash: % duplicate hashes exist. Resolve them first.',
      (SELECT count(*) FROM (SELECT token_hash FROM public.invitations GROUP BY token_hash HAVING count(*) > 1) d);
  END IF;

  -- 0.6 Nothing may already own the names this script introduces.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'accept_invitation'
      AND pg_get_userbyid(p.proowner) <> 'uellix_cap_invitation'
  ) THEN
    RAISE EXCEPTION 'uellix_capability.accept_invitation exists with an unexpected owner.';
  END IF;
END
$$;

-- ============================================================
-- 1. WINDOW 1 (superuser) — the capability role
-- ============================================================
-- NOLOGIN, no attributes, no memberships. There is no connection string that
-- resolves to it, and no role can SET ROLE to it except uellix_owner — which
-- is granted membership below solely so it can transfer ownership of the
-- function. INHERIT FALSE means uellix_owner does NOT carry these privileges
-- during normal operation; it acquires them only inside an explicit SET ROLE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_invitation') THEN
    EXECUTE 'CREATE ROLE uellix_cap_invitation';
  END IF;
END
$$;

ALTER ROLE uellix_cap_invitation
  NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;

GRANT uellix_cap_invitation TO uellix_owner WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;

COMMENT ON ROLE uellix_cap_invitation IS
  'stella_0006 / CAP-01: definer of uellix_capability.accept_invitation. NOLOGIN, no memberships, subject to RLS. Reachable only through that function.';

-- The capability schema. Created with IF NOT EXISTS because all five packages
-- are independent and any of them may be applied first; the rollbacks drop it
-- only when it is empty.
CREATE SCHEMA IF NOT EXISTS uellix_capability AUTHORIZATION uellix_owner;

COMMENT ON SCHEMA uellix_capability IS
  'Narrow public/pre-authenticated capabilities. One function family per capability, each owned by its own NOLOGIN definer role. See docs/ops/DATABASE_CAPABILITY_MODEL.md. Never grant broad privileges here.';

-- USAGE goes to the exact caller that needs it and to nobody else. Never to
-- PUBLIC, anon, authenticated or service_role.
REVOKE ALL ON SCHEMA uellix_capability FROM PUBLIC;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_app;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_cap_invitation;

-- ============================================================
-- 2. WINDOW 2 (owner) — schema changes, function, grants, policies
-- ============================================================

SET ROLE uellix_owner;

-- 2.1 Record WHO accepted.
--
-- acceptInvitation() sets accepted_at, but nothing records the subject: the
-- attribution lived only in audit_logs, so the row itself could not answer
-- "was this accepted by the person it was issued to?" — which is precisely
-- the question the idempotent-replay branch of the function has to answer.
ALTER TABLE public.invitations
  ADD COLUMN IF NOT EXISTS accepted_by uuid REFERENCES public.users(id);

COMMENT ON COLUMN public.invitations.accepted_by IS
  'stella_0006 / CAP-01: the auth.uid() that accepted this invitation. NULL for invitations accepted before the capability existed — that is the truth, not a gap to backfill.';

-- 2.2 Make the token-hash lookup provably single-row.
--
-- idx_invitations_token_hash is non-unique. The function reads with
-- `SELECT ... INTO`, which on a duplicate would take an arbitrary row. A
-- UNIQUE index makes that impossible by construction rather than by argument.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_token_hash
  ON public.invitations (token_hash);

-- 2.3 The capability function.
--
-- search_path is '' — not 'public, pg_temp'. With pg_temp on the path a caller
-- who can create temporary objects can shadow a function or operator this body
-- resolves, and a SECURITY DEFINER would then run the attacker's version with
-- the definer's privileges. The empty path removes the class entirely: there
-- is no implicit resolution left to hijack. Every reference below is
-- schema-qualified, pg_catalog included, so the rule is checkable by lint
-- rather than by reading.

CREATE OR REPLACE FUNCTION uellix_capability.accept_invitation(p_token text)
RETURNS TABLE (organization_id uuid, member_role text)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_subject       uuid;
  v_subject_email text;
  v_hash          text;
  v_inv           public.invitations%ROWTYPE;
  v_member_id     uuid;
BEGIN
  -- A FOR UPDATE with no bound is a denial-of-service vector: one open
  -- transaction holding the row stalls every acceptance behind it. Fail fast,
  -- into the same uniform error as everything else.
  SET LOCAL lock_timeout = '3s';

  -- The subject NEVER arrives as a parameter. No JWT, no capability.
  v_subject := auth.uid();
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- Resolved BEFORE the invitation is looked up, deliberately.
  --
  -- If the e-mail were fetched only on the branch that needs it, the path
  -- "valid token, wrong recipient" would run one more query than the path
  -- "token does not exist", and the difference would be observable as timing.
  -- Doing it unconditionally costs one primary-key lookup and makes both paths
  -- execute the same number of statements. (RR-CAP-01-A.)
  SELECT pg_catalog.lower(pg_catalog.btrim(u.email))
    INTO v_subject_email
    FROM public.users u
   WHERE u.id = v_subject;

  -- Shape check before the index probe: the token is 32 random bytes in hex.
  -- Anything else is not a near-miss, it is noise.
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- Hashed HERE, not by the caller. convert_to pins the encoding: without it
  -- the digest would depend on client_encoding, so one token could hash two
  -- ways. pg_catalog.sha256 is a builtin — no pgcrypto, so no reference to the
  -- `extensions` schema from a function whose search_path is empty.
  v_hash := pg_catalog.encode(
              pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')),
              'hex'
            );

  SELECT * INTO v_inv
    FROM public.invitations i
   WHERE i.token_hash = v_hash
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- Idempotent replay by the SAME subject: a user reloading the accept page.
  -- Return what the first call returned, and write nothing.
  IF v_inv.status = 'accepted' AND v_inv.accepted_by = v_subject THEN
    RETURN QUERY SELECT v_inv.organization_id, v_inv.role::text;
    RETURN;
  END IF;

  -- Everything that is not a live pending invitation collapses into the one
  -- uniform error: revoked, expired, accepted by someone else, wrong
  -- recipient, already a member. A caller cannot tell them apart, and none of
  -- them writes anything.
  IF v_inv.status <> 'pending' THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- Expiry does NOT write. The previous implementation flipped the row to
  -- 'expired' before raising, which let anyone holding an expired token drive
  -- writes. Sweeping expired invitations is a separate operational job.
  IF v_inv.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- Compared against public.users, NOT against request.jwt.claims->>'email':
  -- the claim is asserted by the identity provider and may be unverified.
  IF v_subject_email IS NULL
     OR v_subject_email <> pg_catalog.lower(pg_catalog.btrim(v_inv.email)) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.organization_members m
     WHERE m.user_id = v_subject AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- The role comes from the ROW — it is what the inviting admin chose. It is
  -- not a parameter, and the policy additionally refuses 'super_admin'.
  INSERT INTO public.organization_members
    (organization_id, user_id, role, status, invited_by, joined_at)
  VALUES
    (v_inv.organization_id, v_subject, v_inv.role, 'active', v_inv.invited_by, pg_catalog.now())
  RETURNING id INTO v_member_id;

  UPDATE public.invitations
     SET status      = 'accepted',
         accepted_at = pg_catalog.now(),
         accepted_by = v_subject,
         updated_at  = pg_catalog.now()
   WHERE id = v_inv.id;

  -- actor_user_id is the subject, never NULL: stella_0005c bound audit rows
  -- from a human-facing runtime to the session's user and refuses a NULL actor.
  INSERT INTO public.audit_logs
    (organization_id, actor_user_id, entity_type, entity_id, action, after_json)
  VALUES
    (v_inv.organization_id, v_subject, 'invitation', v_inv.id, 'invitation.accepted',
     pg_catalog.jsonb_build_object('userId', v_subject, 'role', v_inv.role));

  INSERT INTO public.audit_logs
    (organization_id, actor_user_id, entity_type, entity_id, action, after_json)
  VALUES
    (v_inv.organization_id, v_subject, 'organization_member', v_member_id, 'membership.created',
     pg_catalog.jsonb_build_object('userId', v_subject, 'role', v_inv.role));

  -- Minimum data out. Not the invitation id, not the e-mail, not the inviter.
  RETURN QUERY SELECT v_inv.organization_id, v_inv.role::text;
END
$$;

ALTER FUNCTION uellix_capability.accept_invitation(text) OWNER TO uellix_cap_invitation;

COMMENT ON FUNCTION uellix_capability.accept_invitation(text) IS
  'CAP-01. Accepts one invitation by raw token. Uniform refusal (SQLSTATE U0001) for every failure mode, so it cannot be used to enumerate. Idempotent for the same subject. See docs/ops/capabilities/CAP_01_INVITATIONS.md.';

-- 2.4 Definer grants — column-scoped wherever the operation allows it.
--
-- These authorize nothing on their own: the definer role is NOLOGIN with no
-- members, so the only way to exercise them is through the function body
-- above. What they do is bound the blast radius of a bug IN that body.

GRANT SELECT (id, organization_id, email, role, status, token_hash, expires_at, accepted_by)
  ON public.invitations TO uellix_cap_invitation;

-- No UPDATE on token_hash: the capability cannot rewrite a token.
-- No UPDATE on expires_at: it cannot extend an invitation.
GRANT UPDATE (status, accepted_at, accepted_by, updated_at)
  ON public.invitations TO uellix_cap_invitation;

GRANT SELECT (user_id, status) ON public.organization_members TO uellix_cap_invitation;
GRANT INSERT (organization_id, user_id, role, status, invited_by, joined_at)
  ON public.organization_members TO uellix_cap_invitation;
-- Deliberately no UPDATE: the capability cannot change anyone's role.

GRANT SELECT (id, email) ON public.users TO uellix_cap_invitation;

GRANT INSERT (organization_id, actor_user_id, entity_type, entity_id, action, after_json)
  ON public.audit_logs TO uellix_cap_invitation;

-- 2.5 Policies — one per (table, operation), all TO the capability role.
--
-- None is TO PUBLIC. RLS stays enabled for the definer, so a missing policy
-- fails CLOSED rather than passing silently — the failure mode stella_0005c
-- had to repair when service_role's BYPASSRLS made policy text irrelevant.

DROP POLICY IF EXISTS cap_invitation_select_invitations ON public.invitations;
CREATE POLICY cap_invitation_select_invitations
ON public.invitations FOR SELECT TO uellix_cap_invitation
USING (true);

-- The ONLY transition this capability may perform is pending -> accepted.
-- Revoking, expiring or reopening an invitation is outside its reach even if
-- the function body were rewritten to attempt it.
DROP POLICY IF EXISTS cap_invitation_update_invitations ON public.invitations;
CREATE POLICY cap_invitation_update_invitations
ON public.invitations FOR UPDATE TO uellix_cap_invitation
USING (status = 'pending')
WITH CHECK (status = 'accepted' AND accepted_by IS NOT NULL);

DROP POLICY IF EXISTS cap_invitation_select_members ON public.organization_members;
CREATE POLICY cap_invitation_select_members
ON public.organization_members FOR SELECT TO uellix_cap_invitation
USING (true);

-- role <> 'super_admin' duplicates a check createInvitation() already makes.
-- The duplication is the point: the two live in different layers, and the
-- database one survives a rewrite of the application one.
DROP POLICY IF EXISTS cap_invitation_insert_members ON public.organization_members;
CREATE POLICY cap_invitation_insert_members
ON public.organization_members FOR INSERT TO uellix_cap_invitation
WITH CHECK (status = 'active' AND role <> 'super_admin');

DROP POLICY IF EXISTS cap_invitation_select_users ON public.users;
CREATE POLICY cap_invitation_select_users
ON public.users FOR SELECT TO uellix_cap_invitation
USING (true);

DROP POLICY IF EXISTS cap_invitation_insert_audit ON public.audit_logs;
CREATE POLICY cap_invitation_insert_audit
ON public.audit_logs FOR INSERT TO uellix_cap_invitation
WITH CHECK (
  actor_user_id IS NOT NULL
  AND entity_type IN ('invitation','organization_member')
  AND action IN ('invitation.accepted','membership.created')
);

RESET ROLE;

-- ============================================================
-- 3. WINDOW 3 (superuser) — the function's own ACL
-- ============================================================
-- A function created with a NULL proacl is EXECUTE TO PUBLIC implicitly —
-- measured on this stack and documented in DATABASE_ROLE_MODEL.md §1. The
-- REVOKE is not defensive noise; it is the statement that closes that default.
--
-- Done as superuser because the function now belongs to uellix_cap_invitation
-- and uellix_owner holds that role with INHERIT FALSE.

REVOKE ALL ON FUNCTION uellix_capability.accept_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uellix_capability.accept_invitation(text) TO uellix_app;

-- ============================================================
-- 4. Postconditions — assert what was just built
-- ============================================================
-- A script that reports success without checking is a script that reports
-- success. Each of these would have caught a real mistake while authoring.

DO $$
DECLARE
  v_policies integer;
BEGIN
  -- 4.1 The definer role has no way in other than the function.
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'uellix_cap_invitation') THEN
    RAISE EXCEPTION 'uellix_cap_invitation must be NOLOGIN.';
  END IF;
  IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'uellix_cap_invitation') THEN
    RAISE EXCEPTION 'uellix_cap_invitation must be NOBYPASSRLS.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.member
    WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'uellix_cap_invitation')
      AND r.rolname <> 'uellix_owner'
  ) THEN
    RAISE EXCEPTION 'uellix_cap_invitation has a member other than uellix_owner.';
  END IF;

  -- 4.2 The function is a SECURITY DEFINER owned by the capability role, with
  -- an explicitly set (and empty) search_path. The proconfig entry is matched
  -- by prefix rather than by exact text: PostgreSQL is free to render an empty
  -- GUC value as `search_path=` or `search_path=""`, and pinning one spelling
  -- would make this check fail on a detail it does not care about.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'accept_invitation'
      AND pg_get_userbyid(p.proowner) = 'uellix_cap_invitation'
      AND p.prosecdef
      AND p.proconfig IS NOT NULL
      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search\_path=%')
  ) THEN
    RAISE EXCEPTION 'accept_invitation is not a SECURITY DEFINER owned by uellix_cap_invitation with an explicit search_path.';
  END IF;

  -- 4.3 PUBLIC must not hold EXECUTE; uellix_app must.
  IF pg_catalog.has_function_privilege(
       'public', 'uellix_capability.accept_invitation(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC still holds EXECUTE on accept_invitation.';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'uellix_app', 'uellix_capability.accept_invitation(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'uellix_app does not hold EXECUTE on accept_invitation.';
  END IF;

  -- 4.4 Cross-capability isolation: no OTHER capability role may execute this.
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname LIKE 'uellix\_cap\_%'
      AND r.rolname <> 'uellix_cap_invitation'
      AND pg_catalog.has_function_privilege(
            r.rolname, 'uellix_capability.accept_invitation(text)', 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'another capability role can execute accept_invitation.';
  END IF;

  -- 4.5 The definer must NOT reach the SROI pipeline. has_any_column_privilege
  -- rather than has_table_privilege: the grants above are column-scoped, so a
  -- table-level check would report false even where a column grant existed.
  IF EXISTS (
    SELECT 1 FROM pg_tables t
    WHERE t.schemaname = 'public'
      AND t.tablename IN ('projects','sroi_reports','sroi_calculation_runs',
                          'evidence_items','stella_interactions','marketing_leads')
      AND pg_catalog.has_any_column_privilege(
            'uellix_cap_invitation',
            ('public.' || pg_catalog.quote_ident(t.tablename))::regclass, 'SELECT')
  ) THEN
    RAISE EXCEPTION 'uellix_cap_invitation can read a table outside CAP-01.';
  END IF;

  -- 4.6 It must not be able to rewrite a token.
  IF pg_catalog.has_column_privilege(
       'uellix_cap_invitation', 'public.invitations', 'token_hash', 'UPDATE') THEN
    RAISE EXCEPTION 'uellix_cap_invitation can UPDATE invitations.token_hash.';
  END IF;

  -- 4.7 Six new policies, and only six.
  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND policyname LIKE 'cap\_invitation\_%';
  IF v_policies <> 6 THEN
    RAISE EXCEPTION 'Expected 6 cap_invitation_* policies, found %.', v_policies;
  END IF;

  -- 4.8 The baseline is untouched: this package adds six policies and alters
  -- none of the 107 that were already there.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND pg_catalog.left(policyname, 4) <> 'cap_'
         AND pg_catalog.left(policyname, 12) <> 'disclosures_'
         AND policyname NOT IN ('anon_insert_marketing_leads',
                                'authenticated_insert_marketing_leads')) <> 105 THEN
    RAISE EXCEPTION 'stella_0006 changed the non-capability policy baseline; expected 105, found %.',
      (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public'
          AND pg_catalog.left(policyname, 4) <> 'cap_'
          AND pg_catalog.left(policyname, 12) <> 'disclosures_'
          AND policyname NOT IN ('anon_insert_marketing_leads',
                                 'authenticated_insert_marketing_leads'));
  END IF;

  RAISE NOTICE 'stella_0006 applied: CAP-01 capability present, NOT enabled.';
END
$$;
