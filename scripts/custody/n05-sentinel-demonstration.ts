// scripts/custody/n05-sentinel-demonstration.ts
//
// THE WINDOWS_LOCAL_SENTINEL DEMONSTRATION.
//
//   pnpm custody:n05:demonstrate -- --out-dir <a path OUTSIDE this repository>
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
// WHAT IT WILL NOT DO
// ---------------------------------------------------------------------------
// No real credential is read, written, generated, rotated or handled. No
// PostgreSQL connection is opened. No custody inventory file is touched. The
// only Credential Manager entries it creates or deletes are under the reserved
// sentinel prefix, and it verifies that none survives before it exits — a
// cleanup failure is a failure of the run.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve as resolvePath, join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  depositCredential,
  isWindowsCredentialManagerAvailable,
  probeCredential,
  removeCredential,
  retrieveCredential,
  sweepCredentials,
} from '../../db/custody/wcm-credential-store'
import { runWithDeliveredSecret } from '../../db/custody/process-delivery'
import {
  failClosedToken,
  summarizeN05Controls,
  type ControlState,
  type N05ControlId,
  type N05EvidenceRecord,
} from '../../db/custody/n05-control-state'
import {
  AUDITOR_ENV_VAR_NAME,
  SENTINEL_TARGET_PREFIX,
  generateSentinel,
} from './n05-sentinel'
import { buildSentinelConsumer, isInsideRepositoryTree } from './build-sentinel-consumer'
import {
  describeVaultReadAuditSurface,
  enumerateHistorySinks,
  observeFromOutsideProcessTree,
  readPersistentEnvironment,
  searchFileSinks,
  startCommandLineObserver,
} from './n05-observers'

const REPO_ROOT = resolvePath(fileURLToPath(new URL('../..', import.meta.url)))

/**
 * The built consumer, set once before any deposit.
 *
 * It is plain CommonJS run under bare `node`, NOT the TypeScript source run
 * under `tsx` — see `build-sentinel-consumer.ts` for the leak that choice
 * removes, and why the leak is reported anyway.
 */
let consumerEntry = ''

/**
 * How long each consumer run holds the value in its environment.
 *
 * Chosen against the observer's 100ms poll interval, not picked for comfort: a
 * consumer that lives 50ms is invisible to the poller, and an unobserved
 * consumer makes RC-3 and RC-7 pass over an empty set. The harness additionally
 * REFUSES to pass those controls when the observer saw no consuming process at
 * all, so this constant being wrong fails loudly rather than quietly.
 */
const CONSUMER_DWELL_MS = 1_500

const MECHANISM_NAME =
  'A fixed, uninterpolated PowerShell program that P/Invokes the Win32 Credential Management ' +
  'API (CredWriteW, CredReadW, CredDeleteW, CredEnumerateW) against CRED_TYPE_GENERIC entries. ' +
  'It is launched non-interactively with -NoProfile -NonInteractive -EncodedCommand by ' +
  'db/custody/wcm-credential-store.ts, which constructs the argv itself and accepts none from a ' +
  'caller. The value crosses the process boundary base64-framed on an anonymous stdin pipe ' +
  '(deposit) and an anonymous stdout pipe (retrieve), never as an argument. Delivery writes the ' +
  'value into the environment block of exactly one consuming child process at CreateProcess ' +
  'time; the launcher process never sets the variable in its own environment, and no persistent ' +
  'user or machine environment is written. The reader lives INSIDE the repository tree, at ' +
  'db/custody/, as source that contains no credential material.'

interface Args {
  readonly outDir: string
}

