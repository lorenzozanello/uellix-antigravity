// scripts/custody/d1-mint-operator-channel-mutation.ts
//
//   pnpm custody:operator-channel:mutation [-- --only=M-ECHO,M-HOST-CHECK] [--check-anchors]
//
// THE MUTATION CONTROLS OF THE OPERATOR-CHANNEL SUCCESSOR (manifest
// FIBDB-053-D1-MINT-OPERATOR-CHANNEL-SUCCESSOR-R1, mutation_controls, and its
// R2 amendment v1.0.1: R2-M-E1 .. R2-M-X08 re-kill the survivors the
// recertification of 979b1440 found, plus the SCRAM transport, the startup /
// database binding, OC-12 and the observer identity; R3 amendment v1.0.2: TLS;
// R4 amendment v1.0.3: the pre-node boundary, the OEP-1 chain, NB-3, PMR-16). Each
// mutant removes ONE safety guarantee from the real source, runs the targeted
// test files, and must turn them RED. The comment-only self-test must SURVIVE
// (GREEN): a battery that can report nothing but RED proves nothing.
//
// Originals are held in memory and written back byte for byte after every
// mutant (and on any failure); `git checkout` is never used, so uncommitted
// work is never lost. --check-anchors verifies every anchor is unique and
// changes nothing.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

interface Mutant {
  readonly id: string
  readonly file: string
  readonly from: string
  readonly to: string
  readonly tests: readonly string[]
  readonly expect: 'RED' | 'GREEN'
}

const CH = 'db/custody/mint-operator-channel.ts'
const LA = 'scripts/custody/d1-mint-operator-launcher.ts'
const PL = 'scripts/custody/d1-mint-operator-plan.ts'
const EV = 'scripts/custody/d1-mint-operator-evidence.ts'
const N6 = 'scripts/custody/d1-n06-closure.ts'
const RB = 'db/custody/mint-route-b-contract.ts'
const SC = 'db/custody/scram-verifier.ts'
const OB = 'scripts/custody/n05-peb-observer.ts'
const T_CH = 'tests/custody/d1-mint-operator-channel.test.ts'
const T_PR = 'tests/custody/d1-oep1-probe-contract.test.ts'
const T_V7 = 'tests/custody/d1-dag-amendment-v107.test.ts'
const T_PM = 'tests/custody/d1-pre-hc1-post-mint.test.ts'
const T_RB = 'tests/custody/d1-mint-route-b-contract.test.ts'
const T_SC = 'tests/custody/d1-scram-verifier.test.ts'
const T_PEB = 'tests/custody/d1-peb-identity.test.ts'
const PM = 'scripts/custody/d1-pre-hc1-post-mint.ts'
const SN = 'tests/custody/support/tool-trust-snippet.ts'
const T_TLS = 'tests/custody/d1-tls-trust.test.ts'
const T_CHAIN = 'tests/custody/d1-oep1-evidence-chain.test.ts'
const BN = 'db/custody/pre-node-boundary.ts'
const SA = 'scripts/custody/d1-server-auth-measure.ts'
const T_BOUNDARY = 'tests/custody/d1-pre-node-boundary.test.ts'
const T_V10 = 'tests/custody/d1-dag-amendment-v1010.test.ts'
const HM = 'scripts/custody/d1-tls-trust-harness.ts'

