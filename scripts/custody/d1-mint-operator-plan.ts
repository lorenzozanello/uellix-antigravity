// scripts/custody/d1-mint-operator-plan.ts
//
// THE PRE-EXECUTION GATE OF THE OPERATOR CHANNEL (EXECUTION_PROCEDURE).
//
//   pnpm custody:operator-channel:gate -- --mode=probe|mint --channel-dir=<OUTSIDE the repository> [--tools-dir=<dir>] [--write]
//
// Every field of the launcher's plan is DERIVED from the repository here, and
// nowhere else:
//
//   targetHost        N04 arm A (the DAG's authorized direct host, evaluated
//                     by evaluateN04 exactly as PRE-HC1 does; NOT_SATISFIED -> no plan)
//   targetPort/Database  the route-B session (ROUTE_B_PORT, ROUTE_B_DATABASE)
//   validUntil        the effective N09 (mint only) — never N08
//   driverRoot        route B: the repository root, from which createRequire
//                     resolves `postgres`; its package version must be 3.4.9
//   driverDigest      OT-17: sha256 over the files of that package
//   depositor         the built N30 depositor (mint only), built into the channel dir
//   tool              the pinned tool file for the mode (effective CHANNEL_BINDING)
//   launcherDigest    the pinned launcher build digest (effective CHANNEL_BINDING)
//   operatorPrincipal the principal the certified OEP-1 evidence observed (mint only)
//
// The probe is planned only for a CERTIFIED channel (OC-12); the mint only with
// closed OEP-1 evidence. Then the gate checks what will actually run: the
// launcher build written to the channel dir hashes to the pin, each tool file
// hashes to its pin, the worktree is clean, and the UTC clock is before N08
// (the PRE-HC1 evaluator does not read the clock; NB-3). With --write it writes
// the plan; without it, it compares the plan already on disk field by field.
// ANY difference is STOP. It connects to nothing.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { ROUTE_B_DRIVER, driverDigest, type ChannelMode } from '../../db/custody/mint-operator-channel'
import { ROUTE_B_DATABASE, ROUTE_B_PORT } from '../../db/custody/mint-route-b-contract'
import {
  channelCertificationReasons,
  defaultToolsDir,
  gatherChannelEventFacts,
  gatherOep1EvidenceFacts,
  oep1EvidenceReasons,
  readChannelBinding,
  routeBTransportFacts,
  sha256Hex as sha256,
  type ChannelBinding,
  type ChannelEventFacts,
  type Oep1EvidenceFacts,
} from './d1-mint-operator-evidence'
import { isInsideRepositoryTree } from './build-sentinel-consumer'
import { buildProductionEntryPoints } from './build-production-entrypoints'
import { buildLauncherClosure, digestOfWrittenLauncher, writeLauncherBuild } from './d1-mint-operator-channel-build'
import { deriveEffectiveSchedule } from './d1-effective-schedule'
import { evaluateN04 } from './d1-pre-hc1'
import { PLAN_SCHEMA, type ChannelPlan } from './d1-mint-operator-launcher'
import { AUDITOR_DATABASE_ROLE } from '../../db/safety/database-role'
import { CERTIFICATION_EVENT_PATTERN } from './d1-package-closure'

const DAG_BASE = 'docs/ops/release/FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_v1.0.0.json'
const INVENTORY = 'docs/ops/staging/FIBDB053_AUDITOR_CREDENTIAL_CUSTODY_INVENTORY_v1.0.0.json'

