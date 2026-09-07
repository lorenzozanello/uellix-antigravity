# 20 — Stella Role Contracts

> **Owner:** WS6 (Roles & Evaluation), Fable Moonshot.
> **Status:** v1 — formalizes the contracts of the six active Stella roles as implemented.
> **Companion tests:** `lib/stella/schemas/schema-versions.test.ts` (key-list pins),
> `lib/stella/prompts/reviewer-system.test.ts` (prompt↔context contract),
> `tests/eval/stella-roles/**` + `scripts/eval-roles-offline.ts` (behavioral gates).

Stella is a **read-only methodology assistant**. No role writes to the SROI pipeline, changes
any status, or replaces human review. Every model call is feature-flagged (default **false**),
auth-gated, org-scoped, rate-limited, quota-checked, and audit-logged to `stella_interactions`.

## 0. Cross-role invariants

These hold for **all** roles and take precedence over anything else:

1. **Human review is non-negotiable.** Where the schema carries the field, `requires_human_review`
   / `requiresHumanReview` is a Zod `literal(true)` — an output with `false` fails schema parsing
   (`PARSE_ERROR`), it is never "corrected".
2. **Numeric prohibitions.** No role may calculate, recalculate, convert, or invent figures. The
   SROI ratio and totals come exclusively from the deterministic engine
   (`lib/pipeline/sroi-calculation`); Stella receives them as context only.
3. **No certification/approval language.** Certification, approval, validation and sign-off are
   categorically outside every role's mandate regardless of data completeness (SHARED_GUARDRAILS
   + contextual advisor's categorical refusal).
4. **Metadata-only context.** No raw file content, no `filePath`/storage paths, no full
   `snapshotJson`, no PII (redacted via `redactPii`), no secrets, no cross-org data. Org isolation
   is enforced with double filters (`projectId` **and** `organizationId`) on every query.
5. **Untrusted-data envelope.** All org/user-derived content reaches the model inside the
   `UNTRUSTED_PROJECT_DATA` envelope (single JSON payload); it is data, never instructions.
6. **Common error codes** (all server actions): `DISABLED`, `UNAUTHORIZED`, `RATE_LIMITED`,
   `RATE_LIMIT_UNAVAILABLE`, `QUOTA_EXCEEDED`, `PAYLOAD_TOO_LARGE`, `GEMINI_ERROR`,
   `PARSE_ERROR`, `TIMEOUT`, `AUDIT_ERROR`, `UNKNOWN_ERROR`. Role-specific additions are listed
   per role. `AUDIT_ERROR` is fail-closed: if the `stella_interactions` insert fails, the user
   never receives the model output.

## 1. Advisor (`advisor`, incl. contextual mode)

| Aspect | Contract |
|---|---|
| Purpose | Methodological guidance for the current pipeline step. Never touches data, never evaluates a specific artifact's validity. |
| Flag | `STELLA_ENABLED` + `STELLA_ADVISOR_ENABLED` |
| Action | `app/actions/stella/advisor.ts` (`getStellaAdvisor`) |
| Inputs | `AdvisorProjectContext` from `buildAdvisorContext` (project name, narrative summary, outcomes/indicators/stakeholders/activities snapshots, evidence metadata, proxy summary, filters, calculation snapshot + readiness). Contextual mode slices per step via `buildAdvisorStepContext` (`ADVISOR_STEP_CONTEXT_FIELDS`). |
| Output (classic) | `AdvisorOutputSchema`: `step`, `what_to_do`, `why_it_matters`, `how_to_do_it`, `common_mistakes[]`, `suggested_next_actions[]`. |
| Output (contextual) | `AdvisorContextualOutputSchema` (**strict**): `step` (enum), `responseType` (`explanation\|review\|reformulation\|gap_analysis`), `summary`, `findings[]`, `suggestions[]`, `clarifyingQuestions[]`, `limitations[]`, `requiresHumanReview: literal(true)`. |
| `sourceRefIndexes` contract | The provider cites sources ONLY as integer indexes into the request's frozen `canonicalSourceFieldPaths` catalog. Decoding (`decodeProviderSourceRefIndexes`) is fail-closed: out-of-range indexes, string paths, aliases, `sourceFields` properties from the provider, or bare index tokens leaked into free text (`(3)`, `índice 3`, `fuente 3`) reject the whole response. Empty collections are citable via `.empty` sentinel leaves. Internally decoded outputs carry canonical `sourceFields` paths. |
| Failure modes | Common codes + `UNSUPPORTED_STEP`. Contextual production path replaces any decode/validation failure with the claim-free fallback (`requiresHumanReview: true`). |
| Versioning | Key lists pinned in `schema-versions.test.ts`. The contextual schema is frozen by the b1c closure; changes require a new gate, not a silent edit. |
| **Reformulation** | `responseType: 'reformulation'` exists in the schema but is **UNIMPLEMENTED end-to-end (declarative only)**: no product `userQuestion` channel exists to request it, and no UI renders it. Deliberately out of this wave — recorded as an input for `docs/ops/STELLA_FABLE_DECISIONS.md` (product decision on the userQuestion channel needed first). |

