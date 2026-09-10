# Platform admin, MFA/AAL2, support capability and destructive deletion — authority R1

**Authority id** `PLATFORM_ADMIN_MFA_SUPPORT_DELETION_AUTHORITY_v1.0.0`
**Lane** AV · **Tier** A (security/operator) · **Mode** DOCS_ONLY
**Base** `88d95c65b9c9a942195319f09aabaa7b127f7e30` · **Tree** `97006bebd7e496135967d05d59b01e798cdc7394`
**Status** DRAFT_AUTHORITY_PENDING_INDEPENDENT_AUDIT

The machine-readable authority is
[`PLATFORM_ADMIN_MFA_SUPPORT_DELETION_AUTHORITY_v1.0.0.json`](PLATFORM_ADMIN_MFA_SUPPORT_DELETION_AUTHORITY_v1.0.0.json).
It is controlling; this file is guidance alongside it, never a substitute.

The frozen census is
[`PLATFORM_ADMIN_RLS_SUPERADMIN_POLICY_CENSUS_v1.0.0.json`](PLATFORM_ADMIN_RLS_SUPERADMIN_POLICY_CENSUS_v1.0.0.json).
The test contract is
[`PLATFORM_ADMIN_MFA_SUPPORT_DELETION_TEST_MANIFEST_v1.0.0.json`](PLATFORM_ADMIN_MFA_SUPPORT_DELETION_TEST_MANIFEST_v1.0.0.json).

---

## 1. What this authority does and does not do

It **defines** the platform/tenant principal separation, the tenant-authorized
support capability, MFA/AAL2 step-up semantics, destructive-deletion separation
of duties, the commercial-metadata boundary, and the frozen successor
disposition for every RLS policy carrying a superadmin bypass.

It **implements none of them**. No runtime code, no migration, no ordinal, no
ODS allocation, no hosted auth configuration, and no edit to any existing RLS
policy. Any DDL implied here carries `LINEAGE_REDERIVATION_REQUIRED=YES`.

## 2. Provenance — read this before citing anything

Two clauses in this authority are **ratified owner input with no repository
substrate**, and the artifact says so rather than implying otherwise:

- **HPO-D itself.** A standalone `HPO-D` token has **zero** hits across
  `docs/`, `db/`, `lib/`, `app/` and `scripts/` at this tree. The only
  near-matches are `HPO-DEC-1..3`, a different identifier. This artifact is
  HPO-D's first materialization. Its binding clauses are reproduced verbatim in
  `source_authority.binding_clauses_verbatim` and are load-bearing *as ratified
  input*, not as a citation of pre-existing in-tree text.
- **The 60-minute / 4-hour support ceilings.** The directive describes these as
  *already governed*. A grep for `60-minute`, `60 minute`, `4-hour`,
  `four-hour` and `240 minute` across `docs/` returns **zero** hits. They are
  carried here as ratified input. A successor must not cite a repository source
  for them that does not exist.

The same "first materialization" condition previously held for HPO-B and HPO-G.

## 3. The principal model, and the name that causes the damage

`PLATFORM_PRINCIPAL` and `TENANT_PRINCIPAL` are **disjoint kinds**, not two
values of one enumeration. A subject may hold both; holding one never implies
the other, and there is **no hierarchy** between them.

The measured reality is the opposite of that on both counts:

| | measured today |
|---|---|
| Platform principal | `users.is_super_admin` — a **persistent boolean column** on the tenant-shared users row |
| Predicate | `current_user_is_super_admin()` — `SECURITY DEFINER`, reads that column, `db/migrations/0031_rls_core.sql` |
| App gate | `requireAdminAccess()` in `lib/auth/session.ts` — reduces to `user.isSuperAdmin`, nothing else |
| Tenant principal | `organization_members(user_id, organization_id, role, status)` |

The predicate carries **no assurance input, no time bound, no purpose, no
tenant authorization and no expiry**. It is standing access by construction.

