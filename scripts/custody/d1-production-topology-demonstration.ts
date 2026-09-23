// scripts/custody/d1-production-topology-demonstration.ts
//
//   pnpm custody:production:demonstrate -- --out-dir=<a path OUTSIDE this repository>
//
// THE PRODUCTION TOPOLOGY, RE-DEMONSTRATED ON A SYNTHETIC VALUE.
//
// N05 was certified on a topology in which the demonstration harness itself
// was the launcher. The production path is different: a BUILT depositor
// (d1-n30-deposit.js) fed by a pipe, a BUILT launcher (d1-deliver-n13.js) that
// is its own process, and a BUILT N13 consumer (d1-auditor-n13-consumer.js)
// started by that launcher. HC1-S5 and NB-6 require the delivery topology to
// be re-demonstrated when the production consumer differs from the certified
// one; this is that re-demonstration, with the very files a production run
// would use, under bare node, observed from outside by the same PEB observer.
//
// The value is a freshly generated NON-SECRET sentinel with an RFC 6761
// `.invalid` host, deposited through the SYNTHETIC shape into the sentinel
// namespace. The N13 consumer resolves it, and its pre-connect identity gate
// refuses the host, so no socket to any database is ever attempted. The
// production WCM entry name is only PROBED (read), to prove it absent before
// and after; it is never written.
//
// Like the N05 demonstration, this cannot certify anything. Its strongest
// word is SATISFIED_CANDIDATE.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  bridgeArgv,
  isWindowsCredentialManagerAvailable,
  probeCredential,
  removeCredential,
  retrieveCredential,
  sweepCredentials,
} from '../../db/custody/wcm-credential-store'
import { encodeBase64Bytes } from '../../db/custody/base64-bytes'
import { d1AuditorWcmTarget } from '../../db/custody/production-custody'
import { AUDITOR_ENV_VAR_NAME, SENTINEL_TARGET_PREFIX, generateSentinel } from './n05-sentinel'
import { isInsideRepositoryTree } from './build-sentinel-consumer'
import { buildProductionEntryPoints } from './build-production-entrypoints'
import {
  enumerateHistorySinks,
  observeFromOutsideProcessTree,
  readPersistentEnvironment,
  searchFileSinks,
} from './n05-observers'
import { PebObserver, type PebDump } from './n05-peb-observer'
import { deriveObservationControls, governedRepresentations } from './n05-observation-controls'

type State = 'PASSED' | 'FAILED' | 'NOT_RUN'

const REPO_ROOT = resolvePath(fileURLToPath(new URL('../..', import.meta.url)))
const DWELL_MS = 1_500
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const log = (l: string): void => void process.stdout.write(`${l}\n`)

interface Run {
  readonly exitCode: number | null
  readonly lines: readonly Record<string, unknown>[]
  readonly pid: number
}

/** Start a built entry point under bare node, sharing this console unless told otherwise. */
function startNode(
  entry: string,
  args: readonly string[],
  opts: { stdin?: Buffer; noConsole?: boolean; onLine?: (l: Record<string, unknown>) => void } = {}
): { pid: number; done: Promise<Run>; kill: () => void } {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: opts.noConsole === true,
    detached: opts.noConsole === true,
  })
  const lines: Record<string, unknown>[] = []
  let buf = ''
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (c: string) => {
    buf += c
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (raw === '') continue
      try {
        const obj = JSON.parse(raw) as Record<string, unknown>
        lines.push(obj)
        opts.onLine?.(obj)
      } catch {
        lines.push({ unparsed: true })
      }
    }
  })
  if (opts.stdin !== undefined) {
    const framed = Buffer.concat([opts.stdin, Buffer.from('\n')])
    child.stdin!.end(framed, () => framed.fill(0))
  } else {
    child.stdin!.end()
  }
  const done = new Promise<Run>((res) => child.on('close', (code) => res({ exitCode: code, lines, pid: child.pid ?? -1 })))
  return { pid: child.pid ?? -1, done, kill: () => child.kill() }
}

