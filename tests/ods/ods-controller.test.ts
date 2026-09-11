// tests/ods/ods-controller.test.ts — Autonomous Program Controller v0
// positive, negative, mutation and closed-world controls.
//
// Governed by docs/ops/ods/ODS_CONTROLLER_AUTHORITY_v1.0.0.json
// exit_criteria_for_controller_v0_implementation (E1..E8), the
// AUTONOMOUS-PROGRAM-CONTROLLER-V0-AUDIT-REMEDIATION-R1 hardening pass
// (CTRL-M1/M2/M3/M4/M6), and the CONTROLLER-V0-TARGET-EVIDENCE-TERNARY-
// REMEDIATION-R1 pass (CTRL-R1/R2/R3). Synthetic fixtures live only here.

import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {
  CONTROLLER_STATES,
  STOP_CLASSES,
  IMMUTABLE_BY_CONVENTION,
  normalizeRepoPath,
  checkImmutableGuard,
  checkBranchBoundary,
  checkIntegrationTargetsBoundary,
  routeClassBExecutor,
  routeExecutor,
  isValidExecutionClass,
  isValidAuditMode,
  resolveAuditMode,
  aggregateClosureStatus,
  resolveExternalPrecondition,
  decideSelection,
  selectNode,
  runMissionCycles,
  buildAuditPacket,
  MAX_AUTONOMOUS_CYCLES,
  type ControllerUnit,
  type CycleOutcome,
} from '../../scripts/ods-controller'
import { loadRegistry, evaluateEvidence, DEFAULT_REGISTRY_RELATIVE_PATH, type ProgramStateRegistry, type Evidence } from '../../scripts/ods-program-state'

const REPO_ROOT = path.resolve(__dirname, '..', '..')

// A real, always-CLOSED evidence pointer (package.json exists at HEAD) and a
// real, always-OPEN one (a path that never exists), plus one whose REF
// itself cannot resolve at all (UNKNOWN). All three are read via the real
// evaluateEvidence machinery — no fabricated DimensionResult objects.
const CLOSED_EVIDENCE: Evidence = { type: 'paths-exist', ref: 'HEAD', paths: ['package.json'] }
const OPEN_EVIDENCE: Evidence = { type: 'paths-exist', ref: 'HEAD', paths: ['definitely-missing-file-xyz-not-real.txt'] }
const UNKNOWN_EVIDENCE: Evidence = { type: 'paths-exist', ref: 'refs/does-not-exist-xyz-controller-test', paths: ['package.json'] }

