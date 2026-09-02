# ODS Context / Checkpoint Standard v1.0.0

Authority class: `DEVELOPMENT_PROCESS_STANDARD` (ODS-C6). References
`docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json`; does not modify it. Governs
report/handoff **form**, not decision content — it never re-adjudicates a
finding.

Purpose: replace repeated long handoff prompts with a compact,
repository-native checkpoint contract, so context is reconstructed from
exact references instead of pasted prose.

## Retrieval rule (frozen)

```
INDEX / MANIFEST FIRST → exact authority identifier → exact section/range
→ full authority only if the above is insufficient
```

A checkpoint references authority by path/identifier/SHA. It never pastes
long authority content — that defeats the compression the index exists to
provide. No hard token limit is set here; none has been measured yet.

## Level 1 — Task checkpoint

Use between ordinary implementation steps.

```
TASK_ID
RESULT                    one line: what changed / what was found
BASE_SHA
POSTSTATE_HEAD
POSTSTATE_TREE             (only when material — e.g. a commit landed)
BRANCH
WORKTREE
AUTHORITY_REFERENCES       path/identifier only, no pasted content
FILES_CHANGED
TESTS/GATES                which ran, PASS/FAIL, not full logs
OPEN_FINDINGS
NEXT_AUTHORIZED_ACTION
```

## Level 2 — Milestone handoff

Use for: wave closure, an authority freeze, a candidate/release, a
clean-room audit boundary, or a conversation handoff where major context
would otherwise be lost. Adds to Level 1:

```
MILESTONE_STATE
SEALED/CERTIFIED_ARTIFACT_REFERENCES
DEFERRED_FINDINGS
PROHIBITED_NEXT_ACTIONS
DEPENDENCY_STATE
NEXT_GATE
```

## Session rule

**Continue** the existing conversation when the work is the same
implementation lineage, under the same authority, and reusable context
materially reduces re-reading.

**Start a clean conversation** for a genuinely independent adversarial
audit, a new authority domain, or when prior context would materially
bias a review.

There is no blanket "new chat per task" rule.

## Subagent rule

Direct work is the default. Use a subagent only for a genuine parallel
DAG, clean-room isolation, or a validated recurring specialization — never
for a grep, a static check, or a small sequential task.

## Report format

```
RESULT
EVIDENCE
RISKS
NEXT ACTION
```

No ceremonial prose is required beyond this.

## Carry-forward findings

Deferred findings (e.g. MNB-1, BK-1..BK-4) live in their authoritative
milestone/closure record or an explicitly derived backlog document —
never only in conversation memory. This standard does not re-adjudicate
any of them; see `docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.wave1-closure.json`
for their current status.
