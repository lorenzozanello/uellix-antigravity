// tests/helpers/stella-ticket-gates.ts
//
// The static contract for the operation-ticket package (stella_0014,
// INT-INT-001) as a PURE FUNCTION over file contents.
//
// It is a pure function for the same reason tests/helpers/train4-gates.ts is:
// tests/stella-ticket-persistence-mutation.test.ts has to run exactly this code
// over deliberately broken copies. A gate that lives inside an assertion which
// reads the disk itself cannot be shown to go red, and a gate that has never
// gone red is indistinguishable from a gate that cannot.
//
// SCOPE. These gates judge the TWO stella_0014 files and nothing else. They are
// deliberately NOT folded into evaluateTrain4Gates(): that contract asserts
// exact facts about the four Train 4 files — and its `definer-owner` gate is
// written against `uellix_cap_stella_quota`, which is precisely the role this
// package does NOT use. Widening it would have meant relaxing an assertion that
// is exact today. Same argument train4-gates.ts makes for not joining the
// grounding contract, one train earlier.

import { analyzeSecurity, unparsedSecurityStatements } from './sql-structure'
import { parseFunctions } from './grounding-gates'

export const TICKET_FORWARD = 'stella_0014_operation_tickets.sql'
export const TICKET_ROLLBACK = 'stella_0014_rollback.sql'

export const TICKET_SQL_FILES = [TICKET_FORWARD, TICKET_ROLLBACK] as const

export type Sources = Record<string, string>

export interface Violation {
  readonly gate: string
  readonly detail: string
}

/** The ticket definer. Zero members, by design — see stella_0014 §1. */
const TICKET_ROLE = 'uellix_cap_stella_ticket'
/** The runtime identity. The only principal this package hands EXECUTE to. */
const RUNTIME_ROLE = 'uellix_app'
/** stella_0013's schema. This package must add NOTHING to it. */
const QUOTA_SCHEMA = 'uellix_stella'
/** This package's own schema. */
const TICKET_SCHEMA = 'uellix_stella_ops'

/** The ticket table, unqualified and qualified. */
const TABLE = `${TICKET_SCHEMA}.operation_tickets`

/**
 * The six governed functions, with the schema they must live in.
 *
 * Listed rather than discovered, because "the package publishes exactly these"
 * is itself the property: a seventh definer arriving in this schema is a
 * surface nobody reviewed.
 */
export const TICKET_FUNCTIONS = [
  'issue_operation_ticket',
  'bind_operation_ticket',
  'complete_operation_ticket',
  'abort_operation_ticket',
  'inspect_operation_ticket',
  'expire_operation_tickets',
] as const

/** The five states INT-INT-001 requires the machine to represent. */
export const TICKET_STATES = ['issued', 'bound', 'completed', 'aborted', 'expired'] as const

/**
 * The governed capability vocabulary. The SAME seven stella_0013 admits: a
 * ticket for a category the ledger cannot record is a ticket that can never be
 * completed.
 */
export const GOVERNED_CATEGORIES = [
  'advisor',
  'validator',
  'composer',
  'proxy_reviewer',
  'evidence_reviewer',
  'audit_assistant',
  'grounded_query',
] as const

/**
 * The columns whose value is fixed at issue. The trigger must refuse an UPDATE
 * that changes any of them — a ticket whose organization can be edited is not
 * bound to one, and a ticket whose expiry can be extended has none.
 */
export const IMMUTABLE_TICKET_COLUMNS = [
  'ticket_id',
  'organization_id',
  'project_id',
  'actor_id',
  'category',
  'charge_nonce',
  'issued_at',
  'expires_at',
] as const

/** Strip `--` line comments so prose cannot satisfy — or trip — a gate. */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

/**
 * Every `DROP FUNCTION` whose execution is CONDITIONAL on a table existing.
 *
 * This is INT-CAP-004 (1) expressed as a readable property rather than as a
 * string match, carried forward one train. grounding_0003_rollback nested its
 * DROP FUNCTIONs inside `IF to_regclass(...)`, so a database whose table had
 * gone by another route got a rollback that reported success and left callable
 * SECURITY DEFINER functions behind — which then blocked the DROP ROLE forever.
 *
 * The reader walks IF/END IF depth over comment-stripped text, keeping each
 * open block's CONDITION, and reports any DROP FUNCTION with a table-existence
 * test above it.
 *
 * A table-existence test is recognised BOTH written out (`IF to_regclass(...)`)
 * and through a variable that was assigned from one (`tbl_oid := to_regclass
 * (...)` … `IF tbl_oid IS NOT NULL`). The second form is the blind spot the
 * train 4 reader carried: this rollback keeps the oid in a local precisely so
 * it can be reused, so the most natural way to reintroduce INT-CAP-004 (1) here
 * is the one a name-only match cannot see. Found by a mutation that survived.
 */
