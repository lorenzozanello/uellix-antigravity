# B1.1C — Model Quality Remediation Closure Report

**Decision:** `B1_1C_APPROVED_WITH_RESERVATIONS`
**Date:** 2026-07-31
**Branch:** `codex/integrate-stella-b1c-model-quality-remediation`
**HEAD evaluated:** `1756beed271b8404b7bc7a8ec2cbda85231fa8f3`

---

## 1. Scope closed

B1.1C covers the **contextual advisor** path of Stella (`step: stakeholders | outcomes | narrative | indicators | evidence | proxies | calculation`) against the current architecture on this branch — the request/response contract, the source-reference protocol, the fail-closed decoding layer, and the transactional real-model evaluation harness.

This closure certifies that the current architecture, evaluated end to end against the real Gemini provider, produces contextual advisor output that a human reviewer can accept with recorded, non-blocking reservations. It does **not** close any other Stella surface (Validator, Composer, reviewer roles) and does not extend to any pipeline step outside the seven listed above.

**Precise status — read literally, do not extrapolate:**

- B1.1C is **approved with reservations**.
- Stella is **not** declared complete.
- Stella is **not** declared ready for full commercial production.
- No certification was automated; certification of impact remains explicitly outside Stella's role in every evaluated case.
- No methodological validation is declared definitive; `requiresHumanReview = true` holds on all 28 evaluated cases.
- No other Stella phase is declared closed by this document.

---

## 2. Architecture implemented

| Concern | Implementation |
|---|---|
| **Provider-facing citation protocol** | `sourceRefIndexes`: the provider cites integers indexing into a per-request `SOURCE_REFERENCE_INDEXES` list built fresh for each call. The provider never sees field names, aliases, or canonical paths — only positions. |
| **Internal citation protocol** | `sourceFields`: once decoded, indexes are resolved back to canonical dotted/bracket paths (`sourceFields`) for storage and downstream validation. The two protocols are deliberately distinct so a provider response can never smuggle an internal path string past validation. |
| **Request-local canonical catalog** | `collectCanonicalSourceFieldPaths` ([lib/stella/context/canonical-source-field-paths.ts](../../lib/stella/context/canonical-source-field-paths.ts)) walks the frozen, deep-cloned request context to its concrete leaves and builds the index-to-path table used both to render the prompt and to validate the response. Built fresh per request; never reused across requests. |
| **Fail-closed decoding** | `decode-provider-source-ref-indexes.ts` rejects any response that references an index outside the current request's catalog, rather than attempting best-effort recovery. |
| **Trusted step from the request** | `1756beed2` (`fix(stella): trust requested advisor step metadata`) makes the runner treat the step of the *request*, not the provider's echoed `step` field, as authoritative. `26b7733` (`fix(stella-eval): canonicalize trusted contextual step metadata`) canonicalizes that trust at the evaluation-harness layer. A provider mismatch (see §3) is recorded as a metric, not corrected by trusting the provider. |
| **Raw preservation** | `raw-responses.json` stores the untouched provider payload per case, separately from `decoded-results.json`. Decoding never mutates or discards the raw record. |
| **`providerStepMismatches`** | A dedicated counter in `run-manifest.json` / `summary.json` tracks cases where the provider's own `step` field disagrees with the requested step, independent of whether decoding still succeeded. |
| **Transactional checkpoints** | `725e49b` (`add transactional multi-artifact checkpoints`) and `8f7244f` (`enable guarded transactional resume`) make each of the five run artifacts (`run-state.json`, `summary.json`, `raw-responses.json`, `decoded-results.json`, `errors.json`) advance together under one checkpoint sequence, so a partial write cannot leave the artifact set internally inconsistent. |
| **Hashes** | Every completed run and every review/gate package carries its own `hashes.json` — SHA-256 per file, computed once at `FINAL` status. Integrity is re-verified read-only at every downstream step (review, gate) by recomputing and comparing, never by re-trusting a prior computation. |
| **Mandatory human review** | `AdvisorContextualOutputSchema` enforces `requiresHumanReview: z.literal(true)` at the schema level — the provider cannot emit a response that skips it. Automated `canonicalValidation` / `safety` / `schemaContract` / `numericIntegrity` controls run on every case, but gate eligibility additionally requires a completed human review pass; see §4 and the Limitation in §5. |

---

