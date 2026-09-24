#!/usr/bin/env node
// tests/release/staging-recovery-cert-adjudication.mutation-battery.mjs
//
// Independent mutation battery for the Recovery certification ADJUDICATION
// interpreter (tests/release/staging-recovery-cert-adjudication.test.ts,
// authority STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.4).
//
// Each mutant is one textual edit (or, where two defences are redundant by
// design, one edit per defence applied together) to a copy of the test file (the reference
// interpreter and its controls). The copy is written next to the original
// under a unique name, run with vitest, and deleted. KILLED = the copy fails.
// Every semantic mutant must be KILLED; the HARMLESS mutant (a comment edit)
// must SURVIVE, proving the battery can report a survivor. Every anchor must
// occur exactly once. The original file must be byte-identical afterwards and
// no mutant copy may remain.
//
// Run: node tests/release/staging-recovery-cert-adjudication.mutation-battery.mjs
// This file does nothing when imported; it runs only as a script.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TARGET = 'tests/release/staging-recovery-cert-adjudication.test.ts'
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const PREFIX = 'zz-rca-mutant-'
const CONCURRENCY = Number(process.env.RCA_BATTERY_CONCURRENCY ?? 6)

// EQUIVALENT mutants, deliberately NOT run and NOT counted:
// - removing only the canonical CONTAINMENT loop in consume(): once the canonical tip
//   is required to be an ancestor of H, a canonical entry missing or changed at H
//   implies a delete or modify in H's history, which the history step (earlier in
//   the consumer order) already stops;
// - removing only '--no-replace-objects', or only GIT_NO_REPLACE_OBJECTS: each alone
//   still disables replace refs (mutant H7 removes both together).
export const EQUIVALENT = ['canonical containment loop (implied by ancestry + write-once history)', "--no-replace-objects alone", 'GIT_NO_REPLACE_OBJECTS alone']

