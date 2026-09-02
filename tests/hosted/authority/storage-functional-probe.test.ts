// tests/hosted/authority/storage-functional-probe.test.ts
// M-2 — the offline contract of the Storage functional probe.
//
// The behavioural half is MEASURED by both canonical certifications, which run
// this exact SQL against the final managed shape. What this file pins is the
// set of properties a diff could change silently — and, above all, the two
// ways this probe could become decoration:
//
//   by calling the helper directly instead of driving the policy, which returns
//   false for EVERY caller from a session with no JWT claim and would therefore
//   report DENY-for-all on a healthy database;
//
//   by losing a negative case, so that a widened role list, a dead read helper
//   or a broken organisation boundary stops being something the matrix can see.

import { describe, it, expect } from 'vitest'

import {
  STORAGE_FUNCTIONAL_FIXTURE_SQL,
  STORAGE_FUNCTIONAL_MATRIX,
  STORAGE_FUNCTIONAL_MATRIX_SQL,
  evaluateStorageFunctionalProbe,
  storageFunctionalNotRun,
  type StorageFunctionalObservation,
} from '@/db/hosted/authority/certification/storage-functional-probe'

/** The observation a healthy final shape produces, derived from the matrix. */
const healthy: StorageFunctionalObservation = Object.fromEntries(
  STORAGE_FUNCTIONAL_MATRIX.map((c) => [c.id, { write: c.expectedWrite, read: c.expectedRead }]),
)

describe('the matrix covers the contract, including every negative', () => {
  it('exercises the four canonical upload roles as ALLOW on write', () => {
    for (const id of ['super_admin', 'organization_admin', 'impact_manager', 'analyst']) {
      const c = STORAGE_FUNCTIONAL_MATRIX.find((x) => x.id === id)
      expect(c, `${id} is not in the matrix`).toBeDefined()
      expect(c!.expectedWrite, id).toBe('ALLOW')
    }
  })

  it('exercises reviewer and viewer as DENY on write but ALLOW on read', () => {
    // The asymmetry IS the contract: stella_0019 widens the WRITE list and
    // deliberately leaves the read helper admitting any active member. A matrix
    // that expected DENY on both would quietly certify a read helper that had
    // been narrowed, and one that expected ALLOW on both would certify an
    // upload path open to viewers.
    for (const id of ['reviewer', 'viewer']) {
      const c = STORAGE_FUNCTIONAL_MATRIX.find((x) => x.id === id)!
      expect(c.expectedWrite, id).toBe('DENY')
      expect(c.expectedRead, id).toBe('ALLOW')
    }
  })

  it('exercises inactive, absent and cross-org membership as DENY on both', () => {
    for (const id of ['inactive_membership', 'no_membership', 'cross_org']) {
      const c = STORAGE_FUNCTIONAL_MATRIX.find((x) => x.id === id)!
      expect(c.expectedWrite, id).toBe('DENY')
      expect(c.expectedRead, id).toBe('DENY')
    }
  })

  it('carries a POSITIVE control for the organisation boundary', () => {
    // Without it, `cross_org DENY` is equally consistent with a broken user, a
    // broken fixture, or a totally dead surface — which is exactly how a total
    // outage passed for a working isolation boundary. The same user, their own
    // project, must be ALLOWED.
    const denied = STORAGE_FUNCTIONAL_MATRIX.find((c) => c.id === 'cross_org')!
    const allowed = STORAGE_FUNCTIONAL_MATRIX.find((c) => c.id === 'cross_org_own_project')!
    expect(allowed.userId).toBe(denied.userId)
    expect(allowed.project).not.toBe(denied.project)
    expect(allowed.expectedWrite).toBe('ALLOW')
    expect(denied.expectedWrite).toBe('DENY')
  })

  it('cannot be all-ALLOW or all-DENY, in either direction', () => {
    // A matrix whose every case expects the same answer cannot distinguish a
    // working surface from a dead one — which is the defect, restated.
    for (const op of ['expectedWrite', 'expectedRead'] as const) {
      const values = new Set(STORAGE_FUNCTIONAL_MATRIX.map((c) => c[op]))
      expect(values, op).toEqual(new Set(['ALLOW', 'DENY']))
    }
  })

  it('gives every case a reason a reviewer can check it against', () => {
    for (const c of STORAGE_FUNCTIONAL_MATRIX) {
      expect(c.why.length, c.id).toBeGreaterThan(60)
    }
  })
})

