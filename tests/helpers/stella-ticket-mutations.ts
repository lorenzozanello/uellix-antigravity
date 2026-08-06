// tests/helpers/stella-ticket-mutations.ts
//
// The catalogue of deliberate breakages for the operation-ticket package
// (stella_0014, INT-INT-001).
//
// Each entry names ONE property of the protocol, the edit that removes it, and
// the gate in tests/helpers/stella-ticket-gates.ts that must refuse the result.
// tests/stella-ticket-persistence-mutation.test.ts applies them to an in-memory
// copy — nothing here writes to db/prepared.
//
// Three rules carry over from tests/helpers/train4-mutations.ts, and they are
// what make the count mean anything:
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

import { TICKET_FORWARD, TICKET_ROLLBACK } from './stella-ticket-gates'

export interface Mutation {
  readonly id: string
  readonly file: string
  readonly severity: 'CRITICAL' | 'MAJOR' | 'MINOR'
  /** The clause of INT-INT-001 the property comes from. */
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
/* Scope, actor and category — what the ticket is welded to                   */
/* -------------------------------------------------------------------------- */

export const BINDING_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-01',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'invariant 2 — the ticket is bound to an actor',
    change: 'the transition trigger stops treating actor_id as immutable',
    breaks:
      'A ticket issued to one person could be reassigned to another by any role that can UPDATE the row — including the table owner, whom RLS does not bind. The actor equality in the policies would still hold afterwards, because the row would already name the new actor: the check would pass on evidence the attack itself planted.',
    expectedGate: ['ticket-actor-binding'],
    apply: sub('     OR NEW.actor_id        IS DISTINCT FROM OLD.actor_id\n', ''),
  },
  {
    id: 'K-02',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'invariant 11 — a ticket of another scope is refused',
    change: 'the RLS policies stop equating actor_id with the session',
    breaks:
      'Any member of the organization could present any other member\'s ticket. The ticket id is unguessable, so this is not an attack a stranger mounts — but it is exactly the attack a colleague, a leaked log line or a shared debugging session hands over, and the whole point of binding the actor is that holding the token is not the same as being the person.',
    expectedGate: ['ticket-actor-binding'],
    apply: (sql) => sql.split('  actor_id = auth.uid()\n').join('  true\n'),
  },
  {
    id: 'K-03',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'invariant 2 — the ticket is bound to an organization',
    change: 'the transition trigger stops treating organization_id as immutable',
    breaks:
      'A ticket issued against a cheap tenant could be moved onto another tenant\'s ledger between bind and complete, so the charge lands on an organization that never asked for the work. Every downstream check reads the row as it stands and would agree with the move.',
    expectedGate: ['ticket-scope-binding'],
    apply: sub('     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id\n', ''),
  },
  {
    id: 'K-04',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'invariant 2 — the ticket is bound to a project',
    change: 'the transition trigger stops treating project_id as immutable',
    breaks:
      'The unit would still be charged to the right organization but attributed to the wrong project, so the audit trail says work happened somewhere it did not. In a product whose whole output is an auditable SROI figure, a misattributed unit is worse than an uncharged one.',
    expectedGate: ['ticket-scope-binding'],
    apply: sub('     OR NEW.project_id      IS DISTINCT FROM OLD.project_id\n', ''),
  },
  {
    id: 'K-05',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'invariant 11 — cross-tenant tickets are refused',
    change: 'the trigger stops checking that the project belongs to the organization',
    breaks:
      'A ticket could name organization A and a project of organization B. The RLS policy states the same rule, but RLS does not bind the table owner and this line deliberately does not use FORCE ROW LEVEL SECURITY — so removing the trigger check leaves the invariant enforced for everyone except the one role that can do the most damage.',
    expectedGate: ['ticket-scope-binding'],
    apply: sub(
      '    IF NOT FOUND OR v_project_org IS DISTINCT FROM NEW.organization_id THEN',
      '    IF FALSE THEN',
    ),
  },
  {
    id: 'K-06',
    file: TICKET_FORWARD,
    severity: 'MAJOR',
    clause: 'invariant 3 — the ticket is bound to a governed category',
    change: 'issue_operation_ticket stops comparing the category against its governed array',
    breaks:
      'A ticket could be issued for a capability the ledger\'s own CHECK does not admit. It would look valid all the way to completion and then fail inside consume_stella_quota, after the operation had already run — which converts a refusal that costs nothing into work given away for free.',
    expectedGate: ['ticket-category-vocabulary'],
    apply: sub(
      '  IF p_category IS NULL OR NOT (p_category = ANY(v_governed)) THEN',
      '  IF p_category IS NULL THEN',
    ),
  },
  {
    id: 'K-07',
    file: TICKET_FORWARD,
    severity: 'MAJOR',
    clause: 'invariant 3 — the CHECK and the function agree',
    change: "the category CHECK drops 'grounded_query'",
    breaks:
      'The one capability INT-INT-001 exists to serve could no longer be ticketed at all, while issue_operation_ticket\'s own array still names it. Two lists that can disagree are one list plus a latent bug — the exact failure INT-CAP-001 reported one train earlier, reintroduced one layer up.',
    expectedGate: ['ticket-category-vocabulary'],
    apply: sub(
      "                          'evidence_reviewer', 'audit_assistant', 'grounded_query'));",
      "                          'evidence_reviewer', 'audit_assistant'));",
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* Expiry — the reservation that must release itself                          */
/* -------------------------------------------------------------------------- */

export const EXPIRY_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-08',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'invariant 4 — the ticket expires',
    change: 'the expiry CHECK loses its upper bound',
    breaks:
      'A ticket could be issued with an expiry a century out. Its reservation would count against the organization\'s quota forever, and because there is no cron in this project nothing would ever release it. One abandoned ticket per unit of quota is a denial of service an ordinary crash can cause by accident.',
    expectedGate: ['ticket-expiry-bounded'],
    apply: sub(
      "      CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes');",
      '      CHECK (expires_at > issued_at);',
    ),
  },
  {
    id: 'K-09',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'invariant 4 — the expiry is fixed at issue',
    change: 'the transition trigger stops treating expires_at as immutable',
    breaks:
      'A reservation could be extended indefinitely, one UPDATE at a time, by the one role RLS does not bind. The CHECK still holds — it constrains expires_at against issued_at, and issued_at is immutable — but only until someone extends in steps small enough to stay inside the window, which is every step.',
    expectedGate: ['ticket-expiry-bounded'],
    apply: sub('     OR NEW.expires_at      IS DISTINCT FROM OLD.expires_at THEN', '     THEN'),
  },
  {
    id: 'K-10',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'expiry is part of the liveness predicate, not a job for a sweeper',
    change: 'bind_operation_ticket counts every bound ticket, expired or not',
    breaks:
      'An orphaned reservation would hold its unit until something marked it expired — and nothing does, because this project has no pg_cron and the package says so. A process that dies between bind and complete would permanently remove one unit from the organization\'s monthly quota, with no operator action that restores it short of a manual UPDATE.',
    expectedGate: ['ticket-expiry-liveness'],
    apply: sub("    AND t.expires_at > v_now\n", ''),
  },
  {
    id: 'K-11',
    file: TICKET_FORWARD,
    severity: 'MAJOR',
    clause: 'invariant 12 — no ambiguous state is read as completed',
    change: 'complete_operation_ticket stops refusing an expired ticket',
    breaks:
      'A ticket whose reservation had already been released by time could still be completed, charging against headroom that bind had since handed to somebody else. The organization would spend one unit more than it was sold, and the overspend would be invisible because every individual step looked legal.',
    expectedGate: ['ticket-expiry-liveness'],
    // Anchored on the COMMENT that only complete_operation_ticket carries.
    // bind_operation_ticket contains the same three lines of code, appears
    // first in the file, and `String.replace` takes the first match — so an
    // anchor written on the code alone mutates bind and leaves complete intact,
    // testing a property this entry does not claim to test.
    apply: sub(
      '  IF v_expires <= v_now THEN\n    -- The reservation was already released by time.',
      '  IF FALSE THEN\n    -- The reservation was already released by time.',
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* Identity — the digest, and the key the caller must not choose              */
/* -------------------------------------------------------------------------- */

export const IDENTITY_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-12',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'invariant 5 — the query digest is fixed exactly once',
    change: 'the transition trigger permits the query digest to be rewritten',
    breaks:
      'One ticket could be bound to a cheap question, completed, and then rewritten onto a second question — or bound and rewritten before completion. Either way one paid unit does two pieces of work, which is the reuse the protocol exists to make impossible.',
    expectedGate: ['ticket-hash-write-once'],
    apply: sub(
      '  IF OLD.query_hash IS NOT NULL AND NEW.query_hash IS DISTINCT FROM OLD.query_hash THEN',
      '  IF FALSE THEN',
    ),
  },
  {
    id: 'K-13',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'invariant 6 — the same ticket cannot carry another query',
    change: 'bind_operation_ticket accepts a second, different digest',
    breaks:
      'A caller could bind a ticket to question A, get a reservation, then rebind the same ticket to question B and run that instead. The trigger still refuses the UPDATE — but the function would have reported success first, so the caller would proceed on a promise the database is about to break, and the failure would surface as a mysterious error after the work was done.',
    expectedGate: ['ticket-hash-write-once'],
    apply: sub(
      '  IF v_hash IS NOT NULL AND v_hash <> p_query_hash THEN',
      '  IF FALSE THEN',
    ),
  },
  {
    id: 'K-14',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 5 — the caller cannot choose the key consume_stella_quota charges under',
    change: 'complete_operation_ticket takes the idempotency key as an argument',
    breaks:
      'This is the candidate INT-INT-001 rules out by name: a key chosen by the client is a discount chosen by the client. Resending a previous key makes the charge a no-op, so every operation after the first is free; sending a fresh key on a retry charges twice. Both directions are reachable from the browser.',
    expectedGate: ['ticket-derived-idempotency-key'],
    apply: sub(
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.complete_operation_ticket(\n  p_ticket_id char(64),\n  p_query_hash char(64)\n)',
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.complete_operation_ticket(\n  p_ticket_id char(64),\n  p_query_hash char(64),\n  p_idempotency_key char(64)\n)',
    ),
  },
  {
    id: 'K-15',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 5 — the key is not derivable from the ticket alone',
    change: 'the charge key is derived from the ticket id without the server-minted nonce',
    breaks:
      'Anyone holding the ticket could compute the key and call consume_stella_quota directly, charging outside the protocol and leaving a ledger row no ticket accounts for. Worse in the other direction: they could pre-charge the key so that the eventual complete returns `replayed` on an operation the protocol never authorised.',
    expectedGate: ['ticket-derived-idempotency-key'],
    apply: sub(
      "      'stella/ticket/charge/v1' || chr(10) || p_ticket_id || chr(10) || v_nonce,",
      "      'stella/ticket/charge/v1' || chr(10) || p_ticket_id,",
    ),
  },
  {
    id: 'K-16',
    file: TICKET_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 5 — the digest must be recomputable by the retry',
    change: 'bind_operation_ticket stops checking the shape of the query digest',
    breaks:
      'Any string could be fixed onto a ticket as its query identity — including the empty string, or a value that varies per invocation. A digest a retry cannot recompute is not an identity, so the retry would be refused as a different question and be charged again under a fresh ticket.',
    expectedGate: ['ticket-hash-shape'],
    apply: sub(
      "  IF p_query_hash IS NULL OR p_query_hash !~ '^[0-9a-f]{64}$' THEN\n    RAISE EXCEPTION 'stella ticket: the query digest must be a lowercase-hex SHA-256' USING ERRCODE = 'U0100';\n  END IF;\n\n  v_actor := auth.uid();\n  IF v_actor IS NULL THEN\n    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';\n  END IF;\n\n  -- The row lock, FIRST in the lock order.",
      "  v_actor := auth.uid();\n  IF v_actor IS NULL THEN\n    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';\n  END IF;\n\n  -- The row lock, FIRST in the lock order.",
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* The charge — exactly once, and never for work that failed                  */
/* -------------------------------------------------------------------------- */

export const CHARGE_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-17',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'invariant 9 — a completed ticket does not charge again',
    change: 'complete_operation_ticket stops short-circuiting an already-completed ticket',
    breaks:
      'A retry would fall through to the charge. The ledger index still deduplicates on the derived key, so consume_stella_quota would answer `replayed` — but the mutation removes the LAST place that fact is stated in the ticket layer, so the day the key derivation changes shape, or the ledger index is dropped, the retry charges twice with nothing left objecting. That is the whole of INT-INT-001.',
    expectedGate: ['ticket-charge-once'],
    apply: sub(
      "  IF v_status = 'completed' THEN\n    RETURN QUERY SELECT 'replayed'::text, NULL::integer, NULL::integer;\n    RETURN;\n  END IF;",
      '',
    ),
  },
  {
    id: 'K-18',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'the settle and the charge are atomic with each other',
    change: 'the ticket is settled regardless of what the charge returned',
    breaks:
      'A ticket refused by the quota would be marked completed anyway. The organization gets the work, the ledger never records it, and the ticket says it paid — so no later reconciliation can find the gap, because every artefact agrees on a charge that never happened.',
    expectedGate: ['ticket-charge-once'],
    apply: sub(
      "  IF v_charge.outcome IN ('consumed', 'replayed') THEN",
      '  IF TRUE THEN',
    ),
  },
  {
    id: 'K-19',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'the charge goes through the governed path, never around it',
    change: 'complete_operation_ticket writes the ledger directly instead of calling consume_stella_quota',
    breaks:
      'Every check consume_stella_quota performs — the organization boundary, the project/organization consistency, the advisory lock, the ON CONFLICT that makes the retry free — would be skipped. The ticket layer would be re-implementing the quota with none of its guarantees, and the two would drift the first time either changed.',
    expectedGate: ['ticket-charge-once'],
    apply: sub(
      '  SELECT c.outcome, c.used, c.quota INTO v_charge\n  FROM uellix_stella.consume_stella_quota(v_org, v_project, v_category, v_key) c;',
      "  INSERT INTO public.stella_interactions (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json, model_used, idempotency_key)\n  VALUES (v_org, v_project, v_actor, v_category, v_category, v_key, '{}'::jsonb, 'not-applicable', v_key);\n  v_charge := ROW('consumed', 0, 0);",
    ),
  },
  {
    id: 'K-20',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'invariant 10 — an aborted ticket is not a charged one',
    change: 'abort_operation_ticket accepts a ticket that has already been completed',
    breaks:
      'Abort would become a refund path the money never took. The ledger row is append-only and stays; the ticket would say `aborted`, so the reservation accounting and the charge accounting would disagree permanently — and the ticket, being the only record of which operation paid, would now deny an operation that did.',
    expectedGate: ['ticket-abort-releases'],
    apply: sub(
      "  IF v_status = 'completed' THEN\n    RAISE EXCEPTION 'stella ticket: a completed operation cannot be aborted' USING ERRCODE = 'U0109';\n  END IF;",
      '',
    ),
  },
  {
    id: 'K-21',
    file: TICKET_FORWARD,
    severity: 'MAJOR',
    clause: 'no silent compensation — an abort is recorded as an abort',
    change: 'abort_operation_ticket deletes the ticket instead of marking it aborted',
    breaks:
      'A released reservation would become indistinguishable from one that never happened. Nothing would show that an operation was attempted and failed, which is the fact an operator needs when an organization asks why its quota moved — and the DELETE would also be the removal path the protocol deliberately does not have.',
    expectedGate: ['ticket-abort-releases'],
    apply: sub(
      "  UPDATE uellix_stella_ops.operation_tickets t\n  SET status = 'aborted', aborted_at = v_now, abort_reason = p_reason\n  WHERE t.ticket_id = p_ticket_id;",
      '  DELETE FROM uellix_stella_ops.operation_tickets t\n  WHERE t.ticket_id = p_ticket_id;',
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* Concurrency                                                                 */
/* -------------------------------------------------------------------------- */

export const CONCURRENCY_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-22',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 3 B — no overconsumption under concurrency',
    change: 'bind_operation_ticket takes no advisory lock',
    breaks:
      'Two concurrent binds would both read the same headroom and both reserve. The observable effect is the read-then-write race INT-CAP-001 reported, moved one layer up and made harder to see: each individual charge afterwards passes consume_stella_quota\'s own check, because by then the reservations have already been converted one at a time.',
    expectedGate: ['ticket-advisory-lock'],
    apply: sub(
      "  PERFORM pg_catalog.pg_advisory_xact_lock(\n    pg_catalog.hashtextextended('stella/quota/' || v_org::text, 0));",
      '',
    ),
  },
  {
    id: 'K-23',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'the reservation and the charge share ONE mutex',
    change: 'bind_operation_ticket locks on a namespace of its own',
    breaks:
      'Two different keys are two different mutexes. Reservations would serialise against each other and charges against each other, but a reservation could still read the ledger in the middle of a charge that had not committed — so the headroom check would race exactly the operation it exists to constrain, while looking fully locked.',
    expectedGate: ['ticket-advisory-lock'],
    apply: sub(
      "    pg_catalog.hashtextextended('stella/quota/' || v_org::text, 0));",
      "    pg_catalog.hashtextextended('stella/ticket/' || v_org::text, 0));",
    ),
  },
  {
    id: 'K-24',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'the ticket row is locked before anything is decided about it',
    change: 'bind_operation_ticket reads the ticket without FOR UPDATE',
    breaks:
      'Two sessions could bind the same ticket at once: both would see status `issued`, both would pass the digest check, and both would take a reservation on one ticket. The advisory lock does not help — it serialises them, but each still reads its own pre-lock snapshot of the row.',
    expectedGate: ['ticket-advisory-lock'],
    apply: sub(
      '  FROM uellix_stella_ops.operation_tickets t\n  WHERE t.ticket_id = p_ticket_id\n  FOR UPDATE;\n\n  -- Absent, another actor',
      '  FROM uellix_stella_ops.operation_tickets t\n  WHERE t.ticket_id = p_ticket_id;\n\n  -- Absent, another actor',
    ),
  },
  {
    id: 'K-25',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 3 B — the headroom counts reservations, not only charges',
    change: 'bind_operation_ticket compares only the charged rows against the cap',
    breaks:
      'Every concurrent bind would be handed the same last unit, because a reservation is invisible until it is charged. The lock would serialise them and each would still see the same count — a mutex around a computation that ignores the thing being contended is a mutex that protects nothing.',
    expectedGate: ['ticket-reservation'],
    apply: sub('    IF v_used + v_reserved >= v_quota THEN', '    IF v_used >= v_quota THEN'),
  },
]

/* -------------------------------------------------------------------------- */
/* Privilege, payload and error surface                                        */
/* -------------------------------------------------------------------------- */

export const PRIVILEGE_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-26',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'the charge nonce is unreadable outside the definer',
    change: 'the runtime role is granted SELECT on the ticket table',
    breaks:
      'uellix_app could read charge_nonce, compute the idempotency key for any ticket it holds, and charge — or pre-charge — outside the protocol. The nonce is the only reason the key is not derivable from the ticket, so a read grant on this table dissolves the whole of FASE 5.',
    expectedGate: ['ticket-write-grant'],
    apply: sub(
      'GRANT SELECT, INSERT, UPDATE ON TABLE uellix_stella_ops.operation_tickets TO uellix_cap_stella_ticket;',
      'GRANT SELECT, INSERT, UPDATE ON TABLE uellix_stella_ops.operation_tickets TO uellix_cap_stella_ticket;\nGRANT SELECT ON TABLE uellix_stella_ops.operation_tickets TO uellix_app;',
    ),
  },
  {
    id: 'K-27',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'the ticket role reaches the ledger only by calling consume_stella_quota',
    change: 'the ticket role is granted INSERT on the ledger',
    breaks:
      'The privilege separation is what makes "the only way to charge is the governed function" a fact rather than a claim about a function body. With INSERT in hand, any future edit to a ticket function could file a charge directly, skipping the organization boundary, the advisory lock and the conflict clause that makes a retry free.',
    expectedGate: ['ticket-write-grant'],
    apply: sub(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM uellix_cap_stella_ticket;',
      'GRANT INSERT ON public.stella_interactions TO uellix_cap_stella_ticket;',
    ),
  },
  {
    id: 'K-28',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'no EXECUTE for PUBLIC',
    change: 'the REVOKE ALL ... FROM PUBLIC on complete_operation_ticket is dropped',
    breaks:
      'EXECUTE on a new function is granted to PUBLIC by default, so removing the revoke does not merely fail to narrow the ACL — it leaves the settle-and-charge entry point callable by every role in the cluster, including anon. The definer\'s own scope checks would still refuse a caller with no session, but the surface would be open to any authenticated principal at all.',
    expectedGate: ['ticket-definer-acl'],
    apply: sub(
      'REVOKE ALL ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), char(64)) FROM PUBLIC;\n',
      '',
    ),
  },
  {
    id: 'K-29',
    file: TICKET_FORWARD,
    severity: 'MAJOR',
    clause: 'no payload is persisted',
    change: 'a free-text column is added to the ticket table',
    breaks:
      'The prohibition on persisting the query is the one property of this package that is about DATA rather than about correctness, and a single text column reopens it. A note column is exactly where a developer under time pressure puts the query, because it is the most useful thing to put there.',
    expectedGate: ['ticket-no-payload'],
    apply: sub(
      '  abort_reason    varchar(40)\n);',
      '  abort_reason    varchar(40),\n  note            text\n);',
    ),
  },
  {
    id: 'K-30',
    file: TICKET_FORWARD,
    severity: 'MAJOR',
    clause: 'an abort reason is a code, never a sentence',
    change: 'abort_operation_ticket stops checking the reason against its closed vocabulary',
    breaks:
      'The reason column is varchar(40) and would happily take a fragment of the failing query, an error message from the model, or a user identifier. "Why it failed" is a payload, and it would sit in a table that outlives the request, in a package whose stated contract is that no payload is persisted.',
    expectedGate: ['ticket-no-payload'],
    apply: sub(
      '  IF p_reason IS NULL OR NOT (p_reason = ANY(v_reasons)) THEN',
      '  IF p_reason IS NULL THEN',
    ),
  },
  {
    id: 'K-31',
    file: TICKET_FORWARD,
    severity: 'MAJOR',
    clause: 'an error message is not an oracle',
    change: 'the not-found error interpolates the ticket the caller supplied',
    breaks:
      'A refusal that echoes its argument tells an untrusted caller which of its guesses reached a row. Ticket ids are 256 bits wide, so this is not a practical enumeration — but the same message shape is reused for the organization and the project checks, where the identifiers are uuids the caller often already holds, and there the echo distinguishes "no such tenant" from "not yours".',
    expectedGate: ['ticket-error-detail'],
    apply: sub(
      "    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';\n  END IF;\n\n  -- The row lock, FIRST in the lock order.",
      "    RAISE EXCEPTION 'stella ticket: ticket % not found', p_ticket_id USING ERRCODE = 'U0102';\n  END IF;\n\n  -- The row lock, FIRST in the lock order.",
    ),
  },
  {
    id: 'K-32',
    file: TICKET_FORWARD,
    severity: 'MAJOR',
    clause: 'the invariants must bind the owner, whom RLS does not',
    change: 'the transition trigger is left ENABLE by default rather than ENABLE ALWAYS',
    breaks:
      'A session that sets session_replication_role = replica would silence the entire state machine, and every attack the trigger refuses — a ticket declared completed, a rewritten digest, a moved organization, a deleted charged ticket — would succeed. The CHECK constraints survive; the transitions do not.',
    expectedGate: ['ticket-trigger-always'],
    apply: sub(
      'ALTER TABLE uellix_stella_ops.operation_tickets ENABLE ALWAYS TRIGGER trg_operation_tickets_transition;\n',
      '',
    ),
  },
  {
    id: 'K-33',
    file: TICKET_FORWARD,
    severity: 'CRITICAL',
    clause: 'a schema of its own, so stella_0013 keeps its exact assertion',
    change: 'issue_operation_ticket is published into stella_0013\'s schema',
    breaks:
      'stella_0013 asserts, over its WHOLE schema, that every function there is owned by uellix_cap_stella_quota. One function of this package placed there makes stella_0013 abort on its SECOND apply, so the forward chain stops being idempotent — which is the property the dry run exists to measure, and it fails silently in the sense that the FIRST apply of both packages still succeeds.',
    expectedGate: ['ticket-schema-isolation'],
    apply: sub(
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.issue_operation_ticket(',
      'CREATE OR REPLACE FUNCTION uellix_stella.issue_operation_ticket(',
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* The rollback                                                                */
/* -------------------------------------------------------------------------- */

export const ROLLBACK_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-34',
    file: TICKET_ROLLBACK,
    severity: 'CRITICAL',
    clause: 'the rollback refuses on settled operations',
    change: 'the refusal on completed tickets is removed',
    breaks:
      'Uninstalling the protocol would drop the only record of which operation each charged, append-only ledger row paid for. Their idempotency keys become unrecoverable, so a retry arriving afterwards is issued a NEW ticket and charged a SECOND time — the rollback would reintroduce the exact defect the package closes, and would do it on the databases that had used it most.',
    expectedGate: ['ticket-rollback-refuses-settled'],
    apply: sub("    WHERE t.status = 'completed';", '    WHERE FALSE;'),
  },
  {
    id: 'K-35',
    file: TICKET_ROLLBACK,
    severity: 'CRITICAL',
    clause: 'the rollback converges',
    change: 'complete_operation_ticket is never dropped',
    breaks:
      'A callable SECURITY DEFINER function would survive a rollback that reports success — and because it is owned by uellix_cap_stella_ticket, the DROP ROLE further down would fail forever after. That is INT-CAP-004 (1) exactly: the defect grounding_0003_rollback shipped, one train earlier.',
    expectedGate: ['ticket-rollback-convergence'],
    apply: sub(
      "  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.complete_operation_ticket(character, character)';\n",
      '',
    ),
  },
  {
    id: 'K-36',
    file: TICKET_ROLLBACK,
    severity: 'MAJOR',
    clause: 'the rollback converges',
    change: 'the package schema is never dropped',
    breaks:
      'An empty schema would survive every rollback, so "returns exactly to the baseline" would be false and the dry run\'s state comparison would have to be loosened to keep passing — which is how a harness stops measuring the thing it was written for.',
    expectedGate: ['ticket-rollback-convergence'],
    apply: sub("      EXECUTE 'DROP SCHEMA uellix_stella_ops';", '      NULL;'),
  },
  {
    id: 'K-37',
    file: TICKET_ROLLBACK,
    severity: 'CRITICAL',
    clause: 'INT-CAP-004 (1) — a function drop never depends on a table',
    change: 'the DROP FUNCTIONs are nested inside the table-existence test',
    breaks:
      'A database whose ticket table had gone by another route would get a rollback that exits 0 and leaves six callable SECURITY DEFINER functions behind, each still able to reach consume_stella_quota. This is the precise shape of the defect INT-CAP-004 reported, and it passed review there because the nesting reads as caution.',
    expectedGate: ['ticket-rollback-function-drop-unconditional'],
    apply: sub(
      "  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.issue_operation_ticket(uuid, uuid, character varying)';",
      "  IF tbl_oid IS NOT NULL THEN\n    EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.issue_operation_ticket(uuid, uuid, character varying)';\n  END IF;",
    ),
  },
  {
    id: 'K-38',
    file: TICKET_ROLLBACK,
    severity: 'CRITICAL',
    clause: 'the rollback removes nothing that belongs to another package',
    change: "the rollback drops stella_0013's governed function",
    breaks:
      'Rolling back the ticket protocol would silently uninstall the quota consumption path underneath it, so an operator who wanted to undo one change would undo two — and the second one is the package that five other Stella capabilities count rows against.',
    expectedGate: ['ticket-rollback-scope'],
    apply: sub(
      "  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.expire_operation_tickets(integer)';",
      "  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.expire_operation_tickets(integer)';\n  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)';",
    ),
  },
  {
    id: 'K-39',
    file: TICKET_ROLLBACK,
    severity: 'MAJOR',
    clause: 'the blast radius is stated, not inherited',
    change: 'the table is dropped with CASCADE',
    breaks:
      'What the rollback destroys would depend on what somebody attached to the table later rather than on what the script says. A rollback nobody can read by reading it is a rollback nobody can approve.',
    expectedGate: ['ticket-rollback-no-cascade'],
    apply: sub(
      "    EXECUTE 'DROP TABLE uellix_stella_ops.operation_tickets';",
      "    EXECUTE 'DROP TABLE uellix_stella_ops.operation_tickets CASCADE';",
    ),
  },
]

export const MUTATIONS: readonly Mutation[] = [
  ...BINDING_MUTATIONS,
  ...EXPIRY_MUTATIONS,
  ...IDENTITY_MUTATIONS,
  ...CHARGE_MUTATIONS,
  ...CONCURRENCY_MUTATIONS,
  ...PRIVILEGE_MUTATIONS,
  ...ROLLBACK_MUTATIONS,
]