export const MUTANTS: readonly Mutant[] = [
  { id: 'M-ECHO', file: CH, from: '          buf[len++] = b\n', to: '          buf[len++] = b\n          output.write(String.fromCharCode(b))\n', tests: [T_CH], expect: 'RED' },
  { id: 'M-NO-RAW', file: CH, from: '  if (input.isRaw !== true) {\n    input.setRawMode(wasRaw)', to: '  if (false) {\n    input.setRawMode(wasRaw)', tests: [T_CH], expect: 'RED' },
  { id: 'M-ENV-SPREAD', file: CH, from: '  const env: Record<string, string> = {}\n', to: '  const env: Record<string, string> = { ...(base as Record<string, string>) }\n', tests: [T_CH], expect: 'RED' },
  { id: 'M-PARENT-ENV-WRITE', file: LA, from: '    child = io.spawn(', to: '    ;(io.env as Record<string, string>)[OPERATOR_ENV_VAR_NAME] = secret.toString(\'utf8\')\n    child = io.spawn(', tests: [T_CH], expect: 'RED' },
  { id: 'M-WINDOWS-HIDE', file: CH, from: 'export const TOOL_SPAWN_FLAGS = { windowsHide: false,', to: 'export const TOOL_SPAWN_FLAGS = { windowsHide: true,', tests: [T_CH], expect: 'RED' },
  { id: 'M-ARGV-CHECK', file: CH, from: '      if (bytes.includes(passwordRaw) || bytes.includes(b64)) {', to: '      if (false) {', tests: [T_CH], expect: 'RED' },
  { id: 'M-HOST-CHECK', file: CH, from: '  if (facts.host !== plan.targetHost.toLowerCase()) {', to: '  if (false) {', tests: [T_CH], expect: 'RED' },
  { id: 'M-PLAN-HOST', file: PL, from: "    ['targetHost', onDisk.targetHost, derived.targetHost],\n", to: '', tests: [T_CH], expect: 'RED' },
  { id: 'M-PLAN-VALID-UNTIL', file: PL, from: "    ['validUntil', onDisk.validUntil, derived.validUntil],\n", to: '', tests: [T_CH], expect: 'RED' },
  { id: 'M-PLAN-DRIVER', file: PL, from: "    ['driverRoot', onDisk.driverRoot, derived.driverRoot],\n", to: '', tests: [T_CH], expect: 'RED' },
  { id: 'M-TOOL-HASH', file: LA, from: '  if (sha256Hex(toolBytes) !== plan.tool.sha256) throw', to: '  if (false) throw', tests: [T_CH], expect: 'RED' },
  { id: 'M-SYNTHETIC-GATE', file: CH, from: '  return /\\.invalid$/i.test(targetHost)', to: '  return targetHost.length > 0', tests: [T_CH], expect: 'RED' },
  { id: 'M-N06-OPERATOR', file: N6, from: ', ...checkOperatorCredentialSection(inv.operator_credential)]', to: ']', tests: [T_V7], expect: 'RED' },
  // --- R2: the survivors of the recertification of 979b1440, each killed by a behavioural test ---
  // E1: a CONSISTENT non-PASS OEP-1 record (recorded = recomputed) was accepted as a closure.
  { id: 'R2-M-E1', file: EV, from: "  if (e.verdict !== 'CLOSED') r.push(", to: '  if (false) r.push(', tests: [T_PM], expect: 'RED' },
  // The sub-verdict gate alone is an EQUIVALENT mutant: recomputing already pushes a reason for every
  // FAIL sub-verdict (measured: the single-line mutant survived). The regression E1 needs BOTH gone.
  { id: 'R2-M-E1-SUBVERDICTS', file: EV, from: "  r.push(...re.reasons)\n  const recorded = (e.sub_verdicts ?? {}) as Record<string, unknown>\n  for (const k of OEP1_GATING_SUBVERDICTS) if (recorded[k] !== re.subVerdicts[k]) r.push(`the recorded ${k} ${String(recorded[k])} is not the recomputed ${re.subVerdicts[k]}`)\n  // E1: a consistent non-PASS record is still not a closure. Only CLOSED, with every gating sub-verdict PASS, closes OEP-1.\n  if (e.verdict !== 'CLOSED') r.push(`the recorded verdict ${String(e.verdict)} is not CLOSED; only CLOSED closes OEP-1`)\n  if (OEP1_GATING_SUBVERDICTS.some((k) => re.subVerdicts[k] !== 'PASS')) r.push('a gating sub-verdict is not PASS')\n", to: "  const recorded = (e.sub_verdicts ?? {}) as Record<string, unknown>\n  for (const k of OEP1_GATING_SUBVERDICTS) if (recorded[k] !== re.subVerdicts[k]) r.push(`the recorded ${k} ${String(recorded[k])} is not the recomputed ${re.subVerdicts[k]}`)\n  // E1: a consistent non-PASS record is still not a closure. Only CLOSED, with every gating sub-verdict PASS, closes OEP-1.\n  if (e.verdict !== 'CLOSED') r.push(`the recorded verdict ${String(e.verdict)} is not CLOSED; only CLOSED closes OEP-1`)\n", tests: [T_PM], expect: 'RED' },
  // X06: the host check by prefix.
  { id: 'R2-M-X06', file: CH, from: '  if (facts.host !== plan.targetHost.toLowerCase()) {', to: '  if (!facts.host.startsWith(plan.targetHost.toLowerCase())) {', tests: [T_CH], expect: 'RED' },
  // P1: VALID UNTIL from N08.
  { id: 'R2-M-P1', file: PL, from: '    validUntil = sched.N09\n', to: '    validUntil = sched.N08\n', tests: [T_CH], expect: 'RED' },
  // P6: a dirty worktree not a STOP.
  { id: 'R2-M-P6', file: PL, from: '  if (!p.clean) r.push(', to: '  if (false) r.push(', tests: [T_CH], expect: 'RED' },
  // P10: the target host returned whatever N04 says.
  { id: 'R2-M-P10', file: PL, from: "  return n04.status === 'SATISFIED' ? {", to: '  return true ? {', tests: [T_CH], expect: 'RED' },
  // L1: the launcher writes the REAL process environment.
  { id: 'R2-M-L1', file: LA, from: '    child = io.spawn(', to: "    process.env[OPERATOR_ENV_VAR_NAME] = secret.toString('utf8')\n    child = io.spawn(", tests: [T_CH], expect: 'RED' },
  // X08: the tool environment allowlist widened.
  { id: 'R2-M-X08', file: CH, from: "export const TOOL_ENV_ALLOWLIST = ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP'] as const", to: "export const TOOL_ENV_ALLOWLIST = ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP', 'USERPROFILE'] as const", tests: [T_CH], expect: 'RED' },
  // --- R2: the SCRAM transport and the session binding ---
  { id: 'R2-M-STARTUP-QUERY', file: CH, from: "    hasStartupParameters: url.search !== '' || url.hash !== '',", to: '    hasStartupParameters: false,', tests: [T_CH], expect: 'RED' },
  { id: 'R2-M-DATABASE', file: CH, from: '  if (facts.database !== plan.targetDatabase) throw', to: '  if (false) throw', tests: [T_CH], expect: 'RED' },
  { id: 'R2-M-PLAN-DRIVER-DIGEST', file: PL, from: "    ['driverDigest', onDisk.driverDigest, derived.driverDigest],\n", to: '', tests: [T_CH], expect: 'RED' },
  { id: 'R2-M-OC12', file: PL, from: '    reasons.push(...channelCertificationReasons(cert, binding).map((x) => `OC-12: ${x}`))', to: '    void cert', tests: [T_CH], expect: 'RED' },
  { id: 'R2-M-OEP1-STARTUP-CLOSED', file: CH, from: '  const closed = JSON.stringify(o.client_settings', to: '  const closed = true || JSON.stringify(o.client_settings', tests: [T_PR, T_PM], expect: 'RED' },
  { id: 'R2-M-PMR14-PINS', file: EV, from: "  const hashes = b !== null && s('probe_tool_sha256') === b.tools.probe.sha256 && s('mint_tool_sha256') === b.tools.mint.sha256", to: "  const hashes = b !== null && s('mint_tool_sha256') === b.tools.mint.sha256", tests: [T_PM], expect: 'RED' },
  { id: 'R2-M-TRANSPORT', file: RB, from: "export const ROUTE_B_PASSWORD_TRANSPORT = 'CLIENT_SIDE_POSTGRESQL_SCRAM_SHA_256_VERIFIER' as const", to: "export const ROUTE_B_PASSWORD_TRANSPORT = 'PLAINTEXT_SET_CONFIG' as const", tests: [T_PM], expect: 'RED' },
  { id: 'R2-M-GUARD-REGEX', file: RB, from: "!~ '^SCRAM-SHA-256", to: "!~ '^.*|^SCRAM-SHA-256", tests: [T_RB], expect: 'RED' },
  { id: 'R2-M-SCRAM-KEY', file: SC, from: "  const clientKey = hmac(saltedPassword, 'Client Key')", to: "  const clientKey = hmac(saltedPassword, 'Client key')", tests: [T_SC], expect: 'RED' },
  // F: the observer's parent resolution by pid alone (a later reuser adopts the child).
  { id: 'R2-M-PID-REUSE', file: OB, from: '    if (p.pid !== child.ppid || p.createdMs <= 0 || p.createdMs > child.createdMs) continue', to: '    if (p.pid !== child.ppid) continue', tests: [T_PEB], expect: 'RED' },
  // --- R3: server authentication (AC-8, OT-18) on real TLS, the pinned CA, and the recertification survivors of fa43b396 ---
  {id: "R3-M-TLS-NO-VERIFY",file: SN,from: "rejectUnauthorized: ${v('TLS_NO_VERIFY', 'false', 'true')},",to: "rejectUnauthorized: ${v('TLS_NO_VERIFY', 'false', 'false')},",tests: [T_TLS],expect: "RED"},
  {id: "R3-M-TLS-REQUIRE",file: SN,from: "  return variant === 'TLS_REQUIRE' ? \"'require'\" : `pinnedTls(pinned.ca, ${hostExpr}, seen)`",to: "  return \"'require'\"",tests: [T_TLS],expect: "RED"},
  {id: "R3-M-TLS-NO-HOSTNAME",file: SN,from: "${v('TLS_NO_HOSTNAME', 'undefined', 'tls.checkServerIdentity(h, cert)')}",to: "${v('TLS_NO_HOSTNAME', 'undefined', 'undefined')}",tests: [T_TLS],expect: "RED"},
  {id: "R3-M-TLS-SYSTEM-TRUST",file: SN,from: "${v('TLS_SYSTEM_TRUST', '', 'ca: [ca],')}",to: "${v('TLS_SYSTEM_TRUST', '', '')}",tests: [T_TLS],expect: "RED"},
  {id: "R3-M-CA-PIN-TOOL",file: SN,from: "${v('NO_CA_PIN_CHECK', '', \"if (!/^[0-9a-f]{64}$/.test(pin) || createHash('sha256').update(bytes).digest('hex') !== pin) return { refused: 'CA_PIN_MISMATCH' }\")}",to: "",tests: [T_TLS],expect: "RED"},
  {id: "R3-M-CA-PIN-LAUNCHER",file: LA,from: "  if (sha256Hex(caBytes) !== plan.caSha256) throw",to: "  if (false) throw",tests: [T_CH],expect: "RED"},
  {id: "R3-M-X08X",file: CH,from: "  const env: Record<string, string> = {}\n  for (const k of TOOL_ENV_ALLOWLIST) {",to: "  const env: Record<string, string> = Object.fromEntries(Object.entries(base).filter(([k, v]) => /^PG/i.test(k) && v !== undefined)) as Record<string, string>\n  for (const k of TOOL_ENV_ALLOWLIST) {",tests: [T_CH],expect: "RED"},
  {id: "R3-M-X08X-TOOL",file: SN,from: "${v('NO_AMBIENT_ENV_CHECK', '', \"const ambient = ambientEnvironment(); if (ambient.length > 0) { out({ refused: 'AMBIENT_ENVIRONMENT', names: ambient }); return 2 }\")}",to: "",tests: [T_TLS],expect: "RED"},
  {id: "R3-M-L1X",file: LA,from: "    child = io.spawn(",to: "    process.env[OPERATOR_ENV_VAR_NAME] = secret.toString('utf8')\n    delete process.env[OPERATOR_ENV_VAR_NAME]\n    child = io.spawn(",tests: [T_CH],expect: "RED"},
  {id: "R3-M-P6X",file: PL,from: "  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim() === ''",to: "  return execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim() === ''",tests: [T_CH],expect: "RED"},
  {id: "R3-M-P6X-CLI",file: PL,from: "  if (!worktreeIsClean(root)) {",to: "  if (false) {",tests: [T_CH],expect: "RED"},
  // R3-M-CHAIN-ACK re-anchored in R4: the v4 chain (NB-2) compares acknowledged record ids, not paths; same guarantee.
  {id: "R3-M-CHAIN-ACK",file: EV,from: "      if (JSON.stringify(want) !== JSON.stringify(got)) reasons.push(",to: "      if (false) reasons.push(",tests: [T_CHAIN],expect: "RED"},
  {id: "R3-M-CHAIN-IGNORED",file: EV,from: "  r.push(...f.chainReasons)\n",to: "",tests: [T_PM],expect: "RED"},
  {id: "R3-M-COHERENCE",file: EV,from: "  const cr = coherenceReasons(e, ctx)\n",to: "  const cr: string[] = []\n",tests: [T_PM],expect: "RED"},
  // R3-M-PMR15 retired with its target (DAG v1.0.10 supersedes PMR-15); its guarantee is R4-M-PMR16-CA below.
  // --- R4: the pre-node boundary (NB-1), the digest-bound OEP-1 chain (NB-2), the NB-3 test gaps and PMR-16 ---
  {id: "R4-M-BOUNDARY-AMBIENT",file: BN,from: "if ($present.Count -gt 0) { [System.Array]::Sort($present); Refuse 'PRE_NODE_AMBIENT_RUNTIME' $present }",to: "if ($false) { [System.Array]::Sort($present); Refuse 'PRE_NODE_AMBIENT_RUNTIME' $present }",tests: [T_BOUNDARY],expect: "RED"},
  {id: "R4-M-BOUNDARY-ENV",file: BN,from: "$psi.EnvironmentVariables.Clear()\n",to: "",tests: [T_BOUNDARY],expect: "RED"},
  {id: "R4-M-BOUNDARY-NODE-PIN",file: BN,from: "if ((Sha256OfFile $node) -ne $nodePin) { Refuse 'PRE_NODE_NODE_NOT_PINNED' @() }",to: "if ($false) { Refuse 'PRE_NODE_NODE_NOT_PINNED' @() }",tests: [T_BOUNDARY],expect: "RED"},
  {id: "R4-M-LAUNCHER-MARK",file: LA,from: "  if (boundary.length > 0) throw",to: "  if (false) throw",tests: [T_CH],expect: "RED"},
  {id: "R4-M-CHAIN-DIGEST",file: EV,from: "    if (pred.doc.content_digest !== link.content_digest || oep1RecordDigest(pred.doc) !== link.content_digest) reasons.push(",to: "    if (false) reasons.push(",tests: [T_CHAIN],expect: "RED"},
  {id: "R4-M-CHAIN-TIME",file: EV,from: "    if (!(time(r) > time(pred))) reasons.push(",to: "    if (false) reasons.push(",tests: [T_CHAIN],expect: "RED"},
  {id: "R4-M-CHAIN-TIME-ACK",file: EV,from: "        if (!(time(head) > time(target))) reasons.push(",to: "        if (false) reasons.push(",tests: [T_CHAIN],expect: "RED"},
  {id: "R4-M-CHAIN-RECOMPUTE",file: EV,from: "verdict: recomputedLinkVerdict(cur.doc), observedAt:",to: "verdict: (cur.doc.verdict === 'CLOSED' ? 'CLOSED' : 'NOT_CLOSED'), observedAt:",tests: [T_CHAIN],expect: "RED"},
  {id: "R4-M-O4",file: SN,from: "new RegExp(${JSON.stringify(HOSTILE_AMBIENT_ENV_SOURCE)}, 'i')",to: "new RegExp(${JSON.stringify(HOSTILE_AMBIENT_ENV_SOURCE)})",tests: [T_TLS],expect: "RED"},
  {id: "R4-M-O5",file: SN,from: "'^(PG[A-Z0-9_]*|",to: "'^(PG[A-Z]*|",tests: [T_TLS],expect: "RED"},
  {id: "R4-M-O6",file: SN,from: "|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE",to: "|SSL_CERT_FILE",tests: [T_TLS],expect: "RED"},
  {id: "R4-M-O14",file: EV,from: "  if (ctx.targetHost === null || cn.host !== ctx.targetHost) r.push(",to: "  if (ctx.targetHost === null || cn.host !== cn.host) r.push(",tests: [T_PM],expect: "RED"},
  {id: "R4-M-O15",file: EV,from: "  if (ctx.driverDigest === null || cn.driver_digest !== ctx.driverDigest) r.push(",to: "  if (ctx.driverDigest === null || cn.driver_digest !== cn.driver_digest) r.push(",tests: [T_PM],expect: "RED"},
  {id: "R4-M-O11",file: EV,from: "  if (dc === undefined || dc === null || typeof dc !== 'object' || doc.observation === undefined) return 'NOT_CLOSED'",to: "  if (dc === undefined || dc === null || typeof dc !== 'object' || doc.observation === undefined) return 'CLOSED'",tests: [T_CHAIN],expect: "RED"},
  {id: "R4-M-O11-VERDICT",file: EV,from: "(doc.verdict === undefined || (doc.verdict",to: "((doc.verdict",tests: [T_CHAIN],expect: "RED"},
  {id: "R4-M-O8",file: LA,from: "  checkPlannedCa(plan, io.readFile)\n",to: "  if (plan.mode === 'probe') checkPlannedCa(plan, io.readFile)\n",tests: [T_CH],expect: "RED"},
  {id: "R4-M-PMR16",file: SA,from: "  if (codeOf(() => subjects.checkCa({ caFile, caSha256: 'f'.repeat(64) }",to: "  if (false && codeOf(() => subjects.checkCa({ caFile, caSha256: 'f'.repeat(64) }",tests: [T_V10],expect: "RED"},
  {id: "R4-M-PMR16-CA",file: PM,from: "(i) => [...i.operatorChannel.caReasons, ...i.operatorChannel.serverAuthReasons]",to: "(i) => [...i.operatorChannel.serverAuthReasons]",tests: [T_PM,T_V10],expect: "RED"},
  // --- R5: outermost boundary (A), UTC canonicalization (B), case-stable discovery (C), PMR-16 hostname (D) ---
  {id: "R5-M-B-UTC",file: EV,from: "  return canonical === value ? t : null",to: "  return t",tests: [T_CHAIN],expect: "RED"},
  {id: "R5-M-C-DISCOVERY",file: EV,from: "  return { names: tracked, reasons: [...new Set(reasons)] }",to: "  return { names: onDisk, reasons: [] }",tests: [T_CHAIN],expect: "RED"},
  {id: "R5-M-D-HOSTNAME",file: HM,from: "  if (!call({ subject: { CN: 'wrong.d1.invalid' }, subjectaltname: 'DNS:wrong.d1.invalid' }))",to: "  if (false && !call({ subject: { CN: 'wrong.d1.invalid' }, subjectaltname: 'DNS:wrong.d1.invalid' }))",tests: [T_V10],expect: "RED"},
  {id: "R5-M-A-INJECTION",file: BN,from: "$injection = '^(COR_ENABLE_PROFILING|COR_PROFILER|COR_PROFILER_PATH(_32|_64)?|CORECLR_ENABLE_PROFILING|CORECLR_PROFILER|CORECLR_PROFILER_PATH(_32|_64)?|DOTNET_STARTUP_HOOKS|DOTNET_ADDITIONAL_DEPS)$'",to: "$injection = '^d1nevermatch$'",tests: [T_BOUNDARY],expect: "RED"},
  {id: "R5-M-A-OUTER-PSMOD",file: BN,from: "  'PSModulePath',\n",to: "",tests: [T_BOUNDARY],expect: "RED"},
  {id: "R5-M-A-DOTNET",file: BN,from: "$table = [System.Environment]::GetEnvironmentVariables()",to: "$table = Get-ChildItem Env:",tests: [T_BOUNDARY],expect: "RED"},
  { id: 'M-SELF-TEST', file: PL, from: '// CLI\n', to: '// CLI (comment-only self-test mutant)\n', tests: [T_CH], expect: 'GREEN' },
]

