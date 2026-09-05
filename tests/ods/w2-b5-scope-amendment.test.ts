// tests/ods/w2-b5-scope-amendment.test.ts — HPO-ODS-W2-18 deterministic controls.
//
// Asserts the closed-world properties of
// docs/ops/wave2/W2_B5_AUTHORITY_AMENDMENT_v1.0.1.json, which extends the
// CLOSED-WORLD surface of the FROZEN docs/ops/wave2/W2_B5_AUTHORITY_v1.0.0.json
// by exactly four exact literal paths.
//
// Authorization is evaluated with the REAL gate matcher imported from
// scripts/ods-scope.ts — never a reimplementation, which could drift from the
// gate it claims to model.
//
// The load-bearing control is POS-AMD-3 (NON-VACUITY): each added path must be
// UNAUTHORIZED under the v1.0.0 enumeration alone. Without it, "the path is
// authorized" could pass against an already-permissive surface and prove
// nothing — the exact vacuous-PASS failure class W2-B4's audit recorded.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { matchesAnyPattern, DEFAULT_PROTECTED_PATTERNS } from '../../scripts/ods-scope'

const REPO_ROOT = path.resolve(__dirname, '..', '..')

const AMENDMENT_PATH = 'docs/ops/wave2/W2_B5_AUTHORITY_AMENDMENT_v1.0.1.json'
const BASE_AUTHORITY_PATH = 'docs/ops/wave2/W2_B5_AUTHORITY_v1.0.0.json'
const ODS_ADDENDUM_PATH = 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.17.json'

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'))
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const amendment = readJson(AMENDMENT_PATH) as any
const baseAuthority = readJson(BASE_AUTHORITY_PATH) as any
const odsAddendum = readJson(ODS_ADDENDUM_PATH) as any

// The four paths, written out literally rather than read from the artifact, so
// the control cannot be satisfied by an artifact that redefines its own answer.
const EXPECTED_FOUR = [
  'app/app/portfolios/[portfolioId]/page.tsx',
  'lib/stella/context/build-composer-context.funder-breakdown.test.ts',
  'lib/stella/prompts/sensitive-populations-notice.test.ts',
  'tests/eval/stella-roles/cases.ts',
] as const

const ADDED: string[] = amendment.amended_authorized_surface.additional_exact_paths

/** The 49 patterns of the FROZEN v1.0.0 closed world, composed exactly as the authority composes them. */
function v1EnumerationPatterns(): string[] {
  const surface = baseAuthority.authorized_future_implementation_surface
  const u = surface.unprotected
  return [
    ...surface.protected.patterns,
    ...u.schema_and_manifest,
    ...u.domain_logic,
    ...u.readiness_readers,
    ...Object.keys(u.product_surface_patterns),
    ...u.existing_tests,
    ...u.new_tests.patterns,
    ...u.new_tests.exact_new_hosts,
    ...u.derived_artifact_refresh,
    ...u.evidence,
    ...u.audit_artifacts,
  ]
}

const V1_PATTERNS = v1EnumerationPatterns()
/** EFFECTIVE closed world for the B5 implementation mission = v1.0.0 enumeration UNION the four exact paths. */
const EFFECTIVE_PATTERNS = [...V1_PATTERNS, ...ADDED]