## 3. Validation evidence

### 3.1 Core commits (chronological, this branch)

| Commit | Summary |
|---|---|
| `8ebb530` | feat(stella): add contextual advisor foundations |
| `9ef934e` | fix(stella): enforce immutable contextual source contract |
| `45f50be` | fix(stella): transport contextual citations as source indexes |
| `493ceca` | test(stella-eval): add current-architecture contextual mock harness |
| `b5dee89` | test(stella-eval): add guarded contextual real runner |
| `ef654f3` | fix(stella-eval): wire per-case states into runner loop |
| `725e49b` | fix(stella-eval): add transactional multi-artifact checkpoints |
| `8f7244f` | fix(stella-eval): enable guarded transactional resume |
| `26b7733` | fix(stella-eval): canonicalize trusted contextual step metadata |
| `1756bee` | fix(stella): trust requested advisor step metadata *(HEAD)* |

### 3.2 Real-model evaluation runs (chronological)

All runs use `providerMode: paid_gemini`, `model: gemini-2.5-flash`, against `caseCatalogHash: 1402627b529e5e0cd10b2db673325e66cb41c1e4ee5b86c98d56383a11f3f768` (the 28 official cases in [tests/eval/stella-contextual/cases.ts](../../tests/eval/stella-contextual/cases.ts)).

| Run | Run ID | Scope | Status | Notes |
|---|---|---|---|---|
| `b1c-current-architecture-canary-2026-07-30T21-39-31-252Z` | `d1ecbb86-dc80-4846-b830-e1d4f713f440` | canary, 4 cases | `COMPLETED_PENDING_HUMAN_REVIEW` | Focused canary preceding the first full attempt |
| `b1c-current-architecture-full-2026-07-30T22-04-37-099Z` | `bd549f4c-4875-425a-b28b-c620200c9c07` | full, 28 cases | `FAILED` (9/28 processed, 1 schema-invalid) | Superseded; not reviewed |
| `b1c-narrative-incomplete-retest-2026-07-30T23-32-00-520Z` | `8d68adee-be8b-411e-9891-e383efbc2356` | canary, 1 case | `COMPLETED_PENDING_HUMAN_REVIEW` | Targeted single-case retest following the step-metadata fixes |
| `b1c-current-architecture-full-after-step-fix-2026-07-30T23-38-15-764Z` | `de07ce62-175e-4393-bf9b-b381d87c13a3` | full, 28 cases | `COMPLETED_PENDING_HUMAN_REVIEW` (28/28) | Interim full rerun; superseded by the canonical run below, not reviewed |
| **`b1c-current-architecture-full-after-step-fix-2026-07-30T23-40-15-172Z`** | **`02396159-4f9b-4ecb-97de-4cacef8b8caa`** | **full, 28 cases** | **`COMPLETED_PENDING_HUMAN_REVIEW` (28/28) → reviewed → gated** | **Canonical run for this closure** |

Only the canonical run underwent human review and gate evaluation. No provider call was made to produce this closure document; all evidence above was already on disk from prior evaluation sessions.

### 3.3 Canonical run — deterministic metrics

- Processed: 28/28, failed: 0, schema-invalid: 0, errors.json: empty
- `internalCanonicalDecodingCases`: 28/28
- `requiresHumanReviewCases`: 28/28
- `providerStepMismatches`: 1 (`b1c-outcomes-adversarial` — provider returned the Spanish `displayLabel` `"Resultados"` instead of the enum `outcomes`; neutralized by the trusted-request-step design in §2, not by trusting the provider)

### 3.4 Human review

- Review package: `artifacts/stella-contextual-real-reviews/b1c-current-architecture-full-after-step-fix-2026-07-30T23-40-15-172Z/`
- Reviewed: 28/28 · Accepted: 14 · Accepted with reservation: 14 · Rejected: 0
- Groundedness — 0/1/2: 0 / 1 / 27 (average 1.9643)
- Usefulness — 0/1/2: 0 / 4 / 24 (average 1.8571)
- Role-boundary failures: 0 · Numeric-integrity failures: 0 · Adversarial failures: 0 (7/7 adversarial cases held) · Uncertainty-handling failures: 1
- Reference-quality failures: 14 (0 materially false)
- Full narrative: [HUMAN_REVIEW_REPORT.md](../../artifacts/stella-contextual-real-reviews/b1c-current-architecture-full-after-step-fix-2026-07-30T23-40-15-172Z/HUMAN_REVIEW_REPORT.md)

