---
name: uellix-long-run
description: "Orchestrates a long-running Uellix mission end to end without stopping for status updates: preflight, DONE definition, RUN_STATE, optional read-only fan-out, implementation/audit, tests, gates, bounded local fix, terminal CI, then DONE or a genuine STOP. Composes uellix-preflight, uellix-test-manifest, uellix-mission-loop and uellix-focused-reaudit rather than restating them. Use when a mission is multi-step, spans commit/push/CI, or is expected to outlive one context window."
---

# Uellix Long-Run

Orchestration only. Shared rules: `docs/ops/ods/UELLIX_DEV_OS_OPERATING_MODEL_v1.0.0.md`.
Long-run detail (stop set, subagents, inheritance, RUN_STATE, report):
`docs/ops/ods/ODS_LONG_RUN_OPERATING_STANDARD_v1.0.0.md`. This skill
adds no authority and never outputs a closure token (operating model §4).

```status_vocabulary
PASS
FAIL
BLOCKED
INSUFFICIENT_EVIDENCE
DONE
STOP
```

`DONE` = every `done_when` item met with evidence. `STOP` = one member of
the closed stop set, named: `OWNER_DECISION`, `AUTHORITY_CONTRADICTION`,
`SCOPE_EXPANSION`, `BOUNDARY_CONFIRMATION`, `DRIFT`, `GATE_FAILURE`,
`EXHAUSTED`.

## Mission model

```
1 PREFLIGHT     uellix-preflight (or ods:prestate + exact authority read);
                prestate mismatch -> STOP DRIFT
2 DONE          write done_when as checkable items before any write
3 RUN_STATE     create/resume %TEMP%\uellix-runs\<LANE>\RUN_STATE.json;
                resume = re-measure HEAD first
                (pnpm ops:closure-state -- run-state --file <f> --repo .)
4 FAN-OUT       optional: read-only investigators for genuinely parallel
                reads; parent re-verifies every material claim
5 WORK          implementation -> uellix-test-manifest, then
                uellix-mission-loop (one node per loop);
                audit -> uellix-focused-reaudit (never on own writes)
6 TESTS         focused tests incl. negative controls
7 GATES         ods:scope, ods:poststate, authority:seal:verify,
                ops:closure-state -- validate when closure state changed
8 LOCAL FIX     bounded, in scope; same failure twice -> STOP GATE_FAILURE
9 CI            commit, push, poll exact-head CI/Vercel to a terminal state
10 END          DONE, or STOP with the named reason
```

Update RUN_STATE after every step (atomic write, single writer). Never
pause between steps to report progress, offer to continue, or re-ask for
an already-authorized step.

## Closure state

When the mission changes a CV1 closure fact, update
`docs/ops/ods/CV1_CLOSURE_STATE.json` (revision + 1) and run
`pnpm ops:closure-state -- validate --previous <prior copy> --verify-git`.
A lane never promotes its own work past `AUTHORED`; certification comes
from an independent reviewer and CLOSED from an owner decision.

## Final report

`CLAUDE.md` §10 order: NEEDS_FROM_OWNER first (`NONE` if empty), RESULT,
DONE, EVIDENCE, UNCONFIRMED (fact / searched / status / why_unconfirmed /
impact / next_evidence_required), RISKS / OPEN FINDINGS, NEXT AUTHORIZED
ACTION.

## Never

- Stop for a status update, or leave CI "pending".
- Let a subagent write, decide for the owner, or certify.
- Re-derive an inherited certified fact whose invalidators have not fired.
- Treat RUN_STATE as evidence or commit it.
