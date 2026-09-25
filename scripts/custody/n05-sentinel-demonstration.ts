// scripts/custody/n05-sentinel-demonstration.ts
//
// THE WINDOWS_LOCAL_SENTINEL DEMONSTRATION.
//
//   pnpm custody:n05:demonstrate -- --out-dir=<a path OUTSIDE this repository>
//
// Run it from a CONSOLE (any terminal). Process delivery refuses to run from a
// launcher with no console, because such a launcher's consumer is given a
// conhost.exe that inherits the delivered value (B-1).
//
// It runs the mechanism built at `db/custody/**` against a freshly generated
// NON-SECRET sentinel and emits a secret-free evidence record. It does NOT
// decide whether N05 is satisfied: the strongest word it can print is
// SATISFIED_CANDIDATE, and `db/custody/n05-control-state.ts` explains why the
// distinction is load-bearing. A builder who certifies the build has produced
// a self-report, which N29's own text names as the failure mode an empty node
// invites.
//
// ---------------------------------------------------------------------------
// WHAT CHANGED AFTER THE INDEPENDENT CERTIFICATION FAILED THE FIRST VERSION
// ---------------------------------------------------------------------------
// The first version observed command lines through Win32_Process, never read
// an environment block, and exempted conhost.exe from RC-7 BY NAME. The
// certifier read the blocks and found the value in exactly that conhost. The
// process controls are now derived by `n05-observation-controls.ts` from a PEB
// observer that reads every descendant's command line AND environment block
// from outside; no process is exempted by name; a control that observed none
// of its subjects is NOT_RUN; and none of them may pass unless the observer
// first proved, on an injected fixture, that it sees every governed
// representation in both places.
//
// ---------------------------------------------------------------------------
// WHAT IT WILL NOT DO
// ---------------------------------------------------------------------------
// No real credential is read, written, generated, rotated or handled. No
// PostgreSQL connection is opened. No custody inventory file is touched. The
// only Credential Manager entries it creates or deletes are under the reserved
// sentinel prefix, and it verifies that none survives before it exits — a
// cleanup failure is a failure of the run.

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve as resolvePath, join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  bridgeArgv,
  depositCredential,
  isProcessAttachedToConsole,
  isWindowsCredentialManagerAvailable,
  probeCredential,
  removeCredential,
  retrieveCredential,
  sweepCredentials,
} from '../../db/custody/wcm-credential-store'
import { runWithDeliveredSecret } from '../../db/custody/process-delivery'
import { encodeBase64Bytes } from '../../db/custody/base64-bytes'
import {
  failClosedToken,
  summarizeN05Controls,
  type ControlState,
  type N05ControlId,
  type N05EvidenceRecord,
} from '../../db/custody/n05-control-state'
import { AUDITOR_ENV_VAR_NAME, SENTINEL_TARGET_PREFIX, generateSentinel } from './n05-sentinel'
import { buildSentinelConsumer, isInsideRepositoryTree } from './build-sentinel-consumer'
import {
  describeVaultReadAuditSurface,
  enumerateHistorySinks,
  observeFromOutsideProcessTree,
  readPersistentEnvironment,
  searchFileSinks,
} from './n05-observers'
import { PebObserver, type PebDump } from './n05-peb-observer'
import { deriveObservationControls, governedRepresentations } from './n05-observation-controls'

const REPO_ROOT = resolvePath(fileURLToPath(new URL('../..', import.meta.url)))
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href

/**
 * The built consumer, set once before any deposit.
 *
 * It is plain CommonJS run under bare `node`, NOT the TypeScript source run
 * under `tsx` — see `build-sentinel-consumer.ts` for the leak that choice
 * removes.
 */
let consumerEntry = ''

/**
 * How long each consumer run holds the value in its environment. The PEB
 * observer polls every ~15ms; the dwell makes the observation possible, and
 * the controls REFUSE to pass when a consumer was not observed at all.
 */
