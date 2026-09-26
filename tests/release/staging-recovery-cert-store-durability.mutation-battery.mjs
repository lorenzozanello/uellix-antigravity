#!/usr/bin/env node
// tests/release/staging-recovery-cert-store-durability.mutation-battery.mjs
//
// Independent mutation battery for the Recovery certification STORE DURABILITY
// interpreter (tests/release/staging-recovery-cert-store-durability.test.ts,
// authority STAGING_RECOVERY_EXECUTION_AUTHORITY_AMENDMENT_v1.0.5).
//
// Each mutant is one textual edit (or, where defences are redundant by design,
// one edit per defence applied together) to a copy of the test file. The copy
// is written next to the original under a unique name, run with vitest, and
// deleted. KILLED = the copy fails. Every semantic mutant must be KILLED; the
// HARMLESS mutant (a comment edit) must SURVIVE, proving the battery can report
// a survivor. Every anchor must occur exactly once. The original file must be
// byte-identical afterwards and no mutant copy may remain.
//
// Run:   node tests/release/staging-recovery-cert-store-durability.mutation-battery.mjs
// Check: node tests/release/staging-recovery-cert-store-durability.mutation-battery.mjs --check-anchors
// Subset: RCS_BATTERY_ONLY=K4,N1,HARMLESS node ... (reported as BATTERY_SUBSET_*, never as a full pass)
// This file does nothing when imported; it runs only as a script.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TARGET = 'tests/release/staging-recovery-cert-store-durability.test.ts'
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const PREFIX = 'zz-rcs-mutant-'
const CONCURRENCY = Number(process.env.RCS_BATTERY_CONCURRENCY ?? 5)

// EQUIVALENT mutants, deliberately NOT run and NOT counted:
// - each replace-object defence alone (--no-replace-objects, GIT_NO_REPLACE_OBJECTS,
//   core.useReplaceRefs=false): any one still disables replace refs (E1 removes all three);
// - the kind conjunct of W12 (a.subject_kind === r.subject_kind): chainPrefix already
//   restricts the candidates to records of the adjudication's own kind;
// - the :(top,literal) pathspec of the history walk and --full-tree of ls-tree: they make
//   the reads independent of the working directory; every read of this interpreter runs
//   at the repository top level, where the plain root path selects the same entries;
// - dropping GIT_CONFIG_NOSYSTEM or the empty GIT_CONFIG_GLOBAL alone: whether a
//   system or global file exists is a property of the host, not of the repository,
//   so the kill would depend on the machine; the self-check that catches them is
//   mutated instead (E7) and has a host-independent control.
export const EQUIVALENT = [
  'one replace-object defence alone (E1 removes the three together)',
  'W12 kind conjunct (implied by chainPrefix)',
  'GIT_CONFIG_NOSYSTEM / empty GIT_CONFIG_GLOBAL alone (host-dependent; the scope self-check E7 is mutated instead)',
  ':(top,literal) pathspec magic and ls-tree --full-tree (defences for a working directory other than the top level; every read here runs at the top level)',
]

