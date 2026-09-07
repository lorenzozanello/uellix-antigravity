# COMMERCIAL_V1_ALIGNMENT_BASELINE_v1.0.0

```
artifact_id:        COMMERCIAL_V1_ALIGNMENT_BASELINE_v1.0.0
authority_class:    PRODUCT_ALIGNMENT_REFERENCE_NOT_EXECUTABLE_AUTHORITY
hpo_mission_id:      COMMERCIAL-V1-ALIGNMENT-BASELINE-MATERIALIZATION-R1
remediation_mission_id: COMMERCIAL-V1-ALIGNMENT-BASELINE-COORDINATOR-REMEDIATION-R2
amendment_mission_id: COMMERCIAL-V1-CA06-CA08-RATIFICATION-MATERIALIZATION-R1
materialization_date: 2026-09-04
amendment_date:      2026-09-05
companion_artifact:  docs/ops/commercial/COMMERCIAL_V1_PRODUCT_RATIFICATIONS_v1.0.0.json
ratification_count:  30 (MO-01..MO-12=12, SS-01..SS-03=3, CA-01..CA-08=8, EV-01..EV-03=3, RI-01=1, AG-01..AG-03=3) — see companion JSON self_check block for the deterministic count/uniqueness/ID-set verification
AS_OF_HEAD:          4264bd606e1b1da93ab6c8e9167979983994e702 (origin/integration/commercial-v1)
amendment_AS_OF_HEAD: d98cfb72d3e2e513a592be1183e6b9e5f638f2db (origin/integration/commercial-v1, at time of CA-06/07/08 materialization)
main_frozen_sha:     067e8c2f3ac9b5e843de3a35575182907b4365d4 (unchanged, out of scope)
```

## 0. Precedence

- This document is canonical for **product alignment** and **product-owner ratifications** only.
- It does **NOT** override executable FIB/ODS/database/security authority — see
  `docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json`, `docs/ops/fib/**`, `docs/ops/pc01b/**`,
  `docs/ops/im01b/**`. Those remain controlling for any executable decision.
- When product intent recorded here conflicts with current executable authority or the
  live schema, that conflict is an explicit **AUTHORITY_GAP** requiring a governed
  successor artifact before implementation. It is never resolved by silently editing this
  file, the code, or the conflicting authority.
- A product ratification can intentionally contradict current executable authority; that
  contradiction is **not resolved by precedence**. It creates an AUTHORITY_GAP and
  requires a governed executable successor. (Two ratifications are recorded in exactly
  this state today: MO-02 and MO-07 — see section 5 and the companion JSON.)
- New executable authority (ODS maintenance addenda, wave batch authorities, Controller
  entries, migrations) SHOULD cite this baseline or the companion ratifications file where
  the decision it implements traces back to a product-owner ratification recorded here.
- Historical authority remains immutable. This baseline does not rewrite, restate, or
  weaken any sealed/frozen artifact.
- This is **not** an ODS authority successor, **not** a migration authority, and **not**
  permission to implement any of the unresolved domains it describes. Its only purpose is
  to prevent product/architecture drift and to make future missions prove alignment
  before implementation.

## 1. North Star

Uellix converts social impact into defensible evidence.

Uellix is a **B2B Impact Operating System** — not merely an SROI calculator, not a
dashboard, not an AI report generator.

Two structural differentiators:

1. **Proxy intelligence** — help identify, evaluate, document and justify proxies for
   outcomes/SROI.
2. **Traceability** — connect claims, calculations, sources, evidence, assumptions,
   versions, human decisions and approvals.

## 2. Commercial V1 Definition

Commercial V1 must be a genuinely sellable B2B product. It is **NOT** a demo, a manually
operated pilot, or an engineering-assisted MVP.

It must support:

- registration/onboarding/autoprovisioning without technical intervention
- organization/tenant isolation
- users
- differentiated roles/permissions
- read/edit/review/approve or decide boundaries
- multiple active projects per organization
- Measure complete for V1 journeys
- Portfolio complete for V1 journeys
- Evaluate complete for V1 journeys
- Stella as governed transversal intelligence
- defensible evidence/reporting
- commercial administration

## 3. Canonical Domain Model

