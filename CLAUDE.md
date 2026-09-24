# CLAUDE.md — Uellix/Stella development guidance

Compact operational workflow guidance. It summarizes HOW to work, evidenced
by the machine gates below. It does NOT supersede, restate, or duplicate
frozen FIB/PC-01B/IM-01B authority, HPO decisions, or repository evidence —
those remain controlling. See `docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json`.

## 1. Development authority

- **Claude Code Desktop/CLI** — authorized primary development executor (HPO-ODS-01).
- **Git/GitHub** — source of truth and version control.
- **Antigravity** — optional/scoped auxiliary tool only; never an authority anchor.
- **Google AI Studio** — not authorized as a development environment unless separately adjudicated.

## 2. Source-of-truth hierarchy

1. Sealed/frozen repository authority and certified artifacts (`docs/ops/fib/**`, `docs/ops/pc01b/**`, `docs/ops/im01b/**`).
2. Active HPO/addendum/process authority (`docs/ops/ods/**`).
3. Code, schema, tests, current repository state.
4. Checkpoints/handoffs (see `docs/ops/ods/ODS_CONTEXT_CHECKPOINT_STANDARD_v1.0.0.md`).
5. Conversation context.

A conflict between levels **fails closed**: stop and escalate rather than guess.

## 3. Authority retrieval order

Do not read full long-form authority by default — it costs ~100k tokens the
index form does not.

1. The compact index/manifest (`docs/ops/fib/*.index.json`, `*.manifest.json`).
2. The exact authority identifier/path the task names.
3. Only the required section/range of that file.
4. Full long-form authority only when the above is insufficient.

## 4. Standard governed workflow

```
prestate gate → retrieve exact authority → smallest authorized change
→ focused tests → scope/poststate gate → evidence-backed result
→ adversarial escalation only where materially useful
```

Commands (see each script's own header for what it does — not duplicated here):

```
pnpm ods:prestate -- --branch <b> --head <sha> --tree <sha> --clean
pnpm authority:seal:verify
pnpm ods:scope -- --base <sha> --allow <pattern> [--allow ...]
pnpm ods:poststate -- --base <sha> --allow <pattern> [--test <path>] [--clean]
pnpm ops:closure-state -- validate [--verify-git]   # CV1 closure state
```

Program closure status lives in `docs/ops/ods/CV1_CLOSURE_STATE.json`
(operational derived state, NOT authority; it points at evidence).

## 5. Fail-closed rules

- Branch/HEAD/tree/authority mismatch → **STOP**, never silently reconcile.
- No silent authority expansion or scope-allowlist inference from "it changed anyway."
- No historical evidence rewriting; no editing sealed/certified artifacts.
- Never weaken a test or a gate to obtain a PASS.
- Where authority is UNKNOWN or ambiguous, preserve/stop — never guess.

## 6. Model / executor routing

- **A** — new authority, architecture, material conflicts, adversarial audit → highest-reasoning model justified.
- **B** — frozen, well-specified implementation → Sonnet-class preferred, empirically validated by ODS v1's own implementation evidence (see `docs/ops/ods/ODS_V1_EFFICIENCY_VALIDATION_v1.0.0.json`, benchmark G); machine gates (prestate/scope/poststate/authority) remain mandatory regardless, and model economy alone is never proof of adequacy on its own.
- **C** — mechanical, bounded, low-risk work → cheapest reliable model, or a script.
- **D** — deterministic facts (branch/HEAD/tree/hashes/scope) → machine gate, **no LLM**.

## 7. Context economy

- Cite exact SHA/path/identifier; never paste a whole authority when an index or range answers the question.
- Continue an existing conversation when the lineage and authority are the same and context is reusable.
- Start a clean conversation for a genuinely independent adversarial audit or a new authority domain.
- Prefer direct work over subagents for grep/static/small sequential tasks. No skill or subagent proliferation (subagent rules: §12).

## 8. Worktree / branch discipline

- Use the exact worktree and branch a task specifies; worktrees are not interchangeable.
- Certified lineages are immutable unless explicitly authorized to mutate.
- A worktree of unknown status is preserved, never pruned, until classified (see ODS authority `HPO-ODS-02`).
- No destructive cleanup without governed classification.

## 9. Windows hazards (measured, not exhaustive)

- CRLF: `.gitattributes` pins `docs/**`, `db/baseline/**`, `db/prepared/**`, `*.sh` to LF; other text files round-trip through `core.autocrlf` on checkout — the stored blob is still LF.
- Deep paths approach `MAX_PATH`; prefer short worktree directory names.
- Spawn `git`/tool processes with argument arrays; `pnpm` is a `.cmd` shim on Windows and needs `shell:true` with one pre-quoted command string, never an args array (triggers a real Node deprecation warning).
- `git diff <ref> -- <path>` semantics have previously diffed against the working tree unexpectedly — verify the two-endpoint form.
- A new untracked directory collapses to one `git status` line unless `--untracked-files=all` is passed.

## 10. Report contract

Order is fixed; `NEEDS_FROM_OWNER` always comes first (`NONE` when empty).

```
NEEDS_FROM_OWNER   (or: NONE)
RESULT
DONE               (each done_when item, met/unmet)
EVIDENCE           (exact SHA/TREE/paths/gate output)
UNCONFIRMED        (per material fact: fact, searched, status,
                    why_unconfirmed, impact, next_evidence_required)
RISKS / OPEN FINDINGS
NEXT AUTHORIZED ACTION
```

Long-run details (§11–§14): `docs/ops/ods/ODS_LONG_RUN_OPERATING_STANDARD_v1.0.0.md`;
skill `.claude/skills/uellix-long-run`.

## 11. Long-run policy

When a step does not require human input, continue automatically. A
progress/status update is NOT a stopping condition: never stop merely to
summarize, offer to continue, report pending CI/tests, or ask permission
for an already-authorized next step. Poll bounded operations (CI, builds,
test runs) to a terminal state. Stop ONLY on: a real HPO/owner decision;
an authority contradiction; scope expansion; a protected/destructive/
provider boundary requiring confirmation; branch/HEAD/prestate drift; a
genuine gate failure not fixable within scope; no authorized work remaining.

## 12. Subagents

- Default: ONE writer (the parent) + read-only investigators only when the work is genuinely parallel.
- The parent verifies every material subagent claim against the repository before relying on it.
- Subagents never make owner decisions, expand authority, or certify their own writes.
- Multiple writing subagents require explicit disjoint worktrees/write-sets and a declared integration order; otherwise prohibited.
- No subagent for trivial grep or sequential work.

## 13. Certification inheritance

A certified fact may be inherited ONLY while none of its invalidation
predicates has fired. Re-derive it only when: covered files changed;
governing authority changed; package/tree/candidate binding changed;
freshness expired; an explicit invalidator fired; the mission explicitly
challenges it; or contradictory evidence appears. There is no global
"earlier answers are settled" rule — inheritance is per fact, per predicate.

## 14. RUN_STATE

Long missions keep `%TEMP%\uellix-runs\<LANE>\RUN_STATE.json` (outside git):
operational memory only — never authority, certification, or product
evidence. On resume, re-measure branch/HEAD/tree first; repository facts
beat RUN_STATE, and an unexplained HEAD change is drift (STOP). Shape and
update rules: `docs/ops/ods/ODS_RUN_STATE_SCHEMA_v1.0.0.json`,
`pnpm ops:closure-state -- run-state --file <path>`.
