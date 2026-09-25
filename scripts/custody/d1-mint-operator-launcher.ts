// scripts/custody/d1-mint-operator-launcher.ts
//
// THE OPERATOR LAUNCHER (AC-4, OPTION_A). Built to plain CommonJS OUTSIDE the
// repository (scripts/custody/d1-mint-operator-channel-build.ts), pinned by the
// digest of that build, and run by the owner, from his own console, ONLY through the pre-node boundary
// (db/custody/pre-node-boundary.ts), which starts node with no flags and an
// allowlisted environment after refusing every Node runtime/trust variable:
//
//   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <channel-dir>\d1-pre-node-boundary.ps1 -Plan <channel-dir>\plan-<mode>.json
//
// It does ONE thing: take the operator's connection string from the console
// without echo and hand it to ONE pinned tool (the OEP-1 probe tool or the
// route-B mint tool) in that tool's environment block and nowhere else. The
// plan it reads is non-secret and is re-derived from the repository by the
// pre-execution gate (d1-mint-operator-plan.ts) immediately before the run.
//
// It never connects to anything, never generates a credential, never writes a
// file, and never writes its own process.env.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isProcessAttachedToConsole } from '../../db/custody/wcm-credential-store'
import { launchedThroughBoundaryReasons } from '../../db/custody/pre-node-boundary'
import { classifyToolRun } from '../../db/custody/mint-route-b-contract'
import {
  OPERATOR_ENV_VAR_NAME,
  OperatorChannelError,
  TOOL_SPAWN_FLAGS,
  acceptsPipedInput,
  assertToolArgvIsClean,
  buildToolEnvironment,
  checkOperatorUrlAgainstPlan,
  inspectOperatorUrl,
  readHiddenLine,
  readPipedLine,
  type ChannelMode,
  type HiddenInput,
} from '../../db/custody/mint-operator-channel'

export const PLAN_SCHEMA = 'D1_MINT_OPERATOR_CHANNEL_PLAN_v1'

/** The non-secret plan. Every field is re-derived from the repository by the pre-execution gate. */
export interface ChannelPlan {
  readonly schema: typeof PLAN_SCHEMA
  readonly mode: ChannelMode
  /** N04's authorized direct host. */
  readonly targetHost: string
  /** The route-B session's port and database (OC-11). */
  readonly targetPort: number
  readonly targetDatabase: string
  /** Mint only: the principal the certified OEP-1 evidence observed. Null for the probe. */
  readonly operatorPrincipal: string | null
  /** Mint only: the effective N09. */
  readonly validUntil: string | null
  /** Route B: the root createRequire resolves `postgres` from, and the version found there. */
  readonly driverRoot: string
  readonly driverVersion: string
  /** OT-17: sha256 over the driver package's files, re-derived by the gate from the repository. */
  readonly driverDigest: string
  /** AC-8 / OC-13: the pinned project certificate (absolute path) and the sha256 of its bytes. */
  readonly caFile: string
  readonly caSha256: string
  /** R4 / OC-15: the node binary the pre-node boundary may start (sha256 checked before it starts). */
  readonly nodeExecutable: { readonly path: string; readonly sha256: string }
  /** R4 / OC-15: the sha256 of the pinned pre-node boundary script; the launcher refuses without its mark. */
  readonly preNodeBoundarySha256: string
  /** Mint only: the built N30 depositor. */
  readonly depositor: string | null
  readonly tool: { readonly path: string; readonly sha256: string }
  readonly launcherDigest: string
  readonly derivedAtHead: string
  readonly derivedAtUtc: string
}