## 2. Validator (`validator`)

| Aspect | Contract |
|---|---|
| Purpose | Methodological completeness/rigor review of the **Calculation** step: evidence coverage, proxy quality, attribution/deadweight justification, consistency, claims risk. |
| Flag | `STELLA_ENABLED` + `STELLA_VALIDATOR_ENABLED` |
| Action | `app/actions/stella/validator.ts` (`getStellaValidator`) |
| Inputs | `StellaProjectContext` from `buildValidatorContext(projectId, organizationId, step)`; only `calculation`/`cálculo` accepted (`UNSUPPORTED_STEP` otherwise). Proxy financial values are **excluded** (confidence/risk metadata only); calculation totals come from the latest `calculated` run. |
| Output | `ValidatorOutputSchema` **v`1.0.0`** (`VALIDATOR_OUTPUT_SCHEMA_VERSION`): `summary`, `risk_level` (`low\|medium\|high`), `evidence_gaps[]`, `proxy_risks[]`, `attribution_risks[]`, `claim_risks[]`, `recommendations[]`, `requires_human_review: literal(true)`. |
| Invariants | Never recalculates the ratio; never approves; findings are observations, not decisions. |
| Failure modes | Common codes + `UNSUPPORTED_STEP`; context builder codes `UNSUPPORTED_STEP` / `PROJECT_NOT_FOUND` / `CONTEXT_UNAVAILABLE` map to `UNAUTHORIZED`-style results in the action. |

## 3. Composer (`composer`)

| Aspect | Contract |
|---|---|
| Purpose | **Draft-only** report section writer. `draft_content` is NEVER persisted automatically — the user reviews, edits and saves through the report UI. |
| Flag | `STELLA_ENABLED` + `STELLA_COMPOSER_ENABLED` |
| Action | `app/actions/stella/composer.ts` (`getStellaComposer`) |
| Inputs | `StellaProjectContext` from `buildComposerContext(projectId, organizationId, reportId)` (report ownership double-checked). Section type allowlisted against `SECTION_META` before touching the system prompt. Funder breakdown included only for `funder_breakdown`. |
| Output | `ComposerOutputSchema` **v`1.0.0`** (`COMPOSER_OUTPUT_SCHEMA_VERSION`): `section_key`, `draft_title`, `draft_content`, `assumptions[]`, `limitations[]`, `evidence_references[{evidenceId,title,context}]`, `proxy_references[{proxyId,name,context}]`. |
| Numeric prohibitions | Every numeric token in free text must trace to the authorized set (run totals, ratio, funder rows, explicitly passed extras) under `validateComposerNumbers`; every `evidenceId`/`proxyId` must exist in the context under `validateComposerReferences` (`lib/stella/schemas/composer-numeric-guard.ts`, wiring per `lib/stella/schemas/WIRING.md`). A hallucinated figure or fabricated citation rejects the draft. |
| Failure modes | Common codes; guard violations surface as `PARSE_ERROR` (or a dedicated integrity code per WIRING.md). |

## 4–6. Reviewer roles (`proxy_reviewer`, `evidence_reviewer`, `audit_assistant`)

Shared machinery: action `app/actions/stella/reviewer.ts` (`getStellaReviewer(projectId, role)`),
context `buildReviewerContext(projectId, organizationId, role?)`, prompts
`buildReviewerSystemPrompt` / `buildReviewerUserMessage`, output `ReviewerOutputSchema`
**v`1.0.0`** (`REVIEWER_OUTPUT_SCHEMA_VERSION`): `summary`, `risk_level` (`low\|medium\|high`),
`findings[]`, `recommendations[]`, `requires_human_review: literal(true)`.

The prompt↔context mapping is formalized in `REVIEWER_PROMPT_FIELD_CONTRACT`
(`lib/stella/prompts/reviewer-system.ts`) and enforced by `reviewer-system.test.ts`:
**a mandate may only mention data its role's payload serializes.**

### 4. `proxy_reviewer` — Revisor de Proxies

