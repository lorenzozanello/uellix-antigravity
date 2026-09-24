// scripts/custody/d1-mint-operator-channel-demonstration.ts
//
//   pnpm custody:operator-channel:demonstrate -- --out-dir=<OUTSIDE the repository>
//
// THE OPERATOR CHANNEL, PEB-MEASURED ON A SYNTHETIC VALUE (AC-6: "probar
// ausencia de herencia accidental hacia conhost/depositor mediante el
// mecanismo PEB autorizado"). Windows only; no database, no real credential.
//
// The value is a freshly generated synthetic operator URL naming an RFC 6761
// `.invalid` host, fed to the BUILT, PINNED launcher on a pipe (the synthetic
// path OC-3 allows only for such hosts). The launcher spawns the REAL, PINNED
// outside tools against FAKE drivers (and, for the mint, a fake depositor), so
// nothing can reach a database. The authorized external observer
// (n05-peb-observer.ts) reads every new process's command line and environment
// block from its PEB and reports booleans only.
//
// Controls:
//   OBS0      the observer sees a planted fixture (it is able to see at all)
//   CH-MINT   mint run: the value is in the TOOL's block only — not the
//             launcher's, not the depositor's, not any conhost's — and in no
//             command line; the tool classifies COMMITTED
//   CH-PROBE  probe run: same, the probe prints its observation
//   CH-NOCON  a launcher with NO console at all (DETACHED_PROCESS, the B-1 hazard)
//             refuses (CHANNEL_NO_CONSOLE) before reading anything
//   CH-HIDDEN a launcher with a HIDDEN console (windowsHide:true = CREATE_NO_WINDOW
//             gives it a console without a window) passes OC-1; measured: its tool
//             shares that console and no conhost carries the value
//   MUT-HIDE  a launcher build mutated to windowsHide:true IS caught (a conhost carries the value)
//   MUT-PENV  a launcher build mutated to write its own process.env IS caught
//   FILES     no file under the demonstration directory carries the value
//   HISTORY   the PSReadLine history file does not carry the value
//   OUTPUT    no launcher or tool output line carries the value
//
// Like every demonstration here it certifies nothing; its strongest word is
// SATISFIED_CANDIDATE.

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { OPERATOR_ENV_VAR_NAME, driverDigest } from '../../db/custody/mint-operator-channel'
import { PebObserver, childrenOf, identityReasons, recordForSpawn, type PebDump, type PebObservedProcess } from './n05-peb-observer'
import { isInsideRepositoryTree } from './build-sentinel-consumer'
import { buildLauncherClosure, writeLauncherBuild } from './d1-mint-operator-channel-build'
import { defaultToolsDir, readChannelBinding, sha256Hex } from './d1-mint-operator-evidence'
import { FAKE_DEPOSITOR, FAKE_DRIVER } from './d1-mint-tool-contract-harness'
import { FAKE_PROBE_DRIVER, writeCannedProbeAnswers } from './d1-oep1-probe-harness'
import { deriveEffectiveSchedule } from './d1-effective-schedule'
import { PLAN_SCHEMA, type ChannelPlan } from './d1-mint-operator-launcher'

type State = 'PASSED' | 'FAILED' | 'NOT_RUN'
interface Run {
  readonly pid: number
  /** The spawn window (ms since the Unix epoch): binds the observed record by (pid, creation time), never by pid alone. */
  readonly startedMs: number
  readonly endedMs: number
  readonly lines: Record<string, unknown>[]
  readonly raw: string
  readonly exitCode: number | null
}

