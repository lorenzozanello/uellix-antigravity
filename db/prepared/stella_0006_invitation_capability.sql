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
-- ============================================================================
-- WHY THE FUNCTION IS BUILT IN THE SUPERUSER WINDOW (adversarial review, MAJOR/BLOCKER)
-- ============================================================================
-- An earlier revision created the function as `uellix_owner` and then ran
-- `ALTER FUNCTION … OWNER TO uellix_cap_invitation` in the same window. That
-- fails, and the reason is the half of the check the header used to omit:
--
--   ALTER … OWNER TO requires the CURRENT role to be a member of the new
--   owning role AND requires THE NEW OWNER to hold CREATE on the object's
--   schema.
--
-- The capability role holds only USAGE on `uellix_capability` — deliberately —
-- so `AlterObjectOwner_internal` refuses with «permission denied for schema
-- uellix_capability». stella_0004 never hit this because its 38
-- `ALTER TABLE … OWNER TO` statements ran as a superuser, which short-circuits
-- both checks.
--
-- A second defect had the same root. `CREATE OR REPLACE FUNCTION` as
-- `uellix_owner` on a SECOND apply would fail «must be owner of function»:
-- ownership is resolved with `has_privs_of_role`, and the membership was
-- granted INHERIT FALSE, so uellix_owner does not carry the capability role's
-- privileges outside an explicit SET ROLE. The script claimed to be convergent
-- and was not.
--
-- Doing the whole function lifecycle — CREATE OR REPLACE, ALTER OWNER, REVOKE,
-- GRANT — in the superuser window fixes both, and it removes the reason the
-- capability role needed a member at all. It now has ZERO members, which is
-- what the model always claimed and could not previously assert:
-- `uellix_migrator` is a LOGIN role and reaches `uellix_owner` by SET ROLE, so
-- a membership of uellix_owner in the capability role would have made the
-- capability reachable from a real connection string in two statements.
--
-- The three windows, in order:
--   1. superuser        — preconditions, CREATE ROLE, schema, schema grants
--   2. SET ROLE owner   — DDL on public, the definer's table grants, policies
--   3. superuser again  — the function, its ownership, its ACL, postconditions
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
--   * It grants the capability role to NOBODY — see above.
--   * It does not touch the 10 append-only triggers or any of the 107
--     pre-existing policies.
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
  -- 0.1 Superuser: needed for CREATE ROLE, for GRANT USAGE ON SCHEMA auth
  -- (which `postgres` cannot issue on managed Supabase — RR-09), and for the
  -- function lifecycle in window 3.
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      'stella_0006 must run as a superuser; current_user is %. '
      'See the header: granting CREATEROLE to uellix_owner would undo stella_0004.',
      current_user;
  END IF;

  -- 0.2 The role separation must already be in place.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_0006 requires stella_0004 (uellix_owner is absent).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN
    RAISE EXCEPTION 'stella_0006 requires stella_0004 (uellix_app is absent).';
  END IF;

  -- 0.3 The post-stella_0005c shape this script was written against.
  --
  -- The counts EXCLUDE everything the capability campaign introduces — the
  -- four tables, the cap_/disclosures_ prefixes, and the two marketing_leads
  -- policies stella_0009 retires — so the five packages stay mutually
  -- independent. Pinning a raw global total would have coupled them into an
  -- implicit ordering the design explicitly does not have.
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
END
$$;

-- ============================================================
-- 1. WINDOW 1 (superuser) — the capability role and the schema
-- ============================================================
-- NOLOGIN, no attributes, and — since the adversarial review — NO MEMBERS AT
-- ALL. There is no connection string, session or JWT that resolves to it, and
-- no role that can SET ROLE into it. The only way to execute with its
-- privileges is through the body of its function.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_invitation') THEN
    EXECUTE 'CREATE ROLE uellix_cap_invitation';
  END IF;
END
$$;

ALTER ROLE uellix_cap_invitation
  NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;

COMMENT ON ROLE uellix_cap_invitation IS
  'stella_0006 / CAP-01: definer of uellix_capability.accept_invitation. NOLOGIN, ZERO members, subject to RLS. Reachable only through that function.';

