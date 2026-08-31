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

## Source of truth

All five findings, their measured sites, and their adjudications are
recorded in full in
`docs/ops/fib/FIB_IMPLEMENTATION_BASELINE_v1.0.0.wave1-closure.json`. If
this backlog and that artifact ever appear to disagree, the closure
artifact controls.

## Non-goals

This backlog does not fix, remediate, re-scope, or re-prioritize any of
the five findings. It does not create new authority. It exists only so a
future Wave 2 or maintenance session does not have to rediscover that
these five items exist and remain open.
