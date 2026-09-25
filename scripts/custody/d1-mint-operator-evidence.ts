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
//   PROBE_MINT_CONFIGURATION_COHERENT the connection the probe OBSERVED (host, port,
//                                     database, user, TLS verified to the pinned
//                                     anchor, the driver digest it loaded) = what
//                                     the mint will use (R3: never constants alone)
//
// The evidence is an explicit append-only CHAIN bound by digests (R4, NB-2):
// every record carries its record_id, the certified candidate it observed, its
// observation time, the facts it derived its verdict from, and the canonical
// sha256 of its own content; each names its predecessor by record_id AND
// content digest. Every link's verdict is RECOMPUTED from its own facts; the
// head must be observed after every link and acknowledge, by id and digest,
// each earlier link that does not recompute to CLOSED. File names carry no
// meaning, and the history may not delete or modify an evidence file.
// DERIVED_MATERIAL_EXPOSURE is recomputed and must match the record, and gates
// nothing: the verifier is derived material, classified apart.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
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
export const OEP1_EVIDENCE_CLASS = 'D1_OEP1_EVIDENCE_V4'
/** AC-8: the only TLS policy the channel binding may carry. */
export const TLS_TRUST_POLICY = 'VERIFY_FULL_PINNED_CA'
const CA_FILE_PATTERN = /^docs\/ops\/release\/FIBDB053_D1_AUDITOR_TLS_TRUST_ROOT_[a-z0-9]+_v\d+\.\d+\.\d+\.crt$/
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
  /** AC-8: the project certificate every governed tool uses as its ONLY trust anchor. */
  readonly tls: {
    readonly policy: typeof TLS_TRUST_POLICY
    readonly ca_file: string
    readonly ca_raw_sha256: string
    readonly ca_der_sha256: string
    readonly ca_spki_sha256: string
  }
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
  const tls = b.tls
  if (tls === undefined || tls.policy !== TLS_TRUST_POLICY) r.push(`CHANNEL_BINDING.tls.policy is not ${TLS_TRUST_POLICY}`)
  else {
    if (!CA_FILE_PATTERN.test(String(tls.ca_file))) r.push('CHANNEL_BINDING.tls.ca_file is not a repository trust-root file')
    for (const k of ['ca_raw_sha256', 'ca_der_sha256', 'ca_spki_sha256'] as const) if (!HEX64.test(String(tls[k]))) r.push(`CHANNEL_BINDING.tls.${k} is not a sha256`)
  }
  return r
}

/**
 * AC-8, measured on the repository copy: exactly one CA certificate whose raw bytes, DER and SPKI
 * are the pinned ones. Returns the bytes' facts or the reasons they are not the governed anchor.
 */
