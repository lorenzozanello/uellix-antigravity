// db/hosted/authority/certification/installer-identity.ts
// COMMIT 5.6 — the identity of the SESSION that applies the governed chain.
//
// ---------------------------------------------------------------------------
// THE INCIDENT THIS CLOSES
// ---------------------------------------------------------------------------
// The second staging failure of T1 was not a selection defect. The plan was
// right, PACKAGE_PATH pointed at the governed artefact, `artefact:verify`
// passed, and the write still died:
//
//   ERROR:  permission denied to set role "uellix_cap_grounding"
//
// measured against a connection whose identity was
// `session_user = current_user = postgres`.
//
// The reason is written into the artefact itself. Every capability window the
// generator emits is a PAIR:
//
//   GRANT uellix_cap_grounding TO uellix_migrator WITH INHERIT FALSE, SET TRUE;
//   SET ROLE uellix_cap_grounding;
//
// The GRANT names the installer LITERALLY; the SET ROLE is executed by whoever
// holds the session. Applied as anything other than `uellix_migrator`, the
// first statement hands the SET option to a role the session is not, and the
// second is refused. Twenty-two such pairs are spread across the nine packages
// and every package contains at least one, so this is not a T1 property — it is
// the chain's execution contract.
//
// ---------------------------------------------------------------------------
// WHY THE PRECHAIN AUTHORITY GATE DID NOT CATCH IT
// ---------------------------------------------------------------------------
// It was never asked to. `validateHostedPrechainAuthorityContract` measures the
// DATABASE: does `uellix_migrator` exist, can it log in, does it hold
// CREATEROLE, can it become the owner. On the failed attempt every one of those
// answers was correct — `artifacts/t1-prechain.json` recorded
// `uellix_migrator {canLogin: true, createRole: true}` and
// `installerCanSetOwner: true`. The database was ready. The SESSION was
// somebody else, and nothing in the workflow had ever asked who it was.
//
// A gate that measures the target and never the caller is a gate with a blind
// spot exactly the width of the operator's terminal.
//
// ---------------------------------------------------------------------------
// WHY `SET ROLE uellix_migrator` IS NOT AN ACCEPTABLE SUBSTITUTE
// ---------------------------------------------------------------------------
// This is the tempting shortcut, and it is mechanically wrong rather than
// merely inelegant. The governed packages close every window with `RESET ROLE`,
// and `RESET ROLE` returns to `session_user` — not to whatever role was current
// when the window opened. So a session that logged in as `postgres` and assumed
// `uellix_migrator` would execute the first owner window correctly, hit
// `RESET ROLE` (grounding_0002:273), silently fall back to `postgres`, and
// arrive at the capability window as `postgres` anyway. It would fail at the
// same line, having produced a longer and more confusing transcript.
//
// So the verifier demands `session_user = current_user = <installer>`, and the
// equality is a load-bearing part of the contract, not a strictness setting.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE MAY NOT DO
// ---------------------------------------------------------------------------
// It measures and refuses. It opens no connection, alters no role, grants
// nothing, assumes no role, consumes no attempt, and authorises no write. Its
// entire output is a list of refusals, empty or not. The probe below reads
// `pg_catalog` and two session functions inside whatever transaction the
// operator gives it, and would be correct inside `BEGIN READ ONLY`.

import { ATTEMPT_ID_SHAPE } from '../../fresh-observation'
import { AUTHORITY_ROLE_REGISTRY, type HostedRoleIdentifier } from '../role-registry'

/* -------------------------------------------------------------------------- */
/* The contract, derived once                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The single role of a given kind in the authority registry.
 *
 * Derived rather than transcribed. `AUTHORITY_ROLE_REGISTRY` is the closed set
 * the generator itself names roles from, so an expectation read out of it
 * cannot describe a different chain from the one whose bytes are on disk. A
 * fourth spelling of `'uellix_migrator'` in this file would be a fourth thing
 * to keep in step, and the whole incident is what happens when two halves of a
 * contract drift.
 *
 * Throws when the registry does not contain exactly one. An installer contract
 * with two candidates is not a contract, and defaulting to the first would pick
 * a principal on the operator's behalf — which is the class of decision this
 * module exists to take away from tooling.
 */