**The conflation is a name collision.** `'super_admin'` is simultaneously a
value of `organization_members.role` *and* the colloquial name of the platform
principal. `approveProjectDeletion()` gates on `ctx.membership.role !==
'super_admin'` — a **tenant** role. `requireAdminAccess()` gates on
`user.isSuperAdmin` — the **platform** bit. Two unrelated authorities, one
name. Any review that reasons about "super admin" by name rather than by
principal kind will conflate them.

This is why clause **PM-02** forbids rank comparisons as well as literal role
strings: the documented bypass travels with the *relation* and with `hasRole()`,
so a successor can reintroduce it without the string `super_admin` ever
appearing in the diff.

## 4. The policy census — and why "~100" was the wrong target

F-AU-3 reported *approximately 100 policy-level superadmin disjuncts with no
owning node*. **This authority owns that problem.** It also corrects the figure.

The census replays `CREATE POLICY` / `DROP POLICY` in ordinal order with a
comment-, string- and dollar-quote-aware SQL parser to derive the **effective**
policy set, then applies the same parse to the other declared lineages.

**Migration lineage** (`db/migrations/*.sql`, 70 files):

| measure | value |
|---|---|
| effective policies | 132 |
| **carrying a superadmin disjunct** | **127** |
| not carrying one | 5 |
| superadmin call sites | 161 (93 policies ×1, 34 ×2) |
| `RESTRICTIVE` policies | **0** |
| `TO PUBLIC` (no role restriction) | 129 of 132 |

The five exceptions are not a designed exemption set: the 0067 tenancy-refusal
insert (the only policy written under the post-0067 doctrine), two global
taxonomy reads, and two self-scoped `users` writes.

**But the migration lineage is not the closed world.** Three lineages disagree:

| lineage | superadmin disjuncts |
|---|---|
| `db/migrations` (effective) | 127 |
| `db/baseline/stella_g2_schema.sql` only | 4 |
| `db/prepared/**` only | 9 |
| **closed world (union)** | **140** |

`db/policies/**` adds **zero** outside the union — mechanically confirming its
content is sourced into migrations 0031/0032.

Two consequences worth stating plainly:

- **`marketing_leads` is created by `0035` with no RLS and no policies at all.**
  Its only policies, including a superadmin read, exist solely in the hosted
  baseline. A successor treating `db/migrations` as the closed world never sees
  it.
- **All 18 `RESTRICTIVE` policies in the repository live in unapplied
  `db/prepared` packets.** Zero are applied. Every superadmin disjunct is
  therefore purely *additive* and cannot be narrowed by any applied restrictive
  layer — one must be introduced, not assumed.

**Reconciling F-AU-3:** the hosted baseline carries **101** superadmin
policies. That is almost certainly what "~100" measured — the *deployed*
surface, which is the natural thing to look at. It understates the forward
lineage (127) and the full declared corpus (140). The discrepancy is a
lineage-scope difference, not a counting error. But a successor that adopts
"~100" as its target **under-closes by at least 39 policies** and leaves the
prepared and baseline-only surfaces entirely untouched.

### Classification and frozen disposition

| category | policies | tables | frozen successor disposition |
|---|---:|---:|---|
| `TENANT_CONTENT` | **106** | **39** | `REPLACE_WITH_SUPPORT_CAPABILITY` |
| `GLOBAL_REFERENCE` | 12 | 4 | `SPLIT_THEN_REPLACE` |
| `TENANT_METADATA` | 12 | 3 | `REPLACE_WITH_ENUMERATED_OPERATOR_SCOPE` |
| `OPERATOR_METADATA` | 9 | 5 | `RETAIN_UNDER_OPERATOR_PRINCIPAL` |
| `OTHER` | 1 | 1 | `ADJUDICATE_INDIVIDUALLY` |

**106 of 140 disjuncts sit on tenant content, across 39 tables.** That is the
"no standing tenant-content access" clause, quantified.

Classification is **fail-closed**: a table ambiguous between content and
metadata is classified `TENANT_CONTENT`. `projects` and `portfolios` are
classified as content on this rule, because they carry tenant-authored
descriptive fields (`target_population_description`, `thematic_area`,
`governance_regime`), not merely structural ones.