describe('W2-B5 scope amendment — exact membership (closed world)', () => {
  it('adds exactly four paths, no duplicates, exact set equality in both directions', () => {
    expect(ADDED).toHaveLength(4)
    expect(new Set(ADDED).size).toBe(4)
    expect(amendment.amended_authorized_surface.additional_exact_path_count).toBe(4)
    // Both directions — never a subset test.
    expect([...ADDED].sort()).toEqual([...EXPECTED_FOUR].sort())
    for (const p of EXPECTED_FOUR) expect(ADDED).toContain(p)
    for (const p of ADDED) expect(EXPECTED_FOUR as readonly string[]).toContain(p)
  })

  it('POS-AMD-1: each of the four exact paths is a member of the amendment surface', () => {
    for (const p of EXPECTED_FOUR) expect(ADDED).toContain(p)
  })

  it('POS-AMD-2: each of the four exact paths IS authorized under the EFFECTIVE surface', () => {
    for (const p of EXPECTED_FOUR) {
      expect(matchesAnyPattern(p, EFFECTIVE_PATTERNS)).toBe(true)
    }
  })

  it('POS-AMD-3 (NON-VACUITY): each of the four is NOT authorized under the v1.0.0 enumeration alone', () => {
    // If any of these were already authorized, the amendment would be vacuous
    // for that path and POS-AMD-2 would prove nothing about it.
    for (const p of EXPECTED_FOUR) {
      expect(matchesAnyPattern(p, V1_PATTERNS)).toBe(false)
    }
  })

  it('the v1.0.0 enumeration is non-trivial and still authorizes its own surface', () => {
    // Guards against a mangled read of the frozen authority silently emptying
    // V1_PATTERNS, which would make POS-AMD-3 pass for the wrong reason.
    expect(V1_PATTERNS.length).toBeGreaterThanOrEqual(40)
    expect(matchesAnyPattern('lib/pipeline/sroi-readiness.ts', V1_PATTERNS)).toBe(true)
    expect(matchesAnyPattern('db/migrations/0064_fib_readiness_assessments.sql', V1_PATTERNS)).toBe(true)
    expect(matchesAnyPattern('tests/w2-b5-governance.test.ts', V1_PATTERNS)).toBe(true)
  })
})

describe('W2-B5 scope amendment — negative controls', () => {
  it('NEG-AMD-1: a fifth adjacent path is NOT authorized — one sibling per authorized directory', () => {
    const adjacent = [
      'app/app/portfolios/[portfolioId]/loading.tsx',
      'app/app/portfolios/page.tsx',
      'lib/stella/context/build-composer-context.other-breakdown.test.ts',
      'lib/stella/prompts/sensitive-populations-notice.ts',
      'tests/eval/stella-roles/runner.ts',
    ]
    for (const p of adjacent) {
      expect(ADDED).not.toContain(p)
      expect(matchesAnyPattern(p, EFFECTIVE_PATTERNS)).toBe(false)
    }
  })

  it('NEG-AMD-2: a wildcard is NOT authorized — no entry contains * or **', () => {
    for (const p of ADDED) {
      expect(p).not.toContain('*')
    }
    for (const wildcard of [
      'app/app/portfolios/**',
      'lib/stella/**',
      'lib/stella/prompts/*.test.ts',
      'tests/eval/**',
    ]) {
      expect(ADDED).not.toContain(wildcard)
    }
  })

  it('NEG-AMD-3: a directory prefix is NOT sufficient', () => {
    for (const dir of [
      'app/app/portfolios/',
      'app/app/portfolios/[portfolioId]/',
      'lib/stella/prompts/',
      'lib/stella/context/',
      'tests/eval/stella-roles/',
    ]) {
      expect(ADDED).not.toContain(dir)
      // The bare directory is not itself an authorized path...
      expect(matchesAnyPattern(dir, EFFECTIVE_PATTERNS)).toBe(false)
    }
    // ...and no entry is a bare directory (every entry has a file extension).
    for (const p of ADDED) {
      expect(p).toMatch(/\.[a-z]+$/)
      expect(p.endsWith('/')).toBe(false)
    }
  })

  it('NEG-AMD-4: the amendment grants NO protected surface', () => {
    // None of the four is protected under the real gate's classifier.
    for (const p of ADDED) {
      expect(matchesAnyPattern(p, DEFAULT_PROTECTED_PATTERNS)).toBe(false)
      expect(amendment.closed_world_path_correction[pathKeyOf(p)].protected).toBe(false)
    }
    // The companion ODS addendum allocates no grant and leaves the registry cardinality untouched.
    expect(odsAddendum.protected_grant_required).toBe(false)
    expect(odsAddendum.protected_grant).toBeNull()
    expect(odsAddendum.PROTECTED_GRANTS_CHANGED).toBe(false)
    expect(odsAddendum.PROTECTED_GRANTS_COUNT_BEFORE).toBe(odsAddendum.PROTECTED_GRANTS_COUNT_AFTER)
    expect(odsAddendum.W2_17_NOT_WIDENED).toBe(true)
  })

  it('NEG-AMD-5: the frozen artifacts are declared unchanged and semantics carry no delta', () => {
    expect(amendment.amends).toBe(BASE_AUTHORITY_PATH)
    expect(amendment.amendment_semantics).toContain('APPEND-ONLY')
    expect(amendment.what_is_unchanged.test_requirements).toContain('BYTE-UNCHANGED')
    expect(amendment.what_is_unchanged.implementation_semantics).toBe('UNCHANGED.')
    expect(amendment.what_is_unchanged.migrations).toContain('UNCHANGED')
    expect(amendment.BEHAVIORAL_SCOPE_DELTA).toBe('NONE')
    for (const p of ADDED) {
      expect(amendment.closed_world_path_correction[pathKeyOf(p)].BEHAVIORAL_SCOPE_DELTA).toBe('NONE')
    }
    // The base authority itself is untouched by this amendment.
    expect(baseAuthority.final_state).toBe('W2_B5_AUTHORITY_FROZEN_WAITING_FOR_IMPLEMENTATION')
  })

  it('the precedent-prohibition clause is present and binding', () => {
    expect(amendment.precedent_prohibition.rule).toContain('NO precedent')
    expect(amendment.precedent_prohibition.specifically_prohibited_inferences.length).toBeGreaterThanOrEqual(6)
  })
})

