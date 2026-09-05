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

/* ------------------------------------------------------------------------- *
 * W2_B5_AUTHORITY_AMENDMENT_v1.0.2 — HPO-ODS-W2-19 deterministic controls.
 *
 * STRICTLY ADDITIVE. Every declaration above this line is byte-unchanged, so
 * every v1.0.1 control still asserts exactly what it asserted before. In
 * particular EFFECTIVE_PATTERNS above is, and remains, the effective surface
 * AS OF v1.0.1; the surface after v1.0.2 is composed separately below.
 *
 * The v1.0.2 amendment adds THREE exact literal paths on top of v1.0.1's four,
 * under TWO different and non-interchangeable change classes:
 *   MOCK_OR_TEST_WIRING_ONLY     — the two existing product test hosts
 *   DOCUMENTATION_ALIGNMENT_ONLY — the stale role-contract document
 *
 * The load-bearing controls are POS-AMD2-3 (NON-VACUITY, asserted against BOTH
 * predecessor surfaces) and NEG-AMD2-6 (the docs rider is Wave2-authorized but
 * is NOT a member of the ODS product-test instruction, asserted in both
 * directions so the rider cannot be silently promoted into an ODS grant).
 * ------------------------------------------------------------------------- */

const AMENDMENT_V2_PATH = 'docs/ops/wave2/W2_B5_AUTHORITY_AMENDMENT_v1.0.2.json'
const ODS_ADDENDUM_V2_PATH = 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.18.json'

const amendmentV2 = readJson(AMENDMENT_V2_PATH) as any
const odsAddendumV2 = readJson(ODS_ADDENDUM_V2_PATH) as any

// Written out literally rather than read from the artifact, so the control
// cannot be satisfied by an artifact that redefines its own answer.
const EXPECTED_THREE = [
  'tests/b3-completeness.ui.test.tsx',
  'tests/run-detail-page.sufficiency-reachability.test.tsx',
  'docs/20_STELLA_ROLE_CONTRACTS.md',
] as const

// The two product-test paths the companion ODS addendum instructs — a strict
// subset of the three, and the asymmetry is the point.
const EXPECTED_ODS_TWO = [
  'tests/b3-completeness.ui.test.tsx',
  'tests/run-detail-page.sufficiency-reachability.test.tsx',
] as const

const ADDED_V2: string[] = amendmentV2.amended_authorized_surface.additional_exact_paths
const ODS_INSTRUCTED_V2: string[] =
  odsAddendumV2.hpo_decision.FUNCTION_A_EXISTING_PRODUCT_TEST_DISCIPLINE.paths

/** Effective closed world AFTER v1.0.2 = v1.0.0 enumeration UNION v1.0.1's four UNION v1.0.2's three. */
const EFFECTIVE_PATTERNS_AFTER_V1_0_2 = [...EFFECTIVE_PATTERNS, ...ADDED_V2]

/** Maps a v1.0.2 authorized path to its `path_N` key in closed_world_path_correction. */
function pathKeyOfV2(p: string): string {
  const index = EXPECTED_THREE.indexOf(p as (typeof EXPECTED_THREE)[number])
  if (index < 0) throw new Error(`not one of the three v1.0.2 authorized paths: ${p}`)
  return `path_${index + 1}`
}

