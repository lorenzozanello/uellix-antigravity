// scripts/db-audit-disposable.ts — ODS-ACCEL-03 PHASE A, the disposable
// PostgreSQL audit harness.
//
//   pnpm db:audit:disposable -- --setup <path> --probe <path> [--image <img>] [--json]
//
// Lifecycle, unconditionally: CREATE -> APPLY SUBSTRATE -> RUN PROBES ->
// CAPTURE RESULT -> DESTROY -> VERIFY NO LEFTOVERS. Teardown runs in a
// `finally` block reached from every failure branch after the container was
// created — a setup failure, a probe failure, or an unexpected throw all
// still tear the container down; only a failure to CREATE the container in
// the first place skips teardown (there is nothing to tear down yet).
//
// SAFETY: the harness never accepts a caller-supplied connection URL. It
// generates its own container (Docker, `-p 127.0.0.1:0:5432`, ephemeral
// host-assigned port, no volumes), so the "prove locality before mutation"
// requirement is checked against a URL this harness itself just constructed
// from values it just discovered (the assigned port) or generated (the
// disposable database name and password) — see
// db/safety/disposable-audit-target.ts. That check runs BEFORE the first
// mutating statement (`CREATE DATABASE`) and again before running any
// caller-supplied setup/probe SQL against the disposable database itself.
//
// No shell: every Docker invocation goes through spawnSync with an argument
// array, never a shell string — avoiding both injection and Windows
// cmd.exe quoting hazards.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { assertDisposableTargetSafe, generateDisposableIdentity, type DisposableSafetyCheck } from '../db/safety/disposable-audit-target'
import type { DatabaseTargetKind } from '../db/safety/database-target'

// ---------------------------------------------------------------------------
// Process execution — injectable so the orchestrator is testable with mocks.
// ---------------------------------------------------------------------------

export interface ProcessResult {
  status: number
  stdout: string
  stderr: string
}

export interface DockerRunner {
  run(args: string[], input?: string): ProcessResult
}

export const realDockerRunner: DockerRunner = {
  run(args: string[], input?: string): ProcessResult {
    const res = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 })
    return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  },
}

// ---------------------------------------------------------------------------
// Pure helpers: Docker output parsing, redaction, manifest loading.
// ---------------------------------------------------------------------------

/** `docker port <name> 5432/tcp` prints e.g. "127.0.0.1:54821". Never trusts 0.0.0.0 — this harness only ever publishes to 127.0.0.1. */
export function parseAssignedPort(dockerPortStdout: string): number | null {
  const match = dockerPortStdout.trim().match(/^127\.0\.0\.1:(\d+)$/m)
  return match ? Number(match[1]) : null
}

/** Replaces every verbatim occurrence of `secret` in `text` — used before any Docker stdout/stderr reaches the outcome object or console. Plain split/join, not regex, so no escaping hazard from special characters in a generated password. */
export function redactSecret(text: string, secret: string): string {
  if (!secret) return text
  return text.split(secret).join('[REDACTED]')
}

/**
 * `docker inspect -f '{{json .Mounts}}' <container>` output.
 *
 * The official `postgres` image declares `VOLUME /var/lib/postgresql/data`
 * in its Dockerfile — Docker auto-creates an ANONYMOUS volume for it on
 * every `docker run`, even with no `-v`/`--mount` flag at all (measured
 * directly: postgres:16-alpine always reports exactly one mount of type
 * "volume"). That is expected and safe as long as teardown removes it too
 * (`docker rm -f -v`, not plain `-f`) — what must never appear is a "bind"
 * mount, which would mean this throwaway container can read or write the
 * HOST filesystem.
 */
export function hasOnlyAcceptableMounts(mountsJson: string): boolean {
  try {
    const mounts = JSON.parse(mountsJson) as Array<{ Type?: string }>
    if (!Array.isArray(mounts)) return false
    return mounts.every((m) => m.Type === 'volume')
  } catch {
    return false
  }
}

export interface SetupManifest {
  statements: string[]
}

