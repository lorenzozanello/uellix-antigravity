-- db/prepared/stella_0012_super_admin_column_acl.sql
-- SUPER_ADMIN_COLUMN_HARDENING — closes the self-escalation that blocked RR-CAP-10.
--
-- PREPARED ONLY — NOT A MIGRATION. Rollback: stella_0012_rollback.sql.
--
-- SOURCE OF TRUTH: docs/ops/STELLA_FABLE_RISK_REGISTER.md (RR-CAP-15)
-- COMMON MODEL:    docs/ops/DATABASE_CAPABILITY_MODEL.md
-- UNBLOCKS:        stella_0011 / RR-CAP-10
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE.
--
-- ============================================================================
-- THE DEFECT, AND WHY IT VOIDED THE PREVIOUS PACKAGE
-- ============================================================================
-- stella_0011 moved stella_monthly_quota, stella_plan_label and status behind
-- `public.current_user_is_super_admin()`. That predicate reads ONE column:
--
--     SELECT u.is_super_admin FROM public.users u WHERE u.id = auth.uid()
--
-- and every layer let the caller write it:
--
--   * `GRANT SELECT,INSERT,UPDATE ON TABLE public.users` to `authenticated`
--     AND to `uellix_writer` — TABLE level, so every column including
--     is_super_admin;
--   * `users_update_own` has NO `TO` clause, so it is TO PUBLIC, and its
--     predicate is `id = auth.uid()` in both USING and WITH CHECK;
--   * `public.users` carries no trigger of any kind;
--   * `is_super_admin boolean DEFAULT false NOT NULL` has no CHECK.
--
-- So any authenticated subject could run, through the ORM or through PostgREST:
--
--     UPDATE public.users SET is_super_admin = true WHERE id = auth.uid();
--
-- and then satisfy `cap_platform_only_super_admin` and the body check of both
-- admin_* functions. The quota boundary stella_0011 built was real; the
-- predicate it delegated to was self-granting.
--
-- WHY ROW-SCOPING FAILS HERE AND SUCCEEDS ELSEWHERE. `users_update_own` says
-- "you may update your own row", which is the correct rule for a profile — and
-- catastrophic the moment a PRIVILEGE lives in that row. Contrast
-- `organization_members`, where the privilege column `role` is bounded by a
-- ROLE predicate (`members_update_admin`) rather than by ownership: there a
-- viewer cannot reach the column at all. Ownership is a safe bound for data
-- about you; it is never a safe bound for authority over you.
--
-- This is the same shape as RR-CAP-10 itself — table-level UPDATE plus a
-- row-scoped policy and no column bound — one table over, and it is the reason
-- the final reaudit returned BLOCKED_QUOTA.
--
-- ============================================================================
-- WHERE THE COLUMN LISTS COME FROM
-- ============================================================================
-- Re-derived from the code for this package, not inherited from the previous
-- audit.
--
-- public.users — ONE write in the entire application:
--
--   lib/auth/session.ts:304
--     db.insert(users).values({ id, email, fullName, avatarUrl })
--       .onConflictDoUpdate({ target: users.id,
--                             set: { email, fullName, avatarUrl, updatedAt } })
--
-- and that is why this package grants four UPDATE columns rather than none.
-- `ON CONFLICT ... DO UPDATE` requires the UPDATE privilege on every column in
-- its SET list, so a blanket REVOKE would break session bootstrap on the
-- second sign-in of every user — a failure that would not appear until an
-- account already existed. There is NO other UPDATE of public.users anywhere
-- under app/, lib/ or db/, and nothing in the application ever writes
-- is_super_admin.
--
-- public.organization_members — three writes:
--
--   app/app/onboarding/actions.ts:113   INSERT (founder membership)
--   lib/invitations/service.ts:193      INSERT (accepted invitation)
--   lib/organizations/members.ts:49     UPDATE .set({ status:'removed', updatedAt })
--
-- so the runtime's legitimate UPDATE surface is exactly `status, updated_at`.
-- There is no role-change feature in this product: removing a member sets
-- status, it does not rewrite role.
--
-- `role` is included here because it is AUTHORITY: ROLE_HIERARCHY scores
-- org-scoped 'super_admin' at 100 against 'organization_admin' at 80
-- (lib/auth/roles.ts), and lib/projects/service.ts:292 gates project deletion
-- on `role === 'super_admin'` specifically.
--
-- A CORRECTION AN ADVERSARIAL REVIEWER FORCED. An earlier draft justified this
-- by saying CAP-01 and CAP-05 already refuse to mint a super_admin membership.
-- They do — FOR THEIR OWN DEFINER ROLES. `cap_invitation_only_member` is
-- `TO uellix_cap_invitation` and `cap_bootstrap_only_founder` is
-- `TO uellix_cap_bootstrap`; a RESTRICTIVE policy applies only to the roles it
-- names, so neither constrains `uellix_app` or `authenticated` by one bit. The
-- premise was false and the conclusion needed a different argument, which
-- §1.1bis supplies.
--
-- ============================================================================
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
-- ============================================================================
--   * It does NOT touch `service_role` (RR-CAP-10-C, RR-CAP-7). Anything
--     holding the Supabase service key still bypasses all of this.
--   * It does NOT touch any BASELINE policy. `users_update_own` stays exactly
--     as it is: for a COLUMN the repair is an ACL, because a row policy cannot
--     express "this column changed" — the argument stella_0011 makes at length.
--     It DOES add one RESTRICTIVE policy, `cap_members_no_super_admin_grant`, and
--     the distinction is the point: that one bounds a VALUE on INSERT, which no
--     column privilege can express. ACL for columns, policy for values.
--   * It does NOT revoke INSERT. Session bootstrap and both membership
--     inserts need it, and `handle_new_user()` pins is_super_admin to false on
--     the INSERT path it owns.
--   * It does NOT revoke DELETE on organization_members. DELETE + INSERT was
--     the escalation chain, and it is broken at the INSERT by
--     `cap_members_no_super_admin_grant`; narrowing DELETE as well is a separate
--     impact analysis (removing a member is legitimate admin behaviour).
--
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0012_super_admin_column_acl.sql
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions
-- ============================================================

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0012 must run as a superuser; current_user is %.', current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_writer') THEN
    RAISE EXCEPTION 'stella_0012 requires stella_0004 (uellix_writer is absent).';
  END IF;

  -- The two tables, asserted by NAME. A count would be satisfied by a renamed
  -- privilege column, and the grant below enumerates.
  IF EXISTS (
    SELECT unnest(ARRAY['id','email','full_name','avatar_url','created_at',
                        'updated_at','is_super_admin','deleted_at','deleted_by']) AS c
    EXCEPT
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users'
  ) THEN
    RAISE EXCEPTION 'stella_0012: public.users is missing a column this package classifies by name.';
  END IF;
  IF EXISTS (
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users'
    EXCEPT
    SELECT unnest(ARRAY['id','email','full_name','avatar_url','created_at',
                        'updated_at','is_super_admin','deleted_at','deleted_by'])
  ) THEN
    RAISE EXCEPTION 'stella_0012: public.users has a column this package does not classify. Classify it before applying.';
  END IF;

  IF EXISTS (
    SELECT unnest(ARRAY['id','organization_id','user_id','role','status',
                        'invited_by','joined_at','created_at','updated_at']) AS c
    EXCEPT
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organization_members'
  ) THEN
    RAISE EXCEPTION 'stella_0012: public.organization_members is missing a column this package classifies by name.';
  END IF;

  IF (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'users') IS NOT TRUE THEN
    RAISE EXCEPTION 'stella_0012 requires RLS enabled on public.users.';
  END IF;

  -- The profile-sync triggers must exist and be SECURITY DEFINER, because this
  -- package's safety argument is that they are UNAFFECTED: they run with
  -- uellix_owner's privileges, not the runtime's, so revoking the runtime's
  -- UPDATE cannot break them.
  -- BOTH, counted. `EXISTS (… WHERE proname IN (a,b))` is satisfied by EITHER,
  -- and the comment above is plural: handle_update_user is the one that issues
  -- a bare UPDATE public.users, so it is the one whose SECURITY DEFINER status
  -- this REVOKE actually depends on. Found by adversarial review.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('handle_new_user','handle_update_user')
         AND p.prosecdef) <> 2 THEN
    RAISE EXCEPTION 'stella_0012 requires BOTH SECURITY DEFINER profile-sync functions; without them a REVOKE here would break sign-up or e-mail changes.';
  END IF;

  -- The two baseline objects the safety of leaving INSERT open rests on, named
  -- rather than assumed: the unique membership index is what stops SELF
  -- escalation by INSERT, and members_update_admin is what makes `status`
  -- safe to grant even though current_user_role_in_org() reads it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'organization_members' AND c.conname = 'organization_members_org_user_unique'
  ) THEN
    RAISE EXCEPTION 'stella_0012 requires organization_members_org_user_unique; without it a subject could INSERT a second membership for itself.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND policyname = 'members_update_admin') THEN
    RAISE EXCEPTION 'stella_0012 requires members_update_admin; it is what bounds the status column this package grants.';
  END IF;