export const MUTANTS = [
  // ---- controlled git read environment (R3-2)
  { id: 'E1', cls: 'ENV', why: 'replace objects honoured (flag, environment and pin removed together)', edits: [
    { anchor: "const CONTROLLED_FLAGS = ['--no-replace-objects', ...PINNED", replacement: "const CONTROLLED_FLAGS = [...PINNED" },
    { anchor: "    GIT_NO_REPLACE_OBJECTS: '1',\n", replacement: '' },
    { anchor: ".git_read_environment.environment.per_command_flags.filter((f) => f.startsWith('-c '))", replacement: ".git_read_environment.environment.per_command_flags.filter((f) => f.startsWith('-c ') && !f.includes('useReplaceRefs'))" },
  ] },
  { id: 'E2', cls: 'ENV', why: 'grafts honoured', anchor: "    GIT_GRAFT_FILE: GRAFT_FILE,\n", replacement: '' },
  { id: 'E3', cls: 'ENV', why: 'commit-graph honoured', anchor: ".git_read_environment.environment.per_command_flags.filter((f) => f.startsWith('-c '))", replacement: ".git_read_environment.environment.per_command_flags.filter((f) => f.startsWith('-c ') && !f.includes('commitGraph'))" },
  { id: 'E4', cls: 'ENV', why: 'log.showRoot not pinned', anchor: ".git_read_environment.environment.per_command_flags.filter((f) => f.startsWith('-c '))", replacement: ".git_read_environment.environment.per_command_flags.filter((f) => f.startsWith('-c ') && !f.includes('showRoot'))" },
  { id: 'E5', cls: 'ENV', why: 'environment copied from the parent', anchor: "  return {\n    ...env,\n    HOME: HOME_DIR,", replacement: "  return {\n    ...(parent as Record<string, string>),\n    ...env,\n    HOME: HOME_DIR," },
  { id: 'E6', cls: 'ENV', why: 'self-check ignores pins', anchor: "  for (const [k, val] of PINNED) if (effective.get(k.toLowerCase()) !== val) v.push(`pin ${k}=${effective.get(k.toLowerCase())}`)", replacement: '' },
  { id: 'E7', cls: 'ENV', why: 'self-check ignores system/global scopes', anchor: "    if (scope === 'system' || scope === 'global') v.push(`scope ${scope}`)", replacement: '' },
  { id: 'E8', cls: 'ENV', why: 'self-check ignores the object format', anchor: "  if (text(run(cwd, ['rev-parse', '--show-object-format'])) !== 'sha1') v.push('object format')", replacement: '' },
  { id: 'E9', cls: 'ENV', why: 'runner does not refuse a present graft path', anchor: "  if (existsSync(GRAFT_FILE)) throw new Error('graft path present')", replacement: '' },
  { id: 'E10', cls: 'ENV', why: 'consumer ignores object integrity (review B1)', anchor: "  if (i.store.objectIntegrity.length > 0) return { result: 'STOP_GIT_OBJECT_STORE_CORRUPT' }", replacement: '' },
  { id: 'E11', cls: 'ENV', why: 'objects never re-hashed (no fsck)', anchor: "    run(cwd, ['fsck', '--full', '--no-dangling', '--no-progress'])\n    return []", replacement: '    return []' },
  { id: 'E12', cls: 'ENV', why: 'fsck.* configuration tolerated', anchor: "  for (const k of effective.keys()) if (k.startsWith('fsck.')) v.push(`fsck config ${k}`)", replacement: '' },
  // ---- ever-added history (R3-1)
  { id: 'H1', cls: 'HISTORY', why: 'simplified history hides the side branch of a merge -s ours', anchor: "['log', '-z', '--full-history', '--no-renames',", replacement: "['log', '-z', '--no-renames'," },
  { id: 'H2', cls: 'HISTORY', why: 'merge (combined) entries not listed', anchor: "'--no-renames', '--cc', '--raw',", replacement: "'--no-renames', '--raw'," },
  { id: 'H3', cls: 'HISTORY', why: 'merge entries ignored', anchor: "if (meta.startsWith('::') || parents > 1) { v.push(`merge-entry ${p}`); continue }", replacement: "if (meta.startsWith('::') || parents > 1) { continue }" },
  { id: 'H4', cls: 'HISTORY', why: 'two adds tolerated', anchor: "    if (e.n !== 1) v.push(`adds=${e.n} ${p}`)", replacement: "    if (e.n > 2) v.push(`adds=${e.n} ${p}`)" },
  { id: 'H5', cls: 'HISTORY', why: 'modify/delete/rename not violations', anchor: "      else v.push(`${status} ${p}`)", replacement: '      else void status' },
  { id: 'H6', cls: 'HISTORY', why: 'an ever-added path absent at H tolerated (RB-1 merge drop)', anchor: "    if (h === undefined) v.push(`ever-added absent at H ${p}`)", replacement: '    if (h === undefined) void p' },
  { id: 'H7', cls: 'HISTORY', why: 'introducing blob not compared', anchor: "    else if (h !== e.oid) v.push(`introducing blob changed ${p}`)", replacement: '' },
  { id: 'H8', cls: 'HISTORY', why: 'paths with zero adds tolerated', anchor: "  for (const p of atHead.keys()) if (!adds.has(p)) v.push(`adds=0 ${p}`)", replacement: '' },
  { id: 'H9', cls: 'HISTORY', why: 'executable add tolerated', anchor: "    if (e.mode !== '100644') v.push(`add mode ${e.mode} ${p}`)", replacement: '' },
  { id: 'H10', cls: 'HISTORY', why: 'unexpected raw output skipped', anchor: "if (!meta.startsWith(':')) { v.push(`unparsed ${meta}`); continue }", replacement: "if (!meta.startsWith(':')) { continue }" },
  { id: 'H11', cls: 'HISTORY', why: 'consumer skips the history gate', anchor: "  if (i.store.history.length > 0) return { result: 'STOP_ADJUDICATION_HISTORY_VIOLATED' }", replacement: '' },
  { id: 'H13', cls: 'HISTORY', why: 'history walked from the checkout HEAD, not from H (review B2)', anchor: "'--format=%x01%H %P', ref, '--',", replacement: "'--format=%x01%H %P', '--'," },
  { id: 'H12', cls: 'HISTORY', why: 'shallow clone accepted', anchor: "  if (i.store.shallow) return { result: 'STOP_ADJUDICATION_HISTORY_UNVERIFIABLE' }", replacement: '' },
  // ---- canonical store and provider (R3-3)
  { id: 'K1', cls: 'CANONICAL', why: 'provider protection not required', anchor: "  if (!protectionPass(i.provider, CANONICAL_REF)) return { result: 'STOP_PROVIDER_PROTECTION_REQUIRED' }", replacement: '' },
  { id: 'K2', cls: 'CANONICAL', why: 'provider activity witness ignored', anchor: "  if (rewriteWitnessed(i.provider)) return { result: 'STOP_CANONICAL_STORE_REWRITTEN' }", replacement: '' },
  { id: 'K3', cls: 'CANONICAL', why: 'provider ref not compared', anchor: "  if (i.provider.ref !== CANONICAL_REF) return { result: 'STOP_CANONICAL_STORE_REF_MISMATCH' }", replacement: '' },
  { id: 'K4', cls: 'CANONICAL', why: 'genesis ancestry not required', anchor: "  if (!i.isAncestor(i.genesis, i.provider.tip)) return { result: 'STOP_CANONICAL_STORE_NOT_MONOTONIC' }", replacement: '' },
  { id: 'K5', cls: 'CANONICAL', why: 'provider tip need not be an ancestor of H', anchor: "  if (!i.isAncestor(i.provider.tip, i.headSha)) return { result: 'STOP_ADJUDICATION_STORE_STALE' }", replacement: '' },
  { id: 'K6', cls: 'CANONICAL', why: 'reservation tips not required inside the provider tip (force-push)', anchor: "    if (isAttempt(s.record) && !i.isAncestor(s.record.canonical_store.tip_observed_at_reservation, i.provider.tip)) return { result: 'STOP_CANONICAL_STORE_NOT_MONOTONIC' }", replacement: '' },
  { id: 'K7', cls: 'CANONICAL', why: 'containment diagnostic removed', anchor: "  for (const [p, b] of i.store.tipRaw) if (atHead.get(p) !== b) return { result: 'STOP_ADJUDICATION_STORE_STALE' }", replacement: '' },
  { id: 'K8', cls: 'CANONICAL', why: 'uncontrolled environment accepted', anchor: "  if (i.store.envViolations.length > 0) return { result: 'STOP_GIT_READ_ENVIRONMENT_UNCONTROLLED' }", replacement: '' },
  { id: 'P1', cls: 'PROVIDER', why: 'bypass actors tolerated', anchor: '      s.bypass_actors.length === 0 &&\n', replacement: '' },
  { id: 'P2', cls: 'PROVIDER', why: 'evaluate-mode ruleset accepted', anchor: "      s.enforcement === 'active' &&\n", replacement: '' },
  { id: 'P3', cls: 'PROVIDER', why: 'ruleset for another ref accepted', anchor: "      (s.conditions?.ref_name?.include ?? []).some((x) => x === ref || x === '~ALL')", replacement: '      true' },
  { id: 'P4', cls: 'PROVIDER', why: 'rules from different rulesets combined', anchor: "    p.rules.some((r) => r.type === 'deletion' && r.ruleset_id === id),", replacement: "    p.rules.some((r) => r.type === 'deletion')," },
  { id: 'P5', cls: 'PROVIDER', why: 'classic protection without enforce_admins accepted', anchor: ' && c.enforce_admins?.enabled === true', replacement: '' },
  { id: 'P6', cls: 'PROVIDER', why: 'classic protection allowing deletion accepted', anchor: ' && c.allow_deletions?.enabled === false', replacement: '' },
  { id: 'P8', cls: 'PROVIDER', why: 'a second branch_creation (delete/rename and recreate) not flagged', anchor: " || p.activity.filter((a) => a.activity_type === 'branch_creation').length > 1", replacement: '' },
  { id: 'P7', cls: 'PROVIDER', why: 'ruleset target not checked', anchor: "      s.target === 'branch' &&\n", replacement: '' },
  // ---- attempts and state (R3-4, R3-5)
  { id: 'T1', cls: 'STATE', why: 'open attempt does not suspend', anchor: "  if (attempts.some((a) => !resolved.has(a.path))) return out('OPEN_ATTEMPT', 'STOP_RECERT_ATTEMPT_OPEN')", replacement: '' },
  { id: 'T2', cls: 'STATE', why: 'contradiction not reported', anchor: "  if (d.status === 'CONTRADICTED') return out('CONTRADICTED', 'STOP_CONTRADICTORY_CERTIFICATION')", replacement: '' },
  { id: 'T3', cls: 'STATE', why: 'revocation not reported', anchor: "  if (d.status === 'REVOKED') return out('RESOLVED_NON_POSITIVE', 'STOP_CERTIFICATION_REVOKED')", replacement: '' },
  { id: 'T4', cls: 'STATE', why: 'contradiction read as revocation', anchor: '  if (adjudications.slice(firstNeg + 1).some(pos)) return { status: \'CONTRADICTED\', positives }', replacement: '' },
  { id: 'T5', cls: 'STATE', why: 'state not bound to the package digest', anchor: '  const mine = ordered.filter((s) => s.record.subject?.package_digest === digest)', replacement: '  const mine = ordered.filter(() => true)' },
  { id: 'T6', cls: 'STATE', why: 'NO_ATTEMPT read as usable', anchor: "  if (attempts.length === 0) return out('NO_ATTEMPT', 'STOP_NOT_CERTIFIED')", replacement: '' },
  { id: 'T7', cls: 'STATE', why: 'negative-only read as usable', anchor: "  if (d.status === 'NEGATIVELY_ADJUDICATED') return out('RESOLVED_NON_POSITIVE', 'STOP_NOT_CERTIFIED')", replacement: '' },
  { id: 'R1', cls: 'RESOLUTION', why: 'resolution check removed', anchor: "    if (!att || !isAttempt(att.record)) return 'STOP_RECERT_ATTEMPT_RESOLUTION_INVALID'", replacement: "    if (!att || !isAttempt(att.record)) return null" },
  { id: 'R2', cls: 'RESOLUTION', why: 'adjudicator not bound to the reservation', anchor: '      identityKey(a.reservation.adjudicator_lane_id) === identityKey(r.provenance.independent_adjudicator.lane_id) &&\n', replacement: '      true &&\n' },
  { id: 'R10', cls: 'RESOLUTION', why: 'reservation may follow the adjudication (review N1)', anchor: ' &&\n      a.reservation.reservation_date <= r.provenance.independent_adjudicator.adjudication_date\n', replacement: '\n' },
  { id: 'R3', cls: 'RESOLUTION', why: 'candidate not bound', anchor: '      a.subject.candidate_sha === r.subject.candidate_sha &&\n', replacement: '' },
  { id: 'R4', cls: 'RESOLUTION', why: 'tree not bound', anchor: '      a.subject.tree_sha === r.subject.tree_sha &&\n', replacement: '' },
  { id: 'R5', cls: 'RESOLUTION', why: 'package digest not bound', anchor: '      a.subject.package_digest === r.subject.package_digest &&\n', replacement: '' },
  { id: 'R6', cls: 'RESOLUTION', why: 'attempt digest not bound', anchor: '    return recordDigest(a) === ra.record_digest &&\n', replacement: '    return true &&\n' },
  { id: 'R7', cls: 'RESOLUTION', why: 'attempt id not bound', anchor: '      a.attempt_id === ra.attempt_id &&\n', replacement: '' },
  { id: 'R8', cls: 'RESOLUTION', why: 'double resolution tolerated', anchor: "      ? 'STOP_RECERT_ATTEMPT_DOUBLY_RESOLVED'\n", replacement: '      ? null\n' },
  { id: 'R9', cls: 'RESOLUTION', why: 'prefix includes the record itself and later ones', anchor: '  return c.mode === \'write\' ? ordered : at < 0 ? null : ordered.slice(0, at)', replacement: "  return c.mode === 'write' ? ordered : at < 0 ? null : ordered" },
  { id: 'A1', cls: 'ATTEMPT', why: 'prior state not checked', anchor: "    return r.prior_state.state === s.state && r.prior_state.disposition_status === s.disposition ? null : 'STOP_RECERT_ATTEMPT_PRIOR_STATE_MISMATCH'", replacement: '    return null' },
  { id: 'A2', cls: 'ATTEMPT', why: 'second open attempt admitted', anchor: "  { id: 'A9_NOT_ALREADY_OPEN', when: 'both', check: (r) => (r.prior_state.state === 'OPEN_ATTEMPT' ? 'STOP_RECERT_ATTEMPT_ALREADY_OPEN' : null) },", replacement: '' },
  { id: 'A3', cls: 'ATTEMPT', why: 'duplicate attempt ids admitted', anchor: "identityKey(s.record.attempt_id) === identityKey(r.attempt_id)) ? 'STOP_RECERT_ATTEMPT_ID_DUPLICATE' : null },", replacement: 'identityKey(s.record.attempt_id) === identityKey(r.attempt_id)) ? null : null },' },
  { id: 'A4', cls: 'ATTEMPT', why: 'canonical store of the attempt unchecked', anchor: "    r.canonical_store.ref === CANONICAL_REF && HEX40.test(r.canonical_store.tip_observed_at_reservation) ? null : 'STOP_CANONICAL_STORE_REF_MISMATCH' },", replacement: '    null },' },
  { id: 'A5', cls: 'ATTEMPT', why: 'attempt subject not re-derived', anchor: "      if (ref.tree_sha !== r.subject.tree_sha) return 'STOP_TREE_SHA_MISMATCH'\n      if (ref.package_digest", replacement: '      if (ref.package_digest' },
  { id: 'A6', cls: 'ATTEMPT', why: 'attempt digest algorithm unchecked', anchor: " || r.subject.digest_algorithm !== c.contract.subject_identity_derivation.algorithm) return 'STOP_PACKAGE_DIGEST_MISMATCH'", replacement: ") return 'STOP_PACKAGE_DIGEST_MISMATCH'" },
  { id: 'A8', cls: 'ATTEMPT', why: 'reservation date format unchecked', anchor: "    /^\\d{4}-\\d{2}-\\d{2}$/.test(r.reservation.reservation_date) &&\n", replacement: '' },
  { id: 'A7', cls: 'ATTEMPT', why: 'attempt meaning not distinct from adjudication meaning', anchor: '&& r.meaning === c.contract.attempt_meaning', replacement: '&& isStr(r.meaning)' },
  // ---- store integrity
  { id: 'S1', cls: 'STORE', why: 'record type not bound to the file-name form', anchor: "    if (rec?.record_type !== (m[3] ? 'RECERT_ATTEMPT' : 'ADJUDICATION')) { v.push(`record type/file form ${e.path}`); continue }", replacement: '' },
  { id: 'S2', cls: 'STORE', why: 'non-regular entries admitted', anchor: "    if (e.mode !== '100644') { v.push(`mode ${e.mode} ${e.path}`); continue }", replacement: '' },
  { id: 'S3', cls: 'STORE', why: 'non-canonical bytes admitted', anchor: "    if (canonicalPretty(rec) !== e.bytes) { v.push(`not canonical bytes ${e.path}`); continue }", replacement: '' },
  { id: 'S4', cls: 'STORE', why: 'kind/directory mismatch admitted', anchor: "    if (!(kind in codes) || codes[kind] !== m[1]) { v.push(`kind/directory ${e.path}`); continue }", replacement: '' },
  { id: 'S5', cls: 'STORE', why: 'content digest not compared with the file name', anchor: '    if (recordDigest(rec) !== m[4]) v.push(`content digest ${e.path}`)', replacement: '' },
  { id: 'C1', cls: 'CONSUMER', why: 'records of other kinds not validated', anchor: '  for (const s of i.store.records) {\n    const ctx: Ctx = {', replacement: '  for (const s of mine) {\n    const ctx: Ctx = {' },
  { id: 'C2', cls: 'CONSUMER', why: 'currency family rule skipped', anchor: "  if (familyRule(i.contract, i.kind, latest, i.head, i.contractPath) !== 'CURRENT') return { result: 'STOP_NOT_CURRENT', state: st.state }", replacement: '' },
  { id: 'C3', cls: 'CONSUMER', why: 'retired occurrence root ignored', anchor: "  if (i.store.occurrenceRootFiles.length > 0) return { result: 'STOP_RETIRED_OCCURRENCE_ROOT_USED' }", replacement: '' },
  { id: 'C4', cls: 'CONSUMER', why: 'chain integrity of the kind skipped', anchor: "  if (chainIntegrity(mine) !== null) return { result: 'STOP_CHAIN_INTEGRITY_VIOLATED' }", replacement: '' },
  // ---- closure V3
  { id: 'D1', cls: 'CLOSURE', why: 'absent references never excluded (package kind underivable)', anchor: "      if (k.absent_reference_policy === 'EXCLUDE') {", replacement: '      if (false) {' },
  { id: 'D2', cls: 'CLOSURE', why: 'absent references always excluded', anchor: "      if (k.absent_reference_policy === 'EXCLUDE') {", replacement: '      if (true) {' },
  { id: 'D3', cls: 'CLOSURE', why: 'only the first import capture group read', anchor: '          const s = m[1] ?? m[2] ?? m[3]', replacement: '          const s = m[1]' },
  { id: 'D4', cls: 'CLOSURE', why: 'single-"../" runtime literal grammar (v1.0.4 LITERAL_RE)', anchor: "const LITERAL_RE = /['\"`]((?:(?:\\.{1,2}\\/)+[A-Za-z0-9_@-]", replacement: "const LITERAL_RE = /['\"`]((?:(?:\\.{1,2}\\/)?[A-Za-z0-9_@-]" },
  { id: 'D5', cls: 'CLOSURE', why: 'unanchored v1.0.4 import grammar', anchor: "const IMPORT_RE = /^[ \\t]*(?:import|export)\\b[^'\"`;]*?\\bfrom[ \\t]*['\"]([^'\"\\n]+)['\"]|", replacement: "const IMPORT_RE = /\\bfrom\\s*['\"]([^'\"\\n]+)['\"]|" },
  // ---- registry (R3-6)
  { id: 'G1', cls: 'REGISTRY', why: 'keys not discovered (E7 key)', anchor: '          if (withKeys) out.push({ locus: `${p}.${k}#key`, text: k })', replacement: '' },
  { id: 'G2', cls: 'REGISTRY', why: 'no normalization (underscores, hyphens, case)', anchor: "  const norm = (s: string): string => s.replace(/[_-]/g, ' ').replace(/\\s+/g, ' ').toLowerCase()", replacement: '  const norm = (s: string): string => s' },
  { id: 'G4', cls: 'REGISTRY', why: 'owner records not scanned by rule 3 (review B3)', anchor: '    for (const f of [...LAYERS, ...OWNERS]) for (const l of leaves(f, true))', replacement: '    for (const f of LAYERS) for (const l of leaves(f, true))' },
  { id: 'G3', cls: 'REGISTRY', why: 'rule 3 not applied to v1.0.3/v1.0.4 (M-1, next_gate)', anchor: '  const LAYERS = [PATHS.v100, PATHS.v101, PATHS.v102, PATHS.v103, PATHS.v104]', replacement: '  const LAYERS = [PATHS.v100, PATHS.v101, PATHS.v102]' },
  // ---- precedence
  { id: 'N1', cls: 'PRECEDENCE', why: 'anchor domain not checked', anchor: '        if (domainOfPath(a.path) !== allocation[t]) v.push(`domain:${t}`)', replacement: '' },
  // ---- self-test
  { id: 'HARMLESS', cls: 'SELF_TEST', why: 'comment-only edit; must SURVIVE', anchor: '// WHAT THIS FILE IS NOT.', replacement: '// WHAT THIS FILE IS NOT (harmless mutant).', harmless: true },
]

