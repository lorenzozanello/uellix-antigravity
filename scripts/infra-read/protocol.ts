// scripts/infra-read/protocol.ts
//
// The TERMINATING execution protocol for the governed reads.
//
//   candidate committed and certified
//     -> runtime RC-9a (PACMI metadata, three planes, current credential state)
//     -> DN-0 against the execution HEAD, as the LAST pre-read act
//     -> NO COMMIT (checked before every read)
//     -> governed reads
//     -> evidence committed afterward, with parent == the DN-0 HEAD
//
// Committing DN-0 evidence BEFORE the reads would move HEAD, and a DN-0 that is
// "satisfied at this head and nowhere else" would then have to be re-run
// forever. Measuring DN-0 last and committing nothing until the reads are done
// is what makes the recurrence terminate.

import {
  ANTIGRAVITY_PROJECT, FIXED_PROTECTED_BRANCHES, RELEASE_BRANCH, Refusal, type Params,
} from './ops'
import { type EvidenceRecord, type SafeReadExecutor, type Clock, systemClock } from './executor'
import { assessCertificationEvent, type CertificationEventRequirement } from './certification'

export interface GitResult { readonly status: number | null; readonly stdout: string; readonly stderr: string }
/** envOverrides are ADDED to the caller's environment for that single git invocation. */
export interface LocalGit { run(args: readonly string[], envOverrides?: Readonly<Record<string, string>>): GitResult }

/**
 * DN-0 fetch (v1.0.5). The fetch runs INSIDE the repository, because its
 * semantics (remote, refspecs, prune) come from repository configuration, and
 * with system configuration intact, because the system gitconfig sets
 * http.sslbackend: isolating it would change the TLS backend. So XCC-1's full
 * isolation cannot be applied without changing what the fetch does. What CAN
 * be applied without changing it for a public repository is applied: helper,
 * askpass and extraHeader resets, no terminal prompt, no GCM UI. A public
 * repository needs no credential, so these change nothing unless a credential
 * would otherwise have been presented, in which case the fetch now fails.
 */
