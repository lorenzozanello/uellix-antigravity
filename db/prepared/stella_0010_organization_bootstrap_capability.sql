-- db/prepared/stella_0010_organization_bootstrap_capability.sql
-- CAP-05 — self-serve organisation bootstrap, as a transactional capability.
--
-- PREPARED ONLY — NOT A MIGRATION. Rollback: stella_0010_rollback.sql.
--
-- SOURCE OF TRUTH: docs/ops/capabilities/CAP_05_ORGANIZATION_BOOTSTRAP.md
-- COMMON MODEL:    docs/ops/DATABASE_CAPABILITY_MODEL.md
--
-- STATUS: DESIGN. NOT APPLIED ANYWHERE. THE CAPABILITY IS NOT ENABLED.
-- app/app/onboarding/actions.ts is unchanged and still fails closed.
--
-- ============================================================================
-- WHY A DEFINER FUNCTION AND NOT A TECHNICAL BOOTSTRAP IDENTITY
-- ============================================================================
-- CAP-03 needs a LOGIN role because Stripe has no human subject. CAP-05 is the
-- opposite case, and the asymmetry is the justification rather than an
-- inconsistency: a technical bootstrap role could create organisations and
-- memberships WITHOUT a subject, so its leaked credential would let an attacker
-- fabricate organisations and attach anyone to anything. This function cannot
-- run at all without auth.uid().
--
-- It also answers, precisely, the objection recorded in members_insert_admin:
--
--   "No self-insert exception needed here — that would allow any user to join
--    any org."
--
-- Correct, and this is not that. The organization_id inserted into
-- organization_members is the id of the row this same transaction just
-- created — not a value the caller can name — and the policy admits only the
-- founding admin role. members_insert_admin and orgs_insert_super_admin are
-- left untouched.
--
-- ============================================================================
-- WHAT THE ADVERSARIAL REVIEW CHANGED (2026-08-03)
-- ============================================================================
-- * The idempotency key is CLAIMED FIRST. The previous body opened with
--   `SELECT … FOR UPDATE` on capability_bootstrap_attempts, which on a first
--   call locks NOTHING — FOR UPDATE cannot lock a row that does not exist yet.
--   The composite primary key was only touched at the very end, as an
--   ON CONFLICT DO UPDATE, which never blocks. So neither of the two documented
--   defences serialised anything, and what actually prevented a duplicate was
--   `user_single_active_membership` — a pre-existing index in db/schema.ts that
--   no capability document mentioned. The insert now happens first, so the PK
--   genuinely serialises concurrent calls with the same key.
-- * `auth.uid()` needs USAGE on schema `auth` FOR THE DEFINER. stella_0004
--   granted it to uellix_owner only, and stella_0005d exists because exactly
--   this was missed once already for schema `storage`.
-- * `pg_catalog.coalesce` / `pg_catalog.nullif` do not exist — COALESCE and
--   NULLIF are grammar productions, not functions.
-- * `RETURNING id` on organization_members requires SELECT on `id`, which the
--   grant did not include.
-- * `ON CONFLICT (slug)` put an OUT variable named `slug` into an expression
--   context; it names the constraint instead.
-- * The function lifecycle moved to the superuser window (see stella_0006).
-- * An EXCEPTION block collapses engine SQLSTATEs — notably the 23505 from
--   user_single_active_membership, whose DETAIL quotes a real user id.
--
--   psql "$LOCAL_SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 \
--     -f db/prepared/stella_0010_organization_bootstrap_capability.sql
--
-- WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
--   * No password, no LOGIN role, no technical identity.
--   * Nothing granted to anon, authenticated, service_role or PUBLIC.
--   * The definer gets NO grant on organizations.stella_monthly_quota,
--     stella_plan_label or any stripe_* column, so the bootstrap CANNOT choose
--     a plan, a quota or a billing flag — enforced by the grant, not by
--     trusting the body not to try.
--   * No UPDATE or DELETE on organizations or organization_members: the
--     capability can create, never modify.
-- ============================================================================