const sha = (b) => createHash('sha256').update(b).digest('hex')
const editsOf = (m) => m.edits ?? [{ anchor: m.anchor, replacement: m.replacement }]

function runVitest(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VITEST, 'run', file], { cwd: ROOT, env: { ...process.env, CI: '' }, windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => child.kill(), 900_000)
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
  const anchorErrors = MUTANTS.flatMap((m) => editsOf(m).filter((e) => src.split(e.anchor).length - 1 !== 1).map((e) => `${m.id}: anchor occurs ${src.split(e.anchor).length - 1} times`))
  const ids = MUTANTS.map((m) => m.id)
  if (new Set(ids).size !== ids.length) anchorErrors.push('duplicate mutant id')
  if (anchorErrors.length > 0 || process.argv.includes('--check-anchors')) {
    console.log(JSON.stringify({ result: anchorErrors.length > 0 ? 'ANCHOR_ERROR' : 'ANCHORS_OK', mutants: MUTANTS.length, anchorErrors }, null, 2))
    process.exit(anchorErrors.length > 0 ? 2 : 0)
  }
  const only = (process.env.RCS_BATTERY_ONLY ?? '').split(',').filter(Boolean)
  const selected = only.length > 0 ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS
  if (only.some((id) => !MUTANTS.some((m) => m.id === id))) {
    console.log(JSON.stringify({ result: 'UNKNOWN_MUTANT_ID', only }, null, 2))
    process.exit(2)
  }
  const results = []
  const queue = [...selected]
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const rel = `tests/release/${PREFIX}${m.id}-${process.pid}.test.ts`
      const abs = path.join(ROOT, rel)
      writeFileSync(abs, editsOf(m).reduce((text, e) => text.replace(e.anchor, () => e.replacement), src))
      try {
        const { code, out } = await runVitest(rel)
        const collected = /Tests\s+\d+/.test(out)
        const failing = [...out.matchAll(/^\s*(?:×|✗|FAIL)\s+(.*)$/gm)].map((x) => x[1].slice(0, 160)).slice(0, 3)
        results.push({ id: m.id, cls: m.cls, why: m.why, harmless: Boolean(m.harmless), outcome: code === 0 ? 'SURVIVED' : collected ? 'KILLED' : 'ERRORED', killed_by: failing })
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
  const selfTest = results.find((r) => r.harmless)?.outcome === 'SURVIVED' || (only.length > 0 && !only.includes('HARMLESS'))
  const pass = survivors.length === 0 && selfTest && residue.length === 0 && before === after
  console.log(JSON.stringify({
    result: only.length > 0 ? (pass ? 'BATTERY_SUBSET_PASS' : 'BATTERY_SUBSET_FAIL') : pass ? 'BATTERY_PASS' : 'BATTERY_FAIL',
    subset: only.length > 0 ? only : null,
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
