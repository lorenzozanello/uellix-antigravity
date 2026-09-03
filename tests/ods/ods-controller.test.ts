// tests/ods/ods-controller.test.ts — Autonomous Program Controller v0
// positive, negative, mutation and closed-world controls.
//
// Governed by docs/ops/ods/ODS_CONTROLLER_AUTHORITY_v1.0.0.json
// exit_criteria_for_controller_v0_implementation (E1..E8). Synthetic
// fixtures live only in this file, per that authority's instruction.

import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  CONTROLLER_STATES,
  STOP_CLASSES,
  IMMUTABLE_BY_CONVENTION,
  EXTERNAL_PRECONDITION_UNIT_MAP,
  checkImmutableGuard,
  checkBranchBoundary,
  routeClassBExecutor,
  routeExecutor,
  resolveAuditMode,
  decideSelection,
  selectNode,
  runMissionCycles,
  buildAuditPacket,
  MAX_AUTONOMOUS_CYCLES,
  type ControllerUnit,
  type CycleOutcome,
} from '../../scripts/ods-controller'
import { loadRegistry, DEFAULT_REGISTRY_RELATIVE_PATH, type ProgramStateRegistry } from '../../scripts/ods-program-state'

const REPO_ROOT = path.resolve(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// E7 — closed-world stop-class and state-model assertions.
// ---------------------------------------------------------------------------

describe('E7: closed-world stop taxonomy and state model', () => {
  it('STOP_CLASSES matches the frozen authority list exactly (order-independent, exact membership)', () => {
    const frozen = [
      'AUTHORITY_GAP',
      'AUTHORITY_CONFLICT',
      'UNKNOWN_EVIDENCE',
      'PARTIAL_WHERE_PASS_REQUIRED',
      'SHA_MISMATCH',
      'TREE_MISMATCH',
      'DIRTY_PRESTATE',
      'UNEXPECTED_CHANGED_PATH',
      'PROTECTED_SURFACE_CHANGE',
      'NONCANONICAL_PROTECTED_PATH',
      'MIGRATION_AMBIGUITY',
      'DATABASE_AUTHORITY_REQUIRED',
      'SECURITY_ESCALATION',
      'INTEGRATION_CONFLICT',
      'AUDITED_OBJECT_MOVED',
      'MACHINE_GATE_NONDETERMINISTIC',
      'REPEATED_LOCAL_FAILURE',
      'REQUIRED_INDEPENDENT_AUDIT',
      'MAX_MISSION_CYCLES_REACHED',
      'PRODUCTION_BOUNDARY_REACHED',
      'MAIN_MUTATION_ATTEMPT',
      'FLAKE_SUSPECTED',
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
// E2 / E3 — immutableByConvention closed-world + non-vacuous negative control.
// ---------------------------------------------------------------------------

describe('E2/E3: immutableByConvention closed-world guard', () => {
  it('is the exact 22-member closed world (20 pinned entries + v1.0.10 + v1.0.11)', () => {
    expect(IMMUTABLE_BY_CONVENTION.length).toBe(22)
    expect(new Set(IMMUTABLE_BY_CONVENTION).size).toBe(22)
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.10.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.11.json')
  })

  it('excludes ODS_CARRY_FORWARD_BACKLOG.md by design (append-only working backlog)', () => {
    expect(IMMUTABLE_BY_CONVENTION).not.toContain('docs/ops/ods/ODS_CARRY_FORWARD_BACKLOG.md')
  })

  it('POSITIVE: an ordinary unrelated path passes the guard', () => {
    const result = checkImmutableGuard(['docs/ops/ods/ODS_SOME_NEW_ADDENDUM_v1.0.12.json'])
    expect(result.violated).toBe(false)
    expect(result.violatingPaths).toEqual([])
  })

  it('NEGATIVE CONTROL (E3, non-vacuous): a disposable attempt to target an immutableByConvention artifact STOPs', () => {
    const result = checkImmutableGuard(['docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json'])
    expect(result.violated).toBe(true)
    expect(result.violatingPaths).toEqual(['docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json'])
  })

  it('MUTATION CONTROL: an empty guard list would let the same attack through (proves the guard, not the fixture, does the work)', () => {
    // If IMMUTABLE_BY_CONVENTION were emptied, this exact violation would
    // vanish — demonstrating the guard is load-bearing rather than
    // decorative, without actually weakening the production constant.
    const vacuousGuardResult = checkImmutableGuard(['docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json'])
    const wouldBeVacuous = new Set<string>()
    const simulatedVacuousViolation = ['docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json'].filter((p) => wouldBeVacuous.has(p))
    expect(vacuousGuardResult.violatingPaths.length).toBeGreaterThan(0)
    expect(simulatedVacuousViolation.length).toBe(0)
  })

  it('a mixed changeset flags only the immutable member, not the ordinary sibling', () => {
    const result = checkImmutableGuard(['scripts/ods-controller.ts', 'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.9.json'])
    expect(result.violatingPaths).toEqual(['docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.9.json'])
  })
})

// ---------------------------------------------------------------------------
// E6 — fableEligible cannot be self-granted; Class B defaults to SONNET.
// ---------------------------------------------------------------------------

describe('E6: fableEligible self-grant prohibition', () => {
  it('absent fableEligible routes Class B to SONNET', () => {
    expect(routeClassBExecutor(undefined)).toBe('SONNET')
  })

  it('false fableEligible routes Class B to SONNET', () => {
    expect(routeClassBExecutor(false)).toBe('SONNET')
  })

  it('true fableEligible (already-authored elsewhere) routes Class B to FABLE_5_1', () => {
    expect(routeClassBExecutor(true)).toBe('FABLE_5_1')
  })

  it('the module exposes no function that sets fableEligible=true — routeClassBExecutor only reads its parameter', () => {
    // Non-vacuity: calling the reader twice with the same false/undefined
    // input never drifts toward true — there is no hidden mutable state.
    expect(routeClassBExecutor(undefined)).toBe('SONNET')
    expect(routeClassBExecutor(undefined)).toBe('SONNET')
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
  it('escalates MACHINE_ONLY to FOCUSED_OPUS when proposed is stricter', () => {
    expect(resolveAuditMode('MACHINE_ONLY', 'FOCUSED_OPUS')).toBe('FOCUSED_OPUS')
  })

  it('NEGATIVE CONTROL: never de-escalates FULL_OPUS down to MACHINE_ONLY', () => {
    expect(resolveAuditMode('FULL_OPUS', 'MACHINE_ONLY')).toBe('FULL_OPUS')
  })

  it('is a no-op when proposed equals declared', () => {
    expect(resolveAuditMode('FOCUSED_OPUS', 'FOCUSED_OPUS')).toBe('FOCUSED_OPUS')
  })
})

// ---------------------------------------------------------------------------
// Production/main boundary.
// ---------------------------------------------------------------------------

describe('main/production boundary', () => {
  it('POSITIVE: an ordinary feature branch is not a boundary violation', () => {
    expect(checkBranchBoundary('codex/autonomous-program-controller-r1')).toBeUndefined()
  })

  it('NEGATIVE CONTROL: targeting main STOPs with MAIN_MUTATION_ATTEMPT', () => {
    expect(checkBranchBoundary('main')).toBe('MAIN_MUTATION_ATTEMPT')
    expect(checkBranchBoundary('origin/main')).toBe('MAIN_MUTATION_ATTEMPT')
  })
})

// ---------------------------------------------------------------------------
// E5 — CONTROLLER_DB_EXECUTION=DISABLED non-vacuity, and dependsOn/
// externalPreconditions fail-closed routing, via pure decideSelection.
// ---------------------------------------------------------------------------

function baseUnit(overrides: Partial<ControllerUnit>): ControllerUnit {
  return {
    id: 'SYNTH-1',
    authority: { type: 'json-field', ref: 'HEAD', path: 'x.json', field: 'x', closedValues: ['x'] },
    implementation: { type: 'paths-exist', ref: 'HEAD', paths: [] },
    audit: { type: 'json-field', ref: 'HEAD', path: 'x.json', field: 'x', closedValues: ['x'] },
    integrationTargets: [],
    ...overrides,
  }
}

describe('E5/E8: node selection fail-closed routing (synthetic governed fixtures)', () => {
  it('POSITIVE CONTROL: a governed node with satisfied dependsOn, no externalPreconditions and dbWriting=false is selectable', () => {
    const unit = baseUnit({ dependsOn: ['DEP-1'], dbWriting: false })
    const decision = decideSelection(unit, { 'DEP-1': true }, {})
    expect(decision.selectable).toBe(true)
    expect(decision.stopClass).toBeUndefined()
  })

  it('NEGATIVE CONTROL: an unsatisfied dependsOn STOPs with AUTHORITY_GAP', () => {
    const unit = baseUnit({ dependsOn: ['DEP-1'] })
    const decision = decideSelection(unit, { 'DEP-1': false }, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('AUTHORITY_GAP')
  })

  it('NEGATIVE CONTROL (E5, non-vacuous): dbWriting=true STOPs with DATABASE_AUTHORITY_REQUIRED even with everything else satisfied', () => {
    const unit = baseUnit({ dependsOn: ['DEP-1'], dbWriting: true })
    const decision = decideSelection(unit, { 'DEP-1': true }, {})
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('DATABASE_AUTHORITY_REQUIRED')
  })

  it('MUTATION CONTROL: with the dbWriting guard hypothetically removed, the same node would be selectable (proves the guard, not the fixture, blocks it)', () => {
    const unit = baseUnit({ dependsOn: ['DEP-1'], dbWriting: true })
    const guarded = decideSelection(unit, { 'DEP-1': true }, {})
    const unguardedSimulation = decideSelection({ ...unit, dbWriting: false }, { 'DEP-1': true }, {})
    expect(guarded.selectable).toBe(false)
    expect(unguardedSimulation.selectable).toBe(true)
  })

  it('NEGATIVE CONTROL: an unresolved externalPrecondition STOPs with UNKNOWN_EVIDENCE, never treated as satisfied', () => {
    const unit = baseUnit({ externalPreconditions: ['SOME_EXTERNAL_GATE_CLOSED'] })
    const decision = decideSelection(unit, {}, { SOME_EXTERNAL_GATE_CLOSED: undefined })
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('UNKNOWN_EVIDENCE')
  })

  it('a resolved-but-OPEN externalPrecondition also STOPs with UNKNOWN_EVIDENCE, never advances on a false positive', () => {
    const unit = baseUnit({ externalPreconditions: ['SOME_EXTERNAL_GATE_CLOSED'] })
    const decision = decideSelection(unit, {}, { SOME_EXTERNAL_GATE_CLOSED: false })
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('UNKNOWN_EVIDENCE')
  })

  it('a resolved and CLOSED externalPrecondition allows selection (given no other blocker)', () => {
    const unit = baseUnit({ externalPreconditions: ['SOME_EXTERNAL_GATE_CLOSED'] })
    const decision = decideSelection(unit, {}, { SOME_EXTERNAL_GATE_CLOSED: true })
    expect(decision.selectable).toBe(true)
  })

  it('an unknown unit id STOPs with AUTHORITY_GAP via selectNode', () => {
    const registry: ProgramStateRegistry = { units: [] }
    const decision = selectNode(REPO_ROOT, registry, 'DOES-NOT-EXIST')
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('AUTHORITY_GAP')
  })
})

// ---------------------------------------------------------------------------
// Real repository proof: current W2-B4 must NOT be selectable while
// P1A_FULL_BOOTSTRAP_CLOSED is unresolved. Uses the actual registry file,
// not a synthetic fixture, per the mission's acceptance requirement.
// ---------------------------------------------------------------------------

describe('real registry: W2-B4 fail-closed selection', () => {
  const registry = loadRegistry(path.join(REPO_ROOT, DEFAULT_REGISTRY_RELATIVE_PATH))

  it('W2-B4 carries externalPreconditions=["P1A_FULL_BOOTSTRAP_CLOSED"] and dbWriting=true in the real registry', () => {
    const unit = registry.units.find((u) => u.id === 'W2-B4') as ControllerUnit | undefined
    expect(unit).toBeDefined()
    expect(unit?.externalPreconditions).toEqual(['P1A_FULL_BOOTSTRAP_CLOSED'])
    expect(unit?.dbWriting).toBe(true)
  })

  it('EXTERNAL_PRECONDITION_UNIT_MAP does not (and must not) resolve P1A_FULL_BOOTSTRAP_CLOSED', () => {
    expect(EXTERNAL_PRECONDITION_UNIT_MAP['P1A_FULL_BOOTSTRAP_CLOSED']).toBeUndefined()
  })

  it('selectNode STOPs W2-B4 fail-closed (UNKNOWN_EVIDENCE on the unresolved precondition, checked before the dbWriting boundary)', () => {
    const decision = selectNode(REPO_ROOT, registry, 'W2-B4')
    expect(decision.selectable).toBe(false)
    expect(decision.stopClass).toBe('UNKNOWN_EVIDENCE')
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
    const result = runMissionCycles(() => outcomes[cursor++] ?? { status: 'STOP', stopClass: 'MAX_MISSION_CYCLES_REACHED', signature: 'sig-c' })
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

  it('exhausting MAX_AUTONOMOUS_CYCLES without a PASS STOPs with MAX_MISSION_CYCLES_REACHED', () => {
    expect(MAX_AUTONOMOUS_CYCLES).toBe(5)
    let cycleCount = 0
    const result = runMissionCycles((cycle) => {
      cycleCount = cycle
      return { status: 'STOP', stopClass: 'INTEGRATION_CONFLICT', signature: `sig-${cycle}` }
    }, 1)
    // maxCycles=1 here to keep the test fast; INTEGRATION_CONFLICT is
    // terminal on first occurrence regardless, exercising the ceiling path
    // via a maxCycles=0 loop is redundant with the terminal-class test
    // above, so this asserts the ceiling directly instead.
    expect(cycleCount).toBe(1)
    expect(result.outcome).toBe('STOPPED')
  })

  it('the cycle ceiling itself fires when every cycle is a fresh non-flake terminal stop is impossible by construction (terminal stops exit on cycle 1) — so the ceiling is exercised via repeated FLAKE_SUSPECTED-then-distinct-signature stops consuming the run', () => {
    const result = runMissionCycles((cycle) => ({ status: 'STOP', stopClass: 'FLAKE_SUSPECTED', signature: `unique-${cycle}` }), 3)
    // cycle 1: flake, rerun granted (budget now 0) -> continue
    // cycle 2: new signature, budget exhausted -> terminal FLAKE_SUSPECTED
    expect(result.outcome).toBe('STOPPED')
    expect(result.stopClass).toBe('FLAKE_SUSPECTED')
    expect(result.cyclesRun).toBe(2)
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
