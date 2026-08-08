// tests/hosted/storage-capability-probe.test.ts
// TRAIN 5C2 — the probe that must measure ONE thing.
//
// Two failures are available here and both are quiet. The first is a probe that
// accidentally grants access — a single word (RESTRICTIVE, or a predicate other
// than `false`) turns a no-op into either an open door or an outage. The second
// is a probe whose failure has more than one explanation, which is what using a
// canonical Uellix policy would have produced: PART A is not applied, so 42883 on
// a missing helper is indistinguishable from a channel that cannot create
// policies at all.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  CAPABILITY_PROBE_ARTEFACT,
  CAPABILITY_PROBE_CLEANUP_SQL,
  CAPABILITY_PROBE_FIELDS,
  CAPABILITY_PROBE_FORBIDDEN_FALLBACKS,
  CAPABILITY_PROBE_OPERATOR_STEPS,
  CAPABILITY_PROBE_POLICY,
  CAPABILITY_PROBE_POSTCONDITION_SQL,
  CAPABILITY_PROBE_PRECONDITION_SQL,
  CAPABILITY_PROBE_SQL,
  CAPABILITY_PROBE_STATUS_ARTEFACT,
  buildCapabilityProbeRecord,
  evaluateCapabilityProbeArtefact,
  evaluateCapabilityPrecondition,
  interpretCapabilityOutcome,
  reconcileCapabilityRecord,
  sanitizeProbeError,
  verifyCapabilityCleanup,
  verifyCapabilityProbeSurface,
  type CapabilityPrecondition,
  type CapabilityProbeArtefact,
  type ObservedPolicyRow,
} from '@/db/hosted/storage-capability-probe'
import { EXPECTED_STORAGE_POLICIES } from '@/db/hosted/storage-policy-artifact'
import { verifyStoragePolicySurface } from '@/db/hosted/baseline-postconditions'

const STAGING = 'bvyzblhqymxruxdguaee'

describe('the temporary policy cannot grant access', () => {
  it('is PERMISSIVE with USING (false) — a no-op disjunct', () => {
    expect(CAPABILITY_PROBE_FIELDS.permissive).toBe('PERMISSIVE')
    expect(CAPABILITY_PROBE_FIELDS.using).toBe('false')
    expect(CAPABILITY_PROBE_FIELDS.withCheck).toBeNull()
  })

  // PERMISSIVE policies OR together, so a `false` disjunct adds nothing.
  // RESTRICTIVE ones AND together, so the same predicate can only REMOVE access
  // — nothing today, because there are no permissive policies to prune, and
  // everything once the canonical three exist. A probe whose effect depends on
  // when it runs is not the monotone probe that was designed.
  it('states AS PERMISSIVE explicitly rather than relying on the default', () => {
    expect(CAPABILITY_PROBE_SQL).toContain('AS PERMISSIVE')
    expect(CAPABILITY_PROBE_SQL).not.toMatch(/RESTRICTIVE/i)
  })

  it('is SELECT only', () => {
    expect(CAPABILITY_PROBE_FIELDS.cmd).toBe('SELECT')
    expect(CAPABILITY_PROBE_SQL).toMatch(/FOR SELECT/)
    expect(CAPABILITY_PROBE_SQL).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)/i)
  })

  it('names no helper, no auth.uid(), no bucket and no Uellix function', () => {
    for (const forbidden of [
      'can_read_evidence_object',
      'can_write_evidence_object',
      'auth.uid',
      'bucket_id',
      'uellix-evidence',
      'public.',
    ]) {
      expect(CAPABILITY_PROBE_SQL, forbidden).not.toContain(forbidden)
    }
  })

  it('targets storage.objects and the same role the canonical policies use', () => {
    expect(CAPABILITY_PROBE_SQL).toContain('ON storage.objects')
    expect(CAPABILITY_PROBE_FIELDS.roles).toEqual(['authenticated'])
  })

  it('never widens a role beyond authenticated', () => {
    expect(CAPABILITY_PROBE_SQL).not.toMatch(/TO (public|anon|service_role)/i)
  })

  it('contains no escalation of any kind', () => {
    const sql = `${CAPABILITY_PROBE_SQL}\n${CAPABILITY_PROBE_CLEANUP_SQL}`
    for (const forbidden of ['SET ROLE', 'ALTER TABLE', 'GRANT', 'BYPASSRLS', 'service_role', 'OWNER TO']) {
      expect(sql, forbidden).not.toContain(forbidden)
    }
  })
})

