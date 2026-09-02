---
name: uellix-mission-loop
description: "Bounded mission loop for exactly one DAG node at a time: measure, implement, test, gate, local-fix-if-authorized, commit-if-green, next cycle, max 4-5 cycles. Stops on authority conflict, protected-surface violation, migration collision, the same unresolved semantic failure twice, an HPO/human decision point, scope expansion, or max cycles. Use for any bounded implementation mission on a single node — never for open-ended or multi-node work in one invocation."
---

# Uellix Mission Loop

The approved bounded mission model for **one DAG node**. See
`docs/ops/ods/UELLIX_DEV_OS_OPERATING_MODEL_v1.0.0.md` for the shared
rules this skill inherits.

```status_vocabulary
PASS
FAIL
BLOCKED
INSUFFICIENT_EVIDENCE
```

## Bound

```
MAX_CYCLES: 5
```

A cycle is one full pass of the loop below. Reaching `MAX_CYCLES` without a
green commit is itself a STOP condition, reported `BLOCKED` — never
silently extended.

## When to use

- Any mission scoped to exactly one DAG node (one FIB implementation unit,
  one remediation step, one tooling accelerator).
- Never for multiple nodes in a single invocation — run this skill once
  per node, with `uellix-preflight` between nodes.

## The loop

```
MEASURE           -> uellix-preflight (or its constituent tools directly)
  -> ONE DAG NODE -> scope confirmed to exactly one node, no more
  -> IMPLEMENT    -> smallest authorized change for this node only
  -> TEST         -> uellix-test-manifest's declared positive/negative/
                     mutation controls, run for real
  -> GATE         -> typecheck, secrets scan, authority seal,
                     ods:scope, ods:poststate for this node's diff
  -> LOCAL FIX    -> only if the manifest or governing task explicitly
                     authorizes a local fix cycle; never a scope expansion
  -> COMMIT       -> only when every gate above is green
  -> NEXT CYCLE   -> repeat, or stop if the node is done
```

**Never commit red state.** A gate failure ends the cycle without a
commit — go to LOCAL FIX (if authorized) or STOP, never commit-then-fix.

**Never weaken a test or a gate to obtain a PASS.** If a gate seems wrong,
that is itself a STOP condition (authority conflict or HPO decision),
never a reason to edit the gate.

## Stop conditions

Any of the following ends the loop immediately, before another cycle
starts, reported as `BLOCKED` (human/HPO decision, authority conflict,
scope expansion) or `FAIL` (protected-surface violation, migration
collision, max cycles reached):

- **Authority conflict** — the node's implementation would require
  interpreting ambiguous or contradictory frozen authority.
- **Protected-surface violation** — `pnpm ods:scope` (or
  `pnpm ops:integration-plan`'s `PROTECTED_AUTHORITY_DISPOSITION`) reports
  a violation with no resolving grant.
- **Migration collision** — two nodes touch overlapping `db/migrations/**`
  or `db/prepared/**` state in a way that cannot both apply cleanly.
- **The same unresolved semantic failure twice** — a test fails for the
  same root cause across two consecutive cycles. Retrying a third time
  without a materially different diagnosis is a scope expansion, not a
  fix.
- **HPO/human decision** — the node requires a product or authority
  decision no machine gate or prior authority artifact answers.
- **Scope expansion** — the node's diff would need to grow beyond what
  `uellix-test-manifest` declared, or beyond one DAG node.
- **Maximum cycles** — `MAX_CYCLES` reached without a green commit.

## Authority + code in one compound mission

Permitted **only** when a hard, committed authority gate separates them:
the authority artifact is frozen and committed FIRST, as its own commit,
before any implementation commit in the same mission touches code the
authority governs. Interleaving authority decisions with implementation
commits inside one cycle is a protected-surface-adjacent risk — treat it
as a STOP condition and split into two missions instead.

## Never

- Never commit a red gate.
- Never weaken `ods:scope`, `ods:poststate`, a test, or an authority seal
  to obtain a PASS.
- Never expand scope mid-loop without ending the current cycle and
  re-running `uellix-preflight` for the larger scope.
- Never run more than `MAX_CYCLES` cycles without stopping and reporting
  `BLOCKED`.
