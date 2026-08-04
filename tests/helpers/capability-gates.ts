// tests/helpers/capability-gates.ts
//
// The capability contract, expressed as a PURE FUNCTION over the package text.
//
// WHY A FUNCTION AND NOT A TEST FILE. tests/capability-isolation.test.ts reads
// db/prepared/*.sql from disk inside its assertions, so the only thing it can
// ever judge is the working tree. That makes it impossible to ask the one
// question a security gate has to answer: "if someone changed THIS, would the
// suite go red?" Twenty-two mutations survived a 220/220 run and nobody could
// see it, because seeing it requires running the gates against text that is not
// on disk.
//
// So the gates live here, taking their input as a map of file name to content.
// tests/capability-policy-contract.test.ts feeds them the real files and
// expects zero violations. tests/capability-mutation.test.ts feeds them mutated
// copies and expects at least one violation per mutation. Same code, both
// directions — which is the only construction under which "every security
// mutation produces a red test" is a claim rather than a hope.
//
// A violation carries the gate that produced it, so the mutation matrix can
// report WHICH property refused, not merely that something did.

import {
  analyzeSecurity,
  parsePolicies,
  parseGrants,
  parseRevokes,
  parseOwnerships,
  parseRlsToggles,
  parseIndexes,
  parseTriggers,
  parseDroppedTriggers,
  parseDroppedPolicies,
  parseRoleStatements,
  parseOwnedStatements,
  parseDefaultPrivileges,
  stripComments,
  normalizeExpr,
} from './sql-structure'

export interface Violation {
  readonly gate: string
  readonly detail: string
}

export type Sources = Readonly<Record<string, string>>

export const FORWARD = {
  CAP01: 'stella_0006_invitation_capability.sql',
  CAP02: 'stella_0007_public_verification_capability.sql',
  CAP03: 'stella_0008_stripe_webhook_identity.sql',
  CAP04: 'stella_0009_public_lead_capability.sql',
  CAP05: 'stella_0010_organization_bootstrap_capability.sql',
  // Not a sixth capability: stella_0011 NARROWS an existing ACL. It is in this
  // map because it creates a definer in the same schema, under the same rules,
  // and every gate below is exactly as applicable to it — leaving it out would
  // have made "the campaign is contracted" true of five files and false of six.
  CAP06: 'stella_0011_organization_column_acl.sql',
} as const

export const ROLLBACK = {
  CAP01: 'stella_0006_rollback.sql',
  CAP02: 'stella_0007_rollback.sql',
  CAP03: 'stella_0008_rollback.sql',
  CAP04: 'stella_0009_rollback.sql',
  CAP05: 'stella_0010_rollback.sql',
  CAP06: 'stella_0011_rollback.sql',
} as const

export const CAPABILITY_SQL_FILES: readonly string[] = [
  ...Object.values(FORWARD),
  ...Object.values(ROLLBACK),
]

// ---------------------------------------------------------------------------
// The authoritative policy contract.
// ---------------------------------------------------------------------------
// One row per CREATE POLICY in the campaign. `using` and `check` are the
// NORMALISED predicate text; null means the clause must be absent. Comparing
// the whole tuple is what makes a retargeted TO, a substituted predicate and a
// policy attached to the wrong table into three distinct failures instead of
// three invisible edits.

interface PolicyContract {
  readonly name: string
  readonly file: string
  readonly table: string
  readonly mode: 'PERMISSIVE' | 'RESTRICTIVE'
  readonly command: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
  readonly roles: readonly string[]
  readonly using: string | null
  readonly check: string | null
}

const TENANCY_READ =
  "EXISTS ( SELECT 1 FROM public.sroi_reports r WHERE r.id = public.report_public_disclosures.report_id " +
  "AND (r.organization_id = ANY(public.current_user_org_ids()) OR public.current_user_is_super_admin()) )"

const TENANCY_ADMIN =
  "EXISTS ( SELECT 1 FROM public.sroi_reports r WHERE r.id = public.report_public_disclosures.report_id " +
  "AND (public.current_user_role_in_org(r.organization_id) IN ('super_admin', 'organization_admin') " +
  'OR public.current_user_is_super_admin()) )'

// RR-CAP-13. One proposition, written for two tables: a row is readable only
// if some LOCKED report with a LIVE disclosure points at it.
const PUBLISHED_ORG =
  "EXISTS ( SELECT 1 FROM public.sroi_reports r JOIN public.report_public_disclosures d " +
  "ON d.report_id = r.id WHERE r.organization_id = public.organizations.id " +
  "AND r.status = 'locked' AND d.revoked_at IS NULL )"

const PUBLISHED_RUN =
  "EXISTS ( SELECT 1 FROM public.sroi_reports r JOIN public.report_public_disclosures d " +
  "ON d.report_id = r.id WHERE r.calculation_run_id = public.sroi_calculation_runs.id " +
  "AND r.status = 'locked' AND d.revoked_at IS NULL )"

// RR-CAP-14. The row must already carry the Stripe address of a CLAIMED event.
// Both halves of the OR require the event side to be NOT NULL: without that the
// predicate would be satisfied by three-valued logic rather than by a match.
const CLAIMED_ORG =
  "EXISTS ( SELECT 1 FROM public.stripe_webhook_events e " +
  "WHERE e.event_id = NULLIF(pg_catalog.current_setting('app.stripe_event_id', true), '') " +
  "AND e.status = 'processing' " +
  "AND e.received_at > pg_catalog.now() - interval '15 minutes' " +
  "AND ( (e.stripe_customer_id IS NOT NULL " +
  "AND e.stripe_customer_id = public.organizations.stripe_customer_id) " +
  "OR (e.stripe_subscription_id IS NOT NULL " +
  "AND e.stripe_subscription_id = public.organizations.stripe_subscription_id) ) )"

export const POLICY_CONTRACT: readonly PolicyContract[] = [
  // --- CAP-01 -------------------------------------------------------------
  { name: 'cap_invitation_select_invitations', file: FORWARD.CAP01, table: 'public.invitations', mode: 'PERMISSIVE', command: 'SELECT', roles: ['uellix_cap_invitation'], using: 'true', check: null },
  { name: 'cap_invitation_update_invitations', file: FORWARD.CAP01, table: 'public.invitations', mode: 'PERMISSIVE', command: 'UPDATE', roles: ['uellix_cap_invitation'], using: "status = 'pending'", check: "status = 'accepted' AND accepted_by IS NOT NULL" },
  { name: 'cap_invitation_select_members', file: FORWARD.CAP01, table: 'public.organization_members', mode: 'PERMISSIVE', command: 'SELECT', roles: ['uellix_cap_invitation'], using: 'true', check: null },
  { name: 'cap_invitation_insert_members', file: FORWARD.CAP01, table: 'public.organization_members', mode: 'PERMISSIVE', command: 'INSERT', roles: ['uellix_cap_invitation'], using: null, check: "status = 'active' AND role <> 'super_admin'" },
  { name: 'cap_invitation_select_users', file: FORWARD.CAP01, table: 'public.users', mode: 'PERMISSIVE', command: 'SELECT', roles: ['uellix_cap_invitation'], using: 'id = auth.uid()', check: null },
  { name: 'cap_invitation_insert_audit', file: FORWARD.CAP01, table: 'public.audit_logs', mode: 'PERMISSIVE', command: 'INSERT', roles: ['uellix_cap_invitation'], using: null, check: "actor_user_id IS NOT NULL AND entity_type IN ('invitation','organization_member') AND action IN ('invitation.accepted','membership.created')" },
  { name: 'cap_invitation_only_accept', file: FORWARD.CAP01, table: 'public.invitations', mode: 'RESTRICTIVE', command: 'UPDATE', roles: ['uellix_cap_invitation'], using: "status = 'pending'", check: "status = 'accepted' AND accepted_by IS NOT NULL" },
  { name: 'cap_invitation_only_member', file: FORWARD.CAP01, table: 'public.organization_members', mode: 'RESTRICTIVE', command: 'INSERT', roles: ['uellix_cap_invitation'], using: null, check: "status = 'active' AND role <> 'super_admin'" },
  { name: 'cap_invitation_only_self', file: FORWARD.CAP01, table: 'public.users', mode: 'RESTRICTIVE', command: 'SELECT', roles: ['uellix_cap_invitation'], using: 'id = auth.uid()', check: null },

  // --- CAP-02 -------------------------------------------------------------
  { name: 'cap_verification_select_reports', file: FORWARD.CAP02, table: 'public.sroi_reports', mode: 'PERMISSIVE', command: 'SELECT', roles: ['uellix_cap_verification'], using: "status = 'locked'", check: null },
  { name: 'cap_verification_select_disclosures', file: FORWARD.CAP02, table: 'public.report_public_disclosures', mode: 'PERMISSIVE', command: 'SELECT', roles: ['uellix_cap_verification'], using: 'revoked_at IS NULL', check: null },
  { name: 'cap_verification_select_orgs', file: FORWARD.CAP02, table: 'public.organizations', mode: 'PERMISSIVE', command: 'SELECT', roles: ['uellix_cap_verification'], using: 'true', check: null },
  { name: 'cap_verification_select_runs', file: FORWARD.CAP02, table: 'public.sroi_calculation_runs', mode: 'PERMISSIVE', command: 'SELECT', roles: ['uellix_cap_verification'], using: 'true', check: null },
  { name: 'cap_verification_write_hits', file: FORWARD.CAP02, table: 'public.capability_verification_hits', mode: 'PERMISSIVE', command: 'ALL', roles: ['uellix_cap_verification'], using: 'true', check: 'true' },
  // The three INTERNAL policies. They are not cap_*-prefixed, so the old
  // cardinality gate never looked at them at all: deleting disclosures_update_admin
  // outright left every count in the suite unchanged.
  { name: 'disclosures_select_member', file: FORWARD.CAP02, table: 'public.report_public_disclosures', mode: 'PERMISSIVE', command: 'SELECT', roles: ['uellix_app'], using: TENANCY_READ, check: null },
  { name: 'disclosures_insert_admin', file: FORWARD.CAP02, table: 'public.report_public_disclosures', mode: 'PERMISSIVE', command: 'INSERT', roles: ['uellix_app'], using: null, check: `approved_by = auth.uid() AND ${TENANCY_ADMIN}` },
  { name: 'disclosures_update_admin', file: FORWARD.CAP02, table: 'public.report_public_disclosures', mode: 'PERMISSIVE', command: 'UPDATE', roles: ['uellix_app'], using: TENANCY_ADMIN, check: `(revoked_by IS NULL OR revoked_by = auth.uid()) AND ${TENANCY_ADMIN}` },
  { name: 'cap_verification_only_locked', file: FORWARD.CAP02, table: 'public.sroi_reports', mode: 'RESTRICTIVE', command: 'SELECT', roles: ['uellix_cap_verification'], using: "status = 'locked'", check: null },
  { name: 'cap_verification_only_live', file: FORWARD.CAP02, table: 'public.report_public_disclosures', mode: 'RESTRICTIVE', command: 'SELECT', roles: ['uellix_cap_verification'], using: 'revoked_at IS NULL', check: null },
  // RR-CAP-13. The two tables whose only bound used to live in verify_report's
  // JOIN. Written as full predicates rather than as "a RESTRICTIVE exists",
  // because the whole finding was that the bound existed somewhere else.
  { name: 'cap_verification_only_published_org', file: FORWARD.CAP02, table: 'public.organizations', mode: 'RESTRICTIVE', command: 'SELECT', roles: ['uellix_cap_verification'], using: PUBLISHED_ORG, check: null },
  { name: 'cap_verification_only_published_run', file: FORWARD.CAP02, table: 'public.sroi_calculation_runs', mode: 'RESTRICTIVE', command: 'SELECT', roles: ['uellix_cap_verification'], using: PUBLISHED_RUN, check: null },

  // --- CAP-03 -------------------------------------------------------------
  { name: 'cap_stripe_select_orgs', file: FORWARD.CAP03, table: 'public.organizations', mode: 'PERMISSIVE', command: 'SELECT', roles: ['uellix_cap_stripe'], using: 'true', check: null },
  { name: 'cap_stripe_update_orgs', file: FORWARD.CAP03, table: 'public.organizations', mode: 'PERMISSIVE', command: 'UPDATE', roles: ['uellix_cap_stripe'], using: 'true', check: 'true' },
  { name: 'cap_stripe_rw_events', file: FORWARD.CAP03, table: 'public.stripe_webhook_events', mode: 'PERMISSIVE', command: 'ALL', roles: ['uellix_cap_stripe'], using: 'true', check: 'true' },
  { name: 'cap_stripe_insert_audit', file: FORWARD.CAP03, table: 'public.audit_logs', mode: 'PERMISSIVE', command: 'INSERT', roles: ['uellix_cap_stripe'], using: null, check: "actor_user_id IS NULL AND entity_type = 'organization' AND pg_catalog.left(action, 7) = 'stripe.'" },
  // RR-CAP-14. CAP-03 was the only capability with no RESTRICTIVE policy at all.
  { name: 'cap_stripe_only_claimed_read', file: FORWARD.CAP03, table: 'public.organizations', mode: 'RESTRICTIVE', command: 'SELECT', roles: ['uellix_cap_stripe'], using: CLAIMED_ORG, check: null },
  { name: 'cap_stripe_only_claimed_org', file: FORWARD.CAP03, table: 'public.organizations', mode: 'RESTRICTIVE', command: 'UPDATE', roles: ['uellix_cap_stripe'], using: CLAIMED_ORG, check: CLAIMED_ORG },

  // --- CAP-04 -------------------------------------------------------------
  { name: 'cap_lead_insert', file: FORWARD.CAP04, table: 'public.marketing_leads', mode: 'PERMISSIVE', command: 'INSERT', roles: ['uellix_cap_lead'], using: null, check: "lead_status = 'new'" },
  { name: 'cap_lead_deny_runtime', file: FORWARD.CAP04, table: 'public.marketing_leads', mode: 'RESTRICTIVE', command: 'ALL', roles: ['uellix_app'], using: 'false', check: 'false' },

  // --- CAP-05 -------------------------------------------------------------
  { name: 'cap_bootstrap_select_orgs', file: FORWARD.CAP05, table: 'public.organizations', mode: 'PERMISSIVE', command: 'SELECT', roles: ['uellix_cap_bootstrap'], using: 'true', check: null },
  { name: 'cap_bootstrap_insert_orgs', file: FORWARD.CAP05, table: 'public.organizations', mode: 'PERMISSIVE', command: 'INSERT', roles: ['uellix_cap_bootstrap'], using: null, check: "status = 'active'" },
  { name: 'cap_bootstrap_select_members', file: FORWARD.CAP05, table: 'public.organization_members', mode: 'PERMISSIVE', command: 'SELECT', roles: ['uellix_cap_bootstrap'], using: 'true', check: null },
  { name: 'cap_bootstrap_insert_members', file: FORWARD.CAP05, table: 'public.organization_members', mode: 'PERMISSIVE', command: 'INSERT', roles: ['uellix_cap_bootstrap'], using: null, check: "role = 'organization_admin' AND status = 'active'" },
  { name: 'cap_bootstrap_select_users', file: FORWARD.CAP05, table: 'public.users', mode: 'PERMISSIVE', command: 'SELECT', roles: ['uellix_cap_bootstrap'], using: 'id = auth.uid()', check: null },
  { name: 'cap_bootstrap_select_allowlist', file: FORWARD.CAP05, table: 'public.signup_allowlist', mode: 'PERMISSIVE', command: 'SELECT', roles: ['uellix_cap_bootstrap'], using: 'true', check: null },
  { name: 'cap_bootstrap_insert_audit', file: FORWARD.CAP05, table: 'public.audit_logs', mode: 'PERMISSIVE', command: 'INSERT', roles: ['uellix_cap_bootstrap'], using: null, check: "actor_user_id IS NOT NULL AND entity_type IN ('organization','organization_member') AND action IN ('organization.created','membership.created')" },
  { name: 'cap_bootstrap_rw_attempts', file: FORWARD.CAP05, table: 'public.capability_bootstrap_attempts', mode: 'PERMISSIVE', command: 'ALL', roles: ['uellix_cap_bootstrap'], using: 'true', check: 'true' },
  { name: 'cap_bootstrap_only_founder', file: FORWARD.CAP05, table: 'public.organization_members', mode: 'RESTRICTIVE', command: 'INSERT', roles: ['uellix_cap_bootstrap'], using: null, check: "role = 'organization_admin' AND status = 'active'" },
  { name: 'cap_bootstrap_only_active', file: FORWARD.CAP05, table: 'public.organizations', mode: 'RESTRICTIVE', command: 'INSERT', roles: ['uellix_cap_bootstrap'], using: null, check: "status = 'active'" },
  { name: 'cap_bootstrap_only_self', file: FORWARD.CAP05, table: 'public.users', mode: 'RESTRICTIVE', command: 'SELECT', roles: ['uellix_cap_bootstrap'], using: 'id = auth.uid()', check: null },

  // --- stella_0011 / RR-CAP-10 --------------------------------------------
  { name: 'cap_platform_select_orgs', file: FORWARD.CAP06, table: 'public.organizations', mode: 'PERMISSIVE', command: 'SELECT', roles: ['uellix_cap_platform'], using: 'true', check: null },
  { name: 'cap_platform_update_orgs', file: FORWARD.CAP06, table: 'public.organizations', mode: 'PERMISSIVE', command: 'UPDATE', roles: ['uellix_cap_platform'], using: 'true', check: 'true' },
  { name: 'cap_platform_only_super_admin_read', file: FORWARD.CAP06, table: 'public.organizations', mode: 'RESTRICTIVE', command: 'SELECT', roles: ['uellix_cap_platform'], using: 'public.current_user_is_super_admin()', check: null },
  { name: 'cap_platform_only_super_admin', file: FORWARD.CAP06, table: 'public.organizations', mode: 'RESTRICTIVE', command: 'UPDATE', roles: ['uellix_cap_platform'], using: 'public.current_user_is_super_admin()', check: 'public.current_user_is_super_admin()' },
  { name: 'cap_platform_insert_audit', file: FORWARD.CAP06, table: 'public.audit_logs', mode: 'PERMISSIVE', command: 'INSERT', roles: ['uellix_cap_platform'], using: null, check: "actor_user_id = auth.uid() AND actor_user_id IS NOT NULL AND entity_type = 'organization' AND pg_catalog.left(action, 9) = 'platform.'" },
]

