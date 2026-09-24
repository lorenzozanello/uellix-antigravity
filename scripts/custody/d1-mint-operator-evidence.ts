// scripts/custody/d1-mint-operator-evidence.ts
//
// THE OPERATOR CHANNEL'S PINS AND THE OEP-1 EVIDENCE CONTRACT, readable without
// PRE-HC1 (which imports the post-mint conjuncts that import this module).
//
// THE CHANNEL AUTHORITY IS AN APPEND-ONLY CHAIN. v1.0.0 is never edited; each
// amendment (…_EXECUTION_AUTHORITY_AMENDMENT_v1.0.N) names the link it
// supersedes and REPLACES the top-level sections it carries (CHANNEL_BINDING,
// CHANNEL_CONTRACT, OEP1_PROBE_CONTRACT, ...). The effective authority is the
// last link; a broken chain is an error, never a silent pick. The same reader
// runs on the working tree or on a certified candidate through git.
//
// OEP-1 v2 (owner decision N11_PASSWORD_TRANSPORT =
// CLIENT_SIDE_POSTGRESQL_SCRAM_SHA_256_VERIFIER): the evidence closes OEP-1
// only if every gating sub-verdict is PASS, each RECOMPUTED here and never
// trusted from the record:
//   PLAINTEXT_NOT_SERVER_VISIBLE      by construction: SCRAM-verifier transport,
//                                     DO-block guard, the certified mint tool
//   TARGET_SESSION_BOUND              N04 host, route-B port and database, the
//                                     observed principal and database
//   STARTUP_PARAMETERS_CLOSED         client-sourced settings = the measured set
//   TOOL_HASH_BOUND                   probe, mint, launcher and driver = the pins
//   PROBE_MINT_CONFIGURATION_COHERENT the probe's session fingerprint = the mint's
// DERIVED_MATERIAL_EXPOSURE is recomputed and must match the record, and gates
// nothing: the verifier is derived material, classified apart.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  OEP1_DERIVED_MATERIAL_SETTINGS,
  OEP1_EXPECTED_CLIENT_SETTINGS,
  classifyDerivedMaterialExposure,
  evaluateOep1Session,
  type ChannelMode,
  type Oep1Observation,
} from '../../db/custody/mint-operator-channel'
import { ROUTE_B_DATABASE, ROUTE_B_PASSWORD_TRANSPORT, ROUTE_B_PORT, ROUTE_B_STATEMENTS } from '../../db/custody/mint-route-b-contract'

export const RELEASE = 'docs/ops/release'
export const CHANNEL_AUTHORITY = `${RELEASE}/FIBDB053_D1_AUDITOR_MINT_OPERATOR_CHANNEL_EXECUTION_AUTHORITY_v1.0.0.json`
export const CHANNEL_AUTHORITY_AMENDMENT = /^FIBDB053_D1_AUDITOR_MINT_OPERATOR_CHANNEL_EXECUTION_AUTHORITY_AMENDMENT_v(\d+)\.(\d+)\.(\d+)\.json$/
export const OEP1_EVIDENCE_DIR = RELEASE
export const OEP1_EVIDENCE_PATTERN = /^FIBDB053_D1_AUDITOR_OEP1_EVIDENCE_v(\d+)\.(\d+)\.(\d+)\.json$/
export const OEP1_EVIDENCE_CLASS = 'D1_OEP1_EVIDENCE_V2'
export const OEP1_GATING_SUBVERDICTS = [
  'PLAINTEXT_NOT_SERVER_VISIBLE',
  'TARGET_SESSION_BOUND',
  'STARTUP_PARAMETERS_CLOSED',
  'TOOL_HASH_BOUND',
  'PROBE_MINT_CONFIGURATION_COHERENT',
] as const

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

// ---------------------------------------------------------------------------
// The effective channel authority (append-only chain)
// ---------------------------------------------------------------------------

/** How the chain reads a file: from the working tree, or from a commit through git. */
export interface AuthoritySource {
  readonly list: () => string[]
  readonly read: (rel: string) => string | null
}

