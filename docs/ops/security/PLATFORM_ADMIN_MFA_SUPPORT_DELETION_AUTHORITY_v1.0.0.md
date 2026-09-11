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

`db/policies/**` adds **zero new superadmin disjuncts** to the union — which is
what preserves the total of 140.

That is the *precise* claim, and it is narrower than it first looks. **R2
correction:** `db/policies` is **not** a pure mirror of the migration lineage.
Of its 105 keys, **100 match an effective migration policy and 5 do not**; two
of its tables — `governed_model_registry` and `proxy_material_fields_registry` —
have **no effective migration policies at all**. Exactly one orphan carries a
superadmin disjunct (`marketing_leads.super_admins_read_marketing_leads`), and
it is **already counted** under `HOSTED_BASELINE_ONLY` — which is precisely why
the automated check reported zero outside the union. **The 140 total is
unchanged**, but a successor must not treat `db/policies` as redundant with
`db/migrations`. It also corroborates the `marketing_leads` finding from a
*second* non-migration lineage.

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

### The authorizer — fixed by RAT-OP-01 (R3)

`RAT_OP_01_STATUS = RATIFIED_BY_PRODUCT_OWNER`. Materialized at **PR146 /
`1cddd310`** in `docs/ops/commercial/COMMERCIAL_V1_MICRO_RATIFICATIONS_v1.0.0.json`,
read here **read-only**. The owner decision **binds regardless of PR146's merge
state**; merge state governs only when *this* PR may be integrated (§11).

The authorizer must be a **natural person**, holding an **ACTIVE membership in
the affected organization**, with role **exactly `organization_admin`**
(`SC-05A`–`SC-05C`).

**Exact equality — not a threshold** (`SC-05D`). Excluded explicitly:
`hasRole('>=')`, numeric dominance, `'+'` notation, set membership, and
implicit admission of any "higher" role. **Tenant `super_admin` does not
qualify** — not by rank, not by semantics, not as an administrative superset.

That exclusion is load-bearing against a measured property of this codebase:

> `lib/auth/permissions.ts:25` — `hasRole(userRole, requiredRole)` returns
> `ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole]`, and
> `lib/auth/roles.ts` sets `super_admin: 100`, `organization_admin: 80`.

So `hasRole('super_admin', 'organization_admin')` is **`true`**. **Any**
rank-based implementation silently admits precisely the role RAT-OP-01
excludes, while looking like a faithful implementation. `AV-M-10` exists to
catch exactly that, and it is written so the control that must go RED is the
*tenant super_admin* case — because `organization_admin` satisfies both the
equality and the threshold, only `super_admin` distinguishes them.

**A platform principal is never the issuer** (`SC-05E`), and does **not**
become one by holding — or self-assigning — an `organization_admin` membership.
`issued_by` must differ from `issued_to` by natural-person identity.

### The operational precondition — fail closed (`SC-05F`)

**RAT-OP-01 does not make issuance operational.** The rule becomes effective
only *after* the standing platform-admin path that can self-assign tenant
memberships is **proven closed**. Until then, **issuance must fail closed** —
refuse, never default-permit.

This is not a formality, and the precondition is **measurably open today**:

> `db/migrations/0031_rls_core.sql`, policy `members_insert_admin` on
> `organization_members`:
> `WITH CHECK ( current_user_role_in_org(organization_id) IN ('super_admin','organization_admin') OR current_user_is_super_admin() )`

That trailing disjunct lets any principal with `users.is_super_admin = true`
INSERT an arbitrary membership row — **including granting itself
`organization_admin` in any organization**. The policy is `TO PUBLIC`. All four
`organization_members` policies carry the disjunct, so the standing path can
create, alter, delete and enumerate memberships.

**So an `organization_admin` membership is not trustworthy as authorization
while the bypass stands.** Without the closure, `SC-05C` is satisfiable by an
attacker-chosen row and the whole issuer contract is circumventable **by a
single INSERT**.

Closure is effective at the DB layer — `uellix_app` is declared `NOBYPASSRLS`,
so removing the disjuncts does close the runtime path. Two cautions, both
recorded rather than assumed: `postgres` and `service_role` **are** `BYPASSRLS`
and anything running as either never consults RLS at all (**`AG-07`**, open);
and the in-policy comment in `0031` claiming onboarding bypasses RLS via
`DATABASE_URL` is **stale** — `db/client.ts` states the runtime connection now
comes from `UELLIX_RUNTIME_DATABASE_URL` and must declare `uellix_app`.

