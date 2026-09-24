---
name: uellix-long-run
description: "Orchestrates a long-running Uellix mission end to end without stopping for status updates: preflight, DONE definition, RUN_STATE, optional read-only fan-out, implementation/audit, tests, gates, bounded local fix, commit/push only when the mission authorizes it, terminal CI, then DONE or a genuine STOP. Composes uellix-preflight, uellix-test-manifest, uellix-mission-loop and uellix-focused-reaudit rather than restating them. Use when a mission is multi-step, spans commit/push/CI, or is expected to outlive one context window."
---

# Uellix Long-Run

Orchestration only. Path class authorized by
`docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.39.json`. Shared rules:
`docs/ops/ods/UELLIX_DEV_OS_OPERATING_MODEL_v1.0.0.md`. Long-run detail
(stops, push, subagents, inheritance, RUN_STATE, report, durable sources):
`docs/ops/ods/ODS_LONG_RUN_OPERATING_STANDARD_v1.1.0.md`. This skill adds no
authority and never outputs a closure token (operating model §4).

```status_vocabulary
PASS
FAIL
BLOCKED
INSUFFICIENT_EVIDENCE
DONE
STOP
```

`DONE` = every `done_when` item met with evidence. `STOP` names its reason.
The minimum stop set is `OWNER_DECISION`, `AUTHORITY_CONTRADICTION`,
`SCOPE_EXPANSION`, `BOUNDARY_CONFIRMATION`, `DRIFT`, `GATE_FAILURE`,
`EXHAUSTED` — NOT a closed list: UNKNOWN/ambiguity, secret exposure,
authority failure, `MAX_CYCLES` and every `uellix-mission-loop` stop also
stop. Progress is never a stop; safety rules always are.

## Mission model

```
1 PREFLIGHT   uellix-preflight (or ods:prestate + exact authority read);
              prestate mismatch -> STOP DRIFT
2 DONE        write done_when as checkable items before any write; record
              whether the mission authorizes commit and push
3 RUN_STATE   root = `pnpm ops:closure-state -- run-state-root` (non-git,
              verified; none -> STOP); resume = re-measure, then
              `run-state --file <f> --repo . --lane --role --branch --base`
              (full identity, never HEAD alone)
4 FAN-OUT     optional read-only investigators for genuinely parallel reads;
              the parent re-verifies every material claim; more than one
              writer only if the MISSION authorizes it (disjoint worktrees,
              disjoint write sets, integration order)
5 WORK        implementation -> uellix-test-manifest, then
              uellix-mission-loop (one node per loop);
              audit -> uellix-focused-reaudit (never on own writes)
6 TESTS       focused tests incl. negative controls
7 GATES       ods:scope, ods:poststate, authority:seal:verify, and
              ops:closure-state when the projection changed
8 LOCAL FIX   bounded, in scope; same failure twice -> STOP GATE_FAILURE
9 COMMIT/PUSH only if step 2 recorded explicit authorization; a push
              creates a Vercel Preview deployment (a provider event that
              can invalidate evidence windows / event-bound predicates) —
              check first, else STOP BOUNDARY_CONFIRMATION
10 CI         poll exact-head CI/Vercel to a terminal state
11 END        DONE, or STOP with the named reason
```

Update RUN_STATE after every step (atomic write, single writer). Never
pause between steps to report progress, offer to continue, or re-ask for
an already-authorized step.

## Closure projection

When the mission changes a CV1 closure fact, append a revision to
`docs/ops/ods/CV1_CLOSURE_STATE.json` (revision + 1) and run
`pnpm ops:closure-state -- validate --previous-ref <base> --verify-git`. Never
erase evidence, findings, invalidators or history; a fired invalidator never
unfires. Chat, memory or RUN_STATE facts are UNCONFIRMED context only. A lane
never promotes its own work past `AUTHORED`: certification comes from an
independent reviewer's repository record, CLOSED from a repository-recorded
owner decision.

## Final report

`CLAUDE.md` §10 order: NEEDS_FROM_OWNER first (`NONE` if empty), RESULT,
DONE, EVIDENCE, UNCONFIRMED (fact / searched / status / why_unconfirmed /
impact / next_evidence_required), RISKS / OPEN FINDINGS, NEXT AUTHORIZED
ACTION.

## Never

- Stop for a status update, or leave CI "pending".
- Push because the loop reached step 9 without explicit authorization.
- Let a subagent write without mission authorization, decide for the owner, or certify.
- Re-derive an inherited certified fact whose invalidators have not fired.
- Treat RUN_STATE as evidence, keep it inside a git repository, or commit it.