export interface ProbeManifest {
  probes: Array<{ id: string; sql: string }>
}

/** Pure: `.sql` content becomes one statement; `.json` content must already be `{statements: string[]}`. */
export function parseSetupManifestContent(raw: string, isJson: boolean): SetupManifest {
  if (!isJson) return { statements: [raw] }
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as SetupManifest).statements)) {
    throw new Error('setup manifest JSON must be shaped {"statements": string[]}')
  }
  return parsed as SetupManifest
}

/** Pure: `.sql` content becomes one probe named "default"; `.json` content must already be `{probes: [{id, sql}]}`. */
export function parseProbeManifestContent(raw: string, isJson: boolean): ProbeManifest {
  if (!isJson) return { probes: [{ id: 'default', sql: raw }] }
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as ProbeManifest).probes)) {
    throw new Error('probe manifest JSON must be shaped {"probes": [{"id": string, "sql": string}]}')
  }
  return parsed as ProbeManifest
}

export function loadSetupManifest(filePath: string): SetupManifest {
  const raw = readFileSync(filePath, 'utf8')
  return parseSetupManifestContent(raw, path.extname(filePath) === '.json')
}

export function loadProbeManifest(filePath: string): ProbeManifest {
  const raw = readFileSync(filePath, 'utf8')
  return parseProbeManifestContent(raw, path.extname(filePath) === '.json')
}

// ---------------------------------------------------------------------------
// Lifecycle types.
// ---------------------------------------------------------------------------

export type LifecycleState =
  | 'NOT_STARTED'
  | 'CREATED'
  | 'SUBSTRATE_APPLIED'
  | 'PROBES_COMPLETED'
  | 'TEARDOWN_STARTED'
  | 'DESTROYED'
  | 'VERIFIED_GONE'

export type StepStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'NOT_ATTEMPTED'
export type ProbeAggregateStatus = 'ALL_PASSED' | 'SOME_FAILED' | 'SKIPPED'

export interface ProbeResult {
  id: string
  ok: boolean
  detail?: string
}

export interface HarnessOutcome {
  lifecycleState: LifecycleState
  harnessStatus: 'SUCCESS' | 'FAILED'
  targetKind: DatabaseTargetKind | null
  targetLocality: 'LOCAL' | 'NOT_LOCAL' | 'UNKNOWN'
  databaseId: string
  setupStatus: StepStatus
  probeStatus: ProbeAggregateStatus
  probeCount: number
  probeFailureCount: number
  probeResults: ProbeResult[]
  teardownStatus: StepStatus
  leftoverDatabaseCount: number
  failureReason: string | null
}

export interface HarnessOptions {
  image: string
  setup?: SetupManifest
  probe?: ProbeManifest
  containerReadyAttempts?: number
}

export interface HarnessDeps {
  runner: DockerRunner
  randomUUID: () => string
  randomPassword: () => string
  sleepMs: (ms: number) => void
}

export const realHarnessDeps: HarnessDeps = {
  runner: realDockerRunner,
  randomUUID: () => randomUUID(),
  randomPassword: () => randomBytes(24).toString('hex'),
  sleepMs: (ms: number) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* busy-wait: this harness has no async runtime around it and the wait is short (readiness polling only) */
    }
  },
}

// ---------------------------------------------------------------------------
// Orchestration. Every Docker call goes through `deps.runner`, so this whole
// function is exercisable with a mock in tests, and only one real-Docker
// integration test needs to drive the actual binary.
// ---------------------------------------------------------------------------