| Domain | Scope |
|---|---|
| **Measure** | outcomes, indicators, evidence, causal chain, valuation, proxies, SROI, methodological readiness/review |
| **Portfolio** | cross-project consolidation, comparison, evidence/results/performance, methodologically valid aggregation |
| **Evaluate** | structured evaluation, assessments, deterministic scoring/recommendation, human decisions |
| **Grants** | product domain, but **not** a Commercial V1 launch gate unless later authority says otherwise |
| **Stella** | transversal governed intelligence — not an independent authorization/calculation authority |
| **Platform** | commercial accounts, entitlements, tenancy, control plane, administration |
| **Public/Trust** | governed disclosure/verification/report-integrity surfaces |
| **Ops** | observability, recovery, security, release control |

## 4. Non-Negotiable Invariants

- Organization = tenant root.
- Ownership != Access.
- CommercialAccount != Organization.
- Payment != Activation.
- ReleaseFlag != Entitlement != Authorization.
- Measure != Evaluate.
- Stella analysis != Human decision.
- Evidence != Claim.
- Draft != Approved.
- Calculated != Methodology Approved.
- Code Complete != Audit Complete != Staging Validated != Commercially Ready.
- Historical claims/evidence/reports must remain reconstructible.
- Cross-tenant access fails closed.
- Commercial V1 cannot require technical manual provisioning.
- CommercialAccount association != membership.
- CommercialAccount association != authorization.
- Plan != entitlement.
- Usage != entitlement.
- Quota != billing.
- Payment != activation.
- Stripe webhook != membership/role/tenant creation authority.
- Selected organization scope remains Organization, never CommercialAccount.

*(The eight invariants above were added by the CA-06/CA-07/CA-08 amendment,
`COMMERCIAL-V1-CA06-CA08-RATIFICATION-MATERIALIZATION-R1`, 2026-09-05. No
pre-existing invariant in this list was altered or removed.)*

**Stella doctrine:** *"la IA propone y analiza; el sistema controla y calcula; las
personas deciden y aprueban."*

## 5. Human-Ratified Product Decisions

Full text and per-decision implementation status live in the companion machine-readable
file:

`docs/ops/commercial/COMMERCIAL_V1_PRODUCT_RATIFICATIONS_v1.0.0.json`

These are treated as **RATIFIED BY PRODUCT OWNER** as of this mission. Do not re-open any
of them unless repository evidence proves an actual contradiction requiring escalation —
absence of implementation is not a contradiction.

Domains covered (see the JSON file for the exact ratification text and, for the six
MO ids below marked with an evidence note, the full `RATIFIED_PRODUCT_INTENT` /
`CURRENT_EXECUTABLE_STATE` / `REQUIRED_RESOLUTION` breakdown):