export const workingTreeSource = (root: string): AuthoritySource => ({
  list: () => (existsSync(join(root, RELEASE)) ? readdirSync(join(root, RELEASE)) : []),
  read: (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null),
})

export const commitSource = (root: string, commit: string): AuthoritySource => {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return null
    }
  }
  return {
    list: () => (git(['ls-tree', '--name-only', commit, `${RELEASE}/`]) ?? '').split('\n').filter(Boolean).map((p) => p.slice(RELEASE.length + 1)),
    read: (rel) => git(['show', `${commit}:${rel}`]),
  }
}

export interface EffectiveChannelAuthority {
  readonly doc: Readonly<Record<string, unknown>> | null
  readonly chain: readonly string[]
  readonly errors: readonly string[]
}

export function readEffectiveChannelAuthority(src: AuthoritySource): EffectiveChannelAuthority {
  const baseText = src.read(CHANNEL_AUTHORITY)
  if (baseText === null) return { doc: null, chain: [], errors: ['the operator-channel execution authority is absent'] }
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(baseText) as Record<string, unknown>
  } catch {
    return { doc: null, chain: [], errors: ['the operator-channel execution authority is not JSON'] }
  }
  const errors: string[] = []
  const chain = [CHANNEL_AUTHORITY]
  const amendments = src
    .list()
    .map((n) => ({ n, m: CHANNEL_AUTHORITY_AMENDMENT.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]) || Number(a.m[2]) - Number(b.m[2]) || Number(a.m[3]) - Number(b.m[3]))
  for (const a of amendments) {
    const rel = `${RELEASE}/${a.n}`
    let am: Record<string, unknown>
    try {
      am = JSON.parse(src.read(rel) ?? 'null') as Record<string, unknown>
    } catch {
      errors.push(`${rel} is not JSON`)
      continue
    }
    if (am === null || typeof am !== 'object') {
      errors.push(`${rel} cannot be read`)
      continue
    }
    if (am.append_only !== true) errors.push(`${rel} is not append-only`)
    if (am.supersedes !== chain[chain.length - 1]) errors.push(`${rel} supersedes ${String(am.supersedes)}, not the link before it (${chain[chain.length - 1]})`)
    const replaced = Array.isArray(am.REPLACES_SECTIONS) ? (am.REPLACES_SECTIONS as string[]) : []
    if (replaced.length === 0) errors.push(`${rel} names no REPLACES_SECTIONS`)
    for (const k of replaced) {
      if (!(k in am)) errors.push(`${rel} says it replaces ${k} but does not carry it`)
      else doc = { ...doc, [k]: am[k] }
    }
    chain.push(rel)
  }
  return { doc, chain, errors }
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

export function readChannelBinding(root: string): { binding: ChannelBinding | null; reasons: string[] } {
  const eff = readEffectiveChannelAuthority(workingTreeSource(root))
  if (eff.doc === null) return { binding: null, reasons: [...eff.errors] }
  const b = eff.doc.CHANNEL_BINDING as ChannelBinding | undefined
  return { binding: b ?? null, reasons: [...eff.errors, ...bindingShapeReasons(b)] }
}

export function defaultToolsDir(b: ChannelBinding): string | null {
  const base = process.env.LOCALAPPDATA
  return base === undefined ? null : join(base, ...b.tools_directory.relative.split('/'))
}

// ---------------------------------------------------------------------------
// The certification of the channel (OC-12, IP-6)
// ---------------------------------------------------------------------------

export interface ChannelEventFacts {
  readonly exists: boolean
  readonly terminalPass: boolean
  readonly candidateIsAncestorOfHead: boolean
  /** CHANNEL_BINDING of the EFFECTIVE operator-channel authority AT the certified candidate. */
  readonly bindingAtCandidate: ChannelBinding | null
}