END
$$;

-- ============================================================
-- 1. WINDOW 1 (owner) — the column ACL
-- ============================================================

SET ROLE uellix_owner;

-- 1.1 public.users
--
-- REVOKE first, from every principal, unconditionally. `anon` and PUBLIC do
-- not hold it in the measured baseline; naming them makes this a convergence
-- step rather than a description of one database.
REVOKE UPDATE ON public.users FROM authenticated, uellix_writer, anon, PUBLIC;

-- The four columns the ON CONFLICT ... DO UPDATE of session bootstrap writes,
-- alphabetical, one per line, so adding one is a diff nobody skims past.
GRANT UPDATE (
  avatar_url,
  email,
  full_name,
  updated_at
) ON public.users TO uellix_writer;

-- `authenticated` gets NOTHING back. It has no call site: the only write to
-- public.users in the repository goes through the ORM as uellix_app. Leaving
-- it a column grant would keep a PostgREST-reachable write surface alive for a
-- principal that never uses it.

-- 1.1bis. The value bound a column ACL cannot express (RR-CAP-15-A).
--
-- Revoking UPDATE (role) was not enough, and an adversarial reviewer showed why
-- in two statements. `members_insert_admin` is a {public} baseline policy whose
-- WITH CHECK constrains only `current_user_role_in_org(NEW.organization_id)`;
-- it places NO bound on NEW.role, and `role_check` permits 'super_admin'.
-- `authenticated` and `uellix_writer` keep table-level INSERT and DELETE. So an
-- organisation admin could run:
--
--     DELETE FROM organization_members WHERE organization_id=X AND user_id=<other>;
--     INSERT INTO organization_members (organization_id,user_id,role,status)
--     VALUES (X,<other>,'super_admin','active');
--
-- Both statements pass, because the actor's own admin row is untouched. That is
-- a role-rewrite primitive over every member of the org, and org-scoped
-- 'super_admin' is a real step up: ROLE_HIERARCHY scores it 100 against 80
-- (lib/auth/roles.ts), and lib/projects/service.ts:292 gates project deletion
-- on `role === 'super_admin'` specifically. `createInvitation` refuses it at
-- lib/invitations/service.ts:46 — an application check the database did not
-- reproduce for the runtime roles.
--
-- A COLUMN ACL CANNOT FIX THIS. INSERT column privileges say which columns may
-- be written, never which VALUES. This is the one case in the campaign where a
-- RESTRICTIVE policy is the correct instrument rather than the lazy one, and it
-- is scoped to the two runtime principals so that CAP-01 and CAP-05 — which
-- carry their own bounds for their own definers — are untouched.
-- The `cap_` prefix is LOAD-BEARING, not decoration: every capability package
-- asserts a baseline of 105 policies computed as "everything not prefixed
-- cap_ or disclosures_", so a policy named outside that convention makes
-- stella_0006..0010 abort on their SECOND apply. Measured in the dry run.
DROP POLICY IF EXISTS cap_members_no_super_admin_grant ON public.organization_members;
CREATE POLICY cap_members_no_super_admin_grant
ON public.organization_members AS RESTRICTIVE FOR INSERT TO uellix_app, authenticated
WITH CHECK (role <> 'super_admin');

