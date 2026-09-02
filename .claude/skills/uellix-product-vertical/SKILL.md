---
name: uellix-product-vertical
description: "Encodes continuous vertical integration for a closed FIB contract: product preflight, U7 architecture, U8 implementation, tests/accessibility/build/ODS gates, then a Golden E2E extension — without waiting for every FIB wave to close first. Preserves tenant isolation, roles/permissions, evidence/proxy/governance invariants, and Stella human-control boundaries at every step. Use once a specific FIB contract is CLOSED and its product-facing surface needs to be built or extended."
---

# Uellix Product Vertical

Moves ONE closed FIB contract through product integration end to end,
rather than batching product work behind an entire wave. See
`docs/ops/ods/UELLIX_DEV_OS_OPERATING_MODEL_v1.0.0.md` for the shared
rules this skill inherits.

```status_vocabulary
PASS
FAIL
BLOCKED
INSUFFICIENT_EVIDENCE
```

## When to use

- A specific FIB contract (one `FIBIU-*`/`FIBC-*` unit, not a whole wave)
  has `AUTHORITY_STATUS=CLOSED`, `IMPLEMENTATION_STATUS=CLOSED`, and
  `AUDIT_STATUS=CLOSED` per `pnpm ops:program-state -- --unit <id>`, and
  its product-facing surface has not yet been built or is incomplete.

## Skip

- The contract's `IMPLEMENTATION_STATUS` or `AUDIT_STATUS` is not yet
  `CLOSED` — building product surface on an unclosed contract is scope
  expansion into the FIB layer, not vertical integration. Run
  `uellix-preflight` first; if it reports `NO`/`BLOCKED`, this skill does
  not apply yet.

## The vertical

```
FIB contract CLOSED   -> pnpm ops:program-state -- --unit <id> confirms
                          AUTHORITY/IMPLEMENTATION/AUDIT all CLOSED
  -> product preflight -> uellix-preflight scoped to the product surface's
                          own base/head/target-branch
  -> U7 architecture    -> the product-facing design for this contract's
                          surface (routes, actions, data flow) — sized to
                          this ONE contract, not the whole product
  -> U8 implementation  -> uellix-mission-loop, one DAG node per
                          architectural unit from U7
  -> tests/accessibility/build/ODS
                        -> targeted tests, accessibility checks relevant
                          to the new surface, pnpm build, and the full ODS
                          gate set (typecheck, secrets scan, authority
                          seal, ods:scope, ods:poststate)
  -> Golden E2E extension
                        -> uellix-golden-e2e, extending (never
                          recreating) the existing journey
```

**Do not wait for all FIB waves before starting.** A contract's own
closure is the gate, not the wave's.

## Invariants preserved at every step

These are checked, not merely assumed, before any step in the vertical is
considered done:

- **Tenant isolation** — every new query/action scoped to
  `organization_id`/`project_id` as governed elsewhere in this repo; no
  new cross-tenant read/write path.
- **Roles/permissions** — the new surface respects the existing
  role/permission model; no new action bypasses an existing authorization
  check.
- **Evidence/proxy/governance invariants** — sensitivity classification,
  sufficiency determination, and audit-logging obligations already frozen
  by FIB authority are not weakened or bypassed by the new product
  surface.
- **Stella human-control boundaries** — no new AI-assisted action removes
  a human approval/review step FIB authority requires; Stella's
  configured role stays advisory unless authority explicitly says
  otherwise.

A step that cannot verify one of these invariants is not done — treat the
gap as a `uellix-focused-reaudit` finding or an `INSUFFICIENT_EVIDENCE`
stop, never a silent proceed.

## Output

```
PASS      — the contract's product surface is built/extended through
            Golden E2E with every invariant above verified and every ODS
            gate green.
FAIL      — an invariant check or an ODS gate failed for this vertical's
            own diff.
BLOCKED   — the contract's U7 architecture requires a product/HPO
            decision (e.g. an ambiguous UX choice authority does not
            specify).
INSUFFICIENT_EVIDENCE — the FIB contract's own closure could not be
            confirmed via ops:program-state.
```

## Never

- Never start U8 implementation before `uellix-test-manifest` exists for
  this vertical's own DAG nodes.
- Never treat a contract as CLOSED because it merged into a branch —
  `ops:program-state`'s `INTEGRATION_STATUS`/`PRODUCT_BINDING_STATUS` are
  separate dimensions from `IMPLEMENTATION_STATUS`.
- Never weaken tenant isolation, role checks, or evidence-governance
  invariants to ship the surface faster.