// ---------------------------------------------------------------------------
// The authoritative privilege contract.
// ---------------------------------------------------------------------------
// One line per (privilege, columns, object, grantee) the campaign confers, in
// the canonical form `PRIV(col,col) ON object TO grantee`. Comparing the SET
// makes a fused `GRANT INSERT (...), SELECT` visible, which reading the first
// word of the privilege list never could.

const G = (s: string) => s

export const GRANT_CONTRACT: Readonly<Record<string, readonly string[]>> = {
  [FORWARD.CAP01]: [
    G('USAGE ON SCHEMA:uellix_capability TO uellix_app'),
    G('USAGE ON SCHEMA:uellix_capability TO uellix_cap_invitation'),
    G('USAGE ON SCHEMA:auth TO uellix_cap_invitation'),
    G('EXECUTE ON FUNCTION:public.current_user_org_ids TO uellix_cap_invitation'),
    G('EXECUTE ON FUNCTION:public.current_user_is_super_admin TO uellix_cap_invitation'),
    G('EXECUTE ON FUNCTION:public.current_user_role_in_org TO uellix_cap_invitation'),
    G('SELECT(accepted_by,email,expires_at,id,invited_by,organization_id,role,status,token_hash) ON TABLE:public.invitations TO uellix_cap_invitation'),
    G('UPDATE(accepted_at,accepted_by,status,updated_at) ON TABLE:public.invitations TO uellix_cap_invitation'),
    G('SELECT(id,status,user_id) ON TABLE:public.organization_members TO uellix_cap_invitation'),
    G('INSERT(invited_by,joined_at,organization_id,role,status,user_id) ON TABLE:public.organization_members TO uellix_cap_invitation'),
    G('SELECT(email,id) ON TABLE:public.users TO uellix_cap_invitation'),
    G('INSERT(action,actor_user_id,after_json,entity_id,entity_type,organization_id) ON TABLE:public.audit_logs TO uellix_cap_invitation'),
    G('EXECUTE ON FUNCTION:uellix_capability.accept_invitation TO uellix_app'),
  ],
  [FORWARD.CAP02]: [
    G('USAGE ON SCHEMA:uellix_capability TO uellix_app'),
    G('USAGE ON SCHEMA:uellix_capability TO uellix_cap_verification'),
    G('EXECUTE ON FUNCTION:public.current_user_org_ids TO uellix_cap_verification'),
    G('EXECUTE ON FUNCTION:public.current_user_is_super_admin TO uellix_cap_verification'),
    G('EXECUTE ON FUNCTION:public.current_user_role_in_org TO uellix_cap_verification'),
    G('SELECT(calculation_run_id,id,locked_at,organization_id,report_variant,status,title,verification_hash) ON TABLE:public.sroi_reports TO uellix_cap_verification'),
    G('SELECT(id,name) ON TABLE:public.organizations TO uellix_cap_verification'),
    G('SELECT(currency,id,net_social_value,sroi_ratio,total_investment) ON TABLE:public.sroi_calculation_runs TO uellix_cap_verification'),
    G('SELECT(disclosure_version,public_summary,report_id,revoked_at,show_headline_ratio,show_issued_on,show_organization_name,show_report_title,show_report_variant,show_totals) ON TABLE:public.report_public_disclosures TO uellix_cap_verification'),
    G('SELECT ON TABLE:public.capability_verification_hits TO uellix_cap_verification'),
    G('INSERT ON TABLE:public.capability_verification_hits TO uellix_cap_verification'),
    G('UPDATE ON TABLE:public.capability_verification_hits TO uellix_cap_verification'),
    G('SELECT ON TABLE:public.report_public_disclosures TO uellix_writer'),
    G('INSERT(approved_by,disclosure_version,public_summary,report_id,show_headline_ratio,show_issued_on,show_organization_name,show_report_title,show_report_variant,show_totals) ON TABLE:public.report_public_disclosures TO uellix_writer'),
    G('UPDATE(disclosure_version,public_summary,revoked_at,revoked_by,show_headline_ratio,show_issued_on,show_organization_name,show_report_title,show_report_variant,show_totals,updated_at) ON TABLE:public.report_public_disclosures TO uellix_writer'),
    G('EXECUTE ON FUNCTION:uellix_capability.verify_report TO uellix_app'),
    G('EXECUTE ON FUNCTION:uellix_capability.record_verification_hit TO uellix_app'),
  ],
  [FORWARD.CAP03]: [
    G('USAGE ON SCHEMA:uellix_capability TO uellix_stripe'),
    G('USAGE ON SCHEMA:uellix_capability TO uellix_cap_stripe'),
    G('EXECUTE ON FUNCTION:public.current_user_org_ids TO uellix_cap_stripe'),
    G('EXECUTE ON FUNCTION:public.current_user_is_super_admin TO uellix_cap_stripe'),
    G('EXECUTE ON FUNCTION:public.current_user_role_in_org TO uellix_cap_stripe'),
    G('SELECT(id,stella_monthly_quota,stella_plan_label,stripe_customer_id,stripe_price_id,stripe_subscription_id) ON TABLE:public.organizations TO uellix_cap_stripe'),
    G('UPDATE(stella_monthly_quota,stella_plan_label,stripe_customer_id,stripe_price_id,stripe_subscription_id,updated_at) ON TABLE:public.organizations TO uellix_cap_stripe'),
    G('SELECT ON TABLE:public.stripe_webhook_events TO uellix_cap_stripe'),
    G('INSERT ON TABLE:public.stripe_webhook_events TO uellix_cap_stripe'),
    G('UPDATE(attempts,completed_at,failed_at,last_error_code,organization_id,received_at,status) ON TABLE:public.stripe_webhook_events TO uellix_cap_stripe'),
    G('INSERT(action,actor_user_id,after_json,before_json,entity_id,entity_type,organization_id,reason) ON TABLE:public.audit_logs TO uellix_cap_stripe'),
    G('EXECUTE ON FUNCTION:uellix_capability.stripe_begin_event TO uellix_stripe'),
    G('EXECUTE ON FUNCTION:uellix_capability.stripe_apply_subscription TO uellix_stripe'),
    G('EXECUTE ON FUNCTION:uellix_capability.stripe_fail_event TO uellix_stripe'),
  ],
  [FORWARD.CAP04]: [
    G('USAGE ON SCHEMA:uellix_capability TO uellix_app'),
    G('USAGE ON SCHEMA:uellix_capability TO uellix_cap_lead'),
    G('INSERT(company_name,consent_version,email,lead_status,source,sroi_result) ON TABLE:public.marketing_leads TO uellix_cap_lead'),
    G('EXECUTE ON FUNCTION:uellix_capability.submit_lead TO uellix_app'),
  ],
  [FORWARD.CAP05]: [
    G('USAGE ON SCHEMA:uellix_capability TO uellix_app'),
    G('USAGE ON SCHEMA:uellix_capability TO uellix_cap_bootstrap'),
    G('USAGE ON SCHEMA:auth TO uellix_cap_bootstrap'),
    G('EXECUTE ON FUNCTION:public.current_user_org_ids TO uellix_cap_bootstrap'),
    G('EXECUTE ON FUNCTION:public.current_user_is_super_admin TO uellix_cap_bootstrap'),
    G('EXECUTE ON FUNCTION:public.current_user_role_in_org TO uellix_cap_bootstrap'),
    G('SELECT(id,slug) ON TABLE:public.organizations TO uellix_cap_bootstrap'),
    G('INSERT(country,legal_name,name,sector,slug,status) ON TABLE:public.organizations TO uellix_cap_bootstrap'),
    G('SELECT(id,status,user_id) ON TABLE:public.organization_members TO uellix_cap_bootstrap'),
    G('INSERT(joined_at,organization_id,role,status,user_id) ON TABLE:public.organization_members TO uellix_cap_bootstrap'),
    G('SELECT(email,id) ON TABLE:public.users TO uellix_cap_bootstrap'),
    G('SELECT(pattern,type) ON TABLE:public.signup_allowlist TO uellix_cap_bootstrap'),
    G('INSERT(action,actor_user_id,after_json,entity_id,entity_type,organization_id) ON TABLE:public.audit_logs TO uellix_cap_bootstrap'),
    G('SELECT ON TABLE:public.capability_bootstrap_attempts TO uellix_cap_bootstrap'),
    G('INSERT ON TABLE:public.capability_bootstrap_attempts TO uellix_cap_bootstrap'),
    G('UPDATE ON TABLE:public.capability_bootstrap_attempts TO uellix_cap_bootstrap'),
    G('EXECUTE ON FUNCTION:uellix_capability.bootstrap_organization TO uellix_app'),
  ],
  [FORWARD.CAP06]: [
    G('USAGE ON SCHEMA:uellix_capability TO uellix_cap_platform'),
    G('USAGE ON SCHEMA:uellix_capability TO uellix_app'),
    G('USAGE ON SCHEMA:auth TO uellix_cap_platform'),
    // The repair itself. These two lines ARE RR-CAP-10: the set comparison is
    // what makes putting stella_monthly_quota back a visible edit rather than a
    // one-word change inside a parenthesis nobody re-reads.
    G('UPDATE(base_currency,brand_color,country,logo_url,onboarding_completed,sector,updated_at,white_label_enabled) ON TABLE:public.organizations TO uellix_writer'),
    // NOTHING for `authenticated`. It is revoked and never re-granted: it has no
    // call site in the application, and re-granting it would restore the
    // browser-direct write surface the package exists to close.
    G('EXECUTE ON FUNCTION:public.current_user_org_ids TO uellix_cap_platform'),
    G('EXECUTE ON FUNCTION:public.current_user_is_super_admin TO uellix_cap_platform'),
    G('EXECUTE ON FUNCTION:public.current_user_role_in_org TO uellix_cap_platform'),
    G('SELECT(id,name,status,stella_monthly_quota,stella_plan_label) ON TABLE:public.organizations TO uellix_cap_platform'),
    G('UPDATE(status,stella_monthly_quota,stella_plan_label,updated_at) ON TABLE:public.organizations TO uellix_cap_platform'),
    G('INSERT(action,actor_user_id,after_json,before_json,entity_id,entity_type,organization_id,reason) ON TABLE:public.audit_logs TO uellix_cap_platform'),
    G('EXECUTE ON FUNCTION:uellix_capability.admin_set_stella_service TO uellix_app'),
    G('EXECUTE ON FUNCTION:uellix_capability.admin_set_organization_status TO uellix_app'),
  ],
}

