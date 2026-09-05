// scripts/ods-controller.ts — Autonomous Program Controller v0.
//   pnpm ops:controller -- --unit <id> [--json]
// Governed by ODS_CONTROLLER_AUTHORITY_v1.0.0.json (HPO-ODS-W2-10) plus the
// CTRL-M1/M2/M3/M4/M6 and CTRL-R1/R2/R3 hardening passes. Thin deterministic
// node selector/router reusing pnpm ops:program-state for closure evidence.
// Zero daemon/service/database/UI/second state store. CLI is READ-ONLY.

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

// Frozen run-state model and stop taxonomy. Closed-world.
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

// ag1_disposition.immutableByConvention.entries (20) + v1.0.10 + v1.0.11 + v1.0.12 + v1.0.13 + v1.0.14 + v1.0.15 + v1.0.16. EXACT membership — never a subset test.
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
  'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.12.json',
  'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.13.json',
  'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.14.json',
  'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.15.json',
  'docs/ops/ods/ODS_V1_MAINTENANCE_ADDENDUM_v1.0.16.json',
] as const

/** Backslashes -> /, drop "." and empty segments. CTRL-M3: path spelling must never bypass the guard. */
export function normalizeRepoPath(rawPath: string): string {
  return rawPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/')
}

/** nonCanonicalPaths: CTRL-R3 — matches an entry case-insensitively but not its canonical spelling; never silently lowercased, never PROTECTED_SURFACE_CHANGE. */
export interface ImmutableGuardResult { violated: boolean; violatingPaths: string[]; nonCanonicalPaths: string[] }

const IMMUTABLE_BY_CONVENTION_LOWER = new Set(IMMUTABLE_BY_CONVENTION.map((p) => p.toLowerCase()))

/** Pure. STOPs even when ods:scope alone would return OK for the same path. Canonical-exact match wins over a merely case-insensitive one. */
export function checkImmutableGuard(changedPaths: string[]): ImmutableGuardResult {
  const canonical = new Set(IMMUTABLE_BY_CONVENTION)
  const violatingPaths: string[] = []
  const nonCanonicalPaths: string[] = []
  for (const raw of changedPaths) {
    const normalized = normalizeRepoPath(raw)
    if (canonical.has(normalized)) violatingPaths.push(normalized)
    else if (IMMUTABLE_BY_CONVENTION_LOWER.has(normalized.toLowerCase())) nonCanonicalPaths.push(normalized)
  }
  return { violated: violatingPaths.length > 0, violatingPaths, nonCanonicalPaths }
}

// Production/main boundary. CTRL-M4: exact literal ref aliases only — never a substring/prefix match (integration/commercial-v1 can never hit).
const MAIN_REF_ALIASES = new Set(['main', 'origin/main', 'refs/heads/main', 'refs/remotes/origin/main'])
const PRODUCTION_REF_ALIASES = new Set(['production', 'origin/production', 'refs/heads/production', 'refs/remotes/origin/production'])

export function checkBranchBoundary(ref: string): StopClass | undefined {
  if (MAIN_REF_ALIASES.has(ref)) return 'MAIN_MUTATION_ATTEMPT'
  if (PRODUCTION_REF_ALIASES.has(ref)) return 'PRODUCTION_BOUNDARY_REACHED'
  return undefined
}

/** CTRL-M4: inspects a node's declared integrationTargets — never infers integration/commercial-v1 is Production. */
export function checkIntegrationTargetsBoundary(integrationTargets: string[]): StopClass | undefined {
  for (const target of integrationTargets) {
    const hit = checkBranchBoundary(target)
    if (hit) return hit
  }
  return undefined
}

// Executor routing — frozen A/B/C/D taxonomy, unchanged/unextended.
export type ExecutorClass = 'A' | 'B' | 'C' | 'D'
export type ClassBExecutor = 'SONNET' | 'FABLE_5_1'
const VALID_EXECUTION_CLASSES = new Set<string>(['A', 'B', 'C', 'D'])

/** CTRL-M6: JSON is runtime data — TypeScript annotations do not validate it. */
export function isValidExecutionClass(v: unknown): v is ExecutorClass {
  return typeof v === 'string' && VALID_EXECUTION_CLASSES.has(v)
}

/** Pure. fableEligible defaults to false; absence is read as false, never permission. Only READS its parameter. */
export function routeClassBExecutor(fableEligible: boolean | undefined): ClassBExecutor {
  return fableEligible === true ? 'FABLE_5_1' : 'SONNET'
}

