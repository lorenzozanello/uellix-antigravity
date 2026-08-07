// tests/hosted/managed-policy-channel.test.ts
// TRAIN 5C2 — the determination, the boundary, and the attacks the instruction
// enumerated.
//
// The single most dangerous outcome available to this train was to declare the
// Supabase Dashboard a "management plane" because the interface exists, hand the
// operator three CREATE POLICY statements, and record Storage as solved. Most of
// what is asserted below exists to make that outcome fail a test.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  MANAGEMENT_PLANE_EVIDENCE,
  MANAGEMENT_PLANE_PATH,
  PSQL_SET_ROLE_PATH,
  SET_ROLE_PATH_VERIFIED,
  SQL_EDITOR_SET_ROLE_PATH,
  deriveManagedPolicySpec,
  evaluateBoundaryPreconditions,
  reconcileStorageBoundary,
  storageExecutionReadiness,
  type BoundaryPreconditions,
} from '@/db/hosted/managed-policy-channel'
import {
  EXPECTED_STORAGE_POLICIES,
  STORAGE_UNIT_SOURCE,
} from '@/db/hosted/storage-policy-artifact'
import { EXPECTED_STORAGE_POLICY_SURFACE } from '@/db/hosted/baseline-postconditions'

const ROOT = process.cwd()
const SOURCE = readFileSync(path.join(ROOT, STORAGE_UNIT_SOURCE), 'utf8').replace(/\r\n?/g, '\n')
const STAGING = 'bvyzblhqymxruxdguaee'

describe('the SQL channel is closed on both identities', () => {
  it('rejects the psql SET ROLE path', () => {
    expect(PSQL_SET_ROLE_PATH).toBe('REJECTED')
  })

  it('rejects the SQL Editor SET ROLE path', () => {
    expect(SQL_EDITOR_SET_ROLE_PATH).toBe('REJECTED')
  })

  // THE INSTRUCTION: "SET_ROLE_PATH_VERIFIED = false. No debe poder cambiar a
  // true." A mutable flag would satisfy the words and lose the property.
  it('pins SET_ROLE_PATH_VERIFIED false with no way to set it', () => {
    expect(SET_ROLE_PATH_VERIFIED).toBe(false)
    const readiness = storageExecutionReadiness({ managedBoundaryVerified: false, detail: 'nothing observed' })
    expect(readiness.ready).toBe(false)
  })

  it('closes Storage only through MANAGED_BOUNDARY_VERIFIED', () => {
    const ok = storageExecutionReadiness({ managedBoundaryVerified: true, detail: 'catalogue verified' })
    expect(ok.ready).toBe(true)
    if (ok.ready) expect(ok.via).toBe('MANAGED_BOUNDARY_VERIFIED')
  })
})

describe('the management-plane determination rests on primary sources', () => {
  it('does not treat the Dashboard as verified merely because it exists', () => {
    expect(MANAGEMENT_PLANE_PATH).not.toBe('VERIFIED')
  })

  it('holds at least two primary-source findings about the channel', () => {
    const primary = MANAGEMENT_PLANE_EVIDENCE.filter((e) => e.grade === 'primary')
    expect(primary.length).toBeGreaterThanOrEqual(2)
  })

  // The instruction: forums are hints, never final proof. #41126 is recorded
  // precisely because our own measurement contradicts it.
  it('grades the GitHub issue as a hint, not as evidence of capability', () => {
    const issue = MANAGEMENT_PLANE_EVIDENCE.find((e) => e.id === 'issue-41126-asymmetry')
    expect(issue?.grade).toBe('hint')
  })

  it('records that the only official answer is about ALTER TABLE, which we do not issue', () => {
    const official = MANAGEMENT_PLANE_EVIDENCE.find((e) => e.id === 'maintainer-answer-is-about-alter-table')
    expect(official?.grade).toBe('official-doc')
    expect(official?.bearing).toMatch(/does NOT cover our case/)
  })

  it('cites the Studio source that shows the UI compiling to raw SQL', () => {
    const src = MANAGEMENT_PLANE_EVIDENCE.filter((e) => e.source.includes('apps/studio'))
    expect(src.length).toBeGreaterThanOrEqual(2)
    expect(src.some((e) => e.finding.includes('executeSql'))).toBe(true)
    expect(src.some((e) => e.finding.includes('CREATE POLICY'))).toBe(true)
  })

  it('every evidence entry says what it bears on', () => {
    for (const e of MANAGEMENT_PLANE_EVIDENCE) {
      expect(e.source.length, e.id).toBeGreaterThan(10)
      expect(e.bearing.length, e.id).toBeGreaterThan(30)
    }
  })
})

