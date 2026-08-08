// db/hosted/target-identity.ts
// TRAIN 5B — "is this database the staging one?", answered fail-closed.
//
// ---------------------------------------------------------------------------
// THREE INDEPENDENT SIGNALS, ALL REQUIRED
// ---------------------------------------------------------------------------
// Train 5A's rule was that a name containing "staging" proves nothing, and that
// isolation needs at least two independent signals. This module requires three,
// and they are independent in the sense that matters — they fail differently:
//
//   1. declared-environment    — what the OPERATOR says, in the invocation.
//   2. host-derived-project-ref— what the CONNECTION says, parsed from the host
//                                and compared against the declaration.
//   3. in-database-sentinel    — what the DATABASE says about itself, written
//                                once at provisioning by a human looking at the
//                                dashboard.
//
// A pasted connection string defeats (1) alone. A copied invocation defeats (2)
// alone. Neither can defeat (3): a row in the wrong database is not something a
// tired operator produces by accident, because producing it requires having
// deliberately provisioned that database as staging.
//
// ---------------------------------------------------------------------------
// AND ONE VETO THAT OUTRANKS ALL THREE
// ---------------------------------------------------------------------------
// KNOWN_PRODUCTION_IDENTIFIERS is checked FIRST and refuses regardless of what
// the other signals say. Three agreeing signals are a reason to proceed; a
// known production identifier is a reason to stop, and a design where enough
// forged agreement can outvote a known-production match is a design where the
// worst outcome is reachable by the most determined mistake.

/** A refusal code. Stable — the gates and the runbook cite these by name. */
export type TargetIdentityFailureCode =
  | 'HOSTED_TARGET_IS_PRODUCTION'
  | 'HOSTED_TARGET_ENVIRONMENT_NOT_STAGING'
  | 'HOSTED_TARGET_PROJECT_REF_INVALID'
  | 'HOSTED_TARGET_HOST_NOT_SUPABASE'
  | 'HOSTED_TARGET_PROJECT_REF_MISMATCH'
  | 'HOSTED_TARGET_SENTINEL_MISSING'
  | 'HOSTED_TARGET_SENTINEL_NOT_STAGING'
  | 'HOSTED_TARGET_SENTINEL_MISMATCH'

/** The sentinel row, as read by a read-only query. Never written by this code. */
export interface StagingSentinel {
  readonly environment: string
  readonly projectRef: string
}

export interface HostedTargetInput {
  /** What the operator declared. Compared with `===` against 'staging'. */
  readonly declaredEnvironment: string
  /** What the operator declared. A Supabase project ref: 20 lowercase letters. */
  readonly declaredProjectRef: string
  /** Host component only — never the connection string. */
  readonly connectionHost: string
  /** The row read from uellix_bootstrap.staging_sentinel, or null if absent. */
  readonly sentinel: StagingSentinel | null
}

export type TargetIdentityVerdict =
  | {
      readonly ok: true
      readonly projectRef: string
      readonly signals: readonly string[]
      /**
       * True when the third signal was WAIVED because the sentinel's table does
       * not exist yet. The caller MUST supply a compensating control; see
       * `SentinelPolicy` and `db/hosted/hosted-provisioning-runner.ts`.
       */
      readonly sentinelDeferred: boolean
    }
  | { readonly ok: false; readonly code: TargetIdentityFailureCode; readonly message: string }