/** Strict shape check; anything else is refused before the plan is used. */
export function parsePlan(text: string): ChannelPlan {
  let p: Record<string, unknown>
  try {
    p = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new OperatorChannelError('CHANNEL_PLAN_INVALID', 'The plan is not JSON.')
  }
  const str = (k: string): boolean => typeof p[k] === 'string' && (p[k] as string) !== ''
  const hex = (v: unknown, n: number): boolean => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v)
  const tool = p.tool as Record<string, unknown> | undefined
  const ok =
    p.schema === PLAN_SCHEMA &&
    (p.mode === 'probe' || p.mode === 'mint') &&
    str('targetHost') &&
    typeof p.targetPort === 'number' &&
    str('targetDatabase') &&
    hex(p.driverDigest, 64) &&
    str('caFile') &&
    hex(p.caSha256, 64) &&
    typeof (p.nodeExecutable as Record<string, unknown> | undefined)?.path === 'string' &&
    hex((p.nodeExecutable as Record<string, unknown> | undefined)?.sha256, 64) &&
    hex(p.preNodeBoundarySha256, 64) &&
    str('driverRoot') &&
    str('driverVersion') &&
    typeof tool?.path === 'string' &&
    hex(tool?.sha256, 64) &&
    hex(p.launcherDigest, 64) &&
    hex(p.derivedAtHead, 40) &&
    str('derivedAtUtc') &&
    (p.mode === 'probe'
      ? p.operatorPrincipal === null && p.validUntil === null && p.depositor === null
      : str('operatorPrincipal') && str('validUntil') && str('depositor'))
  if (!ok) throw new OperatorChannelError('CHANNEL_PLAN_INVALID', 'The plan does not have the expected shape for its mode.')
  return p as unknown as ChannelPlan
}

/** The tool's argv, from the plan only. Non-secret by construction; re-checked against the value before spawn. */
export function toolArgs(plan: ChannelPlan): string[] {
  const common = [
    `--driver-root=${plan.driverRoot}`,
    `--driver-digest=${plan.driverDigest}`,
    `--target-host=${plan.targetHost}`,
    `--target-port=${plan.targetPort}`,
    `--target-database=${plan.targetDatabase}`,
    `--ca-file=${plan.caFile}`,
    `--ca-sha256=${plan.caSha256}`,
  ]
  if (plan.mode === 'probe') return [plan.tool.path, ...common]
  return [plan.tool.path, ...common, `--depositor=${plan.depositor!}`, `--valid-until=${plan.validUntil!}`, `--operator-principal=${plan.operatorPrincipal!}`]
}

export interface LauncherIo {
  readonly stdin: HiddenInput & NodeJS.ReadableStream
  readonly stdout: { write(s: string): unknown }
  readonly stderr: { write(s: string): unknown }
  /** The launcher's own environment, read only. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly readFile: (path: string) => Buffer
  readonly isAttachedToConsole: () => Promise<boolean>
  readonly spawn: typeof spawn
  readonly execPath: string
  /** The runtime flags node was started with (the boundary starts it with none). */
  readonly execArgv: readonly string[]
}

export const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

const line = (io: LauncherIo, o: Record<string, unknown>): void => {
  io.stdout.write(`${JSON.stringify(o)}\n`)
}

/** OC-13, measurable on its own (PMR-16): the planned CA file exists and is the pinned bytes. Throws otherwise. */
export function checkPlannedCa(plan: Pick<ChannelPlan, 'caFile' | 'caSha256'>, readFile: (path: string) => Buffer): void {
  let caBytes: Buffer
  try {
    caBytes = readFile(plan.caFile)
  } catch {
    throw new OperatorChannelError('CHANNEL_CA_MISSING', 'The pinned CA file cannot be read. Nothing was asked.')
  }
  if (sha256Hex(caBytes) !== plan.caSha256) throw new OperatorChannelError('CHANNEL_CA_MISMATCH', 'The CA file is not the pinned project certificate (sha256 differs). Nothing was asked.')
}