-- The capability schema. Created with IF NOT EXISTS because all five packages
-- are independent and any of them may be applied first; the rollbacks drop it
-- only when it is empty.
CREATE SCHEMA IF NOT EXISTS uellix_capability AUTHORIZATION uellix_owner;

COMMENT ON SCHEMA uellix_capability IS
  'Narrow public/pre-authenticated capabilities. One function family per capability, each owned by its own NOLOGIN definer role. See docs/ops/DATABASE_CAPABILITY_MODEL.md. Never grant broad privileges here.';

-- USAGE goes to the exact caller that needs it and to nobody else. Never to
-- PUBLIC, anon, authenticated or service_role. Note the capability role is NOT
-- granted CREATE here: the ownership transfer happens as superuser precisely
-- so that it never has to be.
REVOKE ALL ON SCHEMA uellix_capability FROM PUBLIC;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_app;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_cap_invitation;

-- The definer calls auth.uid(), and resolving it requires USAGE on schema
-- `auth` FOR THE DEFINER — the executing role inside a SECURITY DEFINER, not
-- the caller. stella_0004 granted that to uellix_owner only.
--
-- This is not a hypothetical: stella_0005d exists solely because stella_0004
-- moved two SECURITY DEFINER functions to an owner without USAGE on `storage`,
-- and every evidence operation was silently refused. Here it would be worse
-- than silent — the failure is SQLSTATE 42501, a DISTINGUISHABLE error, which
-- would puncture the uniform-U0001 refusal the whole enumeration argument
-- rests on.
--
-- RR-09 applies: on managed Supabase `auth` belongs to supabase_auth_admin and
-- `postgres` holds USAGE without GRANT OPTION, so this statement is a remote
-- blocker for CAP-01 exactly as it is for stella_0004.
GRANT USAGE ON SCHEMA auth TO uellix_cap_invitation;

-- ============================================================
-- 2. WINDOW 2 (owner) — DDL on public, definer grants, policies
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
-- idx_invitations_token_hash (db/schema.ts) is non-unique. The function reads
-- with SELECT … INTO, which on a duplicate would take an arbitrary row. A
-- UNIQUE index makes that impossible by construction rather than by argument,
-- and it strictly subsumes the old one — which is therefore dropped rather
-- than left as a second index doing nothing on the same column.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_token_hash
  ON public.invitations (token_hash);

DROP INDEX IF EXISTS public.idx_invitations_token_hash;

-- 2.3 Definer grants — column-scoped wherever the operation allows it.
--
-- These authorize nothing on their own: the definer role is NOLOGIN with zero
-- members, so the only way to exercise them is through the function body in
-- window 3. What they do is bound the blast radius of a bug IN that body.
--
-- `invited_by` and `organization_members.id` are here because the body reads
-- them (the membership carries the inviter, and the audit row carries the new
-- membership id). The adversarial review caught both: a column grant and a
-- `RETURNING id` that names an ungranted column produce «permission denied for
-- table», at run time, on the first real acceptance.


-- The pre-existing SELECT/INSERT/UPDATE policies on the tables this capability
-- touches are `{public}` — they apply to EVERY role, this definer included —
-- and their USING clauses call the three SECURITY DEFINER helpers. stella_0004
-- revoked EXECUTE on those helpers from PUBLIC, so without these three grants
-- the definer raises «permission denied for function current_user_org_ids»
-- (42501) while evaluating a policy that would have been irrelevant to it.
--
-- Discovered by dry run, not by review: the failure is invisible to every
-- static check, because the policy that breaks belongs to another role.
--
-- The grants are safe by construction. The helpers are SECURITY DEFINER owned
-- by uellix_owner, so they run with ITS privileges and read the CALLER's
-- memberships from auth.uid(); invoked from a capability definer with no JWT
-- they return the empty set. `uellix_writer` and `uellix_auditor` already hold
-- the same EXECUTE.
GRANT EXECUTE ON FUNCTION public.current_user_org_ids()        TO uellix_cap_invitation;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO uellix_cap_invitation;
GRANT EXECUTE ON FUNCTION public.current_user_role_in_org(uuid) TO uellix_cap_invitation;