describe('W2-B5 amendment v1.0.2 — exact membership (closed world)', () => {
  it('adds exactly three paths, no duplicates, exact set equality in both directions', () => {
    expect(ADDED_V2).toHaveLength(3)
    expect(new Set(ADDED_V2).size).toBe(3)
    expect(amendmentV2.amended_authorized_surface.additional_exact_path_count).toBe(3)
    expect(amendmentV2.amended_authorized_surface.cumulative_additional_exact_path_count).toBe(7)
    // Both directions — never a subset test.
    expect([...ADDED_V2].sort()).toEqual([...EXPECTED_THREE].sort())
    for (const p of EXPECTED_THREE) expect(ADDED_V2).toContain(p)
    for (const p of ADDED_V2) expect(EXPECTED_THREE as readonly string[]).toContain(p)
  })

  it('POS-AMD2-1: each of the three exact paths is a member of the v1.0.2 surface', () => {
    for (const p of EXPECTED_THREE) expect(ADDED_V2).toContain(p)
  })

  it('POS-AMD2-2: each of the three exact paths IS authorized under the EFFECTIVE surface', () => {
    for (const p of EXPECTED_THREE) {
      expect(matchesAnyPattern(p, EFFECTIVE_PATTERNS_AFTER_V1_0_2)).toBe(true)
    }
  })

  it('POS-AMD2-3 (NON-VACUITY): each of the three is authorized under NEITHER predecessor surface', () => {
    // Against v1.0.0 alone AND against v1.0.0 UNION v1.0.1. A path already
    // covered by either would make this amendment vacuous for it, and
    // POS-AMD2-2 would then prove nothing about that path.
    for (const p of EXPECTED_THREE) {
      expect(matchesAnyPattern(p, V1_PATTERNS)).toBe(false)
      expect(matchesAnyPattern(p, EFFECTIVE_PATTERNS)).toBe(false)
    }
  })

  it('POS-AMD2-4: the predecessor surfaces are non-trivial, so NON-VACUITY cannot pass for the wrong reason', () => {
    expect(V1_PATTERNS.length).toBeGreaterThanOrEqual(40)
    expect(EFFECTIVE_PATTERNS.length).toBe(V1_PATTERNS.length + 4)
    // Known members of each predecessor surface are still authorized by it.
    expect(matchesAnyPattern('lib/pipeline/sroi-sensitivity.ts', V1_PATTERNS)).toBe(true)
    expect(matchesAnyPattern('tests/w2-b5-governance.test.ts', V1_PATTERNS)).toBe(true)
    expect(matchesAnyPattern('tests/eval/stella-roles/cases.ts', EFFECTIVE_PATTERNS)).toBe(true)
  })

  it('the two authorized change classes are declared and are non-interchangeable', () => {
    expect(amendmentV2.closed_world_path_correction.path_1.AUTHORIZED_CHANGE_CLASS)
      .toBe('MOCK_OR_TEST_WIRING_ONLY')
    expect(amendmentV2.closed_world_path_correction.path_2.AUTHORIZED_CHANGE_CLASS)
      .toBe('MOCK_OR_TEST_WIRING_ONLY')
    expect(amendmentV2.closed_world_path_correction.path_3.AUTHORIZED_CHANGE_CLASS)
      .toBe('DOCUMENTATION_ALIGNMENT_ONLY')
    expect(amendmentV2.amended_authorized_surface.change_classes_are_not_interchangeable)
      .toContain('as unauthorized as a change to an unauthorized path')
  })

  it('every path carries a mechanical cause, a necessity class and its own prohibition list', () => {
    for (const p of ADDED_V2) {
      const record = amendmentV2.closed_world_path_correction[pathKeyOfV2(p)]
      expect(record.PATH).toBe(p)
      expect(record.DEFECT_CLASS).toBe('A')
      expect(String(record.MECHANICAL_CAUSE).length).toBeGreaterThan(80)
      expect(record.AUTHORIZED_CHANGE_CLASS).toMatch(/^[A-Z_]+$/)
      expect(record.NECESSITY_CLASS).toMatch(/^(GATE_FORCED|GOVERNANCE_FORCED_NOT_GATE_FORCED)$/)
      expect(record.BEHAVIORAL_SCOPE_DELTA).toBe('NONE')
      expect(Array.isArray(record.explicitly_prohibited_within_this_path)).toBe(true)
      expect(record.explicitly_prohibited_within_this_path.length).toBeGreaterThanOrEqual(6)
      expect(record.protected).toBe(false)
    }
    // The docs rider is the ONLY governance-forced path, and it says so.
    expect(amendmentV2.closed_world_path_correction.path_3.NECESSITY_CLASS)
      .toBe('GOVERNANCE_FORCED_NOT_GATE_FORCED')
    expect(amendmentV2.closed_world_path_correction.path_1.NECESSITY_CLASS).toBe('GATE_FORCED')
    expect(amendmentV2.closed_world_path_correction.path_2.NECESSITY_CLASS).toBe('GATE_FORCED')
  })

  it('the test-wiring prohibitions name every weakening route the mission forbids', () => {
    for (const key of ['path_1', 'path_2']) {
      const joined: string = amendmentV2.closed_world_path_correction[key]
        .explicitly_prohibited_within_this_path.join(' | ')
      expect(joined).toMatch(/weakening/i)
      expect(joined).toMatch(/deletion|deleting/i)
      expect(joined).toContain('.skip')
      expect(joined).toContain('.todo')
      expect(joined).toMatch(/reclassif/i)
      expect(joined).toMatch(/production semantics/i)
    }
  })
})