describe('the operator receives derived fields, never a predicate to retype', () => {
  const spec = deriveManagedPolicySpec(SOURCE)

  it('derives exactly the three policies', () => {
    expect(spec.policies.map((p) => p.policyname).sort()).toEqual([...EXPECTED_STORAGE_POLICIES].sort())
  })

  it('targets storage.objects and nothing else', () => {
    for (const p of spec.policies) {
      expect(`${p.schema}.${p.table}`).toBe('storage.objects')
      expect(p.permissive).toBe('PERMISSIVE')
    }
  })

  it('carries roles, command and the predicate slot for each', () => {
    for (const expected of EXPECTED_STORAGE_POLICY_SURFACE) {
      const p = spec.policies.find((x) => x.policyname === expected.policyname)!
      expect(p.cmd).toBe(expected.cmd)
      expect(`{${p.roles.join(',')}}`).toBe(expected.roles)
      const slot = expected.predicateKind === 'qual' ? p.using : p.withCheck
      const other = expected.predicateKind === 'qual' ? p.withCheck : p.using
      expect(slot).toBeTruthy()
      expect(other).toBeNull()
    }
  })

  it('lists the four DROPs that precede them', () => {
    expect(spec.dropsFirst).toHaveLength(4)
    expect(spec.dropsFirst).toContain('update_evidence')
  })

  it('carries source hash, derived hash and the security surface digest', () => {
    expect(spec.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(spec.managedSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(spec.securitySurfaceDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  // THE PIN THAT MAKES THE BOUNDARY FALSIFIABLE. If the spec handed to the
  // operator could drift from the surface B0-16 checks afterwards, the check
  // would be verifying a different contract than the one that was executed.
  it('refuses to emit a spec that disagrees with the postcondition', () => {
    const widened = SOURCE.replace(
      "bucket_id = 'uellix-evidence' AND\n    public.can_read_evidence_object(name, auth.uid())",
      'true',
    )
    expect(widened).not.toBe(SOURCE)
    expect(() => deriveManagedPolicySpec(widened)).toThrow(/MANAGED_SPEC_DRIFT/)
  })

  it('refuses a source whose roles were widened', () => {
    const widened = SOURCE.replace(/TO authenticated/g, 'TO public')
    expect(() => deriveManagedPolicySpec(widened)).toThrow(/MANAGED_SPEC/)
  })

  it('refuses a source whose command changed', () => {
    const changed = SOURCE.replace('FOR DELETE', 'FOR ALL')
    expect(() => deriveManagedPolicySpec(changed)).toThrow(/MANAGED_SPEC/)
  })

  it('refuses a source that lost a policy', () => {
    const fewer = SOURCE.replace(/-- DELETE Policy[\s\S]*$/, '')
    expect(() => deriveManagedPolicySpec(fewer)).toThrow()
  })
})

describe('HUMAN_STORAGE_POLICY_BOUNDARY refuses to open on anything unproven', () => {
  const ok = (): BoundaryPreconditions => ({
    stagingProjectRef: STAGING,
    productionDenylistPass: true,
    artifactSourceShaPass: true,
    derivedShaPass: true,
    securitySurfaceDigestPass: true,
    expectedPolicyCount: 3,
    rlsAlreadyEnabledOnStorageObjects: true,
    targetTable: 'storage.objects',
    partAState: 'UNIT_41_HELPERS_APPLIED',
  })

  it('opens when every precondition holds', () => {
    expect(evaluateBoundaryPreconditions(ok())).toEqual({ open: true, problems: [] })
  })

  it.each([
    ['a production project ref', { stagingProjectRef: 'ctaxtgujyyprgynmnvtq' }, /KNOWN PRODUCTION/],
    ['a denylist that did not pass', { productionDenylistPass: false }, /denylist/],
    ['a drifted source hash', { artifactSourceShaPass: false }, /source hash/],
    ['a drifted derived hash', { derivedShaPass: false }, /derived/],
    ['a drifted security surface digest', { securitySurfaceDigestPass: false }, /digest/],
    ['a policy count other than three', { expectedPolicyCount: 2 }, /count/],
    ['RLS not measured', { rlsAlreadyEnabledOnStorageObjects: null }, /not measured/],
    ['RLS disabled', { rlsAlreadyEnabledOnStorageObjects: false }, /NOT enabled/],
    ['the wrong table', { targetTable: 'public.objects' }, /storage\.objects/],
    ['PART A not applied', { partAState: 'UNIT_41_NOT_STARTED' as const }, /42883|HELPERS_APPLIED/],
    // The boundary must not reopen over an already-complete unit: that would be
    // three more CREATE POLICY statements over three that already exist.
    ['a unit already complete', { partAState: 'UNIT_41_COMPLETE' as const }, /HELPERS_APPLIED/],
  ])('refuses to open on %s', (_label, over, pattern) => {
    const v = evaluateBoundaryPreconditions({ ...ok(), ...over })
    expect(v.open).toBe(false)
    expect(v.problems.join(' | ')).toMatch(pattern)
  })

  it('rejects the production ref specifically, not merely a malformed one', () => {
    const v = evaluateBoundaryPreconditions({ ...ok(), productionDenylistPass: false })
    expect(v.open).toBe(false)
  })
})

describe('reconciliation is the only path to MANUAL_BOUNDARY_VERIFIED', () => {
  const base = {
    helpersPresent: true,
    policyNamesPresent: [...EXPECTED_STORAGE_POLICIES],
    surfaceVerified: true as boolean | null,
    boundaryJournal: 'MANUAL_BOUNDARY_PENDING' as const,
    partAJournalled: true,
  }

  it('verifies when catalogue, surface and journal agree', () => {
    const r = reconcileStorageBoundary(base)
    expect(r.state).toBe('UNIT_41_COMPLETE')
    expect(r.managedBoundaryVerified).toBe(true)
    expect(r.journalTransition).toBe('MANUAL_BOUNDARY_VERIFIED')
    expect(r.problems).toEqual([])
  })

  // "El operador dijo que terminó" is not an input to this function.
  it('refuses when the surface was never measured', () => {
    const r = reconcileStorageBoundary({ ...base, surfaceVerified: null })
    expect(r.managedBoundaryVerified).toBe(false)
    expect(r.state).toBe('UNIT_41_POLICIES_APPLIED_UNVERIFIED')
    expect(r.problems.join(' ')).toMatch(/Names are not a surface/)
  })

  it('refuses 2 of 3 policies', () => {
    const r = reconcileStorageBoundary({
      ...base,
      policyNamesPresent: ['select_evidence', 'insert_evidence'],
      surfaceVerified: false,
    })
    expect(r.state).toBe('UNIT_41_FAILED')
    expect(r.managedBoundaryVerified).toBe(false)
  })

  it('refuses a measured-wrong surface even with all three names present', () => {
    const r = reconcileStorageBoundary({ ...base, surfaceVerified: false })
    expect(r.state).toBe('UNIT_41_FAILED')
    expect(r.managedBoundaryVerified).toBe(false)
  })

  it('refuses a journal that ran ahead of the catalogue', () => {
    const r = reconcileStorageBoundary({
      ...base,
      policyNamesPresent: [],
      surfaceVerified: null,
      boundaryJournal: 'MANUAL_BOUNDARY_VERIFIED',
    })
    expect(r.managedBoundaryVerified).toBe(false)
    expect(r.problems.join(' ')).toMatch(/ahead of the database/)
  })

  it('refuses an APPLIED PART A row with no helpers in pg_proc', () => {
    const r = reconcileStorageBoundary({
      ...base,
      helpersPresent: false,
      policyNamesPresent: [],
      surfaceVerified: null,
    })
    expect(r.problems.join(' ')).toMatch(/fabricated|cannot arise/)
    expect(r.managedBoundaryVerified).toBe(false)
  })

  it('refuses helpers that exist with no journal row — an ungoverned apply', () => {
    const r = reconcileStorageBoundary({ ...base, partAJournalled: false })
    expect(r.problems.join(' ')).toMatch(/outside the governed channel/)
    expect(r.managedBoundaryVerified).toBe(false)
  })

  it('does not re-transition an already verified boundary', () => {
    const r = reconcileStorageBoundary({ ...base, boundaryJournal: 'MANUAL_BOUNDARY_VERIFIED' })
    expect(r.managedBoundaryVerified).toBe(true)
    expect(r.journalTransition).toBeNull()
  })
})
