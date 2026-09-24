// scripts/recovery/mutation-battery.ts — mutation pressure on the offline
// recovery mechanism (test manifest OR-M1..OR-M14, OR-M-SELF, and the
// remediation classes of the recert of ec573e9b).
//
//   pnpm exec tsx scripts/recovery/mutation-battery.ts             # unit mutants
//   pnpm exec tsx scripts/recovery/mutation-battery.ts --with-pg   # + real-PostgreSQL mutants
//   pnpm exec tsx scripts/recovery/mutation-battery.ts --self-test # proves it can FAIL
//
// Each mutant REMOVES or NEUTRALISES one safety guarantee in source (one or
// more edits, possibly in several files), runs the tests that are supposed to
// notice, and restores every touched file from the ORIGINAL BYTES held in
// memory (never `git checkout`, which would also discard uncommitted work).
// Restoration is verified by sha256.
//
// kill_class records WHY a mutant dies:
//   BYPASS          — the guarantee is the only thing standing between the bad
//                     input and a PASS; a behavioral negative test catches it.
//   TOKEN_PRECISION — another layer still refuses, and the test dies only
//                     because it pins the EXACT refusal reason. Labelled so
//                     defence in depth is not mistaken for a single point of
//                     failure — or the reverse.
//
// Precondition: the unmutated suites must be green, or every mutant "dies".

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { aggregateBattery, classifyMutant, observeVitest, type Expectation, type MutantOutcome } from './mutation-verdict'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const UNIT = 'tests/recovery'
const PG_PRINCIPAL = 'tests/recovery/principal-reachability.pg.test.ts'

export interface Edit {
  file: string
  anchor: string
  replacement: string
}

export interface Mutant {
  id: string
  edits: Edit[]
  tests: string[]
  /** Needs UELLIX_PG_TESTS=1 (Docker). Run only with --with-pg. */
  pg?: boolean
  expect: Expectation
  killClass: 'BYPASS' | 'TOKEN_PRECISION' | 'SELF_TEST_NEUTRAL'
  guarantee: string
}

const R = 'scripts/recovery/'
const T = 'tests/recovery/'
const e = (file: string, anchor: string, replacement: string): Edit => ({ file: `${R}${file}`, anchor, replacement })