export const DN0_FETCH_ARGS = ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'http.extraHeader=', 'fetch', 'origin', '--prune'] as const
export const DN0_FETCH_ENV: Readonly<Record<string, string>> = { GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
/** Residual vectors the resets cannot neutralize inside a repository; their ABSENCE is checked before the fetch. */
export const DN0_FETCH_RESIDUAL_VECTOR_REGEX = '(^url\\..*\\.(insteadof|pushinsteadof)$)|(^http\\..*cookiefile$)'
/** The fetched remote must be https with no userinfo: an ssh remote presents a key, a userinfo URL a token. */
export const DN0_REMOTE_URL_KEY_REGEX = '^remote\\.origin\\.url$'
export const DN0_REMOTE_URL_SAFE_VALUE_REGEX = '^https://[^/@]+/'

export interface Dn0Config {
  readonly expectedBranch: string
  readonly certifiedCandidate: string
  /** Paths that may be ADDED after certification without re-certifying (certification-event records only). */
  readonly allowedPostCertificationAdditions: readonly RegExp[]
  readonly parentBinding: string
  readonly integrationRef: string
  readonly pins: readonly { readonly path: string; readonly blob: string }[]
  /** Each event must satisfy the certification predicate for its EXACT candidate (certification.ts); no verdict name is configured. */
  readonly certificationEvents: readonly CertificationEventRequirement[]
}

export interface Dn0Result {
  readonly measured_utc: string
  readonly branch: string
  readonly head: string
  readonly tree: string
  readonly integration_head: string
  readonly integration_tree: string
  readonly parent_binding_ancestor: true
  readonly certified_candidate: string
  readonly post_certification_additions: readonly string[]
  readonly pins_matched: number
  readonly certification_events_verified: number
}

function ok(git: LocalGit, args: readonly string[], why: string, env?: Readonly<Record<string, string>>): string {
  const r = git.run(args, env)
  if (r.status !== 0) throw new Refusal('STOP_STALE_DN0', why)
  return r.stdout.trim()
}

export function measureDn0(git: LocalGit, cfg: Dn0Config, clock: Clock = systemClock): Dn0Result {
  if (ok(git, ['status', '--porcelain', '--untracked-files=all'], 'status failed') !== '') throw new Refusal('STOP_STALE_DN0', 'worktree is not clean')
  const branch = ok(git, ['rev-parse', '--abbrev-ref', 'HEAD'], 'branch unreadable')
  if (branch !== cfg.expectedBranch) throw new Refusal('STOP_STALE_DN0', 'acting branch is not the governed branch')
  const head = ok(git, ['rev-parse', 'HEAD'], 'HEAD unreadable')
  const tree = ok(git, ['rev-parse', 'HEAD^{tree}'], 'tree unreadable')
  ok(git, ['merge-base', '--is-ancestor', cfg.certifiedCandidate, 'HEAD'], 'certified candidate is not an ancestor of HEAD')
  const additions: string[] = []
  for (const line of ok(git, ['diff', '--name-status', cfg.certifiedCandidate, 'HEAD'], 'diff failed').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const [kind, file] = line.split('\t')
    if (kind !== 'A' || !cfg.allowedPostCertificationAdditions.some((re) => re.test(file ?? ''))) {
      throw new Refusal('STOP_STALE_DN0', 'the effective package changed after certification')
    }
    additions.push(file)
  }
  // Residual-vector checks. --name-only: configuration VALUES never enter this
  // process, so a credential-bearing value is refused without being observed.
  // Exit 1 means no insteadOf / cookieFile key exists at any scope.
  const residual = git.run(['config', '--name-only', '--get-regexp', DN0_FETCH_RESIDUAL_VECTOR_REGEX])
  if (residual.status !== 1) throw new Refusal('STOP_DN0_FETCH_CREDENTIAL_VECTOR', 'an insteadOf or cookieFile key is configured; the DN-0 fetch cannot be shown credential-free')
  // Exit 0 means origin's url matches https-without-userinfo (value-regex match, value not printed).
  const remote = git.run(['config', '--name-only', '--get-regexp', DN0_REMOTE_URL_KEY_REGEX, DN0_REMOTE_URL_SAFE_VALUE_REGEX])
  if (remote.status !== 0) throw new Refusal('STOP_DN0_FETCH_CREDENTIAL_VECTOR', 'origin is not an https URL without userinfo; the DN-0 fetch could present a credential')
  ok(git, DN0_FETCH_ARGS, 'fetch failed', DN0_FETCH_ENV)
  const integration_head = ok(git, ['rev-parse', cfg.integrationRef], 'integration head unreadable')
  const integration_tree = ok(git, ['rev-parse', `${cfg.integrationRef}^{tree}`], 'integration tree unreadable')
  ok(git, ['merge-base', '--is-ancestor', cfg.parentBinding, 'HEAD'], 'parent binding is not an ancestor')
  let pins = 0
  for (const pin of cfg.pins) {
    if (ok(git, ['rev-parse', `HEAD:${pin.path}`], `pin ${pin.path} unreadable`) !== pin.blob) throw new Refusal('STOP_READ_AUTHORITY_BINDING_MISMATCH', `pin ${pin.path} does not re-derive`)
    pins++
  }
  let events = 0
  for (const ev of cfg.certificationEvents) {
    const shown = git.run(['show', `HEAD:${ev.path}`])
    if (shown.status !== 0) throw new Refusal('STOP_ARMING_LIMB1_UNSATISFIED', `certification event ${ev.path} is absent`)
    const a = assessCertificationEvent(shown.stdout, ev)
    if (!a.ok) throw new Refusal('STOP_ARMING_LIMB1_UNSATISFIED', `certification event ${ev.path}: ${a.reason}`)
    // The certified candidate must be part of the history being executed.
    ok(git, ['merge-base', '--is-ancestor', ev.certifiedCandidate, 'HEAD'], `certified candidate of ${ev.path} is not an ancestor of HEAD`)
    events++
  }
  if (ok(git, ['rev-parse', 'HEAD'], 'HEAD unreadable') !== head) throw new Refusal('STOP_STALE_DN0', 'HEAD moved during DN-0')
  return {
    measured_utc: clock.now(), branch, head, tree, integration_head, integration_tree,
    parent_binding_ancestor: true, certified_candidate: cfg.certifiedCandidate,
    post_certification_additions: additions, pins_matched: pins, certification_events_verified: events,
  }
}

/** Checked immediately before EVERY governed read: nothing may be committed between DN-0 and the reads. */
export function assertNoCommitSinceDn0(git: LocalGit, dn0: Dn0Result): void {
  if (ok(git, ['rev-parse', 'HEAD'], 'HEAD unreadable') !== dn0.head) throw new Refusal('STOP_STALE_DN0', 'HEAD moved after DN-0')
  if (ok(git, ['status', '--porcelain', '--untracked-files=all'], 'status failed') !== '') throw new Refusal('STOP_STALE_DN0', 'worktree changed after DN-0')
}

export interface Rc9aResult {
  readonly measured_utc: string
  readonly planes: {
    readonly 'PLANE-G': { readonly satisfied: boolean; readonly projection: unknown }
    readonly 'PLANE-V': { readonly satisfied: boolean; readonly identity?: string; readonly role?: string }
    readonly 'PLANE-X': { readonly satisfied: boolean; readonly credential_class: 'NONE'; readonly basis: 'XCC-1 runtime isolation preflight' }
  }
  readonly all_planes_satisfied: boolean
  readonly records: readonly EvidenceRecord[]
  /** v1.0.4: a provider metadata call may refresh an expiring CLI OAuth session. Lifecycle, not a setting mutation. */
  readonly refresh_side_effect_disclosure: string
}

function firstActiveHost(projection: unknown): Record<string, unknown> | undefined {
  const hosts = (projection as { hosts?: Record<string, unknown[]> } | undefined)?.hosts?.['github.com']
  if (!Array.isArray(hosts)) return undefined
  return (hosts.find((h) => (h as Record<string, unknown>).active === true) ?? hosts[0]) as Record<string, unknown> | undefined
}

/** The executor identity RC-9a must ASSERT, not merely record (v1.0.5). */
/** v1.0.7: the one classic OAuth scope G-R5 needs to see private repositories. Not a widening: already held. */
export const REQUIRED_GITHUB_SCOPE = 'repo'

export interface ExpectedIdentity {
  readonly githubLogin: string
  readonly githubTokenSource: string
  readonly vercelUsername: string
}

export const EXECUTOR_IDENTITY: ExpectedIdentity = { githubLogin: 'lorenzozanello', githubTokenSource: 'keyring', vercelUsername: 'lorenzozanello-5040' }

export function runRuntimeRc9a(ex: SafeReadExecutor, clock: Clock = systemClock, expected: ExpectedIdentity = EXECUTOR_IDENTITY): Rc9aResult {
  const records: EvidenceRecord[] = []
  const g = ex.run('PACMI-G1'); records.push(g)
  const host = firstActiveHost(g.projection)
  const scopes = host?.scopes
  // v1.0.7: G-R5 lists the authenticated user's repositories; private ones need the
  // classic OAuth `repo` scope, which this credential already holds (RC-9a record, DF-13).
  // It is REQUIRED here so a principal that cannot see private repositories fails before any read.
  const scopeList = Array.isArray(scopes) ? scopes.map(String) : typeof scopes === 'string' ? scopes.split(',').map((x) => x.trim()) : []
  const gOk = !!host && host.login === expected.githubLogin && host.tokenSource === expected.githubTokenSource &&
    scopeList.includes(REQUIRED_GITHUB_SCOPE)

  const v1 = ex.run('PACMI-V1'); records.push(v1)
  const v2 = ex.run('PACMI-V2'); records.push(v2)
  const v3 = ex.run('PACMI-V3'); records.push(v3)
  const members = (v3.projection as { members?: Record<string, unknown>[] } | undefined)?.members ?? []
  const role = members.length === 1 && typeof members[0].role === 'string' ? members[0].role : undefined
  const identity = ex.state.vercelUsername
  // DF-12: the permission answer on PLANE-V is the ROLE; team context is never substituted for it.
  const vOk = identity === expected.vercelUsername && typeof role === 'string'

  ex.xcc1Preflight()
  const xOk = ex.state.xcc1PreflightPassed
  ex.state.xcc1PreflightPassed = false // X-R1 must re-run its own preflight immediately before it

  return {
    measured_utc: clock.now(),
    planes: {
      'PLANE-G': { satisfied: gOk, projection: g.projection },
      'PLANE-V': { satisfied: vOk, identity, role },
      'PLANE-X': { satisfied: xOk, credential_class: 'NONE', basis: 'XCC-1 runtime isolation preflight' },
    },
    all_planes_satisfied: gOk && vOk && xOk,
    records,
    refresh_side_effect_disclosure:
      'PACMI-V1 (vercel whoami) may exchange a refresh token for a new access token when the CLI OAuth session is near or past expiry. That is normal credential lifecycle performed by the provider-native client, not a control-plane setting mutation. No refresh-token material is observed, and the credential state recorded here is the state at this instant, not any historical expiry.',
  }
}

// ------------------------------------------------------------- limb D (local)

function refPatternToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i++ }
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export interface LimbDResult {
  readonly target_ref: string
  readonly pattern_forms_evaluated: readonly string[]
  readonly rulesets: readonly { ruleset_id: unknown; enforcement: unknown; matches: boolean }[]
  readonly any_match: boolean
  readonly org_level_caveat: string
}