describe('W2-B5 amendment v1.0.2 — negative controls', () => {
  it('NEG-AMD2-1: an adjacent third test is NOT authorized — including the nearest possible sibling', () => {
    const adjacent = [
      // The closest sibling that exists: same filename stem as path_1.
      'tests/b3-completeness.no-ratio.test.ts',
      // Same "<surface>-page.<subject>.reachability" naming family as path_2.
      'tests/admin-proxies-page.reachability.test.tsx',
      // Another real UI host that renders calculation surfaces.
      'tests/calculation-results.test.tsx',
      // Same docs/ directory, adjacent ordinal, same subject family.
      'docs/13_STELLA_AI_SPEC.md',
      'docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md',
    ]
    for (const p of adjacent) {
      expect(ADDED_V2).not.toContain(p)
      expect(ODS_INSTRUCTED_V2).not.toContain(p)
      expect(matchesAnyPattern(p, EFFECTIVE_PATTERNS_AFTER_V1_0_2)).toBe(false)
    }
  })

  it('NEG-AMD2-2: a wildcard is NOT authorized — no entry contains * or **', () => {
    for (const p of ADDED_V2) expect(p).not.toContain('*')
    for (const p of ODS_INSTRUCTED_V2) expect(p).not.toContain('*')
    for (const wildcard of [
      'tests/**',
      'tests/*.test.tsx',
      'tests/b3-completeness.*',
      'docs/**',
      'docs/*.md',
    ]) {
      expect(ADDED_V2).not.toContain(wildcard)
      expect(ODS_INSTRUCTED_V2).not.toContain(wildcard)
    }
  })

  it('NEG-AMD2-3: a directory-prefix inference is REJECTED', () => {
    for (const dir of ['tests/', 'tests/ods/', 'docs/', 'docs/ops/']) {
      expect(ADDED_V2).not.toContain(dir)
      expect(ODS_INSTRUCTED_V2).not.toContain(dir)
      expect(matchesAnyPattern(dir, EFFECTIVE_PATTERNS_AFTER_V1_0_2)).toBe(false)
    }
    // Every entry is a file, never a bare directory.
    for (const p of ADDED_V2) {
      expect(p).toMatch(/\.[a-z]+$/)
      expect(p.endsWith('/')).toBe(false)
    }
  })

  it('NEG-AMD2-4: a production path is REJECTED — this amendment opened no production surface', () => {
    const production = [
      'app/app/projects/[projectId]/pipeline/outcomes/page.tsx',
      'app/(public)/verify/[hash]/page.tsx',
      'lib/reports/render.ts',
      'lib/pipeline/narratives.ts',
      'components/ui/button.tsx',
    ]
    for (const p of production) {
      expect(ADDED_V2).not.toContain(p)
      expect(ODS_INSTRUCTED_V2).not.toContain(p)
      expect(matchesAnyPattern(p, EFFECTIVE_PATTERNS_AFTER_V1_0_2)).toBe(false)
    }
  })

  it('NEG-AMD2-5: the amendment grants NO protected surface', () => {
    for (const p of ADDED_V2) {
      expect(matchesAnyPattern(p, DEFAULT_PROTECTED_PATTERNS)).toBe(false)
      expect(amendmentV2.closed_world_path_correction[pathKeyOfV2(p)].protected).toBe(false)
    }
    expect(odsAddendumV2.protected_grant_required).toBe(false)
    expect(odsAddendumV2.protected_grant).toBeNull()
    expect(odsAddendumV2.PROTECTED_GRANTS_CHANGED).toBe(false)
    expect(odsAddendumV2.PROTECTED_GRANTS_COUNT_BEFORE).toBe(odsAddendumV2.PROTECTED_GRANTS_COUNT_AFTER)
    expect(odsAddendumV2.PROTECTED_GRANTS_COUNT_AFTER).toBe(10)
    expect(odsAddendumV2.W2_17_NOT_WIDENED).toBe(true)
    expect(odsAddendumV2.W2_18_NOT_WIDENED).toBe(true)
  })

  it('NEG-AMD2-6 (O1/O2, THE DOCS-RIDER SPLIT): the ODS instruction covers the TWO product tests and NOT the doc', () => {
    // O1 — exact membership of the ODS instruction, both directions.
    expect(ODS_INSTRUCTED_V2).toHaveLength(2)
    expect(new Set(ODS_INSTRUCTED_V2).size).toBe(2)
    expect(odsAddendumV2.hpo_decision.FUNCTION_A_EXISTING_PRODUCT_TEST_DISCIPLINE.path_count).toBe(2)
    expect([...ODS_INSTRUCTED_V2].sort()).toEqual([...EXPECTED_ODS_TWO].sort())

    // O2 — the doc IS Wave2-authorized and is NOT ODS-instructed. Both halves.
    expect(ADDED_V2).toContain('docs/20_STELLA_ROLE_CONTRACTS.md')
    expect(ODS_INSTRUCTED_V2).not.toContain('docs/20_STELLA_ROLE_CONTRACTS.md')
    const excluded = odsAddendumV2.hpo_decision.FUNCTION_A2_DOCS_RIDER_DELIBERATELY_EXCLUDED
    expect(excluded.EXCLUDED_PATH).toBe('docs/20_STELLA_ROLE_CONTRACTS.md')
    expect(excluded.IS_IT_INSTRUCTED_BY_THIS_ADDENDUM).toBe('NO')
    expect(excluded.prohibited_reading).toContain('must NOT be read as an ODS instruction')
    // And the Wave2 record says the same from its own side, so the two artifacts cannot drift apart.
    expect(amendmentV2.closed_world_path_correction.path_3.ods_instruction_reference)
      .toContain('NONE - DELIBERATE')
  })

  it('NEG-AMD2-7: the frozen predecessors are declared byte-unchanged and carry no semantic delta', () => {
    expect(amendmentV2.amends).toBe(BASE_AUTHORITY_PATH)
    expect(amendmentV2.predecessor_amendment).toBe(AMENDMENT_PATH)
    expect(amendmentV2.amendment_semantics).toContain('APPEND-ONLY')
    expect(amendmentV2.amendment_semantics).toContain('BYTE-UNCHANGED')
    expect(amendmentV2.what_is_unchanged.implementation_semantics).toBe('UNCHANGED.')
    expect(amendmentV2.what_is_unchanged.test_requirements).toContain('BYTE-UNCHANGED')
    expect(amendmentV2.what_is_unchanged.security_semantics).toContain('FAIL-CLOSED')
    expect(amendmentV2.BEHAVIORAL_SCOPE_DELTA).toBe('NONE')
    // The frozen base and the v1.0.1 amendment still read as they did.
    expect(baseAuthority.final_state).toBe('W2_B5_AUTHORITY_FROZEN_WAITING_FOR_IMPLEMENTATION')
    expect(amendment.amended_authorized_surface.additional_exact_path_count).toBe(4)
  })

  it('the strengthened precedent-prohibition clause is present and binding', () => {
    expect(amendmentV2.precedent_prohibition.rule).toContain('NO precedent')
    expect(amendmentV2.precedent_prohibition.specifically_prohibited_inferences.length)
      .toBeGreaterThanOrEqual(8)
    const joined: string = amendmentV2.precedent_prohibition.specifically_prohibited_inferences.join(' | ')
    expect(joined).toContain('tests/** is now open')
    expect(joined).toContain('docs/** is now open')
  })
})

