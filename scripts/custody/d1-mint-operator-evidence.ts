// scripts/custody/d1-mint-operator-evidence.ts
//
// THE OPERATOR CHANNEL'S PINS AND THE OEP-1 EVIDENCE CONTRACT, readable without
// PRE-HC1 (which imports the post-mint conjuncts that import this module).
//
// CHANNEL_BINDING (execution authority) pins the launcher build digest and the
// two outside tools by sha256. The OEP-1 evidence, written in PHASE 2 through
// the certified channel, closes OEP-1 only if every binding the owner named
// holds: target N04, operator principal, certified tool/launcher hashes,
// timestamp, closed settings list, verdict (RECOMPUTED, never trusted),
// invalidation predicates, and a channel certification event that certifies an
// ancestor candidate carrying the same pins.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { OEP1_SETTINGS, evaluateOep1, type ChannelMode, type Oep1Observation } from '../../db/custody/mint-operator-channel'

export const CHANNEL_AUTHORITY = 'docs/ops/release/FIBDB053_D1_AUDITOR_MINT_OPERATOR_CHANNEL_EXECUTION_AUTHORITY_v1.0.0.json'
export const OEP1_EVIDENCE_DIR = 'docs/ops/release'
export const OEP1_EVIDENCE_PATTERN = /^FIBDB053_D1_AUDITOR_OEP1_LOGGING_POSTURE_EVIDENCE_v(\d+)\.(\d+)\.(\d+)\.json$/
export const OEP1_EVIDENCE_CLASS = 'D1_OEP1_LOGGING_POSTURE_EVIDENCE'

export interface ChannelBinding {
  readonly launcher_build_digest: string
  readonly tools: Readonly<Record<ChannelMode, { readonly file: string; readonly sha256: string }>>
  readonly tools_directory: { readonly base_env: 'LOCALAPPDATA'; readonly relative: string }
}

const HEX64 = /^[0-9a-f]{64}$/

const DAG_BASE = 'docs/ops/release/FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_v1.0.0.json'

/** The DAG's authorized direct host, read (N04 evaluates it; PRE-HC1 requires N04 SATISFIED independently). */
export function authorizedDirectHost(root: string): string | null {
  try {
    const d = JSON.parse(readFileSync(join(root, DAG_BASE), 'utf8')) as { TARGET_IDENTITY?: { authorized_direct_host?: string } }
    return typeof d.TARGET_IDENTITY?.authorized_direct_host === 'string' ? d.TARGET_IDENTITY.authorized_direct_host.toLowerCase() : null
  } catch {
    return null
  }
}

export const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

export function readChannelBinding(root: string): { binding: ChannelBinding | null; reasons: string[] } {
  const p = join(root, CHANNEL_AUTHORITY)
  if (!existsSync(p)) return { binding: null, reasons: ['the operator-channel execution authority is absent'] }
  let b: ChannelBinding | undefined
  try {
    b = (JSON.parse(readFileSync(p, 'utf8')) as { CHANNEL_BINDING?: ChannelBinding }).CHANNEL_BINDING
  } catch {
    return { binding: null, reasons: ['the operator-channel execution authority is not JSON'] }
  }
  return { binding: b ?? null, reasons: bindingShapeReasons(b) }
}

export function bindingShapeReasons(b: ChannelBinding | undefined): string[] {
  const r: string[] = []
  if (b === undefined) return ['CHANNEL_BINDING is absent']
  if (!HEX64.test(String(b.launcher_build_digest))) r.push('CHANNEL_BINDING.launcher_build_digest is not a sha256')
  for (const m of ['probe', 'mint'] as const) {
    const t = b.tools?.[m]
    if (t === undefined || !HEX64.test(String(t.sha256)) || typeof t.file !== 'string' || !/^[\w.-]+\.js$/.test(t.file)) r.push(`CHANNEL_BINDING.tools.${m} is not a file name with a sha256`)
  }
  if (b.tools?.probe?.sha256 === b.tools?.mint?.sha256) r.push('the probe and mint tools are pinned to the same bytes')
  if (b.tools_directory?.base_env !== 'LOCALAPPDATA' || typeof b.tools_directory?.relative !== 'string') r.push('CHANNEL_BINDING.tools_directory is not LOCALAPPDATA-relative')
  return r
}

export function defaultToolsDir(b: ChannelBinding): string | null {
  const base = process.env.LOCALAPPDATA
  return base === undefined ? null : join(base, ...b.tools_directory.relative.split('/'))
}

// ---------------------------------------------------------------------------
// OEP-1 evidence (PHASE 2 writes it; PMR-13 and the mint plan read it)
// ---------------------------------------------------------------------------

