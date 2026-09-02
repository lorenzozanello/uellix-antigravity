// tests/hosted/storage-policy-artifact.test.ts
// TRAIN 5C2 — Phases C, D, H and K.
//
// PART B is the one piece of this provisioning a HUMAN applies through a channel
// the runner cannot observe. Everything here exists because of that: the split
// must be deterministic, the artefact must be provably derived from the one
// canonical source, and the postcondition must compare the whole security
// surface rather than confirm three names exist.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  EXPECTED_STORAGE_POLICIES,
  MANAGED_ARTEFACT,
  PSQL_ARTEFACT,
  STORAGE_UNIT_SOURCE,
  belongsToManagedPart,
  buildStorageArtefacts,
  deriveStorageUnitState,
  isStorageUnitInstalled,
  splitPreservingText,
  STORAGE_UNIT_TRANSITIONS,
  UNIT_41_DEPENDENCY_DAG,
  UNIT_41_NON_DEPENDENCIES,
} from '@/db/hosted/storage-policy-artifact'
import {
  EXPECTED_STORAGE_POLICY_SURFACE,
  verifyStoragePolicySurface,
  type ObservedStoragePolicy,
} from '@/db/hosted/baseline-postconditions'
import { sha256OfSql } from '@/db/hosted/hosted-package-manifest'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')
// LF-normalized. A CRLF checkout would otherwise make every multi-line fixture
// fragment below fail to match, and the tests would pass vacuously by mutating
// nothing — which is exactly how the first run of this file lied to me.
const SOURCE = read(STORAGE_UNIT_SOURCE).replace(/\r\n?/g, '\n')
const stripComments = (s: string) => s.replace(/--[^\n]*/g, '')

describe('the split is deterministic and semantic', () => {
  it('produces the same bytes every time', () => {
    const a = buildStorageArtefacts(SOURCE)
    const b = buildStorageArtefacts(SOURCE)
    expect(a.psqlSha256).toBe(b.psqlSha256)
    expect(a.managedSha256).toBe(b.managedSha256)
    expect(a.managedSecuritySurfaceDigest).toBe(b.managedSecuritySurfaceDigest)
  })

  it('is unaffected by a CRLF checkout', () => {
    const crlf = SOURCE.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n')
    expect(buildStorageArtefacts(crlf).managedSha256).toBe(buildStorageArtefacts(SOURCE).managedSha256)
  })

  it('splits by STATEMENT on storage.objects, not by line number or banner', () => {
    // Moving the `-- STORAGE POLICIES` banner must not move the boundary. A
    // security split anchored on a comment is a split a reformat can silently
    // relocate.
    const moved = SOURCE.replace('-- STORAGE POLICIES', '-- (banner moved)')
    const original = buildStorageArtefacts(SOURCE)
    const shuffled = buildStorageArtefacts(moved)
    expect(shuffled.statementCounts).toEqual(original.statementCounts)
    expect(shuffled.managedSecuritySurfaceDigest).toBe(original.managedSecuritySurfaceDigest)
  })

  it('puts every storage.objects statement in PART B and none in PART A', () => {
    const a = buildStorageArtefacts(SOURCE)
    // In CODE. The generated banner explains the split and necessarily names the
    // table; what must not appear is an executable statement.
    expect(stripComments(a.psqlSql)).not.toMatch(/storage\.objects/)
    expect(splitPreservingText(a.managedSql).filter(belongsToManagedPart)).toHaveLength(7)
    expect(a.statementCounts).toEqual({ total: 13, partA: 6, partB: 7 })
  })

  it('PART A keeps everything 0039 depends on', () => {
    const a = buildStorageArtefacts(SOURCE)
    for (const fn of ['can_read_evidence_object', 'can_write_evidence_object']) {
      expect(a.psqlSql).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`)
      expect(a.psqlSql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}(text, uuid) TO authenticated`)
    }
    // …and 0039 needs nothing from PART B.
    expect(read('db/migrations/0039_grant_rls_helper_execution.sql')).not.toMatch(/storage\.objects/)
  })

  it('PART B carries all four DROP and all three CREATE, unchanged', () => {
    const a = buildStorageArtefacts(SOURCE)
    expect((a.managedSql.match(/DROP POLICY IF EXISTS/g) ?? [])).toHaveLength(4)
    expect((a.managedSql.match(/^CREATE POLICY/gm) ?? [])).toHaveLength(3)
    for (const name of EXPECTED_STORAGE_POLICIES) expect(a.managedSql).toContain(`"${name}"`)
    // No semantic change: every policy body from the source survives verbatim.
    for (const fragment of [
      "bucket_id = 'uellix-evidence' AND\n    public.can_read_evidence_object(name, auth.uid())",
      "bucket_id = 'uellix-evidence' AND\n    public.can_write_evidence_object(name, auth.uid())",
    ]) {
      expect(a.managedSql).toContain(fragment)
    }
  })

  it('never emits ALTER TABLE storage.objects, and refuses a source that acquires one', () => {
    expect(buildStorageArtefacts(SOURCE).managedSql).not.toMatch(/ALTER\s+TABLE\s+storage\.objects/i)
    expect(() =>
      buildStorageArtefacts(`${SOURCE}\nALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;\n`),
    ).toThrow(/STORAGE_SPLIT_REFUSED/)
  })

  it('refuses a source whose shape stopped matching the adaptation', () => {
    expect(() =>
      buildStorageArtefacts(`${SOURCE}\nCREATE POLICY "extra_evidence" ON storage.objects FOR SELECT TO authenticated USING (true);\n`),
    ).toThrow(/STORAGE_SPLIT_UNEXPECTED_SHAPE/)
  })
})

