// scripts/ods-program-state.ts — ODS-ACCEL-01 NODE 1, machine-readable
// cross-worktree program state.
//
//   pnpm ops:program-state -- --unit <id> [--json]
//
// Problem this closes: a prior analysis concluded a unit "was not
// implemented" because its objects were absent from a product branch. The
// actual state was AUTHORITY=CLOSED, IMPLEMENTATION=CLOSED, AUDIT=CLOSED,
// INTEGRATION=NOT_INTEGRATED — four independent dimensions collapsed into
// one wrong conclusion. This tool keeps them explicit and separately
// derived, so ABSENT_FROM_BRANCH is never silently read as
// NOT_IMPLEMENTED_IN_PROGRAM.
//
// Governance rule: no dimension's status is hardcoded in this file. Every
// unit's authority/implementation/audit evidence is a POINTER — a git ref,
// a repo path, an optional JSON field path — declared in
// docs/ops/ods/ODS_PROGRAM_STATE_REGISTRY_v1.0.0.json (operational
// metadata, not new authority). This script only reads the pointed-at
// evidence and reports what it finds. Evidence that cannot be read
// (missing ref, missing path, malformed JSON, missing field) is UNKNOWN —
// never silently promoted to CLOSED.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Registry types — the only place a unit's evidence pointers are declared.
// ---------------------------------------------------------------------------

export interface JsonFieldEvidence {
  type: 'json-field'
  ref: string
  path: string
  /** Dot-separated path into the JSON document, e.g. "source_audit_state.verdict". */
  field: string
  /** Values of that field which count as CLOSED. Anything else found is OPEN. */
  closedValues: string[]
}

export interface PathsExistEvidence {
  type: 'paths-exist'
  ref: string
  paths: string[]
}

export type Evidence = JsonFieldEvidence | PathsExistEvidence

export interface ProgramStateUnit {
  id: string
  description?: string
  authority: Evidence
  implementation: Evidence
  audit: Evidence
  integrationTargets: string[]
  productBranch?: string
}

export interface ProgramStateRegistry {
  units: ProgramStateUnit[]
}

// ---------------------------------------------------------------------------
// Pure status model.
// ---------------------------------------------------------------------------

export type DimensionStatus = 'CLOSED' | 'OPEN' | 'UNKNOWN'
export type IntegrationStatus = 'INTEGRATED' | 'NOT_INTEGRATED' | 'UNKNOWN'
export type BindingStatus = 'BOUND' | 'NOT_BOUND' | 'UNKNOWN' | 'NOT_CONFIGURED'

export interface DimensionResult {
  status: DimensionStatus
  evidenceRef: string
  evidenceKind: Evidence['type']
  detail: string
}

/** Pure: walks a dot-separated field path into a parsed JSON value. */
export function readDotPath(value: unknown, field: string): { found: boolean; value?: unknown } {
  const segments = field.split('.')
  let current: unknown = value
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || !(segment in (current as Record<string, unknown>))) {
      return { found: false }
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return { found: true, value: current }
}