function parseArgs(argv: readonly string[]): Args {
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

/** Run the real consumer with the value delivered, via the custody mechanism. */
async function runConsumerWithDelivery(
  target: string,
  mode: 'success' | 'fail-after-resolve',
  cwd: string
): Promise<{ exitCode: number | null; resolved: boolean }> {
  const result = await runWithDeliveredSecret({
    target,
    envVarName: AUDITOR_ENV_VAR_NAME,
    command: process.execPath,
    args: [consumerEntry, `--mode=${mode}`, `--dwell-ms=${CONSUMER_DWELL_MS}`],
    cwd,
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
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'] as const,
        windowsHide: true,
      }
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
  }

  // Built BEFORE anything is deposited, so no build tool is running while a
  // value is live and no bundler process can inherit one.
  consumerEntry = buildSentinelConsumer(REPO_ROOT, outDir)

  const sentinel = generateSentinel()
  let observedProcessNames: string[] = []
  let childTopology: string[] = []
  let historySinkNames: string[] = []
  let historyClean = false
  let commandLinesClean = false
  let freshShellAbsent = false
  let successPathRemoved = false
  let failurePathRemoved = false
  let checkPresentWhenPresent = false
  let checkAbsentAfterRemoval = false
  let consumerResolved = false
  let envInheritingChildren: string[] = []

  // Anything that survives this run is a cleanup failure and therefore a lane
  // failure. The sweep runs before and after, and the after-sweep is verified.
  const preExisting = await sweepCredentials(SENTINEL_TARGET_PREFIX)
  for (const stale of preExisting) {
    log(`  pre-run sweep: removing stale sentinel entry ${stale}`)
    await removeCredential(stale)
  }

  const observer = startCommandLineObserver(outDir)
  let observerStopped = false

  try {
    log('')
    log('  N05 WINDOWS_LOCAL_SENTINEL DEMONSTRATION')
    log(`  working directory : ${outDir}  (outside the repository tree)`)
    log(`  entry target      : ${sentinel.target}`)
    log('')

    // --- DEPOSIT (N30's act, on a sentinel) --------------------------------
    await depositCredential({
      target: sentinel.target,
      username: sentinel.username,
      secret: sentinel.value,
    })
    log('  [1] deposit           : OK (value crossed on stdin, never argv)')

    // --- WCM-C5 NEGATIVE EXERCISE: the check must report PRESENT -----------
    checkPresentWhenPresent = await probeCredential(sentinel.target)
    log(`  [2] absence check     : reports PRESENT while present = ${String(checkPresentWhenPresent)}`)

    // --- RETRIEVE: the reader returns the same bytes -----------------------
    const retrieved = await retrieveCredential(sentinel.target)
    const roundTrip = retrieved !== null && retrieved.equals(sentinel.value)
    retrieved?.fill(0)
    log(`  [3] round trip        : reader returned the same value = ${String(roundTrip)}`)

    // --- RC-5 SUCCESS PATH -------------------------------------------------
    const successRun = await runConsumerWithDelivery(sentinel.target, 'success', outDir)
    consumerResolved = successRun.resolved
    const afterSuccess = await readPersistentEnvironment(AUDITOR_ENV_VAR_NAME)
    const parentCleanAfterSuccess = process.env[AUDITOR_ENV_VAR_NAME] === undefined
    successPathRemoved = !afterSuccess.user && !afterSuccess.machine && parentCleanAfterSuccess
    log(
      `  [4] success path      : consumer exit=${String(successRun.exitCode)} resolved=${String(successRun.resolved)} ` +
        `removed=${String(successPathRemoved)}`
    )

    // --- RC-5 FAILURE PATH: a REAL consumer failure, after it resolved -----
    const failRun = await runConsumerWithDelivery(sentinel.target, 'fail-after-resolve', outDir)
    const afterFail = await readPersistentEnvironment(AUDITOR_ENV_VAR_NAME)
    const parentCleanAfterFail = process.env[AUDITOR_ENV_VAR_NAME] === undefined
    failurePathRemoved =
      failRun.exitCode === 1 &&
      failRun.resolved &&
      !afterFail.user &&
      !afterFail.machine &&
      parentCleanAfterFail
    log(
      `  [5] failure path      : consumer exit=${String(failRun.exitCode)} resolved-before-failing=${String(failRun.resolved)} ` +
        `removed=${String(failurePathRemoved)}`
    )

    // --- THE SAME CHECK, NEGATIVE: consumer with no delivery ---------------
    const absentRun = await runConsumerWithoutDelivery(outDir)
    const variableCheckCapableOfFalse = consumerResolved && !absentRun.resolved
    log(
      `  [6] variable check    : resolves with delivery=${String(consumerResolved)} / ` +
        `without delivery=${String(absentRun.resolved)}`
    )

    // --- RC-2: a shell OUTSIDE this process tree ---------------------------
    const outside = await observeFromOutsideProcessTree(AUDITOR_ENV_VAR_NAME)
    const persistent = await readPersistentEnvironment(AUDITOR_ENV_VAR_NAME)
    freshShellAbsent =
      !outside.present && outside.parentIsNotThisTree && !persistent.user && !persistent.machine
    log(
      `  [7] fresh shell       : out-of-tree probe present=${String(outside.present)} ` +
        `parent-not-ours=${String(outside.parentIsNotThisTree)} ` +
        `persistent user=${String(persistent.user)} machine=${String(persistent.machine)}`
    )

    // --- RC-4: history sinks -----------------------------------------------
    const sinks = await enumerateHistorySinks()
    historySinkNames = sinks.map((s) => `${s.name} [${s.kind}]${s.exists ? '' : ' (absent)'}`)
    const sinkSearch = searchFileSinks(sinks, sentinel.value)
    historyClean = sinkSearch.clean
    log(`  [8] history sinks     : ${sinks.length} enumerated, clean=${String(historyClean)}`)

    // --- CLEANUP, then RC-6 POSITIVE: the check must report ABSENT ---------
    const deleted = await removeCredential(sentinel.target)
    checkAbsentAfterRemoval = !(await probeCredential(sentinel.target))
    log(
      `  [9] cleanup           : deleted=${String(deleted)} absence-check-after=${String(checkAbsentAfterRemoval)}`
    )

    // --- RC-3: stop the external observer and search every command line ----
    observerStopped = true
    const observation = await observer.stop()
    const needle = sentinel.value.toString('utf8')
    const offenders = observation.processes.filter((p) => p.cmd !== null && p.cmd.includes(needle))
    commandLinesClean = offenders.length === 0
    observedProcessNames = Array.from(
      new Set(observation.processes.filter((p) => p.cmd !== null).map((p) => p.name))
    ).sort()

    // The child topology actually observed, by transitive parentage from this
    // process. RC-7 asks for children OBSERVED, never children believed.
    const byPid = new Map(observation.processes.map((p) => [p.pid, p]))
    const ours = new Set<number>([process.pid])
    let grew = true
    while (grew) {
      grew = false
      for (const p of byPid.values()) {
        if (!ours.has(p.pid) && ours.has(p.ppid)) {
          ours.add(p.pid)
          grew = true
        }
      }
    }
    // RC-7 asks for THE CONSUMING PROCESS's children. The harness tree is a
    // superset — it also holds the bridge invocations, the observers and the
    // runtime's own esbuild workers — so the two are reported separately
    // rather than as one list in which the answer to the question asked is
    // mixed with eleven processes that are not it.
    const consumerPids = new Set(
      observation.processes
        .filter((p) => p.cmd !== null && p.cmd.includes('n05-sentinel-consumer'))
        .map((p) => p.pid)
    )
    const consumerDescendants = new Set(consumerPids)
    let grewConsumer = true
    while (grewConsumer) {
      grewConsumer = false
      for (const p of byPid.values()) {
        if (!consumerDescendants.has(p.pid) && consumerDescendants.has(p.ppid)) {
          consumerDescendants.add(p.pid)
          grewConsumer = true
        }
      }
    }
    const describe = (pid: number): string => {
      const p = byPid.get(pid)
      return `${p?.name ?? 'unknown'} (pid ${pid}, parent ${p?.ppid ?? -1})`
    }
    const consumerChildren = Array.from(consumerDescendants)
      .filter((pid) => !consumerPids.has(pid))
      .map(describe)
      .sort()
    const harnessOnly = Array.from(ours)
      .filter((pid) => pid !== process.pid && !consumerDescendants.has(pid))
      .map(describe)
      .sort()

    // conhost.exe is the console host the Windows console subsystem attaches to
    // a console application. It is created by the subsystem rather than by the
    // application passing its environment block, and it is therefore carried as
    // a DECLARED EXCEPTION with its reason stated, not silently filtered. Any
    // OTHER child is an env-inheriting child until shown otherwise, because
    // Node and the Win32 default is to inherit.
    envInheritingChildren = consumerChildren.filter((c) => !c.startsWith('conhost.exe'))

    childTopology = [
      `CONSUMING PROCESSES OBSERVED: ${consumerPids.size}. Three runs were launched — success, ` +
        'fail-after-resolve and the no-delivery negative exercise — and the count above is what ' +
        'the external observer actually saw, not what was launched.',
      consumerChildren.length === 0
        ? 'CHILDREN OF THE CONSUMING PROCESS: NONE OBSERVED, over the whole run, by an external ' +
          'observer. Not a reading of the consumer source.'
        : `CHILDREN OF THE CONSUMING PROCESS (${consumerChildren.length}): ${consumerChildren.join('; ')}.`,
      envInheritingChildren.length === 0
        ? 'ENVIRONMENT-INHERITING CHILDREN: NONE. The consumer resolves one environment variable, ' +
          'opens no socket, spawns no tool and loads no dotenv reader. The only children observed ' +
          'are console hosts, which the Windows console subsystem attaches to a console ' +
          'application rather than the application handing them its environment block. That ' +
          'exception is declared here rather than filtered out silently.'
        : `ENVIRONMENT-INHERITING CHILDREN (${envInheritingChildren.length}): ` +
          `${envInheritingChildren.join('; ')}. WCM-C1's scope is "the single command that ` +
          'consumes it", and each of these holds the value in its own environment block for its ' +
          'lifetime. RC-7 fires STOP_SECRET_DELIVERY_NONCOMPLIANT on this ground.',
      'MEASURED FINDING, CARRIED FORWARD RATHER THAN ONLY FIXED: the FIRST version of this ' +
        'demonstration ran the consumer through the tsx TypeScript runtime, and the external ' +
        'observation showed esbuild.exe as a child of the consuming process. tsx starts esbuild ' +
        'as a helper service and Node inherits the parent environment by default, so a bundler ' +
        'worker held the delivered value. The consumer source spawns nothing; the runtime ' +
        'underneath it did — which is precisely what RC-7 says a source reading cannot see. The ' +
        'demonstration now transpiles the consumer ahead of time and runs it under bare node, ' +
        'and the finding is recorded because it generalises: the production invocation must not ' +
        'deliver the real credential into a process running under a development runtime either.',
      `REST OF THE DEMONSTRATION TREE (${harnessOnly.length}, NOT children of the consumer): ` +
        `${harnessOnly.join('; ')}. These are the harness, its PowerShell bridge and observer ` +
        'invocations, and the console hosts attached to them. None is ever given the variable: ' +
        'the bridge receives an allowlisted environment that does not contain it, and the ' +
        'observers receive no environment from this module at all.',
    ]
    log(
      `  [10] command lines    : ${observation.readableCommandLines} readable across ` +
        `${observation.pollCount} polls, sentinel found in ${offenders.length}`
    )

    // --- CLEANUP VERIFICATION ----------------------------------------------
    const remaining = await sweepCredentials(SENTINEL_TARGET_PREFIX)
    const sweepClean = remaining.length === 0
    log(`  [11] sweep            : ${remaining.length} sentinel entries remain`)

    // --- RC-8 ---------------------------------------------------------------
    const audit = await describeVaultReadAuditSurface()

    // --- OUTCOMES -----------------------------------------------------------
    outcomes.NP9_FRESH_SHELL_ABSENT = freshShellAbsent ? 'PASSED' : 'FAILED'
    // A clean command-line sweep that never saw the consuming process has
    // observed the wrong thing. RC-3 names the three processes the observation
    // must cover, and the consuming process is one of them.
    const observedTheConsumer = consumerPids.size > 0
    outcomes.NP10_EXTERNAL_COMMAND_LINE_CLEAN =
      commandLinesClean && observation.readableCommandLines > 0 && observedTheConsumer
        ? 'PASSED'
        : 'FAILED'
    outcomes.NP11_BOTH_REMOVAL_PATHS_EXERCISED =
      successPathRemoved && failurePathRemoved ? 'PASSED' : 'FAILED'
    outcomes.NP12_ABSENCE_CHECK_PROVEN_CAPABLE_OF_FALSE =
      checkPresentWhenPresent && checkAbsentAfterRemoval && variableCheckCapableOfFalse
        ? 'PASSED'
        : 'FAILED'
    outcomes.RC2_CONSUMER_RESOLVED_VALUE = consumerResolved && roundTrip ? 'PASSED' : 'FAILED'
    outcomes.RC3_DEPOSIT_ARGV_CLEAN = commandLinesClean ? 'PASSED' : 'FAILED'
    outcomes.RC4_HISTORY_SINKS_CLEAN = historyClean ? 'PASSED' : 'FAILED'
    outcomes.RC6_VAULT_ENTRY_ABSENT_AFTER_CLEANUP =
      checkAbsentAfterRemoval && sweepClean ? 'PASSED' : 'FAILED'
    outcomes.RC7_CONSUMER_SPAWNS_NO_ENV_INHERITING_CHILD =
      observedTheConsumer && envInheritingChildren.length === 0 ? 'PASSED' : 'FAILED'

    const summary = summarizeN05Controls(outcomes)

    const record: N05EvidenceRecord = {
      mechanism_named_by_behaviour: MECHANISM_NAME,
      sentinel_freshly_generated: true,
      wcm_c1_fresh_shell_absent: freshShellAbsent,
      wcm_c2_external_command_line_observation_clean: commandLinesClean,
      wcm_c2_processes_observed: observedProcessNames,
      wcm_c3_history_sinks_enumerated: historySinkNames,
      wcm_c3_all_sinks_clean: historyClean,
      wcm_c3_invocation_contract_enforcement:
        'ENFORCED BY CONSTRUCTION, not by configuration. db/custody/wcm-credential-store.ts ' +
        'builds the PowerShell argv in bridgeArgv(), which is a pure function of nothing and ' +
        'takes no caller input; there is no parameter through which -NonInteractive could be ' +
        'dropped, the profile re-enabled, or a -Command carrying a value appended. The value ' +
        'itself never enters a command line, a script block or an interactive prompt, so a ' +
        'session with every history facility enabled still records no secret. The session ' +
        'property is therefore a property of every future invocation rather than of this run.',
      wcm_c4_success_path_removed: successPathRemoved,
      wcm_c4_failure_path_removed: failurePathRemoved,
      wcm_c4_abrupt_termination_behaviour:
        'STATED, not offered as a pass criterion, per RC-5s derived gap. Two surfaces behave ' +
        'differently under a kill. THE VARIABLE is safe unconditionally: it exists only in the ' +
        'consuming child process environment block, which the operating system destroys on ' +
        'process exit however that exit occurs, so no teardown has to run and none is relied ' +
        'on. THE VAULT ENTRY is NOT safe: it is CRED_PERSIST_LOCAL_MACHINE by design, because ' +
        'the depositor and the reader are different runs, so a process killed between deposit ' +
        'and cleanup leaves the entry behind. The recovery path is sweepCredentials() over the ' +
        'reserved prefix, which this harness runs both before and after every demonstration ' +
        'and whose after-run result is verified empty. For the REAL credential no equivalent ' +
        'sweep exists or should: removing the real entry is the rotation act N28 governs.',
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
    if (!observerStopped) {
      try {
        await observer.stop()
      } catch {
        /* the observation is already lost; the sweep below is what matters */
      }
    }
    // The observer dump holds every command line on the machine for the
    // duration of the run. It is not supposed to contain the sentinel — that
    // is the whole finding — but it is deleted regardless, because keeping a
    // machine-wide command-line capture around is its own disclosure.
    for (const f of ['observer.json', 'observer.stop']) {
      const p = join(outDir, f)
      if (existsSync(p)) rmSync(p, { force: true })
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
