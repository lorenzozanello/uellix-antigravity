// tests/helpers/stella-project-ticket-mutations.ts
//
// The catalogue of deliberate breakages for the project-binding package
// (stella_0015, R2-INT).
//
// Each entry names ONE property of the closure, the edit that removes it, and
// the gate in tests/helpers/stella-project-ticket-gates.ts that must refuse the
// result. tests/stella-project-ticket-mutation.test.ts applies them to an
// in-memory copy — nothing here writes to db/prepared.
//
// The three rules carry over from tests/helpers/stella-ticket-mutations.ts, and
// they are what make the count mean anything:
//
//   1. A mutation must actually CHANGE the text. A stale anchor matches
//      nothing, produces an unmutated source, and yields a violation-free run
//      that reads as a pass.
//   2. It is not enough that SOMETHING objected. The gate that OWNS the
//      property must fire, or the day that gate is weakened the suite stays
//      green because a bystander still notices.
//   3. A mutation is NOT detected because the mutated SQL would fail to
//      compile. "PostgreSQL would have rejected it" is an argument about a
//      database this unit is forbidden from touching. Detection means: a named
//      gate returned a violation, offline, from the text.
//
// IDS. K-40 onwards, continuing the stella_0014 catalogue rather than restarting
// — tests/stella-project-ticket-mutation.test.ts asserts the two sets are
// disjoint, so "K-17" can only ever mean one thing across both packages.

import { PROJECT_TICKET_FORWARD, PROJECT_TICKET_ROLLBACK } from './stella-project-ticket-gates'

export interface Mutation {
  readonly id: string
  readonly file: string
  readonly severity: 'CRITICAL' | 'MAJOR' | 'MINOR'
  /** The clause of R2-INT the property comes from. */
  readonly clause: string
  readonly change: string
  readonly breaks: string
  readonly expectedGate: readonly string[]
  readonly apply: (sql: string) => string
}

/**
 * Replace the first occurrence, or return the input unchanged.
 *
 * The replacement goes through a FUNCTION, not a string. `String.replace` with
 * a string replacement treats `$$` as an escape for a literal `$`, and several
 * anchors below quote PostgreSQL dollar quotes — so a plain string replacement
 * silently breaks the quote and kills the mutant with an `unparsed` violation
 * instead of the gate it was written to exercise.
 */
const sub = (from: string, to: string) => (sql: string) => sql.replace(from, () => to)

/* -------------------------------------------------------------------------- */
/* The argument — four verbs that must receive the execution project          */
/* -------------------------------------------------------------------------- */

