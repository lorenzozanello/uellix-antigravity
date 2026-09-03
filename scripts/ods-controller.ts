// scripts/ods-controller.ts — Autonomous Program Controller v0.
//
//   pnpm ops:controller -- --unit <id> [--json]
//
// Governed by docs/ops/ods/ODS_CONTROLLER_AUTHORITY_v1.0.0.json (HPO-ODS-W2-10)
// and docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.9.json. A thin
// deterministic node selector/router over machine gates that already exist
// in this repository — it performs no semantic judgment an existing gate
// already answers, and reuses pnpm ops:program-state (scripts/ods-program-state.ts)
// for unit closure evidence rather than reimplementing it. Zero daemon,
// zero service, zero database, zero UI, zero second state store.
//
// The default CLI invocation is READ-ONLY: it reports a routing decision
// for one named unit and never mutates repository or shared state.
// CONTROLLER_DB_EXECUTION is DISABLED and not configurable from this file.

import path from 'node:path'
import {
  loadRegistry,
  findUnit,
  evaluateEvidence,
  DEFAULT_REGISTRY_RELATIVE_PATH,
  type ProgramStateRegistry,
  type ProgramStateUnit,
  type DimensionResult,
} from './ods-program-state'

// ---------------------------------------------------------------------------
// Frozen run-state model and stop taxonomy —
// ODS_CONTROLLER_AUTHORITY_v1.0.0.json controller_v0_design. Closed-world:
// tests assert these arrays against the frozen authority exactly.
// ---------------------------------------------------------------------------

export const CONTROLLER_STATES = ['READY', 'PREFLIGHT', 'EXECUTING', 'GATE', 'AUDIT_REQUIRED', 'CLOSED', 'STOPPED'] as const
export type ControllerState = (typeof CONTROLLER_STATES)[number]

export const STOP_CLASSES = [
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
] as const
export type StopClass = (typeof STOP_CLASSES)[number]

// ag1_disposition.immutableByConvention.entries (20, pinned at
// a4f4fa0369e6abd944248e2abf0edb50cb05e0ba) PLUS the two successor addenda
// v1.0.10 and v1.0.11, whose own cross_lane_disposition clauses obligate
// this exact inclusion. docs/ops/ods/ODS_CARRY_FORWARD_BACKLOG.md is
// deliberately excluded (append-only working backlog). EXACT membership —
// never a subset/contains test. Additive defense-in-depth on top of
// ods:scope, per ODS_CONTROLLER_AUTHORITY_v1.0.0.json
// ag1_disposition.controller_local_rule: the STRICTER outcome always wins.
export const IMMUTABLE_BY_CONVENTION: readonly string[] = [
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
] as const

export interface ImmutableGuardResult {
  violated: boolean
  violatingPaths: string[]
}

/** Pure. STOPs even when ods:scope alone would return OK for the same path — that asymmetry is intentional (see ag1_disposition.controller_local_rule.precedence). */
export function checkImmutableGuard(changedPaths: string[]): ImmutableGuardResult {
  const set = new Set(IMMUTABLE_BY_CONVENTION)
  const violatingPaths = changedPaths.filter((p) => set.has(p))
  return { violated: violatingPaths.length > 0, violatingPaths }
}

// ---------------------------------------------------------------------------
// Production/main boundary — production_freeze_invariant.
// ---------------------------------------------------------------------------

/** Pure. main is never a controller-writable or mergeable target. */
export function checkBranchBoundary(branch: string): StopClass | undefined {
  return branch === 'main' || branch === 'origin/main' ? 'MAIN_MUTATION_ATTEMPT' : undefined
}

// ---------------------------------------------------------------------------
// Executor routing — frozen A/B/C/D taxonomy, unchanged/unextended.
// mc1_disposition.fable_disposition.
// ---------------------------------------------------------------------------

export type ExecutorClass = 'A' | 'B' | 'C' | 'D'
export type ClassBExecutor = 'SONNET' | 'FABLE_5_1'

/**
 * Pure. fableEligible defaults to false; absence is read as false, never as
 * permission. This function only READS the flag passed to it — nothing in
 * this module authors, infers, defaults, or promotes fableEligible=true.
 */
export function routeClassBExecutor(fableEligible: boolean | undefined): ClassBExecutor {
  return fableEligible === true ? 'FABLE_5_1' : 'SONNET'
}

/** Pure. No class B+, no CLASS_E — exactly the four frozen classes. */
export function routeExecutor(executionClass: ExecutorClass, fableEligible: boolean | undefined): string {
  if (executionClass === 'A') return 'OPUS'
  if (executionClass === 'D') return 'MACHINE'
  if (executionClass === 'B') return routeClassBExecutor(fableEligible)
  return 'LOWEST_AUTHORIZED_BOUNDED_EXECUTOR_OR_SCRIPT'
}

// ---------------------------------------------------------------------------
// Audit routing — escalate-only, self-certification prohibited.
// ---------------------------------------------------------------------------

export const AUDIT_MODES = ['MACHINE_ONLY', 'FOCUSED_OPUS', 'FULL_OPUS'] as const
export type AuditMode = (typeof AUDIT_MODES)[number]

