// scripts/custody/d1-scram-disposable-proof.ts
//
//   pnpm custody:scram:disposable-proof -- --container=<name> --out-dir=<OUTSIDE the repository>
//
// THE SCRAM-VERIFIER TRANSPORT, PROVED ON A DISPOSABLE POSTGRESQL (owner
// decision N11_PASSWORD_TRANSPORT, AC-7; manifest amendment v1.0.1 R2-P-1..5,
// R2-N-LEAK-CLASSES, R2-N-WRONG-PASSWORD, R2-N-NOT-A-VERIFIER, R2-N-STARTUP).
//
// It refuses any container that does not carry the label uellix.d1r2=disposable
// and connects only to loopback (localhost, the port published on 127.0.0.1). It never
// touches a hosted database.
//
// What it does:
//   1. Arms every emitter the recertification of 979b1440 measured quoting the
//      nested EXECUTE (log_parser_stats/planner/executor, log_lock_waits with a
//      REAL lock wait on pg_authid (SHARE held across the ALTER), a pg_tle passcheck hook
//      that logs what it is handed, log_statement=all with bind parameters,
//      debug_print_*, auto_explain nested at 0ms, pg_stat_statements track=all
//      + utility, pgaudit log=all + log_parameter, verbose error context).
//   2. Runs the REAL pinned mint tool (sha256 checked) with the REAL route-B
//      driver (digest checked) against it, as the operator principal, with a
//      proof depositor that hands the synthetic plaintext back to this script.
//   3. Proves: the stored rolpassword IS a valid SCRAM-SHA-256 verifier of that
//      plaintext; the plaintext authenticates over SCRAM; a wrong password and
//      the verifier used as a password do not; the plaintext occurs ZERO times in
//      the server log and in pg_stat_statements, while the verifier (derived
//      material, classified separately) DOES occur where each emitter quotes the
//      statement — so every emitter was active during the ALTER.
//   4. Server authentication (R3, owner AC-8): the container serves a synthetic
//      certificate for `localhost` issued by a synthetic CA; the tool is given that
//      CA pinned by sha256 and verifies the server (verify-full), and a tool given
//      ANOTHER CA is refused by TLS before any startup message. The governed
//      project certificate is not used here: this is not the project's server.
//   5. Controls: the 979b1440 route (plaintext through set_config) against a
//      separate control role puts its plaintext in the same log (the search can
//      find one); the guarded DO block refuses a non-verifier before ALTER ROLE;
//      the tool refuses an operator URL carrying startup parameters.
//
// The record carries booleans and counts only: never a plaintext, a verifier or
// a password. The plaintext of this run is synthetic, for a disposable role in a
// disposable container, and is dropped when the script exits.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import postgres from 'postgres'
import { OPERATOR_ENV_VAR_NAME, driverDigest } from '../../db/custody/mint-operator-channel'
import { ROUTE_B_DATABASE, ROUTE_B_ROLE, ROUTE_B_STATEMENTS } from '../../db/custody/mint-route-b-contract'
import { parseVerifier, verifierMatches } from '../../db/custody/scram-verifier'
import { isInsideRepositoryTree } from './build-sentinel-consumer'
import { defaultToolsDir, readChannelBinding } from './d1-mint-operator-evidence'
import { routeBDriver } from './d1-mint-operator-plan'
import { syntheticCa, syntheticLeaf } from './synthetic-x509'
import { deriveEffectiveSchedule } from './d1-effective-schedule'

type State = 'PASSED' | 'FAILED'
const pf = (b: boolean): State => (b ? 'PASSED' : 'FAILED')

export const DISPOSABLE_LABEL = 'uellix.d1r2=disposable'
const CONTROL_ROLE = 'uellix_d1r2_control'
/**
 * The negative control's value and the guard's non-verifier are PUBLIC CONSTANTS, not generated
 * secrets: this script generates no credential (the repository-hosted live-mint detector holds for
 * it). The only generated value is the pinned OUTSIDE tool's. The log window of each run starts at
 * that run, so a constant sentinel cannot be matched from an earlier run.
 */