describe('the name cannot be confused with the canonical surface', () => {
  it('is not one of the three canonical names', () => {
    expect(EXPECTED_STORAGE_POLICIES).not.toContain(CAPABILITY_PROBE_POLICY)
  })

  it('does not adopt the canonical _evidence shape', () => {
    expect(CAPABILITY_PROBE_POLICY).not.toMatch(/_evidence$/)
  })

  it('announces itself as temporary, ours, and dated', () => {
    expect(CAPABILITY_PROBE_POLICY).toMatch(/^uellix_tmp_/)
    expect(CAPABILITY_PROBE_POLICY).toMatch(/\d{8}$/)
  })

  // LEAVING IT BEHIND MUST FAIL B0-16. If the probe survived into the baseline,
  // an extra PERMISSIVE policy would sit on storage.objects unnoticed — and this
  // repository has already been bitten once by an extras filter that only looked
  // at names ending in `_evidence`.
  it('fails the baseline storage postcondition if it is still present', () => {
    const canonical: ObservedPolicyRow[] = []
    const verdict = verifyStoragePolicySurface([
      {
        schemaname: 'storage',
        tablename: 'objects',
        policyname: CAPABILITY_PROBE_POLICY,
        roles: '{authenticated}',
        cmd: 'SELECT',
        qual: 'false',
        withCheck: null,
      },
      ...canonical,
    ])
    expect(verdict.passed).toBe(false)
    expect(verdict.detail).toMatch(/nothing in this repository generates/)
  })
})

describe('the precondition refuses everything that would make the answer ambiguous', () => {
  const ok = (): CapabilityPrecondition => ({
    projectRef: STAGING,
    declaredEnvironment: 'staging',
    tableExists: true,
    rlsEnabled: true,
    probeAlreadyPresent: false,
    existingPolicyCount: 0,
    existingPolicyNames: [],
  })

  it('passes on a clean staging target', () => {
    expect(evaluateCapabilityPrecondition(ok())).toEqual({ ok: true, problems: [] })
  })

  it.each([
    ['a production project ref', { projectRef: 'ctaxtgujyyprgynmnvtq' }, /KNOWN PRODUCTION/],
    ['a malformed project ref', { projectRef: 'nope' }, /project ref/],
    ['a non-staging environment', { declaredEnvironment: 'production' }, /not 'staging'/],
    ['an unmeasured table', { tableExists: null }, /not measured/],
    ['a missing table', { tableExists: false }, /does not exist/],
    ['unmeasured RLS', { rlsEnabled: null }, /not measured/],
    ['RLS disabled', { rlsEnabled: false }, /NOT enabled/],
    // A stale probe makes CREATE fail with 42710, which reads exactly like "the
    // channel cannot create policies" — the opposite conclusion.
    ['a stale probe of the same name', { probeAlreadyPresent: true }, /ALREADY EXISTS/],
    ['an unchecked probe name', { probeAlreadyPresent: null }, /not checked/],
    ['no pre-probe inventory', { existingPolicyCount: null }, /inventory was not taken/],
    ['no pre-probe names', { existingPolicyNames: null }, /inventory was not taken/],
    ['a count that disagrees with the names', { existingPolicyCount: 3, existingPolicyNames: ['a'] }, /disagrees/],
  ])('refuses %s', (_label, over, pattern) => {
    const v = evaluateCapabilityPrecondition({ ...ok(), ...over })
    expect(v.ok).toBe(false)
    expect(v.problems.join(' | ')).toMatch(pattern)
  })

  // The probe is for a project where the canonical policies are NOT installed.
  it('refuses once the canonical Uellix policies already exist', () => {
    const v = evaluateCapabilityPrecondition({
      ...ok(),
      existingPolicyCount: 3,
      existingPolicyNames: [...EXPECTED_STORAGE_POLICIES],
    })
    expect(v.ok).toBe(false)
    expect(v.problems.join(' ')).toMatch(/already present/)
  })

  it('reads only — the precondition SQL writes nothing', () => {
    for (const forbidden of ['CREATE', 'DROP', 'ALTER', 'INSERT', 'UPDATE', 'DELETE', 'GRANT']) {
      expect(CAPABILITY_PROBE_PRECONDITION_SQL.toUpperCase(), forbidden).not.toContain(`${forbidden} `)
    }
    expect(CAPABILITY_PROBE_PRECONDITION_SQL).toMatch(/existing_policy_count/)
    expect(CAPABILITY_PROBE_PRECONDITION_SQL).toContain(CAPABILITY_PROBE_POLICY)
  })
})