const AUDIT_MODE_RANK: Record<AuditMode, number> = { MACHINE_ONLY: 0, FOCUSED_OPUS: 1, FULL_OPUS: 2 }

/** Pure. The stricter of `declared` and `proposed` always wins — never a de-escalation below `declared`. */
export function resolveAuditMode(declared: AuditMode, proposed: AuditMode): AuditMode {
  return AUDIT_MODE_RANK[proposed] > AUDIT_MODE_RANK[declared] ? proposed : declared
}

// ---------------------------------------------------------------------------
// Node selection — dependsOn / externalPreconditions / dbWriting, fail-closed.
// ---------------------------------------------------------------------------

export interface ControllerUnit extends ProgramStateUnit {
  dependsOn?: string[]
  externalPreconditions?: string[]
  executionClass?: ExecutorClass
  fableEligible?: boolean
  auditClass?: AuditMode
  dbWriting?: boolean
}

export interface SelectionDecision {
  unitId: string
  selectable: boolean
  stopClass?: StopClass
  reason: string
}

/**
 * Precondition strings resolvable to a program-state unit's full closure.
 * Deliberately EMPTY at this authority: no registry unit currently backs
 * "P1A_FULL_BOOTSTRAP_CLOSED" (P1A closure is a five-part conjunction —
 * see docs/ops/wave2/W2_B4_AUTHORITY_v1.0.0.json p1a_synchronization —
 * with no single program-state evidence pointer). Adding an entry here is
 * a controller-policy act, never a runtime inference. An unmapped
 * precondition MUST fail closed, never be treated as satisfied.
 */
export const EXTERNAL_PRECONDITION_UNIT_MAP: Readonly<Record<string, string>> = {}

function isUnitFullyClosed(authority: DimensionResult, implementation: DimensionResult, audit: DimensionResult): boolean {
  return authority.status === 'CLOSED' && implementation.status === 'CLOSED' && audit.status === 'CLOSED'
}

/**
 * Pure: decides selectability given already-evaluated closure facts for
 * the target unit's dependsOn and externalPreconditions. Never performs
 * git/fs I/O itself — see selectNode for the I/O-performing wrapper that
 * derives these inputs via the existing evaluateEvidence machinery.
 */
export function decideSelection(
  unit: ControllerUnit,
  dependsOnClosure: Record<string, boolean>,
  externalPreconditionClosure: Record<string, boolean | undefined>,
): SelectionDecision {
  for (const dep of unit.dependsOn ?? []) {
    if (!dependsOnClosure[dep]) {
      return { unitId: unit.id, selectable: false, stopClass: 'AUTHORITY_GAP', reason: `dependsOn unit "${dep}" is not fully closed (authority+implementation+audit)` }
    }
  }
  for (const pre of unit.externalPreconditions ?? []) {
    const status = externalPreconditionClosure[pre]
    if (status !== true) {
      return {
        unitId: unit.id,
        selectable: false,
        stopClass: 'UNKNOWN_EVIDENCE',
        reason: `externalPrecondition "${pre}" is not mechanically proven satisfied (status=${status === false ? 'OPEN' : 'UNRESOLVABLE'})`,
      }
    }
  }
  if (unit.dbWriting === true) {
    return { unitId: unit.id, selectable: false, stopClass: 'DATABASE_AUTHORITY_REQUIRED', reason: 'unit requires database execution; CONTROLLER_DB_EXECUTION=DISABLED' }
  }
  return { unitId: unit.id, selectable: true, reason: 'dependsOn closed, externalPreconditions satisfied, no database execution required' }
}

/** I/O wrapper: derives dependsOn/externalPreconditions closure via the existing pnpm ops:program-state evidence machinery — never a second implementation of that fact. */
export function selectNode(cwd: string, registry: ProgramStateRegistry, unitId: string): SelectionDecision {
  const unit = findUnit(registry, unitId) as ControllerUnit | undefined
  if (!unit) return { unitId, selectable: false, stopClass: 'AUTHORITY_GAP', reason: `unit "${unitId}" is not present in the program-state registry` }

  const dependsOnClosure: Record<string, boolean> = {}
  for (const dep of unit.dependsOn ?? []) {
    const depUnit = findUnit(registry, dep)
    dependsOnClosure[dep] = depUnit
      ? isUnitFullyClosed(evaluateEvidence(cwd, depUnit.authority), evaluateEvidence(cwd, depUnit.implementation), evaluateEvidence(cwd, depUnit.audit))
      : false
  }

  const externalPreconditionClosure: Record<string, boolean | undefined> = {}
  for (const pre of unit.externalPreconditions ?? []) {
    const mappedUnitId = EXTERNAL_PRECONDITION_UNIT_MAP[pre]
    const mappedUnit = mappedUnitId ? findUnit(registry, mappedUnitId) : undefined
    externalPreconditionClosure[pre] = mappedUnit
      ? isUnitFullyClosed(evaluateEvidence(cwd, mappedUnit.authority), evaluateEvidence(cwd, mappedUnit.implementation), evaluateEvidence(cwd, mappedUnit.audit))
      : undefined
  }

  return decideSelection(unit, dependsOnClosure, externalPreconditionClosure)
}