describe('the SQL drives the POLICY, not the function', () => {
  it('becomes `authenticated` and sets a real request.jwt.claim.sub', () => {
    expect(STORAGE_FUNCTIONAL_FIXTURE_SQL).toContain("SET LOCAL ROLE authenticated")
    expect(STORAGE_FUNCTIONAL_FIXTURE_SQL).toContain("set_config('request.jwt.claim.sub'")
  })

  it('writes through storage.objects rather than calling the helper bare', () => {
    // THE ATTACK: `SELECT can_write_evidence_object(...)` from an unclaimed
    // session returns false for everyone, healthy database or not, because RLS
    // on projects/organization_members filters the definer by auth.uid(). A
    // probe shaped that way reports DENY-for-all and cannot be told apart from
    // the real outage. Measured both ways before this probe was written.
    expect(STORAGE_FUNCTIONAL_FIXTURE_SQL).toMatch(/INSERT INTO storage\.objects/)
    expect(STORAGE_FUNCTIONAL_FIXTURE_SQL).toMatch(/FROM storage\.objects/)
    for (const sql of [STORAGE_FUNCTIONAL_FIXTURE_SQL, STORAGE_FUNCTIONAL_MATRIX_SQL]) {
      expect(sql).not.toMatch(/SELECT\s+public\.can_(read|write)_evidence_object/)
    }
  })

  it('probes with SECURITY INVOKER functions, never DEFINER', () => {
    // A definer would evaluate the policy with the harness's privileges and
    // answer ALLOW for everything — the one result this probe must not be able
    // to produce by construction.
    expect(STORAGE_FUNCTIONAL_FIXTURE_SQL).not.toMatch(/SECURITY\s+DEFINER/i)
  })

  it('renders every declared case into the matrix query, and no others', () => {
    // Generated from the same array the assertions read, so a case cannot be
    // expected in one place and exercised in another.
    for (const c of STORAGE_FUNCTIONAL_MATRIX) {
      expect(STORAGE_FUNCTIONAL_MATRIX_SQL, c.id).toContain(`('${c.id}', '${c.userId}'::uuid, '${c.project}')`)
    }
    const rendered = [...STORAGE_FUNCTIONAL_MATRIX_SQL.matchAll(/\('([a-z_]+)', '[0-9a-f-]+'::uuid/g)]
    expect(rendered.map((m) => m[1])).toEqual(STORAGE_FUNCTIONAL_MATRIX.map((c) => c.id))
  })

  it('projects exactly one JSON document, so the strict readers are a real check', () => {
    expect(STORAGE_FUNCTIONAL_MATRIX_SQL).toMatch(/json_object_agg/)
    expect(STORAGE_FUNCTIONAL_MATRIX_SQL.match(/;/g) ?? []).toHaveLength(1)
  })

  it('gives the inactive member a role the write list ACCEPTS', () => {
    // organization_admin + status=inactive. A fixture that made the inactive
    // user a `viewer` would be testing the role filter twice and the status
    // filter never.
    expect(STORAGE_FUNCTIONAL_FIXTURE_SQL).toMatch(
      /'77777777-0000-4000-8000-000000000007', 'organization_admin', 'inactive'/,
    )
  })

  it('gives the cross-org user an ACTIVE admin membership of the OTHER org', () => {
    expect(STORAGE_FUNCTIONAL_FIXTURE_SQL).toMatch(
      /'b0000000[0-9a-f-]*', '99999999-0000-4000-8000-000000000009', 'organization_admin', 'active'/,
    )
  })

  it('creates no membership row at all for the no-membership case', () => {
    expect(STORAGE_FUNCTIONAL_FIXTURE_SQL).not.toMatch(
      /organization_members[\s\S]*'88888888-0000-4000-8000-000000000008'/,
    )
    // but the USER exists, so the case measures "no membership" and not
    // "no user", which a foreign key would have decided for us.
    expect(STORAGE_FUNCTIONAL_FIXTURE_SQL).toContain("('88888888-0000-4000-8000-000000000008'")
  })
})

describe('the evaluation cannot be talked into a pass', () => {
  it('passes on the healthy observation', () => {
    const result = evaluateStorageFunctionalProbe(healthy)
    expect(result.ran).toBe(true)
    expect(result.passed).toBe(true)
    expect(result.mismatches).toHaveLength(0)
  })

  it('FAILS on the exact outage M-2 measured — every case denied', () => {
    const dead = Object.fromEntries(
      STORAGE_FUNCTIONAL_MATRIX.map((c) => [c.id, { write: 'DENY', read: 'DENY' }]),
    )
    const result = evaluateStorageFunctionalProbe(dead)
    expect(result.passed).toBe(false)
    // Every ALLOW in the matrix is a mismatch; the DENYs are not.
    const expectedAllows = STORAGE_FUNCTIONAL_MATRIX.filter((c) => c.expectedWrite === 'ALLOW').length +
      STORAGE_FUNCTIONAL_MATRIX.filter((c) => c.expectedRead === 'ALLOW').length
    expect(result.mismatches).toHaveLength(expectedAllows)
  })

  it('FAILS when reviewer gains write — a widened role list', () => {
    const widened = { ...healthy, reviewer: { write: 'ALLOW', read: 'ALLOW' } }
    const result = evaluateStorageFunctionalProbe(widened)
    expect(result.passed).toBe(false)
    expect(result.mismatches.map((m) => `${m.caseId}.${m.operation}`)).toContain('reviewer.write')
  })

  it('FAILS when cross-org gains write — a broken organisation boundary', () => {
    const leaked = { ...healthy, cross_org: { write: 'ALLOW', read: 'DENY' } }
    expect(evaluateStorageFunctionalProbe(leaked).passed).toBe(false)
  })

  it('FAILS when the READ helper is silently dead but writes still work', () => {
    // The half Fable did not report and the half a write-only probe would miss.
    const readDead = Object.fromEntries(
      STORAGE_FUNCTIONAL_MATRIX.map((c) => [c.id, { write: c.expectedWrite, read: 'DENY' }]),
    )
    const result = evaluateStorageFunctionalProbe(readDead)
    expect(result.passed).toBe(false)
    expect(result.mismatches.every((m) => m.operation === 'read')).toBe(true)
  })

  it('FAILS when a case is MISSING, so deleting a row is not a way to pass it', () => {
    for (const c of STORAGE_FUNCTIONAL_MATRIX) {
      const rest = Object.fromEntries(
        Object.entries(healthy).filter(([id]) => id !== c.id),
      )
      const result = evaluateStorageFunctionalProbe(rest)
      expect(result.passed, `dropping ${c.id} still passed`).toBe(false)
      expect(result.mismatches.every((m) => m.caseId === c.id)).toBe(true)
      expect(result.mismatches.map((m) => m.observed)).toContain('NOT_OBSERVED')
    }
  })

  it('FAILS on an empty observation rather than passing vacuously', () => {
    expect(evaluateStorageFunctionalProbe({}).passed).toBe(false)
  })

  it('records a probe that did not run as a FAILURE, never as a pass', () => {
    const skipped = storageFunctionalNotRun('the chain did not complete')
    expect(skipped.ran).toBe(false)
    expect(skipped.passed).toBe(false)
    expect(skipped.detail).toContain('NOT RUN')
  })

  it('names the case, the operation and both answers in every mismatch', () => {
    // A failure a reader cannot act on sends them to the wrong place.
    const result = evaluateStorageFunctionalProbe({ ...healthy, analyst: { write: 'DENY', read: 'ALLOW' } })
    const m = result.mismatches[0]!
    expect(m.caseId).toBe('analyst')
    expect(m.operation).toBe('write')
    expect(m.expected).toBe('ALLOW')
    expect(m.observed).toBe('DENY')
    expect(m.why.length).toBeGreaterThan(60)
    expect(result.detail).toContain('analyst.write expected ALLOW, observed DENY')
  })

  it('declares what is shimmed beside the result', () => {
    // So a reader can tell what the pass is worth without leaving the artefact.
    expect(evaluateStorageFunctionalProbe(healthy).shimNote).toContain('storage.objects is the four-column shim')
  })
})