/**
 * Policies a rollback deliberately KEEPS, and the reason.
 *
 * CAP-02's rollback retains report_public_disclosures because each row is a
 * human decision to publish, and it retains disclosures_select_member so an
 * organisation admin can still read what was published. Symmetry between
 * forward and rollback is the rule; this is the one documented exception, and
 * the gate below requires the rollback to ASSERT the survival rather than
 * merely omit the DROP — an omission and a decision look identical otherwise.
 */
export const ROLLBACK_RETAINED_POLICIES: Readonly<Record<string, readonly string[]>> = {
  [ROLLBACK.CAP01]: [],
  [ROLLBACK.CAP02]: ['disclosures_select_member'],
  [ROLLBACK.CAP03]: [],
  [ROLLBACK.CAP04]: [],
  [ROLLBACK.CAP05]: [],
  [ROLLBACK.CAP06]: [],
}

/**
 * The tables that survive a FULL rollback of the campaign, and the ones that do
 * not. Two survive, not three: stella_0010_rollback's header said "the other
 * three capability tables are retained" while its sibling drops
 * capability_verification_hits, and a rollback whose prose disagrees with its
 * own statements is how an operator ends up believing a counter still exists.
 */
export const RETAINED_TABLES: readonly string[] = [
  'report_public_disclosures',
  'stripe_webhook_events',
]
export const DROPPED_TABLES: readonly string[] = [
  'capability_verification_hits',
  'capability_bootstrap_attempts',
]

/** Canonical, order-independent form of one conferred privilege. */
function grantSignatures(sql: string): string[] {
  return parseGrants(sql)
    .flatMap((g) =>
      g.privileges.flatMap((p) =>
        g.grantees.map(
          (grantee) =>
            `${p.privilege}${p.columns ? `(${[...p.columns].sort().join(',')})` : ''}` +
            ` ON ${g.objectType}:${g.object} TO ${grantee}` +
            // WITH GRANT OPTION is part of the privilege, not decoration: it
            // lets the grantee re-grant, which makes the REVOKE ... FROM PUBLIC
            // that every capability function depends on reversible by the
            // runtime role. Stripping the phrase before building the signature
            // — as the first version did — made the delegating form and the
            // plain form byte-identical to the contract.
            (g.grantOption ? ' WITH GRANT OPTION' : ''),
        ),
      ),
    )
    .sort()
}

/**
 * The owner of every object the campaign creates or re-owns.
 *
 * Ownership is not a detail: `stella_0004` deliberately does NOT set FORCE ROW
 * LEVEL SECURITY, so a table's owner is RLS-EXEMPT. One line —
 * `ALTER TABLE public.marketing_leads OWNER TO uellix_cap_lead` — makes every
 * policy in CAP-04 inert for the definer and hands it implicit SELECT, which is
 * the single thing that capability exists to deny. No gate read ownership at
 * all until this contract existed.
 */
// `CREATE SCHEMA … AUTHORIZATION uellix_owner` is an ownership statement and is
// declared here as one. It was invisible until 2026-08-04: the classifier
// returned early on CREATE SCHEMA with a comment claiming AUTHORIZATION was read
// "below", and nothing read it — so `CREATE SCHEMA … AUTHORIZATION
// uellix_cap_lead`, which confers CREATE and DROP over every capability
// function, produced no record and no finding.
const SCHEMA_OWNER = 'SCHEMA uellix_capability -> uellix_owner'

export const OWNERSHIP_CONTRACT: Readonly<Record<string, readonly string[]>> = {
  [FORWARD.CAP01]: [SCHEMA_OWNER, 'FUNCTION uellix_capability.accept_invitation -> uellix_cap_invitation'],
  [FORWARD.CAP02]: [
    SCHEMA_OWNER,
    'FUNCTION uellix_capability.verify_report -> uellix_cap_verification',
    'FUNCTION uellix_capability.record_verification_hit -> uellix_cap_verification',
  ],
  [FORWARD.CAP03]: [
    SCHEMA_OWNER,
    'FUNCTION uellix_capability.stripe_begin_event -> uellix_cap_stripe',
    'FUNCTION uellix_capability.stripe_apply_subscription -> uellix_cap_stripe',
    'FUNCTION uellix_capability.stripe_fail_event -> uellix_cap_stripe',
  ],
  [FORWARD.CAP04]: [SCHEMA_OWNER, 'FUNCTION uellix_capability.submit_lead -> uellix_cap_lead'],
  [FORWARD.CAP05]: [SCHEMA_OWNER, 'FUNCTION uellix_capability.bootstrap_organization -> uellix_cap_bootstrap'],
  [FORWARD.CAP06]: [
    SCHEMA_OWNER,
    'FUNCTION uellix_capability.admin_set_stella_service -> uellix_cap_platform',
    'FUNCTION uellix_capability.admin_set_organization_status -> uellix_cap_platform',
  ],
}

/** Tables whose RLS each package must ENABLE, and never disable. */
export const RLS_CONTRACT: Readonly<Record<string, readonly string[]>> = {
  [FORWARD.CAP01]: [],
  [FORWARD.CAP02]: ['public.report_public_disclosures', 'public.capability_verification_hits'],
  [FORWARD.CAP03]: ['public.stripe_webhook_events'],
  [FORWARD.CAP04]: [],
  [FORWARD.CAP05]: ['public.capability_bootstrap_attempts'],
  // stella_0011 creates no table, so it enables no RLS. The tables it touches
  // already have it, and its preconditions refuse to run if they do not.
  [FORWARD.CAP06]: [],
}

/** Indexes the design's arguments rest on, and whether uniqueness is the point. */
export const INDEX_CONTRACT: Readonly<Record<string, ReadonlyArray<{ name: string; unique: boolean }>>> = {
  // "provably single-row by construction" for the token lookup: SELECT … INTO
  // on a duplicate token_hash would take an ARBITRARY row.
  [FORWARD.CAP01]: [{ name: 'uq_invitations_token_hash', unique: true }],
  [FORWARD.CAP02]: [],
  [FORWARD.CAP03]: [],
  // The index that makes a duplicate submission indistinguishable from a new
  // one. Without uniqueness, ON CONFLICT DO NOTHING never fires and the
  // endpoint answers differently for a known address.
  [FORWARD.CAP04]: [{ name: 'uq_marketing_leads_email_source', unique: true }],
  [FORWARD.CAP05]: [],
  [FORWARD.CAP06]: [],
}

// ---------------------------------------------------------------------------
// The authoritative trigger contract (RR-CAP-02-F).
// ---------------------------------------------------------------------------
// A trigger is arbitrary code attached to a table, so every field of it is a
// security property: retarget the TABLE and the audit trail follows the wrong
// rows; change AFTER to BEFORE and the audit row can be written for a change
// that never commits; delete FOR EACH ROW and a multi-row UPDATE produces ONE
// audit event; swap the EXECUTEd function and the trail says whatever the new
// function says. Pinning the whole tuple is the same argument the policy
// contract makes, for the same reason.
//
// The parser refused CREATE TRIGGER outright until this contract existed. That
// was the right default and it is why this table had to be written rather than
// the refusal loosened.

interface TriggerContract {
  readonly name: string
  readonly file: string
  readonly table: string
  readonly timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF'
  readonly events: readonly string[]
  readonly level: 'ROW' | 'STATEMENT'
  readonly execute: string
}

export const TRIGGER_CONTRACT: readonly TriggerContract[] = [
  {
    name: 'trg_report_disclosure_audit',
    file: FORWARD.CAP02,
    table: 'public.report_public_disclosures',
    timing: 'AFTER',
    events: ['INSERT', 'UPDATE'],
    level: 'ROW',
    execute: 'public.uellix_audit_report_disclosure',
  },
  {
    // The OTHER half of "is this certificate visible". Public visibility is a
    // conjunction — sroi_reports.status = 'locked' AND revoked_at IS NULL — and
    // only the second conjunct lives on the audited table. Without this trigger
    // an analyst can take a certificate live or dark through sroi_reports and
    // leave no trace on report_public_disclosures at all.
    name: 'trg_report_visibility_audit',
    file: FORWARD.CAP02,
    table: 'public.sroi_reports',
    timing: 'AFTER',
    events: ['UPDATE'],
    level: 'ROW',
    execute: 'public.uellix_audit_report_visibility',
  },
  {
    name: 'trg_report_disclosures_append_only',
    file: FORWARD.CAP02,
    table: 'public.report_public_disclosures',
    timing: 'BEFORE',
    events: ['DELETE'],
    level: 'ROW',
    execute: 'public.uellix_forbid_mutation',
  },
  {
    name: 'trg_report_disclosures_no_truncate',
    file: FORWARD.CAP02,
    table: 'public.report_public_disclosures',
    timing: 'BEFORE',
    events: ['TRUNCATE'],
    level: 'STATEMENT',
    execute: 'public.uellix_forbid_mutation',
  },
]

/**
 * Triggers a rollback must drop, and triggers it must NOT.
 *
 * CAP-02's rollback keeps the rows because each is a human decision to publish;
 * it therefore keeps what makes those rows unerasable, and drops only the audit
 * trigger, whose event can no longer happen once the write path is gone.
 */
// Revised after adversarial review: NO rollback drops a trigger any more. The
// audit triggers used to go with the capability, on the argument that the write
// path was gone so the event could not happen. It could: uellix_owner is the
// table owner, exempt from RLS, reachable by SET ROLE from a LOGIN role, and
// sroi_reports.status stays writable by the runtime regardless. The map is kept
// because a future rollback that DOES drop one must declare it here.
export const ROLLBACK_DROPPED_TRIGGERS: Readonly<Record<string, readonly string[]>> = {
  [ROLLBACK.CAP01]: [],
  [ROLLBACK.CAP02]: [],
  [ROLLBACK.CAP03]: [],
  [ROLLBACK.CAP04]: [],
  [ROLLBACK.CAP05]: [],
  [ROLLBACK.CAP06]: [],
}