export const ARGUMENT_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-40',
    file: PROJECT_TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'R2-INT — bind receives the execution project',
    change: 'bind_operation_ticket loses the p_expected_project_id argument',
    breaks:
      'This is R2-INT itself, restored. With no project in the signature the database has nothing to compare, so a ticket minted on one project\'s surface reserves a unit for work executed on another\'s — and every later verb inherits a reservation nobody checked. It is not a quota escape: the cap is organizational and exactly one unit is sold. It is an attribution defect, and in a product whose entire output is an auditable SROI figure a misattributed unit is worse than an uncharged one.',
    expectedGate: ['ticket-project-argument'],
    apply: sub(
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.bind_operation_ticket(\n  p_ticket_id char(64),\n  p_expected_project_id uuid,\n  p_query_hash char(64)\n)',
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.bind_operation_ticket(\n  p_ticket_id char(64),\n  p_query_hash char(64)\n)',
    ),
  },
  {
    id: 'K-41',
    file: PROJECT_TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'R2-INT — bind compares the ticket project against the execution project',
    change: 'bind_operation_ticket accepts the execution project and never compares it',
    breaks:
      'The signature would advertise a binding the body does not impose — worse than not having the argument at all, because every reviewer downstream reads the signature and stops there. The reservation would be taken for a project the caller never proved it was executing against, and the audit trail would carry a parameter that looks like a check.',
    expectedGate: ['ticket-project-comparison'],
    // bind is the FIRST of the four in the file and `String.replace` takes the
    // first match, so the plain anchor lands here. K-43 needs a comment anchor
    // for exactly that reason.
    apply: sub(
      '  IF v_project IS DISTINCT FROM p_expected_project_id THEN',
      '  IF FALSE THEN',
    ),
  },
  {
    id: 'K-42',
    file: PROJECT_TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'R2-INT — complete receives the execution project',
    change: 'complete_operation_ticket loses the p_expected_project_id argument',
    breaks:
      'complete is the ONLY verb that charges, and it runs in a different transaction from bind. Removing its argument means the one call that files a row in the ledger under a project_id is the one call that cannot say which project the work was done for — so bind\'s check becomes a claim about a request that has already ended.',
    expectedGate: ['ticket-project-argument'],
    apply: sub(
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.complete_operation_ticket(\n  p_ticket_id char(64),\n  p_expected_project_id uuid,\n  p_query_hash char(64)\n)',
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.complete_operation_ticket(\n  p_ticket_id char(64),\n  p_query_hash char(64)\n)',
    ),
  },
  {
    id: 'K-43',
    file: PROJECT_TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'R2-INT — complete revalidates independently of bind',
    change: 'complete_operation_ticket stops comparing the project bind already compared',
    breaks:
      'The whole reason complete rechecks is that bind committed in an earlier transaction: between the two, the same ticket can be presented from a different project\'s surface. Trusting bind here is trusting evidence from a request that has ended, and it is the charge — not the reservation — that lands in an append-only ledger under a project_id that can never be corrected.',
    expectedGate: ['ticket-project-comparison'],
    // Anchored on the COMMENT that only complete_operation_ticket carries. The
    // four bodies contain the same clause verbatim and bind appears first, so
    // an anchor written on the code alone mutates bind and tests a property
    // this entry does not claim to test.
    apply: sub(
      '  -- R2-INT, checked BEFORE the replay short-circuit. A completed ticket\n  -- presented from another project must not be answered `replayed`: that answer\n  -- says "this operation already happened and was already charged", and the\n  -- operation it refers to is not the caller\'s.\n  IF v_project IS DISTINCT FROM p_expected_project_id THEN',
      '  -- R2-INT, checked BEFORE the replay short-circuit. A completed ticket\n  -- presented from another project must not be answered `replayed`: that answer\n  -- says "this operation already happened and was already charged", and the\n  -- operation it refers to is not the caller\'s.\n  IF FALSE THEN',
    ),
  },
  {
    id: 'K-44',
    file: PROJECT_TICKET_FORWARD,
    severity: 'MAJOR',
    clause: 'R2-INT — abort receives the execution project',
    change: 'abort_operation_ticket loses the p_expected_project_id argument',
    breaks:
      'One project\'s surface could release the reservation another project\'s operation is holding. Nothing is charged either way, so this is not a billing defect — it is a denial of service with a governed name: the victim\'s complete then finds an aborted ticket, and work that already ran and already cost a model call is discarded with a refusal that reads as its own fault.',
    expectedGate: ['ticket-project-argument'],
    apply: sub(
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.abort_operation_ticket(\n  p_ticket_id char(64),\n  p_expected_project_id uuid,\n  p_reason varchar(40)\n)',
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.abort_operation_ticket(\n  p_ticket_id char(64),\n  p_reason varchar(40)\n)',
    ),
  },
  {
    id: 'K-45',
    file: PROJECT_TICKET_FORWARD,
    severity: 'MAJOR',
    clause: 'R2-INT — inspect does not disclose another project\'s state',
    change: 'inspect_operation_ticket loses the p_expected_project_id argument',
    breaks:
      'The lifecycle of a ticket welded to one project becomes readable from every other project\'s surface in the organization: whether it was bound, whether it was settled, when it expires. Nothing is charged and nothing is written, which is exactly why it survives review — but it is the reconnaissance half of every attack the other three verbs refuse, and it tells an attacker which tickets are worth presenting.',
    expectedGate: ['ticket-project-argument'],
    apply: sub(
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.inspect_operation_ticket(\n  p_ticket_id char(64),\n  p_expected_project_id uuid\n)',
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.inspect_operation_ticket(\n  p_ticket_id char(64)\n)',
    ),
  },
  {
    id: 'K-51',
    file: PROJECT_TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 3 — no executable path skips the new argument',
    change: 'the execution project is given a DEFAULT, so the caller may omit it',
    breaks:
      'A defaulted argument makes the two-argument call site legal again: `inspect_operation_ticket(t)` resolves, and the guarantee moves from the SIGNATURE (the call does not exist) to a branch inside the body (the call exists and something catches it). The second can be edited away by someone who reads the NULL check as defensive noise, and the runtime role would be back to omitting the project entirely — with the signature still advertising that it cannot.',
    expectedGate: ['ticket-project-no-default'],
    apply: sub(
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.inspect_operation_ticket(\n  p_ticket_id char(64),\n  p_expected_project_id uuid\n)',
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.inspect_operation_ticket(\n  p_ticket_id char(64),\n  p_expected_project_id uuid DEFAULT NULL\n)',
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* The old surface — revoked and removed, not left beside the fix             */
/* -------------------------------------------------------------------------- */

export const LEGACY_SURFACE_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-46',
    file: PROJECT_TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 3 — the unbound signatures are dropped',
    change: 'the unbound bind_operation_ticket(character, character) is never dropped',
    breaks:
      'The R2-INT path stays callable next to its own fix, and PostgreSQL resolves the two-argument call to it without complaint. Every assertion about the new signature keeps passing, the dry run keeps reporting four project-bound functions, and the defect is reachable by a caller that simply did not pass the third argument — which is every caller written before this package existed.',
    expectedGate: ['ticket-project-legacy-dropped'],
    apply: sub(
      'DROP FUNCTION IF EXISTS uellix_stella_ops.bind_operation_ticket(character, character);\n',
      '',
    ),
  },
  {
    id: 'K-47',
    file: PROJECT_TICKET_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 3 — EXECUTE on the old signature is revoked before it is replaced',
    change: 'the REVOKE on the unbound complete_operation_ticket is dropped',
    breaks:
      'For the length of the transaction a runtime principal holds EXECUTE on a settle-and-charge function that takes no project — and if the DROP further down ever fails, is reordered, or is made conditional, the grant is what remains. Stating the REVOKE separately is what makes "no unbound path was ever executable" a property of the ACL rather than a consequence of a DROP nobody re-reads.',
    expectedGate: ['ticket-project-legacy-revoked'],
    apply: sub(
      "    EXECUTE 'REVOKE ALL ON FUNCTION uellix_stella_ops.complete_operation_ticket(character, character) FROM uellix_app';\n",
      '',
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* The error contract and the attribution                                     */
/* -------------------------------------------------------------------------- */

export const CONTRACT_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-48',
    file: PROJECT_TICKET_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 4 — PROJECT_SCOPE_MISMATCH is distinguishable',
    change: 'the project mismatch in bind is laundered into the generic out-of-scope code',
    breaks:
      'Six causes collapse into one code: another organization, another actor, no such ticket, and now another project. The caller cannot tell an attack from a wiring bug, the operator cannot tell a tenancy breach from a mis-mounted surface, and the integration that must decide whether to retry, to abort or to page someone is handed the same answer for all of them. The refusal still happens — it just stops being actionable.',
    expectedGate: ['ticket-project-error-code'],
    apply: sub(
      "    RAISE EXCEPTION 'stella ticket: the ticket belongs to a different project' USING ERRCODE = 'U0110';\n  END IF;\n\n  v_now := pg_catalog.timezone('UTC', pg_catalog.now());",
      "    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';\n  END IF;\n\n  v_now := pg_catalog.timezone('UTC', pg_catalog.now());",
    ),
  },
  {
    id: 'K-49',
    file: PROJECT_TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'R2-INT — the charge is attributed to the project that was proven',
    change: 'the charge is filed under a project chosen by a query instead of the ticket\'s own',
    breaks:
      'Every check passes and the unit still lands on the wrong project. This is the mutation that shows the comparison is not the whole property: proving `ticket.project = expected` means nothing if the value handed to consume_stella_quota is a third one. The ledger is append-only, so the misattribution can never be corrected — only annotated.',
    expectedGate: ['ticket-project-charge-attribution'],
    apply: sub(
      '  FROM uellix_stella.consume_stella_quota(v_org, v_project, v_category, v_key) c;',
      '  FROM uellix_stella.consume_stella_quota(v_org, (SELECT p.id FROM public.projects p WHERE p.organization_id = v_org ORDER BY p.id LIMIT 1), v_category, v_key) c;',
    ),
  },
  {
    id: 'K-52',
    file: PROJECT_TICKET_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 4 — the refusal is not an existence oracle',
    change: 'complete judges the project before the row has been found',
    breaks:
      'Moving the comparison above the NOT FOUND test makes the two failures distinguishable: a ticket that does not exist answers one way and a ticket of another project answers another, so a caller can enumerate which 256-bit identifiers correspond to real tickets of an organization it belongs to. The scope check exists precisely so that "not yours" and "never existed" are the same sentence.',
    expectedGate: ['ticket-project-check-order'],
    apply: sub(
      "  IF NOT FOUND THEN\n    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';\n  END IF;\n\n  -- R2-INT, checked BEFORE the replay short-circuit.",
      "  -- R2-INT, checked BEFORE the replay short-circuit.",
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* The rollback                                                                */
/* -------------------------------------------------------------------------- */

export const ROLLBACK_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-50',
    file: PROJECT_TICKET_ROLLBACK,
    severity: 'CRITICAL',
    clause: 'FASE 7 — the rollback does not republish a vulnerable surface',
    change: 'the rollback "restores the previous version" of bind_operation_ticket',
    breaks:
      'It reads as the most ordinary thing a rollback can do, and it is the defect. R2-INT is not a body a newer body fixed — it is the ABSENCE of an argument, so restoring the previous signature and republishing the vulnerability are the same statement. Worse, it fires on exactly the databases that had used the protocol: the ones with real tickets, real charges and a real reason to be rolling something back.',
    expectedGate: ['ticket-project-rollback-safe'],
    apply: sub(
      "SET client_min_messages = notice;\n",
      "SET client_min_messages = notice;\n\nCREATE OR REPLACE FUNCTION uellix_stella_ops.bind_operation_ticket(\n  p_ticket_id char(64),\n  p_query_hash char(64)\n)\nRETURNS TABLE (outcome text, used integer, quota integer)\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = ''\nAS $$\nBEGIN\n  RETURN QUERY SELECT 'bound'::text, NULL::integer, NULL::integer;\nEND;\n$$;\nGRANT EXECUTE ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), char(64)) TO uellix_app;\n",
    ),
  },
  {
    id: 'K-53',
    file: PROJECT_TICKET_ROLLBACK,
    severity: 'CRITICAL',
    clause: 'FASE 7 — the rollback converges',
    change: 'the project-bound complete_operation_ticket is never dropped',
    breaks:
      'A callable SECURITY DEFINER function survives a rollback that reports success — and because it is owned by uellix_cap_stella_ticket, stella_0014\'s DROP ROLE fails forever after, which makes the ticket protocol permanently un-uninstallable. That is INT-CAP-004 (1) exactly: the defect grounding_0003_rollback shipped, two trains earlier.',
    expectedGate: ['ticket-project-rollback-convergence'],
    apply: sub(
      "  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.complete_operation_ticket(character, uuid, character)';\n",
      '',
    ),
  },
]

export const PROJECT_MUTATIONS: readonly Mutation[] = [
  ...ARGUMENT_MUTATIONS,
  ...LEGACY_SURFACE_MUTATIONS,
  ...CONTRACT_MUTATIONS,
  ...ROLLBACK_MUTATIONS,
]
