---
name: uellix-golden-e2e
description: "Extends, never recreates, the commercial Golden E2E journey (signup -> organization -> roles/users -> project -> evidence -> proxy -> outcome/filters -> SROI -> Stella -> report -> Portfolio -> Evaluate -> review/approval) as each capability closes. Every extension retains the prior passing journey, adds a positive path, adds at least one relevant negative control, and avoids manual/dev-only workarounds. Use whenever uellix-product-vertical reaches its Golden E2E step, or whenever a closed capability needs its journey coverage extended."
---

# Uellix Golden E2E

**Extends — never recreates.** See
`docs/ops/ods/UELLIX_DEV_OS_OPERATING_MODEL_v1.0.0.md` for the shared
rules this skill inherits.

```status_vocabulary
PASS
FAIL
BLOCKED
INSUFFICIENT_EVIDENCE
```

## The expected progressive journey

```
signup -> organization -> roles/users -> project -> evidence -> proxy
  -> outcome/filters -> SROI -> Stella -> report -> Portfolio -> Evaluate
  -> review/approval
```

A capability's Golden E2E extension lands at its own point in this
sequence — evidence work extends at `evidence`, a new report feature
extends at `report`, and so on. Never insert a shortcut that skips an
earlier stage the real product requires (e.g. driving straight to
`report` without going through `project`/`evidence` first) — that is a
manual/dev-only workaround, not an extension of the journey.

## When to use

- `uellix-product-vertical` has reached its Golden E2E step for a closed
  capability.
- An existing journey stage needs additional coverage because a new
  capability changed its behavior.

## Skip

- The capability has no product-facing journey surface at all (pure
  backend/tooling work with no UI/API path a real user would traverse).

## Procedure

1. Locate the current Golden E2E test file(s) covering the journey up to
   (and including) the stage immediately BEFORE this capability's own
   stage. Read them — do not assume their current shape from memory.
2. **Retain the prior passing journey.** Run it before touching anything;
   it must still be green both before and after the extension. An
   extension that requires changing a prior stage's assertions to pass is
   not an extension — treat that as a `uellix-focused-reaudit` finding
   (the change has semantics beyond "add a new stage").
3. **Add the positive path** for this capability's own stage, continuing
   the SAME user/session/data state the prior stage left off with — never
   a fresh, disconnected fixture that only proves the new stage in
   isolation.
4. **Add at least one relevant negative control** for this stage — the
   specific refusal/validation this capability's authority requires (e.g.
   an unauthorized role rejected, a sensitivity-gated evidence item
   correctly withheld, an invalid proxy transition refused). A stage
   extension with only a happy path is incomplete, per the shared
   reference's "every new deterministic gate needs a negative control"
   rule.
5. **Avoid manual/dev-only workarounds** — no test-only bypass route, no
   direct-database seed that skips the real mutation path the product
   actually exposes, no environment flag that only exists to make the
   test pass. If the real journey cannot be driven without one, that is
   itself a finding to report, not a workaround to add quietly.
6. Run the FULL extended journey (prior stages + new stage) and the ODS
   gate set for the diff.

## Output

```
PASS      — the full extended journey (all prior stages + the new stage's
            positive and negative controls) passes, with no
            manual/dev-only workaround introduced.
FAIL      — a prior stage regressed, the new stage's negative control does
            not actually refuse what it claims to, or a workaround was
            required and not resolved.
BLOCKED   — the journey cannot be extended without a product/HPO decision
            about where this capability belongs in the sequence.
INSUFFICIENT_EVIDENCE — the current Golden E2E journey's own passing state
            could not be confirmed before starting the extension.
```

## Never

- Never recreate the journey from scratch for a new capability — extend
  the existing file(s)/fixtures.
- Never let an extension silently drop or weaken a prior stage's negative
  control to make the new stage easier to add.
- Never ship a manual/dev-only workaround as if it were the real path.