export const MUTANTS: Mutant[] = [
  { id: 'OR-M1', edits: [e('artifact-integrity.ts', "return { ok: false, code: 'ARTIFACT_TOC_RELATIONS_MISMATCH' }", 'return null')], tests: [`${T}artifact-integrity.test.ts`, `${T}restore-runner.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'TOC TABLE entries must equal the bound census relations' },
  { id: 'OR-M2', edits: [e('artifact-integrity.ts', "if (sha256 !== packetArtifactSha256(packet)) return { ok: false, code: 'ARTIFACT_DIGEST_MISMATCH' }", '')], tests: [`${T}artifact-integrity.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'recomputed digest must equal the packet content digest' },
  { id: 'OR-M3', edits: [e('substrate.ts', 'if (c.Id !== identity.containerId || labels[RUN_LABEL] !== identity.runId || labels[ROLE_LABEL] !== expectedRole || identity.role !== expectedRole) {', 'if (false) {')], tests: [`${T}restore-runner.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'restore target must be the substrate this run labelled for restore' },
  { id: 'OR-M4', edits: [e('tool-pin.ts', "if (value !== pin.serverVersionNum) refusals.push({ code: 'TOOL_SOURCE_SERVER_VERSION_SKEW', field })", '')], tests: [`${T}tool-pin.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'source server version must equal the pin' },
  { id: 'OR-M5', edits: [e('restore-proof.ts', "if (r.verdict === 'FAIL') reasons.push(`INVARIANT_FAIL_${code}`)", '')], tests: [`${T}restore-runner.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'a FAILED invariant fails the rehearsal whatever the restore exit status' },
  { id: 'OR-M6', edits: [e('post-restore-invariants.ts', "if (!pub.acl.some((a) => a.startsWith('PUBLIC:USAGE:'))) return { ...base, verdict: 'FAIL', reason_code: 'RR_CAP_7_PUBLIC_USAGE_ABSENT' }", '')], tests: [`${T}post-restore-invariants.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'RR-CAP-7 is absolute, even when the source lacks it' },
  { id: 'OR-M7', edits: [e('post-restore-invariants.ts', "return compare(expected, fmt(dst), 'REQUIRED_EXTENSION_MISSING_OR_VERSION_SKEW')", "return compare(expected, expected, 'REQUIRED_EXTENSION_MISSING_OR_VERSION_SKEW')")], tests: [`${T}post-restore-invariants.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'required extensions present with the source version' },
  { id: 'OR-M8', edits: [e('post-restore-invariants.ts', "compare(triggerFacts(src), triggerFacts(dst), 'TRIGGER_STATE_MISMATCH')", "compare(triggerFacts(src), triggerFacts(src), 'TRIGGER_STATE_MISMATCH')")], tests: [`${T}post-restore-invariants.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'trigger enabled state compared with the source' },
  { id: 'OR-M8b', edits: [e('post-restore-invariants.ts', '`${r.schema}.${r.name}:rls=${r.rls}:force=${r.force_rls}`', '`${r.schema}.${r.name}:rls=${r.rls}`')], tests: [`${T}post-restore-invariants.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'FORCE ROW LEVEL SECURITY compared per relation' },
  { id: 'OR-M9', edits: [e('substrate.ts', "const removed = docker.run(['rm', '-f', '-v', target])", "const removed = docker.run(['rm', '-f', target])")], tests: [`${T}substrate.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'container removal takes its anonymous volumes with it' },
  { id: 'OR-M9b', edits: [e('substrate.ts', "if (v.kind === 'named') removeExit = docker.run(['volume', 'rm', v.name]).status", '')], tests: [`${T}substrate.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'the run-named PGDATA volume is removed explicitly' },
  { id: 'OR-M10', edits: [e('substrate.ts', "if (net) throw new SubstrateRefusal('SUBSTRATE_NETWORK_NOT_ISOLATED', net)", '')], tests: [`${T}substrate.test.ts`, `${T}restore-runner.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'inspected network state must be "none" before any byte is streamed' },
  { id: 'OR-M10b', edits: [e('substrate.ts', "'--network',\n      'none',\n", '')], tests: [`${T}substrate.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'the substrate is created with --network none' },
  { id: 'OR-M11', edits: [e('evidence-privacy.ts', "if (!Object.prototype.hasOwnProperty.call(shape.fields, key)) out.push({ path: `${path}.${key}`, problem: 'key not in the evidence grammar' })", '')], tests: [`${T}evidence-privacy.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'closed evidence objects: an unknown nested key is refused' },
  { id: 'OR-M11b', edits: [e('evidence-privacy.ts', "if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) out.push({ path, problem: 'not a non-negative safe integer' })", '')], tests: [`${T}evidence-privacy.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'a count is an integer, never text' },
  { id: 'OR-M12', edits: [e('recovery-target.ts', 'const verdict = verifyStagingTarget(input, production, sentinelPolicy, expectedProjectRef)', 'const verdict = { ok: true, projectRef: input.declaredProjectRef, signals: [], sentinelDeferred: false } as ReturnType<typeof verifyStagingTarget>')], tests: [`${T}recovery-target.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'hosted identity only through verifyStagingTarget (production veto first)' },
  { id: 'OR-M13', edits: [e('recovery-target.ts', 'if (nameKeys.length > 0) {', 'if (false) {')], tests: [`${T}recovery-target.test.ts`], expect: 'KILLED', killClass: 'TOKEN_PRECISION', guarantee: 'a name-like selector key is refused as SELECTED_BY_NAME (the unknown-key layer would still refuse it)' },
  { id: 'OR-M14', edits: [e('post-restore-invariants.ts', "if (PHASE_RANK[entry.phase] < rank) problems.push({ index, problem: 'PHASE_REGRESSION' })", '')], tests: [`${T}post-restore-invariants.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'no mutating probe before a non-mutating check' },

  // --- B-1: frozen packet shapes -------------------------------------------
  { id: 'B1-M1', edits: [e('artifact-packet.ts', "  return {\n    'target identifier': targetIdentifierOf(i.identity),", "  return {\n    event_class: { value: i.eventClass },\n    'target identifier': targetIdentifierOf(i.identity),")], tests: [`${T}authority-packet-shape.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'BACKUP_PACKET never grows a seventh top-level key' },
  { id: 'B1-M2', edits: [e('restore-proof.ts', "  return {\n    'the backup identifier restored from':", "  return {\n    engine_versions: {},\n    'the backup identifier restored from':")], tests: [`${T}authority-packet-shape.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'RESTORE_PROOF never grows a sixth top-level key' },
  {
    id: 'B1-M3',
    edits: [
      e('artifact-packet.ts', 'export const BACKUP_PACKET_SHAPE: Shape = S.obj(Object.fromEntries(BACKUP_PACKET_CONTENTS.map((c, i) => [c, CONTENT_SHAPES[i]])))', "export const BACKUP_PACKET_SHAPE: Shape = S.obj({ ...Object.fromEntries(BACKUP_PACKET_CONTENTS.map((c, i) => [c, CONTENT_SHAPES[i]])), event_class: S.obj({ value: S.opt(S.str('code')) }) })"),
      e('artifact-packet.ts', "  const top = frozenTopLevelProblems(packet, BACKUP_PACKET_CONTENTS, 'backup_packet')\n  if (top.length > 0) return top\n", ''),
      e('artifact-packet.ts', "  return {\n    'target identifier': targetIdentifierOf(i.identity),", "  return {\n    event_class: { value: i.eventClass },\n    'target identifier': targetIdentifierOf(i.identity),"),
    ],
    tests: [`${T}authority-packet-shape.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: "the implementer's own schema cannot bless an extra key: the oracle is the authority file",
  },

  // --- NB-1: stderr oracle ---------------------------------------------------
  {
    id: 'NB1-M1',
    edits: [
      e('evidence-privacy.ts', 'export type StringGrammar =', "import { createHash } from 'node:crypto'\nexport type StringGrammar ="),
      e('evidence-privacy.ts', '  return { exit_code: code, diagnostic: sqlstateClass(extractSqlstate(stderr)) }', "  return { exit_code: code, diagnostic: sqlstateClass(extractSqlstate(stderr)), stderr_sha256: createHash('sha256').update(stderr).digest('hex') } as ToolOutcome"),
    ],
    tests: [`${T}evidence-privacy.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'no digest of tool stderr is ever emitted',
  },
  { id: 'NB1-M2', edits: [e('evidence-privacy.ts', '  return { exit_code: code, diagnostic: sqlstateClass(extractSqlstate(stderr)) }', '  return { exit_code: code, diagnostic: sqlstateClass(extractSqlstate(stderr)), stderr } as ToolOutcome')], tests: [`${T}evidence-privacy.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'raw stderr is never persisted' },

  // --- NB-2: SET ROLE reachability ------------------------------------------
  { id: 'NB2-M1', edits: [e('capture.ts', '  for (const r of o.reachable_roles) {', '  for (const r of [] as ReachableRole[]) {')], tests: [`${T}capture.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'every role the principal can become is held to the predicates' },
  { id: 'NB2-M2', edits: [e('capture.ts', "pg_has_role(me.oid, r.oid, 'MEMBER')", "pg_has_role(me.oid, r.oid, 'USAGE')")], tests: [PG_PRINCIPAL], pg: true, expect: 'KILLED', killClass: 'BYPASS', guarantee: 'NOINHERIT is not sufficient: SET-only and ADMIN-only memberships are reachable' },
  { id: 'NB2-M3', edits: [e('capture.ts', "pg_has_role(me.oid, r.oid, 'MEMBER')", "pg_has_role(me.oid, r.oid, 'SET')")], tests: [PG_PRINCIPAL], pg: true, expect: 'KILLED', killClass: 'BYPASS', guarantee: 'an ADMIN-only grant (SET FALSE) is still reachable: the principal can grant itself SET' },

  // --- NB-3: behavioral survivors of the recert ------------------------------
  { id: 'NB3-M1', edits: [e('restore-runner.ts', "if (restored.readError || restored.sha256 !== digest) return done('RESTORE_STREAM_DIGEST_MISMATCH', 'the artifact read during the restore pass does not match the packet digest')", '')], tests: [`${T}restore-runner.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'the bytes pg_restore consumed must be the packet digest' },
  { id: 'NB3-M2', edits: [e('restore-runner.ts', "if (toc.readError || toc.sha256 !== digest) return done('RESTORE_STREAM_DIGEST_MISMATCH', 'the artifact read during the TOC pass does not match the packet digest')", '')], tests: [`${T}restore-runner.test.ts`], expect: 'KILLED', killClass: 'TOKEN_PRECISION', guarantee: 'the bytes the TOC check read must be the packet digest (the pg_restore stream check would still stop later)' },
  { id: 'NB3-M3', edits: [e('restore-runner.ts', "if (structure && !structure.ok) return done('RESTORE_ARTIFACT_STRUCTURE_REFUSED', structure.code)", '')], tests: [`${T}restore-runner.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'the runner USES the TOC structure check' },
  { id: 'NB3-M4', edits: [e('capture.ts', "    ...req.scope.extensions.flatMap((e) => ['-e', e]),\n  ]", "    ...req.scope.extensions.flatMap((e) => ['-e', e]),\n    ...(((r: CaptureRequest) => r.eventClass)(req) ? ['--no-comments'] : []),\n  ]")], tests: [`${T}event-class-neutrality.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'event_class cannot alter capture, even through a helper' },
  { id: 'NB3-M5', edits: [e('restore-runner.ts', '  if (req.postRestoreCorpusPath === null) {', '  const { value: cls } = req.packet[NO_MUTATION_CONFIRMATION].the_change_it_precedes.event_class\n  if (req.postRestoreCorpusPath === null || cls !== null) {')], tests: [`${T}event-class-neutrality.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'event_class cannot alter restore, even through destructuring' },
  { id: 'NB3-M6', edits: [e('restore-proof.ts', '  if (evidenceViolations.length > 0 || forbiddenHits > 0) {', '  if (false) {')], tests: [`${T}restore-proof.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'the evidence gate fails the run' },
  { id: 'NB3-M7', edits: [e('evidence-privacy.ts', 'fact: /^[A-Za-z0-9_$.:=,|*@+-]{1,512}$/,', String.raw`fact: /^[\s\S]{1,512}$/,`)], tests: [`${T}evidence-privacy.test.ts`, `${T}restore-proof.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'invariant facts cannot carry row-shaped text' },

  // --- B-STREAM-1: whole-artifact digest, single finalization -----------------
  {
    id: 'STR-M1',
    edits: [e('process.ts', '      if (!fileDone) input.resume()\n    }\n\n    input.on', '      if (!fileDone) {\n        finalize()\n        fileDone = true\n        input.destroy()\n      }\n    }\n\n    input.on')],
    tests: [`${T}streaming.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'an early-exiting consumer never turns the digest into a digest of a prefix',
  },
  {
    id: 'STR-M2',
    edits: [
      e('process.ts', '      if (digest !== null) return\n      const buf', '      const buf'),
      e('process.ts', "    child.on('close', (code) => {\n      childStatus = code ?? 1\n      childDone = true\n      consumerGone()", "    child.on('close', (code) => {\n      finalize()\n      childStatus = code ?? 1\n      childDone = true\n      consumerGone()"),
    ],
    tests: [`${T}streaming.test.ts`],
    expect: 'KILLED',
    killClass: 'BYPASS',
    guarantee: 'no hash update after finalization (the ERR_CRYPTO_HASH_FINALIZED class)',
  },
  { id: 'STR-M3', edits: [e('process.ts', '        status: readError && status === 0 ? 1 : status,', '        status,')], tests: [`${T}streaming.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'a read error is a failure, whatever the consumer exits with' },
  { id: 'STR-M4', edits: [e('process.ts', '      resolve({ status: writeError && status === 0 ? 1 : status, stderr', '      resolve({ status, stderr')], tests: [`${T}streaming.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'a write error is a failure, whatever the producer exits with' },

  // --- B-PRIV-1: column-level write grants --------------------------------------
  { id: 'COL-M1', edits: [e('capture.ts', "   OR (relkind <> 'S' AND has_any_column_privilege(oid, 'INSERT,UPDATE,REFERENCES'))\n", '')], tests: [PG_PRINCIPAL], pg: true, expect: 'KILLED', killClass: 'BYPASS', guarantee: 'a column-level INSERT/UPDATE/REFERENCES grant on the principal is refused' },
  { id: 'COL-M2', edits: [e('capture.ts', "       OR (relkind <> 'S' AND has_any_column_privilege(x.oid, rel.oid, 'INSERT,UPDATE,REFERENCES'))\n", '')], tests: [PG_PRINCIPAL], pg: true, expect: 'KILLED', killClass: 'BYPASS', guarantee: 'a column-level write grant on a REACHABLE role is refused' },

  // --- NB-6: skipped e2e residue ----------------------------------------------
  { id: 'NB6-M1', edits: [{ file: 'tests/postgres/recovery-offline.pg.test.ts', anchor: "  let statusBefore = ''\n", replacement: "  mkdtempSync(path.join(tmpdir(), 'uellix-recovery-battery-'))\n  let statusBefore = ''\n" }], tests: [`${T}skipped-e2e-residue.test.ts`], expect: 'KILLED', killClass: 'BYPASS', guarantee: 'a skipped e2e allocates nothing at collection time' },
]

/** A REAL edit that changes no behaviour. Declared KILLED on purpose: the self-test demands it be reported SURVIVED. */
export const NEUTRAL_MUTANT: Mutant = {
  id: 'OR-M-SELF-NEUTRAL',
  edits: [e('tool-pin.ts', '// EXACT, NOT "COMPATIBLE".', '// EXACT, NOT "COMPATIBLE" (neutral self-test edit).')],
  tests: [`${T}tool-pin.test.ts`],
  expect: 'KILLED',
  killClass: 'SELF_TEST_NEUTRAL',
  guarantee: 'none — a comment',
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

function runVitest(files: string[], pg: boolean): { exit: number | null; output: string } {
  const env = { ...process.env }
  if (pg) env.UELLIX_PG_TESTS = '1'
  else delete env.UELLIX_PG_TESTS
  const res = spawnSync(process.execPath, [VITEST, 'run', ...files], { cwd: ROOT, env, encoding: 'utf8', timeout: pg ? 420_000 : 240_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  return { exit: res.status, output: `${res.stdout ?? ''}\n${res.stderr ?? ''}` }
}

/** uellix-recovery-* temp entries (non-unit) — a mutant that leaks one must not leave it behind. */
const tempResidue = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('uellix-recovery-') && !n.startsWith('uellix-recovery-unit-')))

export function runMutant(m: Mutant): MutantOutcome & { killClass: Mutant['killClass'] } {
  const files = [...new Set(m.edits.map((x) => x.file))]
  const originals = new Map(files.map((f) => [f, readFileSync(path.join(ROOT, f))]))
  let anchorFound = true
  const mutated = new Map(files.map((f) => [f, originals.get(f)!.toString('utf8')]))
  for (const edit of m.edits) {
    const text = mutated.get(edit.file)!
    if (text.split(edit.anchor).length - 1 !== 1) anchorFound = false
    // Function replacement: `$` sequences in the replacement are taken literally.
    mutated.set(edit.file, text.replace(edit.anchor, () => edit.replacement))
  }
  let observed: MutantOutcome['observed'] = 'ERROR'
  const residueBefore = tempResidue()
  if (anchorFound) {
    try {
      for (const f of files) writeFileSync(path.join(ROOT, f), mutated.get(f)!)
      const run = runVitest(m.tests, m.pg === true)
      observed = observeVitest(run.exit, run.output)
    } finally {
      for (const f of files) writeFileSync(path.join(ROOT, f), originals.get(f)!)
      for (const n of tempResidue()) if (!residueBefore.has(n)) rmSync(path.join(tmpdir(), n), { recursive: true, force: true })
    }
  }
  const restoredByteIdentical = files.every((f) => sha(readFileSync(path.join(ROOT, f))) === sha(originals.get(f)!))
  return { id: m.id, expect: m.expect, observed, anchorFound, restoredByteIdentical, killClass: m.killClass }
}

function main(): void {
  const selfTest = process.argv.includes('--self-test')
  const withPg = process.argv.includes('--with-pg')
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',')
  let mutants = selfTest ? [MUTANTS.find((m) => m.id === 'OR-M2')!, NEUTRAL_MUTANT] : MUTANTS.filter((m) => withPg || !m.pg)
  if (only) mutants = mutants.filter((m) => only.includes(m.id))
  const files = [...new Set(mutants.flatMap((m) => m.edits.map((x) => x.file)))]
  const before = new Map(files.map((f) => [f, sha(readFileSync(path.join(ROOT, f)))]))

  const baseline = runVitest([UNIT], false)
  let baselineGreen = observeVitest(baseline.exit, baseline.output) === 'SURVIVED'
  console.log(`BASELINE ${UNIT}: ${baselineGreen ? 'GREEN' : 'NOT GREEN'}`)
  if (mutants.some((m) => m.pg)) {
    const pgBaseline = runVitest([PG_PRINCIPAL], true)
    const pgGreen = observeVitest(pgBaseline.exit, pgBaseline.output) === 'SURVIVED'
    console.log(`BASELINE ${PG_PRINCIPAL} (UELLIX_PG_TESTS=1): ${pgGreen ? 'GREEN' : 'NOT GREEN'}`)
    baselineGreen = baselineGreen && pgGreen
  }

  const outcomes = baselineGreen ? mutants.map((m) => runMutant(m)) : []
  for (const o of outcomes) {
    console.log(`${o.id.padEnd(20)} expect=${o.expect.padEnd(8)} observed=${o.observed.padEnd(8)} ${classifyMutant(o).padEnd(11)} kill_class=${o.killClass} anchor=${o.anchorFound} restored=${o.restoredByteIdentical}`)
  }
  const agg = aggregateBattery(outcomes, baselineGreen)
  const after = files.every((f) => sha(readFileSync(path.join(ROOT, f))) === before.get(f))
  console.log(`FILES_RESTORED_BYTE_IDENTICAL=${after}`)
  console.log(`BATTERY=${agg.battery}${agg.reasons.length ? ` (${agg.reasons.join(',')})` : ''}`)

  if (selfTest) {
    const neutral = outcomes.find((o) => o.id === NEUTRAL_MUTANT.id)
    const real = outcomes.find((o) => o.id === 'OR-M2')
    const ok = agg.battery === 'FAIL' && neutral?.observed === 'SURVIVED' && real !== undefined && classifyMutant(real) === 'AS_EXPECTED' && after
    console.log(`SELF_TEST=${ok ? 'PASS' : 'FAIL'} (a battery that cannot report a survivor is not evidence)`)
    process.exit(ok ? 0 : 1)
  }
  process.exit(agg.battery === 'PASS' && after ? 0 : 1)
}

const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/recovery/mutation-battery.ts')
if (invokedDirectly) main()