export interface Oep1EvidenceFacts {
  readonly path: string | null
  readonly evidence: Readonly<Record<string, unknown>> | null
  /** What git says about the certification event the evidence names (null when none is named or it cannot be read). */
  readonly channelEvent: {
    readonly exists: boolean
    readonly terminalPass: boolean
    readonly candidateIsAncestorOfHead: boolean
    /** CHANNEL_BINDING in the operator-channel authority AT the certified candidate. */
    readonly bindingAtCandidate: ChannelBinding | null
  } | null
}

/** Pure. The reasons the evidence does not close OEP-1 (empty = it does). */
export function oep1EvidenceReasons(f: Oep1EvidenceFacts, ctx: { readonly binding: ChannelBinding | null; readonly targetHost: string | null; readonly n08: string | null }): string[] {
  if (f.evidence === null) return ['no OEP-1 evidence exists (PHASE 2 has not run)']
  const e = f.evidence
  const r: string[] = []
  const s = (k: string): string | null => (typeof e[k] === 'string' ? (e[k] as string) : null)
  if (e.evidence_class !== OEP1_EVIDENCE_CLASS) r.push('evidence_class is not D1_OEP1_LOGGING_POSTURE_EVIDENCE')
  if (e.append_only !== true) r.push('the evidence is not append-only')
  if (ctx.targetHost === null || s('target_host') !== ctx.targetHost) r.push('target_host is not N04\'s host')
  const principal = s('operator_principal')
  const identity = e.identity as { current_user?: unknown; session_user?: unknown } | undefined
  if (principal === null || identity?.session_user !== principal || identity?.current_user !== principal) r.push('operator_principal is not the observed session and current user')
  if (ctx.binding === null) r.push('no CHANNEL_BINDING to compare the evidence against')
  else {
    if (s('probe_tool_sha256') !== ctx.binding.tools.probe.sha256) r.push('probe_tool_sha256 is not the pinned probe tool')
    if (s('launcher_build_digest') !== ctx.binding.launcher_build_digest) r.push('launcher_build_digest is not the pinned launcher')
  }
  const at = s('observed_at_utc')
  if (at === null || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(at)) r.push('observed_at_utc is not a strict UTC instant')
  else if (ctx.n08 !== null && Date.parse(at) >= Date.parse(ctx.n08)) r.push('the observation is not before N08')
  const obs = e.observation as Oep1Observation | undefined
  if (obs === undefined || !Array.isArray(obs.rows) || !Array.isArray(obs.extensions)) r.push('observation is absent or malformed')
  else {
    const names = obs.rows.map((x) => x.name)
    if (JSON.stringify(e.settings_list) !== JSON.stringify(OEP1_SETTINGS)) r.push('settings_list is not the closed list')
    if (names.some((n) => !OEP1_SETTINGS.includes(n))) r.push('the observation carries a setting outside the closed list')
    const v = evaluateOep1(obs)
    if (e.verdict !== v.verdict) r.push(`the recorded verdict ${String(e.verdict)} is not the recomputed ${v.verdict}`)
    if (v.verdict !== 'PASS') r.push(`the recomputed verdict is ${v.verdict}; only PASS closes OEP-1`)
  }
  if (!Array.isArray(e.invalidation_predicates) || e.invalidation_predicates.length === 0) r.push('invalidation_predicates are absent')
  const ev = f.channelEvent
  if (ev === null) r.push('the evidence names no channel certification event')
  else {
    if (!ev.exists) r.push('the named channel certification event does not exist')
    if (!ev.terminalPass) r.push('the named channel certification event is not a terminal PASS with 0 blocking findings')
    if (!ev.candidateIsAncestorOfHead) r.push('the channel certification event does not certify an ancestor of HEAD')
    if (ctx.binding !== null && JSON.stringify(ev.bindingAtCandidate) !== JSON.stringify(ctx.binding)) r.push('the certified candidate carried different channel pins: the probe did not run through the certified channel')
  }
  return r
}