describe('DRIFT — the checked-in artefacts are the derivation, not a copy', () => {
  it('both regenerate byte-identically from the canonical source', () => {
    const a = buildStorageArtefacts(SOURCE)
    expect(read(PSQL_ARTEFACT).replace(/\r\n?/g, '\n')).toBe(a.psqlSql)
    expect(read(MANAGED_ARTEFACT).replace(/\r\n?/g, '\n')).toBe(a.managedSql)
  })

  it('a hand edit to the artefact is caught — this is the file a human RUNS', () => {
    const a = buildStorageArtefacts(SOURCE)
    const tampered = a.managedSql.replace("TO authenticated", 'TO public')
    expect(sha256OfSql(tampered)).not.toBe(a.managedSha256)
  })

  it('a source edit changes the artefact hash, so a stale artefact cannot pass', () => {
    const a = buildStorageArtefacts(SOURCE)
    const b = buildStorageArtefacts(SOURCE.replaceAll('uellix-evidence', 'some-other-bucket'))
    expect(b.managedSha256).not.toBe(a.managedSha256)
    expect(b.managedSecuritySurfaceDigest).not.toBe(a.managedSecuritySurfaceDigest)
  })

  it('a COMMENT-only edit moves the file hash but NOT the security surface', () => {
    // The two digests answer different questions and this is the case that
    // shows it: rewording a comment is not a security change, and a digest that
    // moved for it would train a reviewer to ignore the one that matters.
    const a = buildStorageArtefacts(SOURCE)
    const b = buildStorageArtefacts(SOURCE.replace('-- SELECT Policy', '-- the read policy'))
    expect(b.managedSha256).not.toBe(a.managedSha256)
    expect(b.managedSecuritySurfaceDigest).toBe(a.managedSecuritySurfaceDigest)
  })

  it('the security surface digest moves when a PREDICATE changes but the names do not', () => {
    // The failure this pins: three policies with the right names and a widened
    // predicate. A name-only check would call that identical.
    const weakened = SOURCE.replace(
      "bucket_id = 'uellix-evidence' AND\n    public.can_read_evidence_object(name, auth.uid())",
      'true',
    )
    const a = buildStorageArtefacts(SOURCE)
    const b = buildStorageArtefacts(weakened)
    expect(b.managedSecuritySurfaceDigest).not.toBe(a.managedSecuritySurfaceDigest)
  })
})