export const MUTANTS = [
  { id: 'H1', cls: 'HISTORY', why: "simplified history (RB-2)", anchor: "'--full-history', ", replacement: "" },
  { id: 'H2', cls: 'HISTORY', why: "merge entries not reported (evil merge)", anchor: "'--cc', ", replacement: "" },
  { id: 'H3', cls: 'HISTORY', why: "merge entries ignored", anchor: "if (parents > 1) v.push(`merge-entry ${status} ${p}`)", replacement: "if (parents > 1) continue" },
  { id: 'H4', cls: 'HISTORY', why: "two adds tolerated", anchor: "for (const [p, n] of adds) if (n !== 1) v.push(`adds=${n} ${p}`)", replacement: "for (const [p, n] of adds) if (n > 2) v.push(`adds=${n} ${p}`)" },
  { id: 'H5', cls: 'HISTORY', why: "modify/delete not violations", anchor: "else v.push(`${status} ${p}`)", replacement: "else void 0" },
  { id: 'H6', cls: 'HISTORY', why: "consumer skips the history gate", anchor: "if (i.store.history.length > 0) return { result: 'STOP_ADJUDICATION_HISTORY_VIOLATED' }", replacement: "" },
  { id: 'H7', cls: 'HISTORY', why: "replace objects honoured (flag and environment removed together; each alone is an equivalent mutant)", edits: [{ anchor: "['--no-replace-objects', '-c', 'log.showRoot=true', 'log',", replacement: "['-c', 'log.showRoot=true', 'log'," }, { anchor: "GIT_NO_REPLACE_OBJECTS: '1', ", replacement: "" }] },
  { id: 'H11', cls: 'HISTORY', why: "grafts honoured", anchor: ", GIT_GRAFT_FILE: path.join(tmpdir(), 'uellix-rca-no-grafts-file')", replacement: "" },
  { id: 'H8', cls: 'HISTORY', why: "local log.showRoot honoured", anchor: "'-c', 'log.showRoot=true', ", replacement: "" },
  { id: 'H9', cls: 'HISTORY', why: "paths with zero adds tolerated", anchor: "for (const p of presentAtHead) if (!adds.has(p)) v.push(`adds=0 ${p}`)", replacement: "" },
  { id: 'H10', cls: 'HISTORY', why: "shallow clone accepted", anchor: "if (i.store.shallow) return { result: 'STOP_ADJUDICATION_HISTORY_UNVERIFIABLE' }", replacement: "" },
  { id: 'R1', cls: 'REVOCATION', why: "contradiction read as revocation", anchor: "if (d.slice(firstNeg + 1).some(pos))", replacement: "if (false)" },
  { id: 'R2', cls: 'REVOCATION', why: "non-positive ignored (PASS stays usable)", anchor: "if (firstNeg < 0) return { status: 'CERTIFIED', stop: null, positives }", replacement: "return { status: 'CERTIFIED', stop: null, positives }" },
  { id: 'R3', cls: 'REVOCATION', why: "revocation bound to candidate instead of digest", anchor: "filter((r) => r.subject.package_digest === digest)", replacement: "filter((r) => r.subject.package_digest === digest && r.subject.candidate_sha === ordered[0]?.record.subject.candidate_sha)" },
  { id: 'R4', cls: 'REVOCATION', why: "revocation across unrelated digests", anchor: "filter((r) => r.subject.package_digest === digest)", replacement: "filter(() => true)" },
  { id: 'R5', cls: 'REVOCATION', why: "latest-wins", anchor: "const firstNeg = d.findIndex((r) => !pos(r))", replacement: "const firstNeg = pos(d[d.length - 1]) ? -1 : d.findIndex((r) => !pos(r))" },
  { id: 'C1', cls: 'CONSUMER', why: "retired occurrence root ignored", anchor: "if (i.store.occurrenceRootFiles.length > 0) return { result: 'STOP_RETIRED_OCCURRENCE_ROOT_USED' }", replacement: "" },
  { id: 'C2', cls: 'CONSUMER', why: "currency family rule skipped", anchor: "if (familyRule(i.contract, i.kind, latest, i.head, i.contractPath) !== 'CURRENT') return { result: 'STOP_NOT_CURRENT', status: disp.status }", replacement: "" },
  { id: 'C3', cls: 'CONSUMER', why: "records not validated at read", anchor: "if (validate(s.record, ctx) !== 'VALID') return { result: 'STOP_ADJUDICATION_INVALID_AT_READ' }", replacement: "" },
  { id: 'C4', cls: 'CONSUMER', why: "store integrity skipped (B1)", anchor: "if (storeIntegrity(i.contract, i.store.raw).length > 0) return { result: 'STOP_ADJUDICATION_STORE_INVALID' }", replacement: "" },
  { id: 'C6', cls: 'CONSUMER', why: "currency against the first positive", anchor: "const latest = disp.positives[disp.positives.length - 1]", replacement: "const latest = disp.positives[0]" },
  { id: 'C7', cls: 'CONSUMER', why: "changed recorded family member ignored", anchor: "if (recorded.get(p) !== blob) return 'STALE_GOVERNING_AUTHORITY_CHANGED'", replacement: "void blob" },
  { id: 'C8', cls: 'CONSUMER', why: "deleted recorded family member ignored", anchor: "for (const p of recorded.keys()) if (head.blob(p) === null) return 'STALE_GOVERNING_AUTHORITY_CHANGED'", replacement: "" },
  { id: 'C9', cls: 'CONSUMER', why: "declared layer blob not compared", anchor: "if (want === null ? p !== contractPath : want !== blob) return 'STALE_GOVERNING_AUTHORITY_CHANGED'", replacement: "void want" },
  { id: 'C10', cls: 'CONSUMER', why: "records of other kinds not validated", anchor: "for (const s of i.store.records) {", replacement: "for (const s of mine) {" },
  { id: 'S1', cls: 'STORE', why: "non-regular entries admitted", anchor: "if (e.mode !== '100644') { v.push(`mode ${e.mode} ${e.path}`); continue }", replacement: "" },
  { id: 'S2', cls: 'STORE', why: "non-canonical bytes admitted", anchor: "if (canonicalPretty(rec) !== e.bytes) { v.push(`not canonical bytes ${e.path}`); continue }", replacement: "" },
  { id: 'S3', cls: 'STORE', why: "kind/directory mismatch admitted", anchor: "if (!(kind in codes) || codes[kind] !== m[1]) { v.push(`kind/directory ${e.path}`); continue }", replacement: "" },
  { id: 'S4', cls: 'STORE', why: "path shape not enforced", anchor: "if (!m) { v.push(`path shape ${e.path}`); continue }", replacement: "if (!m) continue" },
  { id: 'S5', cls: 'STORE', why: "unparsable entry skipped", anchor: "      v.push(`not json ${e.path}`)\n", replacement: "\n" },
  { id: 'P1', cls: 'CHAIN', why: "predecessor digest not checked", anchor: "if (adjudicationDigest(pred.record) !== p.adjudication_digest) return `predecessor digest mismatch ${p.path}`", replacement: "" },
  { id: 'P2', cls: 'CHAIN', why: "multiple roots tolerated", anchor: "if (roots.length !== 1) return `roots=${roots.length}`", replacement: "if (roots.length < 1) return `roots=${roots.length}`" },
  { id: 'P3', cls: 'CHAIN', why: "fork tolerated", anchor: "if (next.length > 1) return `fork at ${cur.path}`", replacement: "" },
  { id: 'P4', cls: 'CHAIN', why: "missing predecessor tolerated", anchor: "if (!pred) return `missing predecessor ${p.path}`", replacement: "if (!pred) continue" },
  { id: 'P5', cls: 'CHAIN', why: "write-time tip digest not compared", anchor: "return p.path === tip.path && p.adjudication_digest === adjudicationDigest(tip.record) ? null", replacement: "return p.path === tip.path ? null" },
  { id: 'P6', cls: 'CHAIN', why: "closed predecessor keys not enforced", anchor: "(r.chain.predecessor === null || keysExact(r.chain.predecessor, n['chain.predecessor (when not null)']))", replacement: "true" },
  { id: 'P7', cls: 'CHAIN', why: "duplicate closures admitted", anchor: "new Set(closes).size === closes.length && ", replacement: "" },
  { id: 'D1', cls: 'CLOSURE', why: "runtime inputs not collected", anchor: "role.set(r, 'RUNTIME_INPUT')", replacement: "void r" },
  { id: 'D2', cls: 'CLOSURE', why: "vitest setupFiles not collected", anchor: "for (const m of (text.get(t) ?? '').matchAll(SETUP_RE)) {", replacement: "for (const m of [] as RegExpMatchArray[]) {" },
  { id: 'D3', cls: 'CLOSURE', why: "comments not stripped", anchor: "const stripComments = (t: string): string => t.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/(^|[^:\\\\])\\/\\/.*$/gm, '$1')", replacement: "const stripComments = (t: string): string => t" },
  { id: 'D4', cls: 'CLOSURE', why: "toolchain roots not required", anchor: "if (!present.has(t)) return `toolchain root missing ${t}`", replacement: "if (!present.has(t)) continue" },
  { id: 'I1', cls: 'PROVENANCE', why: "separator variants counted as distinct", anchor: "const identityKey = (lane: string): string => lane.split('-').join('')", replacement: "const identityKey = (lane: string): string => lane" },
  { id: 'I2', cls: 'PROVENANCE', why: "Unicode lane ids admitted", anchor: "const LANE_RE = /^[A-Z0-9]+(-[A-Z0-9]+)*$/", replacement: "const LANE_RE = /^\\S+$/" },
  { id: 'I3', cls: 'PROVENANCE', why: "examined tree not bound", anchor: " && r.provenance.independent_adjudicator.examined_tree_sha === r.subject.tree_sha", replacement: "" },
  { id: 'V1', cls: 'VERDICT', why: "closed vocabulary not enforced for positives", anchor: "return prefix.every((t) => v.prefix_token_vocabulary.includes(t) || version.test(t)) ? c : null", replacement: "return c" },
  { id: 'V2', cls: 'VERDICT', why: "FAIL without blocking accepted", anchor: ": v.verdict_class === 'FAIL' ? listOk && b.length >= 1", replacement: ": v.verdict_class === 'FAIL' ? listOk" },
  { id: 'V3', cls: 'VERDICT', why: "FULL_SUBJECT with a basis accepted", anchor: "(a.scope === 'FULL_SUBJECT' ? a.scope_basis.length === 0 : a.scope_basis.length > 0)", replacement: "(a.scope === 'FULL_SUBJECT' ? true : a.scope_basis.length > 0)" },
  { id: 'V5', cls: 'VERDICT', why: "PASS with nonblocking findings accepted", anchor: "v.blocking_findings_count === 0 && b.length === 0 && nb === 0", replacement: "v.blocking_findings_count === 0 && b.length === 0" },
  { id: 'V6', cls: 'VERDICT', why: "duplicate nonblocking ids accepted", anchor: "f.every((x) => isStr(x.id) && isStr(x.summary)) && new Set(ids).size === ids.length", replacement: "f.every((x) => isStr(x.id) && isStr(x.summary))" },
  { id: 'V7', cls: 'VERDICT', why: "empty report reference accepted", anchor: " && isStr(a.report_reference)", replacement: "" },
  { id: 'V8', cls: 'VERDICT', why: "identity_facts_basis unchecked", anchor: "r.provenance.identity_facts_basis === 'MATERIALIZER_REDERIVED' &&", replacement: "" },
  { id: 'W1', cls: 'RECORD', why: "meaning unchecked", anchor: " && r.meaning === c.contract.meaning", replacement: "" },
  { id: 'W2', cls: 'RECORD', why: "authority_class unchecked", anchor: "r.authority_class === c.contract.record_schema.authority_class && ", replacement: "" },
  { id: 'W3', cls: 'RECORD', why: "contract path unchecked", anchor: "r.adjudication_contract.path === c.contractPath && ", replacement: "" },
  { id: 'W4', cls: 'RECORD', why: "target families unchecked", anchor: "if (!sameList(r.subject.governing_families, t.governing_families)) return 'STOP_GOVERNING_PIN_MISMATCH'", replacement: "" },
  { id: 'W5', cls: 'RECORD', why: "target members unchecked", anchor: "if (!blobsEqual(r.subject.governing_family_members_at_candidate, t.governing_family_members_at_candidate)) return 'STOP_GOVERNING_PIN_MISMATCH'", replacement: "" },
  { id: 'W6', cls: 'RECORD', why: "derived families unchecked", anchor: "if (!sameList(r.subject.governing_families, d.governing_families)) return 'STOP_GOVERNING_PIN_MISMATCH'", replacement: "" },
  { id: 'W7', cls: 'RECORD', why: "derived members unchecked", anchor: "if (!blobsEqual(r.subject.governing_family_members_at_candidate, d.governing_family_members_at_candidate)) return 'STOP_GOVERNING_PIN_MISMATCH'", replacement: "" },
  { id: 'A1', cls: 'PRECEDENCE', why: "anchor domain not checked", anchor: "if (domainOfPath(a.path) !== allocation[t]) v.push(`domain:${t}`)", replacement: "" },
  { id: 'A2', cls: 'PRECEDENCE', why: "C10 foreign identifiers not checked", anchor: "for (const [t, list] of topicIds) if (t !== m?.topic && list.some((id) => tokenIn(it.item, id))) v.push(`foreign:${i}:${t}`)", replacement: "" },
  { id: 'A3', cls: 'PRECEDENCE', why: "C10 own identifiers not checked", anchor: "if (!own.some((id) => tokenIn(it.item, id))) v.push(`own:${i}`)", replacement: "" },
  { id: 'A4', cls: 'PRECEDENCE', why: "anchor section existence not checked", anchor: "if (!existsSync(path.join(ROOT, a.path)) || !(a.section in readJson<Record<string, unknown>>(a.path))) v.push(`section:${t}`)", replacement: "" },
  { id: 'K1', cls: 'REGISTRY', why: "rule 1 loses its second pattern", anchor: "/occurrence|\\bKS-[AB]\\b/i.test(s) && /\\bCURRENT\\b|\\bvalid\\b|\\bcurrency\\b/.test(s)", replacement: "/occurrence|\\bKS-[AB]\\b/i.test(s)" },
  { id: 'K2', cls: 'REGISTRY', why: "rule 2 loses its second pattern", anchor: "/\\bcertif(ied|ication)\\b/i.test(s) && /\\b(census|offline|HX-[0-9]|authority)\\b/i.test(s)", replacement: "/\\bcertif(ied|ication)\\b/i.test(s)" },
  { id: 'C11', cls: 'CONSUMER', why: "canonical ancestry not required (review NEW-1)", anchor: "if (!i.canonicalIsAncestor) return { result: 'STOP_ADJUDICATION_STORE_STALE' }", replacement: "" },
  { id: 'V9', cls: 'VERDICT', why: "positive-class suffix admitted on a non-positive record (review NEW-3)", anchor: "return !v.positive_classes.some((p) => tokens.slice(-p.split('_').length).join('_') === p)", replacement: "return true" },
  { id: 'F1', cls: 'FIXTURE_READ', why: "blob bytes read trimmed (review NEW-2)", anchor: "bytes: type === 'blob' ? this.gRaw(['cat-file', 'blob', oid]) : ''", replacement: "bytes: type === 'blob' ? this.g(['cat-file', 'blob', oid]).concat('\\n') : ''" },
  { id: 'HARMLESS', cls: 'SELF_TEST', why: 'comment-only edit; must SURVIVE', anchor: '// WHAT THIS FILE IS NOT.', replacement: '// WHAT THIS FILE IS NOT (harmless mutant).', harmless: true },
]

