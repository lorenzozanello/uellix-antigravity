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
//                     by evaluateN04 exactly as PRE-HC1 does; NOT_SATISFIED -> STOP)
//   validUntil        the effective N09 (mint only)
//   driverRoot        route B: the repository root, from which createRequire
//                     resolves `postgres`; its package version must be 3.4.9
//   depositor         the built N30 depositor (mint only), built into the channel dir
//   tool              the pinned tool file for the mode (CHANNEL_BINDING)
//   launcherDigest    the pinned launcher build digest (CHANNEL_BINDING)
//   operatorPrincipal the principal the certified OEP-1 evidence observed (mint only)
//
// Then it checks what will actually run: the launcher build written to the
// channel dir hashes to the pin, each tool file hashes to its pin, and the UTC
// clock is before N08 (the PRE-HC1 evaluator does not read the clock; NB-3).
// With --write it writes the plan; without it, it compares the plan already on
// disk field by field. ANY difference is STOP. It connects to nothing.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { ROUTE_B_DRIVER, type ChannelMode } from '../../db/custody/mint-operator-channel'
import { defaultToolsDir, gatherOep1EvidenceFacts, oep1EvidenceReasons, readChannelBinding, sha256Hex as sha256 } from './d1-mint-operator-evidence'
import { isInsideRepositoryTree } from './build-sentinel-consumer'
import { buildProductionEntryPoints } from './build-production-entrypoints'
import { buildLauncherClosure, digestOfWrittenLauncher, writeLauncherBuild } from './d1-mint-operator-channel-build'
import { deriveEffectiveSchedule } from './d1-effective-schedule'
import { evaluateN04 } from './d1-pre-hc1'
import { PLAN_SCHEMA, type ChannelPlan } from './d1-mint-operator-launcher'
import { AUDITOR_DATABASE_ROLE } from '../../db/safety/database-role'

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

export function routeBDriver(root: string): { driverRoot: string; version: string | null; reasons: string[] } {
  let version: string | null = null
  try {
    version = (JSON.parse(readFileSync(join(root, 'node_modules', 'postgres', 'package.json'), 'utf8')) as { version?: string }).version ?? null
  } catch {
    version = null
  }
  return { driverRoot: resolvePath(root), version, reasons: version === ROUTE_B_DRIVER.version ? [] : [`the route-B driver at the repository root is ${String(version)}, not postgres ${ROUTE_B_DRIVER.version}`] }
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
  if (i.mode === 'mint') {
    validUntil = sched.N09
    if (validUntil === null) reasons.push('the effective schedule has no N09')
    const ef = gatherOep1EvidenceFacts(root)
    const er = oep1EvidenceReasons(ef, { binding, targetHost: host, n08: sched.N08 })
    reasons.push(...er.map((x) => `OEP-1: ${x}`))
    principal = er.length === 0 ? String(ef.evidence!.operator_principal) : null
    if (i.depositor === null) reasons.push('the mint needs the built N30 depositor')
  }
  if (binding === null || host === null || drv.version === null || reasons.length > 0) return { plan: null, reasons }
  const plan: ChannelPlan = {
    schema: PLAN_SCHEMA,
    mode: i.mode,
    targetHost: host,
    operatorPrincipal: principal,
    validUntil,
    driverRoot: drv.driverRoot,
    driverVersion: drv.version,
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
    ['operatorPrincipal', onDisk.operatorPrincipal, derived.operatorPrincipal],
    ['validUntil', onDisk.validUntil, derived.validUntil],
    ['driverRoot', onDisk.driverRoot, derived.driverRoot],
    ['driverVersion', onDisk.driverVersion, derived.driverVersion],
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
  if (!clean) reasons.push('STOP_DIRTY: the worktree carries changes; the plan must be derived from a committed state')
  if (build.digest !== binding?.launcher_build_digest) reasons.push('STOP_STALE_LAUNCHER_HASH: the launcher built from this repository is not the pinned build')
  const sched = deriveEffectiveSchedule(root)
  const utc = checkUtcMargin(nowUtc, sched.N08)
  reasons.push(...utc.reasons)
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