export const CONTROL_PLAINTEXT_SENTINEL = 'D1R2-CONTROL-SENTINEL-OF-THE-979B1440-ROUTE'
export const NON_VERIFIER_SENTINEL = 'D1R2-NOT-A-VERIFIER-SENTINEL'
const OPERATOR = 'postgres'

/** The 979b1440 route (plaintext through set_config), reproduced ONLY as the negative control. */
const OLD_ROUTE_B = {
  SET_PASSWORD: "SELECT set_config('uellix.rotating_password', $1, true)",
  DO_BLOCK: [
    'DO $rotate$',
    'BEGIN',
    '  EXECUTE format(',
    "    'ALTER ROLE %I PASSWORD %L VALID UNTIL %L',",
    "    current_setting('uellix.rotating_role'),",
    "    current_setting('uellix.rotating_password'),",
    "    current_setting('uellix.rotating_valid_until')",
    '  );',
    'EXCEPTION WHEN OTHERS THEN',
    "  RAISE EXCEPTION USING ERRCODE = SQLSTATE, MESSAGE = 'D1_CREDENTIAL_SET_FAILED';",
    'END',
    '$rotate$',
  ].join('\n'),
} as const

/** Role-level emitters for the operator principal (so they apply to the tool's session). */
export const OPERATOR_ROLE_EMITTERS: ReadonlyArray<readonly [string, string]> = [
  ['log_statement', 'all'],
  ['log_min_duration_statement', '0'],
  ['log_min_error_statement', 'debug5'],
  ['log_error_verbosity', 'verbose'],
  ['log_parser_stats', 'on'],
  ['log_planner_stats', 'on'],
  ['log_executor_stats', 'on'],
  ['debug_print_parse', 'on'],
  ['debug_print_rewritten', 'on'],
  ['debug_print_plan', 'on'],
  ['log_lock_waits', 'on'],
  ['deadlock_timeout', '100ms'],
  ['auto_explain.log_min_duration', '0'],
  ['auto_explain.log_nested_statements', 'on'],
  ['pgaudit.log', 'all'],
  ['pgaudit.log_parameter', 'on'],
]
/** Server-wide emitters (ALTER SYSTEM + reload). */
export const SYSTEM_EMITTERS: ReadonlyArray<readonly [string, string]> = [
  ['pg_stat_statements.track', 'all'],
  ['pg_stat_statements.track_utility', 'on'],
  ['pgtle.enable_password_check', 'on'],
  ['log_parameter_max_length', '-1'],
]
const PASSCHECK_MARKER = 'D1R2_PASSCHECK'

/** Markers of each emitter class in the server log. */
export const EMITTER_MARKERS: Readonly<Record<string, string>> = {
  LOCK_WAIT: 'still waiting for',
  PARSER_STATS: 'PARSER STATISTICS',
  PLANNER_STATS: 'PLANNER STATISTICS',
  EXECUTOR_STATS: 'EXECUTOR STATISTICS',
  DEBUG_PRINT_PARSE: 'parse tree:',
  PASSCHECK_HOOK: PASSCHECK_MARKER,
  PGAUDIT: 'AUDIT:',
  LOG_STATEMENT: 'statement:',
  CONTEXT_OF_NESTED_EXECUTE: 'SQL statement "ALTER ROLE',
}

