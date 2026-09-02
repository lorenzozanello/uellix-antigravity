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
  | 'HOSTED_TARGET_POOLER_USER_MISSING'
  | 'HOSTED_TARGET_POOLER_USER_INVALID'
  | 'HOSTED_TARGET_POOLER_TRANSACTION_MODE'
  | 'HOSTED_TARGET_POOLER_PORT_UNKNOWN'
  | 'HOSTED_TARGET_IDENTITY_CONTRADICTION'
  | 'HOSTED_TARGET_NOT_EXPECTED_PROJECT'
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
  /**
   * The Session Pooler LOGIN ROLE, `postgres.<ref>`, when the connection goes
   * through the pooler. A USERNAME — never a password, never a DSN.
   *
   * REQUIRED for a pooler host and IGNORED-BUT-CROSS-CHECKED for a direct one:
   * if both a ref-bearing host and a login role are present they must agree, and
   * a contradiction is a refusal rather than a silent preference.
   */
  readonly poolerUser?: string | null
  /**
   * The port, when the caller knows it. Optional because a host alone is often
   * all an operator records — but when it IS known it decides pooling MODE, and
   * PHASE_BASELINE cannot run in transaction mode.
   */
  readonly connectionPort?: number | null
  /** The row read from uellix_bootstrap.staging_sentinel, or null if absent. */
  readonly sentinel: StagingSentinel | null
}

/**
 * Supabase pooler ports. Session mode keeps one backend per client connection;
 * transaction mode hands a backend back after every statement.
 *
 * `psql -1` wraps the whole invocation in ONE transaction and every wrapper
 * additionally uses `\ir` and `SET LOCAL`, all of which need session affinity.
 * Transaction mode would scatter them across backends, so it is refused rather
 * than left to fail at unit 17 with a confusing error.
 */
export const SESSION_POOLER_PORT = 5432
export const TRANSACTION_POOLER_PORT = 6543

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

/**
 * The two identities a Supavisor login role carries in ONE string.
 *
 * They are INDEPENDENT and must be validated independently: the role says what
 * privileges the session will hold, the ref says which database it will hold
 * them on. Returning them as one value is what lets a caller check both instead
 * of accidentally checking whichever half it happened to parse.
 */
export interface QualifiedPoolerIdentity {
  /** The role Supavisor authenticates as, once it has stripped the ref. */
  readonly databaseRole: string
  /** The project Supavisor routes the connection to. */
  readonly projectRef: string
}

/** The login role the OPERATOR provisioning path connects through the pooler as. */
export const OPERATOR_POOLER_ROLE = 'postgres'

/**
 * An unquoted Postgres role name: a letter or underscore, then letters, digits
 * or underscores, bounded by NAMEDATALEN-1.
 *
 * Deliberately narrower than what Postgres would accept if the name were
 * quoted. Every role this repository provisions is unquoted and lowercase, so a
 * name outside this shape is not a role we issued, and the parser returning
 * null for it means the caller falls back to comparing the LITERAL username —
 * which then fails the role check. The narrow shape therefore only ever fails
 * closed.
 */
const DATABASE_ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/

/**
 * Split a Supavisor QUALIFIED login role, `<database-role>.<project-ref>`, into
 * the two identities it encodes. Returns null for anything else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM `projectRefFromPoolerUser`
 * ---------------------------------------------------------------------------
 * Supavisor qualifies EVERY login role with the project ref, not just
 * `postgres`: the application runtime authenticates as
 * `uellix_app.<ref>`. The repository only ever modelled `postgres.<ref>`,
 * because that is the form the operator provisioning path uses, so the runtime
 * form failed twice over — the capability layer read the whole string as a role
 * name and refused it, and SYS-02 read no project out of it at all and refused
 * that too.
 *
 * The fix is NOT to loosen `projectRefFromPoolerUser`. Five operator-facing
 * call sites depend on its `postgres.<ref>` contract, and widening it would
 * silently widen the hosted provisioning chain to accept login roles the
 * operator runbook never authorised. So the general parser is introduced here
 * and the operator one becomes the narrow case of it — one shape contract, two
 * deliberately different acceptances.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS STRICT
 * ---------------------------------------------------------------------------
 * No `startsWith`, no `includes`, no permissive pattern. The string is split on
 * `.` and must yield EXACTLY two non-empty segments, each matching its own
 * anchored shape. That is what refuses `uellix_app.<ref>.extra` (three
 * segments), `uellix_app..<ref>` (an empty middle segment), `uellix_app.` and
 * `.<ref>` (an empty half) rather than mining a ref out of them.
 *
 * Case is NOT folded. `projectRefFromPoolerUser` folds it for compatibility
 * with what operators paste out of the dashboard; here a role that differs in
 * case is simply not the role that was expected, and returning null sends it
 * down the literal-comparison path where it fails closed.
 *
 * It is a USERNAME. It carries no password, no token and no key, and the ref
 * inside it is public — it appears in every URL the project serves. Anything
 * shaped like a connection string or carrying credentials is refused outright
 * rather than parsed around, so a well-meaning paste of a full DSN is rejected
 * instead of being mined for a ref.
 */