/**
 * Whether the in-database sentinel is required for THIS call.
 *
 * ---------------------------------------------------------------------------
 * THE CIRCULARITY THIS RESOLVES
 * ---------------------------------------------------------------------------
 * Train 5B required all three signals unconditionally, and Train 5C0 found the
 * consequence: `planHostedApply` verifies identity FIRST, for every plan,
 * including the first-provisioning plan that applies
 * `stella_hosted_0001_managed_role_bootstrap` — the package that CREATES
 * `uellix_bootstrap.staging_sentinel`. On a new project that table does not
 * exist, so the sentinel is necessarily null, so the plan is refused with
 * HOSTED_TARGET_SENTINEL_MISSING. The bootstrap could never be planned at all.
 *
 * The documents recorded the same knot from the other side: §2 A5 demanded the
 * sentinel "antes de aplicar nada" while §3 explained that the bootstrap is what
 * creates its table.
 *
 * ---------------------------------------------------------------------------
 * WHY WAIVING IT IS NOT A WEAKENING, AND WHAT REPLACES IT
 * ---------------------------------------------------------------------------
 * The sentinel answers one question: "is this the database somebody deliberately
 * provisioned as staging, or one whose connection string got pasted from the
 * wrong tab?". Before the bootstrap runs there is a different answer to the same
 * question that production can never give: the target is EMPTY. A production
 * database has rows. It has organizations, users, projects, a Stella ledger with
 * history. A database with zero rows in every business table is not production,
 * and no amount of mispasting makes it so.
 *
 * So the waiver is narrow and it is paid for:
 *
 *   - it applies ONLY when the sentinel table does not exist. A sentinel that
 *     EXISTS is checked exactly as before, under every policy — you cannot
 *     downgrade an already-provisioned database by asking for the waiver;
 *   - the production veto is unchanged and still runs first;
 *   - signals 1 and 2 are unchanged and still both required;
 *   - the caller must supply the emptiness evidence, and
 *     `hosted-provisioning-runner.ts` refuses the phase without it.
 *
 * `'required'` remains the DEFAULT, so every existing call site — including the
 * Train 5B gate that asserts a null sentinel is refused — keeps its behaviour.
 */
export type SentinelPolicy =
  /** Three signals, no exception. The default, and the only policy for the chain. */
  | 'required'
  /**
   * Two signals plus a compensating control, permitted only where the sentinel's
   * own table cannot exist yet. Never valid for PHASE_STELLA_CHAIN.
   */
  | 'deferred-until-bootstrap'

/**
 * Identifiers known to belong to PRODUCTION.
 *
 * The Vercel origin is not a guess: Train 5A's adversarial review found it
 * hardcoded at `lib/site.ts:26` as the last-resort fallback of
 * `resolveSiteUrl()`, and it is the only production identity the repository
 * contains. The Supabase production project ref is deliberately EMPTY and must
 * be filled at provisioning time — see
 * docs/ops/staging/STELLA_STAGING_PROVISIONING_REQUIREMENTS.md.
 *
 * An empty list is not a safe default and this module does not treat it as one:
 * the three positive signals are required regardless, so an unfilled denylist
 * removes a veto, not a gate.
 */
export interface ProductionIdentifiers {
  readonly hosts: readonly string[]
  readonly projectRefs: readonly string[]
}

export const KNOWN_PRODUCTION_IDENTIFIERS: ProductionIdentifiers = {
  hosts: ['uellix-antigravity.vercel.app', 'app.uellix.com', 'uellix.com'],
  // LOADED 2026-08-07, by the operator, from the Supabase dashboard.
  //
  // This list was empty for three trains and Train 5C1 initially refused to fill
  // it, because the repository's one candidate carried two incompatible labels:
  // `docs/AUDIT_2026-07-06.md` described the credential pointing at it as giving
  // "full production database" access, while
  // `docs/audits/2026-07-15-uellix-p1a-integration-rls.md` called the same host
  // "el entorno de Staging remoto de Supabase". Guessing between them is exactly
  // the mistake this list exists to prevent.
  //
  // The dashboard settled it: `ctaxtgujyyprgynmnvtq` is PRODUCTION. The July
  // audit that called it staging was wrong and has been corrected in place
  // rather than quietly left to mislead the next reader — see RR-24.
  //
  // NOT SECRET. A Supabase project ref is public in every URL the project
  // serves; `redactForHostedLog` preserves it on purpose, because it is the
  // single most useful thing an operator can see when diagnosing a wrong target.
  //
  // The staging project is `bvyzblhqymxruxdguaee`. It is deliberately absent
  // from this list and a test asserts that it stays absent: putting the target
  // in its own veto would refuse every provisioning forever, which is the
  // failure mode "no lo confundas con staging" names.
  projectRefs: ['ctaxtgujyyprgynmnvtq'],
}

/**
 * The staging target, pinned so the two refs can be compared by a test.
 *
 * Recorded here rather than left to the invocation because Train 5C1 found the
 * repository had NO record of it — `STELLA_HOSTED_ENVIRONMENT_MATRIX.md` noted
 * the absence and blocker B2 counted it as one of the missing isolation
 * signals. A ref nobody wrote down is a ref every operator retypes.
 *
 * It is NOT authority to connect: the three positive signals are still required
 * per invocation, and this constant participates in none of them.
 */
