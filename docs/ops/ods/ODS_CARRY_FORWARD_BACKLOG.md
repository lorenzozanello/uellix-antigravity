# ODS Carry-Forward Backlog

Authority class: `DERIVED_TRACKING_RECORD` (ODS-05, MNB-BACKLOG-1). Anchored
to `docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.wave1-closure.json`.

**This document is derived tracking, not authority.** It cannot supersede,
reopen, or reinterpret the Wave 1 closure record. **Wave 1 remains
CLOSED.** Every finding below is reproduced from the closure artifact as
it already stands; none is re-adjudicated here.

## Purpose

`docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json` (`wave1_findings_carry_forward`)
stated this backlog was to be materialized during ODS implementation. This
is that materialization — a single place to see all five deferred Wave 1
findings and their intended ownership, without opening the full closure
JSON each time.

## Findings

### MNB-1

- **Surface:** `lib/admin/proxies.ts`
- **Issue:** semantic audit verb/object correspondence issue.
- **Status:** `DEFERRED_NON_BLOCKING`
- **Ownership:** Wave 2 entry-scope reconciliation, unless a more precise
  owning unit is established.

### BK-1

- **Surface:** `db/hosted/baseline-apply-authorization.ts`
- **Issue:** stale 58-unit manifest prose.
- **Status:** `DEFERRED_CLASS_C`

### BK-2

- **Surface:** `tests/audit-action-contract.test.ts`
- **Issue:** semantic plural/singular correspondence exceptions.
- **Status:** `DEFERRED`

### BK-3

- **Surface:** in-code W1-05-RM1 remediation labels.
- **Issue:** R-6 label collision.
- **Status:** `DEFERRED_CLASS_C`

### BK-4

- **Surface:** `lib/pipeline/confidence-score.ts`
- **Issue:** confidence-score best-effort audit catch.
- **Status:** `DEFERRED_FUTURE_REVIEW`

## ODS maintenance findings

Findings from the ODS development-process track itself (distinct from
the Wave 1 product findings above). Anchored to their own source audit,
not to the Wave 1 closure artifact. Recorded here for the same reason:
so a future session does not have to rediscover that they exist.

### AG-1

- **Surface:** `scripts/ods-scope.ts` (`DEFAULT_PROTECTED_PATTERNS`) and
  `docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json` (`authority_corpus`, the C2
  protected corpus).
- **Source:** ODS-M1F (final independent maintenance re-audit).
- **Issue:** four post-v1.0 ODS artifacts are textually immutable/
  prohibited by process convention but are not mechanically protected by
  either `DEFAULT_PROTECTED_PATTERNS` or the C2 protected corpus:

  - `docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.1.json`
  - `docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.2.json`
  - `docs/ops/ods/ODS_V1_OPERATIONAL_CLOSURE_v1.0.0.json`
  - `docs/ops/ods/ODS_V1_EFFICIENCY_VALIDATION_v1.0.0.json`

  Independently confirmed at POST-MAINT-00 (not merely transcribed from
  the audit): `classifyPaths` returns `ok` for
  `ODS_V1_MAINTENANCE_ADDENDUM_v1.0.1.json` when it is named in an
  ordinary `--allow` — an unprotected default-classification, not a
  granted exception — while `docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json`
  (the one ODS artifact that IS a literal `DEFAULT_PROTECTED_PATTERNS`
  entry) correctly still classifies as a protected violation under the
  same call shape.
- **Status:** `DEFERRED`
- **Authority change required:** `YES` — closing this requires an
  explicit HPO decision, not an implementation choice, since it changes
  what `ods:scope`/C2 treat as protected/anchored.
- **Lane A blocking:** `NO`
- **Lane B blocking:** `NO`
- **Does not affect:** Wave 2 authorized surfaces, Lane B toolchain,
  current C1–C6 operational readiness, or ODS v1 operational status.
- **Future minimum decision (not made here):** whether these four
  artifacts should be added to the protected-path gate
  (`DEFAULT_PROTECTED_PATTERNS`), incorporated into C2 external
  anchoring (the protected corpus), or both.

## Source of truth

The five Wave 1 findings above, their measured sites, and their
adjudications are recorded in full in
`docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.wave1-closure.json`. If
this backlog and that artifact ever appear to disagree, the closure
artifact controls.

AG-1's source is the ODS-M1F audit record; if this backlog and that
record ever appear to disagree, the audit record controls.

## Non-goals

This backlog does not fix, remediate, re-scope, or re-prioritize any of
the six findings above (five Wave 1, one ODS maintenance). It does not
create new authority and does not decide AG-1's future minimum decision.
It exists only so a future Wave 2, reengineering, or maintenance session
does not have to rediscover that these six items exist and remain open.