export function parseQualifiedPoolerUser(user: string): QualifiedPoolerIdentity | null {
  const normalized = (user ?? '').trim()
  if (normalized === '') return null
  // Refuse anything that could carry a credential rather than parse around it.
  if (/[:@/\s]/.test(normalized)) return null

  // EXACTLY two segments. A qualified role names one role and one project, so
  // any other count is a string that merely resembles one.
  const segments = normalized.split('.')
  if (segments.length !== 2) return null

  const [databaseRole, projectRef] = segments
  if (!DATABASE_ROLE_NAME.test(databaseRole)) return null
  if (!PROJECT_REF.test(projectRef)) return null

  return { databaseRole, projectRef }
}

/**
 * The project ref out of a Supabase Session Pooler OPERATOR username.
 *
 * ---------------------------------------------------------------------------
 * WHY THE USERNAME, AND WHY IT IS NOT A SECRET
 * ---------------------------------------------------------------------------
 * A pooler host is regional and shared — `aws-0-us-east-2.pooler.supabase.com`
 * is presented by every project in the region — so it cannot corroborate a
 * project ref. The pooler puts the ref in the LOGIN ROLE instead:
 * `postgres.<ref>`. That is the value the connection is actually routed by, so
 * as a second signal it is stronger than the host, not weaker.
 *
 * It is a USERNAME. It carries no password, no token and no key, and the ref
 * inside it is public — it appears in every URL the project serves. Accepting it
 * therefore adds no secret to this repository, and the guard below refuses
 * anything shaped like a connection string or carrying credentials, so a
 * well-meaning paste of a full DSN is rejected rather than stored.
 *
 * The DATABASE user is NOT this value. `current_user` after connecting through
 * the pooler is plain `postgres`, which is why the apply-identity probe cannot
 * supply it and the operator must.
 *
 * SCOPE IS UNCHANGED AND DELIBERATE: still `postgres.<ref>` and nothing else.
 * It is now expressed as the narrow case of `parseQualifiedPoolerUser` so the
 * two cannot drift on what a username may contain, but a runtime role such as
 * `uellix_app.<ref>` still returns null here — the operator chain's contract is
 * the operator login role, and SYS-02 reads the general form itself.
 */
export function projectRefFromPoolerUser(user: string): string | null {
  // Folded to lower case FIRST, preserving this function's historical
  // tolerance of what an operator pastes out of the dashboard. The general
  // parser deliberately does not fold, so the two differ here and only here.
  const qualified = parseQualifiedPoolerUser((user ?? '').trim().toLowerCase())
  if (qualified === null) return null
  return qualified.databaseRole === OPERATOR_POOLER_ROLE ? qualified.projectRef : null
}

/**
 * ONE IDENTITY CONTRACT, TWO DERIVATION MECHANISMS.
 *
 * ---------------------------------------------------------------------------
 * THE DIVERGENCE THIS RESOLVES
 * ---------------------------------------------------------------------------
 * The apply gate corroborated the target through the Session Pooler login role
 * and said PASS, while this module — the one the runner uses to plan
 * PHASE_BASELINE — refused a pooler host outright. Independent audit proved it:
 *
 *     planProvisioningPhase(aws-0-us-east-2.pooler.supabase.com)
 *       → REFUSED HOSTED_TARGET_HOST_NOT_SUPABASE
 *     planProvisioningPhase(db.<ref>.supabase.co)
 *       → PLAN OK, 51 steps
 *
 * Two identity contracts in one decision. The documented apply modes are direct
 * OR session pooler, and every Class-C measurement was taken over the pooler, so
 * the refusal fell on the connection the operator actually uses. Fail-closed, and
 * still wrong: authorisation that cannot be acted on is not authorisation.
 *
 * ---------------------------------------------------------------------------
 * WHAT "SUPPORTING THE POOLER" MUST NOT MEAN
 * ---------------------------------------------------------------------------
 * NOT "accept any host containing pooler.supabase.com". That hostname is
 * regional and shared — every project in us-east-2 presents it — so accepting it
 * on its own would corroborate nothing and quietly delete signal 2.
 *
 * A pooler connection is accepted only when the LOGIN ROLE names the project,
 * because that is the value the pooler actually routes by. The mechanism differs;
 * the contract does not: some source independent of the declaration must name the
 * project, every source present must agree, and the denylist outranks all of it.
 */