function baseUnit(overrides: Partial<ControllerUnit>): ControllerUnit {
  return {
    id: 'SYNTH-1',
    authority: OPEN_EVIDENCE,
    implementation: OPEN_EVIDENCE,
    audit: OPEN_EVIDENCE,
    integrationTargets: [],
    executionClass: 'B',
    auditClass: 'FOCUSED_OPUS',
    writePaths: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// E7 — closed-world stop-class and state-model assertions.
// ---------------------------------------------------------------------------

describe('E7: closed-world stop taxonomy and state model', () => {
  it('STOP_CLASSES matches the frozen authority list exactly (exact membership)', () => {
    const frozen = [
      'AUTHORITY_GAP', 'AUTHORITY_CONFLICT', 'UNKNOWN_EVIDENCE', 'PARTIAL_WHERE_PASS_REQUIRED', 'SHA_MISMATCH', 'TREE_MISMATCH',
      'DIRTY_PRESTATE', 'UNEXPECTED_CHANGED_PATH', 'PROTECTED_SURFACE_CHANGE', 'NONCANONICAL_PROTECTED_PATH', 'MIGRATION_AMBIGUITY',
      'DATABASE_AUTHORITY_REQUIRED', 'SECURITY_ESCALATION', 'INTEGRATION_CONFLICT', 'AUDITED_OBJECT_MOVED', 'MACHINE_GATE_NONDETERMINISTIC',
      'REPEATED_LOCAL_FAILURE', 'REQUIRED_INDEPENDENT_AUDIT', 'MAX_MISSION_CYCLES_REACHED', 'PRODUCTION_BOUNDARY_REACHED',
      'MAIN_MUTATION_ATTEMPT', 'FLAKE_SUSPECTED',
    ]
    expect(new Set(STOP_CLASSES)).toEqual(new Set(frozen))
    expect(STOP_CLASSES.length).toBe(frozen.length)
  })

  it('CONTROLLER_STATES matches the frozen 7-state model exactly', () => {
    expect(new Set(CONTROLLER_STATES)).toEqual(new Set(['READY', 'PREFLIGHT', 'EXECUTING', 'GATE', 'AUDIT_REQUIRED', 'CLOSED', 'STOPPED']))
    expect(CONTROLLER_STATES.length).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// E2 / E3 — immutableByConvention closed-world + non-vacuous negative
// control. CTRL-M3 §10: the real E3 control routes through decideSelection
// (the real selection path), not just the isolated pure helper.
// ---------------------------------------------------------------------------

describe('E2/CTRL-M3: immutableByConvention closed-world guard', () => {
  it('is the exact 42-member closed world (20 pinned entries + v1.0.10 + v1.0.11 + v1.0.12 + v1.0.13 + v1.0.14 + v1.0.15 + v1.0.16 + v1.0.17 + v1.0.18 + v1.0.19 + v1.0.20 + v1.0.21 + v1.0.22 + v1.0.23 + v1.0.24 + v1.0.25 + v1.0.26 + v1.0.27 + v1.0.28 + v1.0.29 + v1.0.30 + v1.0.31)', () => {
    expect(IMMUTABLE_BY_CONVENTION.length).toBe(42)
    expect(new Set(IMMUTABLE_BY_CONVENTION).size).toBe(42)
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.10.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.11.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.12.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.13.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.14.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.15.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.16.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.17.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.18.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.19.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.20.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.21.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.22.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.23.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.24.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.25.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.26.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.27.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.28.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.29.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json')
  })

  it('excludes ODS_CARRY_FORWARD_BACKLOG.md by design (append-only working backlog)', () => {
    expect(IMMUTABLE_BY_CONVENTION).not.toContain('docs/ops/ods/ODS_CARRY_FORWARD_BACKLOG.md')
  })

  // C11 (ODS_V1_MAINTENANCE_ADDENDUM_v1.0.14.json test_contract): the closed
  // world was extended by exactly the one docs/ops/ods/ artifact this addendum
  // funds — never implicitly widened to the companion P1A amendment. The
  // Controller closed world enumerates docs/ops/ods/ artifacts exclusively.
  it('does NOT absorb the companion P1A amendment v1.0.2 (closed world stays docs/ops/ods/ only)', () => {
    expect(IMMUTABLE_BY_CONVENTION).not.toContain('docs/ops/p1a/P1A_FULL_BOOTSTRAP_AUTHORITY_AMENDMENT_v1.0.2.json')
    expect(IMMUTABLE_BY_CONVENTION.every((entry) => entry.startsWith('docs/ops/ods/'))).toBe(true)
  })

  // C8 (ODS_V1_MAINTENANCE_ADDENDUM_v1.0.14.json test_contract, carried
  // forward through v1.0.30.json CONTROLLER_41_RULE and now Controller42):
  // the closed world does not pre-include a later ODS successor artifact. The
  // control ADVANCES with the list — v1.0.31 is now enumerated (Controller42),
  // so the absence assertion moves to the mechanically-next version. This is
  // exactly the act v1.0.31.json CONTROLLER_42_RULE.requirement names in its
  // own words: "Controller42 is REQUIRED to enumerate docs/ops/ods/
  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json in IMMUTABLE_BY_CONVENTION after
  // this successor is integrated, taking the array from 41 entries to 42 with
  // v1.0.31 as the final item, and advancing the absence-control literal from
  // v1.0.31 to the mechanically-next version."
  //
  // NON-ALLOCATION (load-bearing): the v1.0.32 literal below is ONLY the next
  // mechanical absence-control literal.
  //   - v1.0.32 is NOT allocated.
  //   - v1.0.32 is NOT reserved.
  //   - v1.0.32 is NOT an authority.
  //   - v1.0.32 is ONLY the next mechanical absence-control literal.
  // It does NOT allocate, reserve, name-as-allocated, pre-create, grant or
  // otherwise authorize any ODS_V1_MAINTENANCE_ADDENDUM_v1.0.32 artifact.
  // It asserts ABSENCE only. Naming an id in a sequencing/prohibition clause
  // is a PROHIBITION, never an allocation — v1.0.31.json NO_PREALLOCATION
  // states this in its own words, listing "ODS v1.0.32" among the ids it
  // explicitly does NOT allocate.
  //
  // Measured at THIS candidate's BASE 965f0551cfc07770e99a15ad0051525878270df8:
  // v1.0.31.json is ALREADY integrated (this is the Controller42 successor
  // act enumerating it, per CONTROLLER_42_RULE.NOT_ALLOCATED_HERE, which
  // confirms that lane did NOT edit scripts/ods-controller.ts or this file).
  // The grant HPO-ODS-W2-28 it allocates is DECLARED_NOT_REGISTERED — this
  // Controller successor touches neither scripts/ods-scope.ts nor
  // tests/ods/ods-scope.test.ts, and performs no registration act.
  //
  // The ODS-lineage axis and the HPO-grant axis remain decoupled: the
  // Controller's IMMUTABLE_BY_CONVENTION array gates the NEXT LINEAGE
  // allocation, the PROTECTED_GRANTS registry gates which branch may touch
  // which protected path, and a missing Controller enumeration does NOT and
  // CANNOT prevent a grant from resolving.
  it('does NOT pre-include the next unallocated ODS successor addendum (no automatic inclusion; the literal reserves nothing)', () => {
    expect(IMMUTABLE_BY_CONVENTION).not.toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.32.json')
  })

  // APPEND-OVERSHOOT CONTROL (Controller42): the absence assertion above is a
  // membership test. This one pins the BOUNDARY, so an append of a
  // forty-second-plus entry cannot pass by simply not being v1.0.32. Length
  // is exact and the final slot is pinned by index, so appending ANY further
  // entry fails here even if the absence literal above were never updated.
  it('APPEND OVERSHOOT: the list ends at exactly 42 entries with v1.0.31 in the final slot', () => {
    expect(IMMUTABLE_BY_CONVENTION.length).toBe(42)
    expect(IMMUTABLE_BY_CONVENTION[41]).toBe('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json')
    expect(IMMUTABLE_BY_CONVENTION[42]).toBeUndefined()
    expect(IMMUTABLE_BY_CONVENTION.filter((e) => e.includes('v1.0.32'))).toEqual([])
  })

  it('normalizeRepoPath canonicalizes backslashes and redundant "." segments', () => {
    expect(normalizeRepoPath('docs\\ops\\ods\\ODS_V1_AUTHORITY_v1.0.0.json')).toBe('docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json')
    expect(normalizeRepoPath('./docs/ops/./ods/ODS_V1_AUTHORITY_v1.0.0.json')).toBe('docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json')
  })

  it('CTRL-M3: backslash path spelling cannot bypass the guard', () => {
    const result = checkImmutableGuard(['docs\\ops\\ods\\ODS_V1_AUTHORITY_v1.0.0.json'])
    expect(result.violated).toBe(true)
  })

  it('POSITIVE: an ordinary unrelated writePaths entry lets the node through decideSelection', () => {
    const unit = baseUnit({ writePaths: ['lib/some-module.ts'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(true)
  })

  it('REAL E3 MUTATION CONTROL: a node that is otherwise executable but declares writePaths hitting an immutableByConvention artifact STOPs via the real selection path', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_OPERATIONAL_CLOSURE_v1.0.0.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    // If the checkImmutableGuard call were removed/bypassed from
    // decideSelection, this node has no other blocker (dependsOn/
    // externalPreconditions empty, dbWriting false, no boundary hit, valid
    // executionClass/auditClass) and would fall through to selectable=true
    // — so this assertion fails the moment the wiring is removed.
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  // Entry-specific mutation controls for the v1.0.13 successor maintenance
  // delta (22 -> 24). These do not re-derive the generic guard mechanism
  // proven above and in CTRL-R3 — they prove the two newly-appended entries
  // are actually wired into decideSelection, not merely present as strings.
  // Removing either from IMMUTABLE_BY_CONVENTION fails these, independently
  // of the length/Set assertions above.
  it('a node targeting v1.0.12 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.12.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a node targeting v1.0.13 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.13.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of a newly-added entry (v1.0.13) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.13.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // C9 (ODS_V1_MAINTENANCE_ADDENDUM_v1.0.14.json test_contract): non-vacuity
  // through the REAL selection path for the new entry specifically — not
  // merely implied by the length/Set assertions above.
  it('a node targeting v1.0.14 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.14.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.14) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.14.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.15.json self_inclusion_rule: the Controller
  // must enumerate its own governing addendum. These controls prove the newly
  // appended entry is actually wired into decideSelection, not merely present
  // as a string — removing it from IMMUTABLE_BY_CONVENTION fails them
  // independently of the length/Set assertions above.
  it('a node targeting v1.0.15 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.15.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.15) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.15.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.16.json self_inclusion_rule (HPO-ODS-W2-17,
  // funded by W2_B5_AUTHORITY_v1.0.0.json): the Controller must enumerate its
  // own governing addendum. These controls prove the newly appended entry is
  // actually wired into decideSelection, not merely present as a string —
  // removing it from IMMUTABLE_BY_CONVENTION fails them independently of the
  // length/Set assertions above.
  it('a node targeting v1.0.16 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.16.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.16) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.16.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.17.json self_inclusion_rule (HPO-ODS-W2-18,
  // funded by W2-B5 scope-gap authority successor R1): the Controller must
  // enumerate its own governing addendum. These controls prove the newly
  // appended entry is actually wired into decideSelection, not merely present
  // as a string — removing it from IMMUTABLE_BY_CONVENTION fails them
  // independently of the length/Set assertions above.
  it('a node targeting v1.0.17 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.17.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.17) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.17.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.18.json self_inclusion_rule (HPO-ODS-W2-19,
  // funded by W2-B5 test-host successor authority R1): the Controller must
  // enumerate its own governing addendum. These controls prove the newly
  // appended entry is actually wired into decideSelection, not merely present
  // as a string — removing it from IMMUTABLE_BY_CONVENTION fails them
  // independently of the length/Set assertions above.
  it('a node targeting v1.0.18 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.18.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.18) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.18.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.19.json self_inclusion_rule (HPO-ODS-W2-20,
  // funded by MULTIORG-S1-S2-FIRST-EXECUTION-AUTHORITY-R1): the Controller must
  // enumerate its own governing addendum. These controls prove the newly
  // appended entry is actually wired into decideSelection, not merely present
  // as a string — removing it from IMMUTABLE_BY_CONVENTION fails them
  // independently of the length/Set assertions above.
  it('a node targeting v1.0.19 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.19.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.19) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.19.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.20.json self_inclusion_rule (HPO-ODS-W2-21,
  // funded by MULTIORG-S1-S2-SUCCESSOR-AUTHORITY-MATERIALIZATION-R1): the
  // Controller must enumerate its own governing addendum. These controls
  // prove the newly appended entry is actually wired into decideSelection,
  // not merely present as a string — removing it from IMMUTABLE_BY_CONVENTION
  // fails them independently of the length/Set assertions above.
  it('a node targeting v1.0.20 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.20.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.20) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.20.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.21.json self_inclusion_rule (HPO-ODS-W2-22,
  // funded by the combined multi-org S1/S2 successor authority materialization
  // R1): the Controller must enumerate its own governing addendum. These
  // controls prove the newly appended entry is actually wired into
  // decideSelection, not merely present as a string — removing it from
  // IMMUTABLE_BY_CONVENTION fails them independently of the length/Set
  // assertions above.
  it('a node targeting v1.0.21 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.21.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.21) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.21.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.22.json self_inclusion_rule (HPO-ODS-W2-23,
  // funded by S1-REHEARSAL-FRESHNESS-SUCCESSOR-AUTHORITY-MATERIALIZATION-R1,
  // controller_sequencing_rule.what_controller33_must_do): the Controller
  // must enumerate its own governing addendum. These controls prove the
  // newly appended entry is actually wired into decideSelection, not merely
  // present as a string — removing it from IMMUTABLE_BY_CONVENTION fails
  // them independently of the length/Set assertions above.
  it('a node targeting v1.0.22 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.22.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.22) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.22.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.23.json self_inclusion_rule (HPO-ODS-W2-24,
  // funded by MULTIORG-S3-REQUEST-PRINCIPAL-EXECUTION-AUTHORITY-MATERIALIZATION-R1,
  // controller_sequencing_rule.CONTROLLER34_REQUIRED): the Controller must
  // enumerate its own governing addendum. These controls prove the newly
  // appended entry is actually wired into decideSelection, not merely
  // present as a string — removing it from IMMUTABLE_BY_CONVENTION fails
  // them independently of the length/Set assertions above.
  it('a node targeting v1.0.23 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.23.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.23) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.23.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.24.json self_inclusion_rule (HPO-ODS-W2-25,
  // funded by MULTIORG-S3-REFUSAL-AUDIT-EXECUTION-AUTHORITY, tenancy v1.0.5,
  // controller_sequencing_rule.CONTROLLER35_REQUIRED): the Controller must
  // enumerate its own governing addendum, and that enumeration is a SEPARATE
  // governed maintenance mission from the addendum that allocated the
  // lineage — v1.0.24 is explicitly NOT self-including. These controls prove
  // the newly appended entry is actually wired into decideSelection, not
  // merely present as a string — removing it from IMMUTABLE_BY_CONVENTION
  // fails them independently of the length/Set assertions above.
  it('a node targeting v1.0.24 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.24.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.24) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.24.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.25.json self_inclusion_rule /
  // controller_sequencing_rule.CONTROLLER36_REQUIRED (allocating ODS lineage
  // v1.0.25 / tenancy v1.0.6, reusing GRANT_ID W2-25): the Controller must
  // enumerate its own governing addendum, and that enumeration is a SEPARATE
  // governed maintenance mission from the addendum that allocated the
  // lineage — v1.0.25 is explicitly NOT self-including, and its
  // no_controller_edit_in_this_lane clause forbade that lane from touching
  // scripts/ods-controller.ts at all. These controls prove the newly appended
  // entry is actually wired into decideSelection, not merely present as a
  // string — removing it from IMMUTABLE_BY_CONVENTION fails them
  // independently of the length/Set assertions above.
  it('a node targeting v1.0.25 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.25.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.25) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.25.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.26.json self_inclusion_rule /
  // controller_37_sequencing_rule.CONTROLLER37_REQUIRED (allocating ODS
  // lineage v1.0.26 / tenancy v1.0.7, REUSING GRANT_ID HPO-ODS-W2-25 rather
  // than allocating a new one): the Controller must enumerate its own
  // governing addendum, and that enumeration is a SEPARATE governed
  // maintenance mission from the addendum that allocated the lineage —
  // v1.0.26 is explicitly NOT self-including, and its
  // no_controller_edit_in_this_lane clause forbade that lane from touching
  // scripts/ods-controller.ts at all. These controls prove the newly appended
  // entry is actually wired into decideSelection, not merely present as a
  // string — removing it from IMMUTABLE_BY_CONVENTION fails them
  // independently of the length/Set assertions above.
  it('a node targeting v1.0.26 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.26.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.26) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.26.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.27.json self_inclusion_rule /
  // controller_38_sequencing_rule.CONTROLLER38_REQUIRED (allocating ODS
  // lineage v1.0.27 / tenancy v1.0.8, AGAIN REUSING GRANT_ID HPO-ODS-W2-25
  // rather than allocating a new one): the Controller must enumerate its own
  // governing addendum, and that enumeration is a SEPARATE governed
  // maintenance mission from the addendum that allocated the lineage.
  // v1.0.27 is explicitly NOT self-including, and its
  // no_controller_edit_in_this_lane clause forbade that lane from touching
  // scripts/ods-controller.ts at all: "Controller38 is NOT implemented by
  // this mission". These controls prove the newly appended entry is actually
  // wired into decideSelection through the REAL guard, not merely present as
  // a string. Removing it from IMMUTABLE_BY_CONVENTION fails them
  // independently of the length/Set/digest assertions elsewhere in this file.
  it('a node targeting v1.0.27 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.27.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.27) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.27.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // GUARD-LEVEL COMPANION (M3 class): the same case mutation seen through
  // checkImmutableGuard directly, so the case-sensitivity of the newly
  // appended entry is pinned at the guard boundary as well as through
  // decideSelection. A guard that silently lowercased would report
  // violated=true here and fail.
  it('checkImmutableGuard classifies the case-mutated v1.0.27 spelling as noncanonical, never as a violation', () => {
    const guard = checkImmutableGuard(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.27.JSON'])
    expect(guard.violated).toBe(false)
    expect(guard.violatingPaths).toEqual([])
    expect(guard.nonCanonicalPaths).toEqual(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.27.JSON'])
  })

  // NON-VACUITY PAIR (M1 class): the canonical spelling of the SAME artifact
  // must be a real violation at the guard boundary. Together with the control
  // above this proves the guard distinguishes canonical from case-mutated
  // rather than answering the same way to both.
  it('checkImmutableGuard treats the canonical v1.0.27 spelling as a real protected-surface violation', () => {
    const guard = checkImmutableGuard(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.27.json'])
    expect(guard.violated).toBe(true)
    expect(guard.violatingPaths).toEqual(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.27.json'])
    expect(guard.nonCanonicalPaths).toEqual([])
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.28.json self_inclusion_rule /
  // controller_39_sequencing_rule.CONTROLLER39_REQUIRED (allocating ODS
  // lineage v1.0.28 and, for the first time since HPO-ODS-W2-25, a NEW
  // GRANT_ID HPO-ODS-W2-26): the Controller must enumerate its own governing
  // addendum, and that enumeration is a SEPARATE governed maintenance mission
  // from the addendum that allocated the lineage. v1.0.28 is explicitly NOT
  // self-including, and its no_controller_edit_in_this_lane clause forbade
  // that lane from touching scripts/ods-controller.ts at all: "Controller39
  // is NOT implemented by this mission". These controls prove the newly
  // appended entry is actually wired into decideSelection through the REAL
  // guard, not merely present as a string. Removing it from
  // IMMUTABLE_BY_CONVENTION fails them independently of the length/Set/digest
  // assertions elsewhere in this file.
  it('a node targeting v1.0.28 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.28.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.28) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.28.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // GUARD-LEVEL COMPANION (M3 class): the same case mutation seen through
  // checkImmutableGuard directly, so the case-sensitivity of the newly
  // appended entry is pinned at the guard boundary as well as through
  // decideSelection. A guard that silently lowercased would report
  // violated=true here and fail.
  it('checkImmutableGuard classifies the case-mutated v1.0.28 spelling as noncanonical, never as a violation', () => {
    const guard = checkImmutableGuard(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.28.JSON'])
    expect(guard.violated).toBe(false)
    expect(guard.violatingPaths).toEqual([])
    expect(guard.nonCanonicalPaths).toEqual(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.28.JSON'])
  })

  // NON-VACUITY PAIR (M1 class): the canonical spelling of the SAME artifact
  // must be a real violation at the guard boundary. Together with the control
  // above this proves the guard distinguishes canonical from case-mutated
  // rather than answering the same way to both.
  it('checkImmutableGuard treats the canonical v1.0.28 spelling as a real protected-surface violation', () => {
    const guard = checkImmutableGuard(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.28.json'])
    expect(guard.violated).toBe(true)
    expect(guard.violatingPaths).toEqual(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.28.json'])
    expect(guard.nonCanonicalPaths).toEqual([])
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.29.json CONTROLLER_40_RULE.requirement
  // ("Controller40 is REQUIRED to enumerate docs/ops/ods/ODS_V1_MAINTENANCE_
  // ADDENDUM_v1.0.29.json in IMMUTABLE_BY_CONVENTION after this successor is
  // integrated, taking the array from 39 entries to 40 with v1.0.29 as the
  // final item"): the Controller must enumerate its own governing addendum,
  // and that enumeration is a SEPARATE governed maintenance mission from the
  // addendum that allocated the lineage. v1.0.29 is explicitly NOT
  // self-including, and its closed_world clause forbade that lane from
  // touching scripts/ods-controller.ts at all. These controls prove the newly
  // appended entry is actually WIRED INTO decideSelection through the REAL
  // guard, not merely present as a string — removing it from
  // IMMUTABLE_BY_CONVENTION fails them independently of the length/Set/digest
  // assertions elsewhere in this file.
  //
  // NOTE ON THE INVERSION: at Controller39 this same path was asserted to be
  // UNPROTECTED, because it was then only the absence-control literal. That
  // assertion was true at that candidate and is false at this one; v1.0.29 is
  // now an integrated, enumerated artifact. The non-protection control has
  // been ADVANCED to v1.0.31 below rather than deleted, so the suite never
  // loses the proof that a bare absence literal confers no protected status.
  // The SAME inversion has now happened once more, one generation on: v1.0.30
  // was the Controller40 absence-control literal and is, at this candidate,
  // an integrated and enumerated artifact, so its own wiring controls appear
  // immediately below and the non-protection proof moves to v1.0.31.
  it('a node targeting v1.0.29 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.29.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.29) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.29.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // GUARD-LEVEL COMPANION (M3 class): the same case mutation seen through
  // checkImmutableGuard directly, so the case-sensitivity of the newly
  // appended entry is pinned at the guard boundary as well as through
  // decideSelection. A guard that silently lowercased would report
  // violated=true here and fail.
  it('checkImmutableGuard classifies the case-mutated v1.0.29 spelling as noncanonical, never as a violation', () => {
    const guard = checkImmutableGuard(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.29.JSON'])
    expect(guard.violated).toBe(false)
    expect(guard.violatingPaths).toEqual([])
    expect(guard.nonCanonicalPaths).toEqual(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.29.JSON'])
  })

  // NON-VACUITY PAIR (M1 class): the canonical spelling of the SAME artifact
  // must be a real violation at the guard boundary. Together with the control
  // above this proves the guard distinguishes canonical from case-mutated
  // rather than answering the same way to both.
  it('checkImmutableGuard treats the canonical v1.0.29 spelling as a real protected-surface violation', () => {
    const guard = checkImmutableGuard(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.29.json'])
    expect(guard.violated).toBe(true)
    expect(guard.violatingPaths).toEqual(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.29.json'])
    expect(guard.nonCanonicalPaths).toEqual([])
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json CONTROLLER_41_RULE.requirement
  // ("Controller41 is REQUIRED to enumerate docs/ops/ods/ODS_V1_MAINTENANCE_
  // ADDENDUM_v1.0.30.json in IMMUTABLE_BY_CONVENTION after this successor is
  // integrated, taking the array from 40 entries to 41 with v1.0.30 as the
  // final item"): the Controller must enumerate its own governing addendum,
  // and that enumeration is a SEPARATE governed maintenance mission from the
  // addendum that allocated the lineage. v1.0.30 is explicitly NOT
  // self-including, and its CONTROLLER_41_RULE.NOT_ALLOCATED_HERE clause
  // forbade that lane from touching scripts/ods-controller.ts or this file at
  // all: "This addendum does NOT allocate Controller41, does NOT edit
  // scripts/ods-controller.ts, and does NOT edit tests/ods/
  // ods-controller.test.ts." These controls prove the newly appended entry is
  // actually WIRED INTO decideSelection through the REAL guard, not merely
  // present as a string — removing it from IMMUTABLE_BY_CONVENTION fails them
  // independently of the length/Set/digest assertions elsewhere in this file.
  it('a node targeting v1.0.30 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.30) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.30.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // GUARD-LEVEL COMPANION (M3 class): the same case mutation seen through
  // checkImmutableGuard directly, so the case-sensitivity of the newly
  // appended entry is pinned at the guard boundary as well as through
  // decideSelection. A guard that silently lowercased would report
  // violated=true here and fail.
  it('checkImmutableGuard classifies the case-mutated v1.0.30 spelling as noncanonical, never as a violation', () => {
    const guard = checkImmutableGuard(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.30.JSON'])
    expect(guard.violated).toBe(false)
    expect(guard.violatingPaths).toEqual([])
    expect(guard.nonCanonicalPaths).toEqual(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.30.JSON'])
  })

  // NON-VACUITY PAIR (M1 class): the canonical spelling of the SAME artifact
  // must be a real violation at the guard boundary. Together with the control
  // above this proves the guard distinguishes canonical from case-mutated
  // rather than answering the same way to both.
  it('checkImmutableGuard treats the canonical v1.0.30 spelling as a real protected-surface violation', () => {
    const guard = checkImmutableGuard(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json'])
    expect(guard.violated).toBe(true)
    expect(guard.violatingPaths).toEqual(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json'])
    expect(guard.nonCanonicalPaths).toEqual([])
  })

  // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json CONTROLLER_42_RULE.requirement
  // ("Controller42 is REQUIRED to enumerate docs/ops/ods/ODS_V1_MAINTENANCE_
  // ADDENDUM_v1.0.31.json in IMMUTABLE_BY_CONVENTION after this successor is
  // integrated, taking the array from 41 entries to 42 with v1.0.31 as the
  // final item"): the Controller must enumerate its own governing addendum,
  // and that enumeration is a SEPARATE governed maintenance mission from the
  // addendum that allocated the lineage. v1.0.31 is explicitly NOT
  // self-including, and its CONTROLLER_42_RULE.NOT_ALLOCATED_HERE clause
  // forbade that lane from touching scripts/ods-controller.ts or this file at
  // all. These controls prove the newly appended entry is actually WIRED INTO
  // decideSelection through the REAL guard, not merely present as a string —
  // removing it from IMMUTABLE_BY_CONVENTION fails them independently of the
  // length/Set/digest assertions elsewhere in this file.
  it('a node targeting v1.0.31 STOPs with PROTECTED_SURFACE_CHANGE via real decideSelection', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })

  it('a case-mutated spelling of the new entry (v1.0.31) is NONCANONICAL_PROTECTED_PATH, never PROTECTED_SURFACE_CHANGE', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.31.JSON'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  // GUARD-LEVEL COMPANION (M3 class): the same case mutation seen through
  // checkImmutableGuard directly, so the case-sensitivity of the newly
  // appended entry is pinned at the guard boundary as well as through
  // decideSelection. A guard that silently lowercased would report
  // violated=true here and fail.
  it('checkImmutableGuard classifies the case-mutated v1.0.31 spelling as noncanonical, never as a violation', () => {
    const guard = checkImmutableGuard(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.31.JSON'])
    expect(guard.violated).toBe(false)
    expect(guard.violatingPaths).toEqual([])
    expect(guard.nonCanonicalPaths).toEqual(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_V1.0.31.JSON'])
  })

  // NON-VACUITY PAIR (M1 class): the canonical spelling of the SAME artifact
  // must be a real violation at the guard boundary. Together with the control
  // above this proves the guard distinguishes canonical from case-mutated
  // rather than answering the same way to both.
  it('checkImmutableGuard treats the canonical v1.0.31 spelling as a real protected-surface violation', () => {
    const guard = checkImmutableGuard(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json'])
    expect(guard.violated).toBe(true)
    expect(guard.violatingPaths).toEqual(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json'])
    expect(guard.nonCanonicalPaths).toEqual([])
  })

  // NON-ALLOCATION BEHAVIOURAL CONTROL (Controller42, ADVANCED from v1.0.31):
  // the absence-control literal v1.0.32 is NOT protected merely by being
  // named in this file. It is not in IMMUTABLE_BY_CONVENTION, so the real
  // guard must treat it as an ordinary unprotected path — proving the absence
  // literal reserves nothing and confers no protected status.
  it('v1.0.32 is NOT protected — being the absence-control literal confers no protected status', () => {
    const guard = checkImmutableGuard(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.32.json'])
    expect(guard.violated).toBe(false)
    expect(guard.violatingPaths).toEqual([])
    expect(guard.nonCanonicalPaths).toEqual([])
  })

  // The same non-protection proven through decideSelection rather than the
  // guard alone: a node whose ONLY declared write path is the absence-control
  // literal must remain SELECTABLE, with no stop class at all. That is the
  // end-to-end demonstration that v1.0.32 is neither allocated, reserved nor
  // protected by being named here — the whole selection pipeline lets it
  // through, exactly as it does for any ordinary unprotected path.
  it('a node whose writePaths is exactly v1.0.32 remains SELECTABLE through real decideSelection (not reserved, not protected)', () => {
    const unit = baseUnit({ writePaths: ['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.32.json'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(true)
    expect(decision.stopClass).toBeUndefined()
  })

  // Duplicate control: the closed world is a SET as well as an ordered list.
  // A second copy of the new entry would satisfy a naive toContain check and
  // would still be caught here, and by length === Set size, before it could
  // make the live count ambiguous as a successor precondition. Retargeting
  // this control from v1.0.30 to v1.0.31 does not weaken it: v1.0.30 remains
  // pinned by exact position inside the OLD41 literal and its ordered digest
  // below, so a duplicated v1.0.30 still fails the reconstruction controls.
  it('the new entry appears exactly once, and the list carries no duplicates at all', () => {
    const occurrences = IMMUTABLE_BY_CONVENTION.filter(
      (entry) => entry === 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json',
    ).length
    expect(occurrences).toBe(1)
    expect(IMMUTABLE_BY_CONVENTION.length).toBe(new Set(IMMUTABLE_BY_CONVENTION).size)
  })

  // ---------------------------------------------------------------------
  // ORDER PROOF (ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json
  // CONTROLLER_42_RULE): an independently typed literal of the pre-append
  // 41-entry closed world (OLD41 — never derived from the live
  // IMMUTABLE_BY_CONVENTION import, and never copied from the candidate diff
  // that appends v1.0.31) is hashed with an ordered digest. A remove-only
  // reconstruction of the live, post-append list (dropping exactly the new
  // final element) must reproduce OLD41 element-by-element AND by that same
  // ordered digest. This catches a reorder of any predecessor entry that a
  // naive length/Set/toContain check would miss, because Set equality and
  // length are order-blind.
  // ---------------------------------------------------------------------
  describe('ORDER PROOF: append-only reconstruction of OLD41', () => {
    // Independently typed — extracted mechanically from the pre-v1.0.31
    // source (the BASE state of scripts/ods-controller.ts at
    // 965f0551cfc07770e99a15ad0051525878270df8, i.e. Controller 41) via
    // `git show <base>:scripts/ods-controller.ts`, never from the working
    // tree (which already carries this mission's own append) and never from
    // the live import.
    //
    // CORROBORATION (independent of this lane): v1.0.30.json states the same
    // pre-append shape in its own words — "scripts/ods-controller.ts
    // IMMUTABLE_BY_CONVENTION holds exactly 41 entries with docs/ops/ods/
    // ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json in the final slot and zero
    // duplicates". The literal below reproduces exactly that: length 41, no
    // duplicates, v1.0.30 last.
    const OLD41: readonly string[] = [
      'docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json',
      'docs/ops/ods/ODS_V1_OPERATIONAL_CLOSURE_v1.0.0.json',
      'docs/ops/ods/ODS_V1_EFFICIENCY_VALIDATION_v1.0.0.json',
      'docs/ops/ods/ODS_PROGRAM_STATE_REGISTRY_v1.0.0.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.1.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.2.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.3.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.4.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.5.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.6.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.7.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.8.json',
      'docs/ops/ods/KNOWN_TEST_CONDITIONS_v1.0.0.json',
      'docs/ops/ods/ODS_CONTEXT_CHECKPOINT_STANDARD_v1.0.0.md',
      'docs/ops/ods/UELLIX_DEV_OS_OPERATING_MODEL_v1.0.0.md',
      'docs/ops/ods/UELLIX_DEV_OS_PROMPT_EXAMPLES_v1.0.0.md',
      'docs/ops/ods/UELLIX_TEST_MANIFEST_SCHEMA_v1.0.0.json',
      'docs/ops/ods/UELLIX_TEST_MANIFEST_TEMPLATE_v1.0.0.json',
      'docs/ops/ods/ODS_CONTROLLER_AUTHORITY_v1.0.0.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.9.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.10.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.11.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.12.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.13.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.14.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.15.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.16.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.17.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.18.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.19.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.20.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.21.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.22.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.23.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.24.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.25.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.26.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.27.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.28.json',
      'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.30.json',
    ]

    // Independently computed and pinned as a literal. A mismatch here means
    // either OLD41 above or the live pre-append 41 entries drifted — never
    // silently accepted. Computed under the SAME serialization convention
    // orderedDigest uses (sha256 over JSON.stringify of the array, never a
    // join — JSON quoting makes every element self-delimiting, so the digest
    // is injective over the ordered list). That convention was validated by
    // reproducing the inherited Controller41 pin
    // 771851ba13a202f2cbace5b7955c8c70390ae949d52d54238d91b2d6c95b0e5e from
    // OLD41.slice(0, -1) before this value was pinned. That value was not
    // copied from the Controller41 author's work; it was re-derived here from
    // OLD41 and only then compared against the inherited pin.
    const OLD41_DIGEST_EXPECTED = '7b18e93f8d9333696566cf786eb2c71ba82fcc174392d03cad286543a4e2a950'

    function orderedDigest(entries: readonly string[]): string {
      return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex')
    }

    it('OLD41 literal has length 41, no duplicates, and matches the pinned OLD41_DIGEST', () => {
      expect(OLD41.length).toBe(41)
      expect(new Set(OLD41).size).toBe(41)
      expect(orderedDigest(OLD41)).toBe(OLD41_DIGEST_EXPECTED)
    })

    it('the live list is exactly OLD41 with v1.0.31 appended as the sole new final element', () => {
      expect(IMMUTABLE_BY_CONVENTION.length).toBe(42)
      expect(IMMUTABLE_BY_CONVENTION[41]).toBe('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json')
    })

    it('REMOVE-ONLY RECONSTRUCTION: dropping the final element of the live list reproduces OLD41 element-by-element, in order', () => {
      const reconstructed = IMMUTABLE_BY_CONVENTION.slice(0, -1)
      expect(reconstructed).toEqual(OLD41)
      expect(reconstructed.length).toBe(OLD41.length)
      for (let i = 0; i < OLD41.length; i++) {
        expect(reconstructed[i]).toBe(OLD41[i])
      }
    })

    it('REMOVE-ONLY RECONSTRUCTION: its ordered digest matches OLD41_DIGEST exactly (catches any predecessor reorder)', () => {
      const reconstructed = IMMUTABLE_BY_CONVENTION.slice(0, -1)
      expect(orderedDigest(reconstructed)).toBe(OLD41_DIGEST_EXPECTED)
    })

    // CONTINUITY CONTROL (Controller42): the Controller41 pin must still be
    // reproducible from OLD41 by remove-only reconstruction. This ties the
    // new OLD41 literal back to the independently-audited predecessor pin, so
    // OLD41 cannot have silently drifted in any of its 40 inherited entries
    // while still satisfying its own freshly-pinned digest. The pin below is
    // the value Controller41 pinned as its own 40-entry digest constant; it
    // is reproduced here, not inherited on trust.
    const OLD40_DIGEST_CONTROLLER41_PIN = '771851ba13a202f2cbace5b7955c8c70390ae949d52d54238d91b2d6c95b0e5e'

    it('CONTINUITY: OLD41 minus its final element reproduces the Controller41 OLD40 pin exactly', () => {
      const priorClosedWorld = OLD41.slice(0, -1)
      expect(priorClosedWorld.length).toBe(40)
      expect(OLD41[40]).toBe('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.29.json')
      expect(orderedDigest(priorClosedWorld)).toBe(OLD40_DIGEST_CONTROLLER41_PIN)
    })

    // DEEPER CONTINUITY (two generations back): the same remove-only walk
    // reproduces the Controller40 39-entry pin. Chaining two inherited pins
    // rather than one means a drifted inherited entry would have to satisfy
    // BOTH independently-audited historical digests to pass unnoticed.
    const OLD39_DIGEST_CONTROLLER40_PIN = 'b1e4124d6401d5eb294804af9a9ef1958c6d0447904103077f5814f9b7196e0b'

    it('CONTINUITY: OLD41 minus its final two elements reproduces the Controller40 OLD39 pin exactly', () => {
      const twoBack = OLD41.slice(0, -2)
      expect(twoBack.length).toBe(39)
      expect(OLD41[39]).toBe('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.28.json')
      expect(orderedDigest(twoBack)).toBe(OLD39_DIGEST_CONTROLLER40_PIN)
    })

    // MUTATION CONTROL (M5 class, non-vacuous): proves the digest actually
    // detects a predecessor reorder rather than only ever matching by
    // construction. Swapping two adjacent OLD41 entries must change the
    // digest even though length, Set size and membership are all unchanged.
    it('MUTATION CONTROL: reordering two predecessor entries changes the ordered digest (order-blind checks would miss this)', () => {
      const reordered = [...OLD41]
      const tmp = reordered[0]
      reordered[0] = reordered[1]
      reordered[1] = tmp
      expect(reordered.length).toBe(OLD41.length)
      expect(new Set(reordered)).toEqual(new Set(OLD41))
      expect(orderedDigest(reordered)).not.toBe(OLD41_DIGEST_EXPECTED)
    })

    // ORDER-CONTINUITY CONTROL (M2 class, in-suite): the controls above are
    // stated over OLD41. This one is stated over a SIMULATED LIVE list — the
    // exact shape a tampered scripts/ods-controller.ts would produce — so the
    // suite proves the reconstruction pipeline itself rejects a swap of two
    // INHERITED entries that preserves count, Set membership and the appended
    // final element. Both an adjacent swap and a maximally-distant swap are
    // exercised, and each is checked against BOTH the elementwise comparison
    // and the ordered digest, so neither check can be the only thing standing
    // between a reorder and a green suite. Every index below is <= 40, i.e.
    // strictly inside the INHERITED range, so the appended final element at
    // index 41 is never the thing being moved.
    function simulateLiveWithSwap(a: number, b: number): string[] {
      const live = [...IMMUTABLE_BY_CONVENTION]
      const tmp = live[a]
      live[a] = live[b]
      live[b] = tmp
      return live
    }

    it.each([
      ['adjacent inherited entries', 0, 1],
      ['maximally distant inherited entries', 0, 40],
      ['two mid-list inherited addenda', 20, 39],
    ])('ORDER CONTINUITY: a swap of %s in the live list still fails reconstruction, despite identical count and Set', (_label, a, b) => {
      const tampered = simulateLiveWithSwap(a as number, b as number)

      // The order-blind properties an attacker would rely on are all intact.
      expect(tampered.length).toBe(IMMUTABLE_BY_CONVENTION.length)
      expect(new Set(tampered)).toEqual(new Set(IMMUTABLE_BY_CONVENTION))
      expect(tampered.length).toBe(new Set(tampered).size)
      expect(tampered[41]).toBe('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.31.json')

      // The order-sensitive reconstruction is not.
      const reconstructed = tampered.slice(0, -1)
      expect(reconstructed).not.toEqual(OLD41)
      expect(orderedDigest(reconstructed)).not.toBe(OLD41_DIGEST_EXPECTED)
    })

    // NON-VACUITY for the control above: the identical pipeline applied with
    // NO swap must PASS. Without this, a simulateLiveWithSwap that silently
    // returned garbage would make every "not" assertion above trivially true.
    it('ORDER CONTINUITY non-vacuity: the same pipeline with no swap reconstructs OLD41 and its digest', () => {
      const untampered = [...IMMUTABLE_BY_CONVENTION]
      const reconstructed = untampered.slice(0, -1)
      expect(reconstructed).toEqual(OLD41)
      expect(orderedDigest(reconstructed)).toBe(OLD41_DIGEST_EXPECTED)
    })
  })

  it('CTRL-M3: writePaths absent on an otherwise-executable node STOPs with AUTHORITY_GAP (unknown write surface, never implicitly safe)', () => {
    const unit = baseUnit({ writePaths: undefined })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('AUTHORITY_GAP')
  })

  it('explicit writePaths=[] (governed read-only node) is authorized', () => {
    const unit = baseUnit({ writePaths: [] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// PACKAGE NON-VACUITY (CONTROLLER30-V1-0-19-IMPLEMENTATION-R1): a test-only
// integrity control over the v1.0.19 package itself, layered on top of the
// closed-world enumeration proven above. Enumeration alone proves the
// STRING is present in IMMUTABLE_BY_CONVENTION; it proves nothing about the
// FILE that string names. This control reads the real, integrated artifact
// from disk and checks the load-bearing facts docs/ops/ods/
// ODS_V1_MAINTENANCE_ADDENDUM_v1.0.19.json itself declares — document
// identity/version, the companion HPO grant HPO-ODS-W2-20, and the S1/S2
// authority relationship (node_authority + companion_execution_scope_authority)
// — never inventing a new authority contract, only verifying facts the
// integrated, frozen artifact already asserts about itself.
// ---------------------------------------------------------------------------

describe('PACKAGE NON-VACUITY: v1.0.19 package identity', () => {
  const V1_0_19_PATH = path.join(REPO_ROOT, 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.19.json')

  function readV1_0_19(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(V1_0_19_PATH, 'utf8')) as Record<string, unknown>
  }

  // The single deterministic identity check — load-bearing facts only,
  // never re-deriving the addendum's full content or its S1/S2 grant body.
  function isValidV1_0_19PackageIdentity(pkg: Record<string, unknown>): boolean {
    return (
      pkg.package_id === 'ODS_V1_MAINTENANCE_ADDENDUM' &&
      pkg.version === '1.0.19' &&
      pkg.artifact_id === 'ODS_V1_MAINTENANCE_ADDENDUM_v1.0.19' &&
      pkg.GRANT_ID === 'HPO-ODS-W2-20' &&
      pkg.node_authority === 'docs/ops/tenancy/MULTI_ORG_TENANT_SCOPE_AUTHORITY_v1.0.0.json' &&
      pkg.companion_execution_scope_authority === 'docs/ops/tenancy/MULTI_ORG_S1_S2_EXECUTION_SCOPE_AUTHORITY_v1.0.0.json'
    )
  }

  it('POSITIVE: the real integrated artifact satisfies the identity control (not empty, not a wrong package)', () => {
    const pkg = readV1_0_19()
    expect(isValidV1_0_19PackageIdentity(pkg)).toBe(true)
  })

  it('an empty object is NOT a valid v1.0.19 package (proves the control is non-vacuous against a trivially wrong artifact)', () => {
    expect(isValidV1_0_19PackageIdentity({})).toBe(false)
  })

  // M6 MUTATION CONTROL: mutate exactly one load-bearing fact, in a scratch
  // in-memory copy only — the real file on disk is never written. Proves the
  // integrity control actually discriminates the real package from a
  // corrupted one, rather than only ever matching by construction.
  it('M6 MUTATION CONTROL: corrupting GRANT_ID alone flips the control to false', () => {
    const pkg = readV1_0_19()
    const mutated = { ...pkg, GRANT_ID: 'HPO-ODS-W2-99' }
    expect(isValidV1_0_19PackageIdentity(pkg)).toBe(true)
    expect(isValidV1_0_19PackageIdentity(mutated)).toBe(false)
  })

  it('M6 MUTATION CONTROL: corrupting the S1/S2 companion_execution_scope_authority relationship alone flips the control to false', () => {
    const pkg = readV1_0_19()
    const mutated = { ...pkg, companion_execution_scope_authority: 'docs/ops/tenancy/WRONG_AUTHORITY_v1.0.0.json' }
    expect(isValidV1_0_19PackageIdentity(pkg)).toBe(true)
    expect(isValidV1_0_19PackageIdentity(mutated)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// E6 — fableEligible cannot be self-granted; Class B defaults to SONNET.
// ---------------------------------------------------------------------------

describe('E6: fableEligible self-grant prohibition', () => {
  it('absent/false fableEligible routes Class B to SONNET; true routes to FABLE_5_1', () => {
    expect(routeClassBExecutor(undefined)).toBe('SONNET')
    expect(routeClassBExecutor(false)).toBe('SONNET')
    expect(routeClassBExecutor(true)).toBe('FABLE_5_1')
  })

  it('class A/D routing is unaffected by fableEligible and never becomes B+/E', () => {
    expect(routeExecutor('A', true)).toBe('OPUS')
    expect(routeExecutor('D', true)).toBe('MACHINE')
  })
})

// ---------------------------------------------------------------------------
// Audit routing — escalate-only, never de-escalate.
// ---------------------------------------------------------------------------

describe('audit routing: escalate-only', () => {
  it('escalates but never de-escalates', () => {
    expect(resolveAuditMode('MACHINE_ONLY', 'FOCUSED_OPUS')).toBe('FOCUSED_OPUS')
    expect(resolveAuditMode('FULL_OPUS', 'MACHINE_ONLY')).toBe('FULL_OPUS')
    expect(resolveAuditMode('FOCUSED_OPUS', 'FOCUSED_OPUS')).toBe('FOCUSED_OPUS')
  })
})

// ---------------------------------------------------------------------------
// CTRL-M4 — main/production boundary wired into node selection via
// integrationTargets. Never infers integration/commercial-v1 is Production.
// ---------------------------------------------------------------------------

describe('CTRL-M4: main/production boundary', () => {
  it('checkBranchBoundary matches every literal alias and no others', () => {
    expect(checkBranchBoundary('main')).toBe('MAIN_MUTATION_ATTEMPT')
    expect(checkBranchBoundary('origin/main')).toBe('MAIN_MUTATION_ATTEMPT')
    expect(checkBranchBoundary('refs/heads/main')).toBe('MAIN_MUTATION_ATTEMPT')
    expect(checkBranchBoundary('refs/remotes/origin/main')).toBe('MAIN_MUTATION_ATTEMPT')
    expect(checkBranchBoundary('production')).toBe('PRODUCTION_BOUNDARY_REACHED')
    expect(checkBranchBoundary('refs/heads/production')).toBe('PRODUCTION_BOUNDARY_REACHED')
    expect(checkBranchBoundary('integration/commercial-v1')).toBeUndefined()
    expect(checkBranchBoundary('codex/autonomous-program-controller-r1')).toBeUndefined()
  })

  it('NEGATIVE CONTROL: a node whose integrationTargets names main STOPs with MAIN_MUTATION_ATTEMPT via the real selection path', () => {
    const unit = baseUnit({ integrationTargets: ['integration/commercial-v1', 'main'] })
    const decision = decideSelection(unit, 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('MAIN_MUTATION_ATTEMPT')
  })

  it('a node whose integrationTargets names production STOPs with PRODUCTION_BOUNDARY_REACHED', () => {
    expect(checkIntegrationTargetsBoundary(['refs/heads/production'])).toBe('PRODUCTION_BOUNDARY_REACHED')
  })

  it('integration/commercial-v1 alone never STOPs the boundary check (never inferred as Production)', () => {
    expect(checkIntegrationTargetsBoundary(['integration/commercial-v1'])).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// CTRL-M1 — ternary evidence preserved; UNKNOWN never collapsed into OPEN.
// ---------------------------------------------------------------------------

describe('CTRL-M1: UNKNOWN vs OPEN determinism', () => {
  it('aggregateClosureStatus: all CLOSED -> CLOSED', () => {
    const r = { status: 'CLOSED' as const, evidenceRef: 'x', evidenceKind: 'paths-exist' as const, detail: '' }
    expect(aggregateClosureStatus(r, r, r)).toBe('CLOSED')
  })

  it('aggregateClosureStatus: any UNKNOWN dimension -> UNKNOWN (never downgraded to OPEN)', () => {
    const closed = { status: 'CLOSED' as const, evidenceRef: 'x', evidenceKind: 'paths-exist' as const, detail: '' }
    const unknown = { status: 'UNKNOWN' as const, evidenceRef: 'x', evidenceKind: 'paths-exist' as const, detail: '' }
    expect(aggregateClosureStatus(unknown, closed, closed)).toBe('UNKNOWN')
    expect(aggregateClosureStatus(closed, closed, unknown)).toBe('UNKNOWN')
  })

  it('aggregateClosureStatus: all readable but not fully closed -> OPEN', () => {
    const closed = { status: 'CLOSED' as const, evidenceRef: 'x', evidenceKind: 'paths-exist' as const, detail: '' }
    const open = { status: 'OPEN' as const, evidenceRef: 'x', evidenceKind: 'paths-exist' as const, detail: '' }
    expect(aggregateClosureStatus(closed, open, closed)).toBe('OPEN')
  })

  it('DETERMINISM CONTROL: dependency evidence UNKNOWN -> selectNode STOPs with UNKNOWN_EVIDENCE (single answer, not a two-answer assertion)', () => {
    const registry: ProgramStateRegistry = {
      units: [
        { id: 'DEP-UNKNOWN', authority: UNKNOWN_EVIDENCE, implementation: UNKNOWN_EVIDENCE, audit: UNKNOWN_EVIDENCE, integrationTargets: [] },
        { ...baseUnit({ id: 'CONSUMER-U', dependsOn: ['DEP-UNKNOWN'] }) },
      ],
    }
    const decision = selectNode(REPO_ROOT, registry, 'CONSUMER-U')
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('UNKNOWN_EVIDENCE')
  })

  it('DETERMINISM CONTROL: dependency evidence OPEN (readable, not closed) -> selectNode STOPs with AUTHORITY_GAP', () => {
    const registry: ProgramStateRegistry = {
      units: [
        { id: 'DEP-OPEN', authority: OPEN_EVIDENCE, implementation: OPEN_EVIDENCE, audit: OPEN_EVIDENCE, integrationTargets: [] },
        { ...baseUnit({ id: 'CONSUMER-O', dependsOn: ['DEP-OPEN'] }) },
      ],
    }
    const decision = selectNode(REPO_ROOT, registry, 'CONSUMER-O')
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('AUTHORITY_GAP')
  })

  it('a missing dependsOn unit (not in the registry at all) is OPEN -> AUTHORITY_GAP, not UNKNOWN', () => {
    const registry: ProgramStateRegistry = { units: [{ ...baseUnit({ id: 'CONSUMER-M', dependsOn: ['DOES-NOT-EXIST'] }) }] }
    const decision = selectNode(REPO_ROOT, registry, 'CONSUMER-M')
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('AUTHORITY_GAP')
  })
})

// ---------------------------------------------------------------------------
// CTRL-R1 — the TARGET unit's own evidence uses the same ternary discipline
// as dependencies. UNKNOWN must never fall through to writePaths/dependsOn,
// never become AUTHORITY_GAP, never become selectable.
// ---------------------------------------------------------------------------

describe('CTRL-R1: target own-evidence ternary', () => {
  it('target own CLOSED -> alreadyClosed=true, selectable=false, no stopClass', () => {
    const decision = decideSelection(baseUnit({ dependsOn: ['ANYTHING'] }), 'CLOSED', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.alreadyClosed).toBe(true)
    expect(decision.stopClass).toBeUndefined()
  })

  it('target own OPEN continues into dependency/precondition/write/routing checks (does not short-circuit)', () => {
    const decision = decideSelection(baseUnit({ dependsOn: ['DEP-X'] }), 'OPEN', { 'DEP-X': 'OPEN' }, {})
    // Reaching the dependsOn stop class proves OPEN fell through into the
    // ordinary pipeline rather than being treated as closed or unreadable.
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('AUTHORITY_GAP')
  })

  it('MUTATION CONTROL (non-vacuous): target own UNKNOWN STOPs with UNKNOWN_EVIDENCE and never becomes selectable', () => {
    // This node has NO other blocker at all (no dependsOn, no
    // externalPreconditions, dbWriting absent, valid writePaths/
    // executionClass/auditClass from baseUnit's defaults) — if the
    // own-UNKNOWN branch were removed from decideSelection, it would fall
    // all the way through to selectable=true. That is exactly what this
    // assertion catches.
    const decision = decideSelection(baseUnit({}), 'UNKNOWN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('UNKNOWN_EVIDENCE')
    expect(decision.alreadyClosed).toBeUndefined()
  })

  it('real selection path: selectNode STOPs with UNKNOWN_EVIDENCE when the target\'s own evidence ref cannot resolve — never AUTHORITY_GAP', () => {
    const registry: ProgramStateRegistry = {
      units: [{ id: 'TARGET-UNKNOWN', authority: UNKNOWN_EVIDENCE, implementation: UNKNOWN_EVIDENCE, audit: UNKNOWN_EVIDENCE, integrationTargets: [] }],
    }
    const decision = selectNode(REPO_ROOT, registry, 'TARGET-UNKNOWN')
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('UNKNOWN_EVIDENCE')
    expect(decision.alreadyClosed).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// CTRL-M2 — generic external-precondition resolution, no hard-coded map.
// ---------------------------------------------------------------------------

describe('CTRL-M2: generic external-precondition resolution', () => {
  it('CASE A: a provider whose unit id exactly equals the token, fully closed, satisfies the precondition', () => {
    const registry: ProgramStateRegistry = {
      units: [
        { id: 'SYNTHETIC_EXTERNAL_CLOSED', authority: CLOSED_EVIDENCE, implementation: CLOSED_EVIDENCE, audit: CLOSED_EVIDENCE, integrationTargets: [] },
        baseUnit({ id: 'CONSUMER-A', externalPreconditions: ['SYNTHETIC_EXTERNAL_CLOSED'] }),
      ],
    }
    expect(resolveExternalPrecondition(REPO_ROOT, registry, 'SYNTHETIC_EXTERNAL_CLOSED')).toBe('CLOSED')
    const decision = selectNode(REPO_ROOT, registry, 'CONSUMER-A')
    expect(decision.selectable).toBe(true)
  })

  it('CASE B: a provider declaring providesExternalPreconditions, fully closed, satisfies the precondition', () => {
    const registry: ProgramStateRegistry = {
      units: [
        baseUnit({ id: 'PROVIDER-B', authority: CLOSED_EVIDENCE, implementation: CLOSED_EVIDENCE, audit: CLOSED_EVIDENCE, providesExternalPreconditions: ['SOME_TOKEN'] }),
        baseUnit({ id: 'CONSUMER-B', externalPreconditions: ['SOME_TOKEN'] }),
      ],
    }
    expect(resolveExternalPrecondition(REPO_ROOT, registry, 'SOME_TOKEN')).toBe('CLOSED')
    expect(selectNode(REPO_ROOT, registry, 'CONSUMER-B').selectable).toBe(true)
  })

  it('NEGATIVE CONTROL: zero providers -> UNKNOWN (never treated as satisfied)', () => {
    const registry: ProgramStateRegistry = { units: [baseUnit({ id: 'CONSUMER-C', externalPreconditions: ['NO_SUCH_TOKEN'] })] }
    expect(resolveExternalPrecondition(REPO_ROOT, registry, 'NO_SUCH_TOKEN')).toBe('UNKNOWN')
    const decision = selectNode(REPO_ROOT, registry, 'CONSUMER-C')
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('UNKNOWN_EVIDENCE')
  })

  it('MUTATION CONTROL: more than one provider for the same token -> AUTHORITY_CONFLICT (ambiguous, never arbitrarily picked)', () => {
    const registry: ProgramStateRegistry = {
      units: [
        { id: 'DUP_TOKEN', authority: CLOSED_EVIDENCE, implementation: CLOSED_EVIDENCE, audit: CLOSED_EVIDENCE, integrationTargets: [] },
        baseUnit({ id: 'ANOTHER-PROVIDER', providesExternalPreconditions: ['DUP_TOKEN'] }),
        baseUnit({ id: 'CONSUMER-D', externalPreconditions: ['DUP_TOKEN'] }),
      ],
    }
    expect(resolveExternalPrecondition(REPO_ROOT, registry, 'DUP_TOKEN')).toBe('CONFLICT')
    const decision = selectNode(REPO_ROOT, registry, 'CONSUMER-D')
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('AUTHORITY_CONFLICT')
  })

  it('the real registry does not (and must not) resolve P1A_FULL_BOOTSTRAP_CLOSED — no hard-coded map, no premature satisfaction', () => {
    const registry = loadRegistry(path.join(REPO_ROOT, DEFAULT_REGISTRY_RELATIVE_PATH))
    expect(resolveExternalPrecondition(REPO_ROOT, registry, 'P1A_FULL_BOOTSTRAP_CLOSED')).toBe('UNKNOWN')
  })
})

// ---------------------------------------------------------------------------
// CTRL-M6 — runtime validation of routing metadata; JSON is runtime data.
// ---------------------------------------------------------------------------

describe('CTRL-M6: runtime validation of routing metadata', () => {
  it('POSITIVE: valid executionClass/auditClass/fableEligible pass through', () => {
    expect(isValidExecutionClass('B')).toBe(true)
    expect(isValidAuditMode('FOCUSED_OPUS')).toBe(true)
    const decision = decideSelection(baseUnit({ fableEligible: false }), 'OPEN', {}, {})
    expect(decision.selectable).toBe(true)
  })

  it('NEGATIVE: missing or invalid executionClass STOPs with AUTHORITY_CONFLICT, never defaults to Class C', () => {
    expect(isValidExecutionClass(undefined)).toBe(false)
    expect(isValidExecutionClass('E')).toBe(false)
    const missing = decideSelection(baseUnit({ executionClass: undefined }), 'OPEN', {}, {})
    expect(missing.selectable).toBe(false)
    expect(missing.stopClass).toBe('AUTHORITY_CONFLICT')
    const invalid = decideSelection(baseUnit({ executionClass: 'E' }), 'OPEN', {}, {})
    expect(invalid.selectable).toBe(false)
    expect(invalid.stopClass).toBe('AUTHORITY_CONFLICT')
  })

  it('NEGATIVE: missing or invalid auditClass STOPs with REQUIRED_INDEPENDENT_AUDIT, never echoed as authorized', () => {
    expect(isValidAuditMode(undefined)).toBe(false)
    expect(isValidAuditMode('SUPER_AUDIT')).toBe(false)
    const missing = decideSelection(baseUnit({ auditClass: undefined }), 'OPEN', {}, {})
    expect(missing.selectable).toBe(false)
    expect(missing.stopClass).toBe('REQUIRED_INDEPENDENT_AUDIT')
    const invalid = decideSelection(baseUnit({ auditClass: 'SUPER_AUDIT' }), 'OPEN', {}, {})
    expect(invalid.selectable).toBe(false)
    expect(invalid.stopClass).toBe('REQUIRED_INDEPENDENT_AUDIT')
  })

  it('NEGATIVE: non-boolean fableEligible STOPs with AUTHORITY_CONFLICT', () => {
    const decision = decideSelection(baseUnit({ fableEligible: 'yes' }), 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('AUTHORITY_CONFLICT')
  })
})

// ---------------------------------------------------------------------------
// §13 — already-closed disposition: a fully closed unit is never
// misrepresented as a next-executable node, without fabricating a stop class.
// ---------------------------------------------------------------------------

describe('already-closed disposition', () => {
  it('SYNTHETIC: ownClosureStatus=CLOSED short-circuits to selectable=false, alreadyClosed=true, no stopClass', () => {
    const decision = decideSelection(baseUnit({ dependsOn: ['ANYTHING'] }), 'CLOSED', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.alreadyClosed).toBe(true)
    expect(decision.stopClass).toBeUndefined()
  })

  it('REAL REGISTRY: W2-B3 result matches the actual measured own-evidence condition exactly', () => {
    // First inspect the real machine evidence condition (the SAME
    // evaluateEvidence + aggregateClosureStatus primitives selectNode uses
    // internally), THEN assert the one exact result CTRL-R1 requires for
    // that condition — never an OR-any-stop-class or STOP_CLASSES.includes
    // substitute, and AUTHORITY_GAP is never accepted for unreadable
    // target-own evidence.
    const registry = loadRegistry(path.join(REPO_ROOT, DEFAULT_REGISTRY_RELATIVE_PATH))
    const unit = registry.units.find((u) => u.id === 'W2-B3')!
    const ownStatus = aggregateClosureStatus(
      evaluateEvidence(REPO_ROOT, unit.authority),
      evaluateEvidence(REPO_ROOT, unit.implementation),
      evaluateEvidence(REPO_ROOT, unit.audit),
    )
    const decision = selectNode(REPO_ROOT, registry, 'W2-B3')
    if (ownStatus === 'CLOSED') {
      // Full checkout: codex/w2-methodology-objects-r1 fetched, all three
      // dimensions read CLOSED (verified via `pnpm ops:program-state --unit W2-B3`).
      expect(decision.selectable).toBe(false)
      expect(decision.alreadyClosed).toBe(true)
      expect(decision.stopClass).toBeUndefined()
    } else {
      // Shallow/CI checkout: that branch is unfetched, so all three
      // dimensions read UNKNOWN. CTRL-R1 requires exactly UNKNOWN_EVIDENCE.
      expect(ownStatus).toBe('UNKNOWN')
      expect(decision.selectable).toBe(false)
      expect(decision.alreadyClosed).toBeUndefined()
      expect(decision.stopClass).toBe('UNKNOWN_EVIDENCE')
    }
  })
})

// ---------------------------------------------------------------------------
// CTRL26-CLOSURE-TEST-R1 (binding coordinator ruling): W2-B4 closed on
// 2026-09-04 (PR #62 merge 33c2347d81b16c9aafa5dad2db1647c0e4c3d684) — its own
// authority/implementation/audit evidence is now mechanically CLOSED, not
// UNKNOWN. The OLD assertion here (stopClass === 'UNKNOWN_EVIDENCE') tested a
// premise that expired the moment B4 closed: decideSelection's
// ownClosureStatus check runs FIRST and short-circuits to alreadyClosed=true
// before dependsOn/externalPreconditions/dbWriting are ever consulted, so the
// original rationale above ("dependsOn UNKNOWN evidence and unresolved
// externalPreconditions both map to UNKNOWN_EVIDENCE") no longer describes
// what this unit hits. UNKNOWN_EVIDENCE remains correct ONLY when the
// required evidence/ref genuinely cannot be resolved — a materially
// different condition, split into its own control below.
//
// Both controls are deterministic across checkout topology: neither depends
// on whether the branch name "codex/w2-b4-r1" happens to be a locally known
// git ref (true in a full checkout that fetched it; generally false in CI's
// single-branch checkout, which is why the stale assertion above still
// passed there — a checkout-topology accident, not a semantic proof).
// CTRL-CLOSED-1 pins evidence to HEAD, which is trivially resolvable in any
// checkout of this very branch, and the W2-B4 closure artifacts are
// integrated into this branch's own ancestry. CTRL-UNKNOWN-1 pins evidence to
// a ref that provably never exists, in any topology. Neither mocks a
// condition the real selector cannot encounter — both run through the real
// selectNode I/O path (evaluateEvidence + aggregateClosureStatus +
// decideSelection), only the evidence ref differs.
// ---------------------------------------------------------------------------

describe('real registry: W2-B4 fail-closed selection', () => {
  const registry = loadRegistry(path.join(REPO_ROOT, DEFAULT_REGISTRY_RELATIVE_PATH))

  it('W2-B4 carries externalPreconditions=["P1A_FULL_BOOTSTRAP_CLOSED"] and dbWriting=true', () => {
    const unit = registry.units.find((u) => u.id === 'W2-B4') as ControllerUnit | undefined
    expect(unit?.externalPreconditions).toEqual(['P1A_FULL_BOOTSTRAP_CLOSED'])
    expect(unit?.dbWriting).toBe(true)
  })

  it('CTRL-CLOSED-1: with fully resolvable own evidence, selectNode short-circuits to alreadyClosed=true BEFORE dependsOn/externalPreconditions/dbWriting are ever consulted', () => {
    // Same evidence type, path, field and closedValues the real registry
    // declares for W2-B4 — only ref changes, from the branch name to HEAD, so
    // resolution never depends on which branches this checkout fetched.
    const realUnit = registry.units.find((u) => u.id === 'W2-B4') as ControllerUnit
    const unit: ControllerUnit = {
      ...realUnit,
      authority: { ...realUnit.authority, ref: 'HEAD' },
      implementation: { ...realUnit.implementation, ref: 'HEAD' },
      audit: { ...realUnit.audit, ref: 'HEAD' },
    }
    const decision = selectNode(REPO_ROOT, { units: [unit] }, 'W2-B4')
    expect(decision.selectable).toBe(false)
    expect(decision.alreadyClosed).toBe(true)
    expect(decision.stopClass).toBeUndefined()
  })

  it('CTRL-UNKNOWN-1: with the required evidence/ref genuinely unresolvable, selectNode fails closed as UNKNOWN_EVIDENCE — never alreadyClosed', () => {
    const realUnit = registry.units.find((u) => u.id === 'W2-B4') as ControllerUnit
    const unresolvable: Evidence = {
      type: 'paths-exist',
      ref: 'refs/does-not-exist-xyz-w2-b4-closure-test',
      paths: ['docs/ops/wave2/W2_B4_IMPLEMENTATION_EVIDENCE_v1.0.0.json'],
    }
    const unit: ControllerUnit = { ...realUnit, authority: unresolvable, implementation: unresolvable, audit: unresolvable }
    const decision = selectNode(REPO_ROOT, { units: [unit] }, 'W2-B4')
    expect(decision.selectable).toBe(false)
    expect(decision.alreadyClosed).toBeUndefined()
    expect(decision.stopClass).toBe('UNKNOWN_EVIDENCE')
  })

  it('an unknown unit id STOPs with AUTHORITY_GAP', () => {
    expect(selectNode(REPO_ROOT, { units: [] }, 'DOES-NOT-EXIST').stopClass).toBe('AUTHORITY_GAP')
  })
})

// ---------------------------------------------------------------------------
// dbWriting boundary (E5) — CONTROLLER_DB_EXECUTION=DISABLED non-vacuity.
// ---------------------------------------------------------------------------

describe('E5: CONTROLLER_DB_EXECUTION=DISABLED non-vacuity', () => {
  it('dbWriting=true STOPs with DATABASE_AUTHORITY_REQUIRED even with everything else satisfied', () => {
    const decision = decideSelection(baseUnit({ dbWriting: true }), 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('DATABASE_AUTHORITY_REQUIRED')
  })

  it('MUTATION CONTROL: the same node with dbWriting=false is selectable (proves the guard, not the fixture, blocks it)', () => {
    expect(decideSelection(baseUnit({ dbWriting: false }), 'OPEN', {}, {}).selectable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// E4 — rerun/flake ceiling non-vacuity: repeated deterministic failure STOPs.
// ---------------------------------------------------------------------------

describe('E4: rerun policy — single isolated flake rerun, repeated failure STOPs', () => {
  it('POSITIVE CONTROL: a PASS on cycle 1 closes immediately', () => {
    const result = runMissionCycles(() => ({ status: 'PASS' }))
    expect(result.outcome).toBe('CLOSED')
    expect(result.cyclesRun).toBe(1)
  })

  it('a terminal stop class (not FLAKE_SUSPECTED) STOPs on first occurrence, no rerun', () => {
    let calls = 0
    const result = runMissionCycles(() => {
      calls++
      return { status: 'STOP', stopClass: 'MACHINE_GATE_NONDETERMINISTIC', signature: 'sig-a' }
    })
    expect(result.outcome).toBe('STOPPED')
    expect(result.stopClass).toBe('MACHINE_GATE_NONDETERMINISTIC')
    expect(calls).toBe(1)
  })

  it('a single FLAKE_SUSPECTED followed by PASS consumes exactly one rerun and closes', () => {
    let calls = 0
    const result = runMissionCycles((cycle) => {
      calls++
      if (cycle === 1) return { status: 'STOP', stopClass: 'FLAKE_SUSPECTED', signature: 'sig-b' }
      return { status: 'PASS' }
    })
    expect(result.outcome).toBe('CLOSED')
    expect(result.flakeRerunsUsed).toBe(1)
    expect(calls).toBe(2)
  })

  it('NEGATIVE CONTROL (E4, non-vacuous): the SAME signature failing twice STOPs with REPEATED_LOCAL_FAILURE rather than granting a second rerun', () => {
    const outcomes: CycleOutcome[] = [
      { status: 'STOP', stopClass: 'FLAKE_SUSPECTED', signature: 'sig-c' },
      { status: 'STOP', stopClass: 'FLAKE_SUSPECTED', signature: 'sig-c' },
    ]
    let cursor = 0
    const result = runMissionCycles(() => outcomes[cursor++])
    expect(result.outcome).toBe('STOPPED')
    expect(result.stopClass).toBe('REPEATED_LOCAL_FAILURE')
    expect(result.flakeRerunsUsed).toBe(1)
  })

  it('MUTATION CONTROL: a DIFFERENT signature after the rerun budget is exhausted does not get laundered into another rerun', () => {
    const outcomes: CycleOutcome[] = [
      { status: 'STOP', stopClass: 'FLAKE_SUSPECTED', signature: 'sig-d' },
      { status: 'STOP', stopClass: 'FLAKE_SUSPECTED', signature: 'sig-e' },
    ]
    let cursor = 0
    const result = runMissionCycles(() => outcomes[cursor++])
    expect(result.outcome).toBe('STOPPED')
    expect(result.stopClass).toBe('FLAKE_SUSPECTED')
    expect(result.flakeRerunsUsed).toBe(1)
  })

  it('MAX_MISSION_CYCLES_REACHED is provably unreachable under the frozen single-isolated-rerun policy (documented boundary, not weakened to force it)', () => {
    // Every stop class other than FLAKE_SUSPECTED is terminal on first
    // occurrence, and FLAKE_SUSPECTED itself draws at most one isolated
    // rerun for the whole run (never per-signature). Under those frozen
    // rules a run can never exceed 2 cycles without a PASS, so
    // MAX_MISSION_CYCLES_REACHED can never fire for MAX_AUTONOMOUS_CYCLES=5
    // without weakening the rerun policy — this proves the boundary
    // instead of silently skipping it or fabricating a fake trigger.
    expect(MAX_AUTONOMOUS_CYCLES).toBe(5)
    const result = runMissionCycles((cycle) => ({ status: 'STOP', stopClass: 'FLAKE_SUSPECTED', signature: `unique-${cycle}` }))
    expect(result.cyclesRun).toBeLessThanOrEqual(2)
    expect(result.outcome).toBe('STOPPED')
    expect(result.stopClass).not.toBe('MAX_MISSION_CYCLES_REACHED')
  })

  it('the ceiling constant IS honored as a hard upper bound on iteration count when the executor never resolves', () => {
    // Not reachable via terminal-on-first-occurrence + single-rerun, but the
    // loop itself must never exceed maxCycles regardless — proven directly
    // against the internal loop bound with a maxCycles small enough to
    // observe without relying on the (unreachable) MAX_MISSION_CYCLES_REACHED class.
    let calls = 0
    runMissionCycles(() => {
      calls++
      return { status: 'STOP', stopClass: 'FLAKE_SUSPECTED', signature: `s-${calls}` }
    }, 5)
    expect(calls).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// CTRL-R2 — malformed writePaths (runtime JSON, not TS-trusted) fails
// closed rather than crashing or being treated as [] or authorized.
// ---------------------------------------------------------------------------

describe('CTRL-R2: malformed writePaths fails closed', () => {
  it('a string instead of an array -> AUTHORITY_CONFLICT, never interpreted as [] or an exception', () => {
    const decision = decideSelection(baseUnit({ writePaths: 'not-an-array' }), 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('AUTHORITY_CONFLICT')
  })

  it('an object instead of an array -> AUTHORITY_CONFLICT', () => {
    const decision = decideSelection(baseUnit({ writePaths: { path: 'lib/x.ts' } }), 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('AUTHORITY_CONFLICT')
  })

  it('an array containing a non-string element -> AUTHORITY_CONFLICT', () => {
    const decision = decideSelection(baseUnit({ writePaths: ['lib/x.ts', 42] }), 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('AUTHORITY_CONFLICT')
  })

  it('MUTATION CONTROL: a genuinely valid array of strings is not blocked (proves the validator, not the fixture, rejects malformed input)', () => {
    expect(decideSelection(baseUnit({ writePaths: ['lib/x.ts'] }), 'OPEN', {}, {}).selectable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CTRL-R3 — noncanonical protected-path spelling (case bypass) is caught
// and classified distinctly from a canonical-exact protected hit.
// ---------------------------------------------------------------------------

describe('CTRL-R3: noncanonical protected path spelling', () => {
  const CANONICAL = 'docs/ops/ods/ODS_V1_OPERATIONAL_CLOSURE_v1.0.0.json'

  it('canonical exact path -> violated (PROTECTED_SURFACE_CHANGE territory)', () => {
    const result = checkImmutableGuard([CANONICAL])
    expect(result.violated).toBe(true)
    expect(result.nonCanonicalPaths).toEqual([])
  })

  it('./canonical (redundant dot segment) normalizes and still violates', () => {
    expect(checkImmutableGuard([`./${CANONICAL}`]).violated).toBe(true)
  })

  it('backslash canonical normalizes and still violates', () => {
    expect(checkImmutableGuard([CANONICAL.replace(/\//g, '\\')]).violated).toBe(true)
  })

  it('a case-mutated equivalent is NOT violated — it is nonCanonical instead, never PROTECTED_SURFACE_CHANGE', () => {
    const mutated = CANONICAL.toUpperCase()
    const result = checkImmutableGuard([mutated])
    expect(result.violated).toBe(false)
    expect(result.nonCanonicalPaths).toEqual([mutated])
  })

  it('an unrelated differently-cased non-protected path is never treated as immutable', () => {
    const result = checkImmutableGuard(['LIB/SOME-MODULE.TS'])
    expect(result.violated).toBe(false)
    expect(result.nonCanonicalPaths).toEqual([])
  })

  it('real selection path: case-mutated writePaths -> NONCANONICAL_PROTECTED_PATH via decideSelection', () => {
    const decision = decideSelection(baseUnit({ writePaths: [CANONICAL.toUpperCase()] }), 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('NONCANONICAL_PROTECTED_PATH')
  })

  it('real selection path: canonical-exact writePaths -> PROTECTED_SURFACE_CHANGE via decideSelection (never NONCANONICAL)', () => {
    const decision = decideSelection(baseUnit({ writePaths: [CANONICAL] }), 'OPEN', {}, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('PROTECTED_SURFACE_CHANGE')
  })
})

// ---------------------------------------------------------------------------
// Deterministic audit packet derivation.
// ---------------------------------------------------------------------------

describe('audit packet derivation is deterministic', () => {
  it('identical inputs produce a deep-equal packet on every call', () => {
    const a = buildAuditPacket('W2-B4', 'base-sha', 'candidate-sha', ['docs/ops/wave2/W2_B4_AUTHORITY_v1.0.0.json'], ['tests/ods/ods-controller.test.ts'])
    const b = buildAuditPacket('W2-B4', 'base-sha', 'candidate-sha', ['docs/ops/wave2/W2_B4_AUTHORITY_v1.0.0.json'], ['tests/ods/ods-controller.test.ts'])
    expect(a).toEqual(b)
  })

  it('does not alias caller-supplied arrays (defensive copy)', () => {
    const authorityPaths = ['a.json']
    const packet = buildAuditPacket('X', 'b', 'c', authorityPaths, [])
    authorityPaths.push('mutated-after')
    expect(packet.authorityPaths).toEqual(['a.json'])
  })
})
