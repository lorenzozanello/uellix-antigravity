# ODS Long-Run Operating Standard v1.0.0

Authority class: `DEVELOPMENT_PROCESS_STANDARD` (same class as
`ODS_CONTEXT_CHECKPOINT_STANDARD_v1.0.0.md`, ODS-C6). NOT authority: it
governs HOW long missions run and report, never decision content. It
references `ODS_V1_AUTHORITY_v1.0.0.json` and modifies nothing frozen.
Frozen FIB/PC-01B/IM-01B authority, HPO decisions, and repository evidence
always win over this file. `CLAUDE.md` §10–§14 are the compact form; this
file holds the detail those sections point to.

Origin: lane `CV1-DEVOS-OPUS55-AND-CLOSURE-STATE-R1` (owner-issued).
Not independently certified at authoring time.

## 1. Long-run policy

A step that needs no human input runs automatically. Status/progress
updates are not stopping conditions. Bounded operations (CI, build, test
suite, provider job this lane is authorized to watch) are polled to a
terminal state — `success`, `failure`, `cancelled`, or a declared timeout —
never reported as "pending" and left.

Stop set (closed list — anything else continues):

| Stop | Meaning |
|---|---|
| `OWNER_DECISION` | an HPO/owner act no artifact already decides |
| `AUTHORITY_CONTRADICTION` | two controlling sources disagree (fail closed) |
| `SCOPE_EXPANSION` | the next step leaves the declared write set / authority |
| `BOUNDARY_CONFIRMATION` | protected, destructive, or provider boundary needing confirmation |
| `DRIFT` | branch/HEAD/tree/prestate differs from the governed expectation |
| `GATE_FAILURE` | a genuine gate failure not fixable inside scope |
| `EXHAUSTED` | no authorized work remains (includes DONE) |

A bounded local fix inside scope is not a stop: fix, re-run the gate,
continue. The same unresolved semantic failure twice IS a stop
(`GATE_FAILURE`), per `uellix-mission-loop`.

## 2. Subagent policy

- One writer (the parent session) + read-only investigators when the work
  is genuinely parallel. Consistent with the checkpoint standard's
  subagent rule: direct work remains the default.
- Material subagent evidence is re-verified by the parent against the
  repository (a `git show`, a re-run command) before it enters a report,
  a commit, or closure state. A subagent claim alone is `INFERENCE`.
- Subagents never: make owner decisions, expand authority or scope,
  certify their own writes, or write RUN_STATE.
- Multiple writing subagents: only with explicit disjoint worktrees AND
  disjoint write-sets AND a declared integration order. Otherwise
  prohibited.
- No subagent for trivial grep or sequential work.

## 3. Certification inheritance

A certified fact is inherited while — and only while — none of its
invalidation predicates has fired. Predicate kinds (the same vocabulary
`CV1_CLOSURE_STATE_SCHEMA_v1.0.0.json` uses in `invalidated_by[].kind`):

| kind | fires when |
|---|---|
| `COVERED_PATH_CHANGED` | any covered path's blob differs from the certified package (`covered_package_digest` mismatch) |
| `AUTHORITY_CHANGED` | the governing authority path or version differs from the one certified |
| `BINDING_CHANGED` | candidate SHA / tree / package binding differs |
| `FRESHNESS_EXPIRED` | a TTL-bound observation passed `expires_at` |
| `EXPLICIT_EVENT` | a named invalidator (e.g. a provider event) is recorded as fired |
| `MISSION_CHALLENGE` | the mission explicitly challenges the fact |
| `CONTRADICTORY_EVIDENCE` | new evidence contradicts the fact |

Re-derive an inherited fact only when one of these fired. There is no
global "earlier answers are settled" rule: inheritance is per fact, per
predicate, and a fired predicate is never overridden by a prior PASS.
The validator enforces the first five mechanically.

## 4. RUN_STATE contract

Location: `%TEMP%\uellix-runs\<LANE>\RUN_STATE.json` — outside git by
default. Shape: `ODS_RUN_STATE_SCHEMA_v1.0.0.json`. It is operational
memory: never authority, never certification, never product evidence,
never committed, never holding secrets or connection data.

Update semantics:

1. Single writer: only the parent session writes it.
2. Write atomically: write `RUN_STATE.json.tmp`, then rename over the old
   file.
3. Update after every completed step: move the item to `completed`, set
   `active`, refresh `remaining`, `updated_at` (monotonic, UTC ISO-8601).
4. `last_verified_head` changes only after the parent measured it with
   git; own commits are appended to `own_commits`.
5. `findings`, `unconfirmed`, `needs_from_owner` are append-then-resolve:
   an item is marked resolved, not deleted.

Resumption semantics:

1. Re-measure branch, HEAD, tree, cleanliness FIRST.
2. HEAD == `last_verified_head`, or HEAD is the last entry of
   `own_commits` → resume at `active`.
3. Any other HEAD → `DRIFT` stop. Never reconcile silently.
4. Unreadable/invalid RUN_STATE → treat as absent, re-derive from the
   repository; never guess its contents.
5. On conflict, repository facts beat RUN_STATE.

`pnpm ops:closure-state -- run-state --file <path> [--repo <dir>]`
validates the shape and, with `--repo`, performs check 2/3.

## 5. Report contract

Fixed order (superset of ODS-C6's four required elements, which keep
their meaning):

```
NEEDS_FROM_OWNER        first, always; "NONE" when empty
RESULT
DONE                    each done_when item: met / unmet
EVIDENCE                exact SHA / TREE / paths / gate output
UNCONFIRMED
RISKS / OPEN FINDINGS
NEXT AUTHORIZED ACTION
```

Every material UNCONFIRMED fact is recorded with exactly these fields
(the `unconfirmed_fact` shape in both schemas):

```
fact                    the claim
searched                where/how it was looked for
status                  UNCONFIRMED | NOT_FOUND | CONTRADICTED
why_unconfirmed
impact                  what it blocks or weakens
next_evidence_required  the exact read/act that would confirm it
```

## 6. Evidence classes

Closure state and reports keep five classes apart; none is promoted into
another silently:

- `REPOSITORY_FACT` — readable at an exact ref/path(/field); mechanically
  re-checkable with `--verify-git`.
- `PROVIDER_OBSERVATION` — a read of GitHub/Vercel/Supabase/etc. at a
  time; recorded ONCE as an observation with `consumers[]`, never copied
  per consumer.
- `HUMAN_DECISION` — an owner/HPO act.
- `INDEPENDENT_CERTIFICATION` — a verdict by a reviewer other than the
  writer of the certified object.
- `INFERENCE` — derived; never the sole basis for certification or for a
  lifecycle state at or beyond `EXECUTED`.

## 7. Scope of this standard

Changes process documents and tooling only. It does not open any
protected grant, does not modify FIB/PC-01B/IM-01B, `db/**`, runtime,
Supabase, Vercel, or historical evidence.