/** N04's host, as PRE-HC1 evaluates it: returned only when N04 is SATISFIED. */
export function deriveTargetHost(root: string): { host: string | null; reasons: string[] } {
  const dag = JSON.parse(readFileSync(join(root, DAG_BASE), 'utf8')) as { TARGET_IDENTITY: { AUTHORIZED_TARGET_REF: string; authorized_direct_host: string; PRODUCTION_VETOED_REF: string } }
  const inv = JSON.parse(readFileSync(join(root, INVENTORY), 'utf8')) as { entries: Array<{ target_project_ref: string; role: string }> }
  const n04 = evaluateN04({
    declaredRefs: { dag_TARGET_IDENTITY: dag.TARGET_IDENTITY.AUTHORIZED_TARGET_REF, custody_inventory: inv.entries[0]!.target_project_ref },
    authorizedDirectHost: dag.TARGET_IDENTITY.authorized_direct_host,
    dagVetoedRef: dag.TARGET_IDENTITY.PRODUCTION_VETOED_REF,
    declaredRoles: { custody_inventory: inv.entries[0]!.role, database_role_constant: AUDITOR_DATABASE_ROLE },
  })
  return n04.status === 'SATISFIED' ? { host: dag.TARGET_IDENTITY.authorized_direct_host.toLowerCase(), reasons: [] } : { host: null, reasons: n04.reasons.map((x) => `N04: ${x}`) }
}

export function routeBDriver(root: string): { driverRoot: string; version: string | null; digest: string | null; reasons: string[] } {
  let version: string | null = null
  let digest: string | null = null
  try {
    version = (JSON.parse(readFileSync(join(root, 'node_modules', 'postgres', 'package.json'), 'utf8')) as { version?: string }).version ?? null
    digest = driverDigest(join(root, 'node_modules', 'postgres'))
  } catch {
    version = version ?? null
  }
  const reasons: string[] = []
  if (version !== ROUTE_B_DRIVER.version) reasons.push(`the route-B driver at the repository root is ${String(version)}, not postgres ${ROUTE_B_DRIVER.version}`)
  if (digest === null) reasons.push('the route-B driver files cannot be digested')
  return { driverRoot: resolvePath(root), version, digest, reasons }
}