| Aspect | Contract |
|---|---|
| Purpose | Flags proxy source verifiability, reference-year, approval-status, confidence/risk, outcome-appropriateness and over-claiming issues for a human reviewer. |
| Flag | `STELLA_ENABLED` + `STELLA_PROXY_REVIEWER_ENABLED` |
| Inputs | Base `StellaProjectContext` **plus** `proxyDetails[]`: `name`, `value`, `currency`, `sourceName`, `sourceUrlDomain` (**hostname only — full URLs never sent**), `referenceYear`, `approvalStatus` (`financial_proxies.review_status`), `confidenceLevel`, `methodologicalRisk`, `outcomeId` + `outcomeTitle` (the assigned outcome — grounds appropriateness claims; title sanitized, never descriptions/justifications); plus adjustment filters. Org-scoped through active `outcome_proxy_assignments`. Injection-bearing proxy/source/outcome names collapse to fixed placeholders (`[Proxy]`/`[Fuente]`/`[Outcome]`). |
| Invariants | Never proposes a different proxy value; never approves; `requires_human_review` always true. |

### 5. `evidence_reviewer` — Revisor de Evidencia

| Aspect | Contract |
|---|---|
| Purpose | Flags evidence integrity, confidence, linkage, coverage and status issues. |
| Flag | `STELLA_ENABLED` + `STELLA_EVIDENCE_REVIEWER_ENABLED` |
| Inputs | Base context **plus** `evidenceDetails[]`: `title`, `type`, `status`, `integrityVerified`, `integrityVerifiedAt`, `confidenceScore`, `outcomeId`/`indicatorId` linkage, `relatedOutcomeTitle` (sanitized linked-outcome title, null when unlinked — grounds per-outcome coverage claims), `createdAt`. No `filePath`, no raw content, titles injection-filtered. |
| Invariants | Never changes evidence status; flags only. |

### 6. `audit_assistant` — Asistente de Auditoría

| Aspect | Contract |
|---|---|
| Purpose | Overall audit-readiness assessment: trail completeness, consistency, prioritized gaps. |
| Flag | `STELLA_ENABLED` + `STELLA_AUDIT_ASSISTANT_ENABLED` |
| Inputs | Base context (incl. calculation snapshot; `readinessScore` is structurally present on the shared context type but no builder populates it — absent, not legacy) **plus** `runReviewSummary`: `reviewCount`, `latestStatus`, `latestReviewedAt` from `sroi_run_reviews`; **plus** `narrativeSummary` in the payload (sanitized + PII-redacted upstream) — grounds the narrative-consistency mandate. FIBIU-17 (W2-B5): `latestReadinessScore` was removed from `runReviewSummary` — canonical readiness is system-computed (`getReadinessAssessment` / `sroi_readiness_assessments`), the legacy `sroi_run_reviews.readiness_score` column is LEGACY_NON_AUTHORITATIVE, and this context no longer reads it. |
| Invariants | Never declares the analysis audit-ready; consumes no readiness score of any kind — canonical readiness is reported to reviewers elsewhere (the run detail page), never through this context. |

Reviewer failure modes: common codes only (see §0.6); context builder errors map to `UNAUTHORIZED`.

## 7. Versioning policy

- Each versioned schema file exports a `*_SCHEMA_VERSION` semver const, starting at `1.0.0`.
- `lib/stella/schemas/schema-versions.test.ts` pins the exact sorted key list per schema (plus the
  nested reference shapes for the Composer AND the decision-carrying enum vocabularies:
  `risk_level`, `responseType`, finding `severity`, advisor `step`). Any key-set or pinned-enum
  change fails that test until the author bumps the version, updates the pin, and updates this
  document — the three move together. Other type-level changes (e.g. widening a plain string
  field) are not machine-pinned and still require reviewer discipline.
- Bump rules: PATCH = descriptions/doc only; MINOR = optional, backward-compatible additions;
  MAJOR = key removal/rename, type change, or invariant change.
- `scripts/eval-roles-offline.ts` additionally gates that the exported versions match the versions
  declared in this document (`1.0.0` across the board for v1).

## 8. Wiring notes for the coordinator (not applied by WS6)

1. **package.json** — add the eval script entry (WS6 must not edit package.json):
   `"eval:roles": "tsx scripts/eval-roles-offline.ts"`
2. **app/actions/stella/reviewer.ts:87** — pass the role for per-role data minimization:
   `const context = await buildReviewerContext(projectId, ctx.organization.id, role)`
   (backward compatible: with two arguments the builder returns the full superset).