describe('the postcondition compares the surface, not the name', () => {
  const conforming = (): ObservedPolicyRow[] => [
    {
      schemaname: 'storage',
      tablename: 'objects',
      policyname: CAPABILITY_PROBE_POLICY,
      permissive: 'PERMISSIVE',
      roles: '{authenticated}',
      cmd: 'SELECT',
      qual: 'false',
      withCheck: null,
    },
  ]

  it('passes on the exact designed policy', () => {
    const v = verifyCapabilityProbeSurface(conforming())
    expect(v.ok, v.problems.join(' | ')).toBe(true)
  })

  it.each([
    ['an absent policy', () => [], /absent/],
    ['USING (true)', (p: ObservedPolicyRow[]) => [{ ...p[0], qual: 'true' }], /expected 'false'/],
    ['a widened predicate', (p: ObservedPolicyRow[]) => [{ ...p[0], qual: '(false) OR true' }], /expected 'false'/],
    ['an emptied predicate', (p: ObservedPolicyRow[]) => [{ ...p[0], qual: null }], /expected 'false'/],
    ['a widened role', (p: ObservedPolicyRow[]) => [{ ...p[0], roles: '{public}' }], /expected \{authenticated\}/],
    ['the wrong command', (p: ObservedPolicyRow[]) => [{ ...p[0], cmd: 'ALL' }], /expected SELECT/],
    // The catastrophic one: same eight words, opposite meaning.
    ['a RESTRICTIVE policy', (p: ObservedPolicyRow[]) => [{ ...p[0], permissive: 'RESTRICTIVE' }], /can only ever REMOVE access/],
    ['an acquired WITH CHECK', (p: ObservedPolicyRow[]) => [{ ...p[0], withCheck: 'true' }], /expected NULL/],
    ['the wrong schema', (p: ObservedPolicyRow[]) => [{ ...p[0], schemaname: 'public' }], /absent/],
    ['the wrong table', (p: ObservedPolicyRow[]) => [{ ...p[0], tablename: 'buckets' }], /absent/],
  ])('refuses %s', (_label, mutate, pattern) => {
    const v = verifyCapabilityProbeSurface(mutate(conforming()))
    expect(v.ok).toBe(false)
    expect(v.problems.join(' | ')).toMatch(pattern)
  })

  it('does not reduce to EXISTS(policyname)', () => {
    const nameOnly = conforming().map((p) => ({ ...p, qual: 'true', roles: '{public}', cmd: 'ALL' }))
    expect(verifyCapabilityProbeSurface(nameOnly).ok).toBe(false)
  })

  it('does not match by substring', () => {
    const nearName = conforming().map((p) => ({ ...p, policyname: `${CAPABILITY_PROBE_POLICY}_x` }))
    expect(verifyCapabilityProbeSurface(nearName).ok).toBe(false)
  })

  it('reads only', () => {
    for (const forbidden of ['CREATE ', 'DROP ', 'ALTER ', 'INSERT ', 'DELETE ']) {
      expect(CAPABILITY_PROBE_POSTCONDITION_SQL.toUpperCase()).not.toContain(forbidden)
    }
  })
})