COMMENT ON COLUMN public.users.is_super_admin IS
  'RR-CAP-15. THE platform authority bit: public.current_user_is_super_admin() reads this column and nothing else, and 114 policy predicates in this schema call that function. NOT in any runtime UPDATE grant — a subject cannot make itself a platform super_admin. It is set by an operator out of band, or by handle_new_user() which pins it to false. service_role can still write it (RR-CAP-10-C).';
COMMENT ON COLUMN public.users.deleted_at IS
  'RR-CAP-15. Administrative. Outside the runtime UPDATE grant: soft-deletion of a user is not a profile edit.';

-- 1.2 public.organization_members
REVOKE UPDATE ON public.organization_members FROM authenticated, uellix_writer, anon, PUBLIC;

GRANT UPDATE (
  status,
  updated_at
) ON public.organization_members TO uellix_writer;

COMMENT ON COLUMN public.organization_members.role IS
  'RR-CAP-15. Membership authority. Outside the runtime UPDATE grant, and bounded on INSERT by cap_members_no_super_admin_grant (RESTRICTIVE). NOTE: cap_invitation_only_member and cap_bootstrap_only_founder bound only their own definer roles — a RESTRICTIVE policy applies to the roles it names — so they constrain nothing for uellix_app or authenticated. There is no role-change feature in the product: removing a member sets status.';