RAT-OP-01 grants **no** standing tenant-content access (`SC-05G`).
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
| SD-05 typed confirmation | **satisfied** — exact literal `'ELIMINAR'`, strictly compared |
| SD-06 durable audit | **PARTIAL** — actor, action and time satisfied; **assurance evidence VIOLATED** |
| SD-04 reason (approver's own) | **VIOLATED** — no validation, and the reason is synthesized from the requester's |
| SD-01 requester ≠ approver | **VIOLATED** — no comparison exists |
| SD-03 fresh AAL2 | **VIOLATED** — no assurance check on either path |
| SD-07 no tenant-role substitution | **VIOLATED** — the *only* gate is the tenant role |
| SD-02 both actors human | **VIOLATED** — no actor-kind check |

**SD-04 (R2 correction — was previously recorded as satisfied).**
`approveProjectDeletion()` performs **no** server-side check that `deleteReason`
is present or non-empty. The contrast sits in the same file:
`requestProjectDeletion()` *does* validate, with
`if (!reason || reason.trim().length === 0)`; the approval path has no
equivalent, and `logAuditAction()` validates only `entityType`, `entityId` and
`action`.

Worse, the sole caller never asks the approver for a reason at all —
`app/admin/project-deletions/client.tsx:53` **synthesizes** it:

> `` `Aprobado por SuperAdmin. Motivo original: ${selectedRequest.deletionReason}` ``

SD-04 already anticipated exactly this: *"the approval's reason MUST NOT be
defaulted from the request's."* Two consequences follow.

- **A server-side non-empty check alone would be vacuous.** The synthesized
  value is a non-empty template literal, so it always passes. Closure needs
  **both** the validation **and** an approver-supplied input; either alone
  leaves the clause unmet.
- **The audit trail misattributes.** That synthesized string is written to both
  `audit_logs.reason` and `afterJson.deleteReason`, so the durable record
  credits the *requester's* justification to the *approval*.

Disposition: **`CODE_FIX_ONLY`, zero DDL** — `projects.delete_reason` and
`audit_logs.reason` already exist and are already written.

**SD-06 (R2 qualification).** The durable record carries **no assurance
evidence**: `audit_logs` has no AAL/assurance/factor/amr column — its columns
are `action`, `actor_user_id`, `after_json`, `before_json`, `created_at`,
`entity_id`, `entity_type`, `id`, `ip_address`, `organization_id`,
`project_id`, `reason`, `user_agent` — and `logAuditAction()` writes no such
field. Actor, action and time remain satisfied; the assurance portion is
`REQUIRES_NEW_SUBSTRATE`, blocked on the MFA gap and FD-03. **No MFA substrate
is assumed to exist.**

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
snapshot was taken; the census measures declared SQL · `AG-06` whether a
capability may ever permit writes (default deny) · **`AG-07` (R3, new)**
`postgres` and `service_role` are `BYPASSRLS`, so any path running as either is
outside the 140-policy census entirely — whether a live path does so was not
measured, and the `SC-05F` closure proof is incomplete until it is, because
closing RLS cannot close a path that never consults RLS.

### `AG-05` — resolved as a product decision, open as implementation

`AG-05` is **no longer `OWNER_DECISION_REQUIRED`** and must not be re-escalated
to the owner. The two halves are tracked separately:

| | status |
|---|---|
| `PRODUCT_DECISION_STATUS` | **`RESOLVED_BY_RAT_OP_01`** — the authorizer is fixed: natural person, ACTIVE membership in the affected org, role exactly `organization_admin` |
| `IMPLEMENTATION_STATUS` | **`IMPLEMENTATION_GAP_OPEN`** — no runtime satisfies it |

**This authority does not claim the current runtime satisfies RAT-OP-01.** There
is no support-capability substrate at all, and `SC-05F` is measurably open.

One honest wrinkle worth stating: R1's `AG-05` required that the authorizing
role *"must never default to one a platform principal can obtain."* RAT-OP-01
selects `organization_admin` — which a platform principal **can** currently
obtain, via the standing bypass. The ratification resolves that tension not by
picking a different role but by making the bypass closure a **load-bearing
precondition**. So the R1 constraint is satisfied **conditionally, on `SC-05F`**
— never unconditionally.

## 11. Integration dependency

`CANONICAL_MICRO_RATIFICATION_INTEGRATED = **NO**`, by fresh measurement at R3:
`1cddd310` is not an ancestor of `origin/integration/commercial-v1`,
`origin/feature/sprint-0-foundation` or `origin/main`, and `gh` reports PR #146
`state=OPEN`, `isDraft=true`, `mergedAt=null`.

PR145 **may be authored and audited now**. Its **final integration must wait**
while PR146 is unmerged — otherwise this authority would cite a ratification
artifact absent from the integrated tree. That is a provenance dependency, not a
defect in PR145.