GRANT SELECT (id, organization_id, email, role, status, token_hash, expires_at,
              invited_by, accepted_by)
  ON public.invitations TO uellix_cap_invitation;

-- No UPDATE on token_hash: the capability cannot rewrite a token.
-- No UPDATE on expires_at: it cannot extend an invitation.
GRANT UPDATE (status, accepted_at, accepted_by, updated_at)
  ON public.invitations TO uellix_cap_invitation;

GRANT SELECT (id, user_id, status) ON public.organization_members TO uellix_cap_invitation;
GRANT INSERT (organization_id, user_id, role, status, invited_by, joined_at)
  ON public.organization_members TO uellix_cap_invitation;
-- Deliberately no UPDATE: the capability cannot change anyone's role.

GRANT SELECT (id, email) ON public.users TO uellix_cap_invitation;

GRANT INSERT (organization_id, actor_user_id, entity_type, entity_id, action, after_json)
  ON public.audit_logs TO uellix_cap_invitation;

-- 2.4 Policies — one per (table, operation), all TO the capability role.
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

-- Narrowed to the caller's own row, as CAP-01 §6 said it would be and an
-- earlier revision failed to do. Unlike the invitation lookup — which cannot be
-- expressed as a policy, because a policy cannot see the token — this one CAN
-- be bound: the body only ever reads `id = auth.uid()`. Where a policy can
-- carry the restriction, it should.
DROP POLICY IF EXISTS cap_invitation_select_users ON public.users;
CREATE POLICY cap_invitation_select_users
ON public.users FOR SELECT TO uellix_cap_invitation
USING (id = auth.uid());

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
-- 3. WINDOW 3 (superuser) — the function, its owner, its ACL
-- ============================================================
-- search_path is '' — not 'public, pg_temp'. With pg_temp on the path a caller
-- who can create temporary objects can shadow a function or operator this body
-- resolves, and a SECURITY DEFINER would then run the attacker's version with
-- the definer's privileges. The empty path removes the class entirely: there
-- is no implicit resolution left to hijack.
--
-- Every relation, function and cast below is schema-qualified — with ONE
-- deliberate family of exceptions: COALESCE, NULLIF, GREATEST and LEAST are
-- not functions. They are grammar productions that build CoalesceExpr /
-- NullIfExpr parse nodes, and there are no pg_proc rows with those names, so
-- `pg_catalog.coalesce(...)` parses as an ordinary function call and fails
-- «function pg_catalog.coalesce(...) does not exist» — at RUN time, because
-- plpgsql does not resolve SQL expressions at CREATE FUNCTION. Being grammar
-- rather than a name, they are immune to search_path by construction.