function conditionalFunctionDrops(sql: string): string[] {
  const text = code(sql)
  const oidVars = [...text.matchAll(/(\w+)\s*:=\s*to_regclass\s*\(/g)].map((m) => m[1])
  const guardsTable = (condition: string) =>
    /to_regclass|information_schema|pg_class/i.test(condition)
    || oidVars.some((name) => new RegExp(`\\b${name}\\b`).test(condition))
  const token = /\bEND\s+IF\b|\bIF\b|\bTHEN\b|\bDROP\s+FUNCTION\b/g
  const open: string[] = []
  let pendingFrom = -1
  const found: string[] = []
  let m: RegExpExecArray | null
  while ((m = token.exec(text)) !== null) {
    const t = m[0].replace(/\s+/g, ' ').toUpperCase()
    if (t === 'END IF') {
      open.pop()
      pendingFrom = -1
    } else if (t === 'IF') {
      pendingFrom = m.index + m[0].length
    } else if (t === 'THEN') {
      open.push(pendingFrom === -1 ? '' : text.slice(pendingFrom, m.index))
      pendingFrom = -1
    } else {
      if (open.some(guardsTable)) {
        found.push(text.slice(m.index, Math.min(m.index + 90, text.length)).replace(/\s+/g, ' '))
      }
    }
  }
  return found
}

export function evaluateTicketGates(sources: Sources): Violation[] {
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
  for (const file of TICKET_SQL_FILES) {
    if (typeof sources[file] !== 'string' || sources[file].length === 0) {
      add('source-missing', `${file} is absent or empty`)
    }
  }
  if (v.length > 0) return v

  // ---------------------------------------------------------------------
  // Fail-closed: nothing in these packages may be unreadable.
  // ---------------------------------------------------------------------
  // A reader that silently drops what it cannot understand reports the same
  // "zero violations" as one that understood everything. This is the assertion
  // that makes every gate below mean something.
  for (const file of TICKET_SQL_FILES) {
    for (const u of unparsedSecurityStatements(sources[file])) {
      add('unparsed', `${file}: ${u.reason} @${u.line} (${u.origin}): ${u.lead}`)
    }
  }

  const fwd = code(sources[TICKET_FORWARD])
  const rbk = code(sources[TICKET_ROLLBACK])
  const functions = parseFunctions(sources[TICKET_FORWARD])
  const byName = new Map(functions.map((f) => [f.name, f]))
  const fn = (short: string) => byName.get(`${TICKET_SCHEMA}.${short}`)

  // =====================================================================
  // The package depends on stella_0013 and says so BEFORE it builds
  // =====================================================================
  // Without the guard the whole protocol installs cleanly and can charge
  // nothing — the invisible failure INT-CAP-001 reported one train ago.
  require_('ticket-quota-dependency',
    /IF to_regprocedure\('uellix_stella\.consume_stella_quota[\s\S]{0,200}?RAISE EXCEPTION/.test(fwd),
    `${TICKET_FORWARD}: nothing aborts when uellix_stella.consume_stella_quota is absent, so this package can install without a charge path`)

  // ...and it adds nothing to stella_0013's schema. That package asserts, over
  // its WHOLE schema, that every function there is owned by
  // uellix_cap_stella_quota — so one function of this package placed there
  // makes stella_0013 abort on its next apply. Measured, in pass 2 of
  // scripts/stella-ticket-dry-run.sh.
  for (const f of TICKET_FUNCTIONS) {
    require_('ticket-schema-isolation',
      !new RegExp(`CREATE OR REPLACE FUNCTION\\s+${QUOTA_SCHEMA}\\.${f}\\b`).test(fwd),
      `${TICKET_FORWARD}: ${f} is created in ${QUOTA_SCHEMA}, whose every function stella_0013 asserts is owned by uellix_cap_stella_quota — that package would abort on its next apply`)
  }
  require_('ticket-schema-isolation',
    new RegExp(`CREATE SCHEMA IF NOT EXISTS ${TICKET_SCHEMA}\\b`).test(fwd),
    `${TICKET_FORWARD}: the package does not create its own schema, so its objects land in one another package asserts exact facts about`)

  // =====================================================================
  // The state machine — the five states, and the transitions
  // =====================================================================
  const statusCheck = /ADD CONSTRAINT operation_tickets_status_check\s+CHECK \(status IN \(([\s\S]*?)\)\)/.exec(fwd)
  require_('ticket-state-vocabulary', statusCheck !== null,
    `${TICKET_FORWARD}: no CHECK pins the ticket status vocabulary, so any string is a state`)
  for (const s of TICKET_STATES) {
    require_('ticket-state-vocabulary',
      statusCheck !== null && statusCheck[1].includes(`'${s}'`),
      `${TICKET_FORWARD}: the status CHECK does not admit '${s}'`)
  }

  const trigger = byName.get('public.uellix_check_operation_ticket_transition')
  require_('ticket-state-machine', trigger !== undefined,
    `${TICKET_FORWARD}: the transition trigger function is missing, so every invariant that must bind the TABLE OWNER rests on RLS — which does not bind the owner`)

  if (trigger !== undefined) {
    const body = code(trigger.body)

    // A ticket is BORN issued. A row inserted straight into `completed` is the
    // forgery that would claim everything and pay nothing.
    require_('ticket-state-machine',
      /TG_OP = 'INSERT'[\s\S]*?NEW\.status <> 'issued'[\s\S]*?RAISE EXCEPTION/.test(body),
      `${TICKET_FORWARD}: the trigger does not refuse an INSERT in a state other than 'issued', so a completed ticket can be declared rather than earned`)

    // Terminal is terminal, and it is checked FIRST.
    require_('ticket-state-machine',
      /OLD\.status IN \('completed', 'aborted', 'expired'\)[\s\S]{0,200}?RAISE EXCEPTION/.test(body),
      `${TICKET_FORWARD}: the trigger does not freeze a settled ticket, so a completed operation can be reopened`)

    // The legal transitions, exhaustively — anything unnamed fails closed.
    require_('ticket-state-machine',
      /OLD\.status = 'issued' AND NEW\.status IN \('bound', 'aborted', 'expired'\)/.test(body)
      && /OLD\.status = 'bound'\s+AND NEW\.status IN \('completed', 'aborted', 'expired'\)/.test(body),
      `${TICKET_FORWARD}: the trigger does not enumerate the legal transitions, so an unnamed one is permitted rather than refused`)

    // ---- the scope, the actor and the window are fixed at issue --------
    for (const col of IMMUTABLE_TICKET_COLUMNS) {
      require_(
        col === 'expires_at' ? 'ticket-expiry-bounded'
          : col === 'actor_id' ? 'ticket-actor-binding'
            : col === 'organization_id' || col === 'project_id' ? 'ticket-scope-binding'
              : 'ticket-state-machine',
        new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`).test(body),
        `${TICKET_FORWARD}: the trigger permits UPDATE of ${col}, which is fixed at issue — a ticket whose ${col} can change is not bound to one`)
    }

    // ---- the digest is WRITE-ONCE -------------------------------------
    // This is invariants 5 and 6 of the contract in one clause: absent to
    // present exactly once, never to a different value. Without it a ticket can
    // be bound to one question and completed as another — free work.
    require_('ticket-hash-write-once',
      /OLD\.query_hash IS NOT NULL AND NEW\.query_hash IS DISTINCT FROM OLD\.query_hash[\s\S]{0,200}?RAISE EXCEPTION/.test(body),
      `${TICKET_FORWARD}: the trigger permits the query digest to be rewritten, so one ticket can be reused for a second question and do the work for free`)

    // ---- the project belongs to the organization ----------------------
    require_('ticket-scope-binding',
      /FROM public\.projects p WHERE p\.id = NEW\.project_id/.test(body)
      && /v_project_org IS DISTINCT FROM NEW\.organization_id/.test(body),
      `${TICKET_FORWARD}: the trigger does not check that the project belongs to the organization named, so a ticket can straddle a tenancy boundary the owner never crosses in RLS`)

    // ---- a completed ticket cannot be deleted --------------------------
    require_('ticket-settled-immutable',
      /TG_OP = 'DELETE'[\s\S]*?OLD\.status = 'completed'[\s\S]{0,200}?RAISE EXCEPTION/.test(body),
      `${TICKET_FORWARD}: the trigger permits deleting a completed ticket, whose charged ledger row can never be removed to match`)
  }

  // Both triggers must be ENABLE ALWAYS. A default-enabled trigger is skipped
  // under session_replication_role = replica, which is exactly the posture this
  // table exists to make impossible.
  for (const t of ['trg_operation_tickets_transition', 'trg_operation_tickets_no_truncate']) {
    require_('ticket-trigger-always',
      new RegExp(`ENABLE ALWAYS TRIGGER ${t}\\b`).test(fwd),
      `${TICKET_FORWARD}: ${t} is not ENABLE ALWAYS, so a session that sets session_replication_role = replica silences it`)
  }

  // =====================================================================
  // Expiry — present, and BOUNDED
  // =====================================================================
  // An unbounded expiry is the same defect as no expiry: a reservation that
  // never releases. The bound lives in a CHECK so it survives a direct INSERT,
  // and there is no TTL argument so no caller can widen it.
  const expiryCheck = /ADD CONSTRAINT operation_tickets_expiry_window_check\s+CHECK \(([\s\S]*?)\);/.exec(fwd)
  require_('ticket-expiry-bounded', expiryCheck !== null,
    `${TICKET_FORWARD}: no CHECK constrains the expiry window, so a ticket can be issued with none`)
  require_('ticket-expiry-bounded',
    expiryCheck !== null && /expires_at > issued_at/.test(expiryCheck[1]),
    `${TICKET_FORWARD}: the expiry CHECK does not require the expiry to be after issuance`)
  require_('ticket-expiry-bounded',
    expiryCheck !== null && /expires_at <= issued_at \+ interval '\d+ minutes'/.test(expiryCheck[1]),
    `${TICKET_FORWARD}: the expiry CHECK sets no upper bound, so a reservation can be taken out for a century and never release`)
  require_('ticket-expiry-bounded',
    !/issue_operation_ticket\([^)]*p_ttl/.test(fwd),
    `${TICKET_FORWARD}: issue_operation_ticket takes a TTL argument, so the caller chooses how long its own reservation holds`)

  // =====================================================================
  // The reservation — bind is where the quota decision happens
  // =====================================================================
  const bind = fn('bind_operation_ticket')
  require_('ticket-reservation', bind !== undefined,
    `${TICKET_FORWARD}: bind_operation_ticket is missing, so there is no point at which a unit is reserved before the operation runs`)

  if (bind !== undefined) {
    const body = code(bind.body)

    // Serialised against every other reservation AND against every charge.
    require_('ticket-advisory-lock',
      /pg_advisory_xact_lock\(/.test(body),
      `${TICKET_FORWARD}: bind_operation_ticket takes no advisory lock, so two reservations both read the same headroom and both proceed — the read-then-write race, one layer up`)
    // The SAME key stella_0013 uses. Two different keys would be two different
    // mutexes, and the headroom check would race the charge it constrains.
    require_('ticket-advisory-lock',
      /hashtextextended\('stella\/quota\/' \|\| v_org::text, 0\)/.test(body),
      `${TICKET_FORWARD}: bind_operation_ticket's advisory key is not the one consume_stella_quota takes, so the reservation and the charge do not exclude each other`)
    require_('ticket-advisory-lock',
      /FROM uellix_stella_ops\.operation_tickets t\s+WHERE t\.ticket_id = p_ticket_id\s+FOR UPDATE/.test(body),
      `${TICKET_FORWARD}: bind_operation_ticket does not lock the ticket row, so two sessions can bind the same ticket concurrently`)

    // The headroom counts CHARGED rows plus OTHER LIVE reservations. Dropping
    // either half oversells: without the ledger it ignores what was spent,
    // without the reservations it hands the same unit to every concurrent bind.
    require_('ticket-reservation',
      /count\(\*\)::integer INTO v_used[\s\S]{0,300}?FROM public\.stella_interactions/.test(body),
      `${TICKET_FORWARD}: bind_operation_ticket does not count the charged ledger, so it reserves against a limit it never measured`)
    require_('ticket-reservation',
      /count\(\*\)::integer INTO v_reserved[\s\S]{0,400}?status = 'bound'/.test(body),
      `${TICKET_FORWARD}: bind_operation_ticket does not count other live reservations, so every concurrent bind is handed the same last unit`)
    require_('ticket-reservation',
      /v_used \+ v_reserved >= v_quota/.test(body),
      `${TICKET_FORWARD}: bind_operation_ticket does not compare charged plus reserved against the cap, so the reservation reserves nothing`)

    // An orphaned reservation must stop counting BY ITSELF. There is no cron in
    // this project, so a liveness predicate that leaned on a sweeper would let a
    // crashed process starve an organization forever.
    require_('ticket-expiry-liveness',
      /t\.expires_at > v_now/.test(body),
      `${TICKET_FORWARD}: bind_operation_ticket counts reservations without testing their expiry, so a ticket abandoned by a crashed process holds its unit until something sweeps it — and nothing does`)

    // The digest is fixed exactly once, and a different one is refused whatever
    // state the ticket is in.
    require_('ticket-hash-write-once',
      /v_hash IS NOT NULL AND v_hash <> p_query_hash[\s\S]{0,200}?U0107/.test(body),
      `${TICKET_FORWARD}: bind_operation_ticket accepts a second, different digest on the same ticket`)
    require_('ticket-hash-shape',
      /p_query_hash !~ '\^\[0-9a-f\]\{64\}\$'/.test(body),
      `${TICKET_FORWARD}: bind_operation_ticket does not check the digest shape, so a value the retry cannot recompute is accepted as an identity`)

    // An expired ticket cannot be RESERVED either, not only completed. Stated
    // for bind as well as for complete because the two share the phrasing of
    // the check, and a mutation aimed at one of them silently hits whichever
    // appears first in the file — which is how a property ends up guarded in
    // exactly one of the two places anybody would look.
    require_('ticket-expiry-liveness',
      /v_expires <= v_now[\s\S]{0,200}?U0108/.test(body),
      `${TICKET_FORWARD}: bind_operation_ticket reserves against an expired ticket, so a stale token still takes a unit out of the organization's headroom`)
  }

  // =====================================================================
  // The charge — exactly once, under a key the caller cannot choose
  // =====================================================================
  const complete = fn('complete_operation_ticket')
  require_('ticket-charge-once', complete !== undefined,
    `${TICKET_FORWARD}: complete_operation_ticket is missing, so a bound ticket is never settled and never charged`)

  if (complete !== undefined) {
    const body = code(complete.body)

    // THE KEY. Derived from the ticket AND from a nonce the caller has never
    // seen. This is the sentence INT-INT-001 asked for.
    require_('ticket-derived-idempotency-key',
      /v_key := [\s\S]{0,400}?'stella\/ticket\/charge\/v1'[\s\S]{0,200}?p_ticket_id[\s\S]{0,120}?v_nonce/.test(body),
      `${TICKET_FORWARD}: the idempotency key is not derived from the ticket and its server-minted nonce — an identity the caller can compute is an identity the caller can replay`)
    require_('ticket-derived-idempotency-key',
      /INTO[\s\S]{0,200}?v_nonce[\s\S]{0,200}?FROM uellix_stella_ops\.operation_tickets/.test(body),
      `${TICKET_FORWARD}: complete_operation_ticket never reads the charge nonce, so whatever it charges under is derivable from the ticket alone`)

    // The charge goes THROUGH the governed function. This role holds no INSERT
    // on the ledger, so there is no other path even in principle — but a body
    // that wrote the ledger directly would be a body that stopped being true.
    require_('ticket-charge-once',
      /FROM uellix_stella\.consume_stella_quota\(v_org, v_project, v_category, v_key\)/.test(body),
      `${TICKET_FORWARD}: complete_operation_ticket does not charge through consume_stella_quota, so the ledger's own idempotency index no longer guards the charge`)
    require_('ticket-charge-once',
      !/INSERT INTO public\.stella_interactions\b/.test(body),
      `${TICKET_FORWARD}: complete_operation_ticket writes the ledger directly, going around the governed path and its checks`)

    // The retry. A completed ticket presented again reports what happened and
    // charges nothing — the whole point of the protocol.
    require_('ticket-charge-once',
      /v_status = 'completed'[\s\S]{0,200}?'replayed'/.test(body),
      `${TICKET_FORWARD}: complete_operation_ticket does not short-circuit an already-completed ticket, so a retry charges a second unit — the exact defect INT-INT-001 reports`)
    // The settle and the charge are one transaction, and the settle happens
    // only when the charge did.
    require_('ticket-charge-once',
      /v_charge\.outcome IN \('consumed', 'replayed'\)[\s\S]{0,400}?UPDATE uellix_stella_ops\.operation_tickets[\s\S]{0,200}?status = 'completed'/.test(body),
      `${TICKET_FORWARD}: complete_operation_ticket settles the ticket without conditioning on the charge's outcome, so a refused charge leaves a ticket that says it paid`)

    require_('ticket-expiry-liveness',
      /v_expires <= v_now[\s\S]{0,200}?U0108/.test(body),
      `${TICKET_FORWARD}: complete_operation_ticket does not refuse an expired ticket, so it charges against headroom already handed to someone else`)
  }

  // No governed function may take an idempotency key — or anything that looks
  // like one — from its caller. A key chosen by the client is a discount chosen
  // by the client, which is the candidate INT-INT-001 rules out by name.
  for (const f of functions) {
    require_('ticket-derived-idempotency-key',
      !/p_idempotency|p_key\b|p_charge/.test(f.header),
      `${TICKET_FORWARD}: ${f.name} accepts an idempotency key as an argument, so the caller chooses the identity it is charged under`)
  }

  // =====================================================================
  // The release — abort is not a refund
  // =====================================================================
  const abort = fn('abort_operation_ticket')
  require_('ticket-abort-releases', abort !== undefined,
    `${TICKET_FORWARD}: abort_operation_ticket is missing, so a failed operation's reservation is held until it expires`)

  if (abort !== undefined) {
    const body = code(abort.body)
    require_('ticket-abort-releases',
      /v_status = 'completed'[\s\S]{0,200}?RAISE EXCEPTION[\s\S]{0,200}?U0109/.test(body),
      `${TICKET_FORWARD}: abort_operation_ticket accepts a completed ticket, turning abort into a refund path the append-only ledger never received`)
    require_('ticket-abort-releases',
      /status = 'aborted'/.test(body) && !/DELETE FROM/.test(body),
      `${TICKET_FORWARD}: abort_operation_ticket does not record the abort as a state, so a released reservation is indistinguishable from one that never happened`)
    // A reason from a closed set, never free text: "why it failed" is a payload.
    require_('ticket-no-payload',
      /v_reasons text\[\] := ARRAY\[/.test(body) && /p_reason = ANY\(v_reasons\)/.test(body),
      `${TICKET_FORWARD}: abort_operation_ticket accepts a free-text reason, so a sentence about the failure lands in a table that survives the request`)
  }

  // =====================================================================
  // The category — checked at issue, and against the SAME seven
  // =====================================================================
  const categoryCheck = /ADD CONSTRAINT operation_tickets_category_check\s+CHECK \(category IN \(([\s\S]*?)\)\)/.exec(fwd)
  require_('ticket-category-vocabulary', categoryCheck !== null,
    `${TICKET_FORWARD}: no CHECK pins the ticket category, so a ticket can be issued for a capability the ledger cannot record`)
  const issue = fn('issue_operation_ticket')
  const issueGoverned = issue === undefined
    ? null
    : /v_governed\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/.exec(code(issue.body))
  require_('ticket-category-vocabulary', issueGoverned !== null,
    `${TICKET_FORWARD}: issue_operation_ticket declares no governed vocabulary, so any string is a chargeable category`)
  require_('ticket-category-vocabulary',
    issue !== undefined && /p_category = ANY\(v_governed\)/.test(code(issue.body)),
    `${TICKET_FORWARD}: issue_operation_ticket never compares the category against its governed vocabulary, so declaring the list changes nothing`)
  for (const c of GOVERNED_CATEGORIES) {
    require_('ticket-category-vocabulary',
      categoryCheck !== null && categoryCheck[1].includes(`'${c}'`),
      `${TICKET_FORWARD}: the category CHECK does not admit '${c}', so a ticket for it can never be issued`)
    require_('ticket-category-vocabulary',
      issueGoverned !== null && issueGoverned[1].includes(`'${c}'`),
      `${TICKET_FORWARD}: issue_operation_ticket's governed array does not name '${c}', so the CHECK and the function disagree about what is chargeable`)
  }

  // =====================================================================
  // The actor and the scope, at the privilege layer too
  // =====================================================================
  // RLS is not the last line of defence here — the trigger is, because it binds
  // the owner. But the policies must state the same boundary, so an edit to a
  // function body cannot quietly widen what that function may touch.
  const policies = fwd.match(/CREATE POLICY "operation_tickets_definer_\w+"[\s\S]*?;/g) ?? []
  require_('ticket-actor-binding', policies.length === 3,
    `${TICKET_FORWARD}: expected 3 policies on the ticket table (select/insert/update, and no delete), found ${policies.length}`)
  for (const p of policies) {
    require_('ticket-actor-binding', /actor_id = auth\.uid\(\)/.test(p),
      `${TICKET_FORWARD}: a ticket policy does not equate actor_id with the session, so a ticket issued to one person is usable by another`)
    require_('ticket-scope-binding', /organization_id = ANY\(public\.current_user_org_ids\(\)\)/.test(p),
      `${TICKET_FORWARD}: a ticket policy does not re-impose the organization boundary, and SECURITY DEFINER bypasses RLS on everything it reads`)
  }
  require_('ticket-settled-immutable',
    !/CREATE POLICY[^;]*ON uellix_stella_ops\.operation_tickets FOR DELETE/.test(fwd),
    `${TICKET_FORWARD}: a DELETE policy exists on the ticket table. Nothing in this protocol is resolved by making a ticket disappear`)

  // The actor is DERIVED in every function. An argument for it would let a
  // caller act in someone else's name, whatever the policies say afterwards.
  for (const f of functions) {
    if (f.name === 'public.uellix_check_operation_ticket_transition') continue
    require_('ticket-actor-binding',
      /v_actor := auth\.uid\(\)/.test(code(f.body)),
      `${TICKET_FORWARD}: ${f.name} does not derive the actor from the session`)
    require_('ticket-actor-binding',
      !/p_actor|p_user|p_created_by/.test(f.header),
      `${TICKET_FORWARD}: ${f.name} takes the actor as an argument, so a caller can charge a unit in someone else's name`)
  }
  require_('ticket-scope-binding',
    issue !== undefined
      && /p_organization_id = ANY\(public\.current_user_org_ids\(\)\)/.test(code(issue.body))
      && /WHERE p\.id = p_project_id AND p\.organization_id = p_organization_id/.test(code(issue.body)),
    `${TICKET_FORWARD}: issue_operation_ticket does not re-impose organization membership and project ownership, so a ticket can be minted against a tenant the caller cannot see`)

  // =====================================================================
  // The definer contract
  // =====================================================================
  for (const f of functions) {
    // The trigger function is SECURITY INVOKER on purpose: it must run with the
    // privileges of whoever is writing, because its job is to bind THEM.
    if (f.name === 'public.uellix_check_operation_ticket_transition') {
      require_('ticket-definer-security', !/\bSECURITY DEFINER\b/.test(f.header),
        `${TICKET_FORWARD}: the transition trigger is SECURITY DEFINER, so it would run as its owner and stop binding the role that is actually writing`)
      require_('ticket-definer-search-path', /SET search_path = ''/.test(f.header),
        `${TICKET_FORWARD}: the transition trigger does not pin search_path`)
      continue
    }

    require_('ticket-definer-security', /\bSECURITY DEFINER\b/.test(f.header),
      `${TICKET_FORWARD}: ${f.name} is not SECURITY DEFINER`)
    require_('ticket-definer-search-path', /SET search_path = ''/.test(f.header),
      `${TICKET_FORWARD}: ${f.name} does not pin search_path to the empty string — with pg_temp reachable a caller shadows an unqualified name and the definer runs it`)
    // `[\s\S]*?` and not `[^)]*` for the argument list: a signature contains
    // NESTED parentheses — `varchar(50)`, `char(64)` — so a negated-) class
    // stops at the first inner bracket and the match fails on exactly the five
    // functions that take one. Measured: only expire_operation_tickets(integer)
    // passed, which is the shape of a gate that is green by accident.
    const sig = `${f.name.replace('.', '\\.')}\\([\\s\\S]*?\\)`
    require_('ticket-definer-owner',
      new RegExp(`ALTER FUNCTION ${sig}\\s*\\n?\\s*OWNER TO ${TICKET_ROLE}`).test(sources[TICKET_FORWARD]),
      `${TICKET_FORWARD}: ${f.name} is not owned by ${TICKET_ROLE}`)
    require_('ticket-definer-acl',
      new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`).test(sources[TICKET_FORWARD]),
      `${TICKET_FORWARD}: EXECUTE on ${f.name} is not revoked from PUBLIC, which is the default grantee`)
    require_('ticket-definer-acl',
      new RegExp(`GRANT EXECUTE ON FUNCTION ${sig} TO ${RUNTIME_ROLE}`).test(sources[TICKET_FORWARD]),
      `${TICKET_FORWARD}: ${f.name} has no EXECUTE grant to ${RUNTIME_ROLE}, so the runtime cannot reach the governed path at all`)
    require_('ticket-definer-no-star', !/\bSELECT \*(?!\s*INTO)/.test(code(f.body)),
      `${TICKET_FORWARD}: ${f.name} uses SELECT *, so a column added later silently changes its result shape — and this table holds a nonce`)
    require_('ticket-definer-no-dynamic-sql', !/\bEXECUTE\b/.test(code(f.body)),
      `${TICKET_FORWARD}: ${f.name} contains EXECUTE. A definer must not compose SQL`)

    // An error message is a channel. A definer that interpolates an id or a
    // digest into a RAISE hands an untrusted caller an oracle.
    for (const raise of code(f.body).match(/RAISE EXCEPTION[\s\S]*?;/g) ?? []) {
      require_('ticket-error-detail', !/\bp_[a-z_]+\b/.test(raise),
        `${TICKET_FORWARD}: ${f.name} interpolates an argument into an error message, which turns a refusal into an oracle`)
      require_('ticket-error-detail', !/\bv_(nonce|key|hash)\b/.test(raise),
        `${TICKET_FORWARD}: ${f.name} interpolates a secret or a digest into an error message`)
    }
  }

  // Every function this package promises must actually exist.
  for (const f of TICKET_FUNCTIONS) {
    require_('ticket-definer-inventory', byName.has(`${TICKET_SCHEMA}.${f}`),
      `${TICKET_FORWARD}: ${TICKET_SCHEMA}.${f} is not published by this package`)
  }
  // ...and nothing else may arrive in its schema unjudged.
  for (const f of functions) {
    if (f.name === 'public.uellix_check_operation_ticket_transition') continue
    require_('ticket-definer-inventory',
      (TICKET_FUNCTIONS as readonly string[]).includes(f.name.replace(`${TICKET_SCHEMA}.`, '')),
      `${TICKET_FORWARD}: ${f.name} is a function this contract does not know about`)
  }

  // =====================================================================
  // Privilege — the nonce is unreachable, and the ledger is unwritable
  // =====================================================================
  const analysis = analyzeSecurity(sources[TICKET_FORWARD])
  for (const g of analysis.grants) {
    if (g.objectType !== 'TABLE') continue
    for (const grantee of g.grantees) {
      for (const priv of g.privileges) {
        const isWrite = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'ALL']
          .includes(priv.privilege.toUpperCase())
        require_('ticket-write-grant', !isWrite || grantee === TICKET_ROLE,
          `${TICKET_FORWARD}: GRANT ${priv.privilege} ON ${g.object} TO ${grantee} — only the capability role may write`)
        require_('ticket-write-grant',
          !['DELETE', 'TRUNCATE', 'ALL'].includes(priv.privilege.toUpperCase()),
          `${TICKET_FORWARD}: GRANT ${priv.privilege} ON ${g.object} TO ${grantee} — nothing in this protocol removes a ticket`)
      }
      // The nonce lives in this table. A role that could read it could compute
      // the idempotency key and charge outside the protocol entirely.
      require_('ticket-write-grant',
        g.object !== TABLE || grantee === TICKET_ROLE,
        `${TICKET_FORWARD}: GRANT ... ON ${TABLE} TO ${grantee} — the charge nonce must be unreadable outside the definer`)
      require_('ticket-write-grant', !g.grantOption,
        `${TICKET_FORWARD}: GRANT ... ON ${g.object} TO ${grantee} carries WITH GRANT OPTION, so the grantee can re-grant it`)
    }
  }
  // The ledger stays unwritable from here: the separation is what makes "the
  // only way to charge is the governed function" a fact about PRIVILEGES rather
  // than a claim about a function body.
  require_('ticket-write-grant',
    /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.stella_interactions FROM uellix_cap_stella_ticket/.test(fwd),
    `${TICKET_FORWARD}: the ticket role's write privileges on the ledger are not revoked, so a future edit could file a charge without a ticket`)
  require_('ticket-write-grant',
    !/GRANT[^;]*\b(INSERT|UPDATE|DELETE)\b[^;]*ON public\.stella_interactions[^;]*TO uellix_cap_stella_ticket/.test(fwd),
    `${TICKET_FORWARD}: the ticket role is granted write on the ledger, so it can charge without going through consume_stella_quota`)

  // =====================================================================
  // No payload. The prohibition is a property of the SHAPE, and shape can be
  // measured — so it is, rather than promised in a comment.
  // =====================================================================
  const createTable = /CREATE TABLE IF NOT EXISTS uellix_stella_ops\.operation_tickets \(([\s\S]*?)\n\);/.exec(fwd)
  require_('ticket-no-payload', createTable !== null,
    `${TICKET_FORWARD}: the ticket table is not created in the expected form, so nothing can judge which columns it has`)
  if (createTable !== null) {
    for (const line of createTable[1].split('\n')) {
      const col = /^\s{2}(\w+)\s+(\w+)/.exec(line)
      if (col === null) continue
      const [, name, type] = col
      require_('ticket-no-payload',
        name === 'status' || !['text', 'json', 'jsonb', 'bytea', 'xml'].includes(type.toLowerCase()),
        `${TICKET_FORWARD}: column ${name} is ${type} and could hold a payload. This table stores digests and closed-vocabulary codes, never the query, a prompt, an answer or evidence`)
    }
  }
  // ...and nothing is smuggled in afterwards by an ALTER. Scoped to ADD COLUMN
  // rather than scanning the file for words: an earlier revision matched
  // /\bprompt\b/ anywhere in the source and fired on the package's OWN
  // `COMMENT ON TABLE`, which is the sentence PROMISING there is no prompt
  // column. A gate that refuses its own documentation is reading prose, not
  // shape.
  for (const alter of fwd.match(/ALTER TABLE uellix_stella_ops\.operation_tickets[\s\S]*?ADD COLUMN[^;]*;/g) ?? []) {
    require_('ticket-no-payload',
      !/\b(text|json|jsonb|bytea|xml)\b/i.test(alter),
      `${TICKET_FORWARD}: a column capable of holding a payload is added to the ticket table (${alter.replace(/\s+/g, ' ').slice(0, 80)})`)
  }

  // =====================================================================
  // Self-verification — the package asserts its own end state
  // =====================================================================
  require_('ticket-self-verification',
    /FAILED verification/.test(fwd),
    `${TICKET_FORWARD}: the package asserts nothing about the state it leaves behind`)
  require_('ticket-self-verification',
    /RAISE EXCEPTION 'stella_0014 FAILED verification[\s\S]{0,4000}?tgenabled = 'A'/.test(fwd)
    || /tgenabled = 'A'[\s\S]{0,600}?RAISE EXCEPTION 'stella_0014 FAILED verification/.test(fwd),
    `${TICKET_FORWARD}: the package does not verify that its triggers are ENABLE ALWAYS, which is the one trigger property a session can otherwise silence`)

  // =====================================================================
  // The rollback
  // =====================================================================
  // A completed ticket is the only record of WHICH operation a charged row paid
  // for. Dropping the table would leave charges unattributable and their keys
  // unrecoverable — so a retry would be issued a NEW ticket and charged AGAIN.
  require_('ticket-rollback-refuses-settled',
    /status = 'completed'[\s\S]{0,300}?RAISE EXCEPTION[\s\S]{0,400}?rollback refused/.test(rbk),
    `${TICKET_ROLLBACK}: the rollback does not count settled tickets or does not refuse on them, so uninstalling the protocol reintroduces the double charge it closes`)

  for (const drop of conditionalFunctionDrops(sources[TICKET_ROLLBACK])) {
    add('ticket-rollback-function-drop-unconditional',
      `${TICKET_ROLLBACK}: a DROP FUNCTION is nested inside a table-existence test (${drop}). A database whose table went by another route would get a rollback that exits 0 and leaves a callable SECURITY DEFINER function behind`)
  }

  // Convergence: every object the forward creates, the rollback removes.
  for (const f of TICKET_FUNCTIONS) {
    require_('ticket-rollback-convergence',
      new RegExp(`DROP FUNCTION IF EXISTS uellix_stella_ops\\.${f}\\(`).test(rbk),
      `${TICKET_ROLLBACK}: ${f} is never dropped, so it survives as a callable SECURITY DEFINER function and blocks the DROP ROLE forever`)
  }
  for (const [what, re] of [
    ['the ticket table', /DROP TABLE uellix_stella_ops\.operation_tickets/],
    ['the transition trigger function', /DROP FUNCTION IF EXISTS public\.uellix_check_operation_ticket_transition\(\)/],
    ['the package schema', /DROP SCHEMA uellix_stella_ops/],
    ['the capability role', /DROP ROLE uellix_cap_stella_ticket/],
  ] as const) {
    require_('ticket-rollback-convergence', re.test(rbk),
      `${TICKET_ROLLBACK}: ${what} is never dropped, so the rollback does not return the database to the state it found`)
  }

  // ...and it removes nothing that belongs to another package.
  for (const [what, re] of [
    ['stella_0013\'s governed function', /DROP FUNCTION IF EXISTS uellix_stella\.consume_stella_quota/],
    ['stella_0013\'s schema', /DROP SCHEMA uellix_stella\b/],
    ['the quota capability role', /DROP ROLE uellix_cap_stella_quota/],
    ['the ledger', /DROP TABLE public\.stella_interactions/],
  ] as const) {
    require_('ticket-rollback-scope', !re.test(rbk),
      `${TICKET_ROLLBACK}: the rollback drops ${what}, which belongs to another package`)
  }

  require_('ticket-rollback-no-cascade', !/\bCASCADE\b/.test(rbk),
    `${TICKET_ROLLBACK}: the rollback uses CASCADE, so the blast radius depends on what somebody attached later rather than on what the script states`)

  // One DO block: a RAISE ends it and no later statement of that block runs —
  // server semantics inside a single statement, which no client can separate.
  require_('ticket-rollback-single-block',
    (rbk.match(/^DO \$\$/gm) ?? []).length === 1,
    `${TICKET_ROLLBACK}: the rollback is not one DO block, so a client that ignores ON_ERROR_STOP can run the destructive half after the refusal`)

  return v
}
