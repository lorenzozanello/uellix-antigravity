# G4 Package — Stella Role Rollout (Validator → Advisor → Composer → Reviewers)

- **Gate:** G4 — production enablement plan for the Stella roles after WS6 (Roles & Evaluation).
- **Human owner / approver:** Lorenzo Zanello. No agent may set the Vercel flags or approve a
  role's enablement; only the human owner does.
- **Prepared by:** WS6 (branch `moonshot/ws6-roles-eval`).
- **Status:** READY FOR HUMAN DECISION. No flag was changed by WS6; everything below is
  documentation plus offline verification.
- **Contracts:** `docs/20_STELLA_ROLE_CONTRACTS.md` (schema versions pinned at `1.0.0`).

---

## 1. Scope and non-negotiables

Enable the six Stella roles in Production **one at a time**, in this order:

1. `validator` (`STELLA_VALIDATOR_ENABLED`)
2. `advisor` (`STELLA_ADVISOR_ENABLED`)
3. `composer` (`STELLA_COMPOSER_ENABLED`)
4. `proxy_reviewer` (`STELLA_PROXY_REVIEWER_ENABLED`)
5. `evidence_reviewer` (`STELLA_EVIDENCE_REVIEWER_ENABLED`)
6. `audit_assistant` (`STELLA_AUDIT_ASSISTANT_ENABLED`)

Rationale for the order: the validator is read-only analysis over the calculation step with the
narrowest surface; the advisor adds the contextual transport (needs G1); the composer adds draft
generation with numeric/reference guards; the reviewers are the newest roles and go last, one per
observation window.

**Non-negotiables (hold at every step):**

- **Single-role-at-a-time:** never flip two role flags in the same observation window. If a role
  misbehaves you must know which one.
- **Observation window:** minimum **72 h** (or ≥ 20 real interactions of that role, whichever is
  later) between enabling one role and the next.
- **Rollback = flag off.** Every role is fully disabled by removing/false-ing its env var and
  redeploying. No data migration, no code change: the actions return `DISABLED` immediately.
- **Quotas stay authoritative:** organizations start at quota 0 (blocked) regardless of flags;
  enablement per organization continues through `/admin/services`.
- `requires_human_review` remains hardcoded `true` for validator and all reviewer roles; the
  composer output remains a **draft** that is never persisted automatically.

## 2. Global preconditions (before ANY role is enabled)

| # | Precondition | How to verify |
|---|--------------|---------------|
| P1 | `pnpm typecheck` passes on the candidate commit | exit code 0 |
| P2 | `pnpm test:unit` passes | exit code 0 |
| P3 | `pnpm eval:offline` prints `6/6 gates passed`, exit 0 | advisor offline gate |
| P4 | `pnpm eval:roles` (= `pnpm tsx scripts/eval-roles-offline.ts`) prints `5/5 gates passed`, exit 0 | role offline gate (this wave) |
| P5 | Contract versions in `docs/20_STELLA_ROLE_CONTRACTS.md` match the exported `*_SCHEMA_VERSION` consts | Gate 4 of `eval:roles` |
| P6 | A valid, non-leaked `GEMINI_API_KEY` is configured in Vercel (rotated 2026-07-10 after the leak incident; see `docs/ops/runbooks/STELLA_INCIDENTS.md`) | owner attestation |
| P7 | `STELLA_ENABLED=true` plus rate limit (`STELLA_RATE_LIMIT_PER_HOUR`) and quotas configured | Vercel envs |

## 3. Per-role preconditions and enablement steps

For each role, in Vercel: **Preview first**, observe one window, then Production. Set the flag →
redeploy → verify with a real project of the internal test org (quota assigned).

| Role | Flag | Extra preconditions beyond §2 |
|------|------|-------------------------------|
| validator | `STELLA_VALIDATOR_ENABLED` | none (narrowest surface; already exercised in Preview since Fase 5) |
| advisor | `STELLA_ADVISOR_ENABLED` | **G1 real-provider evaluation approved** (`docs/ops/gates/G1_PACKAGE.md` sign-off) — the offline gates alone do NOT clear the contextual advisor |
| composer | `STELLA_COMPOSER_ENABLED` | numeric/reference guard wired into the composer action per `lib/stella/schemas/WIRING.md` (coordinator item) and its action tests green |
| proxy_reviewer | `STELLA_PROXY_REVIEWER_ENABLED` | reviewer action passes the role to `buildReviewerContext` (wiring note, `docs/20_STELLA_ROLE_CONTRACTS.md` §8) or knowingly accepts the superset context; `eval:roles` green on the deployed commit |
| evidence_reviewer | `STELLA_EVIDENCE_REVIEWER_ENABLED` | previous reviewer role stable through a full observation window |
| audit_assistant | `STELLA_AUDIT_ASSISTANT_ENABLED` | previous reviewer role stable through a full observation window |