export function gatherChannelEventFacts(root: string, eventPath: string): ChannelEventFacts {
  const exists = existsSync(join(root, eventPath))
  let body: Record<string, unknown> = {}
  try {
    body = exists ? (JSON.parse(readFileSync(join(root, eventPath), 'utf8')) as Record<string, unknown>) : {}
  } catch {
    body = {}
  }
  const cand = typeof body.candidate_commit === 'string' && /^[0-9a-f]{40}$/.test(body.candidate_commit) ? body.candidate_commit : null
  const terminalPass = (body.verdict_class === 'PASS' || body.verdict_class === 'PASS_WITH_NONBLOCKING_FINDINGS') && body.blocking_findings === 0
  let ancestor = false
  if (cand !== null) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', cand, 'HEAD'], { cwd: root, stdio: 'ignore' })
      ancestor = true
    } catch {
      ancestor = false
    }
  }
  const eff = cand === null ? null : readEffectiveChannelAuthority(commitSource(root, cand))
  const bindingAtCandidate = eff === null || eff.doc === null || eff.errors.length > 0 ? null : ((eff.doc.CHANNEL_BINDING as ChannelBinding | undefined) ?? null)
  return { exists, terminalPass, candidateIsAncestorOfHead: ancestor, bindingAtCandidate }
}

/** Pure: does a certification event certify the channel as currently pinned? (OC-12: required to plan the probe.) */
export function channelCertificationReasons(ev: ChannelEventFacts | null, binding: ChannelBinding | null): string[] {
  const r: string[] = []
  if (ev === null) return ['no channel certification event is named']
  if (!ev.exists) r.push('the named channel certification event does not exist')
  if (!ev.terminalPass) r.push('the named channel certification event is not a terminal PASS with 0 blocking findings')
  if (!ev.candidateIsAncestorOfHead) r.push('the channel certification event does not certify an ancestor of HEAD')
  if (binding === null || JSON.stringify(ev.bindingAtCandidate) !== JSON.stringify(binding)) r.push('the certified candidate carried different channel pins: this channel is not the certified one')
  return r
}

// ---------------------------------------------------------------------------
// OEP-1 v2 evidence
// ---------------------------------------------------------------------------

export interface Oep1EvidenceFacts {
  readonly path: string | null
  readonly evidence: Readonly<Record<string, unknown>> | null
  readonly channelEvent: ChannelEventFacts | null
}

/** What the repository says, which the evidence is recomputed against. */
export interface Oep1RepoContext {
  readonly binding: ChannelBinding | null
  readonly targetHost: string | null
  readonly n08: string | null
  /** OT-17: the driver digest the gate derives from the repository. */
  readonly driverDigest: string | null
  /** The route-B transport as implemented, and whether the DO block refuses a non-verifier. */
  readonly transport: string
  readonly doBlockGuarded: boolean
}

/** The repository facts of the route-B transport (never read from a record). */
export function routeBTransportFacts(): { transport: string; doBlockGuarded: boolean } {
  const d = ROUTE_B_STATEMENTS.DO_BLOCK
  const guard = d.indexOf('D1_VERIFIER_REQUIRED')
  return {
    transport: ROUTE_B_PASSWORD_TRANSPORT,
    doBlockGuarded: guard > -1 && guard < d.indexOf('EXECUTE format(') && !d.includes('rotating_password') && 'SET_VERIFIER' in ROUTE_B_STATEMENTS,
  }
}

/** The session the probe observed and the mint will use: every field the two must share. */
export function sessionFingerprint(p: { host: string; port: number; database: string; principal: string; driverDigest: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([p.host, p.port, p.database, p.principal, p.driverDigest, OEP1_EXPECTED_CLIENT_SETTINGS]))
    .digest('hex')
}