describe('cleanup is verified by more than the probe being gone', () => {
  const row = (name: string, over: Partial<ObservedPolicyRow> = {}): ObservedPolicyRow => ({
    schemaname: 'storage',
    tablename: 'objects',
    policyname: name,
    permissive: 'PERMISSIVE',
    roles: '{authenticated}',
    cmd: 'SELECT',
    qual: 'false',
    withCheck: null,
    ...over,
  })

  it('passes when exactly the probe was removed', () => {
    const r = verifyCapabilityCleanup({ before: [row('keep_me')], after: [row('keep_me')] })
    expect(r.outcome).toBe('CAPABILITY_PROBE_CLEANED')
    expect(r.problems).toEqual([])
  })

  it('blocks when the probe is still present', () => {
    const r = verifyCapabilityCleanup({ before: [], after: [row(CAPABILITY_PROBE_POLICY)] })
    expect(r.outcome).toBe('BLOCKED_MANAGEMENT_CHANNEL_CLEANUP')
    expect(r.problems.join(' ')).toMatch(/STILL PRESENT/)
  })

  // ABSENCE ALONE IS NOT CLEANUP. A DROP that took a pre-existing policy with it
  // leaves the probe absent too, and a check that only asked "is the probe gone"
  // would call that a success.
  it('blocks when cleanup also removed a pre-existing policy', () => {
    const r = verifyCapabilityCleanup({ before: [row('platform_policy')], after: [] })
    expect(r.outcome).toBe('BLOCKED_MANAGEMENT_CHANNEL_CLEANUP')
    expect(r.problems.join(' ')).toMatch(/also removed/)
  })

  // NAMES ARE NOT ROWS. A drop-and-recreate of a pre-existing policy with a
  // different predicate leaves the name SET identical — which is all the first
  // version compared.
  it('blocks when a pre-existing policy survived by name but changed its predicate', () => {
    const r = verifyCapabilityCleanup({
      before: [row('platform_policy', { qual: "bucket_id = 'x'" })],
      after: [row('platform_policy', { qual: 'true' })],
    })
    expect(r.outcome).toBe('BLOCKED_MANAGEMENT_CHANNEL_CLEANUP')
    expect(r.problems.join(' ')).toMatch(/survived by NAME/)
  })

  it('blocks when a pre-existing policy widened its roles', () => {
    const r = verifyCapabilityCleanup({
      before: [row('platform_policy')],
      after: [row('platform_policy', { roles: '{public}' })],
    })
    expect(r.outcome).toBe('BLOCKED_MANAGEMENT_CHANNEL_CLEANUP')
  })

  it('blocks when something unexpected appeared — including a suffixed name', () => {
    const r = verifyCapabilityCleanup({
      before: [],
      after: [row(`${CAPABILITY_PROBE_POLICY} abc_0`)],
    })
    expect(r.outcome).toBe('BLOCKED_MANAGEMENT_CHANNEL_CLEANUP')
    expect(r.problems.join(' ')).toMatch(/unexpected/)
  })
})

describe('the record must agree with the catalogue', () => {
  const probeRow: ObservedPolicyRow = {
    schemaname: 'storage',
    tablename: 'objects',
    policyname: CAPABILITY_PROBE_POLICY,
    permissive: 'PERMISSIVE',
    roles: '{authenticated}',
    cmd: 'SELECT',
    qual: 'false',
    withCheck: null,
  }
  const rec = (outcome: 'CAPABILITY_PROBE_CREATE_SUCCEEDED' | 'CAPABILITY_PROBE_CREATE_FAILED') =>
    buildCapabilityProbeRecord({
      outcome,
      rawError: outcome === 'CAPABILITY_PROBE_CREATE_FAILED' ? 'timeout' : undefined,
      timestamp: '2026-08-07T00:00:00Z',
      projectRef: STAGING,
    })

  it('accepts a SUCCEEDED record with the policy present', () => {
    expect(reconcileCapabilityRecord({ record: rec('CAPABILITY_PROBE_CREATE_SUCCEEDED'), observed: [probeRow] }).ok).toBe(true)
  })

  it('accepts a FAILED record with the policy absent', () => {
    expect(reconcileCapabilityRecord({ record: rec('CAPABILITY_PROBE_CREATE_FAILED'), observed: [] }).ok).toBe(true)
  })

  // The UI timed out AFTER the server committed. Reading REJECTED from that
  // record would conclude the channel cannot create policies while the catalogue
  // shows it just did — and would leave the probe behind.
  it('refuses a FAILED record while the policy exists', () => {
    const v = reconcileCapabilityRecord({ record: rec('CAPABILITY_PROBE_CREATE_FAILED'), observed: [probeRow] })
    expect(v.ok).toBe(false)
    expect(v.problems.join(' ')).toMatch(/Do NOT conclude REJECTED/)
  })

  it('refuses a SUCCEEDED record while the policy is absent', () => {
    const v = reconcileCapabilityRecord({ record: rec('CAPABILITY_PROBE_CREATE_SUCCEEDED'), observed: [] })
    expect(v.ok).toBe(false)
    expect(v.problems.join(' ')).toMatch(/suffix generated policy names|did not perform/)
  })
})