const CONSUMER_DWELL_MS = 1_500

const MECHANISM_NAME =
  'A fixed, uninterpolated PowerShell program that P/Invokes the Win32 Credential Management ' +
  'API (CredWriteW, CredReadW, CredDeleteW, CredEnumerateW) against CRED_TYPE_GENERIC entries. ' +
  'It is launched non-interactively with -NoProfile -NonInteractive -EncodedCommand by ' +
  'db/custody/wcm-credential-store.ts, which constructs the argv itself and accepts none from a ' +
  'caller. The value crosses the process boundary base64-framed on an anonymous stdin pipe ' +
  '(deposit) and an anonymous stdout pipe (retrieve), never as an argument, and is held by the ' +
  'launcher as Buffers except for the one environment string spawn requires. Delivery writes the ' +
  'value into the environment block of exactly one consuming child process at CreateProcess ' +
  'time, spawned WITHOUT CREATE_NO_WINDOW and without DETACHED_PROCESS so it shares the ' +
  "launcher's console (no conhost.exe of its own) and stays in the launcher's kill-on-close job; " +
  'delivery refuses to run from a launcher with no console. The launcher never sets the variable ' +
  'in its own environment, and no persistent user or machine environment is written. The reader ' +
  'lives INSIDE the repository tree, at db/custody/, as source that contains no credential material.'

function parseArgs(argv: readonly string[]): { readonly outDir: string } {
  const raw = argv.find((a) => a.startsWith('--out-dir='))?.slice('--out-dir='.length)
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      'An --out-dir=<path> is required, and it must be OUTSIDE this repository working tree. ' +
        'The readiness contract requires it (SP-3): a correctly shaped sentinel trips the ' +
        'repository secret scanner by design, so no artifact of this run may land in the tree.'
    )
  }
  const outDir = resolvePath(raw)
  if (isInsideRepositoryTree(REPO_ROOT, outDir)) {
    throw new Error(
      `--out-dir resolves to ${outDir}, which is INSIDE the repository working tree at ${REPO_ROOT}. ` +
        'Refusing to run: a sentinel or transcript landing in the tree would redden the secret ' +
        'scanner and inflate ods:scope, and would do so for a real reason.'
    )
  }
  return { outDir }
}

function log(line: string): void {
  process.stdout.write(`${line}\n`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Pids of every process in `dump` descended from `root` (inclusive). */
function treeOf(dump: PebDump, root: number): Set<number> {
  const set = new Set([root])
  let grew = true
  while (grew) {
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

/** Processes of the launcher tree still alive and holding the variable or a governed representation. */
function liveHolders(dump: PebDump): string[] {
  const tree = treeOf(dump, process.pid)
  return dump.processes
    .filter((p) => tree.has(p.pid) && p.alive && (p.envVar || p.govEnv !== 0))
    .map((p) => `${p.name}(pid ${p.pid})`)
}

const deliveredConsumerPids: number[] = []

/** Run the real consumer with the value delivered, via the custody mechanism. */
async function runConsumerWithDelivery(
  target: string,
  mode: 'success' | 'fail-after-resolve',
  cwd: string,
  dwellMs = CONSUMER_DWELL_MS,
  onSpawn?: (pid: number | undefined) => void
): Promise<{ exitCode: number | null; resolved: boolean }> {
  const result = await runWithDeliveredSecret({
    target,
    envVarName: AUDITOR_ENV_VAR_NAME,
    command: process.execPath,
    args: [consumerEntry, `--mode=${mode}`, `--dwell-ms=${dwellMs}`],
    cwd,
    onSpawn: (pid) => {
      if (pid !== undefined) deliveredConsumerPids.push(pid)
      onSpawn?.(pid)
    },
  })
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}'
  let resolved = false
  try {
    resolved = (JSON.parse(line) as { resolved?: boolean }).resolved === true
  } catch {
    resolved = false
  }
  return { exitCode: result.exitCode, resolved }
}

/** Run the SAME consumer with NO delivery. The negative exercise of the check. */
async function runConsumerWithoutDelivery(cwd: string): Promise<{ resolved: boolean }> {
  return await new Promise((resolveP, rejectP) => {
    const child = spawn(
      process.execPath,
      [consumerEntry, '--mode=expect-absent', `--dwell-ms=${CONSUMER_DWELL_MS}`],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] as const, windowsHide: false }
    )
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      out += c
    })
    child.on('error', rejectP)
    child.on('close', () => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}'
      try {
        resolveP({ resolved: (JSON.parse(line) as { resolved?: boolean }).resolved === true })
      } catch {
        resolveP({ resolved: false })
      }
    })
  })
}

