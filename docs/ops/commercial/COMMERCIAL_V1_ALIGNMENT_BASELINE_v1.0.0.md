# COMMERCIAL_V1_ALIGNMENT_BASELINE_v1.0.0

```
artifact_id:        COMMERCIAL_V1_ALIGNMENT_BASELINE_v1.0.0
authority_class:    PRODUCT_ALIGNMENT_REFERENCE_NOT_EXECUTABLE_AUTHORITY
hpo_mission_id:      COMMERCIAL-V1-ALIGNMENT-BASELINE-MATERIALIZATION-R1
materialization_date: 2026-09-04
companion_artifact:  docs/ops/commercial/COMMERCIAL_V1_PRODUCT_RATIFICATIONS_v1.0.0.json
AS_OF_HEAD:          4264bd606e1b1da93ab6c8e9167979983994e702 (origin/integration/commercial-v1)
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

**Stella doctrine:** *"la IA propone y analiza; el sistema controla y calcula; las
personas deciden y aprueban."*

## 5. Human-Ratified Product Decisions

Full text and per-decision implementation status live in the companion machine-readable
file:

`docs/ops/commercial/COMMERCIAL_V1_PRODUCT_RATIFICATIONS_v1.0.0.json`

These are treated as **RATIFIED BY PRODUCT OWNER** as of this mission. Do not re-open any
of them unless repository evidence proves an actual contradiction requiring escalation —
absence of implementation is not a contradiction.

Domains covered (see the JSON file for the exact ratification text of each id):

- **Tenancy / Multi-org**: MO-01 .. MO-09 — self-service founding is 1-per-subject,
  membership is multi-org, exactly one selected organization is the request scope at a
  time (session-scoped, `HttpOnly`/`Secure`/`SameSite=Lax`, session-only), membership is
  revalidated every request and is the authorization ceiling, tenant routes stay
  membership-bound even for platform superadmins (no silent bypass), `/admin` is a
  separate platform/global scope, and any future impersonation must be explicit,
  auditable, time-bounded, separately authorized — never inferred from superadmin status.
- **Self-service**: SS-01 .. SS-03 — mandatory allowlisting is not part of the final V1
  journey; the V1 target is verified identity/email + abuse/rate protection +
  deterministic/idempotent bootstrap; registration != provisioning != commercial
  activation != entitlement, and commercial review may exist but technical provisioning
  intervention cannot be required.
- **Founded_by / historical data**: MO-10 .. MO-11 — `organizations.founded_by` is the
  target explicit founder relation; any historical backfill must be conservative,
  evidence-based, and must leave `founded_by` NULL rather than fabricate attribution.
- **Stella tenant scope**: MO-12 — Stella operations/tickets bind to the selected
  validated organization context, rechecked at the database/runtime boundary.
- **CommercialAccount**: CA-01 .. CA-05 — CommercialAccount is distinct from
  Organization, may govern one-or-more Organizations, EntitlementGrant is distinct from
  authorization, entitlements are evaluated at the organization/product-capability
  boundary, and Stripe/payment state does not directly grant application authorization.
- **Evaluate**: EV-01 .. EV-03 — governed N/A semantics (excluded from numerator and
  denominator for scoring; Measure readiness may differ), DecisionPolicy as an
  immutable/versioned template with deterministic system recommendation and decisive
  human decision (divergence explicit and auditable), and the Stella boundary
  (analyze/explain/suggest/draft — never score, recommend authoritatively, decide, or
  approve).
- **Report Integrity**: RI-01 — do not resurrect obsolete report/hash/RPC designs merely
  because they appeared in prior packets; current Report Integrity requires its own
  future authority against the live repository.

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
| Portfolio | YES (ratified domain) | PARTIAL | NO | `app/app/portfolios/**`, `lib/portfolios`; prior zero-discovery finding (memory: project_portfolio_commercial_v1_gap_r1) records ~35% completion at an earlier head, no add/remove/rename/archive, Stella not yet project-bound-unblocked — **treat that percentage as historical, not re-verified by this mission; re-measure before relying on it** |
| Evaluate | YES (ratified: EV-01..EV-03) | NOT_IMPLEMENTED | NO | no `Evaluate` module found under `app/app` or `lib` at `AS_OF_HEAD` by targeted search; prior packet (`project_evaluate_v1_cross_layer_packet_r1`) is a read-only design packet, not code |
| Stella runtime | YES | PARTIAL | NO | `lib/stella` exists; governed human-control doctrine ratified (EV-03 / Stella doctrine); tenant-scope binding (MO-12) is FUTURE_MEASUREMENT_REQUIRED |
| AI Gateway / observability | NO (not yet a ratified target architecture) | NOT_IMPLEMENTED | NO | prior zero-discovery finding (memory: project_stella_ai_gateway_observability_zero_discovery_compiler_r1) recorded no Gateway (driver+adapter+actions) at an earlier head; not re-verified here — treat as AUTHORITY_GAP pending its own architecture ratification |
| Evidence/traceability | YES (North Star differentiator) | PARTIAL | NO | evidence objects exist inside `lib/pipeline`/Measure; full claim-to-approval traceability chain not independently re-audited by this mission |
| Report Integrity | YES (ratified: RI-01, "do not resurrect obsolete designs") | NOT_IMPLEMENTED | NO | no `report_hash`/report-integrity RPC found under `app`/`lib`/`db` by targeted search at `AS_OF_HEAD`; `lib/reports` exists but its relation to a live design is unresolved — **AUTHORITY_GAP**, needs its own future authority per RI-01 |
| Self-service onboarding | YES (ratified: SS-01..SS-03) | PARTIAL | NO | `app/app/organization/onboarding` exists; verified-identity/abuse-protection/idempotent-bootstrap posture is FUTURE_MEASUREMENT_REQUIRED |
| Multi-org | YES (ratified: MO-01..MO-09) | NOT_IMPLEMENTED (as ratified) | NO | no selected-organization session carrier or multi-membership selection surface found under `app`/`lib` by targeted search at `AS_OF_HEAD` — see Known Alignment Gap #1 |
| CommercialAccount / Entitlements | YES (ratified: CA-01..CA-05) | NOT_IMPLEMENTED | NO | no `CommercialAccount`/`EntitlementGrant` type or table found by targeted search; commercial fields currently overload Organization (`app/app/organization/billing`, `lib/stripe`) — see Known Alignment Gap #2 |
| Platform Admin | YES | PARTIAL | NO | `app/admin` and `lib/admin` exist as a distinct route/library tree (consistent with MO-08 in shape); prior zero-discovery finding recorded `/admin` calling definers ahead of design application in some paths at an earlier head — not re-verified here |
| Staging/release | YES | PARTIAL | NO | prior zero-discovery finding (memory: project_commercial_v1_staging_cutover_release_compiler_r1) recorded staging at 50/76 baseline units at an earlier head — **treat as historical, re-measure via `pnpm ops:program-state`/`ops:integration-plan` before relying on it for a release decision** |

**Do not freeze these PARTIAL/percentage claims as authority.** Several rows cite
prior-session memory rather than a fresh measurement in this mission (this mission's
`node_modules` were not installed in this worktree, so `pnpm ops:program-state` could not
be run live here — a tooling fact, not a product one). Any future mission relying on a
specific completeness number MUST re-run the measurement, not cite this table as the
source of truth for that number. This table's job is to keep DEFINED, IMPLEMENTED, and
COMMERCIALLY_READY visibly distinct — not to be a live dashboard.

## 7. Known Alignment Gaps

These are explicit **authority/implementation gaps**, not unknown product direction. The
product direction is ratified (section 5); the repository has not caught up to it yet.

1. **Multi-org product intent vs. current implementation.** MO-01..MO-09 ratify
   one-founding-per-subject + multi-membership + a single session-scoped selected
   organization. At `AS_OF_HEAD` no selected-organization session carrier or
   multi-membership selection UI was found by targeted search. Implementing this requires
   its own governed authority (schema for membership plurality if not already present,
   session carrier, request-boundary revalidation, and an explicit `/admin` vs.
   tenant-route separation test) before any code changes — not inferred from this
   baseline.
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
| Multi-org | AUTHORITY_REQUIRED (product intent ratified, section 5; no executable authority yet) | see Known Alignment Gap #1 |
| Portfolio | IMPLEMENTATION_ACTIVE (partial) | `app/app/portfolios`, `lib/portfolios`; re-measure before relying on any completion percentage |
| Evaluate | NOT_IMPLEMENTED | no module found at `AS_OF_HEAD` |
| Report Integrity | AUTHORITY_REQUIRED | see Known Alignment Gap #3 |
| AI Gateway | AUTHORITY_REQUIRED | no Gateway module found by targeted search; needs its own architecture ratification before implementation |
| Platform Admin | IMPLEMENTATION_ACTIVE (partial) | `app/admin`, `lib/admin` present; entitlement/CommercialAccount wiring blocked by Known Alignment Gap #2 |
| Staging | STAGING_PENDING | re-measure via `pnpm ops:program-state` / `pnpm ops:integration-plan` before relying on any prior baseline-unit count |
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
- No runtime source changed by this mission; only `docs/ops/commercial/**` was added.