describe('the interpretation keeps capability and correctness apart', () => {
  const record = (outcome: 'CAPABILITY_PROBE_CREATE_SUCCEEDED' | 'CAPABILITY_PROBE_CREATE_FAILED', error = '') => ({
    outcome,
    error,
    timestamp: '2026-08-07T00:00:00Z',
    projectRef: STAGING,
    policyName: CAPABILITY_PROBE_POLICY,
  })

  it('never claims the canonical policies are proven, in either direction', () => {
    expect(interpretCapabilityOutcome(record('CAPABILITY_PROBE_CREATE_SUCCEEDED')).canonicalPoliciesProven).toBe(false)
    expect(interpretCapabilityOutcome(record('CAPABILITY_PROBE_CREATE_FAILED', '42501')).canonicalPoliciesProven).toBe(false)
  })

  it('does not reach VERIFIED on a successful CREATE alone — cleanup is pending', () => {
    const i = interpretCapabilityOutcome(record('CAPABILITY_PROBE_CREATE_SUCCEEDED'))
    expect(i.managementPlanePath).toBe('CAPABILITY_DEMONSTRATED_PENDING_CLEANUP')
    expect(i.detail).toMatch(/Not complete until cleanup is verified/)
  })

  it('rejects the path on failure and forbids every escalation by name', () => {
    const i = interpretCapabilityOutcome(record('CAPABILITY_PROBE_CREATE_FAILED', 'must be owner of table objects'))
    expect(i.managementPlanePath).toBe('REJECTED')
    for (const forbidden of ['service_role', 'supabase_privileged_role', 'SET ROLE', 'BYPASSRLS']) {
      expect(i.detail, forbidden).toContain(forbidden)
    }
  })

  it('enumerates the forbidden fallbacks so they are testable, not merely prose', () => {
    expect(CAPABILITY_PROBE_FORBIDDEN_FALLBACKS).toContain('service_role')
    expect(CAPABILITY_PROBE_FORBIDDEN_FALLBACKS).toContain('supabase_privileged_role')
    expect(CAPABILITY_PROBE_FORBIDDEN_FALLBACKS).toContain('BYPASSRLS')
  })
})

describe('a record cannot be built around the sanitizer', () => {
  const at = '2026-08-07T00:00:00Z'

  it('sanitizes on construction, so an unsanitized record cannot exist', () => {
    const r = buildCapabilityProbeRecord({
      outcome: 'CAPABILITY_PROBE_CREATE_FAILED',
      rawError: 'denied: postgresql://postgres:hunter2@db.abc.supabase.co:5432/postgres',
      timestamp: at,
      projectRef: STAGING,
    })
    expect(r.error).toContain('[REDACTED]')
    expect(r.error).not.toContain('hunter2')
    expect(r.policyName).toBe(CAPABILITY_PROBE_POLICY)
  })

  it('refuses a SUCCEEDED record carrying an error', () => {
    expect(() =>
      buildCapabilityProbeRecord({
        outcome: 'CAPABILITY_PROBE_CREATE_SUCCEEDED',
        rawError: 'must be owner of table objects',
        timestamp: at,
        projectRef: STAGING,
      }),
    ).toThrow(/CAPABILITY_RECORD_INCONSISTENT/)
  })

  // A failure with no message is a failure nobody can interpret: "must be owner
  // of table objects" and a network timeout mean opposite things here.
  it('refuses a FAILED record carrying no error text', () => {
    expect(() =>
      buildCapabilityProbeRecord({ outcome: 'CAPABILITY_PROBE_CREATE_FAILED', timestamp: at, projectRef: STAGING }),
    ).toThrow(/CAPABILITY_RECORD_INCONSISTENT/)
  })

  it('refuses a record naming a production project', () => {
    expect(() =>
      buildCapabilityProbeRecord({
        outcome: 'CAPABILITY_PROBE_CREATE_SUCCEEDED',
        timestamp: at,
        projectRef: 'ctaxtgujyyprgynmnvtq',
      }),
    ).toThrow(/KNOWN PRODUCTION/)
  })
})