function docker(args: string[], opts: { input?: string } = {}): string {
  return execFileSync('docker', args, { encoding: 'utf8', input: opts.input, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 256 * 1024 * 1024 })
}
function psqlAdmin(container: string, statements: string[]): string {
  const args = ['exec', '-i', container, 'psql', '-U', 'supabase_admin', '-d', ROUTE_B_DATABASE, '-v', 'ON_ERROR_STOP=1', '-At']
  for (const s of statements) args.push('-c', s)
  return docker(args)
}
/** As the operator, inside the container over TCP loopback (trust there), so roles it creates are ITS roles. */
function psqlOperator(container: string, statements: string[]): string {
  const args = ['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', OPERATOR, '-d', ROUTE_B_DATABASE, '-v', 'ON_ERROR_STOP=1', '-At']
  for (const s of statements) args.push('-c', s)
  return docker(args)
}

function count(hay: string, needle: string): number {
  if (needle === '') return 0
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

interface ToolRun {
  readonly exitCode: number | null
  readonly lines: Record<string, unknown>[]
}
function runTool(tool: string, args: string[], operatorUrl: string): Promise<ToolRun> {
  const env = {} as NodeJS.ProcessEnv
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP']) if (process.env[k] !== undefined) env[k] = process.env[k]
  env[OPERATOR_ENV_VAR_NAME] = operatorUrl
  return new Promise((res) => {
    const child = spawn(process.execPath, [tool, ...args], { stdio: ['ignore', 'pipe', 'ignore'], env, windowsHide: false })
    let raw = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      raw += c
    })
    child.on('close', (code) => {
      const lines: Record<string, unknown>[] = []
      for (const l of raw.split(/\r?\n/)) {
        try {
          lines.push(JSON.parse(l) as Record<string, unknown>)
        } catch {
          /* not JSON */
        }
      }
      res({ exitCode: code, lines })
    })
  })
}

/** The proof's own sessions verify the server too: the synthetic CA, rejectUnauthorized, the host name. */
const verifiedSsl = (caPem: string, host: string) => ({ ca: [caPem], rejectUnauthorized: true, servername: host, minVersion: 'TLSv1.2' as const })

async function authOutcome(o: { host: string; port: number; user: string; password: string; caPem: string }): Promise<'AUTHENTICATED' | string> {
  const sql = postgres({ host: o.host, port: o.port, database: ROUTE_B_DATABASE, username: o.user, password: o.password, max: 1, prepare: false, ssl: verifiedSsl(o.caPem, o.host), onnotice: () => undefined, connect_timeout: 10 })
  try {
    const r = await sql`SELECT current_user AS u`
    return r[0]?.u === o.user ? 'AUTHENTICATED' : 'WRONG_IDENTITY'
  } catch (e) {
    return `REFUSED_${(e as { code?: string }).code ?? 'UNKNOWN'}`
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined)
  }
}

