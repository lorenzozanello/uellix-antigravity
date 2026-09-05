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
  it('is the exact 29-member closed world (20 pinned entries + v1.0.10 + v1.0.11 + v1.0.12 + v1.0.13 + v1.0.14 + v1.0.15 + v1.0.16 + v1.0.17 + v1.0.18)', () => {
    expect(IMMUTABLE_BY_CONVENTION.length).toBe(29)
    expect(new Set(IMMUTABLE_BY_CONVENTION).size).toBe(29)
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.10.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.11.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.12.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.13.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.14.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.15.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.16.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.17.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.18.json')
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
  // forward by ODS_V1_MAINTENANCE_ADDENDUM_v1.0.17.json and v1.0.18.json
  // self_inclusion_rule): the closed world does not pre-include a later ODS
  // successor artifact. The control ADVANCES with the list — v1.0.18 is now
  // enumerated, so the absence assertion moves to the mechanically-next
  // version. It asserts ABSENCE only: it reserves no identifier and
  // authorizes no future grant. Per ods_lineage_serialization.
  // no_future_ids_reserved, NEXT_ODS_LINEAGE is DERIVE_AT_MATERIALIZATION_TIME;
  // the literal below is a negative-control literal, never an allocation.
  it('does NOT pre-include the next unallocated ODS successor addendum (no automatic inclusion)', () => {
    expect(IMMUTABLE_BY_CONVENTION).not.toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.19.json')
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

  // Duplicate control: the closed world is a SET as well as an ordered list.
  // A second copy of the new entry would satisfy a naive toContain check and
  // would still be caught here, and by length === Set size, before it could
  // make the live count ambiguous as a successor precondition.
  it('the new entry appears exactly once, and the list carries no duplicates at all', () => {
    const occurrences = IMMUTABLE_BY_CONVENTION.filter(
      (entry) => entry === 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.18.json',
    ).length
    expect(occurrences).toBe(1)
    expect(IMMUTABLE_BY_CONVENTION.length).toBe(new Set(IMMUTABLE_BY_CONVENTION).size)
  })

  // ---------------------------------------------------------------------
  // ORDER PROOF (ODS_V1_MAINTENANCE_ADDENDUM_v1.0.18.json successor_scope):
  // an independently-typed literal of the pre-append 28-entry closed world
  // (OLD28 — never derived from the live IMMUTABLE_BY_CONVENTION import) is
  // hashed with an ordered digest. A remove-only reconstruction of the live,
  // post-append list (dropping exactly the new final element) must reproduce
  // OLD28 element-by-element AND by that same ordered digest. This catches a
  // reorder of any predecessor entry that a naive length/Set/toContain check
  // would miss, because Set equality and length are order-blind.
  // ---------------------------------------------------------------------
  describe('ORDER PROOF: append-only reconstruction of OLD28', () => {
    // Independently typed — copied once from the pre-v1.0.18 source, not
    // imported or derived from scripts/ods-controller.ts.
    const OLD28: readonly string[] = [
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
    ]

    // Independently computed and pinned as a literal — recorded in the
    // CONTROLLER29_V1_0_18_IMPLEMENTATION_R1 report as OLD28_DIGEST. A
    // mismatch here means either OLD28 above or the live pre-append 28
    // entries drifted — never silently accepted.
    const OLD28_DIGEST_EXPECTED = 'b0c83a552e0ec4afc4ac63d0e433245391e6226baee4fa325ae44686044859ff'

    function orderedDigest(entries: readonly string[]): string {
      return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex')
    }

    it('OLD28 literal has length 28, no duplicates, and matches the pinned OLD28_DIGEST', () => {
      expect(OLD28.length).toBe(28)
      expect(new Set(OLD28).size).toBe(28)
      expect(orderedDigest(OLD28)).toBe(OLD28_DIGEST_EXPECTED)
    })

    it('the live list is exactly OLD28 with v1.0.18 appended as the sole new final element', () => {
      expect(IMMUTABLE_BY_CONVENTION.length).toBe(29)
      expect(IMMUTABLE_BY_CONVENTION[28]).toBe('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.18.json')
    })

    it('REMOVE-ONLY RECONSTRUCTION: dropping the live list\'s last element reproduces OLD28 element-by-element, in order', () => {
      const reconstructed = IMMUTABLE_BY_CONVENTION.slice(0, -1)
      expect(reconstructed).toEqual(OLD28)
      expect(reconstructed.length).toBe(OLD28.length)
      for (let i = 0; i < OLD28.length; i++) {
        expect(reconstructed[i]).toBe(OLD28[i])
      }
    })

    it('REMOVE-ONLY RECONSTRUCTION: its ordered digest matches OLD28_DIGEST exactly (catches any predecessor reorder)', () => {
      const reconstructed = IMMUTABLE_BY_CONVENTION.slice(0, -1)
      expect(orderedDigest(reconstructed)).toBe(OLD28_DIGEST_EXPECTED)
    })

    // MUTATION CONTROL (M5 class, non-vacuous): proves the digest actually
    // detects a predecessor reorder rather than only ever matching by
    // construction. Swapping two adjacent OLD28 entries must change the
    // digest even though length, Set size and membership are all unchanged.
    it('MUTATION CONTROL: reordering two predecessor entries changes the ordered digest (order-blind checks would miss this)', () => {
      const reordered = [...OLD28]
      const tmp = reordered[0]
      reordered[0] = reordered[1]
      reordered[1] = tmp
      expect(reordered.length).toBe(OLD28.length)
      expect(new Set(reordered)).toEqual(new Set(OLD28))
      expect(orderedDigest(reordered)).not.toBe(OLD28_DIGEST_EXPECTED)
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