/** Pure. No class B+, no CLASS_E. Callers must validate via isValidExecutionClass first — never routed here otherwise. */
export function routeExecutor(executionClass: ExecutorClass, fableEligible: boolean | undefined): string {
  if (executionClass === 'A') return 'OPUS'
  if (executionClass === 'D') return 'MACHINE'
  if (executionClass === 'B') return routeClassBExecutor(fableEligible)
  return 'LOWEST_AUTHORIZED_BOUNDED_EXECUTOR_OR_SCRIPT'
}

// Audit routing — escalate-only, self-certification prohibited.
export const AUDIT_MODES = ['MACHINE_ONLY', 'FOCUSED_OPUS', 'FULL_OPUS'] as const
export type AuditMode = (typeof AUDIT_MODES)[number]
const AUDIT_MODE_RANK: Record<AuditMode, number> = { MACHINE_ONLY: 0, FOCUSED_OPUS: 1, FULL_OPUS: 2 }
const VALID_AUDIT_MODES = new Set<string>(AUDIT_MODES)

export function isValidAuditMode(v: unknown): v is AuditMode {
  return typeof v === 'string' && VALID_AUDIT_MODES.has(v)
}

/** Pure. The stricter of `declared` and `proposed` always wins — never a de-escalation below `declared`. */
export function resolveAuditMode(declared: AuditMode, proposed: AuditMode): AuditMode {
  return AUDIT_MODE_RANK[proposed] > AUDIT_MODE_RANK[declared] ? proposed : declared
}

// Node selection — dependsOn/externalPreconditions/dbWriting/integrationTargets/writePaths/routing-metadata validity, fail-closed.
export type ClosureStatus = 'CLOSED' | 'OPEN' | 'UNKNOWN'
export type PreconditionStatus = ClosureStatus | 'CONFLICT'

export interface ControllerUnit extends ProgramStateUnit {
  dependsOn?: string[]
  externalPreconditions?: string[]
  /** CTRL-M2: this unit MAY provide one or more external-precondition tokens for other units, resolved generically without a Controller code change. */
  providesExternalPreconditions?: string[]
  executionClass?: unknown
  fableEligible?: unknown
  auditClass?: unknown
  dbWriting?: boolean
  /** CTRL-M3/R2: declared repository write surface. Absent = UNKNOWN (fails closed). Runtime JSON, not TS-trusted — validated by isValidWritePaths. */
  writePaths?: unknown
}

/** CTRL-R2: malformed writePaths (non-array, or an array containing a non-string) must fail closed, never be treated as [] or thrown past. */
export function isValidWritePaths(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((p) => typeof p === 'string')
}

/** alreadyClosed=true: the unit is already fully closed and not a next-executable node — never fabricated as a stop-class error. */
export interface SelectionDecision { unitId: string; selectable: boolean; stopClass?: StopClass; reason: string; alreadyClosed?: boolean }

/** CTRL-M1: preserves the ternary DimensionResult status rather than collapsing it to boolean. Any UNKNOWN dimension makes the aggregate UNKNOWN — never silently downgraded to OPEN by an unreadable ref. */
export function aggregateClosureStatus(authority: DimensionResult, implementation: DimensionResult, audit: DimensionResult): ClosureStatus {
  if (authority.status === 'UNKNOWN' || implementation.status === 'UNKNOWN' || audit.status === 'UNKNOWN') return 'UNKNOWN'
  return authority.status === 'CLOSED' && implementation.status === 'CLOSED' && audit.status === 'CLOSED' ? 'CLOSED' : 'OPEN'
}

// CTRL-M2: generic fail-closed resolver — a token is provided by a unit whose id equals it, OR whose providesExternalPreconditions[] lists it. No
// hard-coded per-token map. 0 providers=UNKNOWN, >1=AUTHORITY_CONFLICT, exactly 1 derives closure via the same evaluateEvidence machinery.
export function resolveExternalPrecondition(cwd: string, registry: ProgramStateRegistry, token: string): PreconditionStatus {
  const providers = registry.units.filter((u) => u.id === token || ((u as ControllerUnit).providesExternalPreconditions ?? []).includes(token))
  if (providers.length === 0) return 'UNKNOWN'
  if (providers.length > 1) return 'CONFLICT'
  const p = providers[0]
  return aggregateClosureStatus(evaluateEvidence(cwd, p.authority), evaluateEvidence(cwd, p.implementation), evaluateEvidence(cwd, p.audit))
}

