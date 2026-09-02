# Uellix Development Operating Model v1.0.0 — Shared Reference

Operational metadata shared by every `.claude/skills/uellix-*` skill in this
repository. NOT authority: it summarizes HOW to work, evidenced by the
machine gates in `CLAUDE.md` and `docs/ops/ods/**`. It never supersedes
frozen FIB/PC-01B/IM-01B authority, HPO decisions, or repository evidence —
see `docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json`.

Every `uellix-*` skill's `SKILL.md` references this file instead of
restating its rules. If this file and a skill body disagree, this file
wins for process rules; frozen authority always wins over both.

## 1. Model routing

- **Sonnet** — bounded implementation, tooling, materialization. The
  default for a single DAG-node mission (`uellix-mission-loop`), a
  preflight read (`uellix-preflight`), or writing a test manifest
  (`uellix-test-manifest`). Empirically validated for this class of work —
  see `docs/ops/ods/ODS_V1_EFFICIENCY_VALIDATION_v1.0.0.json`, benchmark G.
- **Fable 5.1** — only for a high-value long/interdependent/cross-layer or
  complex-visual mission loop where the marginal value over Sonnet justifies
  the cost. Not a default; name the specific cross-layer reason when
  choosing it.
- **Opus** — authority conflict, adversarial semantic audit
  (`uellix-focused-reaudit`'s PASS/FAIL judgment), atomicity/security
  review, or wave/global certification. Never for mechanical fact-gathering
  — that is the machine layer's job.
- **Machine** — deterministic facts, always. A model never re-derives a
  number `pnpm ops:program-state` / `ops:integration-plan` / `ops:test-diff`
  / `db:audit:disposable` / `audit:batch` already computed. See Phase D of
  `docs/ops/ods/UELLIX_TEST_MANIFEST_SCHEMA_v1.0.0.json`'s sibling tools for
  the exact commands.

## 2. Status vocabulary

Every `uellix-*` skill's output MUST use only these tokens for a
disposition, plus whatever skill-local extension its own SKILL.md declares
in its own `status_vocabulary` fenced block (checked by
`scripts/validate-uellix-dev-os.ts`):

```
PASS
FAIL
BLOCKED
INSUFFICIENT_EVIDENCE
```

`uellix-preflight` additionally uses `READY_FOR_IMPLEMENTATION=YES|CONDITIONAL|NO`
(the condition on `CONDITIONAL` must name the exact preceding gate it is
bound to — never a vague "mostly ready").

No skill may output a semantic-closure token it did not measure — see
section 4.

## 3. Core rules

- Serial authority gates, then controlled parallelism. Authority and
  implementation code may share ONE compound mission only when separated
  by a hard, committed authority gate — never interleaved.
- Max 4 concurrent lanes, preferred 3 active + 1 buffer.
- Historical evidence is immutable. A superseded artifact is superseded,
  never silently rewritten.
- A changed audited object requires re-audit — a prior PASS does not carry
  forward across a diff to the audited object.
- Fail closed: unknown, SHA mismatch, dirty tree, or wrong branch always
  refuses rather than guesses.
- Every new deterministic gate ships with a positive control AND a
  deliberate negative control — a gate with only a happy-path test is
  unverified.
- Never weaken a gate, a test, or `ods:scope`/`ods:poststate` to obtain a
  PASS.
- PostgreSQL audit probes use `pnpm db:audit:disposable` — a throwaway,
  Docker-backed instance this session's own tooling creates and tears
  down. Never staging, never production, never the canonical local stack
  pinned by `db/safety/local-stack.ts`.

## 4. Fact vs. adjudication

A skill in this layer is either a FACT PRODUCER (preflight, test-manifest
authoring, the machine tools it calls) or an ADJUDICATOR
(`uellix-focused-reaudit`'s PASS/FAIL/BLOCKED/INSUFFICIENT_EVIDENCE call).
No skill in this layer may output any of the following as if it were a
measured fact — these are HPO/human-product-owner acts, never a skill's to
grant:

```
B2_CLOSED
AUTHORITY_ACCEPTED
SEMANTICALLY_SAFE
READY_FOR_PRODUCTION
```

A skill may only ever REPORT a value already present in a declared source
artifact (e.g., quoting `final_state` from a frozen closure JSON) — never
compute or assert one of these itself.

## 5. Machine tool integration

Reused, never reimplemented in prose or in a new script:

| Fact | Command |
|---|---|
| Program state (authority/implementation/audit/integration/product-binding) | `pnpm ops:program-state -- --unit <id> [--json]` |
| Integration/protected/semantic-overlap facts | `pnpm ops:integration-plan -- --source <ref> --target <ref> --base <ref> --target-branch <branch> [--json]` |
| BASE/HEAD failure classification | `pnpm ops:test-diff -- --base <ref-or-capture> --head <ref-or-capture> [--json]` |
| Disposable PostgreSQL audit probes | `pnpm db:audit:disposable -- --setup <path> --probe <path> [--json]` |
| Composed evidence packet | `pnpm audit:batch -- --base <ref> --head <ref> --target-branch <branch> [--authority <id>] [--postgres-manifest <path>] [--json]` |

A skill that needs one of these facts runs the command (or reads a
caller-supplied packet already produced by it) — it never restates the
tool's internal logic, and never hand-computes a number the tool already
produces.

## 6. Known conditions

`docs/ops/ods/KNOWN_TEST_CONDITIONS_v1.0.0.json` records previously
adjudicated test failures with structured identity, never a skip/ignore
list. `uellix-test-manifest` and `uellix-focused-reaudit` both consult it
via `pnpm ops:test-diff`'s classification, never by re-deciding a
condition's status from prose memory.

## 7. Related references

- `docs/ops/ods/UELLIX_TEST_MANIFEST_SCHEMA_v1.0.0.json` and its
  `docs/ops/ods/UELLIX_TEST_MANIFEST_TEMPLATE_v1.0.0.json` — the
  `uellix-test-manifest` contract.
- `docs/ops/ods/UELLIX_DEV_OS_PROMPT_EXAMPLES_v1.0.0.md` — example mission
  invocations showing the compression this layer buys.
- `docs/ops/ods/ODS_PROGRAM_STATE_REGISTRY_v1.0.0.json` /
  `docs/ops/ods/KNOWN_TEST_CONDITIONS_v1.0.0.json` — the registries the
  machine tools in section 5 read from.