function startNode(entry: string, args: string[], opts: { stdin?: string; console?: 'shared' | 'none' | 'hidden'; cwd: string }): Promise<Run> {
  return new Promise((resolve) => {
    const startedMs = Date.now()
    // 'none' = DETACHED_PROCESS (no console at all); 'hidden' = CREATE_NO_WINDOW (a console without a window).
    const child = spawn(process.execPath, [entry, ...args], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: opts.console === 'hidden', detached: opts.console === 'none' })
    let raw = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      raw += c
    })
    child.stderr.on('data', (c: Buffer) => {
      raw += c.toString('utf8')
    })
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin)
    else child.stdin.end()
    child.on('close', (code) => {
      const lines: Record<string, unknown>[] = []
      for (const l of raw.split(/\r?\n/)) {
        try {
          lines.push(JSON.parse(l) as Record<string, unknown>)
        } catch {
          /* not JSON */
        }
      }
      resolve({ pid: child.pid ?? -1, startedMs, endedMs: Date.now(), lines, raw, exitCode: code })
    })
  })
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...filesUnder(p))
    else out.push(p)
  }
  return out
}

export async function demonstrate(root: string, outDir: string): Promise<{ overall: string; record: Record<string, unknown> }> {
  if (process.platform !== 'win32') throw new Error('The PEB demonstration runs on Windows only.')
  const out = resolvePath(outDir)
  if (isInsideRepositoryTree(root, out)) throw new Error('--out-dir must be outside the repository.')
  mkdirSync(out, { recursive: true })
  const c: Record<string, State> = {}
  const pf = (b: boolean): State => (b ? 'PASSED' : 'FAILED')

  // --- the channel as pinned ---------------------------------------------------
  const { binding, reasons } = readChannelBinding(root)
  if (binding === null || reasons.length > 0) throw new Error(`CHANNEL_BINDING unusable: ${reasons.join('; ')}`)
  const toolsDir = defaultToolsDir(binding)!
  const mintTool = join(toolsDir, binding.tools.mint.file)
  const probeTool = join(toolsDir, binding.tools.probe.file)
  c.PINS_TOOLS_MATCH = pf(sha256Hex(readFileSync(mintTool)) === binding.tools.mint.sha256 && sha256Hex(readFileSync(probeTool)) === binding.tools.probe.sha256)
  const build = buildLauncherClosure(root)
  c.PINS_LAUNCHER_MATCH = pf(build.digest === binding.launcher_build_digest)
  const launcher = writeLauncherBuild(root, out, build)

  // --- synthetic value, fixtures, fake roots ------------------------------------
  const host = 'db.operator-channel-demo.invalid'
  const password = `synthetic-${randomBytes(12).toString('hex')}`
  const url = ['postgresql:', '//postgres:', password, '@', host, ':5432/postgres'].join('')
  const governed = [Buffer.from(url, 'latin1'), Buffer.from(password, 'latin1')]
  const fixtureRaw = Buffer.from(`d1-channel-fixture-${randomBytes(12).toString('hex')}`, 'latin1')
  // Each run gets its OWN driver root: the fake drivers record what they were
  // handed inside their package directory, which changes the driver digest
  // (OT-17), so a root reused after its first run is refused as unpinned.
  const depositor = join(out, 'depositor', 'fake-n30-deposit.js')
  mkdirSync(join(out, 'depositor'), { recursive: true })
  writeFileSync(depositor, FAKE_DEPOSITOR)
  const cwd = join(out, 'cwd')
  mkdirSync(cwd, { recursive: true })
  const n09 = deriveEffectiveSchedule(root).N09!
  const base = { schema: PLAN_SCHEMA as typeof PLAN_SCHEMA, targetHost: host, targetPort: 5432, targetDatabase: 'postgres', driverVersion: '3.4.9', launcherDigest: build.digest, derivedAtHead: '0'.repeat(40), derivedAtUtc: new Date().toISOString() }
  const driverRootFor = (tag: string, driverSource: string, extra: (dir: string) => void): { driverRoot: string; driverDigest: string } => {
    const driverRoot = join(out, `driver-root-${tag}`)
    const dir = join(driverRoot, 'node_modules', 'postgres')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(driverRoot, 'package.json'), JSON.stringify({ name: `demo-driver-root-${tag}`, private: true }))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'postgres', main: 'index.js', version: '3.4.9' }))
    writeFileSync(join(dir, 'index.js'), driverSource)
    extra(dir)
    return { driverRoot, driverDigest: driverDigest(dir) }
  }
  const planFile = (tag: string, mode: 'mint' | 'probe'): string => {
    const p: ChannelPlan =
      mode === 'mint'
        ? { ...base, mode, operatorPrincipal: 'postgres', validUntil: n09, ...driverRootFor(tag, FAKE_DRIVER, () => undefined), depositor, tool: { path: mintTool, sha256: binding.tools.mint.sha256 } }
        : {
            ...base,
            mode,
            operatorPrincipal: null,
            validUntil: null,
            ...driverRootFor(tag, FAKE_PROBE_DRIVER, (dir) => {
              writeFileSync(join(dir, 'HOLD'), '1500')
              writeCannedProbeAnswers(dir)
            }),
            depositor: null,
            tool: { path: probeTool, sha256: binding.tools.probe.sha256 },
          }
    const f = join(out, `plan-${tag}.json`)
    writeFileSync(f, JSON.stringify(p))
    return f
  }

  // Mutant launcher builds: the exact failure modes the channel must not have, which the observer MUST catch.
  const mutant = (name: string, file: string, from: string, to: string): string => {
    const dir = join(out, name)
    cpSync(join(out, 'launcher'), join(dir, 'launcher'), { recursive: true })
    const p = join(dir, 'launcher', file)
    const t = readFileSync(p, 'utf8')
    if (t.split(from).length !== 2) throw new Error(`mutant anchor not unique in ${file}`)
    writeFileSync(p, t.replace(from, to))
    return join(dir, 'launcher', 'scripts', 'custody', 'd1-mint-operator-launcher.js')
  }
  const hideMutant = mutant('mutant-windowshide', join('db', 'custody', 'mint-operator-channel.js'), 'windowsHide: false', 'windowsHide: true')
  const penvMutant = mutant('mutant-parent-env', join('scripts', 'custody', 'd1-mint-operator-launcher.js'), 'child = io.spawn(', `process.env.${OPERATOR_ENV_VAR_NAME} = secret.toString('utf8');\n        child = io.spawn(`)

  const observer = await PebObserver.start({
    rootPid: process.pid,
    envVarName: OPERATOR_ENV_VAR_NAME,
    governed,
    fixture: [fixtureRaw],
    classes: ['d1-mint-operator-launcher', 'd1-mint-operator-tool', 'd1-oep1-probe-tool', 'fake-n30-deposit'],
  })
  const runs: Record<string, Run> = {}
  let final: PebDump | null = null
  try {
    // OBS0: a planted fixture the observer must see.
    const fxStarted = Date.now()
    const fx = spawn(process.execPath, ['-e', 'const t=Date.now();while(Date.now()-t<1200){}'], { stdio: 'ignore', windowsHide: false, env: { ...process.env, D1_OBSERVER_FIXTURE: fixtureRaw.toString('latin1') } })
    await new Promise((r) => fx.on('close', r))
    const fixtureWindow = { fromMs: fxStarted, toMs: Date.now() }
    const fixturePid = fx.pid ?? -1

    await observer.mark('mint')
    runs.mint = await startNode(launcher, [`--plan=${planFile('mint', 'mint')}`], { stdin: `${url}\n`, cwd })
    await observer.mark('probe')
    runs.probe = await startNode(launcher, [`--plan=${planFile('probe', 'probe')}`], { stdin: `${url}\n`, cwd })
    await observer.mark('noconsole')
    runs.noConsole = await startNode(launcher, [`--plan=${planFile('noconsole', 'probe')}`], { stdin: `${url}\n`, cwd, console: 'none' })
    await observer.mark('hidden')
    runs.hidden = await startNode(launcher, [`--plan=${planFile('hidden', 'probe')}`], { stdin: `${url}\n`, cwd, console: 'hidden' })
    await observer.mark('mutant_hide')
    runs.mutHide = await startNode(hideMutant, [`--plan=${planFile('mut-hide', 'mint')}`], { stdin: `${url}\n`, cwd })
    await observer.mark('mutant_penv')
    runs.mutPenv = await startNode(penvMutant, [`--plan=${planFile('mut-penv', 'mint')}`], { stdin: `${url}\n`, cwd })
    final = await observer.stop()

    const P = final.processes
    const toolPidOf = (r: Run) => Number(r.lines.find((l) => l.launcher === 'TOOL_SPAWNED')?.pid ?? -1)
    const describeRun = (r: Run) => {
      const tool = toolPidOf(r)
      const window = { fromMs: r.startedMs, toMs: r.endedMs }
      const launcherP = recordForSpawn(P, r.pid, window) ?? undefined
      const toolP = recordForSpawn(P, tool, window) ?? undefined
      const kidsOf = (x: PebObservedProcess | undefined) => (x === undefined ? [] : childrenOf(P, x))
      const toolKids = kidsOf(toolP)
      const inTree = [...new Set([launcherP, toolP, ...kidsOf(launcherP), ...toolKids, ...toolKids.flatMap((k) => kidsOf(k))].filter((x): x is PebObservedProcess => x !== undefined))]
      const conhosts = inTree.filter((p) => /^conhost/i.test(p.name))
      const depositors = toolKids.filter((p) => !/^conhost/i.test(p.name))
      return { tool, launcherP, toolP, depositors, conhosts, inTree }
    }
    const holders = <T extends { govEnv: number; envVar: boolean }>(ps: readonly T[]): T[] => ps.filter((p) => p.govEnv !== 0 || p.envVar)

    c.OBS0_OBSERVER_SEES_FIXTURE = pf((recordForSpawn(P, fixturePid, fixtureWindow)?.fixEnv ?? 0) !== 0)
    c.OBS_IDENTITY_KEYED = pf(identityReasons(final).length === 0)
    for (const [key, r, expectLine] of [
      ['CH_MINT', runs.mint!, (l: Record<string, unknown>) => l.mint === 'COMMITTED'],
      ['CH_PROBE', runs.probe!, (l: Record<string, unknown>) => l.probe === 'OBSERVED'],
      ['CH_HIDDEN', runs.hidden!, (l: Record<string, unknown>) => l.probe === 'OBSERVED'],
    ] as const) {
      const d = describeRun(r)
      c[`${key}_TOOL_SPAWNED_AND_OBSERVED`] = pf(d.tool > 0 && d.toolP !== undefined && d.toolP.envReadable)
      c[`${key}_VALUE_IN_TOOL_BLOCK`] = pf(d.toolP !== undefined && d.toolP.govEnv !== 0 && d.toolP.envVar)
      c[`${key}_LAUNCHER_BLOCK_CLEAN`] = pf(d.launcherP !== undefined && d.launcherP.envReadable && !d.launcherP.envVar && d.launcherP.govEnv === 0)
      c[`${key}_NO_CONHOST_HOLDS_IT`] = pf(holders(d.conhosts).length === 0)
      c[`${key}_ONLY_THE_TOOL_HOLDS_IT`] = pf(holders(d.inTree).length === 1 && holders(d.inTree)[0] === d.toolP)
      if (key === 'CH_MINT') c.CH_MINT_DEPOSITOR_OBSERVED_AND_CLEAN = pf(d.depositors.length >= 1 && d.depositors.every((p) => p.envReadable && !p.envVar && p.govEnv === 0))
      c[`${key}_OUTCOME`] = pf(r.exitCode === 0 && r.lines.some(expectLine))
    }
    c.NP10_NO_VALUE_IN_ANY_COMMAND_LINE = pf(P.every((p) => p.govCmd === 0))
    c.CH_NOCON_REFUSED_NOTHING_SPAWNED = pf(runs.noConsole!.exitCode === 3 && runs.noConsole!.lines.some((l) => l.code === 'CHANNEL_NO_CONSOLE') && toolPidOf(runs.noConsole!) === -1)
    const hide = describeRun(runs.mutHide!)
    c.MUT_HIDE_CAUGHT_CONHOST_HOLDS_VALUE = pf(holders(hide.conhosts).length > 0)
    const penv = describeRun(runs.mutPenv!)
    c.MUT_PENV_CAUGHT_LAUNCHER_HOLDS_VALUE = pf(penv.launcherP !== undefined && (penv.launcherP.govEnv !== 0 || penv.launcherP.envVar))

    const needles = [url, password]
    const leaks = (t: string) => needles.some((n) => t.includes(n))
    c.OUTPUT_CLEAN = pf([runs.mint!, runs.probe!, runs.noConsole!, runs.hidden!].every((r) => !leaks(r.raw)))
    const scanned = filesUnder(out).filter((f) => !f.includes(`${join(out, 'mutant-')}`))
    c.FILES_CLEAN = pf(scanned.length > 0 && scanned.every((f) => !leaks(readFileSync(f, 'latin1'))))
    const history = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt')
    c.HISTORY_CLEAN = pf(!existsSync(history) || !leaks(readFileSync(history, 'utf8')))

    const failed = Object.entries(c).filter(([, s]) => s !== 'PASSED').map(([k]) => k)
    const overall = failed.length === 0 ? 'SATISFIED_CANDIDATE' : 'NOT_SATISFIED'
    const record = {
      demonstration: 'D1_MINT_OPERATOR_CHANNEL_PEB_SYNTHETIC',
      value: 'freshly generated synthetic operator URL, RFC 6761 .invalid host; fake drivers; no database socket',
      launcher_build_digest: build.digest,
      tool_sha256: { mint: binding.tools.mint.sha256, probe: binding.tools.probe.sha256 },
      topology: 'demonstration -> built launcher (console, bare node, piped synthetic input) -> pinned outside tool (bare node) [-> fake depositor for the mint]',
      observer: { polls: final.polls, processes_observed: P.length },
      controls: c,
      // Exit codes and closed-vocabulary codes only (OUTPUT_CLEAN already shows no value is in them).
      run_outcomes: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { exit: r.exitCode, codes: r.lines.map((l) => String(l.code ?? l.launcher ?? l.probe ?? l.mint ?? l.error ?? l.refused ?? Object.keys(l).join('+'))) }])),
      failed,
      history_file_present: existsSync(history),
      overall,
    }
    return { overall, record }
  } finally {
    if (final === null) {
      try {
        await observer.stop()
      } catch {
        /* already stopped */
      }
    }
  }
}

if (/d1-mint-operator-channel-demonstration\.(ts|js)$/.test(process.argv[1] ?? '')) {
  const outDir = process.argv.slice(2).find((a) => a.startsWith('--out-dir='))?.slice('--out-dir='.length)
  if (outDir === undefined) {
    process.stdout.write('usage: --out-dir=<outside the repository>\n')
    process.exitCode = 2
  } else {
    demonstrate(process.cwd(), outDir).then(
      ({ overall, record }) => {
        const text = `${JSON.stringify(record, null, 2)}\n`
        writeFileSync(join(resolvePath(outDir), 'demonstration.json'), text)
        process.stdout.write(text)
        process.exitCode = overall === 'SATISFIED_CANDIDATE' ? 0 : 1
      },
      (e: unknown) => {
        process.stdout.write(`${JSON.stringify({ demonstration: 'FAILED_TO_RUN', message: (e as Error).message })}\n`)
        process.exitCode = 3
      }
    )
  }
  void createHash
}