### 3.5 Gate

- Gate package: `artifacts/stella-contextual-real-gates/b1c-current-architecture-full-after-step-fix-2026-07-30T23-40-15-172Z/`
- Gate ID: `4d285a79-b50a-4c93-9dd6-c98838c53c35`
- Decision: `B1_1C_APPROVED_WITH_RESERVATIONS`
- Preflight: 19/19 checks passed (17 required + 2 boundary/drift guards)
- Full narrative: [B1C_FINAL_GATE_REPORT.md](../../artifacts/stella-contextual-real-gates/b1c-current-architecture-full-after-step-fix-2026-07-30T23-40-15-172Z/B1C_FINAL_GATE_REPORT.md)

### 3.6 Integrity hashes (SHA-256, recomputed and matched at every stage)

**Source run**

| File | Hash |
|---|---|
| `run-state.json` | `d2d8ad0a1fb3ac06518589270be2cba99fa2bbc2609dd41d391fd6335e0a1d89` |
| `summary.json` | `71b817bc3c190030a4782ae2796cc433c77311adf3e91cbda95e51cd3801d126` |
| `raw-responses.json` | `3850246052d9324f304ce13413f2fcfbbaac940cdac8ee10c7d30fac86b65ded` |
| `decoded-results.json` | `87231354d81402063efb97b5f0f46db9b261a22a0087f2d5e51b44812db9e779` |
| `errors.json` | `01cb3923132e5755dc395b73d479c23936466ee3bc59935406051f01ab3c8cbe` |

**Human review package**

| File | Hash |
|---|---|
| `review-matrix.json` | `0f96e47c8a7f8292849b2649beb06396b16f0c21f682abf2d25046418fa2b636` |
| `review-matrix.csv` | `d4cf6ef274e1dd5b330fc53a13682c4a5ddddd64b38e8cabe08517beeb21132c` |
| `review-summary.json` | `6f4b4446c02d7bd8d6554f09668ef53a2dc19161eb39b473bf3fa963b441ded2` |
| `HUMAN_REVIEW_REPORT.md` | `740b54a39932762207469bd5c60d1c0b627f9e8199b3b4020372bd778333aeee` |

**Gate package**

| File | Hash |
|---|---|
| `gate-decision.json` | `e5637a1144e916c53ae7d25c8bcd603d4dc78eb2fec6dbfff570b78ddc9b98f0` |
| `gate-summary.json` | `cae5e0226eeb7833a2056cd068d3eabf2c4e2ab12388325ab2a2c1600bee0af9` |
| `gate-reservations.json` | `47b1aaebb7da795249595ff2b89f63b26a0620e09cd2dcee8d57933bf072f080` |
| `B1C_FINAL_GATE_REPORT.md` | `c896b091262e024c4dcfa5dce06658c3de19839a2e82b112399b5f164db710cc` |

---

## 4. Gate limitation — no automated executor

**There is no executable B1.1C gate in this repository.** This was confirmed by exhaustive search: no gate script, no gate test, no gate entry in `package.json`, no occurrence of `B1_1C`, `gateDecision`, `runGate` or `evaluateGate` outside the artifacts tree.

This is by design, not an oversight. `RealRunnerSummary` in [tests/eval/stella-contextual-real/types.ts](../../tests/eval/stella-contextual-real/types.ts) pins `eligibleForGate` to the **literal type** `false` and `humanReviewStatus` to the **literal type** `'NOT_STARTED'`. The runner cannot emit gate approval — doing so would not type-check. The runner produces evidence; a human produces the review; the gate decision in §3.5 records that human decision, backed by mechanically re-verified hashes and case-identity checks, in its own artifact package.

**Consequently:** the `B1_1C_APPROVED_WITH_RESERVATIONS` decision in this document was **not** produced by running an automated gate script. It is a human decision, made out-of-band from any runner code, and verifiable after the fact by anyone with access to this repository through the source run, review package, gate package and the hashes in §3.6 — without needing to trust the person who made the decision.

Building a reproducible, self-verifying gate executor that consumes a run + review pair and cannot be self-approved by the runner is tracked as **`B1C-GATE-AUTOMATION`** in the backlog (§6). It does not block this closure.

---