export function caFileReasons(root: string, b: ChannelBinding | null): string[] {
  if (b === null || b.tls === undefined) return ['AC-8: no pinned trust root in CHANNEL_BINDING']
  let bytes: Buffer
  try {
    bytes = readFileSync(join(root, b.tls.ca_file))
  } catch {
    return [`AC-8: the pinned trust root ${b.tls.ca_file} is absent`]
  }
  const r: string[] = []
  if (createHash('sha256').update(bytes).digest('hex') !== b.tls.ca_raw_sha256) r.push('AC-8: the trust-root file bytes are not the pinned ones')
  if ((bytes.toString('latin1').match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1) r.push('AC-8: the trust-root file does not hold exactly one certificate')
  try {
    const x = new X509Certificate(bytes)
    if (!x.ca) r.push('AC-8: the trust root is not a CA certificate')
    if (createHash('sha256').update(x.raw).digest('hex') !== b.tls.ca_der_sha256) r.push('AC-8: the trust root DER is not the pinned one')
    if (createHash('sha256').update(x.publicKey.export({ type: 'spki', format: 'der' })).digest('hex') !== b.tls.ca_spki_sha256) r.push('AC-8: the trust root key is not the pinned one')
  } catch {
    r.push('AC-8: the trust-root file does not parse as a certificate')
  }
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
  /** R4: the certified candidate's identity, as the event states it (null when absent or malformed). */
  readonly candidateCommit: string | null
  readonly packageClosureDigest: string | null
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
  const digest = typeof body.package_closure_digest === 'string' && /^[0-9a-f]{64}$/.test(body.package_closure_digest) ? body.package_closure_digest : null
  return { exists, terminalPass, candidateIsAncestorOfHead: ancestor, bindingAtCandidate, candidateCommit: cand, packageClosureDigest: digest }
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
  /** The chain HEAD (the record no other record names as predecessor). */
  readonly path: string | null
  readonly evidence: Readonly<Record<string, unknown>> | null
  readonly channelEvent: ChannelEventFacts | null
  /** Every record of the chain, root first, with its RECOMPUTED verdict. */
  readonly chain: readonly Oep1ChainLink[]
  /** Why the files do not form one acknowledged chain (empty = they do). */
  readonly chainReasons: readonly string[]
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
export function sessionFingerprint(p: { host: string; port: number; database: string; principal: string; driverDigest: string; anchorSha256: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([p.host, p.port, p.database, p.principal, p.driverDigest, p.anchorSha256, OEP1_EXPECTED_CLIENT_SETTINGS]))
    .digest('hex')
}

/** The connection a v3 probe reports it OBSERVED. */
export interface ObservedConnection {
  readonly host: string
  readonly port: number
  readonly database: string
  readonly user: string
  readonly tls: { readonly verified: boolean; readonly peer_sha256: string | null; readonly anchor_sha256: string | null }
  readonly driver_digest: string
}

/**
 * PROBE_MINT_CONFIGURATION_COHERENT (R3): the probe OBSERVED the session the mint will use. Every
 * term is an observation compared with a bound value -- never a constant compared with itself.
 */
export function coherenceReasons(e: Readonly<Record<string, unknown>>, ctx: Oep1RepoContext): string[] {
  const obs = e.observation as (Oep1Observation & { connection?: ObservedConnection }) | undefined
  const cn = obs?.connection
  if (cn === undefined || cn === null || typeof cn !== 'object') return ['the probe recorded no observed connection']
  const r: string[] = []
  if (ctx.targetHost === null || cn.host !== ctx.targetHost) r.push('the observed host is not the N04 host the mint will use')
  if (cn.port !== ROUTE_B_PORT) r.push('the observed port is not the route-B port')
  if (cn.database !== ROUTE_B_DATABASE) r.push('the observed database is not the route-B database')
  const principal = typeof e.operator_principal === 'string' ? e.operator_principal : null
  if (principal === null || cn.user !== principal || obs?.identity?.current_user !== principal || obs.identity.session_user !== principal) r.push('the observed session user is not the principal the mint will use')
  if (cn.tls?.verified !== true) r.push('the probe did not observe a verified TLS session')
  if (ctx.binding?.tls === undefined || cn.tls?.anchor_sha256 !== ctx.binding.tls.ca_der_sha256) r.push('the observed trust anchor is not the pinned project certificate')
  if (typeof cn.tls?.peer_sha256 !== 'string' || !HEX64.test(cn.tls.peer_sha256)) r.push('the probe recorded no observed server certificate')
  if (ctx.driverDigest === null || cn.driver_digest !== ctx.driverDigest) r.push('the driver the probe loaded is not the driver the mint will load')
  if (r.length === 0) {
    const fp = sessionFingerprint({ host: cn.host, port: cn.port, database: cn.database, principal: cn.user, driverDigest: cn.driver_digest, anchorSha256: cn.tls.anchor_sha256! })
    if (e.session_fingerprint !== fp) r.push('the recorded session fingerprint is not the one of the observed connection')
  }
  return r
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

  const cr = coherenceReasons(e, ctx)
  const coherent = cr.length === 0
  if (!coherent) r.push(...cr.map((x) => `PROBE_MINT_CONFIGURATION_COHERENT: ${x}`))

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
  const at = utcMillis(e.observed_at_utc)
  const n08 = ctx.n08 === null ? null : utcMillis(ctx.n08)
  if (at === null) r.push('observed_at_utc is not an exact, possible, canonical UTC instant')
  else if (n08 !== null && at >= n08) r.push('the observation is not before N08')
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
  // R4: the head observed the certified candidate, and derived its verdict from what the repository says NOW.
  const cand = e.candidate as { commit?: unknown; package_closure_digest?: unknown } | undefined
  if (f.channelEvent === null || cand?.commit !== f.channelEvent.candidateCommit || cand?.package_closure_digest !== f.channelEvent.packageClosureDigest || f.channelEvent.candidateCommit === null)
    r.push('the head does not bind the candidate the channel certification event certifies (commit and package digest)')
  if (canonicalJson(e.derivation_context ?? null) !== canonicalJson(derivationContextOf(ctx))) r.push('the head derived its verdict from other facts than the repository states now (derivation_context)')
  r.push(...f.chainReasons)
  return r
}

/** Canonical JSON: object keys sorted at every depth, so a digest does not depend on key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

/** The canonical sha256 of a record's content, excluding its own content_digest field. */
export function oep1RecordDigest(doc: Readonly<Record<string, unknown>>): string {
  const rest: Record<string, unknown> = { ...doc }
  delete rest.content_digest
  return createHash('sha256').update(canonicalJson(rest)).digest('hex')
}

/** A record with its content_digest set (for the probe's evidence writer and for fixtures). */
export function sealOep1Record<T extends Record<string, unknown>>(doc: T): T & { content_digest: string } {
  return { ...doc, content_digest: oep1RecordDigest(doc) }
}

/** The facts a record derives its verdict from: the repository context, as plain data. */
export function derivationContextOf(ctx: Oep1RepoContext): Record<string, unknown> {
  return { binding: ctx.binding, targetHost: ctx.targetHost, n08: ctx.n08, driverDigest: ctx.driverDigest, transport: ctx.transport, doBlockGuarded: ctx.doBlockGuarded }
}

/** A link's verdict, RECOMPUTED from its own facts (its observation and its derivation_context); never read from its verdict string. */
export function recomputedLinkVerdict(doc: Readonly<Record<string, unknown>>): 'CLOSED' | 'NOT_CLOSED' {
  const dc = doc.derivation_context as Partial<Oep1RepoContext> | undefined
  if (dc === undefined || dc === null || typeof dc !== 'object' || doc.observation === undefined) return 'NOT_CLOSED'
  const ctx: Oep1RepoContext = {
    binding: (dc.binding ?? null) as ChannelBinding | null,
    targetHost: typeof dc.targetHost === 'string' ? dc.targetHost : null,
    n08: typeof dc.n08 === 'string' ? dc.n08 : null,
    driverDigest: typeof dc.driverDigest === 'string' ? dc.driverDigest : null,
    transport: String(dc.transport ?? ''),
    doBlockGuarded: dc.doBlockGuarded === true,
  }
  const re = recomputeOep1(doc, ctx)
  return OEP1_GATING_SUBVERDICTS.every((k) => re.subVerdicts[k] === 'PASS') ? 'CLOSED' : 'NOT_CLOSED'
}

const RECORD_ID = /^OEP1-[A-Za-z0-9._-]{1,64}$/
const UTC = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(\.\d{3})?Z$/

/**
 * IP-4: the ONE canonical UTC parser. Returns the finite epoch-millisecond value of a canonical
 * UTC instant, or null. A syntactically plausible but impossible timestamp is null, never a number:
 * month 1..12, day 1..(days in that month, leap years counted), hour 0..23, minute/second 0..59
 * (no leap second), and the instant must re-serialize to EXACTLY the input (so `Z` and `.SSSZ` are
 * the only accepted shapes and no non-canonical spelling of the same instant is admitted). Date.parse
 * is never used: its leniency is the hole this closes.
 */
export function utcMillis(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const m = UTC.exec(value)
  if (m === null) return null
  const [, y, mo, d, h, mi, s, frac] = m
  const ms = frac === undefined ? 0 : Number(frac.slice(1))
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms)
  if (!Number.isFinite(t)) return null
  // The instant must re-serialize to EXACTLY the input. Date.UTC normalizes out-of-range fields (month 13,
  // day 31 of September, Feb 29 of a common year, hour 24, minute/second 60 for a leap second), so any such
  // impossible timestamp re-serializes to a different instant and is rejected; only a real, canonical UTC passes.
  const iso = new Date(t).toISOString()
  const canonical = frac === undefined ? iso.replace(/\.\d{3}Z$/, 'Z') : iso
  return canonical === value ? t : null
}

export interface Oep1ChainLink {
  readonly path: string
  readonly recordId: string
  /** RECOMPUTED from the link's own facts. */
  readonly verdict: 'CLOSED' | 'NOT_CLOSED'
  readonly observedAt: string | null
}

/**
 * The chain rules (pure; R4-N-CHAIN). Records are {path, doc}; the path is for reporting only.
 *   - every record has a unique record_id and a content_digest equal to the canonical digest of its content;
 *   - exactly one root (predecessor null); every other record names its predecessor by record_id AND
 *     content_digest, and that record exists with that digest (no deletion, no substitution);
 *   - no fork (two records naming one predecessor), no cycle, every record on the chain ending at the head;
 *   - every record is observed STRICTLY after its predecessor (exact UTC instants);
 *   - every link's verdict is recomputed from its own facts; a recorded verdict that its facts do not
 *     recompute to is refused;
 *   - the head acknowledges, by record_id and content_digest with a resolution, exactly the earlier links
 *     that do not recompute to CLOSED, each observed before the head.
 */
export function oep1ChainReasons(records: readonly { readonly path: string; readonly doc: Readonly<Record<string, unknown>> }[]): { head: string | null; chain: Oep1ChainLink[]; reasons: string[] } {
  const reasons: string[] = []
  if (records.length === 0) return { head: null, chain: [], reasons }
  const idOf = (r: { doc: Readonly<Record<string, unknown>> }): string | null => (typeof r.doc.record_id === 'string' && RECORD_ID.test(r.doc.record_id) ? r.doc.record_id : null)
  const byId = new Map<string, (typeof records)[number]>()
  for (const r of records) {
    const id = idOf(r)
    if (id === null) reasons.push(`${r.path} carries no valid record_id`)
    else if (byId.has(id)) reasons.push(`the record_id ${id} is used by more than one record`)
    else byId.set(id, r)
    if (r.doc.content_digest !== oep1RecordDigest(r.doc)) reasons.push(`${r.path}: its content does not match its content_digest (altered or substituted)`)
    if (utcMillis(r.doc.observed_at_utc) === null) reasons.push(`${r.path}: observed_at_utc is not an exact, possible, canonical UTC instant`)
  }
  type Link = { record_id?: unknown; content_digest?: unknown } | null | undefined
  const linkOf = (r: { doc: Readonly<Record<string, unknown>> }): Link => r.doc.predecessor as Link
  const roots = records.filter((r) => linkOf(r) === null)
  if (roots.length !== 1) reasons.push(`the OEP-1 evidence has ${roots.length} roots (records whose predecessor is null); exactly one is required`)
  const successors = new Map<string, string[]>()
  const time = (r: { doc: Readonly<Record<string, unknown>> }): number => utcMillis(r.doc.observed_at_utc) ?? Number.NaN
  for (const r of records) {
    const link = linkOf(r)
    if (link === null) continue
    if (link === undefined || typeof link !== 'object' || typeof link.record_id !== 'string' || typeof link.content_digest !== 'string' || !HEX64.test(link.content_digest)) {
      reasons.push(`${r.path} does not name its predecessor by record_id and content_digest (null for the first record)`)
      continue
    }
    const pred = byId.get(link.record_id)
    if (pred === undefined) {
      reasons.push(`${r.path} names a predecessor that does not exist (deleted?): ${link.record_id}`)
      continue
    }
    if (pred.doc.content_digest !== link.content_digest || oep1RecordDigest(pred.doc) !== link.content_digest) reasons.push(`${r.path} names ${link.record_id} with another content digest (substituted predecessor)`)
    if (!(time(r) > time(pred))) reasons.push(`${r.path} is not observed strictly after its predecessor ${link.record_id}`)
    successors.set(link.record_id, [...(successors.get(link.record_id) ?? []), r.path])
  }
  for (const [id, succ] of successors) if (succ.length > 1) reasons.push(`the OEP-1 evidence forks at ${id}: ${succ.join(', ')}`)
  const heads = records.filter((r) => { const id = idOf(r); return id === null || !successors.has(id) })
  if (heads.length !== 1) reasons.push(`the OEP-1 evidence has ${heads.length} heads; exactly one is required`)
  const head = heads.length === 1 ? heads[0]! : null
  const chain: Oep1ChainLink[] = []
  if (head !== null) {
    const seen = new Set<string>()
    let cur: (typeof records)[number] | undefined = head
    while (cur !== undefined && !seen.has(cur.path)) {
      seen.add(cur.path)
      chain.unshift({ path: cur.path, recordId: idOf(cur) ?? '', verdict: recomputedLinkVerdict(cur.doc), observedAt: typeof cur.doc.observed_at_utc === 'string' ? cur.doc.observed_at_utc : null })
      const link = linkOf(cur)
      cur = link !== null && link !== undefined && typeof link.record_id === 'string' ? byId.get(link.record_id) : undefined
    }
    if (seen.size !== records.length) reasons.push(`${records.length - seen.size} OEP-1 evidence record(s) are not on the chain that ends at the head (orphan or cycle)`)
    for (const l of chain) {
      const doc = byId.get(l.recordId)?.doc
      // A recorded string is never trusted; it may only AGREE with the recomputation (any non-CLOSED word -- FAIL,
      // INCONCLUSIVE, NOT_CLOSED -- agrees with NOT_CLOSED; a missing verdict agrees with nothing).
      if (doc !== undefined && (doc.verdict === undefined || (doc.verdict === 'CLOSED') !== (l.verdict === 'CLOSED')))
        reasons.push(`${l.path}: the recorded verdict ${String(doc.verdict)} is not what its facts recompute to (${l.verdict})`)
    }
    const nonClosed = chain.slice(0, -1).filter((c) => c.verdict !== 'CLOSED')
    const ack = Array.isArray(head.doc.acknowledges) ? (head.doc.acknowledges as Array<{ record_id?: unknown; content_digest?: unknown; resolution?: unknown }>) : null
    if (ack === null) reasons.push('the head does not carry acknowledges')
    else {
      const want = nonClosed.map((c) => c.recordId).sort()
      const got = ack.map((a) => String(a.record_id)).sort()
      if (JSON.stringify(want) !== JSON.stringify(got)) reasons.push(`the head must acknowledge exactly the earlier links that do not recompute to CLOSED [${want.join(', ')}], not [${got.join(', ')}]`)
      for (const a of ack) {
        const target = typeof a.record_id === 'string' ? byId.get(a.record_id) : undefined
        if (target === undefined) continue
        if (a.content_digest !== target.doc.content_digest) reasons.push(`the head acknowledges ${String(a.record_id)} with another content digest`)
        if (typeof a.resolution !== 'string' || a.resolution.trim() === '') reasons.push(`the acknowledgement of ${String(a.record_id)} carries no resolution`)
        if (!(time(head) > time(target))) reasons.push(`the head is not observed after ${String(a.record_id)}, which it claims to supersede`)
      }
    }
  }
  return { head: head?.path ?? null, chain, reasons }
}

/** R4: no OEP-1 evidence file may ever have been deleted or modified in the history of HEAD. */
export function oep1EvidenceHistoryReasons(root: string): string[] {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' })
  } catch {
    return ['the OEP-1 evidence history cannot be read (not a git work tree)']
  }
  let out = ''
  try {
    out = execFileSync('git', ['log', '--full-history', '-m', '--diff-filter=DMRT', '--name-status', '--format=', 'HEAD', '--', `${OEP1_EVIDENCE_DIR}/FIBDB053_D1_AUDITOR_OEP1_EVIDENCE_*`], { cwd: root, encoding: 'utf8' })
  } catch {
    return ['the OEP-1 evidence history cannot be read']
  }
  const touched = out.split(/\r?\n/).filter((l) => l.trim() !== '')
  return touched.length === 0 ? [] : [`an OEP-1 evidence file was deleted, modified or renamed in history: ${touched.slice(0, 3).join('; ')}`]
}