describe('the recorded outcome carries no secret', () => {
  it.each([
    ['a connection string', 'failed: postgresql://postgres:hunter2@db.abc.supabase.co:5432/postgres'],
    ['a JWT', 'error eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.Zm9vYmFy'],
    ['a Supabase key', 'denied for sbp_0123456789abcdef'],
    ['an inline secret', 'api_key=abcdef123456'],
  ])('redacts %s', (_label, raw) => {
    const out = sanitizeProbeError(raw)
    expect(out).toContain('[REDACTED]')
    expect(out).not.toMatch(/hunter2|eyJhbGciOiJIUzI1NiJ9|sbp_0123456789abcdef|abcdef123456/)
  })

  it('keeps the diagnostic text, which is the whole point of recording it', () => {
    expect(sanitizeProbeError('ERROR: must be owner of table objects (42501)')).toContain(
      'must be owner of table objects',
    )
  })

  it('bounds the length so a UI dump cannot become the record', () => {
    expect(sanitizeProbeError('x'.repeat(5000)).length).toBeLessThanOrEqual(500)
  })
})

describe('the probe result is derived from an artefact, not asserted in prose', () => {
  const good = (): CapabilityProbeArtefact => ({
    precondition: {
      projectRef: STAGING,
      declaredEnvironment: 'staging',
      tableExists: true,
      rlsEnabled: true,
      probeAlreadyPresent: false,
      existingPolicyCount: 0,
      existingPolicyNames: [],
    },
    record: {
      outcome: 'CAPABILITY_PROBE_CREATE_SUCCEEDED',
      timestamp: '2026-08-07T00:00:00Z',
      projectRef: STAGING,
    },
    afterCreate: [
      {
        schemaname: 'storage',
        tablename: 'objects',
        policyname: CAPABILITY_PROBE_POLICY,
        permissive: 'PERMISSIVE',
        roles: '{authenticated}',
        cmd: 'SELECT',
        qual: 'false',
        withCheck: null,
      },
    ],
    afterCleanup: [],
  })

  // ABSENT IS NOT PASSED, AND IT IS NOT FAILED EITHER.
  it('reports NOT_RUN when no artefact exists', () => {
    const v = evaluateCapabilityProbeArtefact(null)
    expect(v.state).toBe('CAPABILITY_PROBE_NOT_RUN')
    expect(v.canonicalPoliciesProven).toBe(false)
  })

  it('reaches COMPLETE only through precondition, record, surface AND cleanup', () => {
    expect(evaluateCapabilityProbeArtefact(good()).state).toBe('CAPABILITY_PROBE_COMPLETE')
  })

  it('never claims the canonical policies are proven, in any state', () => {
    for (const artefact of [null, {}, good(), { ...good(), afterCleanup: undefined }]) {
      expect(evaluateCapabilityProbeArtefact(artefact).canonicalPoliciesProven).toBe(false)
    }
  })

  it.each([
    ['a refused precondition', { precondition: { projectRef: 'ctaxtgujyyprgynmnvtq' } }, 'CAPABILITY_PROBE_PRECONDITION_REFUSED'],
    ['no post-CREATE observation', { afterCreate: undefined }, 'CAPABILITY_PROBE_INCONSISTENT_RECORD'],
    ['no post-cleanup observation', { afterCleanup: undefined }, 'BLOCKED_MANAGEMENT_CHANNEL_CLEANUP'],
    ['a probe left behind', { afterCleanup: [{ schemaname: 'storage', tablename: 'objects', policyname: CAPABILITY_PROBE_POLICY, permissive: 'PERMISSIVE', roles: '{authenticated}', cmd: 'SELECT', qual: 'false', withCheck: null }] }, 'BLOCKED_MANAGEMENT_CHANNEL_CLEANUP'],
    ['a widened surface', { afterCreate: [{ schemaname: 'storage', tablename: 'objects', policyname: CAPABILITY_PROBE_POLICY, permissive: 'PERMISSIVE', roles: '{authenticated}', cmd: 'SELECT', qual: 'true', withCheck: null }] }, 'CAPABILITY_PROBE_SURFACE_MISMATCH'],
    ['a SUCCEEDED record with nothing in the catalogue', { afterCreate: [] }, 'CAPABILITY_PROBE_INCONSISTENT_RECORD'],
  ] as const)('refuses %s', (_label, over, expected) => {
    expect(evaluateCapabilityProbeArtefact({ ...good(), ...over }).state).toBe(expected)
  })

  it('reports CREATE_FAILED without ever reaching COMPLETE', () => {
    const v = evaluateCapabilityProbeArtefact({
      ...good(),
      record: { outcome: 'CAPABILITY_PROBE_CREATE_FAILED', rawError: 'must be owner of table objects', timestamp: '2026-08-07T00:00:00Z', projectRef: STAGING },
      afterCreate: [],
    })
    expect(v.state).toBe('CAPABILITY_PROBE_CREATE_FAILED')
    expect(v.problems.join(' ')).toMatch(/DO NOT retry through service_role/)
  })

  // THE FULL-ROW CLEANUP CHECK IS ONLY REAL IF THE `before` SIDE HAS REAL ROWS.
  // Reconstructing `before` from names with blank fields and then blanking the
  // `after` side to match silenced the field comparison exactly when there WERE
  // pre-existing policies to protect.
  it('catches a drop-and-recreate of a pre-existing policy when rows were captured', () => {
    const platform: ObservedPolicyRow = {
      schemaname: 'storage',
      tablename: 'objects',
      policyname: 'platform_policy',
      permissive: 'PERMISSIVE',
      roles: '{authenticated}',
      cmd: 'SELECT',
      qual: "bucket_id = 'x'",
      withCheck: null,
    }
    const v = evaluateCapabilityProbeArtefact({
      ...good(),
      precondition: {
        ...good().precondition,
        existingPolicyCount: 1,
        existingPolicyNames: ['platform_policy'],
        existingPolicyRows: [platform],
      },
      afterCleanup: [{ ...platform, qual: 'true' }],
    })
    expect(v.state).toBe('BLOCKED_MANAGEMENT_CHANNEL_CLEANUP')
    expect(v.problems.join(' ')).toMatch(/survived by NAME/)
  })

  it('says so when only names were captured, instead of claiming the stronger check ran', () => {
    const v = evaluateCapabilityProbeArtefact({
      ...good(),
      precondition: {
        ...good().precondition,
        existingPolicyCount: 1,
        existingPolicyNames: ['platform_policy'],
      },
      afterCleanup: [
        {
          schemaname: 'storage',
          tablename: 'objects',
          policyname: 'platform_policy',
          permissive: 'PERMISSIVE',
          roles: '{authenticated}',
          cmd: 'SELECT',
          qual: 'true',
          withCheck: null,
        },
      ],
    })
    expect(v.state).toBe('CAPABILITY_PROBE_COMPLETE')
    expect(v.problems.join(' ')).toMatch(/CLEANUP VERIFIED BY NAME ONLY/)
  })

  it('adds no such caveat when there was nothing pre-existing to protect', () => {
    const v = evaluateCapabilityProbeArtefact(good())
    expect(v.state).toBe('CAPABILITY_PROBE_COMPLETE')
    expect(v.problems.join(' ')).not.toMatch(/NAME ONLY/)
  })

  it('the recorded status file matches the derived verdict', () => {
    const onDisk = JSON.parse(
      readFileSync(path.join(process.cwd(), CAPABILITY_PROBE_STATUS_ARTEFACT), 'utf8'),
    ) as { state: string; canonicalPoliciesProven: boolean; managementPlaneVerified: boolean }
    let artefact: CapabilityProbeArtefact | null = null
    try {
      artefact = JSON.parse(readFileSync(path.join(process.cwd(), CAPABILITY_PROBE_ARTEFACT), 'utf8'))
    } catch {
      artefact = null
    }
    expect(onDisk.state).toBe(evaluateCapabilityProbeArtefact(artefact).state)
    expect(onDisk.canonicalPoliciesProven).toBe(false)
    expect(onDisk.managementPlaneVerified).toBe(false)
  })
})