/** G-R2 limb D: does any ruleset pattern already cover refs/heads/release/commercial-v1? Local evaluation only. */
export function evaluateReleasePatternLimb(details: readonly EvidenceRecord[], defaultBranch: string | undefined): LimbDResult {
  const target = `refs/heads/${RELEASE_BRANCH}`
  const forms = new Set<string>()
  const results: { ruleset_id: unknown; enforcement: unknown; matches: boolean }[] = []
  for (const d of details) {
    const p = d.projection as Record<string, unknown>
    if (p.target !== undefined && p.target !== 'branch') continue
    const ref = ((p.conditions as Record<string, unknown> | undefined)?.ref_name ?? {}) as { include?: string[]; exclude?: string[] }
    const hit = (pats: string[] | undefined) => (pats ?? []).some((pat) => {
      forms.add(pat)
      if (pat === '~ALL') return true
      if (pat === '~DEFAULT_BRANCH') return defaultBranch === RELEASE_BRANCH
      return refPatternToRegExp(pat).test(target)
    })
    const inc = hit(ref.include)
    const exc = hit(ref.exclude)
    results.push({ ruleset_id: p.id, enforcement: p.enforcement, matches: inc && !exc })
  }
  return {
    target_ref: target,
    pattern_forms_evaluated: [...forms],
    rulesets: results,
    any_match: results.some((r) => r.matches),
    org_level_caveat: 'Limb D evaluates the REPOSITORY ruleset inventory. An organization-level ruleset not returned by that inventory is not evaluated here; a clean limb D is clean only over the rulesets it saw.',
  }
}