function treeOf(dump: PebDump, root: number): Set<number> {
  const set = new Set([root])
  for (let grew = true; grew; ) {
    grew = false
    for (const p of dump.processes) {
      if (!set.has(p.pid) && set.has(p.ppid)) {
        set.add(p.pid)
        grew = true
      }
    }
  }
  return set
}
const liveHolders = (d: PebDump): string[] => {
  const t = treeOf(d, process.pid)
  return d.processes.filter((p) => t.has(p.pid) && p.alive && (p.envVar || p.govEnv !== 0)).map((p) => `${p.name}(${p.pid})`)
}

async function main(): Promise<number> {
  const raw = process.argv.slice(2).find((a) => a.startsWith('--out-dir='))?.slice('--out-dir='.length)
  if (raw === undefined || raw.trim() === '') throw new Error('--out-dir=<path OUTSIDE the repository> is required.')
  const outDir = resolvePath(raw)
  if (isInsideRepositoryTree(REPO_ROOT, outDir)) throw new Error('--out-dir resolves inside the repository tree. Refusing.')
  if (!isWindowsCredentialManagerAvailable()) {
    log('  PRODUCTION TOPOLOGY DEMONSTRATION: NOT_RUN (Windows Credential Manager unreachable). Not a pass.')
    return 3
  }
  mkdirSync(outDir, { recursive: true })
  process.chdir(outDir)

  // Built BEFORE any value exists, so no build tool runs while one is live.
  const built = buildProductionEntryPoints(REPO_ROOT, outDir)

  const c: Record<string, State> = {
    T_OBS0_OBSERVER_SEES_FIXTURE: 'NOT_RUN',
    T_B1_PRODUCTION_LAUNCHER_REFUSES_WITHOUT_CONSOLE: 'NOT_RUN',
    T_N30_DEPOSIT_EXIT_MET_BY_READBACK: 'NOT_RUN',
    T_N30_EXACTLY_ONE_ENTRY_SECOND_DEPOSIT_REFUSED: 'NOT_RUN',
    T_RC2_CONSUMER_RESOLVED_DELIVERED_VALUE_WITHOUT_SOCKET: 'NOT_RUN',
    T_NEG_CONSUMER_RESOLVES_NOTHING_WITHOUT_DELIVERY: 'NOT_RUN',
    T_SUCCESS_PATH_REMOVED: 'NOT_RUN',
    T_FAILURE_PATH_REMOVED: 'NOT_RUN',
    T_CONSUMER_KILLED_NO_HOLDER: 'NOT_RUN',
    T_TIMEOUT_KILLED_NO_HOLDER: 'NOT_RUN',
    T_LAUNCHER_KILLED_CONSUMER_DIES_WITH_JOB: 'NOT_RUN',
    T_NP10_NO_VALUE_IN_ANY_COMMAND_LINE: 'NOT_RUN',
    T_RC3_NAMED_SUBJECTS_ARGV_CLEAN: 'NOT_RUN',
    T_RC7_VALUE_ONLY_IN_DELIVERED_CONSUMERS: 'NOT_RUN',
    T_FRESH_SHELL_AND_PERSISTENT_ENV_ABSENT: 'NOT_RUN',
    T_HISTORY_SINKS_CLEAN: 'NOT_RUN',
    T_CLEANUP_EXACT_REMOVAL_AND_ABSENCE: 'NOT_RUN',
    T_PRODUCTION_ENTRY_NEVER_WRITTEN: 'NOT_RUN',
  }
  const pf = (b: boolean): State => (b ? 'PASSED' : 'FAILED')

  const prodTarget = d1AuditorWcmTarget()
  const prodAbsentBefore = !(await probeCredential(prodTarget))
  for (const stale of await sweepCredentials(SENTINEL_TARGET_PREFIX)) await removeCredential(stale)

  const sentinel = generateSentinel()
  const T = sentinel.target
  const governed = governedRepresentations(sentinel.value)
  const fixtureRaw = Buffer.from(`d1-topology-fixture-${randomBytes(12).toString('hex')}`, 'latin1')
  const fixture = [fixtureRaw, encodeBase64Bytes(fixtureRaw)]
  const observer = await PebObserver.start({
    rootPid: process.pid,
    envVarName: AUDITOR_ENV_VAR_NAME,
    governed,
    fixture,
    classes: [bridgeArgv()[5]!.slice(0, 64), 'd1-auditor-n13-consumer', 'd1-deliver-n13', 'd1-n30-deposit'],
  })
  let stopped = false
  const deliveredConsumerPids: number[] = []
  const launcherPids: number[] = []
  const consumerPidOf = (l: Record<string, unknown>): void => {
    if (l.launcher === 'CONSUMER_SPAWNED' && typeof l.pid === 'number') deliveredConsumerPids.push(l.pid)
  }
  const deliver = (mode: string, extra: string[] = [], onLine?: (l: Record<string, unknown>) => void) => {
    const r = startNode(built.deliver, [`--consumer=${built.consumer}`, `--mode=${mode}`, `--synthetic-target=${T}`, ...extra], {
      onLine: (l) => {
        consumerPidOf(l)
        onLine?.(l)
      },
    })
    launcherPids.push(r.pid)
    return r
  }
  const n13 = (run: Run): Record<string, unknown> => run.lines.find((l) => l.node === 'N13') ?? {}

  try {
    log('')
    log('  D-1 PRODUCTION TOPOLOGY DEMONSTRATION (synthetic value, no database)')
    log(`  working directory : ${outDir}`)

    // --- OBS0 fixture -------------------------------------------------------
    const fixturePids: number[] = []
    for (const [a, e] of [
      [fixture[0]!, fixture[1]!],
      [fixture[1]!, fixture[0]!],
    ] as const) {
      const f = spawn(process.execPath, ['-e', 'const t=Date.now();while(Date.now()-t<1200){}', a.toString('latin1')], {
        stdio: 'ignore',
        windowsHide: false,
        env: { ...process.env, D1_OBSERVER_FIXTURE: e.toString('latin1') },
      })
      await new Promise((r) => f.on('close', r))
      fixturePids.push(f.pid ?? -1)
    }

    // --- B-1 on the PRODUCTION launcher: no console -> refusal, nothing read --
    await observer.mark('b1')
    const noConsole = await startNode(built.deliver, [`--consumer=${built.consumer}`, '--mode=dry-run', `--synthetic-target=${T}`], {
      noConsole: true,
      onLine: consumerPidOf,
    }).done
    const refusedLine = noConsole.lines.find((l) => l.launcher === 'REFUSED_OR_FAILED')
    const noConsoleSpawned = noConsole.lines.some((l) => l.launcher === 'CONSUMER_SPAWNED')
    // (The entry does not exist yet, so a launcher that skipped the console check
    //  would still fail — but with CUSTODY_RETRIEVE_FAILED, not the topology code.)
    log(`  [B1] console-less launcher : exit=${noConsole.exitCode} code=${String(refusedLine?.code)} consumer-spawned=${noConsoleSpawned}`)

    // --- N30 through the BUILT depositor, on a pipe -------------------------
    await observer.mark('deposit')
    const dep = await startNode(built.deposit, [`--synthetic-target=${T}`], { stdin: sentinel.value }).done
    const depLine = dep.lines.find((l) => l.node === 'N30') ?? {}
    c.T_N30_DEPOSIT_EXIT_MET_BY_READBACK = pf(dep.exitCode === 0 && depLine.n30ExitMet === true && depLine.postWriteProbePresent === true)
    const dep2 = await startNode(built.deposit, [`--synthetic-target=${T}`], { stdin: sentinel.value }).done
    const dep2Line = dep2.lines.find((l) => l.node === 'N30') ?? {}
    c.T_N30_EXACTLY_ONE_ENTRY_SECOND_DEPOSIT_REFUSED = pf(dep2.exitCode !== 0 && /STOP_N30_ENTRY_ALREADY_PRESENT/.test(String(dep2Line.message)))
    log(`  [1] deposit (built, piped) : exit=${dep.exitCode} n30ExitMet=${String(depLine.n30ExitMet)}; second deposit exit=${dep2.exitCode} refused=${c.T_N30_EXACTLY_ONE_ENTRY_SECOND_DEPOSIT_REFUSED}`)

    c.T_B1_PRODUCTION_LAUNCHER_REFUSES_WITHOUT_CONSOLE = pf(
      noConsole.exitCode === 3 && refusedLine?.code === 'CUSTODY_DELIVERY_TOPOLOGY_UNSAFE' && !noConsoleSpawned
    )

    // --- success path -------------------------------------------------------
    await observer.mark('deliver_success')
    const ok = await deliver('dry-run', [`--dwell-ms=${DWELL_MS}`]).done
    const okLine = n13(ok)
    const holdersOk = liveHolders(await observer.dump())
    const persistOk = await readPersistentEnvironment(AUDITOR_ENV_VAR_NAME)
    const resolvedWithDelivery = okLine.resolved === true
    c.T_RC2_CONSUMER_RESOLVED_DELIVERED_VALUE_WITHOUT_SOCKET = pf(
      ok.exitCode === 0 && resolvedWithDelivery && okLine.connected === false && okLine.failedAt === 'PRE_CONNECT_IDENTITY'
    )
    c.T_SUCCESS_PATH_REMOVED = pf(ok.exitCode === 0 && holdersOk.length === 0 && !persistOk.user && !persistOk.machine && process.env[AUDITOR_ENV_VAR_NAME] === undefined)
    log(`  [2] success path           : exit=${ok.exitCode} resolved=${String(okLine.resolved)} connected=${String(okLine.connected)} stop=${String(okLine.code)} holders-after=${holdersOk.length}`)

    // --- failure path -------------------------------------------------------
    await observer.mark('deliver_fail')
    const bad = await deliver('dry-run-fail', [`--dwell-ms=${DWELL_MS}`]).done
    const badLine = n13(bad)
    const holdersBad = liveHolders(await observer.dump())
    const persistBad = await readPersistentEnvironment(AUDITOR_ENV_VAR_NAME)
    c.T_FAILURE_PATH_REMOVED = pf(bad.exitCode === 1 && badLine.resolved === true && holdersBad.length === 0 && !persistBad.user && !persistBad.machine)
    log(`  [3] failure path           : exit=${bad.exitCode} resolved-before-failing=${String(badLine.resolved)} holders-after=${holdersBad.length}`)

    // --- negative: the same consumer with no delivery -----------------------
    await observer.mark('no_delivery')
    const none = await startNode(built.consumer, ['--mode=expect-absent', `--dwell-ms=${DWELL_MS}`]).done
    const noneLine = n13(none)
    c.T_NEG_CONSUMER_RESOLVES_NOTHING_WITHOUT_DELIVERY = pf(resolvedWithDelivery && none.exitCode === 0 && noneLine.resolved === false)
    log(`  [4] no delivery            : exit=${none.exitCode} resolved=${String(noneLine.resolved)}`)

    const waitLive = async (pidRef: () => number): Promise<boolean> => {
      for (let i = 0; i < 150; i += 1) {
        await sleep(100)
        const pid = pidRef()
        if (pid === 0) continue
        if ((await observer.dump()).processes.some((p) => p.pid === pid && p.alive && p.envVar)) return true
      }
      return false
    }

    // --- consumer killed with the value live --------------------------------
    await observer.mark('kill_consumer')
    let kPid = 0
    const k = deliver('dry-run', ['--dwell-ms=20000'], (l) => {
      if (l.launcher === 'CONSUMER_SPAWNED') kPid = Number(l.pid)
    })
    const kLive = await waitLive(() => kPid)
    if (kPid !== 0) process.kill(kPid)
    const kRun = await k.done
    await sleep(300)
    const kHolders = liveHolders(await observer.dump())
    c.T_CONSUMER_KILLED_NO_HOLDER = pf(kLive && kRun.exitCode !== 0 && kHolders.length === 0)
    log(`  [K1] consumer killed       : seen-live=${kLive} launcher-exit=${kRun.exitCode} holders-after=${kHolders.length}`)

    // --- the launcher's own timeout kills the consumer ----------------------
    await observer.mark('timeout')
    const to = await deliver('dry-run', ['--dwell-ms=20000', '--timeout-ms=2500']).done
    await sleep(300)
    const toHolders = liveHolders(await observer.dump())
    const toCode = to.lines.find((l) => l.launcher === 'REFUSED_OR_FAILED')?.code
    c.T_TIMEOUT_KILLED_NO_HOLDER = pf(to.exitCode === 3 && toCode === 'CUSTODY_BRIDGE_TIMEOUT' && toHolders.length === 0)
    log(`  [K2] timeout               : launcher-exit=${to.exitCode} code=${String(toCode)} holders-after=${toHolders.length}`)

    // --- the LAUNCHER is killed: the consumer must die with its job ----------
    await observer.mark('kill_launcher')
    let lPid = 0
    const lk = deliver('dry-run', ['--dwell-ms=20000'], (l) => {
      if (l.launcher === 'CONSUMER_SPAWNED') lPid = Number(l.pid)
    })
    const lLive = await waitLive(() => lPid)
    lk.kill()
    await lk.done
    let consumerGone = false
    for (let i = 0; i < 30 && !consumerGone; i += 1) {
      await sleep(200)
      consumerGone = !(await observer.dump()).processes.some((p) => p.pid === lPid && p.alive)
    }
    const lHolders = liveHolders(await observer.dump())
    c.T_LAUNCHER_KILLED_CONSUMER_DIES_WITH_JOB = pf(lLive && consumerGone && lHolders.length === 0)
    log(`  [K3] launcher killed       : consumer-seen-live=${lLive} consumer-gone=${consumerGone} holders-after=${lHolders.length}`)

    // --- fresh shell, persistent env, explorer ------------------------------
    await observer.mark('fresh_shell')
    const outside = await observeFromOutsideProcessTree(AUDITOR_ENV_VAR_NAME)
    const persistent = await readPersistentEnvironment(AUDITOR_ENV_VAR_NAME)
    const explorers = (await observer.dump()).processes.filter((p) => /^explorer$/i.test(p.name))
    const explorersClean = explorers.length > 0 && explorers.every((p) => p.envReadable && !p.envVar)
    c.T_FRESH_SHELL_AND_PERSISTENT_ENV_ABSENT = pf(!outside.present && outside.parentIsNotThisTree && !persistent.user && !persistent.machine && explorersClean)
    log(`  [5] fresh shell            : present=${outside.present} persistent user=${persistent.user} machine=${persistent.machine} explorers clean=${explorersClean}`)

    const sinks = await enumerateHistorySinks()
    c.T_HISTORY_SINKS_CLEAN = pf(searchFileSinks(sinks, sentinel.value).clean)
    log(`  [6] history sinks          : ${sinks.length} enumerated, clean=${c.T_HISTORY_SINKS_CLEAN}`)

    // --- cleanup: EXACT removal, positive absence ---------------------------
    await observer.mark('cleanup')
    const deleted = await removeCredential(T)
    const absent = !(await probeCredential(T))
    const readAfter = await retrieveCredential(T)
    const remaining = await sweepCredentials(SENTINEL_TARGET_PREFIX)
    c.T_CLEANUP_EXACT_REMOVAL_AND_ABSENCE = pf(deleted && absent && readAfter === null && remaining.length === 0)
    const prodAbsentAfter = !(await probeCredential(prodTarget))
    c.T_PRODUCTION_ENTRY_NEVER_WRITTEN = pf(prodAbsentBefore && prodAbsentAfter)
    log(`  [7] cleanup                : deleted=${deleted} absent=${absent} read-null=${readAfter === null} sentinel-entries-left=${remaining.length} production-entry absent before/after=${prodAbsentBefore}/${prodAbsentAfter}`)

    // --- process controls from the external observation ---------------------
    stopped = true
    const final = await observer.stop()
    const d = deriveObservationControls({
      processes: final.processes,
      launcherPid: process.pid,
      deliveredConsumerPids,
      fixturePids,
      governedCount: governed.length,
      fixtureCount: fixture.length,
      minBridgeSubjects: 3,
    })
    c.T_OBS0_OBSERVER_SEES_FIXTURE = d.OBS0
    c.T_NP10_NO_VALUE_IN_ANY_COMMAND_LINE = d.NP10
    c.T_RC3_NAMED_SUBJECTS_ARGV_CLEAN = d.RC3
    c.T_RC7_VALUE_ONLY_IN_DELIVERED_CONSUMERS = d.RC7
    const launchersObserved = final.processes.filter((p) => launcherPids.includes(p.pid))
    const launchersClean = launchersObserved.length > 0 && launchersObserved.every((p) => p.envReadable && !p.envVar && p.govEnv === 0 && p.govCmd === 0)
    if (!launchersClean) c.T_RC7_VALUE_ONLY_IN_DELIVERED_CONSUMERS = launchersObserved.length === 0 ? 'NOT_RUN' : 'FAILED'
    for (const r of d.reasons) log(`    ! ${r}`)
    log(
      `  [8] observer               : ${final.polls} polls; tree=${d.subjects.treeSize} bridges=${d.subjects.bridges} ` +
        `delivered-consumers=${d.subjects.deliveredConsumersObserved}/${deliveredConsumerPids.length} consumer-descendants=${d.subjects.consumerDescendants.length} ` +
        `launchers observed clean=${launchersObserved.length}/${launcherPids.length}`
    )
    const tree = treeOf(final, process.pid)
    const names = Array.from(new Set(final.processes.filter((p) => tree.has(p.pid) && p.pid !== process.pid).map((p) => p.name))).sort()

    const failed = Object.entries(c).filter(([, s]) => s !== 'PASSED')
    const overall = failed.length === 0 ? 'SATISFIED_CANDIDATE' : 'NOT_SATISFIED'
    const record = {
      demonstration: 'D1_PRODUCTION_TOPOLOGY_SYNTHETIC',
      value: 'freshly generated NON-SECRET sentinel, RFC 6761 .invalid host, synthetic shape, sentinel namespace',
      topology: 'harness -> built d1-n30-deposit.js (stdin pipe) ; harness -> built d1-deliver-n13.js (console, bare node) -> built d1-auditor-n13-consumer.js (bare node, CONSUMER_SPAWN_FLAGS)',
      database_socket_attempted: false,
      controls: c,
      observed_process_names: names,
      consumer_descendants: d.subjects.consumerDescendants,
      observer_polls: final.polls,
      delivered_consumers: `${d.subjects.deliveredConsumersObserved}/${deliveredConsumerPids.length}`,
      launchers_observed: `${launchersObserved.length}/${launcherPids.length}`,
      overall,
    }
    writeFileSync(join(outDir, 'D1_PRODUCTION_TOPOLOGY_EVIDENCE.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    log('')
    for (const [k2, s] of Object.entries(c)) log(`  ${s.padEnd(8)} ${k2}`)
    log(`  aggregate : ${overall}`)
    log('  This run does NOT certify anything; it produces a candidate for an independent certifier.')
    return overall === 'SATISFIED_CANDIDATE' ? 0 : 1
  } finally {
    sentinel.value.fill(0)
    for (const g of governed) g.fill(0)
    if (!stopped) {
      try {
        await observer.stop()
      } catch {
        /* observation lost; the sweep below is what matters */
      }
    }
    try {
      for (const stale of await sweepCredentials(SENTINEL_TARGET_PREFIX)) {
        log(`  teardown sweep: removing ${stale}`)
        await removeCredential(stale)
      }
    } catch (e) {
      log(`  TEARDOWN SWEEP FAILED: ${(e as Error).message}`)
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((e: unknown) => {
    process.stdout.write(`\n  DEMONSTRATION ABORTED: ${(e as Error).message}\n\n`)
    process.exitCode = 5
  })