/** Recompute every sub-verdict from the observation and the repository. */
export function recomputeOep1(e: Readonly<Record<string, unknown>>, ctx: Oep1RepoContext): {
  readonly subVerdicts: Readonly<Record<(typeof OEP1_GATING_SUBVERDICTS)[number], 'PASS' | 'FAIL'>>
  readonly derived: ReturnType<typeof classifyDerivedMaterialExposure> | null
  readonly reasons: readonly string[]
} {
  const r: string[] = []
  const s = (k: string): string | null => (typeof e[k] === 'string' ? (e[k] as string) : null)
  const principal = s('operator_principal') ?? ''
  const obs = e.observation as Oep1Observation | undefined
  const obsOk = obs !== undefined && typeof obs.identity === 'object' && Array.isArray(obs.client_settings) && Array.isArray(obs.derived_settings)
  if (!obsOk) r.push('observation is absent or malformed')

  const plaintext = ctx.transport === 'CLIENT_SIDE_POSTGRESQL_SCRAM_SHA_256_VERIFIER' && ctx.doBlockGuarded && ctx.binding !== null && s('mint_tool_sha256') === ctx.binding.tools.mint.sha256
  if (!plaintext) r.push('PLAINTEXT_NOT_SERVER_VISIBLE: the transport is not the guarded SCRAM-verifier route B with the certified mint tool')

  const session = obsOk ? evaluateOep1Session(obs, { principal, database: ROUTE_B_DATABASE }) : null
  const bound = session !== null && session.TARGET_SESSION_BOUND === 'PASS' && ctx.targetHost !== null && s('target_host') === ctx.targetHost && e.target_port === ROUTE_B_PORT && s('target_database') === ROUTE_B_DATABASE
  if (!bound) r.push('TARGET_SESSION_BOUND: host, port, database or the observed identity is not the planned session')
  const closed = session !== null && session.STARTUP_PARAMETERS_CLOSED === 'PASS'
  if (!closed) r.push('STARTUP_PARAMETERS_CLOSED: the probe session carried client-sourced settings beyond the measured set')

  const b = ctx.binding
  const hashes = b !== null && s('probe_tool_sha256') === b.tools.probe.sha256 && s('mint_tool_sha256') === b.tools.mint.sha256 && s('launcher_build_digest') === b.launcher_build_digest && ctx.driverDigest !== null && s('driver_digest') === ctx.driverDigest
  if (!hashes) r.push('TOOL_HASH_BOUND: a probe, mint, launcher or driver hash is not the pinned one')

  const expectedFp = ctx.targetHost === null || ctx.driverDigest === null ? null : sessionFingerprint({ host: ctx.targetHost, port: ROUTE_B_PORT, database: ROUTE_B_DATABASE, principal, driverDigest: ctx.driverDigest })
  const coherent = expectedFp !== null && s('session_fingerprint') === expectedFp
  if (!coherent) r.push('PROBE_MINT_CONFIGURATION_COHERENT: the probe session fingerprint is not the one the mint will use')

  const derived = obsOk ? classifyDerivedMaterialExposure(obs.derived_settings) : null
  return {
    subVerdicts: {
      PLAINTEXT_NOT_SERVER_VISIBLE: plaintext ? 'PASS' : 'FAIL',
      TARGET_SESSION_BOUND: bound ? 'PASS' : 'FAIL',
      STARTUP_PARAMETERS_CLOSED: closed ? 'PASS' : 'FAIL',
      TOOL_HASH_BOUND: hashes ? 'PASS' : 'FAIL',
      PROBE_MINT_CONFIGURATION_COHERENT: coherent ? 'PASS' : 'FAIL',
    },
    derived,
    reasons: r,
  }
}