describe('W2-B5 scope amendment — mutation controls', () => {
  it('MUT-AMD-1: removing ANY ONE of the four makes exactly that path unauthorized', () => {
    for (const removed of EXPECTED_FOUR) {
      const mutated = [...V1_PATTERNS, ...ADDED.filter((p) => p !== removed)]
      expect(matchesAnyPattern(removed, mutated)).toBe(false)
      // The other three remain authorized — the failure is precise, not collateral.
      for (const other of EXPECTED_FOUR.filter((p) => p !== removed)) {
        expect(matchesAnyPattern(other, mutated)).toBe(true)
      }
    }
  })

  it('MUT-AMD-2: adding an unrelated path breaks exact membership and the closed-world count', () => {
    const mutated = [...ADDED, 'lib/pipeline/methodology-review.ts']
    expect(mutated).toHaveLength(5)
    expect(mutated.length).not.toBe(amendment.amended_authorized_surface.additional_exact_path_count)
    expect([...mutated].sort()).not.toEqual([...EXPECTED_FOUR].sort())
  })

  it('MUT-AMD-3: a case-corrupted spelling of an exact path is NOT authorized', () => {
    const corrupted = [
      'App/app/portfolios/[portfolioId]/page.tsx',
      'lib/Stella/prompts/sensitive-populations-notice.test.ts',
      'tests/eval/stella-roles/Cases.ts',
    ]
    for (const p of corrupted) {
      expect(matchesAnyPattern(p, EFFECTIVE_PATTERNS)).toBe(false)
      expect(ADDED).not.toContain(p)
    }
  })

  it('MUT-AMD-4: widening an exact path to its directory glob authorizes a sibling it must not', () => {
    const sibling = 'lib/stella/prompts/some-other-file.test.ts'
    expect(matchesAnyPattern(sibling, EFFECTIVE_PATTERNS)).toBe(false)
    const widened = [...V1_PATTERNS, ...ADDED, 'lib/stella/prompts/**']
    // Proves the exact-path form is load-bearing: widen it and the closed world leaks.
    expect(matchesAnyPattern(sibling, widened)).toBe(true)
  })
})

