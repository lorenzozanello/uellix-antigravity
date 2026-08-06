// tests/helpers/stella-reserved-quota-gates.ts
//
// The static contract for the reserved-quota package (stella_0016, R1) as a
// PURE FUNCTION over file contents.
//
// It is a pure function for the same reason tests/helpers/stella-project-ticket-
// gates.ts is: tests/stella-reserved-quota-mutation.test.ts has to run exactly
// this code over deliberately broken copies. A gate that lives inside an
// assertion which reads the disk itself cannot be shown to go red, and a gate
// that has never gone red is indistinguishable from a gate that cannot.
//
// SCOPE. These gates judge the TWO stella_0016 files and nothing else. They are
// deliberately NOT folded into evaluateProjectTicketGates(): that contract
// asserts exact facts about the two stella_0015 files — including that
// `bind_operation_ticket` is published there and that `complete_operation_ticket`
// charges through `consume_stella_quota`, which is precisely the call this
// package replaces. Widening it would have meant relaxing an assertion that is
// exact today about a package that still ships. Same argument
// stella-project-ticket-gates.ts makes for not joining the stella_0014 contract,
// one train earlier.

import { unparsedSecurityStatements } from './sql-structure'
import { parseFunctions } from './grounding-gates'

export const RESERVED_QUOTA_FORWARD = 'stella_0016_reserved_quota_semantics.sql'
export const RESERVED_QUOTA_ROLLBACK = 'stella_0016_rollback.sql'

export const RESERVED_QUOTA_SQL_FILES = [RESERVED_QUOTA_FORWARD, RESERVED_QUOTA_ROLLBACK] as const

export type Sources = Record<string, string>

export interface Violation {
  readonly gate: string
  readonly detail: string
}

/** stella_0013's definer. This package publishes into ITS schema. */
const QUOTA_ROLE = 'uellix_cap_stella_quota'
/** stella_0014's definer. The ONLY principal allowed to reach the conversion. */
const TICKET_ROLE = 'uellix_cap_stella_ticket'
/** The runtime identity. */
const RUNTIME_ROLE = 'uellix_app'
const QUOTA_SCHEMA = 'uellix_stella'
const TICKET_SCHEMA = 'uellix_stella_ops'

/** The SQLSTATE that means "the reservation named is not live". */
export const RESERVATION_INVALID_SQLSTATE = 'U0111'

/**
 * The five SQLSTATEs the campaign already draws. The conversion's refusal must
 * be none of them: a caller that has to tell "your reservation expired" from
 * "that is not your ticket" cannot act on one code for both.
 */
export const PRE_EXISTING_SQLSTATES = [
  'U0100', 'U0102', 'U0106', 'U0107', 'U0108', 'U0109', 'U0110',
] as const

/**
 * The three governed functions this package publishes, and what each one is for.
 *
 * `bind_operation_ticket` and `complete_operation_ticket` are republished too
 * but are NOT in this list: they belong to stella_0014/0015, keep their
 * signatures, and are judged below by what their bodies must now call.
 */
export const CAPACITY_FUNCTIONS = [
  { name: 'stella_capacity', role: 'availability' },
  { name: 'consume_stella_capacity', role: 'ticketless consumption' },
  { name: 'settle_reserved_quota', role: 'reservation conversion' },
] as const

/** The two ticket verbs whose bodies this package replaces in place. */
export const REPUBLISHED_VERBS = ['bind_operation_ticket', 'complete_operation_ticket'] as const

/** Strip `--` line comments so prose cannot satisfy — or trip — a gate. */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