export const ROLLBACK_RETAINED_TRIGGERS: Readonly<Record<string, readonly string[]>> = {
  [ROLLBACK.CAP01]: [],
  [ROLLBACK.CAP02]: [
    'trg_report_disclosures_append_only',
    'trg_report_disclosures_no_truncate',
    'trg_report_disclosure_audit',
    'trg_report_visibility_audit',
  ],
  [ROLLBACK.CAP03]: [],
  [ROLLBACK.CAP04]: [],
  [ROLLBACK.CAP05]: [],
  [ROLLBACK.CAP06]: [],
}

// ---------------------------------------------------------------------------
// Function parsing (local: the gates must not depend on the old suite).
// ---------------------------------------------------------------------------

export interface ParsedFunction {
  readonly name: string
  readonly signature: string
  readonly header: string
  readonly body: string
}

export function parseFunctions(sql: string): ParsedFunction[] {
  const out: ParsedFunction[] = []
  const re =
    /CREATE OR REPLACE FUNCTION\s+uellix_capability\.(\w+)\s*\(([\s\S]*?)\n?AS \$\$([\s\S]*?)\n\$\$;/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    const rest = m[2]
    const closing = rest.indexOf(')')
    out.push({
      name: m[1],
      signature: closing === -1 ? rest : rest.slice(0, closing),
      header: rest,
      body: m[3],
    })
  }
  return out
}

/**
 * Strip comments, so prose describing a rule is never read as the rule.
 *
 * Delegates to the parser's masker rather than reimplementing it. The first
 * version was a line-wise `--` stripper that did NOT understand `/* … *\/`, and
 * eight gates read their input through it: wrapping a statement in a block
 * comment removed it from the applied SQL while leaving it visible to the gate.
 * Block-commenting the `REVOKE … FROM uellix_writer` in stella_0009 left
 * `cap04-net-reduction` green while the runtime kept full DML on the lead
 * table. Two implementations of "what is code" is one too many.
 */
export function codeOnly(sql: string): string {
  return stripComments(sql)
}

export const CAPABILITY_ROLES: Readonly<Record<string, string>> = {
  [FORWARD.CAP01]: 'uellix_cap_invitation',
  [FORWARD.CAP02]: 'uellix_cap_verification',
  [FORWARD.CAP03]: 'uellix_cap_stripe',
  [FORWARD.CAP04]: 'uellix_cap_lead',
  [FORWARD.CAP05]: 'uellix_cap_bootstrap',
  [FORWARD.CAP06]: 'uellix_cap_platform',
}

export const CAPABILITY_FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
  [FORWARD.CAP01]: ['accept_invitation'],
  [FORWARD.CAP02]: ['verify_report', 'record_verification_hit'],
  [FORWARD.CAP03]: ['stripe_begin_event', 'stripe_apply_subscription', 'stripe_fail_event'],
  [FORWARD.CAP04]: ['submit_lead'],
  [FORWARD.CAP05]: ['bootstrap_organization'],
  [FORWARD.CAP06]: ['admin_set_stella_service', 'admin_set_organization_status'],
}

/** The six publication flags of CAP-02. The old gate knew about four. */
export const DISCLOSURE_FLAGS: readonly string[] = [
  'show_organization_name',
  'show_report_title',
  'show_headline_ratio',
  'show_totals',
  'show_issued_on',
  'show_report_variant',
]

/**
 * Every expression verify_report publishes, and the flag that gates it.
 *
 * Per column, not per flag: show_totals gates THREE columns, so a check that
 * `CASE WHEN d.show_totals` appears somewhere is satisfied after two of the
 * three have been un-gated.
 */
export const PUBLISHED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['show_organization_name', 'o.name::text'],
  ['show_report_title', 'r.title::text'],
  ['show_issued_on', 'r.locked_at::date'],
  ['show_report_variant', 'r.report_variant::text'],
  ['show_headline_ratio', 'run.sroi_ratio'],
  ['show_totals', 'run.total_investment'],
  ['show_totals', 'run.net_social_value'],
  ['show_totals', 'run.currency::text'],
]

/** The fixed source allowlist of CAP-04. */
export const LEAD_SOURCES: readonly string[] = [
  'sroi_calculator',
  'landing_hero',
  'pricing',
  'demo_request',
  'contact_form',
]

// ---------------------------------------------------------------------------

/**
 * What a ROLLBACK is allowed to confer or create.
 *
 * The answer is "almost nothing", and it needed saying out loud: gates 1-3 all
 * iterated the FORWARD files only, so a `CREATE POLICY … USING (true)` or a
 * `GRANT … TO PUBLIC` planted in a rollback was invisible to every check — in
 * the files that run as superuser during an incident, when nobody is reading.
 *
 * stella_0009_rollback is the one exception, and it is a RESTORATION: the
 * forward script revokes the runtime's privileges on marketing_leads and drops
 * two PostgREST-era policies, so undoing it means putting all three back. A
 * rollback that quietly hardens produces a state matching neither before nor
 * after.
 */
export const ROLLBACK_GRANT_CONTRACT: Readonly<Record<string, readonly string[]>> = {
  [ROLLBACK.CAP01]: [],
  [ROLLBACK.CAP02]: [],
  [ROLLBACK.CAP03]: [],
  [ROLLBACK.CAP04]: [
    'SELECT ON TABLE:public.marketing_leads TO uellix_writer',
    'INSERT ON TABLE:public.marketing_leads TO uellix_writer',
    'UPDATE ON TABLE:public.marketing_leads TO uellix_writer',
    'DELETE ON TABLE:public.marketing_leads TO uellix_writer',
  ],
  [ROLLBACK.CAP05]: [],
  // The second RESTORATION, and the more uncomfortable one: stella_0011
  // replaced a table-level UPDATE with a column list, so undoing it puts the
  // table-level grant back — and with it RR-CAP-10. A rollback that kept the
  // narrower grant would leave a database matching neither side of the change.
  [ROLLBACK.CAP06]: [
    'UPDATE ON TABLE:public.organizations TO authenticated',
    'UPDATE ON TABLE:public.organizations TO uellix_writer',
    'DELETE ON TABLE:public.organizations TO authenticated',
    'DELETE ON TABLE:public.organizations TO uellix_writer',
  ],
}

export const ROLLBACK_POLICY_CONTRACT: Readonly<Record<string, readonly string[]>> = {
  [ROLLBACK.CAP01]: [],
  [ROLLBACK.CAP02]: [],
  [ROLLBACK.CAP03]: [],
  [ROLLBACK.CAP04]: ['anon_insert_marketing_leads', 'authenticated_insert_marketing_leads'],
  [ROLLBACK.CAP05]: [],
  [ROLLBACK.CAP06]: [],
}

/** Every attribute a capability role must NOT have. All seven, not five. */
const FORBIDDEN_ROLE_ATTRIBUTES = [
  'NOLOGIN',
  'NOINHERIT',
  'NOBYPASSRLS',
  'NOCREATEROLE',
  'NOCREATEDB',
  'NOREPLICATION',
  'NOSUPERUSER',
] as const