function soleRoleOfKind(kind: 'installer' | 'owner'): HostedRoleIdentifier {
  const matches = AUTHORITY_ROLE_REGISTRY.filter((r) => r.kind === kind)
  if (matches.length !== 1) {
    throw new Error(
      `[installer-identity] the authority role registry declares ${matches.length} roles of kind ` +
        `${kind} (${matches.map((r) => r.id).join(', ') || 'none'}); the governed chain's execution ` +
        `contract names exactly one. Refusing to pick one.`,
    )
  }
  return (matches[0] as (typeof AUTHORITY_ROLE_REGISTRY)[number]).id
}

/**
 * The principal the governed chain T1..T9 must be applied AS.
 *
 * This is THE expectation. `scripts/`, the runbook and the tests all read it
 * from here; none of them spells the role name.
 */
export const CERTIFIED_CHAIN_INSTALLER: HostedRoleIdentifier = soleRoleOfKind('installer')

/** The role every owner window opens onto. Needed to state what the installer must reach. */
export const CERTIFIED_CHAIN_OWNER: HostedRoleIdentifier = soleRoleOfKind('owner')

/**
 * The managed administrative login, named so the refusal can be specific.
 *
 * NOT a second installer and not a fallback. It is the correct identity for
 * PHASE_BASELINE and for `stella_hosted_0002` — both of which run BEFORE
 * `uellix_migrator` exists or holds anything — and it is the identity the two
 * staging incidents were executed with. Naming it lets the refusal say which
 * mistake was made instead of only that one was.
 *
 * See docs/ops/staging/STELLA_APPLY_IDENTITY_PROBE.md §1 for why the earlier
 * phases genuinely have no other option.
 */
export const BOOTSTRAP_ADMIN_LOGIN = 'postgres'

/** The envelope's version. A document that does not name it is not this format. */
export const INSTALLER_IDENTITY_SCHEMA = 'uellix.hosted.installer.identity/1'

/* -------------------------------------------------------------------------- */
/* The probe                                                                   */
/* -------------------------------------------------------------------------- */

export class InstallerIdentityRefusal extends Error {
  readonly code: string
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.code = code
    this.name = 'InstallerIdentityRefusal'
  }
}

const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`

/**
 * Who this session is, as ONE jsonb cell, bound to one attempt.
 *
 * READ-ONLY by construction: two session functions and one `pg_catalog` lookup.
 * No `SET ROLE`, no `ALTER`, no write of any kind — running it twice changes
 * nothing and running it inside `BEGIN READ ONLY` succeeds.
 *
 * The attempt id is compiled in as a literal for the reason every other probe
 * here does it: a document that does not echo the open attempt is yesterday's
 * measurement, and yesterday's terminal is exactly the thing that cannot be
 * allowed to authorise today's write.
 *
 * The attributes are asked of `current_user` rather than of the literal
 * installer name. Asking about the literal would answer "is the ROLE capable",
 * which the prechain gate already establishes and which was TRUE while this
 * incident happened. The question here is "is THIS SESSION that role, and is
 * the role it is still shaped the way the certification measured".
 */
export function buildInstallerIdentitySql(attemptId: string): string {
  if (!ATTEMPT_ID_SHAPE.test(attemptId)) {
    throw new InstallerIdentityRefusal(
      'INSTALLER_IDENTITY_PROBE_ATTEMPT_MALFORMED',
      `refusing to build a probe for attempt id ${JSON.stringify(attemptId)}: an attempt id is ` +
        `att_ followed by 32 hex characters. The id is compiled into SQL as a literal, and the ` +
        `shape is the reason no escaping is needed.`,
    )
  }
  return `SET search_path = '';