SET search_path = public;

-- ============================================================
-- 0. Preconditions
-- ============================================================

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0010 must run as a superuser; current_user is %.', current_user;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_owner') THEN
    RAISE EXCEPTION 'stella_0010 requires stella_0004 (uellix_owner is absent).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_app') THEN
    RAISE EXCEPTION 'stella_0010 requires stella_0004 (uellix_app is absent).';
  END IF;

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

  -- The slug uniqueness this design relies on for its atomic ON CONFLICT.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'organizations'
      AND c.contype = 'u' AND c.conname = 'organizations_slug_unique'
  ) THEN
    RAISE EXCEPTION 'stella_0010 requires the UNIQUE constraint on organizations.slug.';
  END IF;

  -- The backstop the design now names explicitly instead of relying on
  -- silently. Without it, two concurrent calls with DIFFERENT idempotency keys
  -- could each pass the membership check and each create an organisation.
  -- The backstop, asserted by SHAPE and not by name. An index of that name
  -- that had lost UNIQUE, or whose WHERE status = 'active' had been altered,
  -- would pass a name check while serialising nothing.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'organization_members'
      AND c.relname = 'user_single_active_membership'
      AND i.indisunique AND i.indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'requires the PARTIAL UNIQUE index user_single_active_membership on organization_members; it is the only thing that serialises two concurrent acceptances or bootstraps that use different keys.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('organizations','organization_members','signup_allowlist','audit_logs','users')
      AND c.relrowsecurity IS FALSE
  ) THEN
    RAISE EXCEPTION 'stella_0010 requires RLS enabled on the five tables it touches.';
  END IF;
END
$$;

-- ============================================================
-- 1. WINDOW 1 (superuser) — role and schema
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_cap_bootstrap') THEN
    EXECUTE 'CREATE ROLE uellix_cap_bootstrap';
  END IF;
END
$$;

ALTER ROLE uellix_cap_bootstrap
  NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOSUPERUSER;

COMMENT ON ROLE uellix_cap_bootstrap IS
  'stella_0010 / CAP-05: definer of uellix_capability.bootstrap_organization. NOLOGIN, ZERO members. Can CREATE an organisation and its founding membership; cannot UPDATE or DELETE either, and has no grant on any plan, quota or billing column.';

CREATE SCHEMA IF NOT EXISTS uellix_capability AUTHORIZATION uellix_owner;

REVOKE ALL ON SCHEMA uellix_capability FROM PUBLIC;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_app;
GRANT USAGE ON SCHEMA uellix_capability TO uellix_cap_bootstrap;

-- The definer calls auth.uid(), and resolving it requires USAGE on schema
-- `auth` FOR THE DEFINER — the executing role inside a SECURITY DEFINER, not
-- the caller. stella_0004 granted that to uellix_owner only, and the membership
-- runs the other way besides.
--
-- RR-09 applies: on managed Supabase `auth` belongs to supabase_auth_admin and
-- `postgres` holds USAGE without GRANT OPTION, so this statement is a remote
-- blocker for CAP-05 exactly as it is for stella_0004.
GRANT USAGE ON SCHEMA auth TO uellix_cap_bootstrap;

-- ============================================================
-- 2. WINDOW 2 (owner) — the ledger, grants, policies
-- ============================================================

SET ROLE uellix_owner;