describe('W2-B5 amendment v1.0.2 — mutation controls', () => {
  it('MUT-AMD2-1: removing ANY ONE of the three makes exactly that path unauthorized', () => {
    for (const removed of EXPECTED_THREE) {
      const mutated = [...EFFECTIVE_PATTERNS, ...ADDED_V2.filter((p) => p !== removed)]
      expect(matchesAnyPattern(removed, mutated)).toBe(false)
      // The other two remain authorized — the failure is precise, not collateral.
      for (const other of EXPECTED_THREE.filter((p) => p !== removed)) {
        expect(matchesAnyPattern(other, mutated)).toBe(true)
      }
    }
  })

  it('MUT-AMD2-2: adding an unrelated path breaks exact membership and the closed-world count', () => {
    const mutated = [...ADDED_V2, 'lib/pipeline/methodology-review.ts']
    expect(mutated).toHaveLength(4)
    expect(mutated.length).not.toBe(amendmentV2.amended_authorized_surface.additional_exact_path_count)
    expect([...mutated].sort()).not.toEqual([...EXPECTED_THREE].sort())
  })

  it('MUT-AMD2-3: a case-corrupted spelling of an exact path is NOT authorized', () => {
    const corrupted = [
      'tests/B3-completeness.ui.test.tsx',
      'tests/Run-detail-page.sufficiency-reachability.test.tsx',
      'docs/20_stella_role_contracts.md',
    ]
    for (const p of corrupted) {
      expect(matchesAnyPattern(p, EFFECTIVE_PATTERNS_AFTER_V1_0_2)).toBe(false)
      expect(ADDED_V2).not.toContain(p)
      expect(ODS_INSTRUCTED_V2).not.toContain(p)
    }
  })

  it('MUT-AMD2-4: widening a product-test path to a glob authorizes an adjacent test it must not', () => {
    const adjacent = 'tests/b3-completeness.no-ratio.test.ts'
    expect(matchesAnyPattern(adjacent, EFFECTIVE_PATTERNS_AFTER_V1_0_2)).toBe(false)
    // Proves the exact-path form is load-bearing: widen it and the closed world leaks.
    const widened = [...EFFECTIVE_PATTERNS_AFTER_V1_0_2, 'tests/b3-completeness.*']
    expect(matchesAnyPattern(adjacent, widened)).toBe(true)
  })

  it('MUT-AMD2-5: moving the docs rider into the ODS instruction breaks its cardinality and set equality', () => {
    const mutated = [...ODS_INSTRUCTED_V2, 'docs/20_STELLA_ROLE_CONTRACTS.md']
    expect(mutated).toHaveLength(3)
    expect(mutated.length).not.toBe(
      odsAddendumV2.hpo_decision.FUNCTION_A_EXISTING_PRODUCT_TEST_DISCIPLINE.path_count
    )
    expect([...mutated].sort()).not.toEqual([...EXPECTED_ODS_TWO].sort())
  })
})

