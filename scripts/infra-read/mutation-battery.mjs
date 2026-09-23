// scripts/infra-read/mutation-battery.mjs — production-code mutation battery for the safe-read executor.
//
//   node scripts/infra-read/mutation-battery.mjs              every mutant; exit 0 only if ALL are killed
//   node scripts/infra-read/mutation-battery.mjs --only A,B   a subset (same aggregate rule)
//   node scripts/infra-read/mutation-battery.mjs --self-test  proves the battery FAILS when fed a survivor
//   add --json <file> to write the rows
//
// Run from the repository root. Each mutant is applied, tests/infra-read is run,
// and the file is restored from an in-memory byte copy (never git checkout) and
// verified by SHA-256. The UNMUTATED suite must be green first, or no verdict
// means anything. v1.0.5: verdict logic moved to mutation-verdict.mjs (the
// v1.0.4 summary reported SURVIVED as AS_EXPECTED and could not fail).
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { aggregate, classify, verdictOf } from './mutation-verdict.mjs'

const R = process.cwd().split('\\').join('/') + '/'
const F = (p) => R + 'scripts/infra-read/' + p
const G = F('guards.ts'), E = F('executor.ts'), X = F('xcc1.ts'), P = F('protocol.ts'), S = F('evidence-scan.ts')
const C = F('certification.ts'), O = F('ops.ts'), RG = F('run-governed-reads.ts')
const XR1 = "fixedArgs: ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'http.extraHeader=', 'ls-remote', X_R1_URL]"