CREATE OR REPLACE FUNCTION uellix_capability.accept_invitation(p_token text)
RETURNS TABLE (organization_id uuid, member_role text)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_subject         uuid;
  v_subject_email   text;
  v_hash            text;
  -- Scalars, not %ROWTYPE. `SELECT *` is expanded at parse time, so it demands
  -- SELECT on EVERY column of invitations — which would defeat the whole point
  -- of a column-scoped grant. Naming the columns keeps the grant narrow AND
  -- makes the read auditable.
  v_inv_id          uuid;
  v_inv_org_id      uuid;
  v_inv_email       text;
  v_inv_role        text;
  v_inv_status      text;
  v_inv_expires_at  timestamp;
  v_inv_invited_by  uuid;
  v_inv_accepted_by uuid;
  v_member_id       uuid;
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

  -- Read WITHOUT the lock first.
  --
  -- `SELECT … FOR UPDATE` is filtered by the UPDATE policy's USING clause, and
  -- this capability's is `USING (status = 'pending')` — deliberately, so the
  -- only transition it can perform is pending -> accepted. The consequence,
  -- measured in the dry run: a locking read of an ALREADY-ACCEPTED row returns
  -- NOT FOUND, so the idempotent-replay branch below was unreachable and a
  -- user reloading the accept page got a refusal instead of their membership.
  --
  -- Reading first without the lock fixes it without loosening the policy. The
  -- replay branch writes nothing, so it needs no lock; the pending path takes
  -- the lock below and re-checks the status under it.
  SELECT i.id, i.organization_id, i.email, i.role, i.status,
         i.expires_at, i.invited_by, i.accepted_by
    INTO v_inv_id, v_inv_org_id, v_inv_email, v_inv_role, v_inv_status,
         v_inv_expires_at, v_inv_invited_by, v_inv_accepted_by
    FROM public.invitations i
   WHERE i.token_hash = v_hash;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- Idempotent replay by the SAME subject: a user reloading the accept page.
  -- Return what the first call returned, and write nothing.
  IF v_inv_status = 'accepted' AND v_inv_accepted_by = v_subject THEN
    RETURN QUERY SELECT v_inv_org_id, v_inv_role;
    RETURN;
  END IF;

  -- Everything that is not a live pending invitation collapses into the one
  -- uniform error: revoked, expired, accepted by someone else, wrong
  -- recipient, already a member. A caller cannot tell them apart, and none of
  -- them writes anything.
  IF v_inv_status <> 'pending' THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- Expiry does NOT write. The previous implementation flipped the row to
  -- 'expired' before raising, which let anyone holding an expired token drive
  -- writes. Sweeping expired invitations is a separate operational job.
  IF v_inv_expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- Compared against public.users, NOT against request.jwt.claims->>'email':
  -- the claim is asserted by the identity provider and may be unverified.
  IF v_subject_email IS NULL
     OR v_subject_email <> pg_catalog.lower(pg_catalog.btrim(v_inv_email)) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.organization_members m
     WHERE m.user_id = v_subject AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- NOW take the lock, and re-check under it. Everything above was decided on
  -- an unlocked read, so a concurrent acceptance could have moved the row in
  -- between; this is the point at which that stops being possible. The row is
  -- still 'pending' as far as this transaction knows, so the UPDATE policy's
  -- USING clause admits it and FOR UPDATE returns it.
  SELECT i.status INTO v_inv_status
    FROM public.invitations i
   WHERE i.id = v_inv_id
     FOR UPDATE;

  IF NOT FOUND OR v_inv_status <> 'pending' THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- The role comes from the ROW — it is what the inviting admin chose. It is
  -- not a parameter, and the policy additionally refuses 'super_admin'.
  INSERT INTO public.organization_members
    (organization_id, user_id, role, status, invited_by, joined_at)
  VALUES
    (v_inv_org_id, v_subject, v_inv_role, 'active', v_inv_invited_by, pg_catalog.now())
  RETURNING id INTO v_member_id;

  UPDATE public.invitations
     SET status      = 'accepted',
         accepted_at = pg_catalog.now(),
         accepted_by = v_subject,
         updated_at  = pg_catalog.now()
   WHERE id = v_inv_id;

  -- actor_user_id is the subject, never NULL: stella_0005c bound audit rows
  -- from a human-facing runtime to the session's user and refuses a NULL actor.
  INSERT INTO public.audit_logs
    (organization_id, actor_user_id, entity_type, entity_id, action, after_json)
  VALUES
    (v_inv_org_id, v_subject, 'invitation', v_inv_id, 'invitation.accepted',
     pg_catalog.jsonb_build_object('userId', v_subject, 'role', v_inv_role));

  INSERT INTO public.audit_logs
    (organization_id, actor_user_id, entity_type, entity_id, action, after_json)
  VALUES
    (v_inv_org_id, v_subject, 'organization_member', v_member_id, 'membership.created',
     pg_catalog.jsonb_build_object('userId', v_subject, 'role', v_inv_role));

  -- Minimum data out. Not the invitation id, not the e-mail, not the inviter.
  RETURN QUERY SELECT v_inv_org_id, v_inv_role;