const sha = (b) => createHash('sha256').update(b).digest('hex')

function runVitest(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VITEST, 'run', file], { cwd: ROOT, env: { ...process.env, CI: '' }, windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => child.kill(), 400_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

async function main() {
  const original = readFileSync(path.join(ROOT, TARGET))
  const before = sha(original)
  const src = original.toString('utf8')
  const editsOf = (m) => m.edits ?? [{ anchor: m.anchor, replacement: m.replacement }]
  const anchorErrors = MUTANTS.flatMap((m) => editsOf(m).filter((e) => src.split(e.anchor).length - 1 !== 1).map((e) => `${m.id}: anchor occurs ${src.split(e.anchor).length - 1} times`))
  if (anchorErrors.length > 0) {
    console.log(JSON.stringify({ result: 'ANCHOR_ERROR', anchorErrors }, null, 2))
    process.exit(2)
  }
  const results = []
  const queue = [...MUTANTS]
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const rel = `tests/release/${PREFIX}${m.id}-${process.pid}.test.ts`
      const abs = path.join(ROOT, rel)
      writeFileSync(abs, editsOf(m).reduce((text, e) => text.replace(e.anchor, () => e.replacement), src))
      try {
        const { code, out } = await runVitest(rel)
        const collected = /Tests\s+\d+/.test(out)
        results.push({ id: m.id, cls: m.cls, why: m.why, harmless: Boolean(m.harmless), outcome: code === 0 ? 'SURVIVED' : collected ? 'KILLED' : 'ERRORED' })
      } finally {
        rmSync(abs, { force: true })
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  results.sort((a, b) => MUTANTS.findIndex((m) => m.id === a.id) - MUTANTS.findIndex((m) => m.id === b.id))
  const residue = readdirSync(path.join(ROOT, 'tests/release')).filter((n) => n.startsWith(PREFIX))
  const after = sha(readFileSync(path.join(ROOT, TARGET)))
  const semantic = results.filter((r) => !r.harmless)
  const survivors = semantic.filter((r) => r.outcome !== 'KILLED')
  const selfTest = results.find((r) => r.harmless)?.outcome === 'SURVIVED'
  const pass = survivors.length === 0 && selfTest && residue.length === 0 && before === after
  console.log(JSON.stringify({
    result: pass ? 'BATTERY_PASS' : 'BATTERY_FAIL',
    semantic_mutants: semantic.length,
    killed: semantic.filter((r) => r.outcome === 'KILLED').length,
    survivors,
    harmless_self_test: selfTest ? 'SURVIVED_AS_REQUIRED' : 'NOT_SURVIVED',
    original_byte_identical: before === after,
    residue,
    results,
  }, null, 2))
  process.exit(pass ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && existsSync(VITEST)) await main()
