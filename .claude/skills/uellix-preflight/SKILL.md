---
name: uellix-preflight
description: "Read-only preflight for the next ODS mission node. Runs pnpm ops:program-state, pnpm ops:integration-plan, and pnpm audit:batch to ground a mission packet in measured facts before any implementation authority opens. Use before starting a new DAG node, before a remediation batch, or whenever a mission would otherwise restate long operational history from memory instead of measuring it. Never implements the next node itself."
---

# Uellix Preflight

Prepares the next mission node **read-only**. It measures; it never
implements. See `docs/ops/ods/UELLIX_DEV_OS_OPERATING_MODEL_v1.0.0.md` for
the shared rules this skill inherits (model routing, status vocabulary,
fact-vs-adjudication boundary) — read it once per session if not already
loaded.

## When to use

- Before starting a new DAG node in `uellix-mission-loop`.
- Before opening a remediation batch that depends on prior nodes being
  genuinely CLOSED (not merely absent from the current branch — see
  `docs/ops/ods/ODS_PROGRAM_STATE_REGISTRY_v1.0.0.json`'s own rationale).
- Whenever a prompt would otherwise ask Claude to reconstruct base/head/
  protected-file/failure facts from conversation history instead of
  measuring them.

## Skip

- Mid-implementation, once `READY_FOR_IMPLEMENTATION=YES` has already been
  reported for this exact node in this session — do not re-run preflight
  speculatively.
- Pure documentation or comment-only changes with no code/authority
  surface.

## Procedure

1. Identify the node/batch's declared unit id (if one exists in
   `docs/ops/ods/ODS_PROGRAM_STATE_REGISTRY_v1.0.0.json`), its base/head
   refs, and its target branch. If any of these is not yet known, that is
   itself a finding — do not guess a ref.
2. Where a program-state unit id is configured, run:
   `pnpm ops:program-state -- --unit <id> --json`
   Report `AUTHORITY_STATUS` / `IMPLEMENTATION_STATUS` / `AUDIT_STATUS` /
   `INTEGRATION_STATUS` / `PRODUCT_BINDING_STATUS` verbatim. Never read
   `NOT_INTEGRATED` as `NOT_IMPLEMENTED` — they are independent dimensions.
3. Where a source/target/base ref triple is known, run:
   `pnpm ops:integration-plan -- --source <ref> --target <ref> --base <ref> --target-branch <branch> --json`
   Report `PROTECTED_FILE_COUNT`, `CURRENT_PROTECTED_AUTHORITY_DISPOSITION`,
   and `SEMANTIC_REVIEW_REQUIRED_FILES` verbatim. A non-empty
   `SEMANTIC_REVIEW_REQUIRED_FILES` list is never waved through because
   Git could auto-merge it — that is exactly the case this tool exists to
   flag (see its own module docstring for the `sroi-calculation.ts`
   precedent).
4. For the fullest single packet, prefer:
   `pnpm audit:batch -- --base <ref> --head <ref> --target-branch <branch> [--authority <id>] --json`
   over running the three tools separately — `audit:batch` composes them
   and adds governance-gate facts (`TYPECHECK`, `SECRETS_SCAN`,
   `AUTHORITY_SEAL_VERIFY`, `ODS_SCOPE`, `ODS_POSTSTATE_RAW`) without
   reimplementing any of them.
5. Compose the mission packet: a compact, machine-grounded summary quoting
   the tools' own field names and values — never paraphrased into a new
   vocabulary, and never a number recomputed by hand.
6. Decide `READY_FOR_IMPLEMENTATION`.

## Output status vocabulary

```status_vocabulary
READY_FOR_IMPLEMENTATION=YES
READY_FOR_IMPLEMENTATION=CONDITIONAL
READY_FOR_IMPLEMENTATION=NO
BLOCKED
INSUFFICIENT_EVIDENCE
```

- `YES` — every consulted tool reported a clean/expected disposition for
  this node's own scope; no protected-authority violation; no unresolved
  `NEW_FAILURE`/`CHANGED_KNOWN_CONDITION` from a prior `ops:test-diff` run
  that touches this node.
- `CONDITIONAL` — implementation may begin, but ONLY after naming the
  exact preceding gate the condition is bound to, e.g.
  `READY_FOR_IMPLEMENTATION=CONDITIONAL (bound to: PROTECTED_AUTHORITY_DISPOSITION=WRONG_BRANCH must resolve to AUTHORIZED before touching db/migrations/**)`.
  A condition that does not name a specific gate is not a valid
  `CONDITIONAL` — escalate to `NO` or `INSUFFICIENT_EVIDENCE` instead.
- `NO` — a measured fact blocks implementation (protected violation,
  unresolved authority conflict, dirty/wrong-branch worktree).
- `BLOCKED` — a human/HPO decision is required before this node can be
  scoped at all.
- `INSUFFICIENT_EVIDENCE` — a required machine tool could not run or
  returned `UNKNOWN`/`UNREADABLE` for something this node's readiness
  depends on. Never round `INSUFFICIENT_EVIDENCE` up to `YES`.

## Never

- Never implement the node this preflight is scoping.
- Never invent a fact a tool didn't report (see the shared reference's
  fact-vs-adjudication section).
- Never touch `~/.claude/**` or any user-global Claude configuration.