The `GLOBAL_REFERENCE` four — `fx_rates`, `proxy_sources`, `financial_proxies`,
`financial_proxy_versions` — all carry a **nullable** `organization_id`, where
NULL means shared and non-NULL means that tenant's content. They must be
**split before replacement**. The predicate
`(organization_id IS NULL OR organization_id = <current org>)` is a **permanent
cross-tenant channel** whenever the current-org value is itself null, and is
forbidden.

### What closure requires

- Close the **union of 140**, not 127 and not 100 (`RS-01`).
- **Removal must be observable** by re-deriving the census (`RS-03`).
- **No silent substitution** — a renamed helper with identical truth conditions
  is the same defect (`RS-04`). Removal *without* a successor predicate is
  strictly safer and must not be treated as a regression.
- **Dispose of the mechanism, not just the callers** — state the disposition of
  `current_user_is_super_admin()` *and* `users.is_super_admin` (`RS-06`).
- **The bypass is not in `/admin`.** All `app/admin/*/actions.ts` server
  actions *do* independently call `requireAdminAccess()` — the console is
  correctly gated. Because the disjunct sits in ordinary tenant policies, the
  leak is in the **normal application**: every ordinary query run by a
  platform-flagged user silently returns cross-tenant rows (`RS-07`).

## 5. Support capability

A capability is the **only** path from a platform principal to tenant content.
No override, no break-glass.

- **Scope** is exactly one `organization_id`. Wildcard, list or "all tenants" is
  invalid **at issue**, not merely at use. Absence of scope is **zero** access,
  never global — stated explicitly because the prevailing in-tree failure mode
  is precisely the opposite.
- **Authorization** is an affirmative, recorded act by a tenant principal of the
  target org. The platform cannot issue to itself. It is never inferred from a
  ticket, an email, a contract, onboarding, or silence.
- **Fields**: `purpose` (binding, not descriptive — use outside the recorded
  purpose is a violation while the capability is otherwise live), `issued_by`,
  `issued_to` (a single natural person; not a group, role or service account;
  non-transferable), `issued_at`, `expires_at` (non-null, absolute wall-clock).
- **Ceilings**: 60 minutes normal, 240 minutes absolute for escalation —
  measured from *its own* `issued_at`, never additive to a prior capability.
  Escalation is itself a fresh authorizing act plus a fresh AAL2 challenge.
- **No auto-renew** by any mechanism — not activity, session refresh, token
  refresh, or operator action. Back-to-back issuance is allowed but must appear
  as *separate* capabilities in the audit record.
- **Revocation** is unilateral by the tenant, effective immediately, durable,
  and irreversible — restoring access needs a *new* capability. A revoked
  capability stays distinguishable from one that never existed.
- **Writes are denied by default**; deletion under a capability is prohibited
  without exception. Access is audited at **use**, not at issue.

**Measured substrate: zero.** No capability table, no issuing act, no expiry,
no revocation, no purpose anywhere in `db/`, `lib/` or `app/`. Support access
today is indistinguishable from standing platform access.

## 6. MFA / AAL2 — semantics only, no vendor

AAL2 means two distinct factors of different kinds, **server-derived**. *Fresh*
AAL2 means a challenge satisfied inside a bounded window ending at the guarded
operation — holding a session that *once* reached AAL2 is not fresh. Step-up
means **refuse, challenge, then retry**; never silently proceed, never downgrade
to a warning. **AAL absent and AAL stale are distinct conditions**; both refuse,
and both must be distinguishable in handling and audit. Undeterminable
assurance refuses.

**Measured substrate: effectively zero.** A repository-wide search for `aal2`,
`assuranceLevel`, `mfa`, `totp`, `enrollFactor` across `lib/`, `app/` and `db/`
hits only two files: the baseline dump, where `auth.aal_level` and
`auth.mfa_amr_claims` are the vendor's own unused schema, and one passing
textual mention in a tenancy document. This corroborates F13's finding that
session claims carry only `{sub, role}` — **no assurance level reaches the
database**, so no policy can test freshness today.

## 7. Destructive deletion — separation of duties