describe('the operator steps are deterministic and stop before the canonical policies', () => {
  const steps = CAPABILITY_PROBE_OPERATOR_STEPS.join('\n')

  it('opens with the read-only precondition and records the inventory', () => {
    expect(CAPABILITY_PROBE_OPERATOR_STEPS[0]).toMatch(/PRECONDITION/)
    expect(CAPABILITY_PROBE_OPERATOR_STEPS[0]).toMatch(/existing_policy_count/)
  })

  it('names the exact policy, role and predicate — nothing to compose', () => {
    expect(steps).toContain(CAPABILITY_PROBE_POLICY)
    expect(steps).toContain('authenticated')
    expect(steps).toMatch(/USING expression\): false/)
  })

  it('warns about RESTRICTIVE explicitly', () => {
    expect(steps).toMatch(/RESTRICTIVE with false denies every read/)
  })

  it('requires cleanup AND a cleanup postcondition', () => {
    expect(steps).toMatch(/CLEANUP —/)
    expect(steps).toMatch(/CLEANUP POSTCONDITION/)
    expect(steps).toMatch(/every policy recorded in step 0 must still be there/)
  })

  it('forbids creating the canonical policies in the same session', () => {
    expect(steps).toMatch(/Do not create the canonical Uellix policies/)
    expect(steps).toMatch(/PART A, which has not been applied/)
  })

  it('records no secret', () => {
    expect(steps).toMatch(/Never a key, a token or a connection string/)
  })
})