/** OC-12: the first certification event in the tree that certifies the channel as currently pinned, if any. */
export function findChannelCertification(root: string, binding: ChannelBinding | null): { event: string | null; facts: ChannelEventFacts | null } {
  const dir = join(root, 'docs/ops/release')
  const events = (existsSync(dir) ? readdirSync(dir) : []).map((n) => `docs/ops/release/${n}`).filter((p) => CERTIFICATION_EVENT_PATTERN.test(p)).sort()
  for (const e of events) {
    const f = gatherChannelEventFacts(root, e)
    if (channelCertificationReasons(f, binding).length === 0) return { event: e, facts: f }
  }
  return { event: null, facts: null }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface PlanInputs {
  readonly mode: ChannelMode
  readonly toolsDir: string
  readonly depositor: string | null
  readonly head: string
  readonly nowUtc: string
  /** Test seams: the OEP-1 evidence facts and the channel certification facts (default: gathered from the repository). */
  readonly oep1Facts?: Oep1EvidenceFacts
  readonly channelCertification?: ChannelEventFacts | null
}

/** Derive the plan from the repository. Reasons non-empty -> STOP (the plan is not usable). */
export function derivePlan(root: string, i: PlanInputs): { plan: ChannelPlan | null; reasons: string[] } {
  const reasons: string[] = []
  const { binding, reasons: br } = readChannelBinding(root)
  reasons.push(...br)
  const { host, reasons: hr } = deriveTargetHost(root)
  reasons.push(...hr)
  const drv = routeBDriver(root)
  reasons.push(...drv.reasons)
  const sched = deriveEffectiveSchedule(root)
  reasons.push(...sched.errors.map((e) => `schedule: ${e}`))
  let principal: string | null = null
  let validUntil: string | null = null
  if (i.mode === 'probe') {
    const cert = i.channelCertification !== undefined ? i.channelCertification : findChannelCertification(root, binding).facts
    reasons.push(...channelCertificationReasons(cert, binding).map((x) => `OC-12: ${x}`))
  } else {
    // OT-7 / RB-DELTA-2: VALID UNTIL is the effective N09 (N08 + 24 h), never N08.
    validUntil = sched.N09
    if (validUntil === null) reasons.push('the effective schedule has no N09')
    const ef = i.oep1Facts ?? gatherOep1EvidenceFacts(root)
    const er = oep1EvidenceReasons(ef, { binding, targetHost: host, n08: sched.N08, driverDigest: drv.digest, ...routeBTransportFacts() })
    reasons.push(...er.map((x) => `OEP-1: ${x}`))
    principal = er.length === 0 ? String(ef.evidence!.operator_principal) : null
    if (i.depositor === null) reasons.push('the mint needs the built N30 depositor')
  }
  if (binding === null || host === null || drv.version === null || drv.digest === null || reasons.length > 0) return { plan: null, reasons }
  const plan: ChannelPlan = {
    schema: PLAN_SCHEMA,
    mode: i.mode,
    targetHost: host,
    targetPort: ROUTE_B_PORT,
    targetDatabase: ROUTE_B_DATABASE,
    operatorPrincipal: principal,
    validUntil,
    driverRoot: drv.driverRoot,
    driverVersion: drv.version,
    driverDigest: drv.digest,
    depositor: i.mode === 'mint' ? i.depositor : null,
    tool: { path: join(i.toolsDir, binding.tools[i.mode].file), sha256: binding.tools[i.mode].sha256 },
    launcherDigest: binding.launcher_build_digest,
    derivedAtHead: i.head,
    derivedAtUtc: i.nowUtc,
  }
  return { plan, reasons }
}

/** Field-by-field comparison of a plan on disk with the derived one. derivedAtUtc is the only field allowed to differ. */
export function verifyPlan(onDisk: ChannelPlan, derived: ChannelPlan): string[] {
  const r: string[] = []
  const fields: Array<[string, unknown, unknown]> = [
    ['schema', onDisk.schema, derived.schema],
    ['mode', onDisk.mode, derived.mode],
    ['targetHost', onDisk.targetHost, derived.targetHost],
    ['targetPort', onDisk.targetPort, derived.targetPort],
    ['targetDatabase', onDisk.targetDatabase, derived.targetDatabase],
    ['operatorPrincipal', onDisk.operatorPrincipal, derived.operatorPrincipal],
    ['validUntil', onDisk.validUntil, derived.validUntil],
    ['driverRoot', onDisk.driverRoot, derived.driverRoot],
    ['driverVersion', onDisk.driverVersion, derived.driverVersion],
    ['driverDigest', onDisk.driverDigest, derived.driverDigest],
    ['depositor', onDisk.depositor, derived.depositor],
    ['tool.path', onDisk.tool?.path, derived.tool.path],
    ['tool.sha256', onDisk.tool?.sha256, derived.tool.sha256],
    ['launcherDigest', onDisk.launcherDigest, derived.launcherDigest],
    ['derivedAtHead', onDisk.derivedAtHead, derived.derivedAtHead],
  ]
  for (const [name, a, b] of fields) if (a !== b) r.push(`STOP_PLAN_MISMATCH: ${name} on disk differs from the repository derivation`)
  return r
}

/** What will run, against the pins: each tool file's bytes, and the launcher build lying in the channel dir. */
export function checkExecutables(p: { readonly plan: ChannelPlan; readonly launcherDiskDigest: string; readonly readFile: (path: string) => Buffer }): string[] {
  const r: string[] = []
  let tool: Buffer | null = null
  try {
    tool = p.readFile(p.plan.tool.path)
  } catch {
    r.push('STOP_TOOL_MISSING: the pinned tool file cannot be read')
  }
  if (tool !== null && sha256(tool) !== p.plan.tool.sha256) r.push('STOP_STALE_TOOL_HASH: the tool file on disk is not the pinned bytes')
  if (p.launcherDiskDigest !== p.plan.launcherDigest) r.push('STOP_STALE_LAUNCHER_HASH: the launcher build on disk is not the pinned build')
  return r
}

export function checkUtcMargin(nowUtc: string, n08: string | null): { reasons: string[]; marginMs: number | null } {
  if (n08 === null) return { reasons: ['no effective N08'], marginMs: null }
  const m = Date.parse(n08) - Date.parse(nowUtc)
  return { reasons: m > 0 ? [] : ['STOP_SCHEDULE_ELAPSED: the UTC clock is at or past N08'], marginMs: m }
}

/** The gate's own STOPs, independent of the plan (pure, so each is testable). */
export function preExecutionStops(p: { readonly clean: boolean; readonly launcherBuiltDigest: string; readonly pinnedLauncherDigest: string | null; readonly nowUtc: string; readonly n08: string | null }): string[] {
  const r: string[] = []
  if (!p.clean) r.push('STOP_DIRTY: the worktree carries changes; the plan must be derived from a committed state')
  if (p.pinnedLauncherDigest === null || p.launcherBuiltDigest !== p.pinnedLauncherDigest) r.push('STOP_STALE_LAUNCHER_HASH: the launcher built from this repository is not the pinned build')
  r.push(...checkUtcMargin(p.nowUtc, p.n08).reasons)
  return r
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv: readonly string[]): number {
  const get = (k: string): string | undefined => argv.find((a) => a.startsWith(k))?.slice(k.length)
  const mode = get('--mode=') as ChannelMode | undefined
  const channelDir = get('--channel-dir=')
  const write = argv.includes('--write')
  const root = process.cwd()
  const out = (o: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(o, null, 2)}\n`)
  if ((mode !== 'probe' && mode !== 'mint') || channelDir === undefined) {
    out({ gate: 'STOP', reasons: ['usage: --mode=probe|mint --channel-dir=<outside the repository> [--tools-dir=<dir>] [--write]'] })
    return 2
  }
  if (isInsideRepositoryTree(root, resolvePath(channelDir))) {
    out({ gate: 'STOP', reasons: ['the channel dir must be outside the repository'] })
    return 2
  }
  const { binding } = readChannelBinding(root)
  const toolsDir = get('--tools-dir=') ?? (binding === null ? null : defaultToolsDir(binding))
  if (toolsDir === null) {
    out({ gate: 'STOP', reasons: ['no tools dir'] })
    return 2
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const clean = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim() === ''
  const nowUtc = new Date().toISOString()
  const build = buildLauncherClosure(root)
  const launcherEntry = writeLauncherBuild(root, channelDir, build)
  const launcherDiskDigest = digestOfWrittenLauncher(channelDir, build).digest
  const depositor = mode === 'mint' ? buildProductionEntryPoints(root, channelDir).deposit : null
  const { plan, reasons } = derivePlan(root, { mode, toolsDir, depositor, head, nowUtc })
  const sched = deriveEffectiveSchedule(root)
  reasons.push(...preExecutionStops({ clean, launcherBuiltDigest: build.digest, pinnedLauncherDigest: binding?.launcher_build_digest ?? null, nowUtc, n08: sched.N08 }))
  const planPath = join(resolvePath(channelDir), `plan-${mode}.json`)
  if (plan !== null) {
    reasons.push(...checkExecutables({ plan, launcherDiskDigest, readFile: (p) => readFileSync(p) }))
    if (write && reasons.length === 0) writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`)
    else if (!write) {
      if (!existsSync(planPath)) reasons.push('STOP_NO_PLAN: no plan on disk to verify (run with --write first)')
      else {
        try {
          reasons.push(...verifyPlan(JSON.parse(readFileSync(planPath, 'utf8')) as ChannelPlan, plan))
        } catch {
          reasons.push('STOP_PLAN_INVALID: the plan on disk is not JSON')
        }
      }
    }
  }
  const utc = checkUtcMargin(nowUtc, sched.N08)
  const pass = reasons.length === 0
  out({
    gate: pass ? 'PASS' : 'STOP',
    mode,
    head,
    nowUtc,
    n08: sched.N08,
    marginHours: utc.marginMs === null ? null : Math.round(utc.marginMs / 36_000) / 100,
    plan: pass ? planPath : null,
    command: pass ? `node "${launcherEntry}" --plan="${planPath}"` : null,
    reasons,
  })
  return pass ? 0 : 1
}

if (/d1-mint-operator-plan\.(ts|js)$/.test(process.argv[1] ?? '')) process.exitCode = main(process.argv.slice(2))