/**
 * C (R5): governed evidence identity is the tracked Git path, not the working-tree filename casing.
 * Inside a git work tree, discovery enumerates `git ls-files` (exact tracked case) so a case-only
 * rename on a case-insensitive filesystem cannot silently drop a FAIL from the chain: reading the
 * tracked name still returns the content, and any divergence between tracked case and on-disk case
 * (or an untracked governed file) is reported as an integrity failure. Outside a git work tree the
 * working-tree listing is used and the separate history check reports it as unverifiable.
 */
export function discoverOep1RecordNames(root: string): { names: string[]; reasons: string[] } {
  const dir = join(root, OEP1_EVIDENCE_DIR)
  const onDisk = (existsSync(dir) ? readdirSync(dir) : []).filter((n) => OEP1_EVIDENCE_PATTERN.test(n))
  let tracked: string[] | null = null
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' })
    tracked = execFileSync('git', ['ls-files', '--', `${OEP1_EVIDENCE_DIR}/`], { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((p) => p.slice(`${OEP1_EVIDENCE_DIR}/`.length))
      .filter((n) => !n.includes('/') && OEP1_EVIDENCE_PATTERN.test(n))
  } catch {
    return { names: onDisk, reasons: [] }
  }
  const reasons: string[] = []
  const diskSet = new Set(onDisk)
  const trackedSet = new Set(tracked)
  for (const t of tracked) {
    if (diskSet.has(t)) continue
    const ci = onDisk.find((n) => n.toLowerCase() === t.toLowerCase())
    reasons.push(ci === undefined ? `a governed OEP-1 record tracked by git is missing from the working tree: ${t}` : `a governed OEP-1 record's on-disk case is not its tracked case (${t} vs ${ci}); governed identity is the tracked path`)
  }
  for (const n of onDisk) {
    if (trackedSet.has(n)) continue
    const ci = tracked.find((t) => t.toLowerCase() === n.toLowerCase())
    reasons.push(ci === undefined ? `an untracked OEP-1 evidence file is present (governed evidence must be tracked): ${n}` : `a governed OEP-1 record's on-disk case is not its tracked case (${ci} vs ${n}); governed identity is the tracked path`)
  }
  return { names: tracked, reasons: [...new Set(reasons)] }
}

/** Gather the evidence facts from the repository: every record as one digest-bound chain, plus its history (R4). */
export function gatherOep1EvidenceFacts(root: string): Oep1EvidenceFacts {
  const { names, reasons: discoveryReasons } = discoverOep1RecordNames(root)
  const history = oep1EvidenceHistoryReasons(root)
  if (names.length === 0) return { path: null, evidence: null, channelEvent: null, chain: [], chainReasons: [...discoveryReasons, ...history.filter((h) => !h.startsWith('the OEP-1 evidence history cannot'))] }
  const records = names.map((n) => {
    const path = `${OEP1_EVIDENCE_DIR}/${n}`
    let doc: Record<string, unknown>
    try {
      doc = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>
    } catch {
      doc = { unparseable: true }
    }
    return { path, doc }
  })
  const { head, chain, reasons } = oep1ChainReasons(records)
  const evidence = head === null ? null : records.find((r) => r.path === head)!.doc
  const eventPath = typeof evidence?.channel_certification_event === 'string' ? evidence.channel_certification_event : null
  return {
    path: head,
    evidence: evidence ?? { unparseable: true },
    channelEvent: eventPath === null ? null : gatherChannelEventFacts(root, eventPath),
    chain,
    chainReasons: [...discoveryReasons, ...reasons, ...history],
  }
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
  /** AC-8: why the repository trust-root file is not the pinned anchor (empty = it is). */
  readonly caReasons: readonly string[]
  /** AC-8: the TLS policy the EFFECTIVE authority states (TLS_TRUST_POLICY section), or null. */
  readonly tlsPolicyStated: string | null
  /** R4 / PMR-16: why the channel does not authenticate the server, MEASURED (empty = it does). */
  readonly serverAuthReasons: readonly string[]
}

export function gatherOperatorChannelFacts(
  root: string,
  deps: {
    readonly buildDigest: (root: string) => string
    readonly operatorSectionReasons: (section: unknown) => string[]
    readonly effectiveN08: (root: string) => string | null
    readonly driverDigest: (root: string) => string | null
    /** R4 / PMR-16: the behavioural measurement of server authentication (d1-server-auth-measure.ts). */
    readonly serverAuth: (root: string, binding: ChannelBinding | null, targetHost: string | null) => string[]
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
    caReasons: caFileReasons(root, binding),
    serverAuthReasons: deps.serverAuth(root, binding, authorizedDirectHost(root)),
    tlsPolicyStated: typeof (eff.doc as { TLS_TRUST_POLICY?: { policy?: unknown } } | null)?.TLS_TRUST_POLICY?.policy === 'string' ? String((eff.doc as { TLS_TRUST_POLICY: { policy: string } }).TLS_TRUST_POLICY.policy) : null,
    oep1: {
      facts: gatherOep1EvidenceFacts(root),
      ctx: { binding, targetHost: authorizedDirectHost(root), n08: deps.effectiveN08(root), driverDigest: deps.driverDigest(root), ...routeBTransportFacts() },
    },
  }
}