-- 2.1 The idempotency ledger.
--
-- The composite PRIMARY KEY matters twice. It scopes a key to its subject, so
-- one user's key cannot collide with another's and a guessed key can at worst
-- interfere with the guesser's own attempts. And it is what SERIALISES
-- concurrent calls — but only because the function now INSERTs into it before
-- doing anything else. A SELECT … FOR UPDATE on a row that does not exist
-- locks nothing at all.
CREATE TABLE IF NOT EXISTS public.capability_bootstrap_attempts (
  user_id         uuid        NOT NULL REFERENCES public.users(id),
  idempotency_key uuid        NOT NULL,
  organization_id uuid        REFERENCES public.organizations(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (user_id, idempotency_key)
);

COMMENT ON TABLE public.capability_bootstrap_attempts IS
  'CAP-05. Idempotency ledger for organisation bootstrap. Keyed by (user_id, idempotency_key) so a key belongs to its subject. The function claims the key by INSERT before any other write, so the primary key serialises concurrent calls; a failed attempt rolls back with the transaction, freeing its key for a retry.';

ALTER TABLE public.capability_bootstrap_attempts ENABLE ROW LEVEL SECURITY;

-- 2.2 Definer grants — column-scoped.
--
-- Note what is ABSENT from the INSERT list: stella_monthly_quota,
-- stella_plan_label and every stripe_* column. The bootstrap literally cannot
-- name them, so "cannot choose a plan, permission or administrative flag" is a
-- property of the ACL rather than a promise about the body.
--
-- `organization_members.id` is granted for SELECT because the body does
-- `RETURNING id` — which requires SELECT privilege on every column named in
-- RETURNING. The adversarial review caught its absence.

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
GRANT EXECUTE ON FUNCTION public.current_user_org_ids()        TO uellix_cap_bootstrap;
GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO uellix_cap_bootstrap;
GRANT EXECUTE ON FUNCTION public.current_user_role_in_org(uuid) TO uellix_cap_bootstrap;

GRANT SELECT (id, slug) ON public.organizations TO uellix_cap_bootstrap;
GRANT INSERT (name, slug, legal_name, country, sector, status)
  ON public.organizations TO uellix_cap_bootstrap;
-- No UPDATE, no DELETE: it can create, never modify.

GRANT SELECT (id, user_id, status) ON public.organization_members TO uellix_cap_bootstrap;
GRANT INSERT (organization_id, user_id, role, status, joined_at)
  ON public.organization_members TO uellix_cap_bootstrap;

GRANT SELECT (id, email) ON public.users TO uellix_cap_bootstrap;
GRANT SELECT (type, pattern) ON public.signup_allowlist TO uellix_cap_bootstrap;

GRANT INSERT (organization_id, actor_user_id, entity_type, entity_id, action, after_json)
  ON public.audit_logs TO uellix_cap_bootstrap;

GRANT SELECT, INSERT, UPDATE ON public.capability_bootstrap_attempts TO uellix_cap_bootstrap;

-- 2.3 Policies.

DROP POLICY IF EXISTS cap_bootstrap_select_orgs ON public.organizations;
CREATE POLICY cap_bootstrap_select_orgs
ON public.organizations FOR SELECT TO uellix_cap_bootstrap
USING (true);

DROP POLICY IF EXISTS cap_bootstrap_insert_orgs ON public.organizations;
CREATE POLICY cap_bootstrap_insert_orgs
ON public.organizations FOR INSERT TO uellix_cap_bootstrap
WITH CHECK (status = 'active');

DROP POLICY IF EXISTS cap_bootstrap_select_members ON public.organization_members;
CREATE POLICY cap_bootstrap_select_members
ON public.organization_members FOR SELECT TO uellix_cap_bootstrap
USING (true);

-- The direct answer to members_insert_admin's objection: only the founding
-- admin role, only active, and only into a row this transaction created.
DROP POLICY IF EXISTS cap_bootstrap_insert_members ON public.organization_members;
CREATE POLICY cap_bootstrap_insert_members
ON public.organization_members FOR INSERT TO uellix_cap_bootstrap
WITH CHECK (role = 'organization_admin' AND status = 'active');

-- Bound to the caller's own row, like CAP-01's: the body only ever reads
-- `id = auth.uid()`, so the policy can carry the restriction and should.
DROP POLICY IF EXISTS cap_bootstrap_select_users ON public.users;
CREATE POLICY cap_bootstrap_select_users
ON public.users FOR SELECT TO uellix_cap_bootstrap
USING (id = auth.uid());

DROP POLICY IF EXISTS cap_bootstrap_select_allowlist ON public.signup_allowlist;
CREATE POLICY cap_bootstrap_select_allowlist
ON public.signup_allowlist FOR SELECT TO uellix_cap_bootstrap
USING (true);

DROP POLICY IF EXISTS cap_bootstrap_insert_audit ON public.audit_logs;
CREATE POLICY cap_bootstrap_insert_audit
ON public.audit_logs FOR INSERT TO uellix_cap_bootstrap
WITH CHECK (
  actor_user_id IS NOT NULL
  AND entity_type IN ('organization','organization_member')
  AND action IN ('organization.created','membership.created')
);

DROP POLICY IF EXISTS cap_bootstrap_rw_attempts ON public.capability_bootstrap_attempts;
CREATE POLICY cap_bootstrap_rw_attempts
ON public.capability_bootstrap_attempts FOR ALL TO uellix_cap_bootstrap
USING (true) WITH CHECK (true);

-- RESTRICTIVE companions. Everything above is PERMISSIVE, and permissive
-- policies are combined with OR — including the 105 {public} baseline
-- policies, which apply to this definer too. Their predicates call
-- current_user_role_in_org() / current_user_is_super_admin(), which read
-- auth.uid() — a SESSION GUC that SECURITY DEFINER does not reset — so
-- inside the definer they resolve to the CALLER, not to the empty set. An
-- org-admin caller would therefore satisfy the baseline policy and OR away
-- every bound the permissive cap_* policies above appear to impose.
--
-- A RESTRICTIVE policy is ANDed with the permissive result and cannot be
-- OR-ed away. These are what make the documented bounds true; without them
-- the only real bound was the column ACL.
DROP POLICY IF EXISTS cap_bootstrap_only_founder ON public.organization_members;
CREATE POLICY cap_bootstrap_only_founder
ON public.organization_members AS RESTRICTIVE FOR INSERT TO uellix_cap_bootstrap
WITH CHECK (role = 'organization_admin' AND status = 'active');

DROP POLICY IF EXISTS cap_bootstrap_only_active ON public.organizations;
CREATE POLICY cap_bootstrap_only_active
ON public.organizations AS RESTRICTIVE FOR INSERT TO uellix_cap_bootstrap
WITH CHECK (status = 'active');

DROP POLICY IF EXISTS cap_bootstrap_only_self ON public.users;
CREATE POLICY cap_bootstrap_only_self
ON public.users AS RESTRICTIVE FOR SELECT TO uellix_cap_bootstrap
USING (id = auth.uid());

RESET ROLE;

-- ============================================================
-- 3. WINDOW 3 (superuser) — the function, its owner, its ACL
-- ============================================================

CREATE OR REPLACE FUNCTION uellix_capability.bootstrap_organization(
  p_idempotency_key uuid,
  p_name            text,
  p_slug            text,
  p_legal_name      text,
  p_country         text,
  p_sector          text
) RETURNS TABLE (organization_id uuid, slug text)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
  SET search_path = ''
AS $$
DECLARE
  -- A fixed array, not a table. A table would be configurable, and therefore a
  -- target; this list changes only through a reviewed migration. Every entry is
  -- a real route of the application or a name that would be confusing as an
  -- organisation slug.
  c_reserved constant text[] := ARRAY[
    'app','api','admin','www','auth','login','logout','signup','onboarding',
    'verify','invite','dashboard','settings','billing','support','help',
    'status','static','public','assets','_next','favicon','robots','sitemap',
    'uellix','stella','null','undefined','new','edit','delete'
  ];
  v_subject   uuid;
  v_email     text;
  v_domain    text;
  v_name      text;
  v_slug      text;
  v_org_id    uuid;
  v_member_id uuid;
  v_existing  uuid;
  v_claimed   boolean := false;
BEGIN
  SET LOCAL lock_timeout = '3s';

  -- The subject NEVER arrives as a parameter. This is what makes a technical
  -- bootstrap identity unnecessary — and unsafe by comparison.
  v_subject := auth.uid();
  IF v_subject IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- CLAIM THE KEY FIRST. This is the statement that serialises concurrent
  -- calls, and it has to come before any other write: an earlier revision
  -- opened with `SELECT … FOR UPDATE` on this table, which locks nothing when
  -- the row does not exist yet, and only touched the primary key at the end as
  -- an ON CONFLICT DO UPDATE, which never blocks. The documented defence did
  -- not defend.
  INSERT INTO public.capability_bootstrap_attempts (user_id, idempotency_key)
  VALUES (v_subject, p_idempotency_key)
  ON CONFLICT ON CONSTRAINT capability_bootstrap_attempts_pkey DO NOTHING
  RETURNING true INTO v_claimed;

  IF NOT v_claimed IS TRUE THEN
    -- Somebody already holds this key. Either it completed — in which case the
    -- replay returns the same organisation and writes nothing — or it is in
    -- flight, and FOR UPDATE now blocks on a row that genuinely exists.
    SELECT a.organization_id INTO v_existing
      FROM public.capability_bootstrap_attempts a
     WHERE a.user_id = v_subject AND a.idempotency_key = p_idempotency_key
       FOR UPDATE;

    IF v_existing IS NOT NULL THEN
      RETURN QUERY
        SELECT o.id, o.slug::text FROM public.organizations o WHERE o.id = v_existing;
      RETURN;
    END IF;

    -- The row exists with no organisation: a concurrent call holds the lock we
    -- just waited for and rolled back, or is still running. Refuse uniformly;
    -- the client retries with the same key.
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- One active membership per subject. This is the SECOND, independent defence
  -- against a duplicate organisation: the idempotency key covers a resubmitted
  -- form, this covers a fresh one. It is a check, not a lock — the real
  -- serialisation for two DIFFERENT keys is the partial unique index
  -- `user_single_active_membership`, whose existence precondition 0 asserts and
  -- whose 23505 the EXCEPTION block below collapses into U0001.
  IF EXISTS (
    SELECT 1 FROM public.organization_members m
     WHERE m.user_id = v_subject AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  SELECT pg_catalog.lower(pg_catalog.btrim(u.email)) INTO v_email
    FROM public.users u WHERE u.id = v_subject;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;
  v_domain := pg_catalog.split_part(v_email, '@', 2);

  -- The allowlist is the gate (DP-CAP-12). The definer can read it; an ordinary
  -- user cannot, which is why the current server action fails one step before
  -- it even reaches the insert.
  IF NOT EXISTS (
    SELECT 1 FROM public.signup_allowlist s
     WHERE (s.type = 'email'  AND s.pattern = v_email)
        OR (s.type = 'domain' AND s.pattern = v_domain)
  ) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- COALESCE / NULLIF bare: they are grammar productions, not functions, so
  -- `pg_catalog.coalesce(...)` fails at run time and the bare form cannot be
  -- shadowed by search_path.
  v_name := pg_catalog.btrim(COALESCE(p_name, ''));
  IF pg_catalog.length(v_name) < 2 OR pg_catalog.length(v_name) > 255 THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  v_slug := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_slug, '')));
  -- Anchored, bounded, and it cannot start or end with a hyphen. The current
  -- action accepts ^[a-z0-9-]+$, which admits '-', '---' and 'api'.
  IF v_slug !~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$' OR v_slug = ANY(c_reserved) THEN
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  END IF;

  -- Atomic, not check-then-act. The current action SELECTs for the slug and
  -- then INSERTs, so two concurrent submissions both pass the check and the
  -- second dies on the constraint with an opaque error.
  --
  -- ON CONSTRAINT, not ON CONFLICT (slug): this function's RETURNS TABLE
  -- declares an OUT variable named `slug`, and a conflict target is an
  -- EXPRESSION context, so plpgsql would substitute that variable there (or
  -- refuse it as ambiguous). The INSERT column list above is NOT an expression
  -- context and is safe. Naming the constraint removes the ambiguity and pins
  -- the one precondition 0 verified.
  INSERT INTO public.organizations (name, slug, legal_name, country, sector, status)
  VALUES (
    v_name,
    v_slug,
    NULLIF(pg_catalog.left(pg_catalog.btrim(COALESCE(p_legal_name, '')), 255), ''),
    NULLIF(pg_catalog.upper(pg_catalog.left(pg_catalog.btrim(COALESCE(p_country, '')), 2)), ''),
    NULLIF(pg_catalog.btrim(COALESCE(p_sector, '')), ''),
    'active'
  )
  ON CONFLICT ON CONSTRAINT organizations_slug_unique DO NOTHING
  RETURNING id INTO v_org_id;

  -- The ONE distinguishable error in this capability, and it is justified: the
  -- slug space is public by design (organisations are addressable by slug), so
  -- hiding "taken" would degrade usability to conceal something that is not
  -- concealed. Revisit if DP-CAP-12 changes the URL model.
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'organization slug is already taken' USING ERRCODE = 'U0002';
  END IF;

  -- Neither the user nor the role is a parameter. The organization_id is the
  -- row created two statements ago — not a value the caller can name.
  INSERT INTO public.organization_members
    (organization_id, user_id, role, status, joined_at)
  VALUES
    (v_org_id, v_subject, 'organization_admin', 'active', pg_catalog.now())
  RETURNING id INTO v_member_id;

  -- Initial configuration. There is no separate settings table in this schema:
  -- an organisation's configuration IS its own columns, and every one this
  -- capability does not name takes the column DEFAULT — quota included. That is
  -- the mechanism by which the bootstrap cannot pick a plan: it has no grant on
  -- those columns at all, so naming them would fail.

  INSERT INTO public.audit_logs
    (organization_id, actor_user_id, entity_type, entity_id, action, after_json)
  VALUES
    (v_org_id, v_subject, 'organization', v_org_id, 'organization.created',
     pg_catalog.jsonb_build_object('name', v_name, 'slug', v_slug));

  INSERT INTO public.audit_logs
    (organization_id, actor_user_id, entity_type, entity_id, action, after_json)
  VALUES
    (v_org_id, v_subject, 'organization_member', v_member_id, 'membership.created',
     pg_catalog.jsonb_build_object('userId', v_subject, 'role', 'organization_admin'));

  -- Seal the key we claimed at the top.
  UPDATE public.capability_bootstrap_attempts
     SET organization_id = v_org_id,
         completed_at    = pg_catalog.now()
   WHERE user_id = v_subject AND idempotency_key = p_idempotency_key;

  RETURN QUERY SELECT v_org_id, v_slug;