// ------------------------------------------------------------- phase runner

export interface GovernedReadBundle {
  readonly protocol: 'RC9A -> DN0(last) -> NO_COMMIT -> READS -> EVIDENCE_COMMIT_AFTER'
  readonly rc9a: Rc9aResult
  readonly dn0: Dn0Result
  readonly ac1: { readonly limb1: boolean; readonly limb2: boolean; readonly limb3: boolean; readonly armed_at_runtime: boolean }
  readonly records: readonly EvidenceRecord[]
  readonly limb_d: LimbDResult
  readonly unresolved: readonly string[]
  readonly not_executed_by_design: readonly string[]
}

export interface PhaseDeps {
  readonly executor: SafeReadExecutor
  readonly git: LocalGit
  readonly dn0: Dn0Config
  readonly clock?: Clock
  readonly expectedIdentity?: ExpectedIdentity
}

export function runGovernedReadPhase(deps: PhaseDeps): GovernedReadBundle {
  const { executor: ex, git } = deps
  const clock = deps.clock ?? systemClock
  const rc9a = runRuntimeRc9a(ex, clock, deps.expectedIdentity)
  if (!rc9a.all_planes_satisfied) throw new Refusal('STOP_RC9_UNRESOLVED', 'runtime RC-9a did not characterize all three planes')

  const dn0 = measureDn0(git, deps.dn0, clock) // LAST pre-read act
  const ac1 = { limb1: dn0.certification_events_verified === deps.dn0.certificationEvents.length, limb2: true, limb3: rc9a.all_planes_satisfied }
  const armed = ac1.limb1 && ac1.limb2 && ac1.limb3
  if (!armed) throw new Refusal('STOP_ARMING_LIMB1_UNSATISFIED', 'AC-1 does not hold at runtime')
  ex.state.commitShas.add(dn0.integration_head)

  const records: EvidenceRecord[] = []
  const unresolved: string[] = []
  const step = (id: string, p: Params = {}): EvidenceRecord => {
    assertNoCommitSinceDn0(git, dn0)
    const r = ex.run(id, p)
    records.push(r)
    return r
  }
  const paged = (id: string, p: Params): void => {
    let page = 0
    let until: string | undefined
    do {
      step(id, until === undefined ? p : { ...p, until })
      until = ex.nextUntilFor(id, p)
      if (++page > 500) throw new Refusal('STOP_PAGINATION_INCOMPLETE', `${id} exceeded the page bound`)
    } while (until !== undefined)
  }

  // PLANE-G — G-R1 first (TI-14, RC-9b), then G-R3 (DF-6: the default branch is measured, not assumed).
  step('G-R1')
  step('G-R3')
  const branches = [...new Set<string>([...FIXED_PROTECTED_BRANCHES, ex.state.defaultBranch!])]
  for (const branch of branches) {
    const w = step('G-R2.WITNESS', { branch })
    if (w.assertions.branch_resolves !== true) { unresolved.push(`G-R2:${branch}:witness_did_not_resolve`); continue }
    step('G-R2.A', { branch })
    step('G-R2.C', { branch })
  }
  step('G-R2.B')
  const details = [...ex.state.rulesetIds].map((rulesetId) => step('G-R2.B.DETAIL', { rulesetId }))
  const limb_d = evaluateReleasePatternLimb(details, ex.state.defaultBranch)
  step('G-R4.RUNS', { sha: dn0.integration_head })
  step('G-R4.STATUS', { sha: dn0.integration_head })

  // PLANE-V — scope set first (DF-7), then inventory, then the named target in EVERY scope.
  paged('V-R2.S1', {})
  const teams = [...ex.state.teams]
  for (const teamId of teams) {
    paged('V-R2.S2', { teamId })
    step('V-R2.S3', { teamId })
  }
  // v1.0.7: a deferred OPAQUE_HIGH_ENTROPY finding at V-R2.S2 projects[*].link.repo is
  // adjudicated by the SAME-RUN witness BEFORE any later read. G-R5 runs only then.
  const notExecuted: string[] = ['V-R4 (F_IMMEDIATE_ONLY_BEFORE_MUTATION: bracket M-7, never in the read-only phase)']
  if (ex.hasPendingAdjudications()) {
    do {
      assertNoCommitSinceDn0(git, dn0)
      ex.run('G-R5', { page: String(ex.witness.expectedPage()) }) // page records are control-only and are not evidence
    } while (!ex.witness.isComplete())
    const { witnessRecord, replacements } = ex.finalizeRepositoryWitness()
    for (const [pending, resolved] of replacements) {
      const i = records.indexOf(pending)
      if (i < 0) throw new Refusal('STOP_WITNESS_UNKNOWN', 'a pending record is not in the bundle')
      records[i] = resolved
    }
    records.push(witnessRecord)
  } else {
    notExecuted.push('G-R5 (NOT_REQUIRED: no OPAQUE_HIGH_ENTROPY finding at V-R2.S2 projects[*].link.repo in this run)')
  }
  if (ex.hasPendingAdjudications()) throw new Refusal('STOP_WITNESS_UNKNOWN', 'unadjudicated V-R2.S2 findings remain')
  const agTeams = teams.filter((t) => [...(ex.state.inventory.get(t)?.values() ?? [])].includes(ANTIGRAVITY_PROJECT))
  if (agTeams.length !== 1) throw new Refusal('STOP_PROJECT_IDENTITY_MISMATCH', `${ANTIGRAVITY_PROJECT} found in ${agTeams.length} scopes`)
  step('V-R1', { teamId: agTeams[0] })
  step('V-R3', { teamId: agTeams[0] })
  for (const teamId of teams) {
    for (const [projectId, name] of ex.state.inventory.get(teamId) ?? []) {
      if (name === ANTIGRAVITY_PROJECT) continue // RNA-1 / DN-2 predicate: other projects only
      for (const limb of ['V-R2.L1', 'V-R2.L3', 'V-R2.L5', 'V-R2.L7']) paged(limb, { teamId, projectId })
    }
  }

  // PLANE-X — the isolation preflight runs immediately before X-R1, every time.
  assertNoCommitSinceDn0(git, dn0)
  ex.xcc1Preflight()
  step('X-R1')

  return {
    protocol: 'RC9A -> DN0(last) -> NO_COMMIT -> READS -> EVIDENCE_COMMIT_AFTER',
    rc9a, dn0, ac1: { ...ac1, armed_at_runtime: armed }, records, limb_d, unresolved,
    not_executed_by_design: notExecuted,
  }
}