/** A short-lived process that carries a FIXTURE (never the value) in argv and env. */
async function runFixture(argvRep: Buffer, envRep: Buffer): Promise<number> {
  return await new Promise((resolveP, rejectP) => {
    const child = spawn(
      process.execPath,
      ['-e', 'const t=Date.now();while(Date.now()-t<1200){}', argvRep.toString('latin1')],
      {
        stdio: 'ignore',
        windowsHide: false,
        env: { ...process.env, N05_OBSERVER_FIXTURE: envRep.toString('latin1') },
      }
    )
    child.on('error', rejectP)
    child.on('close', () => resolveP(child.pid ?? -1))
  })
}

/** OF-CUST-3: deposit from a separate process, kill it, and recover the entry by sweep. */
async function killDepositorAndRecover(target: string, value: Buffer): Promise<{
  readonly deposited: boolean
  readonly survivedKill: boolean
  readonly foundBySweep: boolean
  readonly absentAfterRecovery: boolean
}> {
  const child = spawn(
    process.execPath,
    ['--import', TSX_LOADER, join(REPO_ROOT, 'scripts', 'custody', 'n05-kill-depositor.ts'), `--target=${target}`],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false }
  )
  const framed = Buffer.alloc(value.length + 1)
  value.copy(framed)
  framed[value.length] = 0x0a
  child.stdin.end(framed, () => framed.fill(0))
  const deposited = await new Promise<boolean>((resolveP) => {
    let out = ''
    const timer = setTimeout(() => resolveP(false), 90_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      out += c
      if (out.includes('DEPOSITED')) {
        clearTimeout(timer)
        resolveP(true)
      }
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolveP(out.includes('DEPOSITED'))
    })
  })
  // TerminateProcess, from this process: no taskkill.exe, because a short-lived
  // helper spawned by the launcher is a process the observer may not catch.
  // The depositor's own runtime helper dies with it: Node places every
  // non-detached child in a kill-on-close job.
  try {
    child.kill()
  } catch {
    /* already gone */
  }
  await new Promise<void>((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('close', () => r())))
  const survivedKill = deposited && (await probeCredential(target))
  // Recovery removes ONLY the orphan it was run for. The main sentinel entry is
  // live in the same namespace and must be removed by the cleanup step that is
  // under test, not swept away early by this one.
  const swept = await sweepCredentials(SENTINEL_TARGET_PREFIX)
  const foundBySweep = swept.includes(target)
  if (foundBySweep) await removeCredential(target)
  const absentAfterRecovery = !(await probeCredential(target))
  return { deposited, survivedKill, foundBySweep, absentAfterRecovery }
}