describe('W2-B5 amendment v1.0.2 — lineage, one-hole discipline and Controller successor', () => {
  it('O5: allocates exactly v1.0.18 and HPO-ODS-W2-19, and nothing beyond', () => {
    expect(odsAddendumV2.version).toBe('1.0.18')
    expect(odsAddendumV2.GRANT_ID).toBe('HPO-ODS-W2-19')
    expect(amendmentV2.GRANT_ID).toBe('HPO-ODS-W2-19')
    expect(odsAddendumV2.controller_sequencing_rule.no_preallocation).toContain('PROHIBITION')
    expect(odsAddendumV2.controller_sequencing_rule.no_preallocation).toContain('v1.0.19')
    expect(amendmentV2.controller_successor_rule.no_v1_0_19_allocated).toContain('allocates NOTHING beyond')
  })

  it('O6: the two artifacts name each other as companions, with no drift between them', () => {
    expect(amendmentV2.companion_ods_addendum).toBe(ODS_ADDENDUM_V2_PATH)
    expect(odsAddendumV2.companion_wave2_authority).toBe(AMENDMENT_V2_PATH)
    expect(amendmentV2.hpo_mission_id).toBe(odsAddendumV2.hpo_mission_id)
    expect(amendmentV2.anchors.INTEGRATION_SHA).toBe(odsAddendumV2.anchors.INTEGRATION_SHA)
    expect(amendmentV2.anchors.controller_live_immutable_count_at_INTEGRATION_SHA)
      .toBe(odsAddendumV2.anchors.controller_live_immutable_count_at_INTEGRATION_SHA)
    // Every ODS-instructed path is also Wave2-authorized. The converse is NOT asserted — see NEG-AMD2-6.
    for (const p of ODS_INSTRUCTED_V2) expect(ADDED_V2).toContain(p)
  })

  it('the lineage precondition is discharged by measurement, not assumption', () => {
    const pre = amendmentV2.lineage_precondition_discharged
    expect(pre.governing_clause).toContain('STOP_FOR_LINEAGE_SEQUENCING')
    expect(pre.measurement).toContain('finds v1.0.17 ENUMERATED')
    expect(pre.one_hole_after_this_mission).toContain('EXACTLY ONE')
    expect(odsAddendumV2.lineage_derivation.highest_existing_ods_addendum).toBe('v1.0.17')
    expect(odsAddendumV2.lineage_derivation.allocated_here).toBe('v1.0.18')
    expect(odsAddendumV2.lineage_derivation.highest_allocated_hpo_ods_w2_grant_id).toBe('HPO-ODS-W2-18')
    expect(odsAddendumV2.lineage_derivation.allocated_grant_id_here).toBe('HPO-ODS-W2-19')
    expect(odsAddendumV2.lineage_derivation.w2_19_collision_check).toContain('UNALLOCATED')
  })

  it('O4: the Controller successor is declared, bounded to one entry, and NOT performed here', () => {
    const rule = odsAddendumV2.self_inclusion_rule
    expect(rule.paths_to_enumerate).toEqual([ODS_ADDENDUM_V2_PATH])
    expect(rule.count).toBe('28 -> 29')
    expect(rule.exact_membership_never_a_subset_test).toBe(true)
    expect(odsAddendumV2.CONTROLLER29_REQUIRED).toBe(true)
    expect(amendmentV2.CONTROLLER29_REQUIRED).toBe(true)
    expect(odsAddendumV2.CONTROLLER_MAINTENANCE_IMPLEMENTATION_STATUS).toBe('NOT_STARTED_SUCCESSOR_MISSION')
    expect(odsAddendumV2.hpo_decision.FUNCTION_C_CONTROLLER_MAINTENANCE.NOT_PERFORMED_BY_THIS_MISSION)
      .toContain('DELIBERATE')
    expect(amendmentV2.controller_successor_rule.successor_authorized_paths)
      .toEqual(['scripts/ods-controller.ts', 'tests/ods/ods-controller.test.ts'])
    // This mission changes no gate script and no Controller file.
    const changed: string[] = odsAddendumV2.authorized_changed_paths_this_mission.paths
    expect(changed).toHaveLength(3)
    expect(changed).not.toContain('scripts/ods-controller.ts')
    expect(changed).not.toContain('tests/ods/ods-controller.test.ts')
    expect(changed).not.toContain('scripts/ods-scope.ts')
  })

  it('the C8 absence literal is correctly read as a negative control, never as a reservation', () => {
    expect(amendmentV2.controller_successor_rule.c8_absence_control_is_not_an_allocation)
      .toContain('never an allocation')
    expect(odsAddendumV2.hpo_decision.FUNCTION_C_CONTROLLER_MAINTENANCE.c8_absence_control_is_not_an_allocation)
      .toContain('discharged')
  })

  it('this mission authorizes the three paths but modifies none of them', () => {
    const controls = amendmentV2.this_mission_controls
    expect(controls.no_test_host_edit).toContain('NOT modified by this one')
    expect(controls.no_stale_doc_edit).toContain('NOT modified here')
    expect(controls.no_b5_implementation_edit).toContain('NOT touched')
    expect(controls.no_staging).toBe(true)
    expect(controls.no_production).toBe(true)
    expect(controls.no_docker).toBe(true)
    expect(controls.main_unchanged).toBe(true)
    expect(controls.controller_not_changed).toBe(true)
    expect(controls.one_hole_rule).toContain('EXACTLY ONE')
    expect(amendmentV2.READY_FOR_TEST_HOST_REMEDIATION).toBe('NO_UNTIL_AUDITED_INTEGRATED')
  })

  it('the remediation mission is bound to MEASURE before wiring, so the derived necessity cannot be assumed', () => {
    const obligation: string =
      odsAddendumV2.hpo_decision.FUNCTION_A_EXISTING_PRODUCT_TEST_DISCIPLINE
        .measurement_obligation_on_the_remediation_mission
    expect(obligation).toContain('BINDING')
    expect(obligation).toContain('STOP_FOR_AUTHORITY_DELTA')
    for (const key of ['path_1', 'path_2']) {
      expect(amendmentV2.closed_world_path_correction[key].measurement_honesty)
        .toContain('MUST MEASURE')
      expect(amendmentV2.closed_world_path_correction[key].MEASURED_BASELINE)
        .toMatch(/PASSES at INTEGRATION_SHA/)
    }
  })

  it('no unknown findings are carried by either artifact', () => {
    expect(amendmentV2.risks_and_open_findings.UNKNOWN_FINDINGS).toBe(0)
    expect(odsAddendumV2.risks_and_open_findings.UNKNOWN_FINDINGS).toBe(0)
    expect(amendmentV2.W2_B5_RELEVANT_UNKNOWN_FINDINGS).toBe(0)
  })
})
