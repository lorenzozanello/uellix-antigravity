// tests/helpers/stella-project-ticket-gates.ts
//
// The static contract for the project-binding package (stella_0015, R2-INT) as
// a PURE FUNCTION over file contents.
//
// It is a pure function for the same reason tests/helpers/stella-ticket-gates.ts
// is: tests/stella-project-ticket-mutation.test.ts has to run exactly this code
// over deliberately broken copies. A gate that lives inside an assertion which
// reads the disk itself cannot be shown to go red, and a gate that has never
// gone red is indistinguishable from a gate that cannot.
//
// SCOPE. These gates judge the TWO stella_0015 files and nothing else. They are
// deliberately NOT folded into evaluateTicketGates(): that contract asserts
// exact facts about the two stella_0014 files — including that
// `bind_operation_ticket` is published there with two arguments, which is
// precisely the shape this package removes. Widening it would have meant
// relaxing an assertion that is exact today about a package that still ships.
// Same argument stella-ticket-gates.ts makes for not joining the Train 4
// contract, one train earlier.

import { unparsedSecurityStatements } from './sql-structure'
import { parseFunctions } from './grounding-gates'

export const PROJECT_TICKET_FORWARD = 'stella_0015_project_bound_operation_tickets.sql'
export const PROJECT_TICKET_ROLLBACK = 'stella_0015_rollback.sql'

export const PROJECT_TICKET_SQL_FILES = [PROJECT_TICKET_FORWARD, PROJECT_TICKET_ROLLBACK] as const

export type Sources = Record<string, string>

export interface Violation {
  readonly gate: string
  readonly detail: string
}

/** The ticket definer. stella_0014's role — this package creates none. */
const TICKET_ROLE = 'uellix_cap_stella_ticket'
/** The runtime identity. The only principal this package hands EXECUTE to. */
const RUNTIME_ROLE = 'uellix_app'
const TICKET_SCHEMA = 'uellix_stella_ops'

/** The governed argument. Its NAME is part of the contract, because every
 *  assertion the package makes about itself is written over it. */
export const PROJECT_ARGUMENT = 'p_expected_project_id uuid'

/** The SQLSTATE that means "this ticket belongs to a different project". */
export const PROJECT_MISMATCH_SQLSTATE = 'U0110'

/**
 * The four verbs that depend on the execution project, with the OLD signature
 * each one must no longer have.
 *
 * `issue` is absent on purpose: it is where the binding is created, it already
 * takes the project and this package does not touch it. `expire` is absent
 * because it names no ticket, discloses no state and releases no live
 * reservation — an argument there would be a parameter with no decision behind
 * it.
 */
export const PROJECT_BOUND_FUNCTIONS = [
  { name: 'bind_operation_ticket', legacy: 'character, character' },
  { name: 'complete_operation_ticket', legacy: 'character, character' },
  { name: 'abort_operation_ticket', legacy: 'character, character varying' },
  { name: 'inspect_operation_ticket', legacy: 'character' },
] as const

/**
 * The five SQLSTATEs that already existed. The mismatch code must be none of
 * them: a sixth failure folded into one of these is a failure nobody can act
 * on, and the whole point of FASE 4 is that "another project" is
 * distinguishable from "another organization", "another actor", "no such
 * ticket", "expired", "different query" and "already settled".
 */
export const PRE_EXISTING_SQLSTATES = ['U0100', 'U0102', 'U0106', 'U0107', 'U0108', 'U0109'] as const

/** Strip `--` line comments so prose cannot satisfy — or trip — a gate. */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