- **Tenancy / Multi-org**: MO-01 .. MO-09 — self-service founding is 1-per-subject,
  membership is multi-org, exactly one selected organization is the request scope at a
  time (session-scoped, `HttpOnly`/`Secure`/`SameSite=Lax`, session-only), membership is
  revalidated every request and is the authorization ceiling, tenant routes stay
  membership-bound even for platform superadmins (no silent bypass), `/admin` is a
  separate platform/global scope, and any future impersonation must be explicit,
  auditable, time-bounded, separately authorized — never inferred from superadmin status.
  Six of these ids are not a generic absence but have a measured, named relationship to
  current executable code:
  - **MO-02 contradicts current executable state.** `db/schema.ts:61`
    (`uniqueIndex('user_single_active_membership')...where(status = 'active')`),
    materialized in `db/baseline/stella_g2_schema.sql:7071`, actively ENFORCES at most one
    active membership per user — this is an enforced ceiling, not merely unimplemented
    multi-membership. `REQUIRED_RESOLUTION = FUTURE_AUTHORITY_REQUIRED`.
  - **MO-03** is `NOT_IMPLEMENTED_AS_RATIFIED` — the current principal is
    singular/pick-first (`lib/auth/database-context.ts`: "the caller's single active
    membership"), not a selection among several. `AUTHORITY_GAP`, downstream of MO-02.
  - **MO-05** is `PARTIALLY_IMPLEMENTED` / `IMPLEMENTED_AT_CURRENT_SINGLE_ORG_CEILING` —
    `db/identity-context.ts` genuinely re-verifies membership on every call
    (`withDatabaseIdentityContext`), but against the single-membership ceiling, not a
    selected organization; the mechanism needs rework once MO-02/MO-03 are resolved.
  - **MO-06** is `IMPLEMENTED_AT_CURRENT_TENANCY_MODEL` — role-as-ceiling is real today via
    frozen FIB authority and the live 104-policy RLS surface documented in
    `db/identity-context.ts` (98 policies call `current_user_is_super_admin()`, 33 call
    `current_user_org_ids()`).
  - **MO-07 contradicts current executable state.** `db/identity-context.ts:217`
    (`if (identity.organizationId !== null && check.is_member !== true &&
    !check.is_super_admin)`) is an explicit, present-day superadmin membership-check
    bypass at the database identity boundary. `REQUIRED_RESOLUTION =
    FUTURE_AUTHORITY_REQUIRED`.
  - **MO-12** is `NOT_IMPLEMENTED_AS_RATIFIED` / `AUTHORITY_GAP` — there is no
    selected-organization scope yet for Stella to bind to; downstream of MO-03.
- **Self-service**: SS-01 .. SS-03 — mandatory allowlisting is not part of the final V1
  journey; the V1 target is verified identity/email + abuse/rate protection +
  deterministic/idempotent bootstrap; registration != provisioning != commercial
  activation != entitlement, and commercial review may exist but technical provisioning
  intervention cannot be required.
- **Founded_by / historical data**: MO-10 .. MO-11 — `organizations.founded_by` is the
  target explicit founder relation; any historical backfill must be conservative,
  evidence-based, and must leave `founded_by` NULL rather than fabricate attribution.
- **CommercialAccount**: CA-01 .. CA-08 — CommercialAccount is distinct from
  Organization, may govern one-or-more Organizations, EntitlementGrant is distinct from
  authorization, entitlements are evaluated at the organization/product-capability
  boundary, and Stripe/payment state does not directly grant application authorization
  (CA-01..CA-05). An Organization is governed by exactly one CommercialAccount at a time,
  with a Platform-Admin-initiated governed transfer able to reassign that association
  without touching Organization identity, tenant data, memberships, roles, evidence, or
  audit history, and with the pre-transfer association remaining historically
  reconstructible (CA-06). CommercialAccount owns the commercial/payment relationship —
  Stripe customer/subscription/price identity and plan/catalog identity — while effective
  EntitlementGrants, usage meters, and quota enforcement remain scoped to Organization x
  product-capability per CA-04; CommercialAccount-level plan state is never itself
  evaluated as tenant authorization (CA-07). Stella usage and other metered capability
  usage are metered and enforced per Organization; a CommercialAccount governing multiple
  Organizations may aggregate usage/billing for reporting/invoicing only, which does NOT
  create implicit shared authorization or a pooled runtime quota — a pooled-quota model is
  future product scope requiring its own explicit ratification (CA-08). CA-06/CA-07/CA-08
  were ratified 2026-09-05 via
  `COMMERCIAL-V1-CA06-CA08-RATIFICATION-MATERIALIZATION-R1` (source: Lane AA —
  COMMERCIAL-ACCOUNT-PRODUCT-DECISION-ADJUDICATION-R1); see section 5a/5b/5c below and the
  companion JSON `ratified_semantics_detail_ca06_ca08` block for elaboration. Their
  `DEFINED=YES / IMPLEMENTED=NO / COMMERCIALLY_READY=NO` — no CommercialAccount
  type/table exists in the repository, so CA-06/07/08 inherit the same NOT_IMPLEMENTED
  posture as CA-01/CA-02 they depend on.

### 5a. Self-Service Bootstrap Sequence (ratified doctrine, elaborates SS-01..SS-03)

Registration is an atomic **CommercialAccount + first Organization bootstrap**: founder/
admin membership is granted and a deterministic initial/default entitlement is assigned,
without any technical/manual provisioning step. Commercial activation / Stripe first
binding is a **later, separate, first-party-authenticated action** — it is not part of the
atomic bootstrap and is never required for the initial Commercial V1 customer to exist.
This elaborates SS-03 (registration != provisioning != commercial activation !=
entitlement); it does **not** create CAP-05 or any other executable capability authority,
and it allocates no ODS/HPO id and no migration ordinal.

### 5b. Payment / Suspension Semantics (ratified doctrine, elaborates CA-05/CA-07/CA-08)

Payment != Activation. CommercialAccount `past_due` or commercial suspension does **not**
automatically delete membership, remove tenant identity, change `Organization.status`, or
remove historical access/evidence. Commercial billing state may cause an explicit,
auditable downgrade/revocation of paid EntitlementGrants. `Organization.status` remains a
separate tenant-operational control, independent of commercial/billing state. Platform
Admin may apply an explicit, audited commercial exception/override. Grace periods,
collections schedules, and payment retry timing are **not** ratified here — those remain
future configurable policy, not decided by this mission.

### 5c. Transfer Semantics (ratified doctrine, elaborates CA-06)

A CommercialAccount-to-Organization transfer is Platform-Admin-initiated in Commercial V1.
Across a transfer: Organization tenant identity is unchanged; memberships and roles are
unchanged; evidence and report history are unchanged; commercial history remains
reconstructible; and entitlements must be **explicitly re-evaluated** under the receiving
CommercialAccount rather than silently inherited from the prior one. This records product
intent only — no specific schema table, foreign-key design, or history-relation shape is
ratified here. A live FK plus a history relation remains a derived architecture
recommendation for a future implementation mission to propose, not product doctrine
settled by this document.
- **Evaluate**: EV-01 .. EV-03 — governed N/A semantics (excluded from numerator and
  denominator for scoring; Measure readiness may differ), DecisionPolicy as an
  immutable/versioned template with deterministic system recommendation and decisive
  human decision (divergence explicit and auditable), and the Stella boundary
  (analyze/explain/suggest/draft — never score, recommend authoritatively, decide, or
  approve).
- **Report Integrity**: RI-01 — do not resurrect obsolete report/hash/RPC designs merely
  because they appeared in prior packets; current Report Integrity requires its own
  future authority against the live repository.
- **AI Gateway**: AG-01 .. AG-03 — the target architecture is
  `Frontend -> Stella Orchestrator -> Uellix AI Gateway -> Provider Adapter -> AI
  provider`; direct frontend-to-provider access is prohibited; the Gateway/provider layer
  must expose governed telemetry (model/provider identity, token usage where available,
  economic/cost accounting, latency/errors, operation/trace correlation) without leaking
  private prompt/evidence content into ordinary logs. These are product-alignment
  ratifications, not executable authority — see section 6 for the current implementation
  state (a direct provider adapter exists; the independent Gateway layer does not).

## 6. DEFINED / IMPLEMENTED / COMMERCIALLY_READY

These three states are kept distinct on purpose and must never be collapsed into one
percentage:

- **DEFINED** — a decision exists (product ratification above, or frozen executable
  authority) even if no code implements it yet.
- **IMPLEMENTED** — repository-native evidence (code, schema, tests, passing gates)
  exists at `AS_OF_HEAD`.
- **COMMERCIALLY_READY** — implemented, audited, staging-validated, and fit for a paying
  customer to use unassisted. This is always the strictest state and is not implied by
  IMPLEMENTED.

### Capability matrix (AS_OF_HEAD = `4264bd6`)

| Capability | DEFINED | IMPLEMENTED | COMMERCIALLY_READY | Evidence / basis |
|---|---|---|---|---|
| Architecture/ODS/FIB | YES | YES | N/A (governance layer, not a customer surface) | `docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json`; Controller live count 27 at `AS_OF_HEAD` (`scripts/ods-controller.ts`, `tests/ods/ods-controller.test.ts`, commit `7d486aa`), v1.0.16 addendum present exactly once |
| Measure | YES (ratified domain) | PARTIAL | NO | `lib/pipeline`, `app/app/projects/[projectId]/pipeline/**`; Wave 2 B4 CLOSED_AUDITED_INTEGRATED, W2-B5 authority CLOSED_AUDITED_INTEGRATED / **implementation OPEN** (no `docs/ops/wave2/W2_B5_IMPLEMENTATION_EVIDENCE_v1.0.0.json` at `AS_OF_HEAD`) |
| Portfolio | YES (ratified domain) | PARTIAL | NO | `app/app/portfolios/**`, `lib/portfolios` exist at `AS_OF_HEAD`; add/remove/rename/archive and Stella project-binding completeness are **FUTURE_MEASUREMENT_REQUIRED** — no completion percentage is asserted here (a prior-session figure exists in conversation memory but is not re-measured against `AS_OF_HEAD` and is deliberately not repeated in this canonical baseline; see section 6 note below) |
| Evaluate | YES (ratified: EV-01..EV-03) | NOT_IMPLEMENTED | NO | no `Evaluate` module found under `app/app` or `lib` at `AS_OF_HEAD` by targeted search; prior packet (`project_evaluate_v1_cross_layer_packet_r1`) is a read-only design packet, not code |
| Stella runtime | YES | PARTIAL | NO | `lib/stella` exists (`lib/stella/adapter/gemini-client.ts` direct provider adapter, `lib/stella/advisor`); governed human-control doctrine ratified (EV-03 / Stella doctrine); tenant-scope binding (MO-12) is `NOT_IMPLEMENTED_AS_RATIFIED` / `AUTHORITY_GAP` |
| AI Gateway / observability | YES (ratified: AG-01..AG-03) | NOT_IMPLEMENTED (Gateway layer) / PARTIAL (current direct-adapter architecture) | NO | `lib/stella/adapter/gemini-client.ts` is a direct provider adapter called from `lib/stella/advisor/run-contextual-advisor.ts`; `lib/stella/adapter/provider-call-log.ts`, `lib/stella/observability.ts`, `lib/stella/cost-model.ts` exist as adapter-level telemetry/cost building blocks. **No independent Uellix AI Gateway layer between the orchestrator and the provider adapter is materialized at `AS_OF_HEAD`.** State this precisely: the runtime/provider adapter exists; the ratified Gateway boundary (AG-01) does not yet exist as its own layer |
| Evidence/traceability | YES (North Star differentiator) | PARTIAL | NO | evidence objects exist inside `lib/pipeline`/Measure; full claim-to-approval traceability chain not independently re-audited by this mission |
| Report Integrity | YES (ratified: RI-01, "do not resurrect obsolete designs") | NOT_IMPLEMENTED | NO | no `report_hash`/report-integrity RPC found under `app`/`lib`/`db` by targeted search at `AS_OF_HEAD`; `lib/reports` exists but its relation to a live design is unresolved — **AUTHORITY_GAP**, needs its own future authority per RI-01 |
| Self-service onboarding | YES (ratified: SS-01..SS-03) | PARTIAL | NO | `app/app/organization/onboarding` exists; verified-identity/abuse-protection/idempotent-bootstrap posture is FUTURE_MEASUREMENT_REQUIRED |
| Multi-org | YES (ratified: MO-01..MO-09) | **CONTRADICTS_PRODUCT_INTENT at MO-02/MO-07**, NOT_IMPLEMENTED_AS_RATIFIED at MO-03/MO-12, PARTIALLY_IMPLEMENTED at MO-05/MO-06 | NO | not a generic absence: `db/schema.ts:61` (`user_single_active_membership` partial unique index) actively enforces single active membership (contradicts MO-02), and `db/identity-context.ts:217` contains an explicit superadmin membership-check bypass (contradicts MO-07) — see section 5 and the companion JSON for the full per-id breakdown; both require `FUTURE_AUTHORITY_REQUIRED` |
| CommercialAccount / Entitlements | YES (ratified: CA-01..CA-08) | NOT_IMPLEMENTED | NO | no `CommercialAccount`/`EntitlementGrant` type or table found by targeted search; commercial fields currently overload Organization (`app/app/organization/billing`, `lib/stripe`) — see Known Alignment Gap #2. CA-06/07/08 (governed transfer, plan/payment ownership boundary, per-Organization metering with aggregation-only rollup) are `DEFINED=YES / IMPLEMENTED=NO / COMMERCIALLY_READY=NO`, ratified 2026-09-05 |
| Platform Admin | YES | PARTIAL | NO | `app/admin` and `lib/admin` exist as a distinct route/library tree (consistent with MO-08 in shape); superadmin membership-check bypass at `db/identity-context.ts:217` (MO-07) means the `/admin`-vs-tenant-route separation is not yet the clean boundary MO-07 ratifies — completeness/isolation beyond that specific point is FUTURE_MEASUREMENT_REQUIRED |
| Staging/release | YES | PARTIAL | NO | staging pipeline artifacts exist under `docs/ops/staging/**`; exact baseline-unit completeness is **FUTURE_MEASUREMENT_REQUIRED** via `pnpm ops:program-state`/`ops:integration-plan` at whatever HEAD a future mission starts from — no historical unit count is carried forward into this canonical baseline |

**This matrix is alignment, not a live progress dashboard.** It intentionally excludes
historical completion percentages and historical staging unit counts (e.g. a
Portfolio-completeness percentage or a staging baseline-unit count from an earlier
session) — those are volatile facts that decay the moment integration moves and do not
belong in a canonical reference. Where a number is needed for a real decision, a future
mission must re-run the relevant measurement (`pnpm ops:program-state`,
`pnpm ops:integration-plan`, or an explicit repo search) at its own `AS_OF_HEAD` and may
record that number in a separate, dated status report — not in this file. This mission's
`node_modules` were not installed in this worktree, so `pnpm ops:program-state` could not
be run live here either; every IMPLEMENTED/PARTIAL/NOT_IMPLEMENTED claim above instead
cites a specific repository path, line, or test found (or not found) by direct search at
`AS_OF_HEAD`, which is a weaker but honest substitute for a live program-state run.

## 7. Known Alignment Gaps

These are explicit **authority/implementation gaps**, not unknown product direction. The
product direction is ratified (section 5); the repository has not caught up to it yet.

1. **Multi-org product intent vs. current implementation — an active contradiction, not
   just an absence.** MO-01..MO-09 ratify one-founding-per-subject + multi-membership + a
   single session-scoped selected organization, with no silent superadmin bypass. At
   `AS_OF_HEAD` the repository does not merely lack these features — two specific pieces
   of executable code actively contradict the ratified intent:
   - `db/schema.ts:61` / `db/baseline/stella_g2_schema.sql:7071` — the
     `user_single_active_membership` partial unique index ENFORCES at most one active
     membership per user, directly contradicting MO-02.
   - `db/identity-context.ts:217` — an explicit `!check.is_super_admin` exception lets a
     confirmed superadmin bypass the active-membership check, directly contradicting
     MO-07.
   Both are `FUTURE_AUTHORITY_REQUIRED`: resolving them means a governed schema/authority
   change to the unique index, the invitation/bootstrap logic built on it
   (`db/prepared/stella_0006_invitation_capability.sql`,
   `db/prepared/stella_0010_organization_bootstrap_capability.sql`), and the identity
   boundary in `db/identity-context.ts` — not a documentation update, and not inferred
   from this baseline. MO-03/MO-05/MO-06/MO-12 are downstream of that same resolution
   (see section 5 and the companion JSON for their individual status).
2. **CommercialAccount/Entitlements target vs. current Organization-overloaded
   commercial fields.** CA-01..CA-05 ratify CommercialAccount and EntitlementGrant as
   distinct concepts from Organization and from authorization. At `AS_OF_HEAD`, billing
   lives under `app/app/organization/billing` and `lib/stripe`, i.e. commercial state is
   currently attached to Organization directly. Migrating to the ratified model is a
   schema-and-authorization-boundary change requiring its own FIB/ODS-governed authority;
   this baseline does not authorize that migration.
3. **Report Integrity product need vs. unresolved current authority.** RI-01 explicitly
   forbids resurrecting obsolete report/hash/RPC designs from prior packets. No live
   Report Integrity design exists at `AS_OF_HEAD`. A future mission must produce a fresh
   authority against the *current* repository state, not adapt an old packet.

## 8. Alignment Gate for All Future Missions

Every significant future mission must identify:

- `COMMERCIAL_OBJECTIVE`
- `USER_JOURNEY`
- `DOMAIN_OWNER`
- `REPO_AUTHORITY`
- `ARCHITECTURE_INVARIANTS`
- `DEPENDENCIES`
- `AUTHORIZED_PATHS`
- `DETERMINISTIC_EXIT_CRITERIA`

If a required element is absent: **STOP** or classify explicitly using one of:

- `FUTURE_AUTHORITY_REQUIRED`
- `HUMAN_RATIFICATION_REQUIRED`
- `INSUFFICIENT_EVIDENCE`
- `FUTURE_MEASUREMENT_REQUIRED`

Never silently invent missing authority.

## 9. Development Operating Model (guidance, not executable authority)

| Tier | Use for |
|---|---|
| Sonnet Normal | small local implementation/wiring/tests/UI |
| Sonnet High | schema, RLS, migrations, cross-layer work, shared writers, B5/Wave3/Evaluate |
| Opus High | authority, contradiction resolution, independent audits |
| Opus Max | tenant-security critical audits, SoD, Controller, release/cutover, exceptionally high-risk contradictions |
| Machine-first | hashes, counts, diffs, tests, PG behavior, CI, scope, poststate |

Concurrency on the current 16GB workstation: normal = 2 heavy lanes; maximum practical =
3, only when resource-safe.

This section restates the routing already frozen in
`docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json` (`model_executor_routing`) and
`docs/ops/ods/ODS_CONTROLLER_AUTHORITY_v1.0.0.json` for product-mission convenience; on
any divergence, those artifacts control.

## 10. Current Program Snapshot

`AS_OF_HEAD: 4264bd606e1b1da93ab6c8e9167979983994e702 (origin/integration/commercial-v1)`

| Node | Status | Basis |
|---|---|---|
| Controller (live enumeration) | CLOSED — 27 live, v1.0.16 exactly once | `scripts/ods-controller.ts`, `tests/ods/ods-controller.test.ts`, commit `7d486aa`; PR #67 merged as `4264bd6` |
| W2-B5 authority (FIBIU-17/FIBIU-18) | CLOSED_AUDITED_INTEGRATED (authority) / **OPEN** (implementation) | `docs/ops/wave2/W2_B5_AUTHORITY_v1.0.0.json` `final_state = W2_B5_AUTHORITY_FROZEN_WAITING_FOR_IMPLEMENTATION`; no implementation-evidence file present at `AS_OF_HEAD` |
| Wave 2 (overall) | OPEN — blocked on B5 implementation + closure | B4 CLOSED_AUDITED_INTEGRATED (memory: project_w2_b4_closed_audited_integrated_and_controller26_r1); B5 authority closed, implementation pending |
| Wave 3 / FIBDB-053 | AUTHORITY_REQUIRED / read-only compiled | no `docs/ops/wave3` directory exists at `AS_OF_HEAD`; prior zero-discovery compiler (memory) is design-only, not authority |
| Multi-org | AUTHORITY_REQUIRED — product intent ratified (section 5) actively CONTRADICTED by current executable state at MO-02/MO-07, not merely unimplemented | see Known Alignment Gap #1 |
| Portfolio | IMPLEMENTATION_ACTIVE (partial) | `app/app/portfolios`, `lib/portfolios`; exact completeness is FUTURE_MEASUREMENT_REQUIRED — no percentage carried in this canonical snapshot |
| Evaluate | NOT_IMPLEMENTED | no module found at `AS_OF_HEAD` |
| Report Integrity | AUTHORITY_REQUIRED | see Known Alignment Gap #3 |
| AI Gateway | AUTHORITY_REQUIRED (product architecture ratified, AG-01..AG-03; Gateway layer NOT_IMPLEMENTED) | `lib/stella/adapter/gemini-client.ts` direct provider adapter exists; no independent Gateway layer between orchestrator and adapter exists at `AS_OF_HEAD` |
| Platform Admin | IMPLEMENTATION_ACTIVE (partial) | `app/admin`, `lib/admin` present; superadmin membership-check bypass (MO-07, `db/identity-context.ts:217`) and CommercialAccount wiring (Known Alignment Gap #2) both block completion |
| Staging | STAGING_PENDING | exact baseline-unit count is FUTURE_MEASUREMENT_REQUIRED via `pnpm ops:program-state` / `pnpm ops:integration-plan` — no historical unit count is carried in this canonical snapshot |
| Production | NOT_STARTED | `main` frozen at `067e8c2f3` per `docs/ops/ods/ODS_CONTROLLER_AUTHORITY_v1.0.0.json` `production_freeze_invariant`; no cutover authorized |

Statuses use: `CLOSED`, `OPEN`, `NOT_IMPLEMENTED`, `AUTHORITY_REQUIRED`,
`IMPLEMENTATION_ACTIVE`, `STAGING_PENDING`. This snapshot is a point-in-time read at
`AS_OF_HEAD` and MUST be re-measured, not assumed, by any mission that starts from a
later head.

## 11. Critical Path (current high-level order — re-measured as integration evolves)

```
Controller27 CLOSED
  -> B5 scope authority successor
  -> resume B5
  -> FIBIU-18 independent audit
  -> B5 closure
  -> Wave2 closure

  -> Wave3 / FIBDB-053 / FIBIU-19 / FIBIU-20
  -> Wave3 closure

Controlled parallel commercial track:
  Multi-org authority
  -> tenancy
  -> CAP-05/self-service
  -> CommercialAccount/Entitlements
  -> Platform Admin

After required dependencies:
  Evaluate
  Portfolio
  Report Integrity/CAP-02
  AI Gateway

  -> Commercial Golden
  -> staging convergence
  -> managed validation
  -> release audit
  -> production cutover
```

This graph is a sequencing aid, not a schedule commitment, and is re-measured as
integration evolves — treat any node marked CLOSED above as the only fixed points.

## 12. Quality Check (performed before commit)

- No claim in this document labels future product intent as already implemented — every
  IMPLEMENTED/PARTIAL claim above cites a repository path, test, or commit; every
  NOT_IMPLEMENTED/AUTHORITY_REQUIRED claim is explicit about what was searched and not
  found.
- No current code constraint is silently reclassified as product intent — gaps are
  recorded as gaps (section 7), not folded into the ratifications as if already decided
  differently.
- No migration number, ODS/HPO id, or Controller entry is allocated by this document or
  its companion JSON.
- No runtime source changed by this mission; only `docs/ops/commercial/**` was changed.
- Mechanically verified (companion JSON `self_check` block, checked by direct inspection):
  `ratifications.length == 27`; every `id` unique; the exact id set equals
  `MO-01..MO-12, SS-01..SS-03, CA-01..CA-05, EV-01..EV-03, RI-01, AG-01..AG-03` with no
  missing and no extra id.
- Every IMPLEMENTED/PARTIAL/CONTRADICTS_PRODUCT_INTENT claim added or revised in this
  remediation cites a specific repository path and, where applicable, a line number
  (`db/schema.ts:61`, `db/identity-context.ts:217`, `lib/stella/adapter/gemini-client.ts`)
  found by direct read or grep at `AS_OF_HEAD` — none is carried forward from
  conversation memory without a fresh repository check.

## 13. Quality Check — CA-06/CA-07/CA-08 Amendment (`COMMERCIAL-V1-CA06-CA08-RATIFICATION-MATERIALIZATION-R1`, 2026-09-05)

- No existing ratification (MO-01..MO-12, SS-01..SS-03, CA-01..CA-05, EV-01..EV-03, RI-01,
  AG-01..AG-03) was altered — verified by a direct field-by-field diff of the companion
  JSON's 27 pre-amendment entries against the post-amendment file (byte-identical).
- CA-06, CA-07, CA-08 are the only ids added. No CA-09 or any other new product id was
  allocated, per this mission's explicit boundary.
- Mechanically verified (companion JSON `self_check` block): `ratifications.length == 30`;
  every `id` unique (30 unique); the exact id set equals
  `MO-01..MO-12, SS-01..SS-03, CA-01..CA-08, EV-01..EV-03, RI-01, AG-01..AG-03` with no
  missing and no extra id; `CA-09` absent.
- CA-06/CA-07/CA-08 are recorded as `DEFINED=YES / IMPLEMENTED=NO / COMMERCIALLY_READY=NO`
  — no repository evidence contradicts this; they depend on CA-01/CA-02, which are
  themselves `NOT_IMPLEMENTED` (no `CommercialAccount` type/table exists at
  `amendment_AS_OF_HEAD`).
- The self-service bootstrap sequence, payment/suspension semantics, and transfer
  semantics are recorded as doctrine elaboration (sections 5a/5b/5c above and the
  companion JSON `ratified_semantics_detail_ca06_ca08` block) — no new ratification id,
  no CAP-05 or other executable capability authority, no ODS/HPO id, and no migration
  ordinal is allocated by any of them.
- No prohibited interpretation from the mission prompt was introduced: this document does
  not state that an Organization may have multiple simultaneous CommercialAccounts, does
  not make CommercialAccount a tenant root, does not create account-wide runtime
  authorization or pooled Stella quota in Commercial V1, does not make payment failure
  automatically suspend `Organization.status`, does not let Stripe directly grant
  membership/role/tenant access/EntitlementGrant, and does not make a CommercialAccount
  transfer rewrite historical billing/evidence.
- No runtime, schema, migration, RLS, Stripe, capability, ODS/HPO, or Controller change
  was made by this amendment; only `docs/ops/commercial/**` was changed.
- This amendment is `READY_FOR_INDEPENDENT_COMMERCIAL_RATIFICATION_AUDIT`. It is
  explicitly **NOT** `READY_FOR_COMMERCIAL_ACCOUNT_EXECUTABLE_AUTHORITY` until that
  independent audit passes — required because this is a cross-project canonical product
  artifact per the originating mission prompt.