EXCEPTION
  -- Without this block the uniform refusal is uniform only along the paths the
  -- author enumerated, not along the ones the ENGINE produces. Two are
  -- reachable in normal operation and both are worse than an oracle:
  --
  --   * 23505 from the pre-existing `user_single_active_membership` unique
  --     index, when two concurrent calls race past the EXISTS check above —
  --     DETAIL reads «Key (user_id)=(<uuid>) already exists», i.e. a real user
  --     id in an error string;
  --   * 55P03 from the lock_timeout, which is only reachable when the token
  --     matches a REAL and contended row, so its mere occurrence discloses
  --     that the token exists.
  --
  -- Collapse everything into U0001 and log only the SQLSTATE — never SQLERRM,
  -- which carries the DETAIL that is the problem in the first place.
  WHEN SQLSTATE 'U0001' THEN
    RAISE;
  WHEN OTHERS THEN
    RAISE LOG 'accept_invitation refused with SQLSTATE %', SQLSTATE;
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
END
$$;

ALTER FUNCTION uellix_capability.accept_invitation(text) OWNER TO uellix_cap_invitation;

COMMENT ON FUNCTION uellix_capability.accept_invitation(text) IS
  'CAP-01. Accepts one invitation by raw token. Uniform refusal (SQLSTATE U0001) for every failure mode, so it cannot be used to enumerate. Idempotent for the same subject. See docs/ops/capabilities/CAP_01_INVITATIONS.md.';

-- A function created with a NULL proacl is EXECUTE TO PUBLIC implicitly —
-- measured on this stack and documented in DATABASE_ROLE_MODEL.md §1. The
-- REVOKE is not defensive noise; it is the statement that closes that default.
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
  v_extra    text;