/**
 * A mutant of the launcher closure also changes the pinned launcher digest, so
 * the pin test (P-2) fails for EVERY such mutant. That is a real control, but
 * it says nothing about the behaviour the mutant removed. A mutant therefore
 * counts as KILLED only by a failing test OUTSIDE the pin block.
 */
const PIN_BLOCK = 'P-2: the launcher build is deterministic and pinned'

function runTests(root: string, tests: readonly string[]): { green: boolean; failed: number | null; killedBy: string[] } {
  // The JSON report is written to a FILE, not stdout: a mutant that makes many tests fail also prints
  // FAIL dumps to stdout, and scraping the first '{' out of that mixed stream mis-parses. The file is the
  // reporter's sole, clean JSON, so kill attribution (killedBy) is reliable.
  const reportFile = join(mkdtempSync(join(tmpdir(), 'd1-mut-report-')), 'report.json')
  const r = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--testTimeout=180000', '--reporter=json', `--outputFile=${reportFile}`, ...tests], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  let failed: number | null = null
  let killedBy: string[] = []
  try {
    const raw = existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : r.stdout.slice(r.stdout.indexOf('{'))
    const j = JSON.parse(raw) as {
      numFailedTests: number
      numTotalTests: number
      testResults: Array<{ assertionResults: Array<{ status: string; fullName: string }> }>
    }
    failed = j.numFailedTests
    if (j.numTotalTests === 0) failed = null
    killedBy = j.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === 'failed' && !a.fullName.startsWith(PIN_BLOCK)).map((a) => a.fullName))
  } catch {
    failed = null
  } finally {
    rmSync(dirname(reportFile), { recursive: true, force: true })
  }
  // GREEN = nothing outside the pin block failed (and the run produced a report).
  return { green: failed !== null && killedBy.length === 0, failed, killedBy }
}