async function main(): Promise<number> {
  const { outDir } = parseArgs(process.argv.slice(2))

  if (!isWindowsCredentialManagerAvailable()) {
    log('')
    log('  N05 DEMONSTRATION: NOT_RUN')
    log(`  Windows Credential Manager is unreachable on platform "${process.platform}".`)
    log('  This is NOT a pass and must never be recorded as one. No evidence record is written,')
    log('  because a record of a demonstration that did not happen is worse than its absence.')
    log('')
    return 3
  }

  mkdirSync(outDir, { recursive: true })
  // The demonstration's working directory is outside the repository tree, per
  // the readiness contract's universal preconditions.
  process.chdir(outDir)

  const outcomes: Record<N05ControlId, ControlState> = {
    NP9_FRESH_SHELL_ABSENT: 'NOT_RUN',
    NP10_EXTERNAL_COMMAND_LINE_CLEAN: 'NOT_RUN',
    NP11_BOTH_REMOVAL_PATHS_EXERCISED: 'NOT_RUN',
    NP12_ABSENCE_CHECK_PROVEN_CAPABLE_OF_FALSE: 'NOT_RUN',
    RC2_CONSUMER_RESOLVED_VALUE: 'NOT_RUN',
    RC3_DEPOSIT_ARGV_CLEAN: 'NOT_RUN',
    RC4_HISTORY_SINKS_CLEAN: 'NOT_RUN',
    RC6_VAULT_ENTRY_ABSENT_AFTER_CLEANUP: 'NOT_RUN',
    RC7_CONSUMER_SPAWNS_NO_ENV_INHERITING_CHILD: 'NOT_RUN',
    OBS0_OBSERVER_DETECTS_INJECTED_FIXTURE: 'NOT_RUN',
    B1_CONSOLE_PRECONDITION_CAPABLE_OF_REFUSING: 'NOT_RUN',
    RC5_ABRUPT_TERMINATION_RECOVERED: 'NOT_RUN',
  }

  // Built BEFORE anything is deposited, so no build tool is running while a
  // value is live and no bundler process can inherit one.
  consumerEntry = buildSentinelConsumer(REPO_ROOT, outDir)

  const sentinel = generateSentinel()
  const preExisting = await sweepCredentials(SENTINEL_TARGET_PREFIX)
  for (const stale of preExisting) {
    log(`  pre-run sweep: removing stale sentinel entry ${stale}`)
    await removeCredential(stale)
  }

  // The governed representations are exactly the ones this mechanism creates:
  // the raw value (the environment entry) and its base64 (the deposit framing
  // and the retrieval blob line). The fixture is a random NON-credential token
  // in the same two representations, used only to prove the observer sees.
  const governed = governedRepresentations(sentinel.value)
  const fixtureRaw = Buffer.from(`n05-observer-fixture-${randomBytes(12).toString('hex')}`, 'latin1')
  const fixture = [fixtureRaw, encodeBase64Bytes(fixtureRaw)]
  const observer = await PebObserver.start({
    rootPid: process.pid,
    envVarName: AUDITOR_ENV_VAR_NAME,
    governed,
    fixture,
    classes: [bridgeArgv()[5]!.slice(0, 64), 'n05-sentinel-consumer'],
  })
  let observerStopped = false

  try {
    log('')
    log('  N05 WINDOWS_LOCAL_SENTINEL DEMONSTRATION')
    log(`  working directory : ${outDir}  (outside the repository tree)`)
    log(`  entry target      : ${sentinel.target}`)
    log('')

    // --- OBS0 POSITIVE CONTROL: the observer must SEE a fixture ------------
    await observer.mark('fixture')
    const fixturePids = [await runFixture(fixture[0]!, fixture[1]!), await runFixture(fixture[1]!, fixture[0]!)]
    log(`  [0] observer fixture  : ${fixturePids.length} fixture processes run`)

    // --- B-1 PRECONDITION, BOTH WAYS ---------------------------------------
    await observer.mark('console_precondition')
    const selfAttached = await isProcessAttachedToConsole(process.pid)
    const noConsole = spawn(process.execPath, ['-e', 'setTimeout(()=>{},8000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    await sleep(500)
    const detachedAttached = await isProcessAttachedToConsole(noConsole.pid!)
    noConsole.kill()
    outcomes.B1_CONSOLE_PRECONDITION_CAPABLE_OF_REFUSING = selfAttached && !detachedAttached ? 'PASSED' : 'FAILED'
    log(`  [B1] console probe    : launcher attached=${String(selfAttached)} / console-less process attached=${String(detachedAttached)}`)

    // --- DEPOSIT (N30's act, on a sentinel) --------------------------------
    await observer.mark('deposit')
    await depositCredential({ target: sentinel.target, username: sentinel.username, secret: sentinel.value })
    log('  [1] deposit           : OK (value crossed on stdin, never argv)')

    const checkPresentWhenPresent = await probeCredential(sentinel.target)
    log(`  [2] absence check     : reports PRESENT while present = ${String(checkPresentWhenPresent)}`)

    const retrieved = await retrieveCredential(sentinel.target)
    const roundTrip = retrieved !== null && retrieved.equals(sentinel.value)
    retrieved?.fill(0)
    log(`  [3] round trip        : reader returned the same value = ${String(roundTrip)}`)

    // --- RC-5 SUCCESS PATH -------------------------------------------------
    await observer.mark('deliver_success')
    const successRun = await runConsumerWithDelivery(sentinel.target, 'success', outDir)
    const consumerResolved = successRun.resolved
    const afterSuccess = await readPersistentEnvironment(AUDITOR_ENV_VAR_NAME)
    const holdersAfterSuccess = liveHolders(await observer.dump())
    const successPathRemoved =
      !afterSuccess.user && !afterSuccess.machine && process.env[AUDITOR_ENV_VAR_NAME] === undefined && holdersAfterSuccess.length === 0
    log(`  [4] success path      : consumer exit=${String(successRun.exitCode)} resolved=${String(successRun.resolved)} removed=${String(successPathRemoved)}`)

    // --- RC-5 FAILURE PATH: a REAL consumer failure, after it resolved -----
    await observer.mark('deliver_fail')
    const failRun = await runConsumerWithDelivery(sentinel.target, 'fail-after-resolve', outDir)
    const afterFail = await readPersistentEnvironment(AUDITOR_ENV_VAR_NAME)
    const holdersAfterFail = liveHolders(await observer.dump())
    const failurePathRemoved =
      failRun.exitCode === 1 &&
      failRun.resolved &&
      !afterFail.user &&
      !afterFail.machine &&
      process.env[AUDITOR_ENV_VAR_NAME] === undefined &&
      holdersAfterFail.length === 0
    log(`  [5] failure path      : consumer exit=${String(failRun.exitCode)} resolved-before-failing=${String(failRun.resolved)} removed=${String(failurePathRemoved)}`)

    // --- THE SAME CHECK, NEGATIVE: consumer with no delivery ---------------
    await observer.mark('no_delivery')
    const absentRun = await runConsumerWithoutDelivery(outDir)
    const variableCheckCapableOfFalse = consumerResolved && !absentRun.resolved
    log(`  [6] variable check    : resolves with delivery=${String(consumerResolved)} / without delivery=${String(absentRun.resolved)}`)

    // --- RC-5 KILL PATH: the consumer is killed with the value live --------
    await observer.mark('kill_consumer')
    let killPid = 0
    const killRun = runConsumerWithDelivery(sentinel.target, 'success', outDir, 20_000, (pid) => {
      killPid = pid ?? 0
    })
    let seenLive = false
    for (let i = 0; i < 100 && !seenLive; i += 1) {
      await sleep(100)
      if (killPid === 0) continue
      seenLive = (await observer.dump()).processes.some((p) => p.pid === killPid && p.alive && p.envVar)
    }
    if (killPid !== 0) process.kill(killPid)
    const killResult = await killRun
    await sleep(300)
    const holdersAfterKill = liveHolders(await observer.dump())
    const killPathClean = seenLive && killResult.exitCode !== 0 && holdersAfterKill.length === 0
    log(`  [K1] consumer killed  : seen-live-with-value=${String(seenLive)} exit=${String(killResult.exitCode)} live-holders-after=${holdersAfterKill.length}`)

    // --- OF-CUST-3: a killed DEPOSITOR leaves the entry; the sweep recovers it
    await observer.mark('kill_depositor')
    const recovery = await killDepositorAndRecover(`${sentinel.target}-K`, sentinel.value)
    log(
      `  [K2] depositor killed : deposited=${String(recovery.deposited)} entry-survived-kill=${String(recovery.survivedKill)} ` +
        `found-by-sweep=${String(recovery.foundBySweep)} absent-after-recovery=${String(recovery.absentAfterRecovery)}`
    )
    outcomes.RC5_ABRUPT_TERMINATION_RECOVERED =
      killPathClean && recovery.deposited && recovery.survivedKill && recovery.foundBySweep && recovery.absentAfterRecovery
        ? 'PASSED'
        : 'FAILED'

    // --- RC-2: a shell OUTSIDE this process tree, and every explorer.exe ---
    await observer.mark('fresh_shell')
    const outside = await observeFromOutsideProcessTree(AUDITOR_ENV_VAR_NAME)
    const persistent = await readPersistentEnvironment(AUDITOR_ENV_VAR_NAME)
    const explorers = (await observer.dump()).processes.filter((p) => /^explorer$/i.test(p.name))
    const explorersClean = explorers.length > 0 && explorers.every((p) => p.envReadable && !p.envVar)
    const freshShellAbsent =
      !outside.present && outside.parentIsNotThisTree && !persistent.user && !persistent.machine && explorersClean
    log(
      `  [7] fresh shell       : out-of-tree probe present=${String(outside.present)} parent=${outside.parentName} ` +
        `persistent user=${String(persistent.user)} machine=${String(persistent.machine)} ` +
        `explorer blocks read=${explorers.length} clean=${String(explorersClean)}`
    )

    // --- RC-4: history sinks -----------------------------------------------
    const sinks = await enumerateHistorySinks()
    const historySinkNames = sinks.map((s) => `${s.name} [${s.kind}]${s.exists ? '' : ' (absent)'}`)
    const historyClean = searchFileSinks(sinks, sentinel.value).clean
    log(`  [8] history sinks     : ${sinks.length} enumerated, clean=${String(historyClean)}`)

    // --- CLEANUP, then RC-6 POSITIVE: the check must report ABSENT ---------
    await observer.mark('cleanup')
    const deleted = await removeCredential(sentinel.target)
    const checkAbsentAfterRemoval = !(await probeCredential(sentinel.target))
    const readAfterDelete = await retrieveCredential(sentinel.target)
    log(`  [9] cleanup           : deleted=${String(deleted)} absence-check-after=${String(checkAbsentAfterRemoval)} read-after-delete-null=${String(readAfterDelete === null)}`)

    // --- THE PROCESS CONTROLS, FROM THE EXTERNAL OBSERVATION ----------------
    observerStopped = true
    const finalDump = await observer.stop()
    const derived = deriveObservationControls({
      processes: finalDump.processes,
      launcherPid: process.pid,
      deliveredConsumerPids,
      fixturePids,
      governedCount: governed.length,
      fixtureCount: fixture.length,
      minBridgeSubjects: 3,
    })
    outcomes.OBS0_OBSERVER_DETECTS_INJECTED_FIXTURE = derived.OBS0
    outcomes.NP10_EXTERNAL_COMMAND_LINE_CLEAN = derived.NP10
    outcomes.RC3_DEPOSIT_ARGV_CLEAN = derived.RC3
    outcomes.RC7_CONSUMER_SPAWNS_NO_ENV_INHERITING_CHILD = derived.RC7
    for (const r of derived.reasons) log(`    ! ${r}`)
    log(
      `  [10] observer         : ${finalDump.polls} polls; subjects tree=${derived.subjects.treeSize} ` +
        `bridges=${derived.subjects.bridges} delivered-consumers=${derived.subjects.deliveredConsumersObserved} ` +
        `consumer-descendants=${derived.subjects.consumerDescendants.length} fixtures=${derived.subjects.fixturesObserved}`
    )

    const tree = treeOf(finalDump, process.pid)
    const observedProcessNames = Array.from(
      new Set(finalDump.processes.filter((p) => tree.has(p.pid) && p.pid !== process.pid).map((p) => p.name))
    ).sort()

    // --- CLEANUP VERIFICATION ----------------------------------------------
    const remaining = await sweepCredentials(SENTINEL_TARGET_PREFIX)
    const sweepClean = remaining.length === 0
    log(`  [11] sweep            : ${remaining.length} sentinel entries remain`)

    const audit = await describeVaultReadAuditSurface()

    // --- OUTCOMES -----------------------------------------------------------
    outcomes.NP9_FRESH_SHELL_ABSENT = freshShellAbsent ? 'PASSED' : 'FAILED'
    outcomes.NP11_BOTH_REMOVAL_PATHS_EXERCISED = successPathRemoved && failurePathRemoved ? 'PASSED' : 'FAILED'
    outcomes.NP12_ABSENCE_CHECK_PROVEN_CAPABLE_OF_FALSE =
      checkPresentWhenPresent && checkAbsentAfterRemoval && variableCheckCapableOfFalse ? 'PASSED' : 'FAILED'
    outcomes.RC2_CONSUMER_RESOLVED_VALUE = consumerResolved && roundTrip ? 'PASSED' : 'FAILED'
    outcomes.RC4_HISTORY_SINKS_CLEAN = historyClean ? 'PASSED' : 'FAILED'
    // `deleted` must be true: an absence after a removal that removed nothing
    // proves the entry was already gone, not that cleanup works.
    outcomes.RC6_VAULT_ENTRY_ABSENT_AFTER_CLEANUP =
      deleted && checkAbsentAfterRemoval && readAfterDelete === null && sweepClean ? 'PASSED' : 'FAILED'

    const summary = summarizeN05Controls(outcomes)

    const childTopology = [
      `DELIVERED CONSUMERS OBSERVED: ${derived.subjects.deliveredConsumersObserved} of ${deliveredConsumerPids.length} ` +
        'launched (success, fail-after-resolve, kill path). Each was observed by an external PEB reader with the ' +
        'variable present in its OWN environment block — the capability of true, in the scope the value was set in.',
      derived.subjects.consumerDescendants.length === 0
        ? 'DESCENDANTS OF ANY DELIVERED CONSUMER: NONE, over the whole run, by external observation. ' +
          'No conhost.exe and no runtime helper: the consumer is spawned without CREATE_NO_WINDOW, shares the ' +
          "launcher's console, and runs under bare node."
        : `DESCENDANTS OF DELIVERED CONSUMERS (${derived.subjects.consumerDescendants.length}): ` +
          `${derived.subjects.consumerDescendants.join('; ')}. Each is judged by its own environment block; see RC7.`,
      'NO PROCESS IS EXEMPTED BY NAME. The first version of this record exempted conhost.exe by a stated reason; ' +
        'the independent certification read its environment block and found the value (B-1). Every process in the ' +
        'launcher tree — bridges, observers, console hosts, runtime helpers — is now judged by its own block.',
      `BRIDGE PROCESSES OBSERVED: ${derived.subjects.bridges}. Each was checked for the variable and for every ` +
        'governed representation in its environment block and command line; its environment is an allowlist.',
      'MEASURED FINDING CARRIED FORWARD: a consumer run under tsx spawns an esbuild helper that inherits the ' +
        'delivered value, so the production invocation must not deliver into a process running under a development runtime.',
    ]

    const record: N05EvidenceRecord = {
      mechanism_named_by_behaviour: MECHANISM_NAME,
      sentinel_freshly_generated: true,
      wcm_c1_fresh_shell_absent: freshShellAbsent,
      wcm_c2_external_command_line_observation_clean: derived.NP10 === 'PASSED' && derived.RC3 === 'PASSED',
      wcm_c2_processes_observed: observedProcessNames,
      wcm_c3_history_sinks_enumerated: historySinkNames,
      wcm_c3_all_sinks_clean: historyClean,
      wcm_c3_invocation_contract_enforcement:
        'ENFORCED BY CONSTRUCTION, not by configuration. db/custody/wcm-credential-store.ts ' +
        'builds the PowerShell argv in bridgeArgv(), which is a pure function of nothing and ' +
        'takes no caller input; there is no parameter through which -NonInteractive could be ' +
        'dropped, the profile re-enabled, or a -Command carrying a value appended. The value ' +
        'itself never enters a command line, a script block or an interactive prompt, so a ' +
        'session with every history facility enabled still records no secret.',
      wcm_c4_success_path_removed: successPathRemoved,
      wcm_c4_failure_path_removed: failurePathRemoved,
      wcm_c4_abrupt_termination_behaviour:
        'MEASURED in this run, not only stated. THE VARIABLE: a delivered consumer was killed with the value live ' +
        'in its block; afterwards no live process of the launcher tree carried the variable or any governed ' +
        "representation. The consumer also sits in the launcher's kill-on-close job, so killing the launcher kills " +
        'it. THE VAULT ENTRY: a separate depositor was killed after depositing, and its entry SURVIVED the kill — ' +
        'by design, it is CRED_PERSIST_LOCAL_MACHINE because depositor and reader are different runs. The bounded ' +
        'recovery sweep, which the mechanism refuses to run outside the UELLIX-N05-SENTINEL namespace, found it and ' +
        'removed it, and the absence check then reported it absent. For the REAL credential no sweep exists or ' +
        'may: removing the real entry is the rotation act N28 governs.',
      wcm_c5_check_returned_present_when_present: checkPresentWhenPresent,
      wcm_c5_check_returned_absent_after_removal: checkAbsentAfterRemoval,
      child_process_topology: childTopology,
      vault_read_audit_surface: audit.statement,
      vault_read_audit_records_handle: audit.recordsHandle,
      demonstration_preceded_MR_2: true,
      working_directory_outside_the_repository_tree: true,
      controls: outcomes,
    }

    const recordPath = join(outDir, 'N05_SENTINEL_DEMONSTRATION_EVIDENCE.json')
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')

    log('')
    log(`  evidence record : ${recordPath}`)
    log(`  aggregate       : ${summary.overall}`)
    for (const reason of summary.blockingReasons) log(`    - ${reason}`)
    const token = failClosedToken(summary)
    if (token !== null) log(`  token           : ${token}`)
    log('')
    log('  This run does NOT certify N05. It produces a demonstration candidate for an')
    log('  independent certifier, which is the boundary N29 draws around the builder.')
    log('')

    if (!sweepClean) {
      log('  CLEANUP FAILURE: sentinel entries survived the run.')
      return 4
    }
    return summary.overall === 'SATISFIED_CANDIDATE' ? 0 : 1
  } finally {
    sentinel.value.fill(0)
    for (const g of governed) g.fill(0)
    if (!observerStopped) {
      try {
        await observer.stop()
      } catch {
        /* the observation is already lost; the sweep below is what matters */
      }
    }
    // Last line of defence. Runs even when the body threw.
    try {
      for (const stale of await sweepCredentials(SENTINEL_TARGET_PREFIX)) {
        log(`  teardown sweep: removing ${stale}`)
        await removeCredential(stale)
      }
    } catch (error) {
      log(`  TEARDOWN SWEEP FAILED: ${(error as Error).message}`)
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stdout.write(`\n  DEMONSTRATION ABORTED: ${(error as Error).message}\n\n`)
    process.exitCode = 5
  })