## 4. Metrics to watch during each observation window

Sources: `/admin/services` (per-org monthly usage from `stella_interactions`) plus direct
`stella_interactions` queries and Vercel/Sentry logs (`[stella]` prefix, key redacted).

- **Volume:** interactions per day for the newly enabled `stella_role` (from
  `stella_interactions.stella_role`) — expect a ramp, investigate spikes (rate limit is the
  backstop, `STELLA_RATE_LIMIT_PER_HOUR`).
- **Error mix:** rate of `PARSE_ERROR`, `GEMINI_ERROR`, `TIMEOUT`, `PAYLOAD_TOO_LARGE` responses
  in server logs. Threshold: > 10 % of the role's calls over a window ⇒ turn the flag off.
- **Risk profile:** distribution of `risk_level` and `risk_flags` on the role's interactions — a
  role returning ~100 % `low` with empty findings on real projects suggests a prompt/context
  regression, not healthy data.
- **Quota consumption:** `usedThisMonth` per org in `/admin/services` — reviewer roles share the
  same quota pool as the other roles; watch orgs burning quota unexpectedly fast.
- **Integrity guard hits (composer):** guard-rejected drafts logged server-side; any hit is worth
  reading, a cluster ⇒ flag off.
- **Human feedback:** any report of certification-style language, invented figures/ids, or non-
  Spanish output ⇒ immediate flag off + capture the interaction row for the eval catalog.

## 5. Rollback

Per role: set its env var to `false` (or remove it) in Vercel → redeploy → the role's server
action short-circuits to `DISABLED`. No DB rollback ever needed (all roles are read-only; audit
rows in `stella_interactions` are historical records and stay). If the incident involves the
provider or the key, follow `docs/ops/runbooks/STELLA_INCIDENTS.md` (key rotation runbook).

## 6. Reformulation — explicitly out of this wave

`responseType: 'reformulation'` exists in the contextual advisor schema but is
**UNIMPLEMENTED end-to-end (declarative only)**: there is no product `userQuestion` channel
through which a user could request a reformulation, and no UI renders one. WS6 deliberately did
NOT implement it — it requires a product decision on the userQuestion channel (input recorded
here for `docs/ops/STELLA_FABLE_DECISIONS.md`; that file is coordinator-owned). Until that
decision, no rollout step in this package enables or depends on reformulation.

## 7. Verification record (WS6, offline — run on the WS6 worktree)

```
[eval:roles] PASS roles-catalog-structure — 14 cases — validator:4, composer:4, proxy_reviewer:2, evidence_reviewer:3, audit_assistant:1
[eval:roles] PASS roles-all-cases-pass — summary={...,"casesPassed":14,"casesFailed":0,"canaryCases":5,"canariesRejected":5,"providerCalls":0,"geminiCalls":0}
[eval:roles] PASS roles-canaries-all-rejected — roles-composer-hallucinated-figures→composer-figures, roles-canary-reviewer-certification-language→safety, roles-canary-reviewer-human-review-false→schema, roles-canary-composer-hallucinated-id→composer-references, roles-canary-validator-numeric-claim→numeric-integrity
[eval:roles] PASS roles-contract-versions — validator=1.0.0 composer=1.0.0 reviewer=1.0.0
[eval:roles] PASS roles-fixture-grounded-deterministic — households=120 testimonios=4 confidence=52
[eval:roles] 5/5 gates passed
[eval:roles] OK — 14/14 role cases pass, 5/5 canaries rejected, contract versions consistent
```

## 8. Sign-off

| Role enabled | Date | Window result (STABLE / ROLLED BACK) | Owner initials |
|--------------|------|--------------------------------------|----------------|
| validator | ______ | ______ | ______ |
| advisor (post-G1) | ______ | ______ | ______ |
| composer | ______ | ______ | ______ |
| proxy_reviewer | ______ | ______ | ______ |
| evidence_reviewer | ______ | ______ | ______ |
| audit_assistant | ______ | ______ | ______ |