/** Gather the evidence facts from the repository (the effective = highest version). */
export function gatherOep1EvidenceFacts(root: string): Oep1EvidenceFacts {
  const dir = join(root, OEP1_EVIDENCE_DIR)
  const files = (existsSync(dir) ? readdirSync(dir) : [])
    .map((n) => ({ n, m: OEP1_EVIDENCE_PATTERN.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]) || Number(a.m[2]) - Number(b.m[2]) || Number(a.m[3]) - Number(b.m[3]))
  if (files.length === 0) return { path: null, evidence: null, channelEvent: null }
  const rel = `${OEP1_EVIDENCE_DIR}/${files[files.length - 1]!.n}`
  let evidence: Record<string, unknown> | null = null
  try {
    evidence = JSON.parse(readFileSync(join(root, rel), 'utf8')) as Record<string, unknown>
  } catch {
    evidence = { unparseable: true }
  }
  const eventPath = typeof evidence.channel_certification_event === 'string' ? evidence.channel_certification_event : null
  if (eventPath === null) return { path: rel, evidence, channelEvent: null }
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return null
    }
  }
  const exists = existsSync(join(root, eventPath))
  let body: Record<string, unknown> = {}
  try {
    body = exists ? (JSON.parse(readFileSync(join(root, eventPath), 'utf8')) as Record<string, unknown>) : {}
  } catch {
    body = {}
  }
  const cand = typeof body.candidate_commit === 'string' && /^[0-9a-f]{40}$/.test(body.candidate_commit) ? body.candidate_commit : null
  const terminalPass = (body.verdict_class === 'PASS' || body.verdict_class === 'PASS_WITH_NONBLOCKING_FINDINGS') && body.blocking_findings === 0
  const ancestor = cand !== null && git(['merge-base', '--is-ancestor', cand, 'HEAD']) !== null
  let bindingAtCandidate: ChannelBinding | null = null
  const text = cand === null ? null : git(['show', `${cand}:${CHANNEL_AUTHORITY}`])
  if (text !== null) {
    try {
      bindingAtCandidate = (JSON.parse(text) as { CHANNEL_BINDING?: ChannelBinding }).CHANNEL_BINDING ?? null
    } catch {
      bindingAtCandidate = null
    }
  }
  return { path: rel, evidence, channelEvent: { exists, terminalPass, candidateIsAncestorOfHead: ancestor, bindingAtCandidate } }
}

// ---------------------------------------------------------------------------
// What PRE-HC1 gathers for PMR-11 / PMR-12 / PMR-13
// ---------------------------------------------------------------------------

export interface OperatorChannelFacts {
  readonly binding: ChannelBinding | null
  readonly bindingReasons: readonly string[]
  /** The launcher rebuilt deterministically from this repository, or null if the build failed. */
  readonly launcherBuildDigest: string | null
  /** What the execution authority states, to be compared byte for byte with the implementation. */
  readonly authorityStates: {
    readonly clauseIds: readonly string[] | null
    readonly settingsList: readonly string[] | null
    readonly probeStatements: Readonly<Record<string, string>> | null
  }
  readonly operatorSectionReasons: readonly string[]
  readonly oep1: { readonly facts: Oep1EvidenceFacts; readonly targetHost: string | null; readonly n08: string | null }
}

export function gatherOperatorChannelFacts(
  root: string,
  deps: {
    readonly buildDigest: (root: string) => string
    readonly operatorSectionReasons: (section: unknown) => string[]
    readonly effectiveN08: (root: string) => string | null
  }
): OperatorChannelFacts {
  const { binding, reasons } = readChannelBinding(root)
  let launcherBuildDigest: string | null = null
  try {
    launcherBuildDigest = deps.buildDigest(root)
  } catch {
    launcherBuildDigest = null
  }
  let doc: { CHANNEL_CONTRACT?: { clause_ids?: string[] }; OEP1_PROBE_CONTRACT?: { settings_list?: string[]; statements?: Record<string, string> } } = {}
  try {
    doc = JSON.parse(readFileSync(join(root, CHANNEL_AUTHORITY), 'utf8')) as typeof doc
  } catch {
    doc = {}
  }
  let inventory: { operator_credential?: unknown } = {}
  try {
    inventory = JSON.parse(readFileSync(join(root, 'docs/ops/staging/FIBDB053_AUDITOR_CREDENTIAL_CUSTODY_INVENTORY_v1.0.0.json'), 'utf8')) as typeof inventory
  } catch {
    inventory = {}
  }
  return {
    binding,
    bindingReasons: reasons,
    launcherBuildDigest,
    authorityStates: {
      clauseIds: doc.CHANNEL_CONTRACT?.clause_ids ?? null,
      settingsList: doc.OEP1_PROBE_CONTRACT?.settings_list ?? null,
      probeStatements: doc.OEP1_PROBE_CONTRACT?.statements ?? null,
    },
    operatorSectionReasons: deps.operatorSectionReasons(inventory.operator_credential),
    oep1: { facts: gatherOep1EvidenceFacts(root), targetHost: authorizedDirectHost(root), n08: deps.effectiveN08(root) },
  }
}