BEGIN
  -- 4.1 The definer role has no way in other than the function. ZERO members,
  -- not "no member except uellix_owner": the earlier check counted DIRECT
  -- members only, and SET ROLE authorisation is TRANSITIVE, so a membership in
  -- uellix_owner would have been reachable from uellix_migrator — a LOGIN role.
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'uellix_cap_invitation') THEN
    RAISE EXCEPTION 'uellix_cap_invitation must be NOLOGIN.';
  END IF;
  IF (SELECT rolbypassrls OR rolcreaterole OR rolcreatedb OR rolsuper
        FROM pg_roles WHERE rolname = 'uellix_cap_invitation') THEN
    RAISE EXCEPTION 'uellix_cap_invitation has a forbidden role attribute.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'uellix_cap_invitation')
  ) THEN
    RAISE EXCEPTION 'uellix_cap_invitation has a member; it must have none.';
  END IF;

  -- 4.2 The function is a SECURITY DEFINER owned by the capability role, with
  -- an EMPTY search_path. Not a prefix match: `LIKE 'search\_path=%'` would
  -- also accept `search_path=public, pg_temp`, which is precisely the
  -- configuration the model forbids — that check would have proved that A path
  -- was set, not that it is empty. The two legal renderings of an empty GUC
  -- value are enumerated instead.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'accept_invitation'
      AND pg_get_userbyid(p.proowner) = 'uellix_cap_invitation'
      AND p.prosecdef
      AND (p.proconfig @> ARRAY['search_path=']::text[]
        OR p.proconfig @> ARRAY['search_path=""']::text[])
  ) THEN
    RAISE EXCEPTION 'accept_invitation is not a SECURITY DEFINER owned by uellix_cap_invitation with an EMPTY search_path.';
  END IF;

  -- 4.3 The definer can resolve auth.uid(). Without this the function raises
  -- 42501 at run time — a DISTINGUISHABLE error, which would break the uniform
  -- refusal the enumeration argument depends on.
  IF NOT pg_catalog.has_schema_privilege('uellix_cap_invitation', 'auth', 'USAGE') THEN
    RAISE EXCEPTION 'uellix_cap_invitation cannot use schema auth; auth.uid() would fail inside the definer.';
  END IF;

  -- 4.4 EXECUTE is held by exactly one non-superuser role besides the owner.
  -- Enumerating pg_roles rather than a name pattern is what makes this
  -- order-independent: it covers uellix_stripe, and any future role, without
  -- the check having to know that role exists.
  SELECT pg_catalog.string_agg(r.rolname, ', ') INTO v_extra
    FROM pg_roles r
   WHERE NOT r.rolsuper
     AND r.rolname NOT IN ('uellix_app', 'uellix_cap_invitation')
     AND pg_catalog.has_function_privilege(
           r.rolname, 'uellix_capability.accept_invitation(text)', 'EXECUTE');
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected roles hold EXECUTE on accept_invitation: %', v_extra;
  END IF;

  IF pg_catalog.has_function_privilege(
       'public', 'uellix_capability.accept_invitation(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC still holds EXECUTE on accept_invitation.';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'uellix_app', 'uellix_capability.accept_invitation(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'uellix_app does not hold EXECUTE on accept_invitation.';
  END IF;

  -- 4.5 The definer must NOT reach anything outside CAP-01. pg_class filtered
  -- by relkind rather than pg_tables: pg_tables omits views, materialised
  -- views, foreign tables and sequences, and a view with a PUBLIC grant would
  -- be a read path this check could not see.
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p','v','m','f')
      AND c.relname NOT IN ('invitations','organization_members','audit_logs','users')
      AND pg_catalog.has_any_column_privilege('uellix_cap_invitation', c.oid, 'SELECT')
  ) THEN
    RAISE EXCEPTION 'uellix_cap_invitation can read a relation outside CAP-01.';
  END IF;

  -- 4.6 It must not be able to rewrite a token or extend an invitation.
  IF pg_catalog.has_column_privilege(
       'uellix_cap_invitation', 'public.invitations', 'token_hash', 'UPDATE') THEN
    RAISE EXCEPTION 'uellix_cap_invitation can UPDATE invitations.token_hash.';
  END IF;
  IF pg_catalog.has_column_privilege(
       'uellix_cap_invitation', 'public.invitations', 'expires_at', 'UPDATE') THEN
    RAISE EXCEPTION 'uellix_cap_invitation can extend an invitation.';
  END IF;

  -- 4.7 Every column the body reads is actually granted. A missing column
  -- grant is a run-time «permission denied for table», discovered by a user
  -- clicking an invitation link.
  IF NOT (pg_catalog.has_column_privilege('uellix_cap_invitation', 'public.invitations', 'invited_by', 'SELECT')
      AND pg_catalog.has_column_privilege('uellix_cap_invitation', 'public.organization_members', 'id', 'SELECT')) THEN
    RAISE EXCEPTION 'a column the function body reads is not granted to uellix_cap_invitation.';
  END IF;


  -- The three RLS helpers must be executable, or every read this capability
  -- makes dies at 42501 while evaluating somebody else's {public} policy.
  IF NOT (pg_catalog.has_function_privilege('uellix_cap_invitation', 'public.current_user_org_ids()', 'EXECUTE')
      AND pg_catalog.has_function_privilege('uellix_cap_invitation', 'public.current_user_is_super_admin()', 'EXECUTE')
      AND pg_catalog.has_function_privilege('uellix_cap_invitation', 'public.current_user_role_in_org(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'uellix_cap_invitation cannot execute the RLS helper functions; every policy-guarded read would fail with 42501.';
  END IF;

  -- 4.8 Six new policies, and only six.
  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND pg_catalog.left(policyname, 15) = 'cap_invitation_';
  IF v_policies <> 6 THEN
    RAISE EXCEPTION 'Expected 6 cap_invitation_* policies, found %.', v_policies;
  END IF;

  -- 4.9 The baseline is untouched: this package adds six policies and alters
  -- none of the 105 that were already there.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND pg_catalog.left(policyname, 4) <> 'cap_'
         AND pg_catalog.left(policyname, 12) <> 'disclosures_'
         AND policyname NOT IN ('anon_insert_marketing_leads',
                                'authenticated_insert_marketing_leads')) <> 105 THEN
    RAISE EXCEPTION 'stella_0006 changed the policy baseline; expected 105.';
  END IF;

  RAISE NOTICE 'stella_0006 applied: CAP-01 capability present, NOT enabled.';
END
$$;
