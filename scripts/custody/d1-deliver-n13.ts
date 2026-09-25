// scripts/custody/d1-deliver-n13.ts
//
// THE PRODUCTION LAUNCHER: N05's delivery path, pointed at ONE in-DAG consumer.
//
// The file keeps its first name because the post-mint path record cites it; it
// now launches any of the three BUILT in-DAG consumers (N13, N14, N22 — and
// N22's consumer with --node=N21 for the conditional MR-3 poststate). Each run
// is ONE delivery to ONE consuming process.
//
// Built to plain CommonJS and run under BARE node, FROM A CONSOLE. It reads
// the D-1 auditor custody entry, and runs exactly ONE consumer with the value
// in that consumer's environment block and nowhere else, then zeroes its own
// buffer. Every separately delivered consumer (N13, N14, N22, the PRECHECK,
// the FINAL WITNESS) is a separate run of this launcher: the value is never
// left set between two of them.
//
//   node <out>/scripts/custody/d1-deliver-n13.js --consumer=<built consumer .js> --mode=dry-run
//
// Arguments are non-secret: the consumer path, the consumer mode, and for the
// synthetic topology demonstration only, a target inside the sentinel
// namespace. The production target is derived, never passed.

import { SWEEPABLE_TARGET_PREFIXES } from '../../db/custody/wcm-credential-store'
import { runWithDeliveredSecret } from '../../db/custody/process-delivery'
import { d1AuditorWcmTarget } from '../../db/custody/production-custody'

export const AUDITOR_ENV_VAR_NAME = 'UELLIX_AUDITOR_DATABASE_URL'

const CONSUMER_MODES = ['dry-run', 'dry-run-fail', 'execute'] as const

/** The only consumers this launcher delivers to: the BUILT in-DAG ones. */
export const CONSUMER_ENTRY = /d1-auditor-n(?:13|14|22)-consumer\.js$/
type ConsumerMode = (typeof CONSUMER_MODES)[number]

export interface LauncherArgs {
  readonly target: string
  readonly consumer: string
  readonly node: 'N21' | 'N22' | null
  readonly mode: ConsumerMode
  readonly driverRoot: string | null
  readonly dwellMs: number
  readonly timeoutMs: number | undefined
}

/** Pure, so the refusals are testable. Throws on anything it does not recognise. */
export function parseLauncherArgs(argv: readonly string[]): LauncherArgs {
  const known = ['--consumer=', '--mode=', '--driver-root=', '--dwell-ms=', '--timeout-ms=', '--synthetic-target=', '--node=']
  for (const a of argv) {
    if (!known.some((k) => a.startsWith(k))) throw new Error(`Unrecognised argument (not echoed). Accepted: ${known.join(' ')}`)
  }
  const get = (k: string): string | undefined => argv.find((a) => a.startsWith(k))?.slice(k.length)
  const consumer = get('--consumer=')
  if (consumer === undefined || !CONSUMER_ENTRY.test(consumer)) {
    throw new Error('--consumer must name a BUILT in-DAG consumer (.js); a TypeScript entry would run under a development runtime whose helper inherits the value.')
  }
  const nodeFlag = get('--node=')
  if (nodeFlag !== undefined && (!/d1-auditor-n22-consumer\.js$/.test(consumer) || (nodeFlag !== 'N21' && nodeFlag !== 'N22'))) {
    throw new Error('--node is accepted only as N21 or N22, and only for the N22 consumer.')
  }
  const mode = get('--mode=') as ConsumerMode | undefined
  if (mode === undefined || !CONSUMER_MODES.includes(mode)) throw new Error('--mode must be dry-run, dry-run-fail or execute.')
  const synthetic = get('--synthetic-target=')
  if (synthetic !== undefined && !SWEEPABLE_TARGET_PREFIXES.some((p) => synthetic.startsWith(`${p}-`))) {
    throw new Error('--synthetic-target must lie inside the sentinel namespace.')
  }
  if (synthetic !== undefined && mode === 'execute') {
    throw new Error('A synthetic target is never delivered to a consumer in execute mode.')
  }
  const driverRoot = get('--driver-root=') ?? null
  if (mode === 'execute' && driverRoot === null) throw new Error('--mode=execute requires --driver-root.')
  const timeout = get('--timeout-ms=')
  return {
    target: synthetic ?? d1AuditorWcmTarget(),
    consumer,
    node: (nodeFlag as 'N21' | 'N22' | undefined) ?? null,
    mode,
    driverRoot,
    dwellMs: Math.min(Math.max(Number(get('--dwell-ms=') ?? '0') || 0, 0), 30_000),
    timeoutMs: timeout === undefined ? undefined : Math.max(Number(timeout) || 0, 1),
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseLauncherArgs(argv)
  const consumerArgs = [args.consumer, `--mode=${args.mode}`]
  if (args.node !== null) consumerArgs.push(`--node=${args.node}`)
  if (args.mode === 'execute' && args.driverRoot !== null) consumerArgs.push(`--driver-root=${args.driverRoot}`)
  if (args.mode !== 'execute' && args.dwellMs > 0) consumerArgs.push(`--dwell-ms=${args.dwellMs}`)

  const result = await runWithDeliveredSecret({
    target: args.target,
    envVarName: AUDITOR_ENV_VAR_NAME,
    command: process.execPath,
    args: consumerArgs,
    timeoutMs: args.timeoutMs,
    onSpawn: (pid) => process.stdout.write(`${JSON.stringify({ launcher: 'CONSUMER_SPAWNED', pid: pid ?? null })}\n`),
  })
  // The consumer's line is secret-free by construction; it is relayed, and the
  // launcher adds only its own exit facts.
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}'
  process.stdout.write(`${line}\n`)
  process.stdout.write(`${JSON.stringify({ launcher: 'CONSUMER_EXITED', exitCode: result.exitCode, signal: result.signal })}\n`)
  return result.exitCode ?? 1
}

if (/d1-deliver-n13\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      process.stdout.write(`${JSON.stringify({ launcher: 'REFUSED_OR_FAILED', code: (e as { code?: string }).code ?? 'LAUNCHER_ARGUMENTS' })}\n`)
      process.exitCode = 3
    })
}