export function runDisposableHarness(options: HarnessOptions, deps: HarnessDeps = realHarnessDeps): HarnessOutcome {
  const { runner, randomUUID: genUUID, randomPassword, sleepMs } = deps
  const identity = generateDisposableIdentity(genUUID)
  const password = randomPassword()

  let lifecycleState: LifecycleState = 'NOT_STARTED'
  let containerCreated = false
  let targetKind: DatabaseTargetKind | null = null
  let targetLocality: 'LOCAL' | 'NOT_LOCAL' | 'UNKNOWN' = 'UNKNOWN'
  let setupStatus: StepStatus = 'SKIPPED'
  let probeStatus: ProbeAggregateStatus = 'SKIPPED'
  const probeResults: ProbeResult[] = []
  let failureReason: string | null = null

  const redact = (text: string) => redactSecret(text, password)
  const fail = (reason: string) => {
    failureReason = failureReason ?? redact(reason)
  }

  try {
    const created = runner.run([
      'run',
      '-d',
      '--name',
      identity.containerName,
      '-p',
      '127.0.0.1:0:5432',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=password',
      '-e',
      'POSTGRES_DB=postgres',
      options.image,
    ])
    if (created.status !== 0) {
      fail(`failed to create disposable container: ${redact(created.stderr || created.stdout)}`)
      return finish()
    }
    containerCreated = true
    lifecycleState = 'CREATED'

    // No BIND mounts (host filesystem exposure): proven against the real
    // container, not merely absent from the command that created it. An
    // anonymous "volume" mount from the image's own Dockerfile is expected
    // and is removed at teardown via `docker rm -f -v`.
    const mounts = runner.run(['inspect', '-f', '{{json .Mounts}}', identity.containerName])
    if (mounts.status !== 0 || !hasOnlyAcceptableMounts(mounts.stdout)) {
      fail(`disposable container carries an unexpected mount (expected only anonymous "volume" mounts, never "bind"): ${redact(mounts.stdout || mounts.stderr)}`)
      return finish()
    }

    const attempts = options.containerReadyAttempts ?? 30
    let ready = false
    for (let i = 0; i < attempts; i++) {
      const check = runner.run(['exec', identity.containerName, 'pg_isready', '-U', 'postgres'])
      if (check.status === 0) {
        ready = true
        break
      }
      sleepMs(250)
    }
    if (!ready) {
      fail('disposable container never reported ready (pg_isready did not succeed in time)')
      return finish()
    }

    const portResult = runner.run(['port', identity.containerName, '5432/tcp'])
    const assignedPort = portResult.status === 0 ? parseAssignedPort(portResult.stdout) : null
    if (assignedPort === null) {
      fail('could not determine the assigned host port for the disposable container')
      return finish()
    }

    const adminUrl = `postgresql://postgres:${password}@127.0.0.1:${assignedPort}/postgres`
    const adminCheck = assertDisposableTargetSafe(adminUrl, { requireDisposableDbName: false })
    recordTarget(adminCheck)
    if (!adminCheck.ok) {
      fail(`refusing to mutate: ${redact(adminCheck.reason ?? 'unsafe target')}`)
      return finish()
    }

    const createDb = runner.run(['exec', '-i', identity.containerName, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-c', `CREATE DATABASE ${identity.dbName};`])
    if (createDb.status !== 0) {
      fail(`failed to create disposable database: ${redact(createDb.stderr || createDb.stdout)}`)
      return finish()
    }

    const finalUrl = `postgresql://postgres:${password}@127.0.0.1:${assignedPort}/${identity.dbName}`
    const finalCheck = assertDisposableTargetSafe(finalUrl, { expectDatabaseName: identity.dbName })
    recordTarget(finalCheck)
    if (!finalCheck.ok) {
      fail(`refusing to run setup/probes: ${redact(finalCheck.reason ?? 'unsafe target')}`)
      return finish()
    }

    if (options.setup) {
      let setupFailed = false
      for (const statement of options.setup.statements) {
        const res = runner.run(['exec', '-i', identity.containerName, 'psql', '-U', 'postgres', '-d', identity.dbName, '-v', 'ON_ERROR_STOP=1', '-q'], statement)
        if (res.status !== 0) {
          setupFailed = true
          fail(`setup statement failed: ${redact(res.stderr || res.stdout)}`)
          break
        }
      }
      setupStatus = setupFailed ? 'FAILED' : 'SUCCESS'
      lifecycleState = 'SUBSTRATE_APPLIED'
      if (setupFailed) return finish()
    } else {
      lifecycleState = 'SUBSTRATE_APPLIED'
    }

    if (options.probe) {
      for (const probe of options.probe.probes) {
        const res = runner.run(['exec', '-i', identity.containerName, 'psql', '-U', 'postgres', '-d', identity.dbName, '-v', 'ON_ERROR_STOP=1', '-q'], probe.sql)
        const ok = res.status === 0
        probeResults.push({ id: probe.id, ok, detail: ok ? undefined : redact(res.stderr || res.stdout).trim().slice(0, 500) })
      }
      const failures = probeResults.filter((p) => !p.ok).length
      probeStatus = failures === 0 ? 'ALL_PASSED' : 'SOME_FAILED'
    }
    lifecycleState = 'PROBES_COMPLETED'
    return finish()
  } catch (error) {
    fail(`unexpected error: ${redact(error instanceof Error ? error.message : String(error))}`)
    return finish()
  }

  // -------------------------------------------------------------------------
  function recordTarget(check: DisposableSafetyCheck): void {
    targetKind = check.target.kind
    targetLocality = check.target.kind === 'local_loopback' || check.target.kind === 'local_container' ? 'LOCAL' : 'NOT_LOCAL'
  }

  // Teardown ALWAYS runs here if a container was created — this is the one
  // and only path every branch above funnels through (`return finish()`),
  // so a probe/setup failure or an unexpected throw can never skip it. See
  // tests/ods/db-audit-disposable.test.ts's teardown-guarantee control.
  function finish(): HarnessOutcome {
    let teardownStatus: StepStatus = 'NOT_ATTEMPTED'
    let leftoverDatabaseCount = 0

    if (containerCreated) {
      lifecycleState = 'TEARDOWN_STARTED'
      // `-v` also removes the anonymous volume Docker auto-created for the
      // image's declared VOLUME — without it that volume would outlive the
      // container as a real (if invisible) leftover. See hasOnlyAcceptableMounts.
      const removed = runner.run(['rm', '-f', '-v', identity.containerName])
      teardownStatus = removed.status === 0 ? 'SUCCESS' : 'FAILED'
      if (teardownStatus === 'SUCCESS') lifecycleState = 'DESTROYED'
      else fail(`teardown failed: ${redact(removed.stderr || removed.stdout)}`)

      const check = runner.run(['ps', '-a', '--filter', `name=^${identity.containerName}$`, '--format', '{{.Names}}'])
      leftoverDatabaseCount = check.status === 0 && check.stdout.trim().length > 0 ? 1 : check.status === 0 ? 0 : 1
      if (leftoverDatabaseCount > 0) fail('disposable container still present after teardown')
      else if (teardownStatus === 'SUCCESS') lifecycleState = 'VERIFIED_GONE'
    }

    const probeCount = options.probe?.probes.length ?? 0
    const probeFailureCount = probeResults.filter((p) => !p.ok).length
    const harnessStatus: 'SUCCESS' | 'FAILED' =
      failureReason === null && setupStatus !== 'FAILED' && probeStatus !== 'SOME_FAILED' && teardownStatus !== 'FAILED' && leftoverDatabaseCount === 0
        ? 'SUCCESS'
        : 'FAILED'

    return {
      lifecycleState,
      harnessStatus,
      targetKind,
      targetLocality,
      databaseId: identity.dbName,
      setupStatus,
      probeStatus,
      probeCount,
      probeFailureCount,
      probeResults,
      teardownStatus,
      leftoverDatabaseCount,
      failureReason,
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const DEFAULT_IMAGE = 'postgres:16-alpine'

interface CliArgs {
  setupPath?: string
  probePath?: string
  image: string
  json: boolean
}

const RECOGNIZED_FLAGS = new Set(['--setup', '--probe', '--image', '--json'])

function looksLikeMissingOperand(token: string | undefined): boolean {
  return token === undefined || token === '--' || RECOGNIZED_FLAGS.has(token)
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { image: DEFAULT_IMAGE, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--json') {
      args.json = true
      continue
    }
    if (!RECOGNIZED_FLAGS.has(arg)) {
      console.error(`db:audit:disposable: unrecognized argument "${arg}"`)
      process.exit(2)
    }
    const value = argv[i + 1]
    if (looksLikeMissingOperand(value)) {
      console.error(`db:audit:disposable: ${arg} requires a value`)
      process.exit(2)
    }
    i++
    if (arg === '--setup') args.setupPath = value
    else if (arg === '--probe') args.probePath = value
    else if (arg === '--image') args.image = value
  }
  return args
}

function stableStringify(outcome: HarnessOutcome): string {
  const ordered = {
    HARNESS_STATUS: outcome.harnessStatus,
    TARGET_KIND: outcome.targetKind,
    TARGET_LOCALITY: outcome.targetLocality,
    DATABASE_ID: outcome.databaseId,
    SETUP_STATUS: outcome.setupStatus,
    PROBE_STATUS: outcome.probeStatus,
    PROBE_COUNT: outcome.probeCount,
    PROBE_FAILURE_COUNT: outcome.probeFailureCount,
    TEARDOWN_STATUS: outcome.teardownStatus,
    LEFTOVER_DATABASE_COUNT: outcome.leftoverDatabaseCount,
    LIFECYCLE_STATE: outcome.lifecycleState,
    FAILURE_REASON: outcome.failureReason,
    PROBE_RESULTS: outcome.probeResults,
  }
  return JSON.stringify(ordered, null, 2)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const cwd = process.cwd()

  let setup: SetupManifest | undefined
  let probe: ProbeManifest | undefined
  try {
    if (args.setupPath) {
      const p = path.isAbsolute(args.setupPath) ? args.setupPath : path.join(cwd, args.setupPath)
      if (!existsSync(p)) throw new Error(`--setup path does not exist: ${args.setupPath}`)
      setup = loadSetupManifest(p)
    }
    if (args.probePath) {
      const p = path.isAbsolute(args.probePath) ? args.probePath : path.join(cwd, args.probePath)
      if (!existsSync(p)) throw new Error(`--probe path does not exist: ${args.probePath}`)
      probe = loadProbeManifest(p)
    }
  } catch (error) {
    console.error(`db:audit:disposable: ${error instanceof Error ? error.message : String(error)}`)
    console.log('HARNESS_STATUS=USAGE_ERROR')
    process.exit(2)
  }

  const outcome = runDisposableHarness({ image: args.image, setup, probe })

  if (args.json) {
    console.log(stableStringify(outcome))
  } else {
    console.log(`HARNESS_STATUS=${outcome.harnessStatus}`)
    console.log(`TARGET_KIND=${outcome.targetKind}`)
    console.log(`TARGET_LOCALITY=${outcome.targetLocality}`)
    console.log(`DATABASE_ID=${outcome.databaseId}`)
    console.log(`SETUP_STATUS=${outcome.setupStatus}`)
    console.log(`PROBE_STATUS=${outcome.probeStatus}`)
    console.log(`PROBE_COUNT=${outcome.probeCount}`)
    console.log(`PROBE_FAILURE_COUNT=${outcome.probeFailureCount}`)
    console.log(`TEARDOWN_STATUS=${outcome.teardownStatus}`)
    console.log(`LEFTOVER_DATABASE_COUNT=${outcome.leftoverDatabaseCount}`)
    console.log(`LIFECYCLE_STATE=${outcome.lifecycleState}`)
    if (outcome.failureReason) console.log(`FAILURE_REASON=${outcome.failureReason}`)
  }
  process.exit(outcome.harnessStatus === 'SUCCESS' ? 0 : 1)
}

// Only when run as a script — tests/ods/db-audit-disposable.test.ts imports
// the pure/injectable functions above. See scripts/authority-seal-verify.ts
// for why argv is checked rather than `import.meta.url`.
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/db-audit-disposable.ts')

if (invokedDirectly) main()
