// scripts/infra-read/mutation-battery.mjs — production-code mutation battery for the safe-read executor.
// Run from the repository root: node scripts/infra-read/mutation-battery.mjs
// Each mutant is applied, tests/infra-read is run, and the file is restored from an
// in-memory byte copy (never git checkout) and verified by SHA-256. Every mutant must be KILLED.
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const R = process.cwd().split('\\').join('/') + '/'
const G = R + 'scripts/infra-read/guards.ts'
const E = R + 'scripts/infra-read/executor.ts'
const X = R + 'scripts/infra-read/xcc1.ts'
const P = R + 'scripts/infra-read/protocol.ts'
const S = R + 'scripts/infra-read/evidence-scan.ts'

const mutants = [
  ['M01 gh exact-shape check removed', G, "if (!sameArgv(inv.argv, expected)) throw new Refusal('STOP_GH_NON_GET_OR_BODY_FORM'", "if (false) throw new Refusal('STOP_GH_NON_GET_OR_BODY_FORM'", 'RED'],
  ['M02 gh denylist emptied (exact shape still operative)', G, "export const GH_FORBIDDEN_FLAGS = [", "export const GH_FORBIDDEN_FLAGS = [] as string[]; const _unused = [", 'RED'],
  ['M03 vercel exact-shape check removed', G, "if (!sameArgv(inv.argv, expected)) throw new Refusal('STOP_VERCEL_NON_GET_OR_BODY_FORM'", "if (false) throw new Refusal('STOP_VERCEL_NON_GET_OR_BODY_FORM'", 'RED'],
  ['M04 projection conformance disabled', G, "export function assertProjectionConforms(op: OpDef, projection: unknown): void {", "export function assertProjectionConforms(op: OpDef, projection: unknown): void { return;", 'RED'],
  ['M05 G-R1-first check removed', E, "if (!s.ghRepo) throw new Refusal('STOP_GR1_NOT_FIRST'", "if (false) throw new Refusal('STOP_GR1_NOT_FIRST'", 'RED'],
  ['M06 RC-9b check removed', E, "if (op.read === 'G-R2' && !s.rc9bDischarged) {", "if (false) {", 'RED'],
  ['M07 RNA-1 exclusion removed', E, "if (name === ANTIGRAVITY_PROJECT || s.antigravityIds.has(prj)) {", "if (false) {", 'RED'],
  ['M08 freshness refusal removed', E, "if (op.freshness !== 'EXECUTE_NOW') {", "if (false) {", 'RED'],
  ['M09 post-projection secret detectors removed', E, "if (hits.length > 0) {", "if (false) {", 'RED'],
  ['M10 X-R1 preflight requirement removed', E, "if (op.id === 'X-R1' && !s.xcc1PreflightPassed) {", "if (false) {", 'RED'],
  ['M11 GIT_ASKPASS dropped from the XCC-1 env', X, "  GIT_ASKPASS: '',\n", "", 'RED'],
  ['M12 ceiling directory dropped from the XCC-1 env', X, "  env.GIT_CEILING_DIRECTORIES = ctx.root\n", "", 'RED'],
  ['M13 isolation listing accepts file origins', X, "if (origin !== 'command line:') throw", "if (false) throw", 'RED'],
  ['M14 no-commit-since-DN-0 guard disabled', P, "export function assertNoCommitSinceDn0(git: LocalGit, dn0: Dn0Result): void {", "export function assertNoCommitSinceDn0(git: LocalGit, dn0: Dn0Result): void { return;", 'RED'],
  ['M15 post-certification MODIFY accepted', P, "if (kind !== 'A' || !cfg.allowedPostCertificationAdditions", "if (false && !cfg.allowedPostCertificationAdditions", 'RED'],
  ['M16 env-value detector removed', S, "  { id: 'ENV_VALUE_FIELD', re: /\"value\"\\s*:\\s*\"[^\"]+\"/ },\n", "", 'RED'],
  ['M17 V-R1 allowlist admits deploy-hook url', R + 'scripts/infra-read/ops.ts', "  'link.deployHooks[].id', 'link.deployHooks[].name',", "  'link.deployHooks[].url', 'link.deployHooks[].id', 'link.deployHooks[].name',", 'RED'],
]

const sha = (b) => createHash('sha256').update(b).digest('hex')
const results = []
for (const [name, file, find, replace, expect] of mutants) {
  const orig = readFileSync(file)
  const text = orig.toString('utf8')
  const count = text.split(find).length - 1
  if (count !== 1) { results.push([name, `ANCHOR_COUNT=${count}`, expect, 'INVALID']); continue }
  writeFileSync(file, text.replace(find, replace))
  const r = spawnSync('npx vitest run tests/infra-read', { cwd: R, encoding: 'utf8', shell: true, timeout: 300000 })
  writeFileSync(file, orig)
  if (sha(readFileSync(file)) !== sha(orig)) { console.log('RESTORE FAILED for', file); process.exit(9) }
  const out = (r.stdout || '') + (r.stderr || '')
  const failed = /Tests\s+(\d+) failed/.exec(out)
  const verdict = r.status === 0 ? 'SURVIVED' : 'KILLED'
  const ok = (expect === 'RED' && verdict === 'KILLED') || (expect === 'RED' && verdict === 'SURVIVED')
  results.push([name, `${verdict}${failed ? ` (${failed[1]} failing)` : ''}`, expect, ok ? 'AS_EXPECTED' : 'UNEXPECTED'])
}
for (const row of results) console.log(row.join(' | '))
const unexpected = results.filter((r) => r[3] !== 'AS_EXPECTED')
console.log(`MUTANTS=${results.length} AS_EXPECTED=${results.length - unexpected.length} UNEXPECTED=${unexpected.length}`)