RESET ROLE;

-- ============================================================
-- 2. Postconditions
-- ============================================================

DO $$
DECLARE
  v_role text;
  v_col  text;
BEGIN
  -- 2.1 The escalation itself, from every principal that could hold it.
  -- Driven from the CATALOGUE, not from a hand-written list. The first version
  -- named two of the six capability definers and skipped a missing name in
  -- silence, so a rename would have degraded the assertion to "true".
  FOR v_role IN
    SELECT rolname FROM pg_roles
     WHERE rolname IN ('uellix_writer','uellix_app','authenticated','anon','uellix_auditor')
        OR rolname LIKE 'uellix_cap%'
        OR rolname = 'uellix_stripe'
  LOOP

    IF pg_catalog.has_column_privilege(v_role, 'public.users', 'is_super_admin', 'UPDATE') THEN
      RAISE EXCEPTION '% can UPDATE users.is_super_admin; the platform authority bit is self-granting.', v_role;
    END IF;
    FOREACH v_col IN ARRAY ARRAY['id','created_at','deleted_at','deleted_by']
    LOOP
      IF pg_catalog.has_column_privilege(v_role, 'public.users', v_col, 'UPDATE') THEN
        RAISE EXCEPTION '% can UPDATE users.%, which is outside the profile surface.', v_role, v_col;
      END IF;
    END LOOP;
    FOREACH v_col IN ARRAY ARRAY['role','organization_id','user_id','id','invited_by','created_at']
    LOOP
      IF pg_catalog.has_column_privilege(v_role, 'public.organization_members', v_col, 'UPDATE') THEN
        RAISE EXCEPTION '% can UPDATE organization_members.%, which is membership authority.', v_role, v_col;
      END IF;
    END LOOP;
  END LOOP;

  -- `authenticated` must hold UPDATE on NO column of either table.
  IF pg_catalog.has_any_column_privilege('authenticated', 'public.users'::regclass, 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated retains an UPDATE column on public.users; it has no call site.';
  END IF;
  IF pg_catalog.has_any_column_privilege('authenticated', 'public.organization_members'::regclass, 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated retains an UPDATE column on public.organization_members; it has no call site.';
  END IF;

  -- 2.2 …and the legitimate writes still work. A repair that only revokes is
  -- indistinguishable from an outage, and this one would surface on the SECOND
  -- sign-in of every user, not the first.
  FOREACH v_col IN ARRAY ARRAY['email','full_name','avatar_url','updated_at']
  LOOP
    IF NOT pg_catalog.has_column_privilege('uellix_writer', 'public.users', v_col, 'UPDATE') THEN
      RAISE EXCEPTION 'uellix_writer lost UPDATE on users.%, which the ON CONFLICT DO UPDATE of session bootstrap writes.', v_col;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['status','updated_at']
  LOOP
    IF NOT pg_catalog.has_column_privilege('uellix_writer', 'public.organization_members', v_col, 'UPDATE') THEN
      RAISE EXCEPTION 'uellix_writer lost UPDATE on organization_members.%; removing a member would fail.', v_col;
    END IF;
  END LOOP;

  -- INSERT is untouched on both tables: sign-up, the founder membership and an
  -- accepted invitation all depend on it.
  IF NOT pg_catalog.has_column_privilege('uellix_writer', 'public.users', 'email', 'INSERT') THEN
    RAISE EXCEPTION 'uellix_writer lost INSERT on public.users; sign-up would fail.';
  END IF;
  IF NOT pg_catalog.has_column_privilege('uellix_writer', 'public.organization_members', 'role', 'INSERT') THEN
    RAISE EXCEPTION 'uellix_writer lost INSERT on organization_members.role; onboarding and invitation acceptance would fail.';
  END IF;

  -- 2.3 The trigger path is unaffected, which is what makes the REVOKE safe.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'handle_new_user' AND p.prosecdef
      AND pg_get_userbyid(p.proowner) = 'uellix_owner'
  ) THEN
    RAISE EXCEPTION 'handle_new_user is no longer a SECURITY DEFINER owned by uellix_owner; the safety argument of this package does not hold.';
  END IF;

  -- 2.4 No baseline policy was touched. The repair is ACL, and saying so is
  -- checkable — BY NAME, not by count. A count here would be a cross-package
  -- census: CAP-01 and CAP-05 add their own policies to both of these tables,
  -- so the number depends on which capability packages happen to be applied,
  -- and this package would abort or pass for reasons that have nothing to do
  -- with it. (The same fragility an adversarial reviewer flagged as a NIT on
  -- stella_0008 and stella_0011; it is a defect here, so it is fixed here.)
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND policyname IN ('users_insert_own','users_select_own','users_update_own',
                            'members_delete_admin','members_insert_admin',
                            'members_select_own_org','members_update_admin')) <> 7 THEN
    RAISE EXCEPTION 'stella_0012: a baseline policy on users / organization_members is missing; this package must change only the ACL.';
  END IF;

  -- 2.4bis The value bound, which no column ACL can express.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'organization_members'
       AND policyname = 'cap_members_no_super_admin_grant'
       AND permissive = 'RESTRICTIVE' AND cmd = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'cap_members_no_super_admin_grant is absent; an organisation admin could DELETE and re-INSERT a member as super_admin.';
  END IF;

  -- 2.5 The path this package does NOT close, in the operator's terminal.
  IF pg_catalog.has_column_privilege('service_role', 'public.users', 'is_super_admin', 'UPDATE') THEN
    RAISE WARNING 'RR-CAP-10-C: service_role retains table-level UPDATE on public.users and holds BYPASSRLS, so anything with the Supabase service key can still grant itself platform super_admin. Out of scope here.';
  END IF;

  -- 2.6 This package creates no table. Asserted by NAME, not by counting the
  -- schema — the same cross-package census 2.4 rejects four lines above, and it
  -- would have aborted this package the day grounding_0001 adds
  -- public.evidence_chunks. Found by adversarial review, which noted the file
  -- was condemning in one postcondition what it did in the next.
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users')
     OR NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'organization_members') THEN
    RAISE EXCEPTION 'stella_0012: one of the two tables it hardens is absent.';
  END IF;

  RAISE NOTICE 'stella_0012 applied: users.is_super_admin and organization_members.role are outside every runtime UPDATE grant.';
END
$$;