Two distinct **human** actors, requester ≠ approver by natural-person identity;
independently fresh AAL2 for each; reason on both acts; typed confirmation by
the approver; durable audit surviving the deletion. Tenant `super_admin` **does
not** substitute for either actor — the requirement is *structural* (two
people), not a permission a privileged role can satisfy alone.

Measured at `lib/projects/service.ts` `approveProjectDeletion()` (line 289):

| clause | status today |
|---|---|
| SD-04 reason | **satisfied** — required and recorded |
| SD-05 typed confirmation | **satisfied** — exact literal `'ELIMINAR'`, strictly compared |
| SD-06 durable audit | **satisfied** — `PROJECT_DELETION_APPROVED` with actor, reason, time |
| SD-01 requester ≠ approver | **VIOLATED** — no comparison exists |
| SD-03 fresh AAL2 | **VIOLATED** — no assurance check on either path |
| SD-07 no tenant-role substitution | **VIOLATED** — the *only* gate is the tenant role |
| SD-02 both actors human | **VIOLATED** — no actor-kind check |

The sharpest finding in this authority:

> **SD-01 is fully expressible today with zero DDL.**
> `projects.deletion_requested_by` already exists, is already written by
> `requestProjectDeletion()` at `lib/projects/service.ts:265`, and is already
> guaranteed non-null whenever a request is active by the existing CHECK
> constraint `deletion_request_consistency_check` (`db/schema.ts:245`).
> The approval path simply **never reads it**.

One person holding tenant `super_admin` can request *and* approve the same
deletion, today. The fix is a comparison, not a schema change — the highest-value,
lowest-cost closure here, and the one mutation control (`AV-M-04`) that can be
proven non-vacuous immediately, because it must be **RED at this very base**.

## 8. Commercial / operational metadata boundary

Enumerated scope is a **closed world** — silence is denial. `TENANT_CONTENT` is
never in scope. Operator ledgers (`audit_logs`, `domain_object_versions`,
`marketing_leads`, `signup_allowlist`, `operation_tickets`) are read-only plus
append to `audit_logs`; **no UPDATE or DELETE of audit records by any principal,
platform included** — the audit record is not editable by the party it audits.
Tenant metadata (`organizations`, `organization_members`, `invitations`) is
readable for commercial purposes, but **never writable to manufacture a tenant
principal for the operator**. Metadata scope lowers the authorization bar; it
does **not** lower the audit bar.

Two hazards are recorded rather than waved through:

- `audit_logs.after_json` and `domain_object_versions` carry **verbatim prior
  object state** across 40+ audited verbs. Reading them may be reading tenant
  content by another name. **Unadjudicated — fails closed** (`AG-02`).
- `organizations` is both the tenant record and the tenant **enumerator**.
  Platform read reveals the full customer list. Accepted for commercial
  operation, but it must never be reused to justify reaching tenant contents.

## 9. LANE AU dependency — frozen

AU S4/S5 **may** implement its selected-org weld. It **may not** claim full
MO-07 or platform-admin isolation until this authority's successor closes the
policy-level standing bypass.

The two defects are independent: the weld constrains which organization a
*tenant* principal acts in; it does not remove a *platform* principal's
disjunct. **A weld can be entirely correct and all 140 disjuncts still fire.**
Worse, a weld applied to `organizations` collapses the tenant enumerator and can
*present* as isolation while the bypass remains — AU passing its own gates is
not evidence that platform-admin isolation holds.

AU must not be required to solve this as a side effect, and must not be blamed
for its persistence. **Ownership sits here.** Any MO-07 closure claim must cite
a re-derived census showing the count fallen; a claim citing only AU's gates
must be refused.

## 10. Open gaps — all fail closed

`AG-01` the enumeration of destructive operations beyond project deletion ·
`AG-02` whether operator reads of `after_json` / `domain_object_versions`
constitute content access · `AG-03` applied state of the nine prepared-only
policies is UNKNOWN from the repository alone · `AG-04` no live `pg_policies`
snapshot was taken; the census measures declared SQL · `AG-05` which tenant role
may perform the authorizing act — must never default to one a platform principal
can obtain · `AG-06` whether a capability may ever permit writes (default deny).