EXCEPTION
  -- U0002 (slug taken) is deliberately distinguishable; U0001 is the uniform
  -- refusal. Everything else the engine produces is collapsed — above all the
  -- 23505 from `user_single_active_membership`, whose DETAIL reads
  -- «Key (user_id)=(<uuid>) already exists» and would return a real user id to
  -- the caller. Log the SQLSTATE only, never SQLERRM.
  WHEN SQLSTATE 'U0001' THEN
    RAISE;
  WHEN SQLSTATE 'U0002' THEN
    RAISE;
  -- OTHERS does NOT match query_canceled (57014) or assert_failure: PL/pgSQL
  -- excludes both. A statement_timeout firing mid-call would therefore reach
  -- the caller as 57014 with PostgreSQL's own message, straight through the
  -- uniform-refusal argument. uellix_stripe carries statement_timeout as a
  -- ROLE setting, so this is not hypothetical for CAP-03.
  WHEN query_canceled THEN
    RAISE LOG 'capability call cancelled (57014)';
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
  WHEN OTHERS THEN
    RAISE LOG 'bootstrap_organization refused with SQLSTATE %', SQLSTATE;
    RAISE EXCEPTION 'capability request denied' USING ERRCODE = 'U0001';
END
$$;

ALTER FUNCTION uellix_capability.bootstrap_organization(uuid, text, text, text, text, text)
  OWNER TO uellix_cap_bootstrap;