export async function runLauncher(argv: readonly string[], io: LauncherIo): Promise<number> {
  if (argv.length !== 1 || !argv[0]!.startsWith('--plan=')) throw new OperatorChannelError('CHANNEL_ARGUMENTS', 'The launcher accepts exactly one argument: --plan=<file>.')
  // OC-5: an ambient value would make a success prove nothing about this channel.
  if (io.env[OPERATOR_ENV_VAR_NAME] !== undefined) {
    throw new OperatorChannelError('CHANNEL_AMBIENT_VALUE', `${OPERATOR_ENV_VAR_NAME} is already set in the launcher's own environment. Refusing.`)
  }
  const plan = parsePlan(io.readFile(argv[0]!.slice('--plan='.length)).toString('utf8'))
  // OC-15 (defence in depth, NOT the boundary): refuse a direct start. A preload that ran before this
  // line is excluded only by the pre-node boundary, which never lets such a node start.
  const boundary = launchedThroughBoundaryReasons(io.env, io.execArgv, plan.preNodeBoundarySha256)
  if (boundary.length > 0) throw new OperatorChannelError('CHANNEL_NO_PRE_NODE_BOUNDARY', `${boundary.join('; ')}. Start the channel only through the pre-node boundary. Nothing was asked.`)
  // OC-8: the tool is the pinned file, checked before anything is asked.
  let toolBytes: Buffer
  try {
    toolBytes = io.readFile(plan.tool.path)
  } catch {
    throw new OperatorChannelError('CHANNEL_TOOL_MISSING', 'The planned tool file cannot be read.')
  }
  if (sha256Hex(toolBytes) !== plan.tool.sha256) throw new OperatorChannelError('CHANNEL_TOOL_HASH_MISMATCH', 'The tool file is not the pinned one (sha256 differs). Nothing was asked.')
  // OC-13: the one trust anchor the tool will use is the pinned project certificate, checked before anything is asked, in every mode.
  checkPlannedCa(plan, io.readFile)
  // OC-1: without a console of its own, the tool would be given a fresh conhost that inherits its environment block.
  if (!(await io.isAttachedToConsole())) {
    throw new OperatorChannelError('CHANNEL_NO_CONSOLE', 'The launcher is not attached to a console. Run it from the owner console.')
  }
  line(io, { launcher: 'READY', mode: plan.mode, targetHost: plan.targetHost, toolSha256: plan.tool.sha256, launcherDigest: plan.launcherDigest })

  // OC-2 / OC-3
  let secret: Buffer
  if (io.stdin.isTTY === true) secret = await readHiddenLine(io.stdin, io.stderr)
  else if (acceptsPipedInput(plan.targetHost)) secret = await readPipedLine(io.stdin)
  else throw new OperatorChannelError('CHANNEL_NO_CONSOLE_INPUT', 'Standard input is not a console, and piped input is accepted only for a synthetic .invalid target.')

  let child: ReturnType<typeof spawn>
  let passwordRaw: Buffer | null = null
  try {
    const facts = inspectOperatorUrl(secret)
    passwordRaw = facts.passwordRaw
    checkOperatorUrlAgainstPlan(facts, plan) // OC-4
    const args = toolArgs(plan)
    assertToolArgvIsClean(args, secret, facts.passwordRaw) // OC-6
    child = io.spawn(io.execPath, args, { env: buildToolEnvironment(io.env, secret) as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], ...TOOL_SPAWN_FLAGS }) // OC-6 / OC-7
  } finally {
    // OC-9: the Buffers are zeroed on every path; the one environment string spawn required is not zeroable (disclosed).
    secret.fill(0)
    passwordRaw?.fill(0)
  }
  line(io, { launcher: 'TOOL_SPAWNED', pid: child.pid ?? null })

  let stdout = ''
  let stderrBytes = 0
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (c: string) => {
    stdout += c
    io.stdout.write(c)
  })
  child.stderr!.on('data', (c: Buffer) => {
    // Relayed as a count only: the tool's contract keeps its stderr secret-free, and the launcher does not widen the exposure if it failed to.
    stderrBytes += c.length
  })
  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('error', () => resolve({ code: null, signal: null }))
    child.on('close', (c, s) => resolve({ code: c, signal: s }))
  })
  const tail: Record<string, unknown> = { launcher: 'TOOL_EXITED', exitCode: code, signal, stderrBytes }
  if (plan.mode === 'mint') tail.mint = classifyToolRun(stdout).outcome
  line(io, tail)
  return code ?? 1
}

if (/d1-mint-operator-launcher\.(ts|js)$/.test(process.argv[1] ?? '')) {
  const io: LauncherIo = {
    stdin: process.stdin as unknown as HiddenInput & NodeJS.ReadableStream,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    readFile: (p) => readFileSync(p),
    isAttachedToConsole: () => isProcessAttachedToConsole(process.pid),
    spawn,
    execPath: process.execPath,
    execArgv: process.execArgv,
  }
  runLauncher(process.argv.slice(2), io)
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      process.stdout.write(`${JSON.stringify({ launcher: 'REFUSED_OR_FAILED', code: (e as { code?: string }).code ?? 'CHANNEL_FAILED' })}\n`)
      process.exitCode = 3
    })
}