// ---------------------------------------------------------------------------
// Cycle / rerun policy — stop_classes.rerun_policy + cycle_ceiling.
// ---------------------------------------------------------------------------

export const MAX_AUTONOMOUS_CYCLES = 5

export type CycleOutcome = { status: 'PASS' } | { status: 'STOP'; stopClass: StopClass; signature: string }
export type CycleExecutor = (cycleIndex: number) => CycleOutcome

export interface MissionRunResult {
  cyclesRun: number
  outcome: 'CLOSED' | 'STOPPED'
  stopClass?: StopClass
  flakeRerunsUsed: number
}

/**
 * Pure given `executor`. Only a FLAKE_SUSPECTED outcome may consume the
 * single isolated rerun; every other stop class is terminal on first
 * occurrence. A signature that already drew its one rerun and recurs is
 * reclassified REPEATED_LOCAL_FAILURE — it can never draw a second one
 * (the anti-laundering rule).
 */
export function runMissionCycles(executor: CycleExecutor, maxCycles: number = MAX_AUTONOMOUS_CYCLES): MissionRunResult {
  let flakeRerunsUsed = 0
  const flakeRetriedSignatures = new Set<string>()

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const result = executor(cycle)
    if (result.status === 'PASS') return { cyclesRun: cycle, outcome: 'CLOSED', flakeRerunsUsed }

    if (result.stopClass === 'FLAKE_SUSPECTED') {
      if (flakeRetriedSignatures.has(result.signature)) {
        return { cyclesRun: cycle, outcome: 'STOPPED', stopClass: 'REPEATED_LOCAL_FAILURE', flakeRerunsUsed }
      }
      if (flakeRerunsUsed < 1) {
        flakeRerunsUsed++
        flakeRetriedSignatures.add(result.signature)
        continue
      }
      return { cyclesRun: cycle, outcome: 'STOPPED', stopClass: 'FLAKE_SUSPECTED', flakeRerunsUsed }
    }

    return { cyclesRun: cycle, outcome: 'STOPPED', stopClass: result.stopClass, flakeRerunsUsed }
  }

  return { cyclesRun: maxCycles, outcome: 'STOPPED', stopClass: 'MAX_MISSION_CYCLES_REACHED', flakeRerunsUsed }
}

// ---------------------------------------------------------------------------
// Audit packet derivation — deterministic pure composition, no randomness.
// ---------------------------------------------------------------------------

export interface AuditPacket {
  unitId: string
  baseSha: string
  candidateSha: string
  authorityPaths: string[]
  testResults: string[]
}

export function buildAuditPacket(unitId: string, baseSha: string, candidateSha: string, authorityPaths: string[], testResults: string[]): AuditPacket {
  return { unitId, baseSha, candidateSha, authorityPaths: [...authorityPaths], testResults: [...testResults] }
}

// ---------------------------------------------------------------------------
// CLI — read-only routing report. No mutation, no DB, no daemon.
// ---------------------------------------------------------------------------

interface ControllerArgs {
  unit?: string
  json: boolean
}

function parseArgs(argv: string[]): ControllerArgs {
  const args: ControllerArgs = { json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--unit') args.unit = argv[++i]
    else if (arg === '--json') args.json = true
    else {
      console.error(`ops:controller: unrecognized argument "${arg}"`)
      process.exit(2)
    }
  }
  return args
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!args.unit) {
    console.error('ops:controller: --unit <id> is required (read-only routing report; no mutation)')
    console.log('ODS_CONTROLLER=USAGE_ERROR')
    process.exit(2)
  }

  const cwd = process.cwd()
  const registry = loadRegistry(path.join(cwd, DEFAULT_REGISTRY_RELATIVE_PATH))
  const decision = selectNode(cwd, registry, args.unit)
  const unit = findUnit(registry, args.unit) as ControllerUnit | undefined
  const executor = unit?.executionClass ? routeExecutor(unit.executionClass, unit.fableEligible) : undefined

  if (args.json) {
    console.log(JSON.stringify({ decision, executor, auditClass: unit?.auditClass }, null, 2))
  } else {
    console.log(`UNIT=${decision.unitId}`)
    console.log(`SELECTABLE=${decision.selectable}`)
    if (decision.stopClass) console.log(`STOP_CLASS=${decision.stopClass}`)
    console.log(`REASON=${decision.reason}`)
    if (executor) console.log(`EXECUTOR=${executor}`)
    if (unit?.auditClass) console.log(`AUDIT_CLASS=${unit.auditClass}`)
  }
  console.log(`ODS_CONTROLLER=${decision.selectable ? 'SELECTABLE' : 'STOPPED'}`)
  process.exit(decision.selectable ? 0 : 1)
}

// Only when run as a script — tests/ods/ods-controller.test.ts imports the
// pure functions above. See scripts/authority-seal-verify.ts for why argv
// is checked rather than `import.meta.url`.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/ods-controller.ts')

if (invokedDirectly) main()
