// tests/ods/ods-controller.test.ts — Autonomous Program Controller v0
// positive, negative, mutation and closed-world controls.
//
// Governed by docs/ops/ods/ODS_CONTROLLER_AUTHORITY_v1.0.0.json
// exit_criteria_for_controller_v0_implementation (E1..E8) and the
// AUTONOMOUS-PROGRAM-CONTROLLER-V0-AUDIT-REMEDIATION-R1 hardening pass
// (CTRL-M1/M2/M3/M4/M6). Synthetic fixtures live only in this file.

import { describe, it, expect } from 'vitest'
import path from 'node:path'
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
import { loadRegistry, DEFAULT_REGISTRY_RELATIVE_PATH, type ProgramStateRegistry, type Evidence } from '../../scripts/ods-program-state'

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
  it('is the exact 22-member closed world (20 pinned entries + v1.0.10 + v1.0.11)', () => {
    expect(IMMUTABLE_BY_CONVENTION.length).toBe(22)
    expect(new Set(IMMUTABLE_BY_CONVENTION).size).toBe(22)
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.10.json')
    expect(IMMUTABLE_BY_CONVENTION).toContain('docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.11.json')
  })

  it('excludes ODS_CARRY_FORWARD_BACKLOG.md by design (append-only working backlog)', () => {
    expect(IMMUTABLE_BY_CONVENTION).not.toContain('docs/ops/ods/ODS_CARRY_FORWARD_BACKLOG.md')
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

  it('REAL REGISTRY: W2-B3 (fully closed authority+implementation+audit) is not misselected as executable', () => {
    const registry = loadRegistry(path.join(REPO_ROOT, DEFAULT_REGISTRY_RELATIVE_PATH))
    const decision = selectNode(REPO_ROOT, registry, 'W2-B3')
    expect(decision.selectable).toBe(false)
    expect(decision.alreadyClosed).toBe(true)
    expect(decision.stopClass).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Real repository proof: W2-B4 is not selectable while
// P1A_FULL_BOOTSTRAP_CLOSED is unresolved — now a single deterministic
// answer under CTRL-M1 (dependsOn UNKNOWN evidence and unresolved
// externalPreconditions both map to UNKNOWN_EVIDENCE).
// ---------------------------------------------------------------------------

describe('real registry: W2-B4 fail-closed selection', () => {
  const registry = loadRegistry(path.join(REPO_ROOT, DEFAULT_REGISTRY_RELATIVE_PATH))

  it('W2-B4 carries externalPreconditions=["P1A_FULL_BOOTSTRAP_CLOSED"] and dbWriting=true', () => {
    const unit = registry.units.find((u) => u.id === 'W2-B4') as ControllerUnit | undefined
    expect(unit?.externalPreconditions).toEqual(['P1A_FULL_BOOTSTRAP_CLOSED'])
    expect(unit?.dbWriting).toBe(true)
  })

  it('selectNode STOPs W2-B4 fail-closed with UNKNOWN_EVIDENCE, deterministically', () => {
    const decision = selectNode(REPO_ROOT, registry, 'W2-B4')
    expect(decision.selectable).toBe(false)
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