export function runBattery(root: string, opts: { only?: readonly string[]; checkAnchorsOnly?: boolean } = {}) {
  const chosen = MUTANTS.filter((m) => opts.only === undefined || opts.only.includes(m.id))
  const originals = new Map<string, string>()
  for (const m of chosen) if (!originals.has(m.file)) originals.set(m.file, readFileSync(join(root, m.file), 'utf8'))
  for (const m of chosen) {
    const n = originals.get(m.file)!.split(m.from).length - 1
    if (n !== 1) throw new Error(`${m.id}: anchor occurs ${n} times in ${m.file}`)
  }
  if (opts.checkAnchorsOnly) return { anchors: 'OK', mutants: chosen.map((m) => m.id) }
  const results: Array<{ id: string; expect: string; observed: string; failedTests: number | null; killedBy: string[]; asExpected: boolean }> = []
  try {
    for (const m of chosen) {
      const original = originals.get(m.file)!
      writeFileSync(join(root, m.file), original.replace(m.from, m.to))
      let r: { green: boolean; failed: number | null; killedBy: string[] }
      try {
        r = runTests(root, m.tests)
      } finally {
        writeFileSync(join(root, m.file), original)
      }
      if (readFileSync(join(root, m.file), 'utf8') !== original) throw new Error(`${m.file} was not restored byte for byte`)
      const observed = r.green ? 'GREEN' : 'RED'
      results.push({ id: m.id, expect: m.expect, observed, failedTests: r.failed, killedBy: r.killedBy, asExpected: observed === m.expect })
      process.stdout.write(`${JSON.stringify(results[results.length - 1])}\n`)
    }
  } finally {
    for (const [f, t] of originals) writeFileSync(join(root, f), t)
  }
  const selfTest = results.find((r) => r.id === 'M-SELF-TEST')
  return {
    results,
    red: results.filter((r) => r.expect === 'RED' && r.observed === 'RED').length,
    expectedRed: results.filter((r) => r.expect === 'RED').length,
    survivors: results.filter((r) => r.expect === 'RED' && r.observed !== 'RED').map((r) => r.id),
    selfTestSurvived: selfTest === undefined ? null : selfTest.observed === 'GREEN',
    allAsExpected: results.every((r) => r.asExpected),
  }
}

if (/d1-mint-operator-channel-mutation\.(ts|js)$/.test(process.argv[1] ?? '')) {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',')
  const summary = runBattery(process.cwd(), { only, checkAnchorsOnly: process.argv.includes('--check-anchors') })
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}
