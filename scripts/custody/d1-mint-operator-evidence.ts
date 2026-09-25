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
// The evidence is an explicit append-only CHAIN (R3): each record names its
// predecessor; the head is evaluated, and it must acknowledge every earlier
// record that did not close OEP-1, so a later PASS cannot silently erase an
// earlier FAIL or INCONCLUSIVE.
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
export const OEP1_EVIDENCE_CLASS = 'D1_OEP1_EVIDENCE_V3'
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
  /** The chain HEAD (the record no other record names as predecessor). */
  readonly path: string | null
  readonly evidence: Readonly<Record<string, unknown>> | null
  readonly channelEvent: ChannelEventFacts | null
  /** Every record of the chain, root first, with its recorded verdict. */
  readonly chain: readonly { readonly path: string; readonly verdict: string }[]
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
  r.push(...f.chainReasons)
  return r
}

const versionOf = (name: string): [number, number, number] | null => {
  const m = OEP1_EVIDENCE_PATTERN.exec(name)
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}
const versionLess = (a: [number, number, number], b: [number, number, number]): boolean => a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))

/**
 * The chain rules (pure; R3-N-CHAIN). Records are {path, doc}. One root (predecessor null); every
 * other record names an existing record with a LOWER version; no two records name the same
 * predecessor; every record is on the chain; the head acknowledges, with a resolution, exactly the
 * earlier records whose verdict is not CLOSED.
 */
export function oep1ChainReasons(records: readonly { readonly path: string; readonly doc: Readonly<Record<string, unknown>> }[]): { head: string | null; chain: { path: string; verdict: string }[]; reasons: string[] } {
  const reasons: string[] = []
  if (records.length === 0) return { head: null, chain: [], reasons }
  const byPath = new Map(records.map((r) => [r.path, r]))
  const pred = (r: { doc: Readonly<Record<string, unknown>> }): string | null | undefined => (r.doc.predecessor === null ? null : typeof r.doc.predecessor === 'string' ? r.doc.predecessor : undefined)
  const roots = records.filter((r) => pred(r) === null)
  if (roots.length !== 1) reasons.push(`the OEP-1 evidence has ${roots.length} roots (records with predecessor null); exactly one is required`)
  const named = new Map<string, string[]>()
  for (const r of records) {
    const p = pred(r)
    if (p === undefined) {
      reasons.push(`${r.path} does not name its predecessor (null for the first record)`)
      continue
    }
    if (p === null) continue
    const target = byPath.get(p)
    if (target === undefined) {
      reasons.push(`${r.path} names a predecessor that does not exist: ${p}`)
      continue
    }
    const va = versionOf(p.split('/').pop()!)
    const vb = versionOf(r.path.split('/').pop()!)
    if (va === null || vb === null || !versionLess(va, vb)) reasons.push(`${r.path} names a predecessor that is not an earlier version`)
    named.set(p, [...(named.get(p) ?? []), r.path])
  }
  for (const [p, succ] of named) if (succ.length > 1) reasons.push(`the OEP-1 evidence forks at ${p}: ${succ.join(', ')}`)
  const heads = records.filter((r) => !named.has(r.path))
  if (heads.length !== 1) reasons.push(`the OEP-1 evidence has ${heads.length} heads; exactly one is required`)
  const head = heads.length === 1 ? heads[0]! : null
  const chain: { path: string; verdict: string }[] = []
  if (head !== null) {
    const seen = new Set<string>()
    let cur: (typeof records)[number] | undefined = head
    while (cur !== undefined && !seen.has(cur.path)) {
      seen.add(cur.path)
      chain.unshift({ path: cur.path, verdict: String(cur.doc.verdict ?? 'MISSING') })
      const p = pred(cur)
      cur = typeof p === 'string' ? byPath.get(p) : undefined
    }
    if (seen.size !== records.length) reasons.push(`${records.length - seen.size} OEP-1 evidence record(s) are not on the chain that ends at the head`)
    const nonClosed = chain.slice(0, -1).filter((c) => c.verdict !== 'CLOSED').map((c) => c.path).sort()
    const ack = Array.isArray(head.doc.acknowledged_non_closed) ? (head.doc.acknowledged_non_closed as Array<{ path?: unknown; resolution?: unknown }>) : null
    if (ack === null) reasons.push('the head does not carry acknowledged_non_closed')
    else {
      const ackPaths = ack.map((a) => String(a.path)).sort()
      if (JSON.stringify(ackPaths) !== JSON.stringify(nonClosed)) reasons.push(`the head must acknowledge exactly the earlier non-CLOSED records [${nonClosed.join(', ')}], not [${ackPaths.join(', ')}]`)
      if (ack.some((a) => typeof a.resolution !== 'string' || a.resolution.trim() === '')) reasons.push('an acknowledged non-CLOSED record carries no resolution')
    }
  }
  return { head: head?.path ?? null, chain, reasons }
}

/** Gather the evidence facts from the repository: every record, as one explicit chain (R3). */
export function gatherOep1EvidenceFacts(root: string): Oep1EvidenceFacts {
  const dir = join(root, OEP1_EVIDENCE_DIR)
  const names = (existsSync(dir) ? readdirSync(dir) : []).filter((n) => OEP1_EVIDENCE_PATTERN.test(n))
  if (names.length === 0) return { path: null, evidence: null, channelEvent: null, chain: [], chainReasons: [] }
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
    chainReasons: reasons,
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
    caReasons: caFileReasons(root, binding),
    tlsPolicyStated: typeof (eff.doc as { TLS_TRUST_POLICY?: { policy?: unknown } } | null)?.TLS_TRUST_POLICY?.policy === 'string' ? String((eff.doc as { TLS_TRUST_POLICY: { policy: string } }).TLS_TRUST_POLICY.policy) : null,
    oep1: {
      facts: gatherOep1EvidenceFacts(root),
      ctx: { binding, targetHost: authorizedDirectHost(root), n08: deps.effectiveN08(root), driverDigest: deps.driverDigest(root), ...routeBTransportFacts() },
    },
  }
}