/** Envelope allowlist for the written bundle summary (records reduced to op ids). */
export const BUNDLE_SUMMARY_KEYS = ['protocol', 'rc9a', 'dn0', 'ac1', 'records', 'limb_d', 'unresolved', 'not_executed_by_design'] as const
export const RC9A_SUMMARY_KEYS = ['measured_utc', 'planes', 'all_planes_satisfied', 'records', 'refresh_side_effect_disclosure'] as const

export function assertBundleEnvelopeConforms(summary: unknown): void {
  const check = (obj: unknown, allowed: readonly string[], where: string) => {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Refusal('STOP_ENVELOPE_NONCONFORMANT', `${where} is not an object`)
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new Refusal('STOP_ENVELOPE_NONCONFORMANT', `${where} carries key ${k} outside the envelope allowlist`)
  }
  check(summary, BUNDLE_SUMMARY_KEYS, 'bundle')
  const s = summary as Record<string, unknown>
  check(s.rc9a, RC9A_SUMMARY_KEYS, 'bundle.rc9a')
  if (!Array.isArray(s.records) || s.records.some((r) => typeof r !== 'string')) throw new Refusal('STOP_ENVELOPE_NONCONFORMANT', 'bundle.records must be op ids only')
}

/** After the reads, the caller commits evidence. This verifies that commit's parent is the DN-0 HEAD and that it only adds evidence. */
export function assertEvidenceCommitParent(git: LocalGit, dn0Head: string, evidencePrefix: string): void {
  if (ok(git, ['rev-parse', 'HEAD^'], 'HEAD^ unreadable') !== dn0Head) throw new Refusal('STOP_STALE_DN0', 'evidence commit parent is not the DN-0 HEAD')
  for (const line of ok(git, ['diff', '--name-status', dn0Head, 'HEAD'], 'diff failed').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const [kind, file] = line.split('\t')
    if (kind !== 'A' || !(file ?? '').startsWith(evidencePrefix)) throw new Refusal('STOP_STALE_DN0', 'evidence commit touches more than new evidence files')
  }
}