export type ConnectionMechanism = 'direct-db' | 'rest' | 'session-pooler'

export type ConnectionIdentityVerdict =
  | {
      readonly ok: true
      readonly projectRef: string
      readonly mechanism: ConnectionMechanism
      /** Every independent source that named this project, for the log. */
      readonly corroboratedBy: readonly string[]
    }
  | { readonly ok: false; readonly code: TargetIdentityFailureCode; readonly message: string }

/**
 * Derives the project ref the CONNECTION names, from whichever sources exist.
 *
 * Pure and total: it judges nothing about which project is wanted — that is the
 * caller's pin — and it never prefers one source over another when they
 * disagree, because a silent preference is how a contradiction becomes a pass.
 */
export function deriveConnectionIdentity(input: {
  readonly connectionHost: string
  readonly poolerUser?: string | null
  readonly connectionPort?: number | null
}): ConnectionIdentityVerdict {
  const host = (input.connectionHost ?? '').trim().toLowerCase()
  const kind = classifySupabaseHost(host)
  const fromUser = projectRefFromPoolerUser(input.poolerUser ?? '')
  const userSupplied = (input.poolerUser ?? '').trim() !== ''

  if (kind === 'unknown') {
    return {
      ok: false,
      code: 'HOSTED_TARGET_HOST_NOT_SUPABASE',
      message:
        `refused: '${host || '(none)'}' is not a recognised Supabase endpoint. Accepted forms are ` +
        `db.<ref>.supabase.co, <ref>.supabase.co, or aws-<n>-<region>.pooler.supabase.com with a ` +
        `postgres.<ref> login role. A DNS suffix alone is never enough.`,
    }
  }

  if (kind === 'pooler') {
    // MODE BEFORE IDENTITY: transaction mode cannot run the baseline at all, so
    // saying "wrong project" about a connection that could never work either way
    // would be the less useful of two true refusals.
    if (typeof input.connectionPort === 'number') {
      if (input.connectionPort === TRANSACTION_POOLER_PORT) {
        return {
          ok: false,
          code: 'HOSTED_TARGET_POOLER_TRANSACTION_MODE',
          message:
            `refused: port ${input.connectionPort} is the Supabase TRANSACTION pooler. PHASE_BASELINE ` +
            `applies every unit with psql -1 and each wrapper uses \\ir and SET LOCAL, all of which need ` +
            `session affinity. Use the session pooler port ${SESSION_POOLER_PORT}.`,
        }
      }
      if (input.connectionPort !== SESSION_POOLER_PORT) {
        return {
          ok: false,
          code: 'HOSTED_TARGET_POOLER_PORT_UNKNOWN',
          message:
            `refused: port ${input.connectionPort} is neither the session pooler (${SESSION_POOLER_PORT}) ` +
            `nor the transaction pooler (${TRANSACTION_POOLER_PORT}). An unrecognised port is an ` +
            `unrecognised pooling mode, and mode decides whether the baseline can run at all.`,
        }
      }
    }
    if (!userSupplied) {
      return {
        ok: false,
        code: 'HOSTED_TARGET_POOLER_USER_MISSING',
        message:
          `refused: '${host}' is a Supabase Session Pooler host, which is regional and shared — every ` +
          `project in the region presents it, so it names no project. The pooler puts the ref in the ` +
          `LOGIN ROLE; supply it as postgres.<ref>. A username, never a password or a connection string.`,
      }
    }
    if (fromUser === null) {
      return {
        ok: false,
        code: 'HOSTED_TARGET_POOLER_USER_INVALID',
        message:
          `refused: the pooler login role does not have the exact shape postgres.<ref> (20 lowercase ` +
          `letters). Anything carrying ':', '@', '/' or whitespace is rejected rather than parsed ` +
          `around, so a pasted DSN is refused instead of being mined for a ref.`,
      }
    }
    return { ok: true, projectRef: fromUser, mechanism: 'session-pooler', corroboratedBy: ['pooler login role'] }
  }

  // Direct or REST: the host names the project.
  const fromHost = projectRefFromHost(host)
  if (fromHost === null) {
    return {
      ok: false,
      code: 'HOSTED_TARGET_HOST_NOT_SUPABASE',
      message: `refused: no Supabase project ref can be derived from '${host}'.`,
    }
  }
  // CROSS-CORROBORATION. A login role alongside a ref-bearing host is a second
  // source, and two sources that disagree are a contradiction — never a choice.
  if (userSupplied) {
    if (fromUser === null) {
      return {
        ok: false,
        code: 'HOSTED_TARGET_POOLER_USER_INVALID',
        message:
          `refused: a login role was supplied alongside a direct host and it does not parse as ` +
          `postgres.<ref>. An unreadable second source is not an absent one.`,
      }
    }
    if (fromUser !== fromHost) {
      return {
        ok: false,
        code: 'HOSTED_TARGET_IDENTITY_CONTRADICTION',
        message:
          `refused: the host names ${fromHost} and the login role names ${fromUser}. Two identity ` +
          `sources disagree, and this runner will not silently prefer one.`,
      }
    }
    return {
      ok: true,
      projectRef: fromHost,
      mechanism: kind,
      corroboratedBy: ['connection host', 'pooler login role'],
    }
  }
  return { ok: true, projectRef: fromHost, mechanism: kind, corroboratedBy: ['connection host'] }
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
  /**
   * The ONE project this runner may provision.
   *
   * Injectable for the same reason `production` is: a constant a test cannot
   * vary is a constant nothing proves. Production callers take the default and
   * therefore get the pin, which is what turns "some syntactically valid ref"
   * into "the staging project" — audit requirement 14.
   */
  expectedProjectRef: string = KNOWN_STAGING_PROJECT_REF,
): TargetIdentityVerdict {
  const host = input.connectionHost.trim().toLowerCase()

  // (0) THE VETO. First, unconditional, and over EVERY ref any source names.
  //
  // It used to look at the DECLARED ref and the sentinel only. A pooler login
  // role naming production while the declaration said staging would have been
  // caught downstream as a mismatch — a true refusal with the wrong reason, and
  // the denylist is supposed to outrank everything rather than arrive second.
  const poolerRef = projectRefFromPoolerUser(input.poolerUser ?? '')
  const hostRef = projectRefFromHost(host)
  const namedRefs = [input.declaredProjectRef, input.sentinel?.projectRef, poolerRef, hostRef].filter(
    (r): r is string => typeof r === 'string' && r !== '',
  )
  const vetoed = namedRefs.filter((r) => production.projectRefs.includes(r))
  if (production.hosts.some((h) => host === h || host.endsWith(`.${h}`)) || vetoed.length > 0) {
    return refuse(
      'HOSTED_TARGET_IS_PRODUCTION',
      `refused: the target matches a known production identifier${vetoed.length > 0 ? ` (${[...new Set(vetoed)].join(', ')})` : ''}. ` +
        `No combination of declarations, hosts, login roles or sentinel rows overrides this. ` +
        `host=${host || '(none)'}`,
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

  // (2) What the connection says — direct host OR session pooler login role.
  const connection = deriveConnectionIdentity({
    connectionHost: host,
    poolerUser: input.poolerUser,
    connectionPort: input.connectionPort,
  })
  if (!connection.ok) return refuse(connection.code, connection.message)
  const derived = connection.projectRef

  if (derived !== input.declaredProjectRef) {
    return refuse(
      'HOSTED_TARGET_PROJECT_REF_MISMATCH',
      `refused: the connection names project ${derived} (via ${connection.corroboratedBy.join(' + ')}), ` +
        `the operator declared ${input.declaredProjectRef}. One of the two is wrong and this runner ` +
        `will not guess which.`,
    )
  }

  // (2b) THE PIN. Everything above proves the sources AGREE; this proves they
  // agree on the RIGHT project. Without it a perfectly self-consistent identity
  // for some other Supabase project would provision it.
  if (derived !== expectedProjectRef) {
    return refuse(
      'HOSTED_TARGET_NOT_EXPECTED_PROJECT',
      `refused: every signal agrees on ${derived}, and this runner provisions ${expectedProjectRef}. ` +
        `A consistent identity for the wrong project is still the wrong project.`,
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