/* ========================================================================== */
/* SECURITY MONOTONICITY, checked algebraically rather than asserted          */
/* ========================================================================== */

/**
 * PostgreSQL's row-visibility rule for a command, modelled directly:
 *
 *   visible(row) = (OR over PERMISSIVE predicates) AND (AND over RESTRICTIVE)
 *
 * with the standing rule that a table with RLS enabled and no PERMISSIVE policy
 * shows nothing — an empty disjunction is false.
 *
 * Modelling it is what turns "adding USING (false) cannot widen access" from a
 * claim in a comment into something a machine re-checks. The earlier version of
 * this file asserted the SQL text and the pg_policies surface, which proves the
 * probe is what we think it is — not that what we think it is, is harmless.
 */
type ModelPolicy = { readonly permissive: boolean; readonly predicate: (row: number) => boolean }

const visible = (policies: readonly ModelPolicy[], rows: readonly number[]): Set<number> => {
  const permissive = policies.filter((p) => p.permissive)
  const restrictive = policies.filter((p) => !p.permissive)
  return new Set(
    rows.filter(
      (r) =>
        permissive.some((p) => p.predicate(r)) && restrictive.every((p) => p.predicate(r)),
    ),
  )
}

describe('adding the probe cannot enlarge the authorised row set', () => {
  const ROWS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  const PROBE: ModelPolicy = { permissive: true, predicate: () => false }

  // Every subset of a small, deliberately varied policy library — including the
  // empty set, which is the state storage.objects is in today.
  const LIBRARY: ModelPolicy[] = [
    { permissive: true, predicate: (r) => r % 2 === 0 },
    { permissive: true, predicate: (r) => r > 6 },
    { permissive: false, predicate: (r) => r !== 3 },
    { permissive: false, predicate: (r) => r < 9 },
  ]
  const subsets = <T,>(xs: readonly T[]): T[][] =>
    xs.reduce<T[][]>((acc, x) => [...acc, ...acc.map((s) => [...s, x])], [[]])

  it('leaves the visible set EXACTLY unchanged, for every policy configuration', () => {
    for (const base of subsets(LIBRARY)) {
      const before = visible(base, ROWS)
      const after = visible([...base, PROBE], ROWS)
      expect([...after].sort(), JSON.stringify({ base: base.length })).toEqual([...before].sort())
    }
  })

  it('in particular adds nothing to a table with RLS on and no policies', () => {
    expect(visible([], ROWS).size).toBe(0)
    expect(visible([PROBE], ROWS).size).toBe(0)
  })

  // THE COUNTEREXAMPLE THAT PROVES THE MODEL IS NOT VACUOUS. If the same
  // predicate were RESTRICTIVE it would empty the table — so the model CAN
  // detect a change, and the PERMISSIVE result above is a real property.
  it('and the same predicate as RESTRICTIVE does remove access, wherever there was any', () => {
    const restrictiveProbe: ModelPolicy = { permissive: false, predicate: () => false }
    const withAccess = [LIBRARY[0]]
    expect(visible(withAccess, ROWS).size).toBeGreaterThan(0)
    expect(visible([...withAccess, restrictiveProbe], ROWS).size).toBe(0)
  })

  it('the probe as specified is the PERMISSIVE one', () => {
    expect(CAPABILITY_PROBE_FIELDS.permissive).toBe('PERMISSIVE')
    expect(CAPABILITY_PROBE_FIELDS.using).toBe('false')
  })
})