export const KNOWN_STAGING_PROJECT_REF = 'bvyzblhqymxruxdguaee'

/**
 * Whether the production veto is actually loaded.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE PREDICATE AND NOT A REFUSAL INSIDE verifyStagingTarget
 * ---------------------------------------------------------------------------
 * An empty denylist removes a VETO. It does not remove a gate: the three
 * positive signals stay required no matter what, so a dry run against an empty
 * denylist is answering a well-posed question and should keep working. Folding
 * the emptiness check into `verifyStagingTarget` would break every dry run and
 * every test fixture to guard against a risk that only materialises on a WRITE.
 *
 * So the check lives where the risk does. `hosted-baseline-apply-authorized`
 * consumes this and refuses: authorising the first hosted write while the veto
 * that would catch "this is production" has never been loaded is the one
 * situation where "removes a veto, not a gate" stops being reassuring.
 */
export function productionDenylistStatus(
  production: ProductionIdentifiers = KNOWN_PRODUCTION_IDENTIFIERS,
): { readonly loaded: boolean; readonly detail: string } {
  const refs = production.projectRefs.length
  const hosts = production.hosts.length

  if (refs === 0) {
    return {
      loaded: false,
      detail:
        `the production project-ref veto is EMPTY (${hosts} host(s) listed, 0 refs). Host matching ` +
        `catches a connection string aimed at a production DOMAIN; it catches nothing aimed at the ` +
        `production DATABASE, because a Supabase database host is db.<ref>.supabase.co and the ref is ` +
        `the only part that identifies the project. Until a ref is listed, the veto cannot fire on the ` +
        `target that matters most.`,
    }
  }

  const malformed = production.projectRefs.filter((r) => !PROJECT_REF.test(r))
  if (malformed.length > 0) {
    return {
      loaded: false,
      detail: `${malformed.length} entr(y|ies) in the production denylist are not 20-lowercase-letter project refs. A malformed entry never matches anything, so it is an absent veto wearing a present one's clothes.`,
    }
  }

  return {
    loaded: true,
    detail: `${refs} production project ref(s) and ${hosts} production host(s) are vetoed before any other check`,
  }
}

const PROJECT_REF = /^[a-z]{20}$/

/**
 * Derives a Supabase project ref from a host, or null.
 *
 * Returns null for the shared pooler (`aws-0-*.pooler.supabase.com`) on purpose:
 * that host does NOT name a project — the ref travels in
 * `?options=reference%3D<ref>` or in the username — so deriving one from it
 * would be inventing a signal. A null here means "this host cannot corroborate
 * the declaration", and the caller refuses rather than falling back to trusting
 * the operator.
 */
/**
 * What KIND of Supabase host this is — which decides whether it can name a
 * project at all.
 *
 * ---------------------------------------------------------------------------
 * WHY A POOLER HOST IS ITS OWN CASE
 * ---------------------------------------------------------------------------
 * The operator connects through the Session Pooler, whose host is
 * `aws-0-<region>.pooler.supabase.com`. That host is REGIONAL AND SHARED: every
 * project in the region presents the same one, and the project ref lives in the
 * pooler USERNAME (`postgres.<ref>`) instead.
 *
 * `projectRefFromHost` correctly returns null for it — but the refusal that
 * followed said "no project ref can be derived, a direct db.<ref>.supabase.co
 * host is required", which reads as though the operator supplied something
 * wrong. They did not: they supplied the host they actually connect to, and it
 * is structurally incapable of corroborating a ref. Naming the case is the
 * difference between "your evidence is invalid" and "this evidence answers a
 * different question".
 *
 * Classifying it changes no verdict. A pooler host still cannot corroborate,
 * and accepting one would corroborate nothing — every project in us-east-2
 * shares it.
 */
export type SupabaseHostKind =
  /** `db.<ref>.supabase.co` — names the project. */
  | 'direct-db'
  /** `<ref>.supabase.co` — the REST/API host. Also names the project. */
  | 'rest'
  /** `aws-0-<region>.pooler.supabase.com` — regional, shared, ref-free. */
  | 'pooler'
  /** Not a recognised Supabase host. */
  | 'unknown'