export function evaluateReservedQuotaGates(input: Sources): Violation[] {
  // LINE ENDINGS ARE NORMALIZED HERE, ONCE, BEFORE ANY ANCHOR IS SOUGHT.
  //
  // Almost every gate below is a multi-line anchor: `code()` strips `--`
  // comments up to the next `\n`, `parseFunctions` frames a body between `AS $$`
  // and its terminator, and several assertions match a signature spread over
  // five lines. `.gitattributes` pins `db/prepared/**` to LF, so today's
  // checkout feeds this LF — but this function is also called with SYNTHETIC
  // sources (the mutation suite builds them in memory), and a reader whose
  // verdict depends on which line ending it was handed is a reader whose green
  // means nothing. The lesson train 4.2 measured, carried forward.
  //
  // Normalizing the INPUT rather than the FILES is the whole point: nothing on
  // disk is rewritten to make a gate pass.
  const sources: Sources = Object.fromEntries(
    Object.entries(input).map(([name, text]) => [
      name,
      typeof text === 'string' ? text.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : text,
    ]),
  )

  const v: Violation[] = []
  const add = (gate: string, detail: string) => {
    v.push({ gate, detail })
  }
  const require_ = (gate: string, ok: boolean, detail: string) => {
    if (!ok) add(gate, detail)
  }

  // ---------------------------------------------------------------------
  // Harness self-check: is the reader reading what it thinks it is?
  // ---------------------------------------------------------------------
  for (const file of RESERVED_QUOTA_SQL_FILES) {
    if (typeof sources[file] !== 'string' || sources[file].length === 0) {
      add('source-missing', `${file} is absent or empty`)
    }
  }
  if (v.length > 0) return v

  // Fail-closed: a reader that silently drops what it cannot understand
  // reports the same "zero violations" as one that understood everything.
  for (const file of RESERVED_QUOTA_SQL_FILES) {
    for (const u of unparsedSecurityStatements(sources[file])) {
      add('unparsed', `${file}: ${u.reason} @${u.line} (${u.origin}): ${u.lead}`)
    }
  }

  const fwd = code(sources[RESERVED_QUOTA_FORWARD])
  const rbk = code(sources[RESERVED_QUOTA_ROLLBACK])
  const functions = parseFunctions(sources[RESERVED_QUOTA_FORWARD])
  const byName = new Map(functions.map((f) => [f.name, f]))
  const capacity = (short: string) => byName.get(`${QUOTA_SCHEMA}.${short}`)
  const verb = (short: string) => byName.get(`${TICKET_SCHEMA}.${short}`)

  // =====================================================================
  // The package constrains a protocol it does not create, and says so first
  // =====================================================================
  // Without the guards, three governed functions install over a database with
  // no ticket table, and `CREATE OR REPLACE` MINTS bind/complete rather than
  // replacing them — leaving a project-blind pair beside a project-bound one.
  for (const [what, re] of [
    ['stella_0013 (the charge path)', /IF to_regprocedure\('uellix_stella\.consume_stella_quota[\s\S]{0,400}?RAISE EXCEPTION/],
    ['stella_0014 (the ticket table)', /IF to_regclass\('uellix_stella_ops\.operation_tickets'\) IS NULL[\s\S]{0,400}?RAISE EXCEPTION/],
    ['stella_0015 (the project-bound signatures)', /IF to_regprocedure\('uellix_stella_ops\.bind_operation_ticket\(character, uuid, character\)'\) IS NULL[\s\S]{0,600}?RAISE EXCEPTION/],
  ] as const) {
    require_('capacity-dependency', re.test(fwd),
      `${RESERVED_QUOTA_FORWARD}: nothing aborts when ${what} is absent, so this package installs over a database it cannot constrain`)
  }
  // ...and the project-BLIND pair must be proven gone before anything is
  // published. A database that still holds it is one where R2-INT is reachable,
  // and closing R1 on top of it produces exact reservation accounting with
  // wrong attribution.
  require_('capacity-dependency',
    /bind_operation_ticket\(character, character\)'\) IS NOT NULL[\s\S]{0,600}?RAISE EXCEPTION/.test(fwd),
    `${RESERVED_QUOTA_FORWARD}: nothing aborts when a project-blind ticket verb still exists, so R1 would be closed on a database where R2-INT is open`)

  // =====================================================================
  // The arithmetic — Available = Limit - Consumed - Reserved
  // =====================================================================
  const cap = capacity('stella_capacity')
  require_('capacity-availability-function', cap !== undefined,
    `${RESERVED_QUOTA_FORWARD}: ${QUOTA_SCHEMA}.stella_capacity is not published, so there is no single surface and every consumer keeps its own copy of the count`)

  if (cap !== undefined) {
    const body = code(cap.body)

    // THE DEFECT R1 IS ABOUT. A capacity function that returns Limit - Consumed
    // satisfies every signature check in this file and IS R1 with a new name.
    require_('capacity-reservation-counted',
      /v_limit - v_consumed - v_reserved/.test(body),
      `${RESERVED_QUOTA_FORWARD}: stella_capacity does not subtract live reservations from the limit. Counting only charged rows is exactly what lets a sibling take a unit a reservation is holding`)
    require_('capacity-reservation-counted',
      new RegExp(`FROM ${TICKET_SCHEMA}\\.operation_tickets`).test(body)
      && /t\.status = 'bound'/.test(body),
      `${RESERVED_QUOTA_FORWARD}: stella_capacity never reads the reservation set, so Reserved is not a count of anything`)

    // EXPIRY IS IN THE PREDICATE, not delegated to a sweeper. There is no
    // pg_cron in this project; an orphaned reservation that only stops counting
    // once somebody runs a job would starve an organization until they did.
    require_('capacity-expiry-in-predicate',
      /t\.expires_at > v_now/.test(body),
      `${RESERVED_QUOTA_FORWARD}: stella_capacity counts reservations without testing expiry, so a crashed process holds a unit forever and the guarantee starts depending on a cron this project does not have`)

    // NO PERIOD FILTER ON THE RESERVATION SET, deliberately. A reservation
    // taken at 23:58 converts at 00:03 into the NEXT period, and the period the
    // charge lands in must already have set the unit aside.
    require_('capacity-no-period-filter',
      !/t\.period_month/.test(body),
      `${RESERVED_QUOTA_FORWARD}: stella_capacity filters reservations by period. A reservation taken before a month boundary converts after it, so filtering makes the new period sell a unit it never reserved`)

    // Consumed IS period-scoped, and by the same UTC month lib/stella/quota.ts
    // uses. Without it the count is lifetime usage against a monthly cap.
    require_('capacity-period-scoped-consumption',
      /date_trunc\('month'/.test(body) && /si\.created_at >= v_month/.test(body),
      `${RESERVED_QUOTA_FORWARD}: stella_capacity does not scope charged rows to the current UTC month, so a monthly limit is measured against lifetime consumption`)

    // A capacity READ takes no lock. A caller that is about to DECIDE takes the
    // lock and then asks; a lock in here would make every observability read
    // serialise behind every charge.
    require_('capacity-read-takes-no-lock',
      !/pg_advisory_xact_lock/.test(body) && !/FOR UPDATE/.test(body),
      `${RESERVED_QUOTA_FORWARD}: stella_capacity takes a lock. It decides nothing and reports; locking here makes an observability read queue behind every consumption`)

    require_('capacity-scope-check',
      /current_user_org_ids/.test(body) && /U0102/.test(body),
      `${RESERVED_QUOTA_FORWARD}: stella_capacity does not re-impose the caller's organization boundary. SECURITY DEFINER bypasses RLS on what it reads, so an omitted check reads the estate`)
  }

  // =====================================================================
  // The ticketless surface — the answer to R6-INT
  // =====================================================================
  const sibling = capacity('consume_stella_capacity')
  require_('capacity-sibling-surface', sibling !== undefined,
    `${RESERVED_QUOTA_FORWARD}: ${QUOTA_SCHEMA}.consume_stella_capacity is not published, so the five Stella actions that hold no ticket have nothing to migrate to and keep writing the ledger with an unlocked read behind them`)

  if (sibling !== undefined) {
    const body = code(sibling.body)

    require_('capacity-sibling-uses-capacity',
      new RegExp(`FROM ${QUOTA_SCHEMA}\\.stella_capacity\\(`).test(body),
      `${RESERVED_QUOTA_FORWARD}: consume_stella_capacity rebuilds its own count instead of asking the canonical one. Two arithmetics that can disagree are one arithmetic plus a latent oversell`)

    // THE CLAUSE R1 IS ABOUT, on the sibling side.
    require_('capacity-limit-enforced',
      /v_cap\.available <= 0/.test(body),
      `${RESERVED_QUOTA_FORWARD}: consume_stella_capacity never refuses on exhausted availability, so the surface that was supposed to see reservations charges straight through them`)

    // THE LOCK. The count is taken after it, never before: two callers that
    // both read `available = 1` and both charge is the defect INT-CAP-001
    // reported two trains ago, restated for a surface that also counts
    // reservations.
    require_('capacity-advisory-lock',
      /pg_advisory_xact_lock/.test(body)
      && /hashtextextended\('stella\/quota\/'/.test(body),
      `${RESERVED_QUOTA_FORWARD}: consume_stella_capacity does not take the per-organization advisory lock under the shared key, so its headroom check races the charge it exists to constrain`)
    require_('capacity-advisory-lock',
      body.indexOf('pg_advisory_xact_lock') < body.indexOf('stella_capacity('),
      `${RESERVED_QUOTA_FORWARD}: consume_stella_capacity counts before it locks, which is the read-then-write race with an extra step`)

    // IDEMPOTENCY BEFORE CAPACITY. A retry of an operation that already charged
    // is not asking for headroom; refusing it turns a harmless retry into a
    // failure on exactly the organizations that are at their cap.
    require_('capacity-idempotent',
      /idempotency_key = p_idempotency_key/.test(body),
      `${RESERVED_QUOTA_FORWARD}: consume_stella_capacity never checks for a replay, so a retried sibling action is charged a second unit`)
    require_('capacity-idempotent',
      body.indexOf('idempotency_key = p_idempotency_key') < body.indexOf('v_cap.available <= 0'),
      `${RESERVED_QUOTA_FORWARD}: consume_stella_capacity judges capacity before replay, so a retry is refused for lack of headroom it is not asking for`)
    // ...and the lookup must be USED. Reading the existing row and then falling
    // through to the capacity test satisfies both clauses above and behaves
    // exactly as if the replay check were absent — the retry is still refused at
    // the cap. Measured: K-61 survived until this clause existed.
    require_('capacity-idempotent',
      /v_existing IS NOT NULL[\s\S]{0,200}?'replayed'/.test(body),
      `${RESERVED_QUOTA_FORWARD}: consume_stella_capacity looks up the existing charge and does nothing with it, so a retried sibling action is judged for headroom it already spent`)

    // The charge goes THROUGH stella_0013, never around it: one writer for the
    // ledger, one implementation of the uniqueness guarantee.
    require_('capacity-governed-charge',
      new RegExp(`FROM ${QUOTA_SCHEMA}\\.consume_stella_quota\\(`).test(body),
      `${RESERVED_QUOTA_FORWARD}: consume_stella_capacity does not charge through consume_stella_quota`)
    require_('capacity-governed-charge',
      !/INSERT INTO public\.stella_interactions/.test(body),
      `${RESERVED_QUOTA_FORWARD}: consume_stella_capacity writes the ledger directly, so the campaign gains a second writer and a second copy of the idempotency guarantee`)

    // SCOPE BEFORE BUSINESS STATE. Without it an out-of-scope project is
    // answered `quota_exceeded` whenever the organization happens to be at its
    // cap — a retryable business state for a call that can never be legal.
    require_('capacity-scope-before-state',
      /p\.organization_id = p_organization_id/.test(body),
      `${RESERVED_QUOTA_FORWARD}: consume_stella_capacity never proves the project belongs to the organization being charged`)
    require_('capacity-scope-before-state',
      body.indexOf('p.organization_id = p_organization_id') < body.indexOf('pg_advisory_xact_lock'),
      `${RESERVED_QUOTA_FORWARD}: consume_stella_capacity judges the project after locking and counting, so an out-of-scope call at the cap is refused as a business state instead of as a scope error`)
  }

  // =====================================================================
  // The conversion — the one function that charges without a limit
  // =====================================================================
  const settle = capacity('settle_reserved_quota')
  require_('capacity-conversion-surface', settle !== undefined,
    `${RESERVED_QUOTA_FORWARD}: ${QUOTA_SCHEMA}.settle_reserved_quota is not published, so complete has nothing to convert through and must go back to competing for its own reservation`)

  if (settle !== undefined) {
    const body = code(settle.body)

    // THE PROOF. It charges without evaluating a limit, so what keeps it from
    // being a back door is that it re-reads the ticket and refuses unless the
    // reservation is live and welded to what it is being asked to charge.
    for (const [what, re] of [
      ['the ticket is bound', /v_status\s+IS DISTINCT FROM 'bound'/],
      ['the organization matches', /v_org\s+IS DISTINCT FROM p_organization_id/],
      ['the project matches', /v_project\s+IS DISTINCT FROM p_project_id/],
      ['the category matches', /v_category IS DISTINCT FROM p_stella_role/],
    ] as const) {
      require_('capacity-conversion-proves-reservation', re.test(body),
        `${RESERVED_QUOTA_FORWARD}: settle_reserved_quota does not check that ${what}. It files a unit WITHOUT evaluating the limit, so every check it skips is a way to charge past the cap`)
    }
    require_('capacity-conversion-proves-reservation',
      /v_expires <= v_now/.test(body),
      `${RESERVED_QUOTA_FORWARD}: settle_reserved_quota converts a reservation without testing expiry. An expired reservation's unit may already have been handed to somebody else — converting it is the oversell this package exists to prevent`)

    require_('capacity-conversion-error-code',
      new RegExp(`RAISE EXCEPTION[\\s\\S]{0,200}?${RESERVATION_INVALID_SQLSTATE}`).test(body),
      `${RESERVED_QUOTA_FORWARD}: settle_reserved_quota does not raise ${RESERVATION_INVALID_SQLSTATE} when the reservation is not live, so a caller cannot tell a bug in the protocol from a business refusal`)

    // ...and it must NOT evaluate the limit. This is the sentence R1 asked for,
    // and a gate is what keeps it from being re-added by somebody who reads its
    // absence as an oversight.
    require_('capacity-conversion-does-not-compete',
      !/available <= 0/.test(body) && !/v_used >= v_quota/.test(body),
      `${RESERVED_QUOTA_FORWARD}: settle_reserved_quota evaluates the limit. The unit it files was committed at bind and counted against that limit ever since — testing it again charges the organization twice for one commitment and loses whichever operation asks second`)

    // The lock is still taken, and not for a decision: it is what makes the
    // INSERT and the caller's UPDATE of the ticket visible to a competing
    // capacity check as ONE move.
    require_('capacity-advisory-lock',
      /pg_advisory_xact_lock/.test(body)
      && /hashtextextended\('stella\/quota\/'/.test(body),
      `${RESERVED_QUOTA_FORWARD}: settle_reserved_quota does not take the shared advisory lock, so a sibling can observe the reservation gone and the charge not yet filed — a window in which Consumed + Reserved is one short and the cap can be oversold`)

    require_('capacity-idempotent',
      /idempotency_key = p_idempotency_key/.test(body)
      && /ON CONFLICT \(organization_id, idempotency_key\)/.test(body),
      `${RESERVED_QUOTA_FORWARD}: settle_reserved_quota is not idempotent, so two conversions of one reservation file two units`)

    // The row it files must be indistinguishable from every other charged unit.
    // An auditor reading the ledger must not be able to tell a conversion from
    // a direct consumption — a charge is a charge.
    require_('capacity-charge-shape',
      /'stella\/quota\/v1'/.test(body) && /'\{"kind":"quota_consumption","version":1\}'/.test(body),
      `${RESERVED_QUOTA_FORWARD}: settle_reserved_quota files a row whose shape differs from the one consume_stella_quota files, so the ledger records two kinds of unit and an auditor has to know which is which`)
  }

  // =====================================================================
  // The two republished verbs
  // =====================================================================
  for (const name of REPUBLISHED_VERBS) {
    const f = verb(name)
    require_('capacity-verb-republished', f !== undefined,
      `${RESERVED_QUOTA_FORWARD}: ${TICKET_SCHEMA}.${name} is not republished here, so it keeps stella_0015's body — the one whose arithmetic counts charged rows only`)
    if (f === undefined) continue

    // SAME SIGNATURE. A republication with a different argument list does not
    // replace anything: it MINTS a second overload, and both stay callable.
    require_('capacity-verb-signature',
      f.header.includes('p_expected_project_id uuid'),
      `${RESERVED_QUOTA_FORWARD}: the republished ${name} does not keep p_expected_project_id, so it mints a new overload beside stella_0015's instead of replacing it — and reopens R2-INT`)
    require_('capacity-verb-signature',
      !/p_expected_project_id\s+uuid\s+DEFAULT/i.test(f.header),
      `${RESERVED_QUOTA_FORWARD}: the republished ${name} gives the execution project a DEFAULT, so the two-argument call site is quietly legal again`)

    // R2-INT must SURVIVE the republication. A body rewritten for R1 that
    // dropped the project comparison would close one contract by reopening
    // another.
    const body = code(f.body)
    require_('capacity-verb-keeps-project-binding',
      /v_project IS DISTINCT FROM p_expected_project_id/.test(body) && /U0110/.test(body),
      `${RESERVED_QUOTA_FORWARD}: the republished ${name} lost the R2-INT project comparison. Closing R1 must not reopen the attribution defect the previous train closed`)
  }

  const bind = verb('bind_operation_ticket')
  if (bind !== undefined) {
    const body = code(bind.body)
    require_('capacity-bind-uses-capacity',
      new RegExp(`FROM ${QUOTA_SCHEMA}\\.stella_capacity\\(`).test(body),
      `${RESERVED_QUOTA_FORWARD}: bind_operation_ticket does not reserve through the canonical arithmetic. Its own count ran under an actor-scoped policy and saw only the caller's tickets — which is how two members of one organization each reserved the same last unit`)
    require_('capacity-bind-uses-capacity',
      !new RegExp(`SELECT count\\(\\*\\)::integer INTO v_reserved`).test(body),
      `${RESERVED_QUOTA_FORWARD}: bind_operation_ticket still counts reservations with its own query`)
    require_('capacity-limit-enforced',
      /v_cap\.available <= 0/.test(body),
      `${RESERVED_QUOTA_FORWARD}: bind_operation_ticket does not refuse on exhausted availability, so a reservation is granted against capacity that is already committed`)
  }

  const complete = verb('complete_operation_ticket')
  if (complete !== undefined) {
    const body = code(complete.body)

    // THE HEART OF R1.
    require_('capacity-complete-converts',
      new RegExp(`FROM ${QUOTA_SCHEMA}\\.settle_reserved_quota\\(`).test(body),
      `${RESERVED_QUOTA_FORWARD}: complete_operation_ticket does not convert through settle_reserved_quota`)
    require_('capacity-complete-does-not-compete',
      !new RegExp(`${QUOTA_SCHEMA}\\.consume_stella_quota\\(`).test(body),
      `${RESERVED_QUOTA_FORWARD}: complete_operation_ticket still charges through consume_stella_quota, which evaluates the limit against charged rows only. That is R1: the completion competes for the unit its own bind reserved, and loses to a sibling that arrived while the model was running`)
    require_('capacity-complete-does-not-compete',
      !/INSERT INTO public\.stella_interactions/.test(body),
      `${RESERVED_QUOTA_FORWARD}: complete_operation_ticket writes the ledger directly, going around the governed path`)

    // The reservation must STOP being a reservation. Leaving the ticket `bound`
    // after a charge counts the same unit twice — once as Consumed, once as
    // Reserved — until it expires.
    require_('capacity-complete-settles',
      /SET status = 'completed', completed_at = v_now/.test(body),
      `${RESERVED_QUOTA_FORWARD}: complete_operation_ticket does not settle the ticket, so the converted reservation keeps holding a unit that has already been charged — the organization pays once and loses capacity twice`)
    require_('capacity-complete-settles',
      body.indexOf('settle_reserved_quota') < body.indexOf("SET status = 'completed'"),
      `${RESERVED_QUOTA_FORWARD}: complete_operation_ticket settles the ticket before the charge lands, so a failed conversion leaves a completed ticket with no unit behind it`)

    // The row lock is what serialises two concurrent completes into one charge.
    require_('capacity-complete-row-lock',
      /FOR UPDATE/.test(body),
      `${RESERVED_QUOTA_FORWARD}: complete_operation_ticket does not lock the ticket row, so two concurrent completions both see \`bound\` and the uniqueness index becomes the only thing between the organization and a second unit`)
  }

  // =====================================================================
  // The grant that IS the boundary
  // =====================================================================
  // `settle_reserved_quota` charges without evaluating the limit, so who may
  // execute it is not an ACL detail — it is the security property.
  require_('capacity-conversion-grant-scope',
    new RegExp(`GRANT EXECUTE ON FUNCTION ${QUOTA_SCHEMA}\\.settle_reserved_quota\\([\\s\\S]*?\\)\\s*\\n?\\s*TO ${TICKET_ROLE}`).test(sources[RESERVED_QUOTA_FORWARD]),
    `${RESERVED_QUOTA_FORWARD}: settle_reserved_quota is not granted to ${TICKET_ROLE}, so complete_operation_ticket cannot convert a reservation at all`)
  // `[^;]*` and NOT a lazy `[\s\S]*?`: the lazy form backtracks past this
  // statement's own semicolon until it finds SOME later `) ... TO uellix_app`,
  // and the next one in the file is bind_operation_ticket's — so the gate fired
  // on its own clean baseline. Measured, not reasoned about.
  require_('capacity-conversion-grant-scope',
    !new RegExp(`GRANT EXECUTE ON FUNCTION ${QUOTA_SCHEMA}\\.settle_reserved_quota[^;]*TO ${RUNTIME_ROLE}\\b`).test(sources[RESERVED_QUOTA_FORWARD]),
    `${RESERVED_QUOTA_FORWARD}: settle_reserved_quota is granted to ${RUNTIME_ROLE}. A runtime principal holding EXECUTE on a function that files a unit without evaluating the limit could charge past the cap for any ticket it could name`)
  require_('capacity-conversion-grant-scope',
    /has_function_privilege[\s\S]{0,600}?settle_reserved_quota[\s\S]{0,600}?RAISE EXCEPTION/.test(fwd),
    `${RESERVED_QUOTA_FORWARD}: nothing in the self-verification asserts who can and cannot execute settle_reserved_quota, so "only the ticket definer reaches it" is worth exactly what an unmeasured claim is worth`)

  // =====================================================================
  // The read this package opens onto the ticket table
  // =====================================================================
  require_('capacity-policy-scope',
    /CREATE POLICY "operation_tickets_capacity_select"[\s\S]{0,400}?current_user_org_ids/.test(fwd),
    `${RESERVED_QUOTA_FORWARD}: the capacity policy does not restrict to the caller's organizations, so the availability definer reads the estate`)
  require_('capacity-policy-scope',
    !/CREATE POLICY "operation_tickets_capacity_select"[\s\S]{0,400}?actor_id/.test(fwd),
    `${RESERVED_QUOTA_FORWARD}: the capacity policy is actor-scoped. Then the availability arithmetic sees only the caller's own reservations, two members of one organization each reserve the same last unit, and both are told bound`)
  require_('capacity-policy-scope',
    new RegExp(`CREATE POLICY "operation_tickets_capacity_select"[\\s\\S]{0,200}?TO ${QUOTA_ROLE}`).test(fwd),
    `${RESERVED_QUOTA_FORWARD}: the capacity policy is not scoped to ${QUOTA_ROLE}, so it widens what some other principal can read`)

  // THE COLUMN GRANT. "Counts the organization's reservations" and "can read the
  // secret half of an idempotency key" must stay two different statements, and
  // the privilege system is what keeps them apart — not the discipline of the
  // function bodies.
  const grantMatch = /GRANT SELECT \(([^)]*)\)\s*\n?\s*ON TABLE uellix_stella_ops\.operation_tickets TO uellix_cap_stella_quota/.exec(fwd)
  require_('capacity-column-grant', grantMatch !== null,
    `${RESERVED_QUOTA_FORWARD}: the capacity role's read is not column-level, so it can read every column of the ticket table including the charge nonce`)
  if (grantMatch !== null) {
    const cols = grantMatch[1].split(',').map((c) => c.trim())
    for (const forbidden of ['charge_nonce', 'query_hash']) {
      require_('capacity-column-grant', !cols.includes(forbidden),
        `${RESERVED_QUOTA_FORWARD}: the capacity role is granted SELECT on ${forbidden}. A role that can read the nonce can compute the idempotency key and charge outside the protocol — the one thing that nonce was minted to prevent`)
    }
    for (const needed of ['status', 'expires_at', 'organization_id']) {
      require_('capacity-column-grant', cols.includes(needed),
        `${RESERVED_QUOTA_FORWARD}: the capacity role is not granted SELECT on ${needed}, which the live-reservation predicate is written over`)
    }
  }
  // Order-agnostic on purpose: the forbidden column names are listed in a
  // VALUES row ABOVE the has_column_privilege call that tests them, so an
  // anchor written in reading order matches nothing.
  require_('capacity-column-grant',
    /has_column_privilege/.test(fwd) && /can read column\(s\) % of operation_tickets/.test(fwd),
    `${RESERVED_QUOTA_FORWARD}: nothing in the self-verification asserts the nonce stays unreadable, so the column list is a statement nobody re-checks`)

  // =====================================================================
  // The period, as a derived fact
  // =====================================================================
  require_('capacity-period-generated',
    /period_month timestamp\s*\n?\s*GENERATED ALWAYS AS \(date_trunc\('month', bound_at\)\) STORED/.test(fwd),
    `${RESERVED_QUOTA_FORWARD}: period_month is not a GENERATED column derived from bound_at. A period a caller can write is a period that can disagree with the reservation it describes, and "unequivocal membership" stops being a property of the type system`)
  require_('capacity-period-generated',
    /attgenerated = 's'/.test(fwd),
    `${RESERVED_QUOTA_FORWARD}: nothing asserts that period_month is STORED-generated, which is the difference between a column nobody can write and a column nobody happened to write`)

  // =====================================================================
  // No new object lands where a published package counts them
  // =====================================================================
  // stella_0015 §4 asserts EXACTLY six functions in uellix_stella_ops. A seventh
  // makes it abort on its next apply — the defect stella_0014 §1 recorded and
  // refused to introduce.
  for (const f of functions) {
    if (!f.name.startsWith(`${TICKET_SCHEMA}.`)) continue
    require_('capacity-no-new-ticket-function',
      (REPUBLISHED_VERBS as readonly string[]).some((n) => f.name === `${TICKET_SCHEMA}.${n}`),
      `${RESERVED_QUOTA_FORWARD}: ${f.name} is published into ${TICKET_SCHEMA}, which stella_0015 asserts holds exactly six functions. Its next apply would abort`)
  }
  require_('capacity-no-new-ticket-function',
    /IF n <> 6 THEN/.test(fwd),
    `${RESERVED_QUOTA_FORWARD}: nothing asserts that ${TICKET_SCHEMA} still holds exactly six functions, so a seventh added later would silently break stella_0015's idempotency`)

  // =====================================================================
  // The definer contract, over every function this package publishes
  // =====================================================================
  for (const f of functions) {
    require_('capacity-definer-security', /\bSECURITY DEFINER\b/.test(f.header),
      `${RESERVED_QUOTA_FORWARD}: ${f.name} is not SECURITY DEFINER`)
    require_('capacity-definer-search-path', /SET search_path = ''/.test(f.header),
      `${RESERVED_QUOTA_FORWARD}: ${f.name} does not pin search_path to the empty string — with pg_temp reachable a caller shadows an unqualified name and the definer runs it`)

    // `[\s\S]*?` and not `[^)]*`: a signature contains NESTED parentheses —
    // `varchar(50)`, `char(64)` — so a negated-) class stops at the first inner
    // bracket and the match fails on exactly the functions that take one.
    const sig = `${f.name.replace('.', '\\.')}\\([\\s\\S]*?\\)`
    const owner = f.name.startsWith(`${QUOTA_SCHEMA}.`) ? QUOTA_ROLE : TICKET_ROLE
    require_('capacity-definer-owner',
      new RegExp(`ALTER FUNCTION ${sig}\\s*\\n?\\s*OWNER TO ${owner}`).test(sources[RESERVED_QUOTA_FORWARD]),
      `${RESERVED_QUOTA_FORWARD}: ${f.name} is not owned by ${owner}. Both stella_0013 and stella_0015 assert ownership over their whole schema, so a function owned by the wrong role makes one of them abort on its next apply`)
    require_('capacity-definer-acl',
      new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`).test(sources[RESERVED_QUOTA_FORWARD]),
      `${RESERVED_QUOTA_FORWARD}: EXECUTE on ${f.name} is not revoked from PUBLIC, which is the default grantee`)
    require_('capacity-definer-no-star', !/\bSELECT \*(?!\s*INTO)/.test(code(f.body)),
      `${RESERVED_QUOTA_FORWARD}: ${f.name} uses SELECT *, so a column added later silently changes its result shape — and this table holds a nonce this package deliberately cannot read`)
    require_('capacity-definer-no-dynamic-sql', !/\bEXECUTE\b/.test(code(f.body)),
      `${RESERVED_QUOTA_FORWARD}: ${f.name} contains EXECUTE. A definer must not compose SQL`)

    require_('capacity-actor-binding',
      /v_actor := auth\.uid\(\)/.test(code(f.body)),
      `${RESERVED_QUOTA_FORWARD}: ${f.name} does not derive the actor from the session`)
    require_('capacity-actor-binding',
      !/p_actor|p_user|p_created_by/.test(f.header),
      `${RESERVED_QUOTA_FORWARD}: ${f.name} takes the actor as an argument, so a caller can charge a unit in someone else's name`)

    // An error message is a channel. A definer that interpolates an id into a
    // RAISE hands an untrusted caller an oracle.
    for (const raise of code(f.body).match(/RAISE EXCEPTION[\s\S]*?;/g) ?? []) {
      require_('capacity-error-detail', !/\bp_[a-z_]+\b/.test(raise),
        `${RESERVED_QUOTA_FORWARD}: ${f.name} interpolates an argument into an error message, which turns a refusal into an oracle`)
      require_('capacity-error-detail', !/\bv_(nonce|key|hash|project|org)\b/.test(raise),
        `${RESERVED_QUOTA_FORWARD}: ${f.name} interpolates a secret, a digest or an internal identifier into an error message`)
    }
  }

  // Exactly the five: three new, two republished. A sixth definer published here
  // would be a surface nobody reviewed.
  const expected = CAPACITY_FUNCTIONS.length + REPUBLISHED_VERBS.length
  require_('capacity-inventory', functions.length === expected,
    `${RESERVED_QUOTA_FORWARD}: expected exactly ${expected} function definitions, found ${functions.length}`)
  for (const untouched of ['issue_operation_ticket', 'expire_operation_tickets', 'abort_operation_ticket', 'inspect_operation_ticket']) {
    require_('capacity-inventory',
      !new RegExp(`CREATE OR REPLACE FUNCTION\\s+${TICKET_SCHEMA}\\.${untouched}\\b`).test(fwd),
      `${RESERVED_QUOTA_FORWARD}: ${untouched} is republished here. It belongs to an earlier package, and a package that redefines it makes the rollback order of two packages depend on each other's bodies`)
  }
  require_('capacity-inventory',
    !new RegExp(`CREATE OR REPLACE FUNCTION\\s+${QUOTA_SCHEMA}\\.consume_stella_quota\\b`).test(fwd),
    `${RESERVED_QUOTA_FORWARD}: consume_stella_quota is republished here. It is stella_0013's, five sibling actions reach it, and this package charges THROUGH it rather than replacing it`)

  // =====================================================================
  // Self-verification
  // =====================================================================
  require_('capacity-self-verification',
    /stella_0016 FAILED verification/.test(fwd),
    `${RESERVED_QUOTA_FORWARD}: the package asserts nothing about the state it leaves behind`)

  // =====================================================================
  // The rollback
  // =====================================================================
  // THE STRATEGY, as a machine assertion. R1 is the ABSENCE of reservation-aware
  // arithmetic, so "restore the previous version" and "republish the
  // vulnerability" are the same statement.
  require_('capacity-rollback-safe',
    !new RegExp(`CREATE OR REPLACE FUNCTION\\s+${TICKET_SCHEMA}\\.`).test(rbk)
    && !new RegExp(`CREATE OR REPLACE FUNCTION\\s+${QUOTA_SCHEMA}\\.`).test(rbk),
    `${RESERVED_QUOTA_ROLLBACK}: the rollback recreates a function. Restoring a bind whose count is actor-scoped, or a complete that charges through consume_stella_quota, is republishing R1 — on exactly the databases that used the protocol most`)
  require_('capacity-rollback-safe',
    !/GRANT EXECUTE ON FUNCTION/.test(rbk) && !/CREATE POLICY/.test(rbk),
    `${RESERVED_QUOTA_ROLLBACK}: the rollback grants a privilege or creates a policy. A rollback that hands something out is a forward package with a misleading name`)
  require_('capacity-rollback-safe',
    /bind_operation_ticket\(character, uuid, character\)'\) IS NOT NULL[\s\S]{0,900}?rollback FAILED/.test(rbk),
    `${RESERVED_QUOTA_ROLLBACK}: no postcondition asserts that no reserve-or-settle verb survives this rollback, so the one thing it must never do can be done by an edit that reads as a restoration`)

  // THE LEDGER IS NEVER TOUCHED. A rollback that could erase a consumption is
  // not a rollback; it is a refund nobody authorised.
  require_('capacity-rollback-preserves-charges',
    !/DELETE FROM public\.stella_interactions/.test(rbk)
    && !/TRUNCATE[\s\S]{0,40}stella_interactions/.test(rbk)
    && !/DROP TABLE[\s\S]{0,40}stella_interactions/.test(rbk),
    `${RESERVED_QUOTA_ROLLBACK}: the rollback removes rows from the ledger. Those are units an organization actually spent, the trail is append-only for the owner as well, and a charge filed by a conversion is indistinguishable from any other by construction`)
  require_('capacity-rollback-preserves-charges',
    !/DELETE FROM uellix_stella_ops\.operation_tickets/.test(rbk)
    && !/DROP TABLE[\s\S]{0,40}operation_tickets/.test(rbk),
    `${RESERVED_QUOTA_ROLLBACK}: the rollback removes tickets. A completed ticket is the only record of WHICH operation a charged ledger row paid for`)

  // Convergence: every object the forward creates, the rollback removes.
  for (const { name } of CAPACITY_FUNCTIONS) {
    require_('capacity-rollback-convergence',
      new RegExp(`DROP FUNCTION IF EXISTS ${QUOTA_SCHEMA}\\.${name}\\(`).test(rbk),
      `${RESERVED_QUOTA_ROLLBACK}: ${name} is never dropped, so it survives as a callable SECURITY DEFINER function owned by ${QUOTA_ROLE} — and stella_0013's DROP ROLE then fails forever after`)
    require_('capacity-rollback-convergence',
      new RegExp(`REVOKE ALL ON FUNCTION ${QUOTA_SCHEMA}\\.${name}\\([^)]*\\) FROM`).test(rbk),
      `${RESERVED_QUOTA_ROLLBACK}: the EXECUTE grant this package made on ${name} is never withdrawn by name, so what it hands back can only be inferred from a cascade`)
  }
  for (const name of REPUBLISHED_VERBS) {
    require_('capacity-rollback-convergence',
      new RegExp(`DROP FUNCTION IF EXISTS ${TICKET_SCHEMA}\\.${name}\\(character, uuid`).test(rbk),
      `${RESERVED_QUOTA_ROLLBACK}: ${name} is never dropped, so a body that calls three functions this rollback removes stays installed and granted — broken rather than closed`)
  }
  require_('capacity-rollback-convergence',
    /DROP POLICY IF EXISTS "operation_tickets_capacity_select"/.test(rbk),
    `${RESERVED_QUOTA_ROLLBACK}: the capacity policy is never dropped, so a role with no functions keeps an organization-wide read on the reservation set`)
  require_('capacity-rollback-convergence',
    /DROP COLUMN IF EXISTS period_month/.test(rbk),
    `${RESERVED_QUOTA_ROLLBACK}: period_month is never dropped, so a re-application finds the column already there and stella_0016's state vector cannot tell the two states apart`)
  require_('capacity-rollback-convergence',
    new RegExp(`REVOKE ALL ON TABLE ${TICKET_SCHEMA}\\.operation_tickets FROM ${QUOTA_ROLE}`).test(rbk),
    `${RESERVED_QUOTA_ROLLBACK}: the column-level read this package opened onto the ticket table is never withdrawn`)

  // ...and it removes nothing that belongs to another package.
  for (const [what, re] of [
    ["stella_0013's governed function", /DROP FUNCTION IF EXISTS uellix_stella\.consume_stella_quota/],
    ["stella_0014's issue verb", /DROP FUNCTION IF EXISTS uellix_stella_ops\.issue_operation_ticket/],
    ["stella_0014's hygiene verb", /DROP FUNCTION IF EXISTS uellix_stella_ops\.expire_operation_tickets/],
    ["stella_0015's abort verb", /DROP FUNCTION IF EXISTS uellix_stella_ops\.abort_operation_ticket/],
    ["stella_0015's inspect verb", /DROP FUNCTION IF EXISTS uellix_stella_ops\.inspect_operation_ticket/],
    ['the ticket schema', /DROP SCHEMA uellix_stella_ops/],
    ['the quota schema', /DROP SCHEMA uellix_stella\b/],
    ['a capability role', /DROP ROLE uellix_cap_stella/],
  ] as const) {
    require_('capacity-rollback-scope', !re.test(rbk),
      `${RESERVED_QUOTA_ROLLBACK}: the rollback drops ${what}, which belongs to another package`)
  }

  require_('capacity-rollback-no-cascade', !/\bCASCADE\b/.test(rbk),
    `${RESERVED_QUOTA_ROLLBACK}: the rollback uses CASCADE, so the blast radius depends on what somebody attached later rather than on what the script states`)

  // One DO block: a RAISE ends it and no later statement of that block runs —
  // server semantics inside a single statement, which no client can separate.
  require_('capacity-rollback-single-block',
    (rbk.match(/^DO \$\$/gm) ?? []).length === 1,
    `${RESERVED_QUOTA_ROLLBACK}: the rollback is not one DO block, so a client that ignores ON_ERROR_STOP can run the destructive half after a refusal`)

  return v
}