/** Pure: given already-fetched blob text, evaluates a json-field evidence pointer. Fails closed (UNKNOWN) on any read/parse/field problem. */
export function evaluateJsonFieldFromText(evidence: JsonFieldEvidence, blobText: string | undefined): DimensionResult {
  const base = { evidenceRef: evidence.ref, evidenceKind: 'json-field' as const }
  if (blobText === undefined) {
    return { ...base, status: 'UNKNOWN', detail: `could not read ${evidence.ref}:${evidence.path}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(blobText)
  } catch {
    return { ...base, status: 'UNKNOWN', detail: `${evidence.ref}:${evidence.path} is not valid JSON` }
  }
  const field = readDotPath(parsed, evidence.field)
  if (!field.found) {
    return { ...base, status: 'UNKNOWN', detail: `field "${evidence.field}" not found in ${evidence.ref}:${evidence.path}` }
  }
  const isClosed = typeof field.value === 'string' && evidence.closedValues.includes(field.value)
  return {
    ...base,
    status: isClosed ? 'CLOSED' : 'OPEN',
    detail: `${evidence.ref}:${evidence.path}#${evidence.field} = ${JSON.stringify(field.value)}`,
  }
}

/** Pure: given already-fetched per-path existence, evaluates a paths-exist evidence pointer. Fails closed (UNKNOWN) when existence could not be determined at all. */
export function evaluatePathsExistFromResults(evidence: PathsExistEvidence, existence: Map<string, boolean | undefined>): DimensionResult {
  const base = { evidenceRef: evidence.ref, evidenceKind: 'paths-exist' as const }
  const missingDetermination = evidence.paths.filter((p) => existence.get(p) === undefined)
  if (missingDetermination.length > 0) {
    return { ...base, status: 'UNKNOWN', detail: `could not determine existence of: ${missingDetermination.join(', ')}` }
  }
  const absent = evidence.paths.filter((p) => existence.get(p) === false)
  if (absent.length > 0) {
    return { ...base, status: 'OPEN', detail: `missing at ${evidence.ref}: ${absent.join(', ')}` }
  }
  return { ...base, status: 'CLOSED', detail: `all ${evidence.paths.length} declared path(s) present at ${evidence.ref}` }
}

// ---------------------------------------------------------------------------
// Git-backed I/O — isolated so the pure evaluators above are testable
// without a repo.
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** undefined means "could not read" — the caller must treat that as UNKNOWN, never as absence. */
export function readBlobAtRef(cwd: string, ref: string, filePath: string): string | undefined {
  const res = git(cwd, ['show', `${ref}:${filePath}`])
  return res.code === 0 ? res.stdout : undefined
}

/** undefined means "could not determine" (e.g. the ref itself does not resolve) — distinct from a determined `false`. */
export function pathExistsAtRef(cwd: string, ref: string, filePath: string): boolean | undefined {
  const refCheck = git(cwd, ['cat-file', '-e', ref])
  if (refCheck.code !== 0) return undefined
  const res = git(cwd, ['cat-file', '-e', `${ref}:${filePath}`])
  return res.code === 0
}

export function isAncestor(cwd: string, ancestorRef: string, descendantRef: string): boolean | undefined {
  const a = git(cwd, ['cat-file', '-e', ancestorRef])
  const b = git(cwd, ['cat-file', '-e', descendantRef])
  if (a.code !== 0 || b.code !== 0) return undefined
  const res = git(cwd, ['merge-base', '--is-ancestor', ancestorRef, descendantRef])
  return res.code === 0
}

/** Resolves a branch NAME (not a bare sha) to a commit — undefined if the branch does not exist locally. */
export function resolveBranch(cwd: string, branch: string): string | undefined {
  const res = git(cwd, ['rev-parse', '--verify', branch])
  return res.code === 0 ? res.stdout.trim() : undefined
}

export function evaluateEvidence(cwd: string, evidence: Evidence): DimensionResult {
  if (evidence.type === 'json-field') {
    return evaluateJsonFieldFromText(evidence, readBlobAtRef(cwd, evidence.ref, evidence.path))
  }
  const existence = new Map<string, boolean | undefined>()
  for (const p of evidence.paths) existence.set(p, pathExistsAtRef(cwd, evidence.ref, p))
  return evaluatePathsExistFromResults(evidence, existence)
}

/** The implementation ref is authoritative-per-unit — INTEGRATION never re-derives from a --allow list or a heuristic file scan, only from git ancestry against the declared implementation ref. */
export function evaluateIntegration(cwd: string, implementationRef: string, targetBranch: string): { status: IntegrationStatus; detail: string } {
  const targetSha = resolveBranch(cwd, targetBranch)
  if (targetSha === undefined) {
    return { status: 'UNKNOWN', detail: `target branch "${targetBranch}" does not resolve locally` }
  }
  const ancestor = isAncestor(cwd, implementationRef, targetSha)
  if (ancestor === undefined) {
    return { status: 'UNKNOWN', detail: `could not compute ancestry of ${implementationRef} against ${targetBranch} (${targetSha})` }
  }
  return {
    status: ancestor ? 'INTEGRATED' : 'NOT_INTEGRATED',
    detail: `${implementationRef} ${ancestor ? 'is' : 'is not'} an ancestor of ${targetBranch} (${targetSha})`,
  }
}

export interface ProgramStateReport {
  unit: string
  description?: string
  authority: DimensionResult
  implementation: DimensionResult
  audit: DimensionResult
  integration: Record<string, IntegrationStatus>
  productBinding: Record<string, BindingStatus>
}

/** Pure composition given already-computed dimension results and per-branch integration lookups — testable without spawning git. */
export function composeReport(
  unit: ProgramStateUnit,
  authority: DimensionResult,
  implementation: DimensionResult,
  audit: DimensionResult,
  integrationByBranch: Record<string, IntegrationStatus>,
): ProgramStateReport {
  const productBinding: Record<string, BindingStatus> = {}
  if (unit.productBranch) {
    const productIntegration = integrationByBranch[unit.productBranch]
    productBinding[unit.productBranch] =
      productIntegration === 'INTEGRATED' ? 'BOUND' : productIntegration === 'NOT_INTEGRATED' ? 'NOT_BOUND' : 'UNKNOWN'
  }
  return {
    unit: unit.id,
    description: unit.description,
    authority,
    implementation,
    audit,
    integration: integrationByBranch,
    productBinding,
  }
}

export function buildProgramStateReport(cwd: string, unit: ProgramStateUnit, extraIntegrationTargets: string[]): ProgramStateReport {
  const authority = evaluateEvidence(cwd, unit.authority)
  const implementation = evaluateEvidence(cwd, unit.implementation)
  const audit = evaluateEvidence(cwd, unit.audit)

  const targets = [...new Set([...unit.integrationTargets, ...(unit.productBranch ? [unit.productBranch] : []), ...extraIntegrationTargets])]
  const integrationByBranch: Record<string, IntegrationStatus> = {}
  for (const branch of targets) {
    integrationByBranch[branch] = evaluateIntegration(cwd, unit.implementation.ref, branch).status
  }

  return composeReport(unit, authority, implementation, audit, integrationByBranch)
}

// ---------------------------------------------------------------------------
// Registry loading.
// ---------------------------------------------------------------------------

export const DEFAULT_REGISTRY_RELATIVE_PATH = 'docs/ops/ods/ODS_PROGRAM_STATE_REGISTRY_v1.0.0.json'

export function loadRegistry(registryAbsolutePath: string): ProgramStateRegistry {
  const raw = readFileSync(registryAbsolutePath, 'utf8')
  const parsed = JSON.parse(raw) as ProgramStateRegistry
  if (!Array.isArray(parsed.units)) throw new Error(`${registryAbsolutePath}: missing "units" array`)
  return parsed
}

export function findUnit(registry: ProgramStateRegistry, id: string): ProgramStateUnit | undefined {
  return registry.units.find((u) => u.id === id)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface ProgramStateArgs {
  unit?: string
  json: boolean
  integrationTargets: string[]
  registryPath?: string
}

const RECOGNIZED_FLAGS = new Set(['--unit', '--json', '--integration-target', '--registry'])

function looksLikeMissingOperand(token: string | undefined): boolean {
  return token === undefined || token === '--' || RECOGNIZED_FLAGS.has(token)
}

function parseArgs(argv: string[]): ProgramStateArgs {
  const args: ProgramStateArgs = { json: false, integrationTargets: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--unit') {
      const value = argv[i + 1]
      if (looksLikeMissingOperand(value)) {
        console.error('ops:program-state: --unit requires a value')
        process.exit(2)
      }
      args.unit = value
      i++
    } else if (arg === '--integration-target') {
      const value = argv[i + 1]
      if (looksLikeMissingOperand(value)) {
        console.error('ops:program-state: --integration-target requires a value')
        process.exit(2)
      }
      args.integrationTargets.push(value)
      i++
    } else if (arg === '--registry') {
      const value = argv[i + 1]
      if (looksLikeMissingOperand(value)) {
        console.error('ops:program-state: --registry requires a value')
        process.exit(2)
      }
      args.registryPath = value
      i++
    } else if (arg === '--json') {
      args.json = true
    } else {
      console.error(`ops:program-state: unrecognized argument "${arg}"`)
      process.exit(2)
    }
  }
  return args
}

function stableStringify(report: ProgramStateReport): string {
  // Explicit key order — never Object.keys() insertion order left to chance
  // across engines, and never a re-sorted alphabetical order that would
  // scramble the deliberate authority -> implementation -> audit ->
  // integration -> productBinding reading order.
  const ordered = {
    unit: report.unit,
    description: report.description,
    authority: report.authority,
    implementation: report.implementation,
    audit: report.audit,
    integration: report.integration,
    productBinding: report.productBinding,
  }
  return JSON.stringify(ordered, null, 2)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!args.unit) {
    console.error('ops:program-state: --unit <id> is required')
    console.log('ODS_PROGRAM_STATE=USAGE_ERROR')
    process.exit(2)
  }

  const cwd = process.cwd()
  const registryAbsolutePath = path.join(cwd, args.registryPath ?? DEFAULT_REGISTRY_RELATIVE_PATH)
  const registry = loadRegistry(registryAbsolutePath)
  const unit = findUnit(registry, args.unit)
  if (!unit) {
    console.error(`ops:program-state: unknown unit "${args.unit}" (not present in ${registryAbsolutePath})`)
    console.log('ODS_PROGRAM_STATE=USAGE_ERROR')
    process.exit(2)
  }

  const report = buildProgramStateReport(cwd, unit, args.integrationTargets)

  if (args.json) {
    console.log(stableStringify(report))
    process.exit(0)
  }

  const lines: string[] = []
  lines.push(`UNIT=${report.unit}`)
  lines.push(`AUTHORITY_STATUS=${report.authority.status}`)
  lines.push(`  ${report.authority.detail}`)
  lines.push(`IMPLEMENTATION_STATUS=${report.implementation.status}`)
  lines.push(`  ${report.implementation.detail}`)
  lines.push(`AUDIT_STATUS=${report.audit.status}`)
  lines.push(`  ${report.audit.detail}`)
  for (const [branch, status] of Object.entries(report.integration)) {
    lines.push(`INTEGRATION_STATUS[${branch}]=${status}`)
  }
  for (const [branch, status] of Object.entries(report.productBinding)) {
    lines.push(`PRODUCT_BINDING_STATUS[${branch}]=${status}`)
  }
  lines.push('ODS_PROGRAM_STATE=REPORTED')
  console.log(lines.join('\n'))
  process.exit(0)
}

// Only when run as a script — tests/ods/ods-program-state.test.ts imports
// the pure functions above. See scripts/authority-seal-verify.ts for why
// argv is checked rather than `import.meta.url`.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/ods-program-state.ts')

if (invokedDirectly) main()