describe('the splitter survives block comments — reviewer B', () => {
  // EXECUTED BY THE REVIEWER against the first version: a block comment holding
  // a semicolon was cut in half, and the fragment carrying the unterminated
  // `/*` landed in PART A, where it would swallow whatever followed it.
  it('does not cut inside /* … ; … */', () => {
    const sql = [
      'CREATE FUNCTION public.f() RETURNS boolean AS $$ SELECT true $$ LANGUAGE sql;',
      '',
      '/* legacy note; keep for history */',
      'DROP POLICY IF EXISTS "select_evidence" ON storage.objects;',
    ].join('\n')
    const statements = splitPreservingText(sql)
    expect(statements).toHaveLength(2)
    expect(statements.filter(belongsToManagedPart)).toHaveLength(1)
    expect(statements.every((s) => (s.match(/\/\*/g) ?? []).length === (s.match(/\*\//g) ?? []).length)).toBe(true)
  })

  it('handles nested block comments the way PostgreSQL does', () => {
    const sql = 'SELECT 1 /* outer /* inner; */ still outer; */ ;\nSELECT 2;'
    expect(splitPreservingText(sql)).toHaveLength(2)
  })

  it('still treats a block comment mentioning storage.objects as a comment', () => {
    const stmt =
      '/* touches storage.objects one day */\nCREATE FUNCTION public.g() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;'
    expect(belongsToManagedPart(stmt)).toBe(false)
  })
})

describe('the pinned hashes describe the bytes written', () => {
  // The journal wrapper checks its include against `psqlSha256`, which surfaced
  // that `psqlSha256` hashed the pre-newline string while the artefact written
  // to disk carried a trailing newline. One character, and the ledger would have
  // attested a file that did not exist.
  it('psqlSha256 is the hash of psqlSql itself', () => {
    const a = buildStorageArtefacts(SOURCE)
    expect(sha256OfSql(a.psqlSql)).toBe(a.psqlSha256)
    expect(sha256OfSql(a.managedSql)).toBe(a.managedSha256)
  })

  it('and matches what is on disk', () => {
    const a = buildStorageArtefacts(SOURCE)
    expect(sha256OfSql(read(PSQL_ARTEFACT))).toBe(a.psqlSha256)
    expect(sha256OfSql(read(MANAGED_ARTEFACT))).toBe(a.managedSha256)
  })

  it('separates PART A and PART B security surface digests', () => {
    const a = buildStorageArtefacts(SOURCE)
    expect(a.psqlSecuritySurfaceDigest).not.toBe(a.managedSecuritySurfaceDigest)
  })
})

describe('the unit 41 state machine', () => {
  const S = (over: Partial<Parameters<typeof deriveStorageUnitState>[0]> = {}) =>
    deriveStorageUnitState({
      helpersPresent: true,
      policyNamesPresent: [...EXPECTED_STORAGE_POLICIES],
      boundaryOpen: false,
      surfaceVerified: true,
      ...over,
    })

  it('is NOT_STARTED before PART A', () => {
    expect(S({ helpersPresent: false, policyNamesPresent: [], surfaceVerified: null })).toBe('UNIT_41_NOT_STARTED')
  })

  it('is HELPERS_APPLIED — not complete — with PART A alone', () => {
    const state = S({ policyNamesPresent: [], surfaceVerified: null })
    expect(state).toBe('UNIT_41_HELPERS_APPLIED')
    expect(isStorageUnitInstalled(state)).toBe(false)
  })

  it('is POLICIES_PENDING while the human boundary is open', () => {
    expect(S({ policyNamesPresent: [], boundaryOpen: true, surfaceVerified: null })).toBe('UNIT_41_POLICIES_PENDING')
  })

  // THE STATE THE INSTRUCTION INSISTED ON. "PARTE B ejecutada" is not
  // "PARTE B correcta", and a machine without this state has to choose between
  // calling an unverified surface COMPLETE or calling it FAILED. Both lie.
  it('is POLICIES_APPLIED_UNVERIFIED when all three exist and B0-16 has not run', () => {
    const state = S({ surfaceVerified: null })
    expect(state).toBe('UNIT_41_POLICIES_APPLIED_UNVERIFIED')
    expect(isStorageUnitInstalled(state)).toBe(false)
  })

  it('is FAILED when the surface was measured and did not match', () => {
    expect(S({ surfaceVerified: false })).toBe('UNIT_41_FAILED')
  })

  it('is FAILED with 2 of 3 policies once the boundary has closed', () => {
    const state = S({ policyNamesPresent: ['select_evidence', 'insert_evidence'], surfaceVerified: null })
    expect(state).toBe('UNIT_41_FAILED')
    expect(isStorageUnitInstalled(state)).toBe(false)
  })

  it('is still POLICIES_PENDING with 2 of 3 while the boundary is open', () => {
    expect(
      S({ policyNamesPresent: ['select_evidence', 'insert_evidence'], boundaryOpen: true, surfaceVerified: null }),
    ).toBe('UNIT_41_POLICIES_PENDING')
  })

  // Policies whose predicates call helpers that do not exist raise 42883 on
  // every row. That is not an earlier state; it is a broken one.
  it('is FAILED when policies exist without the helpers they call', () => {
    expect(S({ helpersPresent: false, surfaceVerified: null })).toBe('UNIT_41_FAILED')
  })

  it('is COMPLETE only with helpers AND all three policies AND a verified surface', () => {
    expect(S()).toBe('UNIT_41_COMPLETE')
    expect(isStorageUnitInstalled(S())).toBe(true)
  })

  it('has no transition into COMPLETE that skips the verified surface', () => {
    const into = Object.entries(STORAGE_UNIT_TRANSITIONS)
      .filter(([, to]) => (to as readonly string[]).includes('UNIT_41_COMPLETE'))
      .map(([from]) => from)
    expect(into).toEqual(['UNIT_41_POLICIES_APPLIED_UNVERIFIED'])
  })

  it('cannot be driven to COMPLETE by an operator claim — there is no such input', () => {
    // `deriveStorageUnitState` takes four measured facts and nothing else. If a
    // "the operator says it is done" field ever appears, this fails.
    expect(Object.keys({ helpersPresent: 0, policyNamesPresent: 0, boundaryOpen: 0, surfaceVerified: 0 })).toEqual([
      'helpersPresent',
      'policyNamesPresent',
      'boundaryOpen',
      'surfaceVerified',
    ])
    expect(S({ surfaceVerified: null })).not.toBe('UNIT_41_COMPLETE')
  })
})

describe('the unit 41 dependency DAG', () => {
  it('makes 0039 depend on PART A and not on PART B', () => {
    const toGrant = UNIT_41_DEPENDENCY_DAG.filter((e) => e.to === '0039_grant_rls_helper_execution.sql')
    expect(toGrant.map((e) => e.from)).toEqual(['unit-41-part-a'])
  })

  it('does not make the bucket an apply-time dependency of anything', () => {
    const bucketEdges = UNIT_41_DEPENDENCY_DAG.filter((e) => e.from === 'evidence-bucket')
    expect(bucketEdges.every((e) => e.kind !== 'apply-time')).toBe(true)
  })

  it('keeps PART B a dependency of CHECKPOINT B0 — the boundary is observable', () => {
    expect(UNIT_41_DEPENDENCY_DAG.some((e) => e.from === 'unit-41-part-b' && e.to === 'checkpoint-b0-16')).toBe(true)
  })

  it('asserts the non-edges rather than merely omitting them', () => {
    for (const absent of UNIT_41_NON_DEPENDENCIES) {
      expect(
        UNIT_41_DEPENDENCY_DAG.some((e) => e.from === absent.from && e.to === absent.to),
        absent.why,
      ).toBe(false)
    }
  })

  it('is acyclic', () => {
    const edges = UNIT_41_DEPENDENCY_DAG.map((e) => [e.from, e.to] as const)
    const nodes = [...new Set(edges.flat())]
    const seen = new Set<string>()
    const stack = new Set<string>()
    const visit = (n: string): boolean => {
      if (stack.has(n)) return false
      if (seen.has(n)) return true
      stack.add(n)
      for (const [f, t] of edges) if (f === n && !visit(t)) return false
      stack.delete(n)
      seen.add(n)
      return true
    }
    expect(nodes.every(visit)).toBe(true)
  })
})

describe('the storage postcondition compares the SURFACE, not the names', () => {
  const conforming = (): ObservedStoragePolicy[] => [
    { schemaname: 'storage', tablename: 'objects', policyname: 'select_evidence', roles: '{authenticated}', cmd: 'SELECT', qual: "((bucket_id = 'uellix-evidence'::text) AND public.can_read_evidence_object(name, auth.uid()))", withCheck: null },
    { schemaname: 'storage', tablename: 'objects', policyname: 'insert_evidence', roles: '{authenticated}', cmd: 'INSERT', qual: null, withCheck: "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))" },
    { schemaname: 'storage', tablename: 'objects', policyname: 'delete_evidence', roles: '{authenticated}', cmd: 'DELETE', qual: "((bucket_id = 'uellix-evidence'::text) AND public.can_write_evidence_object(name, auth.uid()))", withCheck: null },
  ]

  it('passes against the real pg_policies shape, casts and parentheses included', () => {
    const v = verifyStoragePolicySurface(conforming())
    expect(v.passed, v.detail).toBe(true)
  })

  it('pins exactly three expected policies', () => {
    expect(EXPECTED_STORAGE_POLICY_SURFACE).toHaveLength(3)
  })

  it.each([
    ['a missing policy', (p: ObservedStoragePolicy[]) => p.slice(1), /ABSENT/],
    ['a widened role', (p: ObservedStoragePolicy[]) => [{ ...p[0], roles: '{public}' }, ...p.slice(1)], /roles are/],
    ['a wrong command', (p: ObservedStoragePolicy[]) => [{ ...p[0], cmd: 'ALL' }, ...p.slice(1)], /cmd is/],
    ['a dropped bucket filter', (p: ObservedStoragePolicy[]) => [{ ...p[0], qual: '(public.can_read_evidence_object(name, auth.uid()))' }, ...p.slice(1)], /bucket_id/],
    ['a dropped isolation helper', (p: ObservedStoragePolicy[]) => [{ ...p[0], qual: "((bucket_id = 'uellix-evidence'::text))" }, ...p.slice(1)], /can_read_evidence_object/],
    ['USING (true)', (p: ObservedStoragePolicy[]) => [{ ...p[0], qual: 'true' }, ...p.slice(1)], /bucket_id/],
    ['an emptied predicate', (p: ObservedStoragePolicy[]) => [{ ...p[0], qual: null }, ...p.slice(1)], /empty/],
    ['a predicate in both slots', (p: ObservedStoragePolicy[]) => [{ ...p[0], withCheck: 'true' }, ...p.slice(1)], /both slots/],
    ['an extra evidence policy', (p: ObservedStoragePolicy[]) => [...p, { ...p[0], policyname: 'sneaky_evidence' }], /nothing in this repository generates/],
    // Adversarial review: the old name filter only flagged /_evidence$/, so a
    // policy called anything else was invisible. PERMISSIVE policies OR
    // together — one USING (true) opens every object.
    ['an extra policy with an UNRELATED name', (p: ObservedStoragePolicy[]) => [...p, { ...p[0], policyname: 'temp_debug', qual: 'true' }], /nothing in this repository generates/],
    ['an OR-injected predicate', (p: ObservedStoragePolicy[]) => [{ ...p[0], qual: `((${p[0].qual}) OR true)` }, ...p.slice(1)], /does not MATCH/],
    ['a bucket whose name CONTAINS the expected one', (p: ObservedStoragePolicy[]) => [{ ...p[0], qual: p[0].qual!.replace("'uellix-evidence'", "'not-uellix-evidence'") }, ...p.slice(1)], /does not MATCH/],
    ['a helper whose name CONTAINS the expected one', (p: ObservedStoragePolicy[]) => [{ ...p[0], qual: p[0].qual!.replace('public.can_read', 'public.bypass_can_read') }, ...p.slice(1)], /does not MATCH/],
  ])('refuses %s', (_label, mutate, pattern) => {
    const v = verifyStoragePolicySurface(mutate(conforming()))
    expect(v.passed).toBe(false)
    expect(v.detail).toMatch(pattern)
  })

  it('does NOT reduce to policyname EXISTS — right names, wrong everything else still fails', () => {
    const rightNames = conforming().map((p) => ({ ...p, roles: '{public}', qual: 'true', withCheck: null }))
    expect(verifyStoragePolicySurface(rightNames).passed).toBe(false)
  })
})
