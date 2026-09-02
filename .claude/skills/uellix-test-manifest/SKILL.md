---
name: uellix-test-manifest
description: "Freeze a node/batch test contract BEFORE implementation, against docs/ops/ods/UELLIX_TEST_MANIFEST_SCHEMA_v1.0.0.json. Declares positive/negative/mutation controls, PostgreSQL requirements, sentinels, known conditions, dependencies, protected surfaces, and exit gates as machine-readable JSON, not free-form prose. Use whenever a mission is about to start writing implementation code for a new node/batch and no manifest for it exists yet."
---

# Uellix Test Manifest

A manifest is a **commitment made before implementation**, not a report
written after. See
`docs/ops/ods/UELLIX_DEV_OS_OPERATING_MODEL_v1.0.0.md` for the shared
rules this skill inherits.

## When to use

- Before writing implementation code for a new FIB node or a remediation
  batch that doesn't already have a manifest.
- Before `uellix-mission-loop` opens its first cycle for a node.

## Skip

- A one-line documentation fix with no behavioral surface.
- A node whose manifest already exists and is unchanged in scope.

## Schema

`docs/ops/ods/UELLIX_TEST_MANIFEST_SCHEMA_v1.0.0.json` is the JSON Schema.
`docs/ops/ods/UELLIX_TEST_MANIFEST_TEMPLATE_v1.0.0.json` is a blank
starting point — copy it, never hand-roll a new shape.

Every manifest MUST validate against the schema and MUST set
`positive_controls` and `negative_controls` to at least one entry each —
**a manifest with zero negative controls is incomplete by definition**
(see the shared reference, section 3: every new deterministic gate needs
a positive AND a deliberate negative control).

## Procedure

1. Copy the template to a working location (e.g.
   `docs/ops/wave<N>/<manifest_id>_TEST_MANIFEST.json`, or keep it inline
   in the mission transcript if the node is small and short-lived — the
   schema does not mandate a commit location).
2. Fill `authority_reference` with an exact citation (file + line range),
   never a paraphrase.
3. Fill `dependencies` with other `manifest_id`s or program-state unit ids
   this node assumes are CLOSED — then actually verify each via
   `pnpm ops:program-state -- --unit <id> --json` before treating the
   dependency as satisfied. **Unknown required evidence fails closed**: if
   a dependency's status cannot be measured, the manifest must record it
   as `"UNKNOWN"` inline in a control's `description`, never silently omit
   the dependency or assume it is satisfied.
4. Fill `protected_surfaces` and `protected_authority` explicitly — an
   empty array is a valid, explicit "none expected"; do not omit the key
   to mean the same thing (the schema requires the key when present in the
   object, but a node touching zero protected paths still states `[]`).
5. If a real PostgreSQL probe is needed, fill `postgres_requirements`
   pointing at setup/probe manifests for
   `pnpm db:audit:disposable -- --setup <path> --probe <path>` — never a
   raw connection string, never staging/production.
6. Name each `sentinels` entry's purpose precisely (e.g. "a generated
   password must never appear in tool stdout/JSON output") — a sentinel
   with no stated purpose is not useful evidence.
7. Cross-check `known_conditions` against
   `docs/ops/ods/KNOWN_TEST_CONDITIONS_v1.0.0.json` via
   `pnpm ops:test-diff` — never hand-pick a condition id from memory.
8. Set `exit_gates` to the actual machine gates this node must pass —
   values are constrained to the schema's closed enum; there is no
   free-form gate name.

## Output status vocabulary

```status_vocabulary
PASS
FAIL
BLOCKED
INSUFFICIENT_EVIDENCE
```

`PASS` here means "the manifest itself validates against the schema and
has at least one positive and one negative control" — it is a manifest
QUALITY verdict, never a claim that the node's implementation has passed
anything (the node does not exist yet).

## Never

- Never author a manifest as free-form prose only — the JSON is the
  contract; prose is guidance alongside it, never a substitute.
- Never mark a control's evidence known when it has not actually been
  measured — write `"UNKNOWN"` and let the gate fail closed.
- Never invent a new `exit_gates` value outside the schema's enum.