## 5. Reservations

Six reservations were recorded during human review, none of which blocks this closure. Full mechanism, code references and per-case evidence are in [gate-reservations.json](../../artifacts/stella-contextual-real-gates/b1c-current-architecture-full-after-step-fix-2026-07-30T23-40-15-172Z/gate-reservations.json).

| ID | Title | Priority | Blocks B1.1C | Blocks commercial production |
|---|---|---|---|---|
| **R1** | Empty-collection citation gap | P1 | No | **Yes** |
| **R2** | Reference relevance gap | P1 | No | **Yes** |
| **R3** | Over-broad source catalog | P2 | No | No |
| **R4** | Internal reference index leakage | P1 | No | **Yes** |
| **R5** | Incomplete complete-fixtures | P1 | No | **Yes** |
| **R6** | Conditional certification refusal | P2 | No | No |

**Production condition:** R1, R2, R4 and R5 must be resolved before declaring the audit-ready contextual advisor experience ready for commercial production. R3 and R6 remain as quality-backlog items and do not gate a production declaration on their own.

One-line summaries (full detail in §6 and in `gate-reservations.json`):

- **R1** — empty arrays visible to the model (e.g. `proxySummary: []`) produce no citable canonical path, forcing either `sourceFields: []` on a factual claim or a substitute citation.
- **R2** — automated `canonicalValidation` proves an index exists in the catalog, never that it is the *right* index for the claim it supports.
- **R3** — all seven advisor steps receive the same request catalog; the catalog is not filtered by step.
- **R4** — internal `sourceRefIndexes` tokens leaked into three user-facing text fields, in one case reading as a parenthetical `(0)`.
- **R5** — the `complete` fixture variant for indicators, evidence, proxies and calculation is not actually complete; it duplicates the `incomplete` variant's empty collections.
- **R6** — one of seven adversarial cases (`b1c-outcomes-adversarial`) conditions certification refusal on data completeness instead of stating it as categorically outside Stella's role; no adversarial case executed the injected instruction.

---

## 6. Backlog

See [docs/12_BACKLOG.md — Stella: seguimiento de calidad B1.1C](../12_BACKLOG.md) for the trackable entries (R1–R6 and `B1C-GATE-AUTOMATION`), each with problem, evidence, impact, acceptance criterion, blocking status, dependency and recommended phase.

---

## 7. References

| Item | Path / ID |
|---|---|
| Source run | `artifacts/stella-contextual-real-runs/b1c-current-architecture-full-after-step-fix-2026-07-30T23-40-15-172Z/` |
| Run ID | `02396159-4f9b-4ecb-97de-4cacef8b8caa` |
| Review package | `artifacts/stella-contextual-real-reviews/b1c-current-architecture-full-after-step-fix-2026-07-30T23-40-15-172Z/` |
| Gate package | `artifacts/stella-contextual-real-gates/b1c-current-architecture-full-after-step-fix-2026-07-30T23-40-15-172Z/` |
| Gate ID | `4d285a79-b50a-4c93-9dd6-c98838c53c35` |
| Official case catalog | `tests/eval/stella-contextual/cases.ts` |
| Canonical source-field paths | `lib/stella/context/canonical-source-field-paths.ts` |
| Step contracts | `lib/stella/advisor/step-contracts.ts` |
| Contextual system prompt | `lib/stella/prompts/advisor-contextual-system.ts` |
| Contextual output schema | `lib/stella/schemas/advisor-contextual-output.ts` |
| Real evaluation runner | `tests/eval/stella-contextual-real/runner.ts` |

**Note on a related branch:** an earlier, narrower closure of the same B1.1C effort exists on a sibling branch (`codex/stella-b1c-model-quality-remediation`, commit `a57a407`), evaluated at HEAD `73153c3` before the step-metadata fixes in §3.1 landed, against a different run (`1b753c1e-0d94-4cc7-972f-e506e5ba8041`) with different metrics (average groundedness 1.71, 8 groundedness-reservation cases). That closure is not part of this branch's history and is superseded here by a run evaluated against a later HEAD with a dedicated review and gate package structure. Reconciling the two closures, if both branches are merged, is out of scope for this document.

---

**Document prepared:** 2026-07-31
**Status:** CLOSED — approved with reservations
**Next step:** PR audit preparation (this branch). No push, no PR opened by this document.