// Pure: decides selectability given already-evaluated closure facts (never does I/O — see selectNode). Gate order: own-closure short-circuit
// (CLOSED/UNKNOWN, CTRL-R1), dependsOn, externalPreconditions, dbWriting, boundary (M4), write-surface guard (M3/R2/R3), routing metadata (M6).
export function decideSelection(
  unit: ControllerUnit,
  ownClosureStatus: ClosureStatus,
  dependsOnClosure: Record<string, ClosureStatus>,
  externalPreconditionClosure: Record<string, PreconditionStatus>,
): SelectionDecision {
  if (ownClosureStatus === 'CLOSED') {
    return { unitId: unit.id, selectable: false, alreadyClosed: true, reason: 'unit is already fully closed (authority+implementation+audit); not a next-executable node' }
  }
  if (ownClosureStatus === 'UNKNOWN') {
    return { unitId: unit.id, selectable: false, stopClass: 'UNKNOWN_EVIDENCE', reason: "unit's own authority/implementation/audit evidence could not be mechanically read" }
  }

  for (const dep of unit.dependsOn ?? []) {
    const status = dependsOnClosure[dep]
    if (status === 'CLOSED') continue
    if (status === 'UNKNOWN') return { unitId: unit.id, selectable: false, stopClass: 'UNKNOWN_EVIDENCE', reason: `dependsOn unit "${dep}" evidence could not be mechanically read` }
    return { unitId: unit.id, selectable: false, stopClass: 'AUTHORITY_GAP', reason: `dependsOn unit "${dep}" is not fully closed` }
  }

  for (const pre of unit.externalPreconditions ?? []) {
    const status = externalPreconditionClosure[pre]
    if (status === 'CLOSED') continue
    if (status === 'CONFLICT') return { unitId: unit.id, selectable: false, stopClass: 'AUTHORITY_CONFLICT', reason: `externalPrecondition "${pre}" has more than one provider unit` }
    if (status === 'UNKNOWN') return { unitId: unit.id, selectable: false, stopClass: 'UNKNOWN_EVIDENCE', reason: `externalPrecondition "${pre}" has no resolvable provider` }
    return { unitId: unit.id, selectable: false, stopClass: 'AUTHORITY_GAP', reason: `externalPrecondition "${pre}" provider is not fully closed` }
  }

  if (unit.dbWriting === true) {
    return { unitId: unit.id, selectable: false, stopClass: 'DATABASE_AUTHORITY_REQUIRED', reason: 'unit requires database execution; CONTROLLER_DB_EXECUTION=DISABLED' }
  }

  const boundary = checkIntegrationTargetsBoundary(unit.integrationTargets)
  if (boundary) return { unitId: unit.id, selectable: false, stopClass: boundary, reason: 'unit integrationTargets names a main/production boundary ref' }

  if (unit.writePaths === undefined) {
    return { unitId: unit.id, selectable: false, stopClass: 'AUTHORITY_GAP', reason: 'writePaths is not declared; write surface is UNKNOWN' }
  }
  if (!isValidWritePaths(unit.writePaths)) {
    return { unitId: unit.id, selectable: false, stopClass: 'AUTHORITY_CONFLICT', reason: `writePaths is malformed — must be an array of strings (found ${JSON.stringify(unit.writePaths)})` }
  }
  const guard = checkImmutableGuard(unit.writePaths)
  if (guard.violated) {
    return { unitId: unit.id, selectable: false, stopClass: 'PROTECTED_SURFACE_CHANGE', reason: `writePaths targets immutableByConvention artifact(s): ${guard.violatingPaths.join(', ')}` }
  }
  if (guard.nonCanonicalPaths.length > 0) {
    return { unitId: unit.id, selectable: false, stopClass: 'NONCANONICAL_PROTECTED_PATH', reason: `writePaths matches immutableByConvention case-insensitively but not canonically: ${guard.nonCanonicalPaths.join(', ')}` }
  }

  if (!isValidExecutionClass(unit.executionClass)) {
    return { unitId: unit.id, selectable: false, stopClass: 'AUTHORITY_CONFLICT', reason: `executionClass is missing or not one of A/B/C/D (found ${JSON.stringify(unit.executionClass)})` }
  }
  if (!isValidAuditMode(unit.auditClass)) {
    return { unitId: unit.id, selectable: false, stopClass: 'REQUIRED_INDEPENDENT_AUDIT', reason: `auditClass is missing or not one of MACHINE_ONLY/FOCUSED_OPUS/FULL_OPUS (found ${JSON.stringify(unit.auditClass)})` }
  }
  if (unit.fableEligible !== undefined && typeof unit.fableEligible !== 'boolean') {
    return { unitId: unit.id, selectable: false, stopClass: 'AUTHORITY_CONFLICT', reason: `fableEligible must be boolean if present (found ${typeof unit.fableEligible})` }
  }

  return { unitId: unit.id, selectable: true, reason: 'dependsOn closed, externalPreconditions satisfied, no database execution required, no boundary hit, write surface authorized, routing metadata valid' }
}