export function classifySupabaseHost(host: string): SupabaseHostKind {
  const normalized = (host ?? '').trim().toLowerCase()
  if (/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(normalized)) return 'pooler'
  if (!normalized.endsWith('.supabase.co')) return 'unknown'
  const labels = normalized.slice(0, -'.supabase.co'.length).split('.')
  if (labels.length === 1 && PROJECT_REF.test(labels[0])) return 'rest'
  if (labels.length === 2 && labels[0] === 'db' && PROJECT_REF.test(labels[1])) return 'direct-db'
  return 'unknown'
}

export function projectRefFromHost(host: string): string | null {
  if (!host) return null
  const normalized = host.trim().toLowerCase()
  if (!normalized.endsWith('.supabase.co')) return null

  // EXACTLY `db.<ref>.supabase.co` or `<ref>.supabase.co`, with no extra labels.
  //
  // The first version ignored trailing labels, so `db.<ref>.anything.supabase.co`
  // derived a ref and "corroborated" the declaration. No cross-project
  // acceptance was reachable — everything under *.supabase.co is
  // Supabase-controlled and a mismatching ref is refused downstream — but it
  // degraded the independence of signal 2, which is the only thing signal 2 is
  // for. Adversarial review, Train 5C1.
  const labels = normalized.slice(0, -'.supabase.co'.length).split('.')
  if (labels.length === 1) {
    // `<ref>.supabase.co` — the REST/API host. Accepted because an operator
    // reading the dashboard sees this form, and it names the project as
    // unambiguously as the database host does.
    return PROJECT_REF.test(labels[0]) ? labels[0] : null
  }
  if (labels.length === 2 && labels[0] === 'db') {
    return PROJECT_REF.test(labels[1]) ? labels[1] : null
  }
  return null
}

const CONNECTION_STRING = /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi
// The third segment is `{2,}` rather than `{5,}` on purpose: a real signature
// is long, but a TRUNCATED token in a log is still a token, and a redactor that
// only recognises well-formed secrets is a redactor that leaks the malformed ones.
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/g
// Two Supabase key shapes, and the second was missing: the legacy `sbp_<hex>`
// personal-access form, and the current `sb_secret_<...>` / `sb_publishable_<...>`
// form, whose underscore comes immediately after `sb`. Adversarial review A.
const SUPABASE_KEY = /\bsb[a-z]?_(?:[a-z]+_)?[A-Za-z0-9_-]{20,}\b/g

// A libpq keyword/value DSN carries no scheme, so CONNECTION_STRING never sees
// it, and `password=` is the part that matters. Also `PGPASSWORD=`.
const DSN_PASSWORD = /\b(pg)?password\s*=\s*\S+/gi

/**
 * Scrubs anything credential-shaped out of a line destined for a log.
 *
 * Deliberately NOT a denylist of known secret names: the failure mode this
 * guards against is a driver error message that embeds the host and the
 * userinfo it was built from, and those carry no recognisable key name. So the
 * rule is shape-based, and a whole URL is removed rather than parsed — the
 * lesson `docs/ops/DATABASE_TARGET_SAFETY.md` records as "cuando el mensaje se
 * construye a partir del dato sensible, se descarta el mensaje".
 *
 * The project ref survives on purpose: it is public in every URL the project
 * serves, and it is the single most useful thing an operator can see when
 * diagnosing a wrong target.
 */
export function redactForHostedLog(line: string): string {
  return line
    .replace(CONNECTION_STRING, '[redacted]')
    .replace(DSN_PASSWORD, '[redacted]')
    .replace(JWT, '[redacted]')
    .replace(SUPABASE_KEY, '[redacted]')
}

/**
 * Echoes an operator-supplied value into a refusal message, bounded.
 *
 * The refusals below quote what the operator declared, because "it must be
 * exactly 'staging'" is unactionable without showing what arrived. But that
 * field is also the likeliest place for a mispaste — a whole connection string
 * typed into the wrong argument — so the echo is scrubbed AND truncated. The
 * scrubbing catches what it recognises; the truncation bounds what it does not.
 */
function echoOperatorValue(value: string): string {
  const scrubbed = redactForHostedLog(value)
  return scrubbed.length > 40 ? `${JSON.stringify(scrubbed.slice(0, 40))}… (truncated)` : JSON.stringify(scrubbed)
}

function refuse(code: TargetIdentityFailureCode, message: string): TargetIdentityVerdict {
  return { ok: false, code, message: redactForHostedLog(message) }
}