export function evaluateCapabilityGates(sources: Sources): Violation[] {
  const v: Violation[] = []
  const add = (gate: string, detail: string) => v.push({ gate, detail })
  /**
   * The text a gate judges is the file, and the parser goes INTO it.
   *
   * The previous version appended every `EXECUTE '<literal>'` to the end of the
   * source, because the masker could not see inside a string. That worked for
   * the literal form and for nothing else: DDL written directly inside a DO
   * body, or built with format(), was neither appended nor visible. The scanner
   * now descends into DO blocks, function bodies and executed literals itself,
   * so appending would count every executed statement twice — and a policy
   * created from a literal would trip the duplicate-name check for the wrong
   * reason.
   */
  const src = (f: string): string => sources[f] ?? ''
  const verbatim = (f: string): string => sources[f] ?? ''

  // -- Gate 0: nothing that looks like a security statement is unreadable ----
  //
  // THE FAIL-CLOSED GATE. Every other gate in this file answers "does the text
  // say the right thing?", and every one of them treats an unmatched pattern as
  // a satisfied condition. That inversion is what let eight PostgreSQL-
  // equivalent spellings of a security operation pass: a quoted grantee, a
  // nested block comment, a REASSIGN OWNED and a DO block full of DDL each
  // matched nothing, and matching nothing read as containing nothing.
  //
  // This gate asserts the parser's own completeness. A statement that OPENS
  // like a security operation and does not classify is a violation with a file,
  // a line and a reason — never an absence.
  for (const file of CAPABILITY_SQL_FILES) {
    for (const u of analyzeSecurity(src(file)).unparsed) {
      add(
        'unparsed-security-statement',
        `${file}:${u.line} (${u.origin}, ${u.reason}) ${u.lead} — ${u.detail}`,
      )
    }
  }

  // -- Gate 1: the policy tuple contract ------------------------------------
  for (const file of Object.values(FORWARD)) {
    const parsed = parsePolicies(src(file))
    const expected = POLICY_CONTRACT.filter((p) => p.file === file)

    const seen = new Set(parsed.map((p) => p.name))
    for (const e of expected) {
      const actual = parsed.find((p) => p.name === e.name)
      if (!actual) {
        add('policy-inventory', `${file}: policy ${e.name} is missing`)
        continue
      }
      if (actual.table !== e.table)
        add('policy-table', `${e.name}: attached to ${actual.table}, expected ${e.table}`)
      if (actual.permissive !== e.mode)
        add('policy-mode', `${e.name}: is ${actual.permissive}, expected ${e.mode}`)
      if (actual.command !== e.command)
        add('policy-command', `${e.name}: FOR ${actual.command}, expected ${e.command}`)
      if (actual.roles.join(',') !== e.roles.join(','))
        add('policy-to', `${e.name}: TO [${actual.roles.join(', ') || '<absent>'}], expected [${e.roles.join(', ')}]`)
      const nu = e.using === null ? null : normalizeExpr(e.using)
      const nc = e.check === null ? null : normalizeExpr(e.check)
      if (actual.using !== nu)
        add('policy-using', `${e.name}: USING is ${actual.using ?? '<absent>'}, expected ${nu ?? '<absent>'}`)
      if (actual.withCheck !== nc)
        add('policy-with-check', `${e.name}: WITH CHECK is ${actual.withCheck ?? '<absent>'}, expected ${nc ?? '<absent>'}`)
    }
    for (const p of parsed) {
      if (!expected.some((e) => e.name === p.name))
        add('policy-inventory', `${file}: undeclared policy ${p.name}`)
    }
    if (seen.size !== parsed.length) add('policy-inventory', `${file}: duplicate policy name`)
  }

  // -- Gate 2: no policy reaches a pre-existing or public role ---------------
  for (const file of Object.values(FORWARD)) {
    for (const p of parsePolicies(src(file))) {
      if (p.roles.length === 0)
        add('policy-to-absent', `${file}: policy ${p.name} has no TO clause, which is TO PUBLIC`)
      for (const r of p.roles) {
        if (['public', 'anon', 'authenticated', 'service_role'].includes(r))
          add('policy-to-widened', `${file}: policy ${p.name} names ${r}`)
      }
    }
  }

  // -- Gate 3: the privilege contract, per statement AND per privilege -------
  for (const file of Object.values(FORWARD)) {
    const actual = grantSignatures(src(file))
    const expected = [...(GRANT_CONTRACT[file] ?? [])].sort()
    for (const e of expected) if (!actual.includes(e)) add('grant-missing', `${file}: ${e}`)
    for (const a of actual) if (!expected.includes(a)) add('grant-extra', `${file}: ${a}`)
  }

  // -- Gate 4: every capability function is revoked from PUBLIC --------------
  for (const [file, fns] of Object.entries(CAPABILITY_FUNCTIONS)) {
    const revokes = parseRevokes(src(file)).filter(
      (r) => r.objectType === 'FUNCTION' && r.grantees.includes('public'),
    )
    for (const fn of fns) {
      const r = revokes.find((x) => x.object === `uellix_capability.${fn}`)
      if (!r) {
        add('function-revoke', `${file}: EXECUTE on ${fn} is not revoked from PUBLIC`)
        continue
      }
      // The PRIVILEGE matters, not just the object and the grantee. A function
      // created with a NULL proacl is EXECUTE TO PUBLIC implicitly, so
      // `REVOKE UPDATE ON FUNCTION … FROM PUBLIC` removes nothing while
      // satisfying an object-and-grantee check.
      if (!r.privileges.some((p) => p.privilege === 'ALL' || p.privilege === 'EXECUTE'))
        add(
          'function-revoke',
          `${file}: the REVOKE on ${fn} takes [${r.privileges.map((p) => p.privilege).join(', ')}], not ALL or EXECUTE`,
        )
    }
  }

  // -- Gate 4b: a package retires only the policies it declares --------------
  // CAP-04 retires two named PostgREST-era policies and that is deliberate.
  // Nothing else may drop a policy it did not create: a forward package that
  // quietly removes a pre-existing tenancy policy would leave the table open
  // and every count in this suite unchanged.
  const DECLARED_RETIREMENTS = new Set([
    'anon_insert_marketing_leads',
    'authenticated_insert_marketing_leads',
  ])
  for (const file of Object.values(FORWARD)) {
    const created = new Set(parsePolicies(src(file)).map((p) => p.name))
    // Structured, not `/DROP POLICY IF EXISTS\s+(\w+)/`: `\w+` cannot read
    // `DROP POLICY IF EXISTS "tenancy policy" ON …`, and a name it cannot read
    // is a drop this gate would not have seen.
    for (const d of parseDroppedPolicies(src(file))) {
      if (created.has(d.name) || DECLARED_RETIREMENTS.has(d.name)) continue
      add('policy-retired', `${file}: drops ${d.name}, which it does not create and was not declared retired`)
    }
  }
  // The ROLLBACKS need the same rule and did not have it. Gate 4b iterated the
  // forward files only, so `DROP POLICY IF EXISTS <someone else's tenancy
  // policy>` planted in a rollback was checked by nothing — in the file that
  // runs as superuser during an incident. A rollback may drop what its own
  // forward created, what that forward declared retired, and what the rollback
  // itself restores.
  for (const key of Object.keys(FORWARD) as Array<keyof typeof FORWARD>) {
    const created = new Set(parsePolicies(src(FORWARD[key])).map((p) => p.name))
    const restored = new Set(ROLLBACK_POLICY_CONTRACT[ROLLBACK[key]] ?? [])
    for (const d of parseDroppedPolicies(src(ROLLBACK[key]))) {
      if (created.has(d.name) || DECLARED_RETIREMENTS.has(d.name) || restored.has(d.name)) continue
      add(
        'policy-retired',
        `${ROLLBACK[key]}: drops ${d.name}, which its forward package does not create`,
      )
    }
  }

  // -- Gate 5: SECURITY DEFINER standard, per function -----------------------
  for (const [file, fns] of Object.entries(CAPABILITY_FUNCTIONS)) {
    const parsed = parseFunctions(codeOnly(src(file)))
    if (parsed.length !== fns.length)
      add('definer-inventory', `${file}: ${parsed.length} functions, expected ${fns.length}`)
    for (const fn of parsed) {
      if (!/\bSECURITY DEFINER\b/.test(fn.header))
        add('definer-security', `${fn.name} is not SECURITY DEFINER`)
      if (!/SET search_path = ''/.test(fn.header))
        add('definer-search-path', `${fn.name} has no empty search_path`)
      if (/\bSELECT\s+\*/i.test(fn.body)) add('definer-select-star', `${fn.name} uses SELECT *`)
      if (/pg_catalog\.(coalesce|nullif|greatest|least)\s*\(/i.test(fn.body))
        add('definer-overqualified', `${fn.name} qualifies a grammar production`)
      // EXECUTE of ANYTHING that is not a self-contained literal. The first
      // version matched `EXECUTE format(` and `EXECUTE '…' ||` only, so
      // `v_sql := '…' || p_source || '…'; EXECUTE v_sql;` — plain SQL injection
      // into a SECURITY DEFINER reachable by anonymous traffic — matched
      // neither.
      if (/\bEXECUTE\s+(?!'[^']*'\s*;)/i.test(fn.body))
        add('definer-dynamic-sql', `${fn.name} executes something that is not a fixed literal`)
      if (!/EXCEPTION[\s\S]*WHEN OTHERS THEN/.test(fn.body) && !/LANGUAGE sql/i.test(fn.header))
        add('definer-uniform-error', `${fn.name} has no WHEN OTHERS handler`)
      // SQLERRM anywhere the caller can see it, not just in a RAISE LOG. The
      // reachable case this protects is named in stella_0006 itself: a 23505 on
      // user_single_active_membership, whose DETAIL reads «Key (user_id)=(…)
      // already exists» — a real user id returned to whoever called.
      for (const m of fn.body.matchAll(/RAISE\s+(LOG|NOTICE|WARNING|INFO|DEBUG|EXCEPTION)([^;]*);/gi)) {
        if (!/\bSQLERRM\b/.test(m[2])) continue
        add(
          'definer-sqlerrm',
          `${fn.name} puts SQLERRM in a RAISE ${m[1].toUpperCase()}; only SQLSTATE may be logged and nothing may reach the caller`,
        )
      }
      if (/USING[^;]*\b(HINT|DETAIL)\s*=/i.test(fn.body))
        add('definer-detail', `${fn.name} attaches HINT or DETAIL`)
      // PL/pgSQL's WHEN OTHERS does NOT match query_canceled (57014) or
      // assert_failure. A statement_timeout firing mid-call would otherwise
      // reach the caller as 57014 with PostgreSQL's own message, straight
      // through the uniform-refusal argument — and uellix_stripe carries
      // statement_timeout as a ROLE setting, so it is not hypothetical.
      // ADVERSARIAL_FINDINGS_ROUND2 A2-F07 claimed a gate for this; there was
      // none until now.
      if (!/LANGUAGE sql/i.test(fn.header) && !/WHEN query_canceled THEN/.test(fn.body))
        add('definer-query-canceled', `${fn.name} has no WHEN query_canceled branch, so 57014 escapes the uniform refusal`)
    }
  }

  // -- Gate 6: role attributes and role isolation ---------------------------
  for (const [file, role] of Object.entries(CAPABILITY_ROLES)) {
    // matchAll, not exec. The first version read only the FIRST ALTER ROLE for
    // the role, so appending a second one — `ALTER ROLE uellix_cap_stripe
    // BYPASSRLS;` — left the gate green while every policy in the package
    // became decoration. Every attribute statement for the role is considered,
    // and the LAST one wins, because that is what PostgreSQL does.
    //
    // STRUCTURED, not `/ALTER ROLE\s+<role>\s*\n?\s*([^;]+);/`. That pattern
    // anchored on a BARE role name, so `ALTER ROLE "uellix_cap_lead"
    // BYPASSRLS SUPERUSER;` — the same role, spelled the way PostgreSQL also
    // accepts — matched nothing at all, and matching nothing left every
    // attribute "declared" by the first statement and none contradicted.
    // CREATE ROLE counts too: these packages create the role inside a DO block
    // through EXECUTE, and its attributes are no less real for that.
    const roleStmts = parseRoleStatements(src(file)).filter(
      (s) => s.role === role && s.verb !== 'DROP',
    )
    const altered = roleStmts.filter((s) => s.verb === 'ALTER')
    if (altered.length === 0) {
      add('role-attributes', `${file}: no ALTER ROLE for ${role}`)
    } else {
      for (const forbidden of FORBIDDEN_ROLE_ATTRIBUTES) {
        const positive = forbidden.slice(2) // NOBYPASSRLS -> BYPASSRLS
        const declared = roleStmts.some((s) => s.attributes.includes(forbidden))
        const contradicted = roleStmts.some((s) => s.attributes.includes(positive))
        if (!declared) add('role-attributes', `${role} is missing ${forbidden}`)
        if (contradicted) add('role-attributes', `${role} is given ${positive}`)
      }
    }
    // Outbound: the capability role handed to someone else.
    for (const g of parseGrants(src(file))) {
      if (g.objectType === 'ROLE' && g.object === role)
        add('role-membership', `${file}: ${role} is granted to another role`)
    }
    // INBOUND: the capability role made a member of someone else. This is the
    // direction that matters most and the one the first version could not see —
    // `GRANT uellix_owner TO uellix_cap_bootstrap` gives the definer the table
    // owner's privileges, and with no FORCE ROW LEVEL SECURITY anywhere in the
    // campaign, ownership means RLS-exempt.
    for (const g of parseGrants(src(file))) {
      if (g.objectType !== 'ROLE') continue
      if (g.grantees.includes(role))
        add('role-membership', `${file}: ${role} is made a member of ${g.object}`)
    }
    // Another capability's role named as a recipient anywhere in this package.
    // Read from the parsed statements rather than from `/\bTO\s+<role>\b/` over
    // the text, so a quoted spelling is the same finding and a mention inside a
    // comment is not a finding at all.
    const recipients = new Set<string>([
      ...parseGrants(src(file)).flatMap((g) => [...g.grantees, ...(g.objectType === 'ROLE' ? [g.object] : [])]),
      ...parsePolicies(src(file)).flatMap((p) => [...p.roles]),
      ...parseOwnerships(src(file)).map((o) => o.owner),
      ...parseOwnedStatements(src(file)).flatMap((o) => [...o.from, ...(o.to ? [o.to] : [])]),
    ])
    for (const other of Object.values(CAPABILITY_ROLES)) {
      if (other === role) continue
      if (recipients.has(other)) add('role-crossgrant', `${file}: names ${other}`)
    }
  }

  // -- Gate 6z: the campaign touches ONLY the roles it declares -------------
  //
  // Gate 6 reads role statements for the five capability roles and for nothing
  // else, because it iterates CAPABILITY_ROLES. That left every OTHER role
  // unguarded: `ALTER ROLE uellix_writer BYPASSRLS;` parses cleanly, produces
  // no unparsed finding, and is consumed by no gate — while making the runtime
  // exempt from cap_lead_deny_runtime, the RESTRICTIVE USING(false) that
  // CAP-04 calls its durable half. `CREATE ROLE backdoor LOGIN SUPERUSER` had
  // the same standing: parsed, then ignored.
  //
  // Two properties, both over EVERY file including the rollbacks — a rollback
  // runs as superuser during an incident, which is when nobody is reading.
  const DECLARED_ROLES = new Set<string>([...Object.values(CAPABILITY_ROLES), 'uellix_stripe'])
  const DANGEROUS_ROLE_ATTRIBUTES = ['SUPERUSER', 'BYPASSRLS', 'CREATEROLE', 'CREATEDB', 'REPLICATION']
  for (const file of CAPABILITY_SQL_FILES) {
    for (const s of parseRoleStatements(src(file))) {
      if (!DECLARED_ROLES.has(s.role))
        add(
          'role-foreign',
          `${file}: ${s.verb} ROLE ${s.role} — the campaign declares no role by that name, ` +
            'and a role statement is unbounded by any policy',
        )
      for (const a of s.attributes) {
        if (DANGEROUS_ROLE_ATTRIBUTES.includes(a))
          add('role-dangerous-attribute', `${file}: ${s.verb} ROLE ${s.role} is given ${a}`)
      }
    }
  }

  // -- Gate 6a: ownership transferred wholesale ----------------------------
  //
  // REASSIGN OWNED BY uellix_owner TO uellix_cap_lead re-owns EVERY object the
  // owner holds in one statement — every table in public, not one function.
  // With no FORCE ROW LEVEL SECURITY anywhere in the campaign, that is a
  // blanket RLS exemption for a role whose entire purpose is to be bounded by
  // RLS. DROP OWNED BY is its destructive twin: it removes the privileges and
  // the objects, which changes the contract by deletion rather than by grant.
  //
  // Neither appeared in any pattern in this file before, in either direction.
  for (const file of CAPABILITY_SQL_FILES) {
    for (const o of parseOwnedStatements(src(file))) {
      // TWO LITERAL CALLS, not one with a ternary for the gate name.
      // tests/capability-mutation.test.ts derives the set of gate names by
      // matching the helper call and a single-quoted literal in this file's
      // SOURCE — so a gate name computed at
      // runtime is a gate the coverage check CANNOT SEE — and that check exists
      // precisely to make an unexercised gate visible. Written as a ternary,
      // these two were exercised by E-06 and F-02 and still absent from the
      // derived inventory.
      const detail =
        `${file}: ${o.verb} OWNED BY ${o.from.join(', ')}${o.to ? ` TO ${o.to}` : ''} — ` +
        'a whole-catalogue ownership change is not expressible in the capability contract'
      if (o.verb === 'REASSIGN') add('ownership-reassigned', detail)
      else add('ownership-dropped', detail)
    }
  }

  // -- Gate 6a2: default privileges ---------------------------------------
  //
  // ALTER DEFAULT PRIVILEGES … GRANT EXECUTE ON FUNCTIONS TO PUBLIC does not
  // grant anything today; it grants it to everything created tomorrow. Every
  // capability function depends on `REVOKE ALL … FROM PUBLIC` closing the
  // implicit default, and a default privilege re-opens it for the NEXT
  // function without touching any statement this file inspects.
  //
  // The campaign uses none, so the contract is: none.
  for (const file of CAPABILITY_SQL_FILES) {
    for (const d of parseDefaultPrivileges(src(file))) {
      add(
        'default-privileges',
        `${file}: ALTER DEFAULT PRIVILEGES ${d.action} ${d.privileges.join(' ')} ON ${d.objectKind} ` +
          `TO ${d.grantees.join(', ')} — the campaign declares no default privileges`,
      )
    }
  }

  // -- Gate 6b: ownership -------------------------------------------------
  for (const file of Object.values(FORWARD)) {
    const declared = [...(OWNERSHIP_CONTRACT[file] ?? [])].sort()
    const actual = parseOwnerships(src(file))
      .map((o) => `${o.objectType} ${o.object} -> ${o.owner}`)
      .sort()
    for (const d of declared) if (!actual.includes(d)) add('ownership-missing', `${file}: ${d}`)
    for (const a of actual)
      if (!declared.includes(a))
        add('ownership-extra', `${file}: ${a} — ownership is RLS exemption, there being no FORCE ROW LEVEL SECURITY`)
  }

  // -- Gate 6c: row-level security is enabled and never switched off -------
  for (const file of Object.values(FORWARD)) {
    const toggles = parseRlsToggles(src(file))
    for (const t of toggles) {
      if (t.action === 'DISABLE' || t.action === 'NO FORCE')
        add('rls-disabled', `${file}: ${t.action} ROW LEVEL SECURITY on ${t.table}`)
    }
    for (const table of RLS_CONTRACT[file] ?? []) {
      if (!toggles.some((t) => t.table === table && t.action === 'ENABLE'))
        add('rls-not-enabled', `${file}: ${table} never enables row level security`)
    }
  }

  // -- Gate 6d: the indexes the design's arguments rest on -----------------
  for (const file of Object.values(FORWARD)) {
    const found = parseIndexes(src(file))
    for (const want of INDEX_CONTRACT[file] ?? []) {
      const got = found.find((i) => i.name === want.name)
      if (!got) add('index-missing', `${file}: ${want.name}`)
      else if (got.unique !== want.unique)
        add('index-uniqueness', `${file}: ${want.name} is ${got.unique ? '' : 'not '}UNIQUE`)
    }
  }

  // -- Gate 6e: triggers, pinned as whole tuples (RR-CAP-02-F) --------------
  {
    const declared = new Map(TRIGGER_CONTRACT.map((t) => [t.name, t]))
    for (const file of Object.values(FORWARD)) {
      for (const got of parseTriggers(src(file))) {
        const want = declared.get(got.name)
        if (!want || want.file !== file) {
          // An UNDECLARED trigger is the finding, not a curiosity: it is code
          // on a table, added by a package, that no contract describes.
          add('trigger-extra', `${file}: ${got.name} on ${got.table} is not in TRIGGER_CONTRACT`)
          continue
        }
        const shape = `${got.timing} ${[...got.events].join(',')} ${got.level} -> ${got.execute} ON ${got.table}`
        const wantShape = `${want.timing} ${[...want.events].join(',')} ${want.level} -> ${want.execute} ON ${want.table}`
        if (shape !== wantShape) add('trigger-shape', `${file}: ${got.name} is ${shape}, contract says ${wantShape}`)
        // A WHEN clause narrows when the trigger fires. None of the three has
        // one, and adding one is how an audit trail acquires a blind spot.
        if (got.when !== null) add('trigger-when', `${file}: ${got.name} carries a WHEN clause`)
      }
    }
    for (const want of TRIGGER_CONTRACT) {
      const found = parseTriggers(src(want.file)).some((t) => t.name === want.name)
      if (!found) add('trigger-missing', `${want.file}: ${want.name}`)
    }
    // Every CREATE must be preceded by its own DROP … IF EXISTS, or a re-apply
    // stacks a second trigger on the same table and the audit trail doubles.
    for (const want of TRIGGER_CONTRACT) {
      const dropped = parseDroppedTriggers(src(want.file))
        .some((d) => d.name === want.name && d.table === want.table)
      if (!dropped) add('trigger-not-convergent', `${want.file}: ${want.name} is created without a preceding DROP`)
    }
  }

  // -- Gate 6f: what a rollback does to a trigger ---------------------------
  for (const [rb, names] of Object.entries(ROLLBACK_DROPPED_TRIGGERS)) {
    const dropped = new Set(parseDroppedTriggers(src(rb)).map((d) => d.name))
    for (const n of names) if (!dropped.has(n)) add('rollback-trigger', `${rb}: ${n} is not dropped`)
    for (const n of ROLLBACK_RETAINED_TRIGGERS[rb] ?? []) {
      if (dropped.has(n)) add('rollback-trigger-retained', `${rb}: ${n} must survive the rollback but is dropped`)
    }
    // A rollback that CREATES a trigger is planting code during an incident.
    for (const t of parseTriggers(src(rb))) {
      add('rollback-trigger-created', `${rb}: creates trigger ${t.name} on ${t.table}`)
    }
  }

  // -- Gate 6g: CAP-02, the publication trail (RR-CAP-02-F) ----------------
  {
    const cap02 = codeOnly(src(FORWARD.CAP02))
    const fnMatch = /CREATE OR REPLACE FUNCTION public\.uellix_audit_report_disclosure\(\)([\s\S]*?)\n\$\$;/
      .exec(cap02)
    if (!fnMatch) {
      add('cap02-audit-function', 'uellix_audit_report_disclosure is absent, so publishing leaves no trace')
    } else {
      const body = fnMatch[1]
      if (!/INSERT INTO public\.audit_logs/.test(body)) {
        add('cap02-audit-writes', 'the disclosure trigger does not write audit_logs')
      }
      // Not SECURITY DEFINER: the row must be written with the CALLER's
      // privileges so audit_logs' own policy pins actor_user_id to auth.uid().
      // A definer here would let the trigger insert rows the caller could not.
      if (/SECURITY DEFINER/.test(fnMatch[0])) {
        add('cap02-audit-caller-rights', 'the disclosure trigger is SECURITY DEFINER; the actor would no longer be pinned by RLS')
      }
      if (!/actor_user_id[\s\S]{0,400}auth\.uid\(\)/.test(body) && !/auth\.uid\(\)/.test(body)) {
        add('cap02-audit-actor', 'the audit row does not record auth.uid() as the actor')
      }
      // The summary is free text a person wrote. A digest answers "did what
      // circulated change?"; the text itself would put a payload in a log that
      // holds none anywhere else.
      // `app.request_id` is a custom GUC any role can set to arbitrary text, so
      // an unvalidated copy is a free-text channel into an APPEND-ONLY table.
      if (!/\^\[A-Za-z0-9_\.:-\]\{1,64\}\$/.test(body)) {
        add('cap02-audit-request-id',
          'app.request_id is copied into audit_logs without a shape bound; it is a free-text channel into an append-only table')
      }
      if (!/sha256/.test(body)) {
        add('cap02-audit-digest', 'public_summary is not reduced to a digest')
      }
      if (/'summary'\s*,\s*(?:NEW|OLD)\.public_summary/.test(body)) {
        add('cap02-audit-digest', 'the audit row carries public_summary as text')
      }
      // Each transition named apart, or "how many certificates were withdrawn"
      // needs a diff of every pair of rows to answer.
      for (const action of ['report.disclosure.published', 'report.disclosure.revoked',
                            'report.disclosure.reinstated']) {
        if (!body.includes(action)) add('cap02-audit-transitions', `${action} is never recorded`)
      }
    }
  }

  // -- Gate 6h: stella_0011, the organizations column ACL (RR-CAP-10) ------
  {
    const cap06 = codeOnly(src(FORWARD.CAP06))

    // The columns an organisation admin must never move through the ORM.
    const ADMINISTRATIVE = [
      'stella_monthly_quota', 'stella_plan_label', 'status',
      'stripe_customer_id', 'stripe_subscription_id', 'stripe_price_id',
    ]

    // (1) The table-level UPDATE must be taken back from BOTH principals.
    // `authenticated` is the one that gets forgotten: it is PostgREST's role,
    // reachable from a browser with nothing but a user's own JWT.
    const revoked = parseRevokes(src(FORWARD.CAP06)).filter(
      (r) => r.object === 'public.organizations'
        && r.privileges.some((pr) => pr.privilege === 'UPDATE' && pr.columns === null),
    )
    const revokedFrom = new Set(revoked.flatMap((r) => r.grantees))
    for (const who of ['authenticated', 'uellix_writer']) {
      if (!revokedFrom.has(who)) {
        add('cap06-revoke', `the table-level UPDATE on organizations is not revoked from ${who}`)
      }
    }

    // (2) …and no runtime grant may name an administrative column. Read from
    // the parsed grants, not from the text: a column added inside the
    // parenthesis is a one-word edit that reads like formatting.
    for (const g of parseGrants(src(FORWARD.CAP06))) {
      if (g.object !== 'public.organizations') continue
      if (!g.grantees.some((r) => r === 'uellix_writer' || r === 'authenticated')) continue
      for (const pr of g.privileges) {
        for (const col of pr.columns ?? []) {
          if (ADMINISTRATIVE.includes(col)) {
            add('cap06-quota-excluded', `the runtime is granted UPDATE (${col}) on organizations`)
          }
        }
      }
    }

    // (3) The definer must check the CALLER, in the body as well as in the
    // policy. Two independent locks: the policy survives a rewritten body, the
    // body survives a policy someone drops by hand during an incident.
    const fns = parseFunctions(cap06)
    for (const name of ['admin_set_stella_service', 'admin_set_organization_status']) {
      const fn = fns.find((f) => f.name === name)
      if (!fn) {
        add('cap06-function', `${name} is absent`)
        continue
      }
      if (!/IF NOT public\.current_user_is_super_admin\(\) THEN/.test(fn.body)) {
        add('cap06-super-admin-check', `${name} does not refuse a caller that is not a platform super_admin`)
      }
      if (!/INSERT INTO public\.audit_logs/.test(fn.body)) {
        add('cap06-audit-atomic', `${name} moves an administrative column without recording it in the same transaction`)
      }
    }
    const status = fns.find((f) => f.name === 'admin_set_organization_status')
    if (status && !/p_status NOT IN \('active','suspended'\)/.test(status.body)) {
      // `status` carries no CHECK constraint in the baseline, so an
      // unvalidated parameter lets a platform admin invent a state nothing
      // handles — including one that reads as "not suspended".
      add('cap06-status-allowlist', 'admin_set_organization_status accepts a status outside (active, suspended)')
    }
  }

  // -- Gate 6h-bis: the owner default ACL, taken back explicitly -----------
  // `ALTER DEFAULT PRIVILEGES FOR ROLE uellix_owner IN SCHEMA public GRANT
  // SELECT, INSERT ON TABLES TO uellix_writer` (baseline) fires the moment a
  // package creates a table in its owner window, at TABLE level, BEFORE any
  // column-scoped grant runs. ACLs are additive, so a package that creates a
  // table and then grants by column has narrowed nothing unless it revokes
  // first. Two of the three tables in this campaign had that hole.
  {
    const NEEDS_REVOKE: ReadonlyArray<readonly [string, string]> = [
      [FORWARD.CAP02, 'public.report_public_disclosures'],
      [FORWARD.CAP02, 'public.capability_verification_hits'],
      [FORWARD.CAP03, 'public.stripe_webhook_events'],
      [FORWARD.CAP05, 'public.capability_bootstrap_attempts'],
    ]
    for (const [file, table] of NEEDS_REVOKE) {
      const revoked = parseRevokes(src(file)).some(
        (r) => r.object === table && r.grantees.includes('uellix_writer'),
      )
      if (!revoked) {
        add('default-acl-not-revoked',
          `${file}: creates ${table} without revoking the owner default ACL from uellix_writer`)
      }
    }
  }

  // -- Gate 6i: CAP-03, the claimed Stripe address (RR-CAP-14) -------------
  {
    const cap03 = codeOnly(src(FORWARD.CAP03))
    const begin = parseFunctions(cap03).find((f) => f.name === 'stripe_begin_event')
    if (begin) {
      if (!/stripe_customer_id, stripe_subscription_id/.test(begin.body)) {
        add('cap03-claim-identity', 'the claim does not record the Stripe address the event is addressed to, so no row bound can be derived from it')
      }
      if (!/IS NOT DISTINCT FROM p_stripe_customer_id/.test(begin.body)) {
        add('cap03-claim-identity', 'an existing event id can be re-claimed under a different Stripe address')
      }
    }
    const apply = parseFunctions(cap03).find((f) => f.name === 'stripe_apply_subscription')
    if (apply) {
      // The body must correlate the event to the address it matches on, not
      // merely check that the event is claimed. Both reviewers found the same
      // consequence independently: without it, the two identity columns
      // RR-CAP-14 added are read by the policy and IGNORED by the function.
      if (!/e\.event_id = p_event_id[\s\S]{0,400}e\.stripe_customer_id = p_match_value/.test(apply.body)) {
        add('cap03-claim-correlated',
          'stripe_apply_subscription does not require the claimed event to carry the address it matches on')
      }
      // …and it must publish WHICH event it is applying, or the RESTRICTIVE
      // policies fall back to "some event is in flight".
      if (!/set_config\('app\.stripe_event_id', p_event_id, true\)/.test(apply.body)) {
        add('cap03-claim-correlated',
          'stripe_apply_subscription does not publish the event id the policies correlate against')
      }
      // A customer-addressed event must not be able to detach a subscription.
      if (!/stripe_subscription_id = COALESCE\(p_stripe_subscription_id, stripe_subscription_id\)/.test(apply.body)) {
        add('cap03-subscription-coalesce',
          'a customer-addressed event can null out the organisation stripe_subscription_id')
      }
    }

    // The two-argument form must be dropped, not merely shadowed: an event
    // claimed through it carries no address and matches no organisation.
    if (!/DROP FUNCTION IF EXISTS uellix_capability\.stripe_begin_event\(text, text\);/.test(cap03)) {
      add('cap03-claim-identity', 'the pre-RR-CAP-14 two-argument stripe_begin_event is not dropped')
    }
  }

  // -- Gate 7: CAP-01, the invitation business guards ------------------------
  {
    const fn = parseFunctions(codeOnly(src(FORWARD.CAP01)))[0]
    if (!fn) {
      add('cap01-function', 'accept_invitation is absent')
    } else {
      const b = fn.body
      const at = (needle: string | RegExp) =>
        typeof needle === 'string' ? b.indexOf(needle) : b.search(needle)
      const require = (gate: string, ok: boolean, detail: string) => {
        if (!ok) add(gate, detail)
      }

      require('cap01-subject', /v_subject\s*:=\s*auth\.uid\(\)/.test(b), 'the subject does not come from auth.uid()')
      require('cap01-subject', /IF v_subject IS NULL THEN/.test(b), 'a NULL auth.uid() is not refused')
      require('cap01-no-jwt-email', !/jwt\.claims/.test(b), "the e-mail is taken from the JWT")
      require('cap01-email-source', /FROM public\.users u/.test(b), 'the e-mail is not read from public.users')
      require(
        'cap01-email-check',
        /v_subject_email\s*<>\s*pg_catalog\.lower\(pg_catalog\.btrim\(v_inv_email\)\)/.test(b),
        'the recipient e-mail is not compared',
      )
      require('cap01-token-hash', /pg_catalog\.sha256\(pg_catalog\.convert_to\(p_token/.test(b), 'the token is not hashed server-side')
      require('cap01-token-shape', /p_token !~ '\^\[0-9a-f\]\{64\}\$'/.test(b), 'the token shape is not checked')
      require('cap01-expiry', /v_inv_expires_at <= \(pg_catalog\.now\(\) AT TIME ZONE 'UTC'\)/.test(b), 'expiry is not compared in one frame')
      require('cap01-status', /IF v_inv_status <> 'pending' THEN/.test(b), 'a non-pending invitation is not refused')
      require('cap01-single-membership', /FROM public\.organization_members m[\s\S]{0,120}m\.status = 'active'/.test(b), 'the single-membership guard is gone')
      require('cap01-lock-timeout', /SET LOCAL lock_timeout/.test(b), 'no lock_timeout')

      // ORDER. Each of these is a distinct mutation in the catalogue.
      const firstRead = at('FROM public.invitations i')
      const lock = at('FOR UPDATE')
      const replay = at("v_inv_status = 'accepted' AND v_inv_accepted_by = v_subject")
      const expiry = at('v_inv_expires_at <=')
      const firstWrite = at(/\b(INSERT INTO|UPDATE)\s+public\./)
      const emailRead = at('FROM public.users u')

      // Not `lock > firstRead` — that is definitionally true whenever the lock
      // exists at all, because a FOR UPDATE always follows its own FROM clause.
      // The real question is whether the FIRST read and the lock are the SAME
      // STATEMENT, which is what defect D8 was: a locking first read is
      // filtered by the UPDATE policy's USING (status='pending') and returns
      // NOT FOUND for an already-accepted row, making the replay branch
      // unreachable. Statements end at a semicolon, so that is what to look for.
      require(
        'cap01-order-unlocked-read',
        firstRead > -1 && lock > -1 && b.slice(firstRead, lock).includes(';'),
        'the first read of invitations is the locking read',
      )
      require('cap01-order-replay', replay > -1 && replay < lock, 'the idempotent-replay branch is unreachable behind the lock')
      require('cap01-order-lock-present', lock > -1, 'the pending path never takes FOR UPDATE')
      require('cap01-order-no-write-on-refusal', expiry > -1 && firstWrite > expiry, 'a write precedes the expiry refusal')
      require('cap01-order-constant-time-email', emailRead > -1 && emailRead < firstRead, 'the e-mail lookup is not unconditional')
      require(
        'cap01-concurrent-replay',
        b.lastIndexOf('FROM public.invitations i') > lock,
        'losing the race has no unlocked recovery read, so a concurrent retry is refused',
      )
      require('cap01-membership-unique', /RETURNING id INTO v_member_id/.test(b), 'the membership insert does not return its id')
    }
  }

  // -- Gate 8: CAP-02, publication is opt-in and minimal ---------------------
  {
    const body = codeOnly(src(FORWARD.CAP02))
    const table = /CREATE TABLE IF NOT EXISTS public\.report_public_disclosures \(([\s\S]*?)\n\);/.exec(body)
    if (!table) {
      add('cap02-table', 'report_public_disclosures is not created')
    } else {
      // DERIVED from the table, then compared to the declared set — not
      // iterated FROM the declared set. That direction is the whole finding:
      // the previous gate walked four hardcoded names, so the two flags round 2
      // added were unobserved. Walking six hardcoded names has exactly the same
      // defect one flag later, and a seventh flag defaulting to true would
      // publish something nobody chose to publish.
      const found = [...table[1].matchAll(/^\s*(show_\w+)\s+boolean/gm)].map((m) => m[1])
      const missing = DISCLOSURE_FLAGS.filter((f) => !found.includes(f))
      const undeclared = found.filter((f) => !DISCLOSURE_FLAGS.includes(f))
      for (const f of missing) add('cap02-flag-count', `${f} is no longer declared on the table`)
      for (const f of undeclared)
        add('cap02-flag-count', `${f} is a publication flag the contract does not know about`)
      for (const flag of found) {
        if (!new RegExp(`${flag}\\s+boolean\\s+NOT NULL DEFAULT false`).test(body))
          add('cap02-flag-default', `${flag} is not NOT NULL DEFAULT false`)
      }
    }
    const verify = parseFunctions(body).find((f) => f.name === 'verify_report')
    if (!verify) add('cap02-function', 'verify_report is absent')
    else {
      if (!/\nSTABLE\n/.test(verify.header)) add('cap02-stable', 'verify_report is not STABLE, so the read path could write')
      if (/\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\./.test(verify.body))
        add('cap02-readonly', 'verify_report writes')
      if (!/r\.status = 'locked'/.test(verify.body) && !/status = 'locked'/.test(verify.body))
        add('cap02-locked', 'verify_report does not require a locked report')
      if (!/d\.revoked_at IS NULL/.test(verify.body)) add('cap02-revoked', 'verify_report ignores revocation')
      if (/\bo\.slug\b|stripe_|stella_monthly_quota/.test(verify.body))
        add('cap02-minimal', 'verify_report reads a column outside the disclosure surface')
      // Pinning the column DEFAULTS is not the same as pinning that anything
      // reads them. Checking that `CASE WHEN d.<flag>` merely APPEARS is not
      // enough either: show_totals gates three columns, so removing one leaves
      // two occurrences and a presence check green while the figure is
      // published for every disclosure.
      //
      // So the gate is per COLUMN: every published expression must be preceded
      // by the CASE that gates it, with nothing in between.
      for (const [flag, column] of PUBLISHED_COLUMNS) {
        if (!new RegExp(`CASE WHEN d\\.${flag}\\s+THEN ${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(verify.body))
          add('cap02-flag-honoured', `verify_report publishes ${column} without gating it on ${flag}`)
      }
    }
    for (const table of ['evidence_items', 'sroi_report_sections', 'sroi_calculation_line_items', 'methodology_review_matrix', 'projects'])
      if (new RegExp(`GRANT[^;]*ON\\s+public\\.${table}\\b`, 'i').test(body))
        add('cap02-private-data', `the read capability is granted something on ${table}`)
    const hits = /CREATE TABLE IF NOT EXISTS public\.capability_verification_hits \(([\s\S]*?)\n\);/.exec(body)
    if (!hits) add('cap02-hits', 'the hit counter table is absent')
    else
      for (const forbidden of ['ip', 'user_agent', 'referer', 'referrer', 'fingerprint', 'session'])
        if (hits[1].toLowerCase().includes(forbidden))
          add('cap02-hits-personal-data', `the hit counter has a ${forbidden} column`)
  }

  // -- Gate 9: CAP-03, the webhook identity ---------------------------------
  {
    const body = codeOnly(src(FORWARD.CAP03))
    const fns = parseFunctions(body)
    const apply = fns.find((f) => f.name === 'stripe_apply_subscription')
    const fail = fns.find((f) => f.name === 'stripe_fail_event')
    const begin = fns.find((f) => f.name === 'stripe_begin_event')

    if (/client_reference_id/i.test(body))
      add('cap03-client-reference', 'client_reference_id is authority again; it is buyer-supplied (DP-CAP-15)')
    if (!/event_id\s+text\s+PRIMARY KEY/.test(body))
      add('cap03-event-pk', 'event_id is not the PRIMARY KEY, so idempotency is check-then-act')
    if (!apply) add('cap03-function', 'stripe_apply_subscription is absent')
    else {
      if (!/p_match_kind NOT IN \('customer','subscription'\)/.test(apply.body))
        add('cap03-match-kind', 'the match_kind allowlist is not exactly (customer, subscription)')
      // Narrow deliberately: `entity_type = 'organization'` on the audit insert
      // is legitimate and contains the same literal. What must never return is
      // the branch that RESOLVES an organisation from a caller-chosen value.
      if (/p_match_kind\s*(=|IN\s*\([^)]*)\s*'?organization/.test(apply.body))
        add('cap03-match-kind', "the removed 'organization' match kind is back")
      // Widened when RR-CAP-14 added the address correlation: the two
      // conjuncts are no longer adjacent. The property is unchanged — the
      // event named by p_event_id must be one this capability claimed — and
      // cap03-claim-correlated now asserts the stricter half separately.
      if (!/e\.event_id = p_event_id[\s\S]{0,80}e\.status = 'processing'/.test(apply.body))
        add('cap03-claimed-event', 'a change can be applied for an event this capability never claimed')
      if (/SET status\s*=\s*'failed'/.test(apply.body))
        add('cap03-failure-transaction', 'the failure is marked inside the transaction the RAISE rolls back')
      if (!/pg_catalog\.array_agg\(o\.id\)/.test(apply.body))
        add('cap03-single-org', 'the organisation is not resolved to exactly one row')
    }
    if (!begin) add('cap03-function', 'stripe_begin_event is absent')
    else if (!/ON CONFLICT \(event_id\) DO UPDATE/.test(begin.body))
      add('cap03-claim-atomic', 'the event claim is not an atomic upsert')
    if (!fail) add('cap03-function', 'stripe_fail_event is absent')
    else {
      if (!/status\s*=\s*CASE WHEN p_error_code/.test(fail.body))
        add('cap03-failure-transaction', 'stripe_fail_event no longer records the failure state')
      if (!/'failed'/.test(fail.body)) add('cap03-failure-transaction', "stripe_fail_event never writes 'failed'")
    }
    const columns = /CREATE TABLE IF NOT EXISTS public\.stripe_webhook_events \(([\s\S]*?)\n\);/.exec(body)
    if (!columns) add('cap03-events-table', 'stripe_webhook_events is absent')
    else {
      const names = columns[1]
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !/^(CONSTRAINT|CHECK|PRIMARY KEY|UNIQUE|FOREIGN KEY)\b/i.test(l))
        .map((l) => l.split(/\s+/)[0])
      for (const forbidden of ['payload', 'body', 'raw', 'signature', 'request'])
        if (names.includes(forbidden)) add('cap03-no-payload', `stripe_webhook_events has a ${forbidden} column`)
    }
    // The Stripe identity reaches nothing outside CAP-03's three tables.
    for (const table of ['projects', 'evidence_items', 'sroi_reports', 'sroi_calculation_runs', 'sroi_calculation_line_items', 'invitations'])
      if (new RegExp(`GRANT[^;]*ON\\s+public\\.${table}\\b`, 'i').test(body))
        add('cap03-blast-radius', `CAP-03 grants something on ${table}`)
    if (/GRANT[^;]*ON\s+public\.[^;]*TO\s+uellix_stripe\b/i.test(body))
      add('cap03-login-identity', 'the LOGIN identity receives a table privilege')
    if (/GRANT\s+\w+\s+TO\s+uellix_stripe\b/i.test(body))
      add('cap03-login-identity', 'the LOGIN identity is made a member of a role')
  }

  // -- Gate 10: CAP-04, the writer cannot read ------------------------------
  {
    const body = codeOnly(src(FORWARD.CAP04))
    const conferred = parseGrants(body)
      .filter((g) => g.object === 'public.marketing_leads' && g.grantees.includes('uellix_cap_lead'))
      .flatMap((g) => g.privileges.map((p) => p.privilege))
    if (conferred.length !== 1 || conferred[0] !== 'INSERT')
      add('cap04-insert-only', `uellix_cap_lead receives [${conferred.join(', ')}]; INSERT and only INSERT is the capability`)
    for (const forbidden of ['SELECT', 'UPDATE', 'DELETE', 'ALL'])
      if (conferred.includes(forbidden))
        add('cap04-no-read', `uellix_cap_lead receives ${forbidden} on marketing_leads`)

    const fn = parseFunctions(body).find((f) => f.name === 'submit_lead')
    if (!fn) add('cap04-function', 'submit_lead is absent')
    else {
      if (!/RETURNS void/.test(fn.header)) add('cap04-returns-void', 'submit_lead does not return void')
      if (/RETURNING/i.test(fn.body)) add('cap04-no-returning', 'submit_lead uses RETURNING, which needs SELECT')
      if (!/ON CONFLICT DO NOTHING/.test(fn.body))
        add('cap04-on-conflict', 'the insert is not an untargeted ON CONFLICT DO NOTHING')
      if (/ON CONFLICT\s*(\(|ON CONSTRAINT)/.test(fn.body))
        add('cap04-on-conflict', 'a targeted conflict clause requires SELECT on the arbiter columns')
      if (!/SET LOCAL lock_timeout/.test(fn.body)) add('cap04-lock-timeout', 'no lock_timeout on an anonymous write path')
      const allow = /p_source NOT IN \(([^)]*)\)/.exec(fn.body)
      if (!allow) add('cap04-source-allowlist', 'there is no source allowlist')
      else {
        const listed = allow[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
        if (listed.join('|') !== LEAD_SOURCES.join('|'))
          add('cap04-source-allowlist', `the source allowlist is [${listed.join(', ')}]`)
      }
      if (/status/i.test(fn.signature)) add('cap04-no-status-param', 'lead_status is a parameter')
      for (const forbidden of ['campaign', 'utm', 'referer', 'referrer', 'ip'])
        if (fn.signature.toLowerCase().includes(forbidden))
          add('cap04-server-derived', `the signature accepts ${forbidden}; campaign attribution is not the submitter's to assert`)
      if (!/lead_status/.test(fn.body) || !/'new'/.test(fn.body))
        add('cap04-status-constant', "lead_status is not pinned to 'new' in the body")
    }
    if (!/REVOKE SELECT, INSERT, UPDATE, DELETE ON public\.marketing_leads FROM uellix_writer/.test(body))
      add('cap04-net-reduction', 'the runtime keeps its privileges, so the package is not a net reduction')
    for (const dead of ['anon_insert_marketing_leads', 'authenticated_insert_marketing_leads'])
      if (!new RegExp(`DROP POLICY IF EXISTS ${dead}`).test(body))
        add('cap04-retire-dead-policies', `${dead} is not retired`)
    if (/DROP POLICY IF EXISTS super_admins_read_marketing_leads/.test(body))
      add('cap04-retire-dead-policies', 'the super-admin read is dropped, which is outside this capability')
  }

  // -- Gate 11: CAP-05, bootstrap chooses nothing ---------------------------
  {
    const body = codeOnly(src(FORWARD.CAP05))
    const fn = parseFunctions(body).find((f) => f.name === 'bootstrap_organization')
    if (!fn) add('cap05-function', 'bootstrap_organization is absent')
    else {
      const sig = fn.signature.toLowerCase()
      for (const forbidden of ['actor', 'user_id', 'owner', 'role', 'plan', 'quota', 'flag', 'admin', 'subject'])
        if (sig.includes(forbidden))
          add('cap05-no-authority-param', `the signature accepts ${forbidden}; authority would then be asserted, not proven`)
      if (!/v_subject\s*:=\s*auth\.uid\(\)/.test(fn.body))
        add('cap05-subject', 'the subject does not come from auth.uid()')
      if (/p_actor/.test(fn.body)) add('cap05-no-actor', 'p_actor is trusted somewhere in the body')

      const claim = fn.body.indexOf('INSERT INTO public.capability_bootstrap_attempts')
      const orgInsert = fn.body.indexOf('INSERT INTO public.organizations')
      const memberInsert = fn.body.indexOf('INSERT INTO public.organization_members')
      const audit = fn.body.indexOf('INSERT INTO public.audit_logs')
      const firstLock = fn.body.indexOf('FOR UPDATE')

      if (claim === -1) add('cap05-claim', 'the idempotency key is never claimed')
      if (orgInsert === -1) add('cap05-organization', 'no organisation is created')
      if (claim > -1 && orgInsert > -1 && claim > orgInsert)
        add('cap05-claim-order', 'the key is claimed AFTER the organisation is created, so the loser keeps an organisation')
      if (firstLock > -1 && claim > -1 && firstLock < claim)
        add('cap05-claim-first', 'FOR UPDATE runs before the claiming INSERT, and it locks nothing when the row does not exist')
      if (!/ON CONFLICT ON CONSTRAINT capability_bootstrap_attempts_pkey DO NOTHING/.test(fn.body))
        add('cap05-claim-atomic', 'the claim is not an atomic INSERT ... DO NOTHING')
      if (!/ON CONFLICT ON CONSTRAINT organizations_slug_unique DO NOTHING/.test(fn.body))
        add('cap05-slug-atomic', 'slug uniqueness is check-then-act')
      if (/ON CONFLICT \(slug\)/.test(fn.body))
        add('cap05-slug-atomic', 'ON CONFLICT (slug) puts an OUT variable in an expression context')
      if (!(claim < orgInsert && orgInsert < memberInsert && memberInsert < audit))
        add('cap05-atomicity', 'organisation, membership and audit are not written in one ordered transaction')
      if (/\bCOMMIT\b|\bROLLBACK\b/i.test(fn.body))
        add('cap05-atomicity', 'the body commits or rolls back, so the four writes are not one unit')
      // Anchored to the membership INSERT, not to the file. `'organization_admin'`
      // also appears in the audit_logs JSONB payload two statements later, so a
      // bare substring test is satisfied while the membership itself is
      // inserted with any role the ACL admits.
      if (!/INSERT INTO public\.organization_members[\s\S]{0,400}'organization_admin'/.test(fn.body))
        add('cap05-founding-role', 'the founding membership does not pin organization_admin')
      // The reserved-slug denylist is a documented property (CAP-05 §3.2) that
      // no gate read: removing the `= ANY(c_reserved)` arm leaves a function
      // that will happily create an organisation whose slug is `api`.
      if (!/v_slug\s*=\s*ANY\(c_reserved\)/.test(fn.body))
        add('cap05-reserved-slugs', 'the reserved-slug denylist is not consulted')
      for (const reserved of ['app', 'api', 'admin', 'verify', 'invite', 'login'])
        if (!new RegExp(`'${reserved}'`).test(fn.body))
          add('cap05-reserved-slugs', `the denylist no longer contains '${reserved}'`)
      if (/stella_monthly_quota|stella_plan_label|stripe_/.test(fn.body))
        add('cap05-no-plan', 'the bootstrap names a billing column')
      if (!/FROM public\.signup_allowlist s/.test(fn.body)) add('cap05-allowlist', 'the allowlist gate is gone')
      if (!/v_slug !~ '\^\[a-z0-9\]\[a-z0-9-\]\{1,48\}\[a-z0-9\]\$'/.test(fn.body))
        add('cap05-slug-shape', 'the slug pattern is not anchored and bounded')
      if (!/FROM public\.organization_members m[\s\S]{0,120}m\.status = 'active'/.test(fn.body))
        add('cap05-single-membership', 'the single active membership guard is gone')
    }
    const insertGrant = parseGrants(body).find(
      (g) => g.object === 'public.organizations' && g.privileges.some((p) => p.privilege === 'INSERT'),
    )
    if (!insertGrant) add('cap05-grant', 'no INSERT grant on organizations')
    else {
      const cols = insertGrant.privileges.find((p) => p.privilege === 'INSERT')!.columns ?? []
      for (const col of cols)
        if (/stella_|stripe_|quota|owner_user_id/.test(col))
          add('cap05-no-plan', `the INSERT grant names ${col}`)
    }
  }

  // -- Gate 12: rollback symmetry, per named object -------------------------
  for (const key of Object.keys(FORWARD) as Array<keyof typeof FORWARD>) {
    const fwd = codeOnly(src(FORWARD[key]))
    const rb = codeOnly(src(ROLLBACK[key]))
    const retained = ROLLBACK_RETAINED_POLICIES[ROLLBACK[key]] ?? []
    // The DROPs the rollback actually performs, read structurally. A regex over
    // the text answers a different question — "does this string appear?" — and
    // a nested block comment or a quoted policy name makes the two answers
    // disagree in the dangerous direction.
    const rbDropped = new Set(parseDroppedPolicies(src(ROLLBACK[key])).map((d) => d.name))
    for (const p of parsePolicies(fwd)) {
      const dropped = rbDropped.has(p.name)
      if (retained.includes(p.name)) {
        // Retention has to be a decision the script states, not a DROP someone
        // forgot: the rollback must leave the policy alone AND assert it lived.
        if (dropped) add('rollback-retention', `${ROLLBACK[key]} drops ${p.name}, which is retained by design`)
        if (!new RegExp(`policyname = '${p.name}'`).test(src(ROLLBACK[key])))
          add('rollback-retention', `${ROLLBACK[key]} does not assert that ${p.name} survived`)
        continue
      }
      if (!dropped) add('rollback-policy', `${ROLLBACK[key]} does not drop ${p.name}`)
    }
    // The retained/dropped table split, per rollback, against the authoritative
    // set. A rollback that DROPs a retained table, or keeps a dropped one,
    // leaves a state matching neither before nor after.
    for (const t of RETAINED_TABLES)
      if (new RegExp(`DROP TABLE IF EXISTS public\\.${t}\\b`).test(rb))
        add('rollback-retention', `${ROLLBACK[key]} drops ${t}, which the campaign retains`)
    for (const t of DROPPED_TABLES)
      if (new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t}\\b`).test(fwd) &&
          !new RegExp(`DROP TABLE IF EXISTS public\\.${t}\\b`).test(rb))
        add('rollback-retention', `${ROLLBACK[key]} creates ${t} and never drops it`)
    for (const fn of CAPABILITY_FUNCTIONS[FORWARD[key]]) {
      if (!new RegExp(`DROP FUNCTION IF EXISTS uellix_capability\\.${fn}\\b`).test(rb))
        add('rollback-function', `${ROLLBACK[key]} does not drop ${fn}`)
    }
    if (!new RegExp(`DROP ROLE ${CAPABILITY_ROLES[FORWARD[key]]}`).test(rb))
      add('rollback-role', `${ROLLBACK[key]} does not drop ${CAPABILITY_ROLES[FORWARD[key]]}`)
    if (/\bCASCADE\b/i.test(rb)) add('rollback-cascade', `${ROLLBACK[key]} uses CASCADE`)

    // A rollback confers and creates almost nothing, and what it does is
    // declared. Gates 1-3 read the forward files only, so until this existed a
    // `CREATE POLICY … USING (true)` or a `GRANT … TO PUBLIC` planted in a
    // rollback was checked by nothing — in a file that runs as superuser during
    // an incident.
    const rbFile = ROLLBACK[key]
    const allowedGrants = [...(ROLLBACK_GRANT_CONTRACT[rbFile] ?? [])].sort()
    for (const sig of grantSignatures(src(rbFile)))
      if (!allowedGrants.includes(sig)) add('rollback-grant', `${rbFile}: confers ${sig}`)
    const allowedPolicies = ROLLBACK_POLICY_CONTRACT[rbFile] ?? []
    for (const p of parsePolicies(src(rbFile))) {
      if (!allowedPolicies.includes(p.name)) {
        add('rollback-policy-created', `${rbFile}: creates undeclared policy ${p.name}`)
        continue
      }
      if (p.roles.length === 0 || p.roles.includes('public'))
        add('rollback-policy-created', `${rbFile}: restored policy ${p.name} reaches PUBLIC`)
    }
    for (const o of parseOwnerships(src(rbFile)))
      add('rollback-ownership', `${rbFile}: re-owns ${o.objectType} ${o.object} to ${o.owner}`)
    for (const t of parseRlsToggles(src(rbFile)))
      if (t.action === 'DISABLE' || t.action === 'NO FORCE')
        add('rollback-rls', `${rbFile}: ${t.action} ROW LEVEL SECURITY on ${t.table}`)
  }

  // -- Gate 13: the mask stays in sync ------------------------------------
  // Every gate above reads masked text. If the masker desynchronises — an
  // unterminated dollar quote, an unbalanced literal — the tail of the file
  // becomes invisible and the gates go quiet rather than red. Cheap invariant,
  // catastrophic failure mode.
  // Over EVERY file, not only the forward ones. A desynchronised mask in a
  // rollback makes its tail invisible, and the rollback files are the ones that
  // run as superuser with nobody watching.
  for (const file of CAPABILITY_SQL_FILES) {
    const raw = verbatim(file)
    if (raw.length === 0) {
      add('source-missing', `${file} is empty or absent`)
      continue
    }
    const stripped = stripComments(raw)
    if (stripped.length !== raw.length)
      add('mask-desync', `${file}: the comment mask changed the file length`)
    const opens = (stripped.match(/\$\$/g) ?? []).length
    if (opens % 2 !== 0) add('mask-desync', `${file}: an odd number of $$ delimiters survives masking`)
  }

  return v
}