/** Pure. The reasons the evidence does not close OEP-1 (empty = it does). */
export function oep1EvidenceReasons(f: Oep1EvidenceFacts, ctx: Oep1RepoContext): string[] {
  if (f.evidence === null) return ['no OEP-1 evidence exists (PHASE 2 has not run)']
  const e = f.evidence
  const r: string[] = []
  if (e.evidence_class !== OEP1_EVIDENCE_CLASS) r.push(`evidence_class is not ${OEP1_EVIDENCE_CLASS}`)
  if (e.append_only !== true) r.push('the evidence is not append-only')
  const at = typeof e.observed_at_utc === 'string' ? e.observed_at_utc : null
  if (at === null || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(at)) r.push('observed_at_utc is not a strict UTC instant')
  else if (ctx.n08 !== null && Date.parse(at) >= Date.parse(ctx.n08)) r.push('the observation is not before N08')
  if (JSON.stringify(e.derived_settings_list) !== JSON.stringify(OEP1_DERIVED_MATERIAL_SETTINGS)) r.push('derived_settings_list is not the stated list')
  const re = recomputeOep1(e, ctx)
  r.push(...re.reasons)
  const recorded = (e.sub_verdicts ?? {}) as Record<string, unknown>
  for (const k of OEP1_GATING_SUBVERDICTS) if (recorded[k] !== re.subVerdicts[k]) r.push(`the recorded ${k} ${String(recorded[k])} is not the recomputed ${re.subVerdicts[k]}`)
  // E1: a consistent non-PASS record is still not a closure. Only CLOSED, with every gating sub-verdict PASS, closes OEP-1.
  if (e.verdict !== 'CLOSED') r.push(`the recorded verdict ${String(e.verdict)} is not CLOSED; only CLOSED closes OEP-1`)
  if (OEP1_GATING_SUBVERDICTS.some((k) => re.subVerdicts[k] !== 'PASS')) r.push('a gating sub-verdict is not PASS')
  const dm = e.derived_material_exposure as { classification?: unknown } | undefined
  if (re.derived !== null && dm?.classification !== re.derived.classification) r.push('the recorded DERIVED_MATERIAL_EXPOSURE is not the recomputed classification')
  if (!Array.isArray(e.invalidation_predicates) || e.invalidation_predicates.length === 0) r.push('invalidation_predicates are absent')
  r.push(...channelCertificationReasons(f.channelEvent, ctx.binding))
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
  return { path: rel, evidence, channelEvent: eventPath === null ? null : gatherChannelEventFacts(root, eventPath) }
}

// ---------------------------------------------------------------------------
// What PRE-HC1 gathers for PMR-11 / PMR-12 / PMR-14
// ---------------------------------------------------------------------------

export interface OperatorChannelFacts {
  readonly binding: ChannelBinding | null
  readonly bindingReasons: readonly string[]
  /** The launcher rebuilt deterministically from this repository, or null if the build failed. */
  readonly launcherBuildDigest: string | null
  /** What the EFFECTIVE execution authority states, to be compared byte for byte with the implementation. */
  readonly authorityStates: {
    readonly clauseIds: readonly string[] | null
    readonly derivedSettingsList: readonly string[] | null
    readonly expectedClientSettings: unknown
    readonly probeStatements: Readonly<Record<string, string>> | null
  }
  readonly operatorSectionReasons: readonly string[]
  readonly oep1: { readonly facts: Oep1EvidenceFacts; readonly ctx: Oep1RepoContext }
}

export function gatherOperatorChannelFacts(
  root: string,
  deps: {
    readonly buildDigest: (root: string) => string
    readonly operatorSectionReasons: (section: unknown) => string[]
    readonly effectiveN08: (root: string) => string | null
    readonly driverDigest: (root: string) => string | null
  }
): OperatorChannelFacts {
  const { binding, reasons } = readChannelBinding(root)
  let launcherBuildDigest: string | null = null
  try {
    launcherBuildDigest = deps.buildDigest(root)
  } catch {
    launcherBuildDigest = null
  }
  const eff = readEffectiveChannelAuthority(workingTreeSource(root))
  const doc = (eff.doc ?? {}) as { CHANNEL_CONTRACT?: { clause_ids?: string[] }; OEP1_PROBE_CONTRACT?: { derived_settings_list?: string[]; expected_client_settings?: unknown; statements?: Record<string, string> } }
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
      derivedSettingsList: doc.OEP1_PROBE_CONTRACT?.derived_settings_list ?? null,
      expectedClientSettings: doc.OEP1_PROBE_CONTRACT?.expected_client_settings ?? null,
      probeStatements: doc.OEP1_PROBE_CONTRACT?.statements ?? null,
    },
    operatorSectionReasons: deps.operatorSectionReasons(inventory.operator_credential),
    oep1: {
      facts: gatherOep1EvidenceFacts(root),
      ctx: { binding, targetHost: authorizedDirectHost(root), n08: deps.effectiveN08(root), driverDigest: deps.driverDigest(root), ...routeBTransportFacts() },
    },
  }
}