describe('W2-B5 scope amendment — lineage and one-hole discipline', () => {
  it('allocates exactly v1.0.17 and HPO-ODS-W2-18, and nothing beyond', () => {
    expect(odsAddendum.version).toBe('1.0.17')
    expect(odsAddendum.GRANT_ID).toBe('HPO-ODS-W2-18')
    expect(amendment.GRANT_ID).toBe('HPO-ODS-W2-18')
    expect(amendment.companion_ods_addendum).toBe(ODS_ADDENDUM_PATH)
    expect(odsAddendum.companion_wave2_authority).toBe(AMENDMENT_PATH)
    expect(odsAddendum.controller_sequencing_rule.no_preallocation).toContain('PROHIBITION')
  })

  it('the Controller successor is declared, bounded to one entry, and NOT performed here', () => {
    const rule = odsAddendum.self_inclusion_rule
    expect(rule.paths_to_enumerate).toEqual([ODS_ADDENDUM_PATH])
    expect(rule.count).toBe('27 -> 28')
    expect(rule.exact_membership_never_a_subset_test).toBe(true)
    expect(odsAddendum.hpo_decision.FUNCTION_C_CONTROLLER_MAINTENANCE.NOT_PERFORMED_BY_THIS_MISSION)
      .toContain('DELIBERATE')
    expect(odsAddendum.CONTROLLER_MAINTENANCE_IMPLEMENTATION_STATUS).toBe('NOT_STARTED_SUCCESSOR_MISSION')
    // This mission changes no gate script.
    expect(odsAddendum.authorized_changed_paths_this_mission.paths).not.toContain('scripts/ods-controller.ts')
    expect(odsAddendum.authorized_changed_paths_this_mission.paths).not.toContain('scripts/ods-scope.ts')
  })

  it('the ODS instruction covers exactly the same four paths — no drift between the two artifacts', () => {
    const instructed: string[] =
      odsAddendum.hpo_decision.FUNCTION_A_PRODUCT_TEST_AND_PRODUCT_SURFACE_DISCIPLINE.paths
    expect(instructed).toHaveLength(4)
    expect([...instructed].sort()).toEqual([...ADDED].sort())
    expect(odsAddendum.hpo_decision.FUNCTION_A_PRODUCT_TEST_AND_PRODUCT_SURFACE_DISCIPLINE.no_wildcard)
      .toContain('No directory prefix is authorized')
  })

  it('every path carries a mechanical cause, a change class and an ODS instruction reference', () => {
    for (const p of ADDED) {
      const record = amendment.closed_world_path_correction[pathKeyOf(p)]
      expect(record.PATH).toBe(p)
      expect(record.MECHANICALLY_REQUIRED_BY_FROZEN_B5_CONTRACT).toBe('YES')
      expect(String(record.MECHANICAL_CAUSE).length).toBeGreaterThan(80)
      expect(record.AUTHORIZED_CHANGE_CLASS).toMatch(/^[A-Z_]+$/)
      expect(record.CAN_BE_REMOVED_WITHOUT_WEAKENING_B5).toMatch(/^NO\b/)
      expect(String(record.REQUIRED_TEST_OR_GATE).length).toBeGreaterThan(0)
      expect(record.ods_instruction_reference).toContain('ODS_V1_MAINTENANCE_ADDENDUM_v1.0.17.json')
      expect(['A', 'B']).toContain(record.DEFECT_CLASS)
    }
  })
})

/** Maps an authorized path to its `path_N` key in closed_world_path_correction. */
function pathKeyOf(p: string): string {
  const index = EXPECTED_FOUR.indexOf(p as (typeof EXPECTED_FOUR)[number])
  if (index < 0) throw new Error(`not one of the four authorized paths: ${p}`)
  return `path_${index + 1}`
}