/** I/O wrapper: derives every closure fact via the existing evaluateEvidence machinery — never a second implementation of that fact. */
export function selectNode(cwd: string, registry: ProgramStateRegistry, unitId: string): SelectionDecision {
  const unit = findUnit(registry, unitId) as ControllerUnit | undefined
  if (!unit) return { unitId, selectable: false, stopClass: 'AUTHORITY_GAP', reason: `unit "${unitId}" is not present in the program-state registry` }

  const ownClosureStatus = aggregateClosureStatus(evaluateEvidence(cwd, unit.authority), evaluateEvidence(cwd, unit.implementation), evaluateEvidence(cwd, unit.audit))

  const dependsOnClosure: Record<string, ClosureStatus> = {}
  for (const dep of unit.dependsOn ?? []) {
    const depUnit = findUnit(registry, dep)
    dependsOnClosure[dep] = depUnit
      ? aggregateClosureStatus(evaluateEvidence(cwd, depUnit.authority), evaluateEvidence(cwd, depUnit.implementation), evaluateEvidence(cwd, depUnit.audit))
      : 'OPEN'
  }

  const externalPreconditionClosure: Record<string, PreconditionStatus> = {}
  for (const pre of unit.externalPreconditions ?? []) {
    externalPreconditionClosure[pre] = resolveExternalPrecondition(cwd, registry, pre)
  }

  return decideSelection(unit, ownClosureStatus, dependsOnClosure, externalPreconditionClosure)
}

// Cycle / rerun policy — stop_classes.rerun_policy + cycle_ceiling.
export const MAX_AUTONOMOUS_CYCLES = 5

export type CycleOutcome = { status: 'PASS' } | { status: 'STOP'; stopClass: StopClass; signature: string }
export type CycleExecutor = (cycleIndex: number) => CycleOutcome

export interface MissionRunResult { cyclesRun: number; outcome: 'CLOSED' | 'STOPPED'; stopClass?: StopClass; flakeRerunsUsed: number }

// Pure given `executor`. Only FLAKE_SUSPECTED may consume the single isolated rerun; every other stop class is terminal on first occurrence.
// A signature that already drew its rerun and recurs is reclassified REPEATED_LOCAL_FAILURE (anti-laundering rule).
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

// Audit packet derivation — deterministic pure composition, no randomness.
export interface AuditPacket { unitId: string; baseSha: string; candidateSha: string; authorityPaths: string[]; testResults: string[] }

export function buildAuditPacket(unitId: string, baseSha: string, candidateSha: string, authorityPaths: string[], testResults: string[]): AuditPacket {
  return { unitId, baseSha, candidateSha, authorityPaths: [...authorityPaths], testResults: [...testResults] }
}

// CLI — read-only routing report. No mutation, no DB, no daemon.
interface ControllerArgs { unit?: string; json: boolean }

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
  const executor = unit && isValidExecutionClass(unit.executionClass) ? routeExecutor(unit.executionClass, unit.fableEligible as boolean | undefined) : undefined

  if (args.json) {
    console.log(JSON.stringify({ decision, executor, auditClass: unit?.auditClass }, null, 2))
  } else {
    console.log(`UNIT=${decision.unitId}`)
    console.log(`SELECTABLE=${decision.selectable}`)
    if (decision.alreadyClosed) console.log('ALREADY_CLOSED=true')
    if (decision.stopClass) console.log(`STOP_CLASS=${decision.stopClass}`)
    console.log(`REASON=${decision.reason}`)
    if (executor) console.log(`EXECUTOR=${executor}`)
    if (unit?.auditClass) console.log(`AUDIT_CLASS=${unit.auditClass}`)
  }
  console.log(`ODS_CONTROLLER=${decision.selectable ? 'SELECTABLE' : 'STOPPED'}`)
  process.exit(decision.selectable ? 0 : 1)
}

// Only when run as a script — tests/ods/ods-controller.test.ts imports the pure functions above.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/ods-controller.ts')

if (invokedDirectly) main()