export function evaluateProjectTicketGates(sources: Sources): Violation[] {
  const v: Violation[] = []
  const add = (gate: string, detail: string) => {
    v.push({ gate, detail })
  }
  /** The ONE forwarder. Its argument is a literal one frame up. */
  const require_ = (gate: string, ok: boolean, detail: string) => {
    if (!ok) add(gate, detail)
  }

  // ---------------------------------------------------------------------
  // Harness self-check: is the reader reading what it thinks it is?
  // ---------------------------------------------------------------------
  for (const file of PROJECT_TICKET_SQL_FILES) {
    if (typeof sources[file] !== 'string' || sources[file].length === 0) {
      add('source-missing', `${file} is absent or empty`)
    }
  }
  if (v.length > 0) return v

  // Fail-closed: a reader that silently drops what it cannot understand
  // reports the same "zero violations" as one that understood everything.
  for (const file of PROJECT_TICKET_SQL_FILES) {
    for (const u of unparsedSecurityStatements(sources[file])) {
      add('unparsed', `${file}: ${u.reason} @${u.line} (${u.origin}): ${u.lead}`)
    }
  }

  const fwd = code(sources[PROJECT_TICKET_FORWARD])
  const rbk = code(sources[PROJECT_TICKET_ROLLBACK])
  const functions = parseFunctions(sources[PROJECT_TICKET_FORWARD])
  const byName = new Map(functions.map((f) => [f.name, f]))
  const fn = (short: string) => byName.get(`${TICKET_SCHEMA}.${short}`)

  // =====================================================================
  // The package constrains a ticket it does not create, and says so first
  // =====================================================================
  // Without the guard, four governed functions install and are granted over a
  // table that does not exist — the invisible failure INT-CAP-001 reported two
  // trains ago, in the shape this package could reproduce it.
  require_('ticket-project-dependency',
    /IF to_regclass\('uellix_stella_ops\.operation_tickets'\) IS NULL[\s\S]{0,300}?RAISE EXCEPTION/.test(fwd),
    `${PROJECT_TICKET_FORWARD}: nothing aborts when the ticket table is absent, so this package can install over a database that has no stella_0014`)
  require_('ticket-project-dependency',
    /IF to_regprocedure\('uellix_stella\.consume_stella_quota[\s\S]{0,300}?RAISE EXCEPTION/.test(fwd),
    `${PROJECT_TICKET_FORWARD}: nothing aborts when consume_stella_quota is absent, so complete_operation_ticket is republished with no charge path`)

  // =====================================================================
  // The argument — declared, on all four, and NOT optional
  // =====================================================================
  for (const { name } of PROJECT_BOUND_FUNCTIONS) {
    const f = fn(name)
    require_('ticket-project-argument', f !== undefined,
      `${PROJECT_TICKET_FORWARD}: ${TICKET_SCHEMA}.${name} is not published by this package, so its unbound signature is whatever stella_0014 left behind`)
    if (f === undefined) continue

    require_('ticket-project-argument',
      f.header.includes(PROJECT_ARGUMENT),
      `${PROJECT_TICKET_FORWARD}: ${name} does not declare ${PROJECT_ARGUMENT}, so the database has no execution project to compare the ticket against — which IS R2-INT`)

    // A defaulted argument is an argument the caller may omit, and then the
    // guarantee stops being a property of the SIGNATURE (the call does not
    // resolve) and becomes a property of a branch inside the body (the call
    // resolves and something catches it). The first cannot be forgotten.
    require_('ticket-project-no-default',
      !/p_expected_project_id\s+uuid\s+DEFAULT/i.test(f.header),
      `${PROJECT_TICKET_FORWARD}: ${name} gives the execution project a DEFAULT, so a call that omits it resolves again and the two-argument call site is quietly legal`)
  }

  // =====================================================================
  // The comparison — every verb, independently
  // =====================================================================
  // "bind already checked it" is a claim about a request that has since ended:
  // bind and complete run in DIFFERENT transactions, which the protocol
  // requires (INT-INT-001 §4 step 3). Only complete charges, so only complete
  // can make the charge land correctly.
  for (const { name } of PROJECT_BOUND_FUNCTIONS) {
    const f = fn(name)
    if (f === undefined) continue
    const body = code(f.body)

    require_('ticket-project-comparison',
      /v_project IS DISTINCT FROM p_expected_project_id[\s\S]{0,200}?RAISE EXCEPTION/.test(body),
      `${PROJECT_TICKET_FORWARD}: ${name} accepts the execution project and never compares it against the ticket's — an argument a function ignores closes nothing`)

    require_('ticket-project-error-code',
      new RegExp(`v_project IS DISTINCT FROM p_expected_project_id[\\s\\S]{0,300}?${PROJECT_MISMATCH_SQLSTATE}`).test(body),
      `${PROJECT_TICKET_FORWARD}: ${name} does not raise ${PROJECT_MISMATCH_SQLSTATE} on a project mismatch, so the refusal is indistinguishable from a cross-organization, cross-actor, expired, settled or unknown ticket — six causes, one code, no action`)

    // A missing project is NOT a mismatched one. The caller retries on one and
    // must not on the other.
    require_('ticket-project-comparison',
      /p_expected_project_id IS NULL[\s\S]{0,200}?U0100/.test(body),
      `${PROJECT_TICKET_FORWARD}: ${name} does not refuse a NULL execution project, so "unstated" is treated as "whatever the ticket says" — the defect, spelled as a convenience`)

    // ORDER. The project is judged as soon as the row is found: before expiry,
    // before the digest, before the state. Otherwise the refusal itself
    // reports the lifecycle of a ticket the caller is not entitled to read.
    // Anchored on the `IF` that PERFORMS each check, not on the variable name.
    // Every one of these locals is DECLAREd at the top of the body, so an index
    // taken on the bare name lands in the DECLARE block — before everything,
    // including the project — and the gate fires on its own baseline. Measured:
    // it did, on three of the four.
    const foundAt = body.indexOf('IF NOT FOUND THEN')
    const projectAt = body.indexOf('v_project IS DISTINCT FROM p_expected_project_id')
    const later = ['IF v_expires', 'IF v_hash', 'IF v_status']
      .map((anchor) => body.indexOf(anchor))
      .filter((i) => i > -1)
    require_('ticket-project-check-order',
      projectAt > -1 && foundAt > -1 && projectAt > foundAt,
      `${PROJECT_TICKET_FORWARD}: ${name} judges the project before it has a row, so a ticket that does not exist and a ticket of another project answer differently — an existence oracle`)
    require_('ticket-project-check-order',
      projectAt > -1 && later.every((i) => projectAt < i),
      `${PROJECT_TICKET_FORWARD}: ${name} examines expiry, digest or state before the project, so a ticket welded to another project is distinguishable as expired, as bound or as settled — a lifecycle the caller may not read`)
  }

  // The code must be NEW. Reusing one of the five would make the sixth failure
  // unreachable to a caller that has to act differently on it.
  require_('ticket-project-error-code',
    !(PRE_EXISTING_SQLSTATES as readonly string[]).includes(PROJECT_MISMATCH_SQLSTATE),
    `this contract names ${PROJECT_MISMATCH_SQLSTATE} as the mismatch code, but it is one of the SQLSTATEs stella_0014 already uses for another failure`)

  // =====================================================================
  // The attribution — the charge lands on the project that was proven
  // =====================================================================
  const complete = fn('complete_operation_ticket')
  if (complete !== undefined) {
    const body = code(complete.body)
    require_('ticket-project-charge-attribution',
      /FROM uellix_stella\.consume_stella_quota\(v_org, v_project, v_category, v_key\)/.test(body),
      `${PROJECT_TICKET_FORWARD}: complete_operation_ticket does not charge consume_stella_quota with v_project — the column read from the ticket row under the row lock and proven equal to the execution project. A charge filed under any other value is R2-INT with the check still in place`)
    require_('ticket-project-charge-attribution',
      !/INSERT INTO public\.stella_interactions\b/.test(body),
      `${PROJECT_TICKET_FORWARD}: complete_operation_ticket writes the ledger directly, going around the governed path and the project it just verified`)
    // The replay short-circuit must not answer a caller of another project
    // "this already happened and was already charged".
    require_('ticket-project-check-order',
      body.indexOf('v_project IS DISTINCT FROM p_expected_project_id') < body.indexOf("'replayed'"),
      `${PROJECT_TICKET_FORWARD}: complete_operation_ticket reports \`replayed\` before judging the project, so another project's surface is told that an operation it does not own already ran and was already charged`)
  }

  // =====================================================================
  // The old signatures — revoked, then dropped
  // =====================================================================
  for (const { name, legacy } of PROJECT_BOUND_FUNCTIONS) {
    const sig = `${TICKET_SCHEMA}\\.${name}\\(${legacy.replace(/[()]/g, '\\$&')}\\)`
    require_('ticket-project-legacy-revoked',
      new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`).test(fwd)
      && new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM ${RUNTIME_ROLE}`).test(fwd),
      `${PROJECT_TICKET_FORWARD}: EXECUTE on the unbound ${name}(${legacy}) is not revoked from PUBLIC and ${RUNTIME_ROLE} before it is replaced, so there is an interval in which a runtime principal holds EXECUTE on a function that takes no project`)
    require_('ticket-project-legacy-dropped',
      new RegExp(`DROP FUNCTION IF EXISTS ${sig}`).test(fwd),
      `${PROJECT_TICKET_FORWARD}: the unbound ${name}(${legacy}) is never dropped, so the R2-INT path stays callable next to its own fix — a second door that reads as deliberate`)
  }

  // ...and the package MEASURES the drop rather than trusting the statement.
  require_('ticket-project-legacy-dropped',
    /still exist and take no execution project/.test(sources[PROJECT_TICKET_FORWARD]),
    `${PROJECT_TICKET_FORWARD}: nothing in the self-verification asserts that the unbound signatures are gone, so "we dropped them" is worth exactly what an unmeasured claim is worth`)

  // =====================================================================
  // The definer contract, restated for the four republished bodies
  // =====================================================================
  for (const f of functions) {
    require_('ticket-project-definer-security', /\bSECURITY DEFINER\b/.test(f.header),
      `${PROJECT_TICKET_FORWARD}: ${f.name} is not SECURITY DEFINER`)
    require_('ticket-project-definer-search-path', /SET search_path = ''/.test(f.header),
      `${PROJECT_TICKET_FORWARD}: ${f.name} does not pin search_path to the empty string — with pg_temp reachable a caller shadows an unqualified name and the definer runs it`)

    // `[\s\S]*?` and not `[^)]*`: a signature contains NESTED parentheses —
    // `varchar(40)`, `char(64)`, `uuid` — so a negated-) class stops at the
    // first inner bracket and the match fails on exactly the functions that
    // take one. The lesson stella-ticket-gates.ts measured, carried forward.
    const sig = `${f.name.replace('.', '\\.')}\\([\\s\\S]*?\\)`
    require_('ticket-project-definer-owner',
      new RegExp(`ALTER FUNCTION ${sig}\\s*\\n?\\s*OWNER TO ${TICKET_ROLE}`).test(sources[PROJECT_TICKET_FORWARD]),
      `${PROJECT_TICKET_FORWARD}: ${f.name} is not owned by ${TICKET_ROLE}, so it does not run with the privileges the whole protocol is scoped to`)
    require_('ticket-project-definer-acl',
      new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`).test(sources[PROJECT_TICKET_FORWARD]),
      `${PROJECT_TICKET_FORWARD}: EXECUTE on ${f.name} is not revoked from PUBLIC, which is the default grantee`)
    require_('ticket-project-definer-acl',
      new RegExp(`GRANT EXECUTE ON FUNCTION ${sig} TO ${RUNTIME_ROLE}`).test(sources[PROJECT_TICKET_FORWARD]),
      `${PROJECT_TICKET_FORWARD}: ${f.name} has no EXECUTE grant to ${RUNTIME_ROLE}, so the runtime cannot reach the governed path at all`)
    require_('ticket-project-definer-no-star', !/\bSELECT \*(?!\s*INTO)/.test(code(f.body)),
      `${PROJECT_TICKET_FORWARD}: ${f.name} uses SELECT *, so a column added later silently changes its result shape — and this table holds a nonce`)
    require_('ticket-project-definer-no-dynamic-sql', !/\bEXECUTE\b/.test(code(f.body)),
      `${PROJECT_TICKET_FORWARD}: ${f.name} contains EXECUTE. A definer must not compose SQL`)

    // The actor stays derived. This package adds an argument for the PROJECT
    // and must not accidentally open one for the identity.
    require_('ticket-project-actor-binding',
      /v_actor := auth\.uid\(\)/.test(code(f.body)),
      `${PROJECT_TICKET_FORWARD}: ${f.name} does not derive the actor from the session`)
    require_('ticket-project-actor-binding',
      !/p_actor|p_user|p_created_by|p_organization/.test(f.header),
      `${PROJECT_TICKET_FORWARD}: ${f.name} takes the actor or the organization as an argument. Only the PROJECT is supplied, and only because it is re-verified against the ticket; the other two are derived from the session and must stay that way`)
    require_('ticket-project-no-idempotency-argument',
      !/p_idempotency|p_key\b|p_charge|p_nonce/.test(f.header),
      `${PROJECT_TICKET_FORWARD}: ${f.name} accepts an idempotency key or a nonce as an argument, so the caller chooses the identity it is charged under`)

    // An error message is a channel. A definer that interpolates an id into a
    // RAISE hands an untrusted caller an oracle — and the new refusal is
    // raised on a value the caller supplied.
    for (const raise of code(f.body).match(/RAISE EXCEPTION[\s\S]*?;/g) ?? []) {
      require_('ticket-project-error-detail', !/\bp_[a-z_]+\b/.test(raise),
        `${PROJECT_TICKET_FORWARD}: ${f.name} interpolates an argument into an error message, which turns a refusal into an oracle`)
      require_('ticket-project-error-detail', !/\bv_(nonce|key|hash|project|org)\b/.test(raise),
        `${PROJECT_TICKET_FORWARD}: ${f.name} interpolates a secret, a digest or an internal identifier into an error message`)
    }
  }

  // Exactly the four, and nothing else. A fifth definer published here would be
  // a surface nobody reviewed, and stella_0014's own §7 sweeps the schema.
  for (const f of functions) {
    require_('ticket-project-inventory',
      PROJECT_BOUND_FUNCTIONS.some((p) => f.name === `${TICKET_SCHEMA}.${p.name}`),
      `${PROJECT_TICKET_FORWARD}: ${f.name} is a function this contract does not know about`)
  }
  require_('ticket-project-inventory', functions.length === PROJECT_BOUND_FUNCTIONS.length,
    `${PROJECT_TICKET_FORWARD}: expected exactly ${PROJECT_BOUND_FUNCTIONS.length} function definitions, found ${functions.length}`)

  // ...and the package leaves stella_0014's two alone. Republishing `issue`
  // would silently take ownership of the one place the binding is CREATED.
  for (const untouched of ['issue_operation_ticket', 'expire_operation_tickets']) {
    require_('ticket-project-inventory',
      !new RegExp(`CREATE OR REPLACE FUNCTION\\s+${TICKET_SCHEMA}\\.${untouched}\\b`).test(fwd),
      `${PROJECT_TICKET_FORWARD}: ${untouched} is republished here. It belongs to stella_0014, and a package that redefines it makes the rollback order of two packages depend on each other's bodies`)
  }

  // =====================================================================
  // Self-verification — the package asserts its own end state
  // =====================================================================
  require_('ticket-project-self-verification',
    /stella_0015 FAILED verification/.test(fwd),
    `${PROJECT_TICKET_FORWARD}: the package asserts nothing about the state it leaves behind`)
  require_('ticket-project-self-verification',
    /pronargdefaults/.test(fwd),
    `${PROJECT_TICKET_FORWARD}: nothing asserts that the execution project carries no DEFAULT, which is the difference between a signature that refuses the call and a body that catches it`)

  // =====================================================================
  // The rollback
  // =====================================================================
  // THE STRATEGY, as a machine assertion. R2-INT is the ABSENCE of an
  // argument, so "restore the previous version" and "republish the
  // vulnerability" are the same statement.
  require_('ticket-project-rollback-safe',
    !new RegExp(`CREATE OR REPLACE FUNCTION\\s+${TICKET_SCHEMA}\\.`).test(rbk),
    `${PROJECT_TICKET_ROLLBACK}: the rollback recreates an operation-ticket function. Restoring a signature that takes no execution project is republishing R2-INT, on exactly the databases that used the protocol most`)
  require_('ticket-project-rollback-safe',
    !/GRANT EXECUTE ON FUNCTION/.test(rbk),
    `${PROJECT_TICKET_ROLLBACK}: the rollback grants EXECUTE on a function. A rollback that hands out a privilege is a forward package with a misleading name`)
  require_('ticket-project-rollback-safe',
    /bind_operation_ticket\(character, character\)'\) IS NOT NULL[\s\S]{0,600}?rollback FAILED/.test(rbk),
    `${PROJECT_TICKET_ROLLBACK}: no postcondition asserts that no unbound signature survives this rollback, so the one thing it must never do can be done by an edit that reads as a restoration`)

  // Convergence: every object the forward creates, the rollback removes.
  for (const { name } of PROJECT_BOUND_FUNCTIONS) {
    require_('ticket-project-rollback-convergence',
      new RegExp(`DROP FUNCTION IF EXISTS ${TICKET_SCHEMA}\\.${name}\\(character, uuid`).test(rbk),
      `${PROJECT_TICKET_ROLLBACK}: the project-bound ${name} is never dropped, so it survives as a callable SECURITY DEFINER function owned by ${TICKET_ROLE} — and stella_0014's DROP ROLE then fails forever after`)
    require_('ticket-project-rollback-convergence',
      new RegExp(`REVOKE ALL ON FUNCTION ${TICKET_SCHEMA}\\.${name}\\(character, uuid[^)]*\\) FROM ${RUNTIME_ROLE}`).test(rbk),
      `${PROJECT_TICKET_ROLLBACK}: the EXECUTE grant this package made on ${name} is never withdrawn by name, so what it hands back can only be inferred from a cascade`)
  }

  // ...and it removes nothing that belongs to another package.
  for (const [what, re] of [
    ["stella_0014's ticket table", /DROP TABLE[\s\S]{0,40}operation_tickets/],
    ["stella_0014's issue verb", /DROP FUNCTION IF EXISTS uellix_stella_ops\.issue_operation_ticket/],
    ["stella_0014's hygiene verb", /DROP FUNCTION IF EXISTS uellix_stella_ops\.expire_operation_tickets/],
    ['the ticket schema', /DROP SCHEMA uellix_stella_ops/],
    ['the capability role', /DROP ROLE uellix_cap_stella_ticket/],
    ["stella_0013's governed function", /DROP FUNCTION IF EXISTS uellix_stella\.consume_stella_quota/],
    ['the ledger', /DROP TABLE public\.stella_interactions/],
  ] as const) {
    require_('ticket-project-rollback-scope', !re.test(rbk),
      `${PROJECT_TICKET_ROLLBACK}: the rollback drops ${what}, which belongs to another package`)
  }

  require_('ticket-project-rollback-no-cascade', !/\bCASCADE\b/.test(rbk),
    `${PROJECT_TICKET_ROLLBACK}: the rollback uses CASCADE, so the blast radius depends on what somebody attached later rather than on what the script states`)

  // One DO block: a RAISE ends it and no later statement of that block runs —
  // server semantics inside a single statement, which no client can separate.
  require_('ticket-project-rollback-single-block',
    (rbk.match(/^DO \$\$/gm) ?? []).length === 1,
    `${PROJECT_TICKET_ROLLBACK}: the rollback is not one DO block, so a client that ignores ON_ERROR_STOP can run the destructive half after a refusal`)

  return v
}