// [id, description, file, find, replace, expectation]
export const MUTANTS = [
  // ---- retained from v1.0.4 (GitHub / Vercel POST+body+write-op, ordering, projection, XCC-1, DN-0)
  ['M01', 'gh exact-shape check removed (POST/body forms)', G, "if (!sameArgv(inv.argv, expected)) throw new Refusal('STOP_GH_NON_GET_OR_BODY_FORM'", "if (false) throw new Refusal('STOP_GH_NON_GET_OR_BODY_FORM'", 'KILLED'],
  ['M02', 'gh denylist emptied (exact shape still operative)', G, 'export const GH_FORBIDDEN_FLAGS = [', 'export const GH_FORBIDDEN_FLAGS = [] as string[]; const _unused = [', 'KILLED'],
  ['M03', 'vercel exact-shape check removed (POST/body forms)', G, "if (!sameArgv(inv.argv, expected)) throw new Refusal('STOP_VERCEL_NON_GET_OR_BODY_FORM'", "if (false) throw new Refusal('STOP_VERCEL_NON_GET_OR_BODY_FORM'", 'KILLED'],
  ['M04', 'projection conformance disabled', G, 'export function assertProjectionConforms(op: OpDef, projection: unknown): void {', 'export function assertProjectionConforms(op: OpDef, projection: unknown): void { return;', 'KILLED'],
  ['M05', 'G-R1-first check removed (G-R2 before G-R1)', E, "if (!s.ghRepo) throw new Refusal('STOP_GR1_NOT_FIRST'", "if (false) throw new Refusal('STOP_GR1_NOT_FIRST'", 'KILLED'],
  ['M06', 'RC-9b check removed', E, "if (op.read === 'G-R2' && !s.rc9bDischarged) {", 'if (false) {', 'KILLED'],
  ['M07', 'RNA-1 exclusion removed', E, 'if (name === ANTIGRAVITY_PROJECT || s.antigravityIds.has(prj)) {', 'if (false) {', 'KILLED'],
  ['M08', 'freshness refusal removed', E, "if (op.freshness !== 'EXECUTE_NOW') {", 'if (false) {', 'KILLED'],
  ['M09', 'post-projection secret detectors removed', E, 'if (hits.length > 0) {', 'if (false) {', 'KILLED'],
  ['M10', 'X-R1 preflight requirement removed', E, "if (op.id === 'X-R1' && !s.xcc1PreflightPassed) {", 'if (false) {', 'KILLED'],
  ['M11', 'GIT_ASKPASS dropped from the XCC-1 env', X, "  GIT_ASKPASS: '',\n", '', 'KILLED'],
  ['M12', 'ceiling directory dropped from the XCC-1 env', X, '  env.GIT_CEILING_DIRECTORIES = ctx.root\n', '', 'KILLED'],
  ['M13', 'isolation listing accepts file origins', X, "if (origin !== 'command line:') throw", 'if (false) throw', 'KILLED'],
  ['M14', 'no-commit-since-DN-0 guard disabled (stale DN-0 head)', P, 'export function assertNoCommitSinceDn0(git: LocalGit, dn0: Dn0Result): void {', 'export function assertNoCommitSinceDn0(git: LocalGit, dn0: Dn0Result): void { return;', 'KILLED'],
  ['M15', 'post-certification MODIFY accepted', P, "if (kind !== 'A' || !cfg.allowedPostCertificationAdditions", 'if (false && !cfg.allowedPostCertificationAdditions', 'KILLED'],
  ['M16', 'env-value detector removed', S, "{ id: 'ENV_VALUE_FIELD', re: /", "{ id: 'ENV_VALUE_FIELD', re: /(?!)", 'KILLED'],
  ['M17', 'V-R1 allowlist admits deploy-hook url', O, "  'link.deployHooks[].id', 'link.deployHooks[].name',", "  'link.deployHooks[].url', 'link.deployHooks[].id', 'link.deployHooks[].name',", 'KILLED'],
  ['M18', 'vercel write-operation-id check removed', G, "  if (typeof endpoint !== 'string' || !endpoint.startsWith('/')) {", '  if (false) {', 'KILLED'],
  // ---- v1.0.5: B-1 and the certification predicate
  ['N01', 'B-1 reintroduced: predicate requires the author-guessed verdict name', C, '  const v = verdict.verdict\n', "  const v = verdict.verdict\n  if (typeof v === 'string' && !/^INFRA_EXECUTOR_HARDENING_IC_PASS/.test(v)) return { ok: false, reason: 'verdict name' }\n", 'KILLED'],
  ['N02', 'B-1 reintroduced at the entry point: a verdict pattern configured for the recert event', RG, '      { ...EXECUTOR_RECERT_EVENT, certifiedCandidate },', '      { ...EXECUTOR_RECERT_EVENT, certifiedCandidate, verdict: /^INFRA_EXECUTOR_HARDENING_IC_PASS/ },', 'KILLED'],
  ['N03', 'candidate binding removed (wrong-candidate PASS accepted)', C, '  if (cand !== req.certifiedCandidate) return', '  if (false) return', 'KILLED'],
  ['N04', 'verdict judged by substring (FAIL containing PASS accepted)', C, "  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(verdict)) return undefined", "  if (verdict.includes('PASS')) return 'PASS'\n  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(verdict)) return undefined", 'KILLED'],
  ['N05', 'blocking-count check removed', C, '  if (verdict.blocking_findings !== 0) return', '  if (false) return', 'KILLED'],
  ['N06', 'document-class check removed', C, "  if (typeof cls !== 'string' || !cls.startsWith(CERTIFICATION_DOCUMENT_CLASS_PREFIX)) {", '  if (false) {', 'KILLED'],
  // ---- v1.0.5: environment
  ['N07', 'gh env guard reverted to a case-sensitive denylist (mixed-case GH_TOKEN)', G, "    assertProviderEnv(inv.env, GH_ENV_ALLOWED_UPPER, 'gh')", "    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN']) if (k in inv.env) throw new Refusal('STOP_CREDENTIAL_OVERRIDE_IN_ENV', k)", 'KILLED'],
  ['N08', 'vercel env guard reverted to a case-sensitive denylist (mixed-case VERCEL_TOKEN)', G, "    assertProviderEnv(inv.env, VERCEL_ENV_ALLOWED_UPPER, 'vercel')", "    for (const k of ['VERCEL_TOKEN']) if (k in inv.env) throw new Refusal('STOP_CREDENTIAL_OVERRIDE_IN_ENV', k)", 'KILLED'],
  ['N09', 'credential-name check made case-sensitive', G, '    if (CREDENTIAL_NAME_RE.test(u)) throw', '    if (CREDENTIAL_NAME_RE.test(k)) throw', 'KILLED'],
  ['N10', 'constructed env compares names case-sensitively', G, '    const u = k.toUpperCase()\n    const list = byUpper.get(u) ?? []', '    const u = k\n    const list = byUpper.get(u) ?? []', 'KILLED'],
  // ---- v1.0.5: free-text detectors and write-set classification
  ['N11', 'vcp_ detector removed', S, "{ id: 'VERCEL_VCP_TOKEN', re: /", "{ id: 'VERCEL_VCP_TOKEN', re: /(?!)", 'KILLED'],
  ['N12', 'URL userinfo detector reverted to the v1.0.4 user:password form', S, "[^/\\s@\"'<>]+@/i },", "[^/\\s:@\"]+:[^/\\s@\"]+@/i },", 'KILLED'],
  ['N13', 'env-assignment detector removed', S, "{ id: 'ENV_ASSIGNMENT_SECRET', re: /", "{ id: 'ENV_ASSIGNMENT_SECRET', re: /(?!)", 'KILLED'],
  ['N14', 'keyword-adjacent classic-token detector removed', S, "{ id: 'KEYWORD_ADJACENT_OPAQUE', re: /", "{ id: 'KEYWORD_ADJACENT_OPAQUE', re: /(?!)", 'KILLED'],
  ['N15', 'designated fixtures accepted regardless of counts (global suppression)', S, "return sameCounts(countByDetector(findings), designatedFixture) ? 'EXPECTED_DETECTIONS' : 'FAIL'", "return 'EXPECTED_DETECTIONS'", 'KILLED'],
  // ---- v1.0.5: envelope
  ['N16', 'raw provider key injected into the evidence envelope', E, "      record_kind: op.cls === 'PACMI' ? 'PACMI_EVIDENCE' : 'GOVERNED_READ_EVIDENCE',", "      raw_exit: res.status, record_kind: op.cls === 'PACMI' ? 'PACMI_EVIDENCE' : 'GOVERNED_READ_EVIDENCE',", 'KILLED'],
  ['N17', 'envelope allowlist disabled', E, 'export function assertEnvelopeConforms(record: unknown): void {', 'export function assertEnvelopeConforms(record: unknown): void { return;', 'KILLED'],
  // ---- v1.0.5: XCC-1 normative contract
  ['N18', 'X-R1 registry drops the credential.helper reset', O, XR1, "fixedArgs: ['-c', 'core.askPass=', '-c', 'http.extraHeader=', 'ls-remote', X_R1_URL]", 'KILLED'],
  ['N19', 'X-R1 registry drops the core.askPass reset', O, XR1, "fixedArgs: ['-c', 'credential.helper=', '-c', 'http.extraHeader=', 'ls-remote', X_R1_URL]", 'KILLED'],
  ['N20', 'X-R1 registry drops the http.extraHeader reset', O, XR1, "fixedArgs: ['-c', 'credential.helper=', '-c', 'core.askPass=', 'ls-remote', X_R1_URL]", 'KILLED'],
  ['N21', 'preflight argv drops the credential.helper reset', X, "export const XCC1_PREFLIGHT_ARGS = ['-c', 'credential.helper=', ", 'export const XCC1_PREFLIGHT_ARGS = [', 'KILLED'],
  ['N22', 'terminal prompt enabled in the XCC-1 env', X, "  GIT_TERMINAL_PROMPT: '0',\n", "  GIT_TERMINAL_PROMPT: '1',\n", 'KILLED'],
  ['N23', 'system-config isolation dropped from the XCC-1 env', X, "  GIT_CONFIG_NOSYSTEM: '1',\n", '', 'KILLED'],
  ['N24', 'normative X-R1 argv check removed from the guard', G, '  asXcc1Refusal(() => assertXcc1NormativeArgv(inv.argv))\n', '', 'KILLED'],
  // ---- v1.0.5: DN-0 fetch and RC-9a identity
  ['N25', 'DN-0 residual-vector (insteadOf/cookieFile) check removed', P, '  if (residual.status !== 1) throw', '  if (false) throw', 'KILLED'],
  ['N26', 'DN-0 fetch drops the credential.helper reset', P, "export const DN0_FETCH_ARGS = ['-c', 'credential.helper=', ", 'export const DN0_FETCH_ARGS = [', 'KILLED'],
  ['N27', 'RC-9a identity assertion removed', P, 'host.login === expected.githubLogin && host.tokenSource === expected.githubTokenSource &&', 'true &&', 'KILLED'],
  ['N28', 'DN-0 origin https-without-userinfo check removed', P, '  if (remote.status !== 0) throw', '  if (false) throw', 'KILLED'],
  ['N29', 'DN-0 residual probe reads config VALUES (--name-only dropped)', P, "  const residual = git.run(['config', '--name-only', '--get-regexp', DN0_FETCH_RESIDUAL_VECTOR_REGEX])", "  const residual = git.run(['config', '--get-regexp', DN0_FETCH_RESIDUAL_VECTOR_REGEX])", 'KILLED'],
]