export async function prove(root: string, container: string, outDir: string): Promise<{ overall: string; record: Record<string, unknown> }> {
  const out = resolvePath(outDir)
  if (isInsideRepositoryTree(root, out)) throw new Error('--out-dir must be outside the repository.')
  mkdirSync(out, { recursive: true })
  const c: Record<string, State> = {}

  // --- the container must be the labelled disposable one, published on loopback only ---
  const labels = docker(['inspect', container, '--format', '{{json .Config.Labels}}'])
  if (!(JSON.parse(labels) as Record<string, string>)['uellix.d1r2'] || (JSON.parse(labels) as Record<string, string>)['uellix.d1r2'] !== 'disposable') throw new Error(`container ${container} is not labelled ${DISPOSABLE_LABEL}`)
  const mapped = docker(['port', container, '5432/tcp']).trim().split(/\r?\n/)[0] ?? ''
  const m = /^127\.0\.0\.1:(\d+)$/.exec(mapped)
  if (m === null) throw new Error('the disposable container must publish 5432 on 127.0.0.1 only')
  // verify-full needs a NAME: the synthetic server certificate is issued for localhost.
  const host = 'localhost'
  const port = Number(m[1])
  const envLines = docker(['inspect', container, '--format', '{{range .Config.Env}}{{println .}}{{end}}']).split(/\r?\n/)
  const operatorPassword = (envLines.find((l) => l.startsWith('POSTGRES_PASSWORD=')) ?? '').slice('POSTGRES_PASSWORD='.length)
  if (operatorPassword === '') throw new Error('the disposable container carries no POSTGRES_PASSWORD')

  // --- the channel as pinned: the REAL mint tool and the REAL route-B driver ---
  const { binding, reasons } = readChannelBinding(root)
  if (binding === null || reasons.length > 0) throw new Error(`CHANNEL_BINDING unusable: ${reasons.join('; ')}`)
  const tool = join(defaultToolsDir(binding)!, binding.tools.mint.file)
  c.PINNED_MINT_TOOL = pf(createHash('sha256').update(readFileSync(tool)).digest('hex') === binding.tools.mint.sha256)
  const drv = routeBDriver(root)
  if (drv.driverRoot === null) throw new Error(`route-B driver unusable: ${drv.reasons.join('; ')}`)
  c.PINNED_DRIVER = pf(drv.digest !== null && driverDigest(join(drv.driverRoot, 'node_modules', 'postgres')) === drv.digest)
  const validUntil = deriveEffectiveSchedule(root).N09!

  // --- a synthetic server certificate for localhost, from a synthetic CA the tool will pin ---
  const ca = syntheticCa('d1 disposable proof ca')
  const other = syntheticCa('d1 disposable proof OTHER ca')
  const leaf = syntheticLeaf(ca, [host], { notAfter: new Date(Date.now() + 2 * 60 * 60 * 1000) })
  const trustDir = join(out, 'trust')
  mkdirSync(trustDir, { recursive: true })
  writeFileSync(join(trustDir, 'server.crt'), leaf.certPem)
  writeFileSync(join(trustDir, 'server.key'), leaf.keyPem)
  writeFileSync(join(trustDir, 'ca.crt'), ca.certPem)
  writeFileSync(join(trustDir, 'other-ca.crt'), other.certPem)
  const caSha256 = createHash('sha256').update(ca.certPem).digest('hex')
  for (const f of ['server.crt', 'server.key']) docker(['cp', join(trustDir, f), `${container}:/var/lib/postgresql/data/d1r3-${f}`])
  // The key must be readable by postgres only; it is synthetic and lives only in this disposable container and the out dir.
  docker(['exec', '-u', 'root', container, 'sh', '-c', 'chown postgres:postgres /var/lib/postgresql/data/d1r3-server.crt /var/lib/postgresql/data/d1r3-server.key && chmod 600 /var/lib/postgresql/data/d1r3-server.key'])
  rmSync(join(trustDir, 'server.key'), { force: true })

  // --- arm the disposable server --------------------------------------------------
  psqlOperator(container, [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROUTE_B_ROLE}') THEN CREATE ROLE ${ROUTE_B_ROLE} LOGIN; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${CONTROL_ROLE}') THEN CREATE ROLE ${CONTROL_ROLE} LOGIN; END IF; END $$`,
    `ALTER ROLE ${ROUTE_B_ROLE} PASSWORD NULL`,
  ])
  psqlAdmin(container, [
    'CREATE EXTENSION IF NOT EXISTS pg_tle',
    'CREATE EXTENSION IF NOT EXISTS pg_stat_statements',
    `CREATE OR REPLACE FUNCTION public.d1r2_passcheck(username text, password text, password_type pgtle.password_types, valid_until timestamptz, valid_null boolean) RETURNS void LANGUAGE plpgsql AS $f$ BEGIN RAISE LOG '${PASSCHECK_MARKER} type=% value=%', password_type, password; END $f$`,
    "DO $$ BEGIN PERFORM pgtle.register_feature('public.d1r2_passcheck', 'passcheck'); EXCEPTION WHEN OTHERS THEN NULL; END $$",
    ...SYSTEM_EMITTERS.map(([k, v]) => `ALTER SYSTEM SET ${k} = '${v}'`),
    "ALTER SYSTEM SET ssl = 'on'",
    "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/data/d1r3-server.crt'",
    "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/data/d1r3-server.key'",
    ...OPERATOR_ROLE_EMITTERS.map(([k, v]) => `ALTER ROLE ${OPERATOR} SET ${k} = '${v}'`),
    'SELECT pg_reload_conf()',
    'SELECT pg_stat_statements_reset()',
  ])
  await new Promise((r) => setTimeout(r, 500))
  const since = new Date(Date.now() - 1000).toISOString()

  // --- the proof depositor: hands the synthetic plaintext back, never to a file in the repo ---
  const depositor = join(out, 'proof-depositor.js')
  const dsnFile = join(out, 'proof-dsn.txt')
  writeFileSync(
    depositor,
    "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',(c)=>{s+=c});process.stdin.on('end',()=>{s=s.trim();require('fs').writeFileSync(require('path').join(__dirname,'proof-dsn.txt'),s);process.stdout.write(JSON.stringify({n30ExitMet:s!==''})+'\\n')})\n"
  )
  const operatorUrl = ['postgresql:', `//${OPERATOR}:`, encodeURIComponent(operatorPassword), '@', host, ':', String(port), '/', ROUTE_B_DATABASE].join('')
  const toolArgs = [
    `--driver-root=${drv.driverRoot}`,
    `--driver-digest=${drv.digest}`,
    `--target-host=${host}`,
    `--target-port=${port}`,
    `--target-database=${ROUTE_B_DATABASE}`,
    `--depositor=${depositor}`,
    `--valid-until=${validUntil}`,
    `--operator-principal=${OPERATOR}`,
    `--ca-file=${join(trustDir, 'ca.crt')}`,
    `--ca-sha256=${caSha256}`,
  ]

  // R3 (AC-8 on a real server): the tool pinned to ANOTHER CA is refused by TLS before any startup message.
  const otherSha256 = createHash('sha256').update(other.certPem).digest('hex')
  const unpinned = await runTool(tool, toolArgs.map((a) => (a.startsWith('--ca-file=') ? `--ca-file=${join(trustDir, 'other-ca.crt')}` : a.startsWith('--ca-sha256=') ? `--ca-sha256=${otherSha256}` : a)), operatorUrl)
  c.TOOL_REFUSES_AN_UNPINNED_SERVER = pf(unpinned.exitCode !== 0 && unpinned.lines.some((l) => l.phase === 'DRIVER_REJECTED' && /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED/.test(String(l.code))) && unpinned.lines.some((l) => l.mint === 'DEFINITELY_NOT_COMMITTED' && l.tlsVerified === false))

  // R2-N-STARTUP: an operator URL carrying a startup GUC is refused before any connection.
  const startup = await runTool(tool, toolArgs, `${operatorUrl}?options=-c%20log_statement%3Dall`)
  c.TOOL_REFUSES_STARTUP_PARAMETERS = pf(startup.exitCode === 2 && startup.lines.some((l) => l.refused === 'OPERATOR_URL_HAS_STARTUP_PARAMETERS'))

  // --- a REAL lock wait on pg_authid across the tool's ALTER ROLE. SHARE conflicts with the ALTER's
  // ROW EXCLUSIVE without touching the row: a concurrent ALTER ROLE of the same row instead makes the
  // tool's update fail (XX000 tuple concurrently updated, measured on the first run). ---
  const blocker = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'supabase_admin', '-d', ROUTE_B_DATABASE, '-v', 'ON_ERROR_STOP=1', '-At'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
  blocker.stdin.end('BEGIN;\nLOCK TABLE pg_catalog.pg_authid IN SHARE MODE;\nSELECT pg_sleep(2.5);\nCOMMIT;\n')
  await new Promise((r) => setTimeout(r, 700))
  const mint = await runTool(tool, toolArgs, operatorUrl)
  await new Promise((r) => blocker.on('close', r))
  c.TOOL_COMMITTED = pf(mint.exitCode === 0 && mint.lines.some((l) => l.mint === 'COMMITTED' && l.n30ExitMet === true))
  c.TOOL_VERIFIED_THE_SERVER = pf(mint.lines.some((l) => l.mint === 'COMMITTED' && l.tlsVerified === true))

  // --- the synthetic plaintext, handed back by the depositor, held in memory only ---
  let plaintext = ''
  if (existsSync(dsnFile)) {
    const dsn = readFileSync(dsnFile, 'utf8')
    rmSync(dsnFile, { force: true })
    try {
      plaintext = decodeURIComponent(new URL(dsn).password)
    } catch {
      plaintext = ''
    }
  }
  c.DEPOSITOR_RECEIVED_A_32_BYTE_VALUE = pf(/^[A-Za-z0-9_-]{43}$/.test(plaintext))

  // --- R2-P-1..3: what the server stored, and what authenticates -----------------
  const stored = psqlAdmin(container, [`SELECT rolpassword FROM pg_authid WHERE rolname = '${ROUTE_B_ROLE}'`]).trim()
  const parsed = parseVerifier(stored)
  c.STORED_IS_A_SCRAM_SHA_256_VERIFIER = pf(parsed !== null)
  c.STORED_VERIFIER_IS_OF_THE_DEPOSITED_PLAINTEXT = pf(parsed !== null && plaintext !== '' && verifierMatches(stored, plaintext))
  c.PLAINTEXT_AUTHENTICATES = pf(plaintext !== '' && (await authOutcome({ host, port, user: ROUTE_B_ROLE, password: plaintext, caPem: ca.certPem })) === 'AUTHENTICATED')
  c.WRONG_PASSWORD_REFUSED = pf((await authOutcome({ host, port, user: ROUTE_B_ROLE, password: `${plaintext}x`, caPem: ca.certPem })) === 'REFUSED_28P01')
  c.VERIFIER_AS_PASSWORD_REFUSED = pf(stored !== '' && (await authOutcome({ host, port, user: ROUTE_B_ROLE, password: stored, caPem: ca.certPem })) === 'REFUSED_28P01')

  // --- R2-N-NOT-A-VERIFIER: the guarded DO block refuses a non-verifier before ALTER ROLE ---
  const admin = postgres({ host, port, database: ROUTE_B_DATABASE, username: OPERATOR, password: operatorPassword, max: 1, prepare: false, ssl: verifiedSsl(ca.certPem, host), onnotice: () => undefined })
  const nonVerifier = NON_VERIFIER_SENTINEL
  let guardCode = 'NO_ERROR'
  try {
    await admin.begin(async (tx) => {
      await tx.unsafe(ROUTE_B_STATEMENTS.SET_ROLE, [ROUTE_B_ROLE])
      await tx.unsafe(ROUTE_B_STATEMENTS.SET_VERIFIER, [nonVerifier])
      await tx.unsafe(ROUTE_B_STATEMENTS.SET_VALID_UNTIL, [validUntil])
      await tx.unsafe(ROUTE_B_STATEMENTS.DO_BLOCK)
    })
  } catch (e) {
    guardCode = String((e as { code?: string }).code ?? 'UNKNOWN')
  }
  const storedAfterGuard = psqlAdmin(container, [`SELECT rolpassword FROM pg_authid WHERE rolname = '${ROUTE_B_ROLE}'`]).trim()
  c.GUARD_REFUSES_A_NON_VERIFIER = pf(guardCode === '22023' && storedAfterGuard === stored)

  // --- the negative control: the 979b1440 route puts ITS plaintext in the same log ---
  const controlPlain = CONTROL_PLAINTEXT_SENTINEL
  let controlOk = true
  try {
    await admin.begin(async (tx) => {
      await tx.unsafe(ROUTE_B_STATEMENTS.SET_ROLE, [CONTROL_ROLE])
      await tx.unsafe(OLD_ROUTE_B.SET_PASSWORD, [controlPlain])
      await tx.unsafe(ROUTE_B_STATEMENTS.SET_VALID_UNTIL, [validUntil])
      await tx.unsafe(OLD_ROUTE_B.DO_BLOCK)
    })
  } catch {
    controlOk = false
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined)
  }
  await new Promise((r) => setTimeout(r, 800))

  // --- R2-N-LEAK-CLASSES: search what the server actually wrote ---------------------
  // PostgreSQL writes its log to stderr; docker logs replays both streams.
  const logs = spawnSync('docker', ['logs', '--since', since, container], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 })
  const log = `${logs.stdout}\n${logs.stderr}`
  const statements = psqlAdmin(container, ['SELECT string_agg(query, E\'\\n\') FROM pg_stat_statements'])
  const surfaces = { server_log: log, pg_stat_statements: statements }
  const storedKey = parsed?.storedKey.toString('base64') ?? ''
  const serverKey = parsed?.serverKey.toString('base64') ?? ''
  const plaintextCounts = Object.fromEntries(Object.entries(surfaces).map(([k, t]) => [k, plaintext === '' ? -1 : count(t, plaintext)]))
  const derivedCounts = Object.fromEntries(Object.entries(surfaces).map(([k, t]) => [k, { verifier: count(t, stored), stored_key: count(t, storedKey), server_key: count(t, serverKey) }]))
  const controlCounts = Object.fromEntries(Object.entries(surfaces).map(([k, t]) => [k, count(t, controlPlain)]))
  const logLines = log.split(/\r?\n/)
  const emitters = Object.fromEntries(
    Object.entries(EMITTER_MARKERS).map(([k, marker]) => {
      const lines = logLines.filter((l) => l.includes(marker))
      return [k, { lines: lines.length, quoting_the_verifier: lines.filter((l) => storedKey !== '' && l.includes(storedKey)).length, quoting_the_control_plaintext: lines.filter((l) => l.includes(controlPlain)).length }]
    })
  ) as Record<string, { lines: number; quoting_the_verifier: number; quoting_the_control_plaintext: number }>

  c.PLAINTEXT_ABSENT_FROM_SERVER_LOG = pf(plaintextCounts.server_log === 0)
  c.PLAINTEXT_ABSENT_FROM_PG_STAT_STATEMENTS = pf(plaintextCounts.pg_stat_statements === 0)
  c.CONTROL_OLD_ROUTE_RAN = pf(controlOk)
  c.CONTROL_OLD_ROUTE_PLAINTEXT_FOUND_IN_LOG = pf((controlCounts.server_log ?? 0) > 0)
  // Each emitter the recertification measured was ACTIVE during the tool's ALTER ROLE:
  // it quotes the verifier (derived material) where the old route quoted the plaintext.
  c.EMITTER_LOCK_WAIT_FIRED = pf(emitters.LOCK_WAIT!.lines > 0)
  // The "still waiting" line names no statement; its CONTEXT line (the next ones of the same message) does.
  const lockWaitContextQuotes = logLines.some((l, i) => l.includes(EMITTER_MARKERS.LOCK_WAIT!) && logLines.slice(i + 1, i + 4).some((n) => n.includes('CONTEXT:') && storedKey !== '' && n.includes(storedKey)))
  c.EMITTER_LOCK_WAIT_CONTEXT_QUOTES_THE_VERIFIER = pf(lockWaitContextQuotes)
  c.EMITTER_CONTEXT_OF_NESTED_EXECUTE_QUOTES_THE_VERIFIER = pf(emitters.CONTEXT_OF_NESTED_EXECUTE!.quoting_the_verifier > 0)
  c.EMITTER_PASSCHECK_HOOK_QUOTES_THE_VERIFIER = pf(emitters.PASSCHECK_HOOK!.quoting_the_verifier > 0)
  c.EMITTER_PARSER_STATS_FIRED = pf(emitters.PARSER_STATS!.lines > 0)
  c.EMITTER_PGAUDIT_QUOTES_THE_VERIFIER = pf(emitters.PGAUDIT!.quoting_the_verifier > 0)
  c.EMITTER_LOG_STATEMENT_FIRED = pf(emitters.LOG_STATEMENT!.lines > 0)
  c.EMITTER_DEBUG_PRINT_PARSE_FIRED = pf(emitters.DEBUG_PRINT_PARSE!.lines > 0)

  const derivedPresent = Object.values(derivedCounts).some((d) => d.verifier + d.stored_key + d.server_key > 0)
  const failed = Object.entries(c).filter(([, s]) => s !== 'PASSED').map(([k]) => k)
  const overall = failed.length === 0 ? 'SATISFIED_CANDIDATE' : 'NOT_SATISFIED'
  const record = {
    proof: 'D1_SCRAM_VERIFIER_TRANSPORT_DISPOSABLE_POSTGRES',
    container: { label: DISPOSABLE_LABEL, image: docker(['inspect', container, '--format', '{{.Config.Image}}']).trim(), server_version_num: psqlAdmin(container, ['SHOW server_version_num']).trim(), bound_to: 'loopback' },
    pins: { mint_tool_sha256: binding.tools.mint.sha256, driver_digest: drv.digest, launcher_build_digest: binding.launcher_build_digest },
    tls: { server: 'synthetic certificate for localhost issued by a synthetic CA (NOT the governed project certificate)', pinned_ca_der_sha256: ca.derSha256, tool_pinned_to: 'the synthetic CA by the sha256 of its bytes', negative: 'the same tool pinned to another synthetic CA' },
    emitters_armed: { operator_role: OPERATOR_ROLE_EMITTERS.map(([k]) => k), system: SYSTEM_EMITTERS.map(([k]) => k), passcheck_hook: 'pg_tle passcheck RAISE LOG of what it is handed', lock_wait: 'a second session held SHARE on pg_authid across the ALTER ROLE' },
    classification: {
      PLAINTEXT: plaintextCounts.server_log === 0 && plaintextCounts.pg_stat_statements === 0 ? 'PLAINTEXT_NOT_PRESENT' : 'PLAINTEXT_PRESENT',
      DERIVED_MATERIAL: derivedPresent ? 'DERIVED_MATERIAL_PRESENT' : 'NO_DERIVED_MATERIAL_PRESENT',
      note: 'The verifier is derived material, classified separately: PLAINTEXT_NOT_PRESENT does not mean NO_DERIVED_MATERIAL_PRESENT. It is present by design wherever an emitter quotes the ALTER ROLE.',
    },
    counts: { plaintext: plaintextCounts, derived: derivedCounts, control_plaintext: controlCounts },
    emitters,
    outcomes: { startup_refusal: startup.lines.map((l) => String(l.refused ?? l.mint ?? '')), mint: mint.lines.map((l) => [l.phase, l.code, l.mint, l.refused].filter((x) => x !== undefined).join(':')), guard_sqlstate: guardCode },
    controls: c,
    failed,
    overall,
  }
  return { overall, record }
}

function arg(name: string): string | undefined {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`))
  return a?.slice(name.length + 3)
}

if (require.main === module) {
  const container = arg('container')
  const outDir = arg('out-dir')
  if (container === undefined || outDir === undefined) {
    process.stderr.write('usage: --container=<disposable container> --out-dir=<outside the repository>\n')
    process.exit(2)
  }
  prove(process.cwd(), container, outDir).then(
    ({ overall, record }) => {
      const text = `${JSON.stringify(record, null, 2)}\n`
      writeFileSync(join(resolvePath(outDir), 'd1-scram-disposable-proof.json'), text)
      process.stdout.write(text)
      process.exit(overall === 'SATISFIED_CANDIDATE' ? 0 : 1)
    },
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(3)
    }
  )
}
