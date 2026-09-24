# ODS Long-Run Operating Standard v1.1.0

Authority class: `DEVELOPMENT_PROCESS_STANDARD` (same class as
`ODS_CONTEXT_CHECKPOINT_STANDARD_v1.0.0.md`, ODS-C6). NOT authority: it
governs HOW long missions run and report, never decision content. Frozen
FIB/PC-01B/IM-01B authority, HPO decisions and repository evidence always
win. `CLAUDE.md` §10–§14 are the compact form; this file holds the detail.

Supersedes `ODS_LONG_RUN_OPERATING_STANDARD_v1.0.0.md` (kept unchanged as
history). Changes: the stop list is a minimum, not a closed set; push is
never a generic step; multiple writers need mission authorization; RUN_STATE
has a verified non-git location and a full resume identity; durable-source,
dependency and projection rules are recorded. Governed by
`ODS_V1_MAINTENANCE_ADDENDUM_v1.0.39.json`. Not independently certified at
authoring time.

## 1. Long-run policy

A step that needs no human input runs automatically. Status/progress
updates are not stopping conditions. Bounded operations (CI, build, test
suite, a provider job this lane is authorized to watch) are polled to a
terminal state — `success`, `failure`, `cancelled`, or a declared timeout.

Minimum stop set — these ALWAYS stop:

| Stop | Meaning |
|---|---|
| `OWNER_DECISION` | an HPO/owner act no repository artifact already decides |
| `AUTHORITY_CONTRADICTION` | two controlling sources disagree |
| `SCOPE_EXPANSION` | the next step leaves the declared write set / authority |
| `BOUNDARY_CONFIRMATION` | protected, destructive, or provider boundary needing confirmation |
| `DRIFT` | branch/HEAD/tree/prestate/RUN_STATE identity differs from the governed expectation |
| `GATE_FAILURE` | a genuine gate failure not fixable inside scope; the same failure twice |
| `EXHAUSTED` | no authorized work remains (includes DONE) |

The list is NOT closed and never overrides another rule. Every other
fail-closed rule also stops: UNKNOWN or ambiguous authority (`CLAUDE.md` §5),
secret exposure, authority-seal or scope failure, `MAX_CYCLES` and every stop
of `uellix-mission-loop`. "Progress is not a stop" removes only one false
reason to stop; it never removes a safety stop.

## 2. Push and other side-effecting steps

Commit and push are not generic loop steps. Push only when the current
mission's DONE/authority explicitly authorizes commit/push. A push to ANY
branch of this repository creates a Vercel Preview deployment, which is a
provider event: it can invalidate evidence windows and event-bound
predicates (for example a quiescence census or an Event-A window). Before
pushing, check that no open window or observation this lane relies on is
invalidated by that event; if one is, that is a `BOUNDARY_CONFIRMATION` stop.

## 3. Subagent policy

- One writer (the parent session) + read-only investigators when the work
  is genuinely parallel. Direct work remains the default.
- Material subagent evidence is re-verified by the parent against the
  repository before it enters a report, a commit, or the closure projection.
  A subagent claim alone is `INFERENCE`.
- Subagents never make owner decisions, expand authority or scope, certify
  their own writes, or write RUN_STATE.
- Multiple writers only when the mission itself explicitly authorizes them
  — the parent cannot self-authorize by declaring it — AND with disjoint
  worktrees, disjoint write sets and a declared integration order.
- No subagent for trivial grep or sequential work.

## 4. Certification inheritance

A certified fact is inherited while — and only while — none of its
invalidation predicates has fired. Predicate kinds are
`invalidator_kind` in `CV1_CLOSURE_STATE_SCHEMA_v1.1.0.json`:
COVERED_PATH_CHANGED, AUTHORITY_CHANGED, BINDING_CHANGED,
FRESHNESS_EXPIRED, EXPLICIT_EVENT, MISSION_CHALLENGE, CONTRADICTORY_EVIDENCE.
Re-derive only when one fired. A fired predicate is permanent history: it
never returns to `fired=false` and is never deleted. A later certification
supersedes it only under a NEW `certification_id` with durable evidence.

## 5. RUN_STATE contract

Location: `<ROOT>\<LANE>\RUN_STATE.json`, where ROOT comes from
`pnpm ops:closure-state -- run-state-root`: `%TEMP%\uellix-runs` only if that
path is verified to be outside every git repository/worktree (no `.git` in
it or any ancestor), else `%LOCALAPPDATA%\uellix-runs` if verified; no
verified location => STOP. (Measured on this host: `%TEMP%` is itself inside
a git repository.) Shape: `ODS_RUN_STATE_SCHEMA_v1.1.0.json`. RUN_STATE is
operational memory: never authority, certification or product evidence,
never committed, never holding secrets or connection data.

Update semantics: single writer (the parent); atomic write (`.tmp` then
rename); update after every completed step; `last_verified_head` changes
only after a git measurement and own commits are appended to `own_commits`;
findings / unconfirmed / needs_from_owner are resolved, never deleted.

Resumption: re-measure branch, HEAD, tree and cleanliness first; then bind
the FULL identity — lane, role, branch (recorded AND checked out), base,
candidate (null or one of `own_commits`) and HEAD (= `last_verified_head` or
the LAST own commit). HEAD alone is never sufficient: another lane's
RUN_STATE at the same HEAD is drift. Any mismatch => `DRIFT` stop.
`pnpm ops:closure-state -- run-state --file <f> --repo . --lane <L> --role <R>
--branch <B> --base <SHA> [--candidate <SHA>]` performs these checks; the
expected identity is supplied by the mission, never inferred from the file.

## 6. Report contract

```
NEEDS_FROM_OWNER        first, always; "NONE" when empty
RESULT
DONE                    each done_when item: met / unmet
EVIDENCE                exact SHA / TREE / paths / gate output
UNCONFIRMED             fact, searched, status, why_unconfirmed, impact,
                        next_evidence_required
RISKS / OPEN FINDINGS
NEXT AUTHORIZED ACTION
```

## 7. Durable sources, dependencies and the closure projection

Durable source (owner policy, addendum v1.0.39): a human decision or an
independent certification that exists only in chat, memory, scratchpad,
RUN_STATE or free-text `source` is contextual or UNCONFIRMED only. It never
supports CERTIFIED, MATERIALIZED, ARMED, `execution_allowed = true`, CLOSED
or the resolution of a blocking finding. Durable = materialized in the
repository and referenced by ref, path, field AND expected value, re-checked
by `--verify-git`. A second-hand repository record of someone else's verdict
is a REPOSITORY_FACT about that record, not a certification.

Dependencies (owner policy, addendum v1.0.39): every edge declares
`required_state` and `applies_from_state`; there is no default. ARMED,
CLOSED and `execution_allowed` need every edge satisfied.

`docs/ops/ods/CV1_CLOSURE_STATE.json` is a mutable derived projection. It
never outranks the authority, decisions, certifications, observations or
evidence it points at. Git history keeps old projections; a newer projection
may change current dispositions but may not erase evidence, findings,
invalidators, dependency edges, certifications or lifecycle history. CI
(`pnpm ops:closure-state -- ci`) derives the previous projection from the
merge-base, so no human has to remember it.

## 8. Scope of this standard

Process documents and tooling only. It opens no protected grant and changes
nothing in FIB/PC-01B/IM-01B, `db/**`, runtime, Supabase, Vercel, or
historical evidence.