export function verifyStagingTarget(
  input: HostedTargetInput,
  /**
   * Injectable so provisioning can supply the real production ref without
   * editing this module, and so the veto is testable rather than asserted.
   */
  production: ProductionIdentifiers = KNOWN_PRODUCTION_IDENTIFIERS,
  /** Defaults to the Train 5B behaviour. See `SentinelPolicy`. */
  sentinelPolicy: SentinelPolicy = 'required',
): TargetIdentityVerdict {
  const host = input.connectionHost.trim().toLowerCase()

  // (0) THE VETO. First, and unconditional.
  if (
    production.hosts.some((h) => host === h || host.endsWith(`.${h}`)) ||
    production.projectRefs.includes(input.declaredProjectRef) ||
    (input.sentinel && production.projectRefs.includes(input.sentinel.projectRef))
  ) {
    return refuse(
      'HOSTED_TARGET_IS_PRODUCTION',
      `refused: the target matches a known production identifier. No combination of declarations ` +
        `or sentinel rows overrides this. host=${host || '(none)'}`,
    )
  }

  // (1) What the operator declared.
  if (input.declaredEnvironment !== 'staging') {
    return refuse(
      'HOSTED_TARGET_ENVIRONMENT_NOT_STAGING',
      `refused: declared environment must be exactly 'staging' (got ${echoOperatorValue(input.declaredEnvironment)}). ` +
        `There is no default and no normalization: trailing space, different case and an empty ` +
        `string are all refusals, because each of them is a typo that would otherwise widen the ` +
        `set of databases this runner accepts.`,
    )
  }

  if (!PROJECT_REF.test(input.declaredProjectRef)) {
    return refuse(
      'HOSTED_TARGET_PROJECT_REF_INVALID',
      `refused: declared project ref is not a Supabase project ref (20 lowercase letters).`,
    )
  }

  // (2) What the connection says.
  const derived = projectRefFromHost(host)
  if (derived === null) {
    return refuse(
      'HOSTED_TARGET_HOST_NOT_SUPABASE',
      `refused: no Supabase project ref can be derived from the connection host, so the ` +
        `connection cannot corroborate the declaration. A direct host (db.<ref>.supabase.co) is ` +
        `required; the shared pooler does not name a project in its hostname.`,
    )
  }

  if (derived !== input.declaredProjectRef) {
    return refuse(
      'HOSTED_TARGET_PROJECT_REF_MISMATCH',
      `refused: the connection host names project ${derived}, the operator declared ` +
        `${input.declaredProjectRef}. One of the two is wrong and this runner will not guess which.`,
    )
  }

  // (3) What the database says about itself.
  //
  //     Absence is the ONLY thing the policy can excuse. Everything below this
  //     branch runs unconditionally, because a sentinel that exists and disagrees
  //     is not a missing signal — it is a contradicted one, and there is no
  //     provisioning stage at which that becomes acceptable.
  if (input.sentinel === null) {
    if (sentinelPolicy === 'required') {
      return refuse(
        'HOSTED_TARGET_SENTINEL_MISSING',
        `refused: uellix_bootstrap.staging_sentinel holds no row. A connection string can be pasted ` +
          `from the wrong tab; a sentinel row in the wrong database cannot. Provision the target ` +
          `first — see docs/ops/staging/STELLA_STAGING_PROVISIONING_REQUIREMENTS.md.`,
      )
    }
    return {
      ok: true,
      projectRef: input.declaredProjectRef,
      signals: ['declared-environment', 'host-derived-project-ref'],
      sentinelDeferred: true,
    }
  }

  if (input.sentinel.environment !== 'staging') {
    return refuse(
      'HOSTED_TARGET_SENTINEL_NOT_STAGING',
      `refused: the database declares itself ${echoOperatorValue(input.sentinel.environment)}. What ` +
        `the database says about itself outranks what the invocation says about it.`,
    )
  }

  if (input.sentinel.projectRef !== input.declaredProjectRef) {
    return refuse(
      'HOSTED_TARGET_SENTINEL_MISMATCH',
      `refused: the sentinel names project ${input.sentinel.projectRef}, the connection and the ` +
        `declaration name ${input.declaredProjectRef}. A sentinel that disagrees with its own host ` +
        `means one of the two was copied from somewhere else.`,
    )
  }

  return {
    ok: true,
    projectRef: input.declaredProjectRef,
    signals: ['declared-environment', 'host-derived-project-ref', 'in-database-sentinel'],
    sentinelDeferred: false,
  }
}
