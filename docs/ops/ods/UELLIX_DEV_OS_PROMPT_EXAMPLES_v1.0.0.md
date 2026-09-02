# Uellix Dev OS — Prompt Compression Examples

Three example mission invocations, showing how a prompt authored against
the `uellix-*` skill layer replaces the long-form operational history that
ODS-ACCEL-01 through ODS-ACCEL-03's own task prompts had to restate by
hand each time. Refs below are placeholders (`<...>`) — never hardcode a
real historical ref (e.g. the B1/B2 cases) into a reusable production
skill or example; a real mission fills these in at invocation time.

## Example 1 — normal FIB implementation mission

**Before** (representative of this repo's own prior task prompts): a
multi-hundred-line prompt restating branch/HEAD/tree verification steps,
the full authority retrieval order, the mission-loop shape, stop
conditions, model-routing rules, and gate commands, every single time.

**After**, using this skill layer:

```
Use uellix-preflight for <unit-id> on <branch>, base <base-ref>.
Then uellix-test-manifest for <unit-id> if none exists.
Then uellix-mission-loop for the single DAG node <unit-id>, max 5 cycles.
```

Everything the long-form prompt used to spell out — prestate verification,
authority retrieval order, the loop shape, stop conditions, gate commands,
model routing — is inherited from the skills and their shared operating
model reference instead of being retyped.

## Example 2 — focused remediation re-audit

**Before**: a prompt reciting the entire remediation's audit history,
every prior finding, and re-deriving base/head/protected/failure facts
from conversation memory before rendering a verdict.

**After**:

```
Use uellix-focused-reaudit for the remediation at base <base-ref>,
head <head-ref>, target-branch <branch>, authority <authority-id>.
Prior disposition: <path to prior audit artifact>.
Test manifest: <path>.
```

The skill runs `pnpm audit:batch` itself for the machine facts and spends
its semantic tokens only on the new-semantics/atomicity/security/
mutation-strength/new-gaps axes — never restating what the packet already
proves.

## Example 3 — product vertical integration

**Before**: a prompt separately explaining that product work can start
once a FIB contract closes (not the whole wave), then separately
describing the Golden E2E journey shape and its extension rules.

**After**:

```
Use uellix-product-vertical for FIB contract <unit-id>.
Extend Golden E2E at the appropriate stage once product work is green.
```

`uellix-product-vertical` already encodes the "don't wait for the whole
wave" rule and the invariant checklist (tenant isolation, roles,
evidence/proxy/governance, Stella boundaries); `uellix-golden-e2e` already
encodes the journey shape and its extend-don't-recreate contract.
