-- S3 REFUSAL AUDIT — the additive INSERT policy for tenancy refusal events.
--
-- Authority: docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.25.json
-- (AUDIT_LOG_POLICY_CONTRACT), with its companion execution scope
-- docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_AMENDMENT_v1.0.6.json.
--
-- Custom SQL migration: no schema.ts diff. RLS policies are hand-authored in
-- this repo's migration chain (see 0031_rls_core.sql and, for the sibling
-- policy on this very table, 0042_fib_audit_insert_policy.sql), following the
-- same idempotent DROP POLICY IF EXISTS / CREATE POLICY pattern.
--
-- WHY THE EXISTING POLICY CANNOT CARRY THIS ROW.
--
-- A tenancy refusal is an event about a request that was REFUSED an
-- organisation. It has NO organization_id, because there is no tenant that
-- owns it. audit_logs_insert_member_or_admin (0042) requires exactly the
-- opposite — organization_id IS NOT NULL AND organization_id = ANY(
-- current_user_org_ids()), or super-admin — so a refusal row is impossible
-- under it BY CONSTRUCTION, not by oversight. This policy is ADDED BESIDE it.
-- 0042's clause is byte-unchanged here and is NOT widened: widening the
-- generic policy to admit NULL-organisation rows would also admit every other
-- NULL-organisation write, which is the opposite of what this node needs.
--
-- THE ENLARGEMENT, DISCLOSED RATHER THAN HIDDEN.
--
-- PostgreSQL combines multiple PERMISSIVE policies for the same command with
-- OR, so adding this policy DOES enlarge the set of rows uellix_app can insert
-- into audit_logs. That enlargement is the point, and it is bounded: a row
-- must satisfy EVERY common invariant below AND exactly one of the three
-- correlated action/form disjuncts, all of them with organization_id IS NULL
-- and actor_user_id = auth.uid(). A caller cannot reach any other shape.
--
-- ACTION AND SUBJECT FORM ARE COUPLED, AND THE COUPLING IS THE POINT.
--
-- There are two authorised verbs and two authorised subject forms, but only
-- THREE of the four combinations describe something that can actually happen:
--
--   selection_refused  + FORM A  an explicit selection attempt supplied no
--                                usable organisation UUID. Subject is the
--                                caller: entity_type 'user', entity_id
--                                auth.uid().
--   selection_refused  + FORM B  an explicit selection attempt supplied a
--                                VALID organisation UUID the caller is not a
--                                member of. Subject is that organisation.
--   revalidation_refused + FORM B  a previously selected valid organisation
--                                UUID failed membership revalidation.
--
-- revalidation_refused + FORM A is REFUSED HERE, by the database, and not
-- merely by emitter discipline. Revalidation presupposes something to
-- revalidate; a FORM A row under that verb would assert that a membership
-- revalidation was refused when none was attempted. That is a false statement
-- in the audit trail, and the trail is the only reason this policy exists.
--
-- WHAT THIS POLICY DELIBERATELY CANNOT PROVE.
--
-- It can prove a FORM B row carries SOME organisation-shaped subject. It
-- CANNOT prove that subject is THE organisation the caller actually attempted,
-- because proving that would need a lookup against public.organizations — and
-- an existence check inside an INSERT policy would turn every refusal write
-- into an organisation-existence oracle for a subject unauthenticated in that
-- tenant. That obligation is therefore discharged in the application, by the
-- emitter and its tests, and is documented as such rather than papered over.
--
-- Deploy-safety: this policy is PERMISSIVE and additive. It enables a write
-- that is impossible today and restricts nothing already granted.

DROP POLICY IF EXISTS "audit_logs_insert_tenancy_refusal" ON audit_logs;
CREATE POLICY "audit_logs_insert_tenancy_refusal"
ON audit_logs FOR INSERT
TO uellix_app
WITH CHECK (
  -- Common invariants. A refusal row is anonymous of tenant, carries no
  -- payload, and is attributed to the caller the database itself sees.
  actor_user_id = auth.uid()
  AND organization_id IS NULL
  AND project_id IS NULL
  AND before_json IS NULL
  AND after_json IS NULL
  AND ip_address IS NULL
  AND user_agent IS NULL
  AND (
    -- selection_refused, FORM A: no usable organisation UUID was supplied.
    -- The subject is the caller, and entity_id is pinned to auth.uid() so a
    -- FORM A row cannot name anyone else.
    (
      action = 'tenancy.organization.selection_refused'
      AND reason = 'TENANCY_NO_ORGANIZATION_SELECTED'
      AND entity_type = 'user'
      AND entity_id = auth.uid()
    )
    -- selection_refused, FORM B: a valid organisation UUID was supplied and
    -- the caller is not a member of it.
    OR (
      action = 'tenancy.organization.selection_refused'
      AND reason = 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER'
      AND entity_type = 'organization'
      AND entity_id IS NOT NULL
    )
    -- revalidation_refused, FORM B: the ONLY form this verb admits.
    OR (
      action = 'tenancy.membership.revalidation_refused'
      AND reason = 'TENANCY_SELECTED_ORGANIZATION_NOT_A_MEMBER'
      AND entity_type = 'organization'
      AND entity_id IS NOT NULL
    )
  )
);