SELECT jsonb_build_object(
  'schema', ${lit(INSTALLER_IDENTITY_SCHEMA)},
  'attemptId', ${lit(attemptId)},
  'identity', jsonb_build_object(
    -- \`session_user\` and \`current_user\` are SQL-standard KEYWORDS, not catalog
    -- functions: they cannot be schema-qualified, and they do not need to be.
    -- The grammar resolves them, so \`SET search_path = ''\` above — which is what
    -- protects every other name here — leaves them working untouched.
    'sessionUser', session_user,
    'currentUser', current_user,
    'canLogin', COALESCE((
      SELECT r.rolcanlogin FROM pg_catalog.pg_roles r
      WHERE r.rolname = current_user), false),
    'createRole', COALESCE((
      SELECT r.rolcreaterole FROM pg_catalog.pg_roles r
      WHERE r.rolname = current_user), false),
    'isSuper', COALESCE((
      SELECT r.rolsuper FROM pg_catalog.pg_roles r
      WHERE r.rolname = current_user), false),
    -- Resolved through pg_roles and asked by OID, NOT by name. The name
    -- overload of pg_has_role RAISES for a role that does not exist, and
    -- COALESCE does not catch an exception — it only replaces NULL. Measured on
    -- the certification image: a database without ${CERTIFIED_CHAIN_OWNER} made
    -- this probe die with \`role "${CERTIFIED_CHAIN_OWNER}" does not exist\`
    -- instead of reporting the fact. Selecting FROM pg_roles turns a missing
    -- role into no rows, which is NULL, which is false: a measurement.
    'canSetOwner', COALESCE((
      SELECT pg_catalog.pg_has_role(current_user, r.oid, 'SET')
      FROM pg_catalog.pg_roles r WHERE r.rolname = ${lit(CERTIFIED_CHAIN_OWNER)}), false)
  )
)::text;`
}

/* -------------------------------------------------------------------------- */
/* The write-time guard                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The same question, asked INSIDE the transaction that is about to write.
 *
 * The plan-time gate is the fail-closed one: without an identity document there
 * is no plan, no PACKAGE_PATH and no command to paste. But the plan and the
 * keystroke are two moments and the window between them belongs to a human —
 * the same reasoning that makes `artefact:verify` a separate step from the pin
 * check inside the plan. A different terminal, a different \`PGSERVICE\`, a
 * shell that expands a different variable, and the measured session is not the
 * executing one.
 *
 * This closes that window in the only place it can be closed: prepended to the
 * package with a second \`-f\` under \`psql -1\`, so it runs as the first
 * statement of the very transaction that would otherwise apply the DDL. A wrong
 * principal aborts it before a single object is created.
 *
 * READ-ONLY: it reads two keywords and raises. It grants nothing, alters
 * nothing, and assumes no role — a guard that repaired what it found would be a
 * second way to reach the state the chain is supposed to construct.
 *
 * It is defence in depth and is NOT pinned by `artefact:verify`, deliberately:
 * tampering with it can only make it more permissive, and the gate that
 * actually decides is the one in `planChainWriteForOperator`. Saying so here is
 * cheaper than someone later mistaking it for the authorisation.
 */
export function buildInstallerIdentityGuardSql(attemptId: string): string {
  if (!ATTEMPT_ID_SHAPE.test(attemptId)) {
    throw new InstallerIdentityRefusal(
      'INSTALLER_IDENTITY_PROBE_ATTEMPT_MALFORMED',
      `refusing to build a guard for attempt id ${JSON.stringify(attemptId)}: an attempt id is ` +
        `att_ followed by 32 hex characters.`,
    )
  }
  return `-- GENERATED for attempt ${attemptId} by pnpm chain:attempt:open. Read-only.
-- Prepended to the governed package with a second -f under psql -1, so it runs
-- as the first statement of the SAME transaction. It writes nothing: if the
-- principal is right it is a no-op, and if it is wrong the transaction aborts
-- before any DDL exists to roll back.
DO $uellix_identity_guard$
BEGIN
  IF session_user <> ${lit(CERTIFIED_CHAIN_INSTALLER)}
     OR current_user <> ${lit(CERTIFIED_CHAIN_INSTALLER)} THEN
    RAISE EXCEPTION
      'governed chain refused: this transaction is session_user=% current_user=%, and the chain is applied AS %. Every capability window it emits is "GRANT <capability> TO % WITH INHERIT FALSE, SET TRUE;" followed by "SET ROLE <capability>;", so any other principal is refused with "permission denied to set role" several hundred statements in. Reconnect as % and open a new attempt (%).',
      session_user, current_user, ${lit(CERTIFIED_CHAIN_INSTALLER)},
      ${lit(CERTIFIED_CHAIN_INSTALLER)}, ${lit(CERTIFIED_CHAIN_INSTALLER)}, ${lit(attemptId)};
  END IF;
END
$uellix_identity_guard$;`
}

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

export interface ObservedInstallerIdentity {
  readonly sessionUser: string
  readonly currentUser: string
  readonly canLogin: boolean
  readonly createRole: boolean
  readonly isSuper: boolean
  readonly canSetOwner: boolean
}

export interface InstallerIdentityDocument {
  readonly schema: string
  readonly attemptId: string
  readonly identity: ObservedInstallerIdentity
}

/**
 * Parse, bind to the attempt, and TYPE-CHECK every field.
 *
 * Refuses rather than coerces, for the reason `parseRemediationWitness` does: a
 * missing boolean is not `false`. Here the direction matters in both ways — an
 * absent `createRole` read as `false` would refuse a session that was perfectly
 * good, and an absent `sessionUser` read as `''` would refuse with a message
 * naming nobody. Neither is a measurement.
 */
export function parseInstallerIdentity(
  raw: string | null,
  expectedAttemptId: string,
): InstallerIdentityDocument {
  if (!ATTEMPT_ID_SHAPE.test(expectedAttemptId)) {
    throw new InstallerIdentityRefusal(
      'INSTALLER_IDENTITY_PROBE_ATTEMPT_MALFORMED',
      `the caller supplied attempt id ${JSON.stringify(expectedAttemptId)}, which is not att_ ` +
        `followed by 32 hex characters.`,
    )
  }
  if (raw === null || raw.trim() === '') {
    throw new InstallerIdentityRefusal(
      'INSTALLER_IDENTITY_REQUIRED',
      `no installer identity document was supplied. The governed chain is applied AS ` +
        `${CERTIFIED_CHAIN_INSTALLER}, and an unmeasured session is not a session that has been ` +
        `shown to be it. The absence of a measurement is not a measurement.`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new InstallerIdentityRefusal(
      'INSTALLER_IDENTITY_MALFORMED',
      `the identity document is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        `It is emitted as a single jsonb cell precisely so that this is the only parse that happens.`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InstallerIdentityRefusal(
      'INSTALLER_IDENTITY_MALFORMED',
      'the identity document is not a JSON object.',
    )
  }
  const doc = parsed as Record<string, unknown>

  if (doc.schema !== INSTALLER_IDENTITY_SCHEMA) {
    throw new InstallerIdentityRefusal(
      'INSTALLER_IDENTITY_MALFORMED',
      `schema is ${JSON.stringify(doc.schema)}; this reader consumes ${INSTALLER_IDENTITY_SCHEMA}.`,
    )
  }
  if (doc.attemptId !== expectedAttemptId) {
    throw new InstallerIdentityRefusal(
      'INSTALLER_IDENTITY_ATTEMPT_MISMATCH',
      `the document echoes attempt ${JSON.stringify(doc.attemptId)} and the open attempt is ` +
        `${expectedAttemptId}. The id is compiled into the probe, so a disagreement means this ` +
        `identity was measured from a different session than the one this attempt opened — which ` +
        `is precisely the substitution this gate exists to detect.`,
    )
  }
  if (doc.identity === null || typeof doc.identity !== 'object' || Array.isArray(doc.identity)) {
    throw new InstallerIdentityRefusal(
      'INSTALLER_IDENTITY_MALFORMED',
      'identity is absent or is not an object.',
    )
  }
  const i = doc.identity as Record<string, unknown>

  for (const field of ['sessionUser', 'currentUser'] as const) {
    if (typeof i[field] !== 'string' || (i[field] as string).trim() === '') {
      throw new InstallerIdentityRefusal(
        'INSTALLER_IDENTITY_MALFORMED',
        `identity.${field} is ${JSON.stringify(i[field])}, not a non-empty string.`,
      )
    }
  }
  for (const field of ['canLogin', 'createRole', 'isSuper', 'canSetOwner'] as const) {
    if (typeof i[field] !== 'boolean') {
      throw new InstallerIdentityRefusal(
        'INSTALLER_IDENTITY_MALFORMED',
        `identity.${field} is ${JSON.stringify(i[field])}, not a boolean. A field that is absent ` +
          `is not false — absent means the probe did not measure it, and an unmeasured fact may ` +
          `not decide whether a write reaches staging.`,
      )
    }
  }

  return {
    schema: INSTALLER_IDENTITY_SCHEMA,
    attemptId: expectedAttemptId,
    identity: {
      sessionUser: i.sessionUser as string,
      currentUser: i.currentUser as string,
      canLogin: i.canLogin as boolean,
      createRole: i.createRole as boolean,
      isSuper: i.isSuper as boolean,
      canSetOwner: i.canSetOwner as boolean,
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The verifier                                                                */
/* -------------------------------------------------------------------------- */

export type InstallerIdentityRefusalCode =
  | 'INSTALLER_IDENTITY_WRONG_PRINCIPAL'
  | 'INSTALLER_IDENTITY_ROLE_ASSUMED'
  | 'INSTALLER_IDENTITY_NOT_LOGIN'
  | 'INSTALLER_IDENTITY_CANNOT_CREATE_ROLE'
  | 'INSTALLER_IDENTITY_CANNOT_BECOME_OWNER'
  | 'INSTALLER_IDENTITY_WIDENED'

export interface InstallerIdentityFinding {
  readonly code: InstallerIdentityRefusalCode
  readonly detail: string
}

/**
 * Every way this session is not the certified installer, named.
 *
 * Returns a LIST rather than the first failure. An operator who is on the wrong
 * connection entirely should learn that in one reading, not discover a second
 * reason after fixing the first — the two staging incidents were both
 * "fix the thing the error named, run again, find the next thing".
 *
 * The attribute checks are deliberately narrow: exactly the four facts the
 * chain's execution contract depends on, and no audit of the cluster. LOGIN,
 * because the chain is applied by a connection. CREATEROLE, because six of the
 * nine packages create a capability role. SET on the owner, because every owner
 * window opens with `SET ROLE <owner>`. NOSUPERUSER, because the whole managed
 * certification is the proof that this chain runs WITHOUT one, and a superuser
 * session would pass for reasons the certification never measured.
 */
export function verifyInstallerIdentity(
  identity: ObservedInstallerIdentity,
  expected: string = CERTIFIED_CHAIN_INSTALLER,
): InstallerIdentityFinding[] {
  const findings: InstallerIdentityFinding[] = []

  if (identity.sessionUser !== expected) {
    findings.push({
      code: 'INSTALLER_IDENTITY_WRONG_PRINCIPAL',
      detail:
        `this connection logged in as ${JSON.stringify(identity.sessionUser)} and the governed ` +
        `chain must be applied as ${expected}. ` +
        (identity.sessionUser === BOOTSTRAP_ADMIN_LOGIN
          ? `${BOOTSTRAP_ADMIN_LOGIN} is the BOOTSTRAP/ADMIN identity: it is correct for ` +
            `PHASE_BASELINE and for stella_hosted_0002, both of which run before ${expected} ` +
            `holds anything, and it is the identity both staging T1 failures were executed with. ` +
            `It is not the chain installer. Every capability window the packages emit is ` +
            `\`GRANT <capability> TO ${expected} WITH INHERIT FALSE, SET TRUE;\` followed by ` +
            `\`SET ROLE <capability>;\` — the grant names ${expected} literally, so under any ` +
            `other session the next statement is refused with ` +
            `\`permission denied to set role\`. Granting ${BOOTSTRAP_ADMIN_LOGIN} the membership ` +
            `does not help: the packages would still hand the SET option to ${expected} and the ` +
            `end-state membership the chain postconditions pin would not be the one produced.`
          : `The chain names ${expected} literally in every temporary elevation it emits; a ` +
            `session that is somebody else receives none of them.`),
    })
  }

  // AFTER the principal check, and separately: `SET ROLE` is the shortcut this
  // refuses by name, so the operator who tried it is told why rather than being
  // told again that they are on the wrong connection.
  if (identity.currentUser !== identity.sessionUser) {
    findings.push({
      code: 'INSTALLER_IDENTITY_ROLE_ASSUMED',
      detail:
        `session_user is ${JSON.stringify(identity.sessionUser)} and current_user is ` +
        `${JSON.stringify(identity.currentUser)}, so this session has assumed a role rather than ` +
        `connected as one. That is not a substitute and it is not a stricter reading of the same ` +
        `thing: the governed packages close every window with \`RESET ROLE\`, which returns to ` +
        `session_user. A session that logged in as ${identity.sessionUser} and assumed ` +
        `${identity.currentUser} would be dropped back to ${identity.sessionUser} at the first ` +
        `\`RESET ROLE\` and arrive at the capability window as the wrong principal anyway — ` +
        `failing at the same statement, several hundred lines later.`,
    })
  }

  // The remaining checks describe the role this session IS. When the principal
  // is already wrong they describe the wrong role, so they are skipped: a
  // refusal listing `postgres lacks CREATEROLE` would send an operator to widen
  // an identity that must not be widened at all.
  if (findings.length > 0) return findings

  if (!identity.canLogin) {
    findings.push({
      code: 'INSTALLER_IDENTITY_NOT_LOGIN',
      detail: `${expected} is NOLOGIN in this database, yet this document claims a session as it.`,
    })
  }
  if (!identity.createRole) {
    findings.push({
      code: 'INSTALLER_IDENTITY_CANNOT_CREATE_ROLE',
      detail:
        `${expected} lacks CREATEROLE. Six of the nine packages create a capability role and ` +
        `\`assert_hosted_capabilities\` refuses at the FIRST statement of T1 without it. This is ` +
        `E-02, and the prechain remediation is what sets it.`,
    })
  }
  if (!identity.canSetOwner) {
    findings.push({
      code: 'INSTALLER_IDENTITY_CANNOT_BECOME_OWNER',
      detail:
        `${expected} cannot \`SET ROLE ${CERTIFIED_CHAIN_OWNER}\`. Every owner window opens with ` +
        `exactly that, and PostgreSQL 16+ makes \`set_option\` a grant option of its own — being ` +
        `a member is not enough.`,
    })
  }
  if (identity.isSuper) {
    findings.push({
      code: 'INSTALLER_IDENTITY_WIDENED',
      detail:
        `${expected} holds SUPERUSER in this database. The managed PG17 certification measured ` +
        `this chain applying with \`rolsuper = false\`; a superuser session would succeed for ` +
        `reasons nothing has certified, and would silently pass statements the packages are ` +
        `written to survive without.`,
    })
  }
  return findings
}