COMMENT ON FUNCTION uellix_capability.bootstrap_organization(uuid, text, text, text, text, text) IS
  'CAP-05. Creates one organisation, its founding admin membership and two audit rows in ONE transaction — there is no partial organisation. Subject comes from auth.uid(); owner, role, plan and quota are not parameters. U0001 uniform refusal, U0002 for a taken slug only.';

REVOKE ALL ON FUNCTION uellix_capability.bootstrap_organization(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uellix_capability.bootstrap_organization(uuid, text, text, text, text, text) TO uellix_app;

-- ============================================================
-- 4. Postconditions
-- ============================================================

DO $$
DECLARE
  v_policies integer;
  v_extra    text;
BEGIN
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'uellix_cap_bootstrap') THEN
    RAISE EXCEPTION 'uellix_cap_bootstrap must be NOLOGIN.';
  END IF;
  IF (SELECT rolbypassrls OR rolcreaterole OR rolcreatedb OR rolsuper
        FROM pg_roles WHERE rolname = 'uellix_cap_bootstrap') THEN
    RAISE EXCEPTION 'uellix_cap_bootstrap has a forbidden role attribute.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'uellix_cap_bootstrap')
  ) THEN
    RAISE EXCEPTION 'uellix_cap_bootstrap has a member; it must have none.';
  END IF;

  -- 4.1 This package must not have created a LOGIN identity of any kind.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uellix_bootstrap') THEN
    RAISE EXCEPTION 'stella_0010 must not create a LOGIN bootstrap identity.';
  END IF;

  -- 4.2 The plan/quota/billing exclusion — the requirement stated as an ACL
  -- fact rather than as a claim about the function body.
  IF pg_catalog.has_column_privilege(
       'uellix_cap_bootstrap', 'public.organizations', 'stella_monthly_quota', 'INSERT')
     OR pg_catalog.has_column_privilege(
       'uellix_cap_bootstrap', 'public.organizations', 'stella_plan_label', 'INSERT')
     OR pg_catalog.has_column_privilege(
       'uellix_cap_bootstrap', 'public.organizations', 'stripe_customer_id', 'INSERT') THEN
    RAISE EXCEPTION 'uellix_cap_bootstrap can set a plan, quota or billing column.';
  END IF;

  -- 4.3 Create-only.
  IF pg_catalog.has_any_column_privilege(
       'uellix_cap_bootstrap', 'public.organizations'::regclass, 'UPDATE')
     OR pg_catalog.has_any_column_privilege(
       'uellix_cap_bootstrap', 'public.organization_members'::regclass, 'UPDATE')
     OR pg_catalog.has_table_privilege(
       'uellix_cap_bootstrap', 'public.organizations', 'DELETE')
     OR pg_catalog.has_table_privilege(
       'uellix_cap_bootstrap', 'public.organization_members', 'DELETE') THEN
    RAISE EXCEPTION 'uellix_cap_bootstrap can modify or delete an existing organisation or membership.';
  END IF;

  -- 4.4 Every column the body reads through RETURNING is granted.
  IF NOT pg_catalog.has_column_privilege(
       'uellix_cap_bootstrap', 'public.organization_members', 'id', 'SELECT') THEN
    RAISE EXCEPTION 'uellix_cap_bootstrap cannot read organization_members.id; RETURNING id would fail.';
  END IF;

  -- 4.5 It can resolve auth.uid().
  IF NOT pg_catalog.has_schema_privilege('uellix_cap_bootstrap', 'auth', 'USAGE') THEN
    RAISE EXCEPTION 'uellix_cap_bootstrap cannot use schema auth; auth.uid() would fail inside the definer.';
  END IF;

  -- 4.6 Nothing outside CAP-05. pg_class by relkind, not pg_tables.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p','v','m','f')
      AND c.relname NOT IN ('organizations','organization_members','users',
                            'signup_allowlist','audit_logs','capability_bootstrap_attempts')
      AND pg_catalog.has_any_column_privilege('uellix_cap_bootstrap', c.oid, 'SELECT')
  ) THEN
    RAISE EXCEPTION 'uellix_cap_bootstrap can read a relation outside CAP-05.';
  END IF;

  -- 4.7 The function, and its EMPTY search_path — enumerated, not
  -- prefix-matched.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_capability' AND p.proname = 'bootstrap_organization'
      AND p.prosecdef
      AND pg_get_userbyid(p.proowner) = 'uellix_cap_bootstrap'
      AND (p.proconfig @> ARRAY['search_path=']::text[]
        OR p.proconfig @> ARRAY['search_path=""']::text[])
  ) THEN
    RAISE EXCEPTION 'bootstrap_organization is not a SECURITY DEFINER owned by uellix_cap_bootstrap with an EMPTY search_path.';
  END IF;

  -- 4.8 ACL, enumerated over pg_roles so it covers uellix_stripe and any
  -- future role without having to know it exists.
  SELECT pg_catalog.string_agg(r.rolname, ', ') INTO v_extra
    FROM pg_roles r
   WHERE NOT r.rolsuper
     AND r.rolname NOT IN ('uellix_app', 'uellix_cap_bootstrap')
     AND pg_catalog.has_function_privilege(
           r.rolname,
           'uellix_capability.bootstrap_organization(uuid,text,text,text,text,text)', 'EXECUTE');
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected roles hold EXECUTE on bootstrap_organization: %', v_extra;
  END IF;

  IF pg_catalog.has_function_privilege(
       'public',
       'uellix_capability.bootstrap_organization(uuid,text,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC still holds EXECUTE on bootstrap_organization.';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'uellix_app',
       'uellix_capability.bootstrap_organization(uuid,text,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'uellix_app does not hold EXECUTE on bootstrap_organization.';
  END IF;

  -- 4.9 The historic policies this capability deliberately does not touch.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'members_insert_admin'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'orgs_insert_super_admin'
  ) THEN
    RAISE EXCEPTION 'stella_0010 removed a pre-existing policy it must leave alone.';
  END IF;


  -- The three RLS helpers must be executable, or every read this capability
  -- makes dies at 42501 while evaluating somebody else's {public} policy.
  IF NOT (pg_catalog.has_function_privilege('uellix_cap_bootstrap', 'public.current_user_org_ids()', 'EXECUTE')
      AND pg_catalog.has_function_privilege('uellix_cap_bootstrap', 'public.current_user_is_super_admin()', 'EXECUTE')
      AND pg_catalog.has_function_privilege('uellix_cap_bootstrap', 'public.current_user_role_in_org(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'uellix_cap_bootstrap cannot execute the RLS helper functions; every policy-guarded read would fail with 42501.';
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies WHERE schemaname = 'public' AND pg_catalog.left(policyname, 14) = 'cap_bootstrap_';
  IF v_policies <> 11 THEN
    RAISE EXCEPTION 'Expected 11 cap_bootstrap_* policies (8 permissive + 3 restrictive), found %.', v_policies;
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND pg_catalog.left(policyname, 14) = 'cap_bootstrap_'
         AND permissive = 'RESTRICTIVE') <> 3 THEN
    RAISE EXCEPTION 'the three RESTRICTIVE cap_bootstrap_* policies are missing; the founding-role bound would be OR-ed away by members_insert_admin.';
  END IF;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND pg_catalog.left(policyname, 4) <> 'cap_'
         AND pg_catalog.left(policyname, 12) <> 'disclosures_'
         AND policyname NOT IN ('anon_insert_marketing_leads',
                                'authenticated_insert_marketing_leads')) <> 105 THEN
    RAISE EXCEPTION 'stella_0010 changed the policy baseline; expected 105.';
  END IF;

  RAISE NOTICE 'stella_0010 applied: CAP-05 capability present, onboarding action still failing closed.';
END
$$;