// Behaviour-neutral: a comment edit. Expected KILLED, so it MUST be reported UNEXPECTED.
const SELF_TEST_SURVIVOR = ['S01', 'SELF-TEST: behaviour-neutral comment edit, deliberately expected KILLED', G, '// scripts/infra-read/guards.ts\n', '// scripts/infra-read/guards.ts (mutation battery self-test)\n', 'KILLED']

const sha = (b) => createHash('sha256').update(b).digest('hex')
function suite() {
  const r = spawnSync('npx vitest run tests/infra-read', { cwd: R, encoding: 'utf8', shell: true, timeout: 480000 })
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

function runOne([id, desc, file, find, replace, expect]) {
  const orig = readFileSync(file)
  const text = orig.toString('utf8')
  const count = text.split(find).length - 1
  if (count !== 1) return { id, desc, verdict: `INVALID_ANCHOR_COUNT_${count}`, failing: null, expect, classification: 'UNEXPECTED' }
  // Function replacer: a string replacement would expand $&, $', $` and $$ patterns.
  writeFileSync(file, text.replace(find, () => replace))
  let r
  try { r = suite() } finally {
    writeFileSync(file, orig)
    if (sha(readFileSync(file)) !== sha(orig)) { console.log('RESTORE FAILED for', file); process.exit(9) }
  }
  const verdict = verdictOf(r.status, r.out)
  const failing = /Tests\s+(\d+) failed/.exec(r.out)
  // WHY it died: the first failing tests, as vitest names them.
  const killedBy = [...new Set(r.out.split(/\r?\n/).filter((l) => /^\s*FAIL\s+tests\//.test(l)).map((l) => l.replace(/^\s*FAIL\s+/, '').trim()))].slice(0, 4)
  return { id, desc, verdict, failing: failing ? Number(failing[1]) : null, killedBy, expect, classification: classify(expect, verdict) }
}

function baselineGreen() {
  const r = suite()
  const passed = /Tests\s+(\d+) passed/.exec(r.out)
  console.log(`BASELINE ${r.status === 0 ? 'GREEN' : 'NOT_GREEN'}${passed ? ` (${passed[1]} passed)` : ''}`)
  return r.status === 0
}

function report(rows) {
  for (const r of rows) console.log([r.id, r.desc, `${r.verdict}${r.failing !== null ? ` (${r.failing} failing)` : ''}`, `expect ${r.expect}`, r.classification].join(' | '))
  const a = aggregate(rows)
  console.log(`MUTANTS=${a.total} AS_EXPECTED=${a.asExpected} UNEXPECTED=${a.unexpected}`)
  console.log(`BATTERY=${a.pass ? 'PASS' : 'FAIL'}`)
  return a
}

const argv = process.argv.slice(2)
const jsonAt = argv.indexOf('--json')
const jsonPath = jsonAt === -1 ? undefined : argv[jsonAt + 1]
const onlyAt = argv.indexOf('--only')
const only = onlyAt === -1 ? undefined : new Set(argv[onlyAt + 1].split(','))

if (argv.includes('--check-anchors')) {
  // Static: every anchor occurs exactly once. Runs no test.
  const bad = [...MUTANTS, SELF_TEST_SURVIVOR].filter(([, , file, find]) => readFileSync(file, 'utf8').split(find).length - 1 !== 1)
  for (const m of bad) console.log(`ANCHOR_INVALID ${m[0]} ${m[1]}`)
  console.log(`ANCHORS=${bad.length === 0 ? 'OK' : 'INVALID'} (${MUTANTS.length + 1} checked)`)
  process.exit(bad.length === 0 ? 0 : 1)
}

if (!baselineGreen()) { console.log('BATTERY=FAIL (unmutated suite is not green; no verdict is meaningful)'); process.exit(3) }

if (argv.includes('--self-test')) {
  // A real kill next to a real survivor: the battery must report the survivor UNEXPECTED and FAIL.
  const rows = [runOne(MUTANTS.find((m) => m[0] === 'M05')), runOne(SELF_TEST_SURVIVOR)]
  const a = report(rows)
  const s = rows[1]
  const ok = !a.pass && s.verdict === 'SURVIVED' && s.classification === 'UNEXPECTED' && rows[0].classification === 'AS_EXPECTED'
  console.log(`SELF_TEST=${ok ? 'PASS (the battery failed when fed a survivor)' : 'FAIL (the battery did not fail on a survivor)'}`)
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify({ mode: 'self-test', rows, aggregate: a, self_test: ok ? 'PASS' : 'FAIL' }, null, 1)}\n`)
  process.exit(ok ? 0 : 1)
}

const selected = only ? MUTANTS.filter((m) => only.has(m[0])) : MUTANTS
const rows = selected.map(runOne)
const a = report(rows)
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify({ mode: only ? 'subset' : 'full', rows, aggregate: a }, null, 1)}\n`)
process.exit(a.pass ? 0 : 1)
