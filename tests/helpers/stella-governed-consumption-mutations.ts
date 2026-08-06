// tests/helpers/stella-governed-consumption-mutations.ts
//
// The catalogue of deliberate breakages for the governed-consumption package
// (stella_0017, R6-INT and the residual of R1).
//
// Each entry names ONE property of the closure, the edit that removes it, and
// the gate in tests/helpers/stella-governed-consumption-gates.ts that must
// refuse the result. tests/stella-governed-consumption-mutation.test.ts applies
// them to an in-memory copy — nothing here writes to db/prepared.
//
// The three rules carry over from tests/helpers/stella-reserved-quota-mutations.ts,
// and they are what make the count mean anything:
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
// IDS. K-86 onwards, continuing the stella_0014, stella_0015 and stella_0016
// catalogues rather than restarting — the mutation suite asserts the four sets
// are disjoint, so "K-54" can only ever mean one thing.

import { GOVERNED_FORWARD, GOVERNED_ROLLBACK } from './stella-governed-consumption-gates'

export interface Mutation {
  readonly id: string
  readonly file: string
  readonly severity: 'CRITICAL' | 'MAJOR' | 'MINOR'
  /** The clause of the train-4.3b brief the property comes from. */
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

/**
 * Replace EVERY occurrence.
 *
 * Needed where the property is stated in more than one place on purpose — the
 * membership-following privilege question is asked twice in stella_0017 §5, once
 * over a named list of principals and once exhaustively over pg_roles. A mutation
 * that removed only the first would leave the second standing, the gate would
 * fire on it, and the mutant would look dead while the property it names is half
 * gone. Removing both is what "the verification stopped following membership"
 * actually means.
 */
const subAll = (from: string, to: string) => (sql: string) => sql.split(from).join(to)

/* -------------------------------------------------------------------------- */
/* (1) The direct write                                                       */
/* -------------------------------------------------------------------------- */

export const DIRECT_WRITE_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-86',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 3 — retirar de los roles runtime toda capacidad de INSERT directo',
    change: 'the REVOKE against uellix_writer is removed',
    breaks:
      'This is R6-INT restored in one line, and on stella_0016 it composes into a measured oversell: a live reservation holds the last unit, a sibling files it with an unlocked INSERT, and the conversion — which evaluates no limit, deliberately — settles anyway. Consumed = 2 against Limit = 1. Every other statement of the package still reads as a closure.',
    expectedGate: ['governed-direct-insert-revoked'],
    apply: sub(
      "    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM uellix_writer';",
      "    PERFORM 1;",
    ),
  },
  {
    id: 'K-87',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 3 — cubrir privilegios directos, heredados y por roles intermedios',
    change: 'the self-verification reads relacl instead of asking has_table_privilege',
    breaks:
      'The defect is INHERITED. uellix_app holds ZERO entries in the ledger relacl and can INSERT regardless, because GRANT uellix_writer TO uellix_app carries INHERIT TRUE. A verification written over aclexplode reports the table clean while every runtime session keeps writing — so the package would CERTIFY the hole it was published to close.',
    expectedGate: ['governed-inherited-privilege'],
    apply: subAll(
      'has_table_privilege(r.oid, tbl_oid, p.priv)',
      "EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a WHERE c.oid = tbl_oid AND a.grantee = r.oid AND a.privilege_type = p.priv)",
    ),
  },
  {
    id: 'K-88',
    file: GOVERNED_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 9 — INSERT directo como authenticated',
    change: 'authenticated keeps its write privileges',
    breaks:
      'authenticated holds no INSERT today — stella_0005c revoked it — but stella_0005c_rollback.sql GRANTs it back BY NAME, and a baseline restore re-grants it too. A closure that only revokes what is currently held is a closure with a documented way to undo it that nobody re-checks. The row would then be filed by the browser-facing role, with no reservation and no identity.',
    expectedGate: ['governed-runtime-principals'],
    apply: sub(
      "    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions FROM authenticated';",
      "    PERFORM 1;",
    ),
  },
  {
    id: 'K-89',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 3 — ausencia de privilege debe ser parte del contrato',
    change: 'the governed-identity CHECK is never added',
    breaks:
      'The REVOKE is the barrier a GRANT can undo. Without the CHECK, the table OWNER — and anybody who regains INSERT by a baseline restore or by stella_0005c_rollback — can file a unit with no operation identity, which is a unit no reservation ever counted and no retry can be told apart from a new operation.',
    expectedGate: ['governed-identity-check'],
    apply: sub(
      '    ALTER TABLE public.stella_interactions\n      ADD CONSTRAINT stella_interactions_governed_identity_check\n      CHECK (idempotency_key IS NOT NULL) NOT VALID;',
      '    PERFORM 1;',
    ),
  },
  {
    id: 'K-90',
    file: GOVERNED_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 3 — el paquete debe converger',
    change: 'the governed-identity CHECK is added VALIDATED',
    breaks:
      'Every row filed before this package was filed by the direct path and carries no key. A validated constraint therefore fails on apply against any database with history — or, worse, succeeds on one where somebody deleted rows from an append-only compliance trail to make it pass. The package must decline to make a claim about the past.',
    expectedGate: ['governed-identity-check-not-valid'],
    apply: sub(
      'CHECK (idempotency_key IS NOT NULL) NOT VALID;',
      'CHECK (idempotency_key IS NOT NULL);',
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* (2) What the sibling verb may and may not decide                           */
/* -------------------------------------------------------------------------- */

export const SIBLING_VERB_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-91',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 5 — no permitas que el cliente elija libremente la categoría efectiva',
    change: 'the sibling verb charges a category the caller supplies',
    breaks:
      'The category is what the ticket IS: it is welded at issue, the transition trigger refuses an UPDATE that changes it, and the conversion refuses (U0111) unless it matches. Reading it from an argument makes the ticket a bearer token for any capability the caller names — an advisor ticket completed as audit_assistant, filed under the wrong role in a ledger a client reads back as an audit trail.',
    expectedGate: ['governed-category-validated'],
    apply: sub(
      '  SELECT c.outcome, c.used, c.quota INTO v_charge\n  FROM uellix_stella.settle_reserved_quota(\n    v_org, v_project, v_category, v_key, p_ticket_id,',
      '  SELECT c.outcome, c.used, c.quota INTO v_charge\n  FROM uellix_stella.settle_reserved_quota(\n    v_org, v_project, p_pipeline_step::varchar(50), v_key, p_ticket_id,',
    ),
  },
  {
    id: 'K-92',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 6 — revalidar actor',
    change: 'the sibling verb stops deriving the actor from the session',
    breaks:
      'auth.uid() is what makes created_by unforgeable and what the RLS policies on both tables compare against. With the derivation gone the function proceeds for a session with no identity at all, and the row it files names an actor nobody authenticated.',
    expectedGate: ['governed-actor-derived'],
    apply: sub(
      "  v_actor := auth.uid();\n  IF v_actor IS NULL THEN\n    RAISE EXCEPTION 'stella ticket: ticket not found' USING ERRCODE = 'U0102';\n  END IF;\n\n  -- The row lock, FIRST in the lock order and held for the whole conversion.",
      '  -- The row lock, FIRST in the lock order and held for the whole conversion.',
    ),
  },
  {
    id: 'K-93',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 6 — revalidar proyecto (R2-INT)',
    change: 'the sibling verb stops comparing the ticket project against the execution project',
    breaks:
      'bind committed in an earlier transaction, and only complete charges. Without the comparison a ticket minted on one project surface can be presented to the action mounted on another, and the unit is filed under the project of the TICKET while the work read its evidence under the project of the ACTION. R2-INT, reopened for five more categories.',
    expectedGate: ['governed-project-proved'],
    apply: sub(
      "  -- R2-INT, checked BEFORE the replay short-circuit. A completed ticket\n  -- presented from another project must not be answered `replayed`.\n  IF v_project IS DISTINCT FROM p_expected_project_id THEN\n    RAISE EXCEPTION 'stella ticket: the ticket belongs to a different project' USING ERRCODE = 'U0110';\n  END IF;\n\n  IF v_hash IS NULL THEN",
      '  IF v_hash IS NULL THEN',
    ),
  },
  {
    id: 'K-94',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 6 — reutilizar el mismo ticket en retry',
    change: 'the sibling verb no longer replays a completed ticket',
    breaks:
      'A retried server action presents the same ticket. With the short circuit gone the function falls through to the status checks, and a completed ticket is neither bound nor settled-with-a-code — so the retry either raises where it should report, or reaches the conversion and asks it to file a second row. The unique index catches the second row, but the caller is told the operation failed after it succeeded.',
    expectedGate: ['governed-retry-same-ticket'],
    apply: sub(
      "  IF v_status = 'completed' THEN\n    RETURN QUERY SELECT 'replayed'::text, NULL::integer, NULL::integer;\n    RETURN;\n  END IF;\n\n  IF v_status IN ('aborted', 'expired') THEN\n    RAISE EXCEPTION 'stella ticket: the ticket is already settled' USING ERRCODE = 'U0109';\n  END IF;\n\n  IF v_status <> 'bound' THEN",
      "  IF v_status IN ('aborted', 'expired') THEN\n    RAISE EXCEPTION 'stella ticket: the ticket is already settled' USING ERRCODE = 'U0109';\n  END IF;\n\n  IF v_status <> 'bound' THEN",
    ),
  },
  {
    id: 'K-95',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'PROHIBICIONES — no derives idempotencia del contenido de la solicitud',
    change: 'the idempotency key is derived from the query digest and the payload',
    breaks:
      'A key computed from what the caller sent draws the wrong distinction in BOTH directions. Two legitimately identical operations — the same question asked twice, which is what a user does when the answer was useful — collapse onto one key, and the second is free. And a retry whose non-deterministic model returned a different body computes a DIFFERENT key, so the same operation is charged twice. That is the exact failure INT-INT-001 catalogued and the reason the nonce exists.',
    expectedGate: ['governed-key-from-ticket'],
    apply: sub(
      "      'stella/ticket/charge/v1' || chr(10) || p_ticket_id || chr(10) || v_nonce,",
      "      'stella/ticket/charge/v1' || chr(10) || p_query_hash || chr(10) || p_response_json::text,",
    ),
  },
  {
    id: 'K-96',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 6 — usar ticket nuevo para una operación nueva',
    change: 'the ticket id leaves the key preimage, so every ticket of one nonce shape collides',
    breaks:
      'The ticket id is the ONLY component of the preimage that varies per operation. Take it out and two tickets whose nonces happen to be handled by the same code path derive the same key, the unique index refuses the second insert, the conversion reports `replayed`, and a brand-new operation is given away as a duplicate of one that already ran.',
    expectedGate: ['governed-new-operation-charges', 'governed-key-from-ticket'],
    apply: sub(
      "      'stella/ticket/charge/v1' || chr(10) || p_ticket_id || chr(10) || v_nonce,",
      "      'stella/ticket/charge/v1' || chr(10) || v_nonce,",
    ),
  },
  {
    id: 'K-97',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 7 — ninguna operación puede robar una unidad reservada',
    change: 'the sibling verb charges through consume_stella_quota instead of the conversion',
    breaks:
      'consume_stella_quota evaluates the limit against CHARGED ROWS ONLY. A sibling completing through it re-enters the competition its own bind already settled: a grounded reservation taken meanwhile is invisible to it, and its own reservation is counted by nobody. This is R1 with a new caller, and it is the shape the package exists to make unreachable.',
    expectedGate: ['governed-conversion-surface'],
    apply: sub(
      '  SELECT c.outcome, c.used, c.quota INTO v_charge\n  FROM uellix_stella.settle_reserved_quota(\n    v_org, v_project, v_category, v_key, p_ticket_id,\n    p_pipeline_step, v_hash, p_model_used, p_tokens_used, p_response_json) c;',
      '  SELECT c.outcome, c.used, c.quota INTO v_charge\n  FROM uellix_stella.consume_stella_quota(v_org, v_project, v_category, v_key) c;',
    ),
  },
  {
    id: 'K-98',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'PROHIBICIONES — no conserves una ruta de INSERT directo',
    change: 'the sibling verb files the ledger row itself',
    breaks:
      'It runs as uellix_cap_stella_ticket, which holds no INSERT — but a package that wrote this would also have had to grant it, and then the ticket definer could file a unit with no reservation proof, no advisory lock and no capacity arithmetic. The whole point of the two-role split is that the verb that settles a ticket cannot be the verb that writes the ledger.',
    expectedGate: ['governed-ledger-single-writer'],
    apply: sub(
      '  SELECT c.outcome, c.used, c.quota INTO v_charge\n  FROM uellix_stella.settle_reserved_quota(\n    v_org, v_project, v_category, v_key, p_ticket_id,\n    p_pipeline_step, v_hash, p_model_used, p_tokens_used, p_response_json) c;',
      "  INSERT INTO public.stella_interactions (organization_id, project_id, created_by, stella_role, pipeline_step, context_hash, response_json, model_used, tokens_used, idempotency_key)\n  VALUES (v_org, v_project, v_actor, v_category, p_pipeline_step, v_hash, p_response_json, p_model_used, p_tokens_used, v_key);\n  SELECT 'consumed'::text AS outcome, NULL::integer AS used, NULL::integer AS quota INTO v_charge;",
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* (3) The conversion, and the surfaces around it                             */
/* -------------------------------------------------------------------------- */

export const CONVERSION_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-99',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 7 — complete convierte la reserva sin competir nuevamente',
    change: 'the conversion evaluates the limit before filing',
    breaks:
      'The unit was committed at bind and has been counted against the cap ever since. Testing it again counts one commitment twice: the reservation while the work ran, and the charge when it lands. Whichever operation asks second loses a unit it had already set aside, and the executed work is given away — R1 as originally reported, restored inside the very function that closed it.',
    expectedGate: ['governed-conversion-does-not-compete'],
    apply: sub(
      "  IF v_existing IS NOT NULL THEN\n    RETURN QUERY SELECT 'replayed'::text, v_cap.consumed, v_cap.limit_units;\n    RETURN;\n  END IF;\n\n  -- THE PAYLOAD, resolved.",
      "  IF v_existing IS NOT NULL THEN\n    RETURN QUERY SELECT 'replayed'::text, v_cap.consumed, v_cap.limit_units;\n    RETURN;\n  END IF;\n\n  IF v_cap.available <= 0 THEN\n    RETURN QUERY SELECT 'quota_exceeded'::text, v_cap.consumed, v_cap.limit_units;\n    RETURN;\n  END IF;\n\n  -- THE PAYLOAD, resolved.",
    ),
  },
  {
    id: 'K-100',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 7 — abort y expire liberan; FASE 9 — abort deja cargo',
    change: 'the conversion no longer requires the ticket to be BOUND and unexpired',
    breaks:
      'An abort releases a reservation and files nothing — that is what makes "the work failed" cost nothing. With the state test gone, an aborted ticket can still be converted, so an abort stops meaning anything and a unit is charged for an operation the caller was told had been abandoned. The expiry half is worse: the released unit may already have been handed to somebody else, and filing now is the oversell this package exists to prevent.',
    expectedGate: ['governed-settled-ticket-refused'],
    apply: sub(
      "     OR v_category IS DISTINCT FROM p_stella_role\n     OR v_status   IS DISTINCT FROM 'bound' THEN\n    RAISE EXCEPTION 'stella settle: the reservation is not live' USING ERRCODE = 'U0111';\n  END IF;\n\n  v_now := pg_catalog.timezone('UTC', pg_catalog.now());\n  IF v_expires <= v_now THEN\n    RAISE EXCEPTION 'stella settle: the reservation is not live' USING ERRCODE = 'U0111';\n  END IF;",
      "     OR v_category IS DISTINCT FROM p_stella_role THEN\n    RAISE EXCEPTION 'stella settle: the reservation is not live' USING ERRCODE = 'U0111';\n  END IF;\n\n  v_now := pg_catalog.timezone('UTC', pg_catalog.now());",
    ),
  },
  {
    id: 'K-101',
    file: GOVERNED_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 9 — organización no validada',
    change: 'the conversion takes its caller\'s word for the organization',
    breaks:
      'It is granted only to the ticket definer, so "the caller is trusted" is nearly true — and nearly is the problem. The conversion is the last place the organization being CHARGED is compared against the organization the ticket was WELDED to, and it exists precisely so a future edit to a ticket verb cannot move a charge across tenants without something noticing. A defence that only holds while its single caller is correct is a defence that holds until the day it matters.',
    expectedGate: ['governed-organization-proved'],
    apply: sub(
      "  IF NOT FOUND\n     OR v_org      IS DISTINCT FROM p_organization_id\n     OR v_project  IS DISTINCT FROM p_project_id",
      '  IF NOT FOUND\n     OR v_project  IS DISTINCT FROM p_project_id',
    ),
  },
  {
    id: 'K-102',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 9 — PUBLIC EXECUTE; el grant ES la propiedad de seguridad',
    change: 'the payload-carrying conversion is granted to the runtime role',
    breaks:
      'It files a unit WITHOUT evaluating the limit. A runtime principal holding EXECUTE can charge past the cap for any ticket it can name — and the ticket id is the only thing it needs, which is a value its own issue call returns. The reservation arithmetic stays exact and stops constraining anything.',
    expectedGate: ['governed-conversion-grant'],
    apply: sub(
      'GRANT EXECUTE ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64), varchar(100), char(64), varchar(100), integer, jsonb)\n  TO uellix_cap_stella_ticket;',
      'GRANT EXECUTE ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64), varchar(100), char(64), varchar(100), integer, jsonb)\n  TO uellix_cap_stella_ticket;\nGRANT EXECUTE ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64), varchar(100), char(64), varchar(100), integer, jsonb) TO uellix_app;',
    ),
  },
  {
    id: 'K-103',
    file: GOVERNED_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 9 — firma antigua ejecutable',
    change: 'the five-argument conversion is DROPPED instead of turned into a delegator',
    breaks:
      'STELLA_0016_INSTALLED_PROBE in db/prepared-package-order.ts is written over exactly that signature. Drop it and the probe returns false, so the registry stops refusing stella_0015 over a stella_0016 database — and re-applying stella_0015 silently republishes a bind whose reservation count is actor-scoped and a complete that charges through consume_stella_quota. R1, restored by a guard that was disarmed as a side effect.',
    expectedGate: ['governed-old-signature-delegates'],
    apply: sub(
      'CREATE OR REPLACE FUNCTION uellix_stella.settle_reserved_quota(\n  p_organization_id uuid,\n  p_project_id uuid,\n  p_stella_role varchar(50),\n  p_idempotency_key char(64),\n  p_ticket_id char(64)\n)',
      'DROP FUNCTION IF EXISTS uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character);\nCREATE OR REPLACE FUNCTION uellix_stella.settle_reserved_quota_legacy(\n  p_organization_id uuid,\n  p_project_id uuid,\n  p_stella_role varchar(50),\n  p_idempotency_key char(64),\n  p_ticket_id char(64)\n)',
    ),
  },
  {
    id: 'K-104',
    file: GOVERNED_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 10 — reserva grounded vs operación hermana',
    change: 'the conversion takes an advisory lock on a key of its own',
    breaks:
      'Two different keys are two different mutexes. The reservation check inside bind and the charge inside the conversion would stop excluding each other, so a capacity read taken between the ticket UPDATE and the ledger INSERT sees a reservation that is gone and a charge that has not landed — Consumed + Reserved momentarily one lower than the truth, which is exactly the window a competitor needs.',
    expectedGate: ['governed-shared-lock'],
    apply: sub(
      "    pg_catalog.hashtextextended('stella/quota/' || p_organization_id::text, 0));\n\n  SELECT si.id INTO v_existing",
      "    pg_catalog.hashtextextended('stella/settle/' || p_organization_id::text, 0));\n\n  SELECT si.id INTO v_existing",
    ),
  },
  {
    id: 'K-105',
    file: GOVERNED_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 6 — no rompas el recorrido grounded existente',
    change: 'a NULL payload no longer defaults to the fixed literal body',
    breaks:
      'The grounded path calls the delegator, which passes NULL for every payload argument. Without the default the INSERT files a NULL into a NOT NULL column and the grounded complete stops working entirely — or, if the column ever loses its NOT NULL, files a row that says nothing at all where stella_0016 filed one that says a unit was spent. The parity between the two arities is what makes the delegation safe, and it is measured rather than promised.',
    expectedGate: ['governed-null-payload-parity'],
    apply: sub(
      "  v_body  := COALESCE(p_response_json, '{\"kind\":\"quota_consumption\",\"version\":1}'::jsonb);",
      '  v_body  := p_response_json;',
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* (4) Order and rollback                                                     */
/* -------------------------------------------------------------------------- */

export const ORDER_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-106',
    file: GOVERNED_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 11 — añade protección de orden al camino real de aplicación',
    change: 'the stella_0016 precondition is removed',
    breaks:
      'Applied over stella_0015 alone, `CREATE OR REPLACE` MINTS the five-argument settle_reserved_quota rather than replacing it — so the database ends up with a delegator whose target exists, a `complete` that still charges through consume_stella_quota, and no stella_capacity for either to ask. The package would install cleanly and produce a chain nobody designed.',
    expectedGate: ['governed-package-order'],
    apply: sub(
      "  IF to_regprocedure('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)') IS NULL THEN\n    RAISE EXCEPTION 'stella_0017 aborted: uellix_stella.settle_reserved_quota is absent — apply db/prepared/stella_0016_reserved_quota_semantics.sql first. This package republishes that body; it must not be the package that mints the signature.';\n  END IF;",
      '  PERFORM 1;',
    ),
  },
  {
    id: 'K-107',
    file: GOVERNED_ROLLBACK,
    severity: 'CRITICAL',
    clause: 'FASE 11 — el rollback no debe restaurar INSERT directo runtime',
    change: 'the rollback grants INSERT on the ledger back to uellix_writer',
    breaks:
      'This is the one thing the rollback must never do, and it is the shape a well-meaning edit takes: "undo what the forward package did". The forward package did not replace a feature — it closed a defect that composes, on stella_0016, into two units sold against a cap of one. A rollback that reopens it hands the oversell back with no statement anybody signed.',
    expectedGate: ['governed-rollback-keeps-revoke'],
    apply: sub(
      "  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)';",
      "  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)';\n  EXECUTE 'GRANT SELECT, INSERT ON public.stella_interactions TO uellix_writer';",
    ),
  },
  {
    id: 'K-108',
    file: GOVERNED_ROLLBACK,
    severity: 'CRITICAL',
    clause: 'FASE 11 — el rollback debe quedar fail-closed',
    change: 'the rollback drops the governed-identity CHECK',
    breaks:
      'With the CHECK gone and only the REVOKE standing, the table OWNER can file a unit with no operation identity again — and so can any principal a later GRANT restores. The rollback would have removed the half of the closure that a privilege cannot undo while keeping the half that one can.',
    expectedGate: ['governed-rollback-keeps-check'],
    apply: sub(
      "  IF to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)') IS NOT NULL\n     OR to_regprocedure('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb)') IS NOT NULL THEN\n    RAISE EXCEPTION 'stella_0017 rollback FAILED: a payload-carrying function is still installed and still callable — aborting so the transaction rolls back.';\n  END IF;",
      "  EXECUTE 'ALTER TABLE public.stella_interactions DROP CONSTRAINT IF EXISTS stella_interactions_governed_identity_check';",
    ),
  },
  {
    id: 'K-109',
    file: GOVERNED_ROLLBACK,
    severity: 'MAJOR',
    clause: 'FASE 11 — debe negarse cuando una reversión no sea segura',
    change: 'the rollback stops refusing on a database where stella_0016 is already gone',
    breaks:
      'It republishes the five-argument conversion with stella_0016\'s body, which calls uellix_stella.stella_capacity and reads the ticket table through a policy and a column grant that package installs. On a database where those are gone the function installs cleanly, is granted to the ticket definer, and fails at its first call. A rollback that leaves a callable function which cannot work is worse than one that refuses, because only one of the two is visible.',
    expectedGate: ['governed-rollback-order-refusal'],
    apply: sub(
      "  IF to_regprocedure('uellix_stella.stella_capacity(uuid, character)') IS NULL THEN\n    RAISE EXCEPTION 'stella_0017 rollback REFUSED:",
      "  IF false THEN\n    RAISE EXCEPTION 'stella_0017 rollback note:",
    ),
  },
  {
    id: 'K-110',
    file: GOVERNED_ROLLBACK,
    severity: 'CRITICAL',
    clause: 'FASE 11 — no debe borrar cargos',
    change: 'the rollback removes the rows the sibling verb filed',
    breaks:
      'A charge filed through the sibling verb is indistinguishable from every other charge — the construction is deliberately identical — and the ledger is append-only for the owner as well. Removing them is not a rollback, it is a refund nobody authorised, applied to units organizations actually spent.',
    expectedGate: ['governed-rollback-keeps-charges'],
    apply: sub(
      '  SELECT count(*) INTO n_charged\n  FROM public.stella_interactions si\n  WHERE si.idempotency_key IS NOT NULL;',
      "  DELETE FROM public.stella_interactions WHERE model_used <> 'not-applicable';\n  SELECT count(*) INTO n_charged\n  FROM public.stella_interactions si\n  WHERE si.idempotency_key IS NOT NULL;",
    ),
  },
  {
    id: 'K-111',
    file: GOVERNED_ROLLBACK,
    severity: 'MAJOR',
    clause: 'FASE 11 — debe converger; INT-CAP-004 (1)',
    change: 'the payload-carrying conversion is left behind',
    breaks:
      'It is owned by uellix_cap_stella_quota. stella_0013\'s rollback DROPs that role, and a role that still owns a function cannot be dropped — so the whole transaction three links downstream aborts and nothing is destroyed. A rollback whose omission is only discovered by another package\'s failure is a rollback nobody can sequence.',
    expectedGate: ['governed-rollback-removes-both'],
    apply: sub(
      "  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb)';",
      '  PERFORM 1;',
    ),
  },
]

export const GOVERNED_CONSUMPTION_MUTATIONS: readonly Mutation[] = [
  ...DIRECT_WRITE_MUTATIONS,
  ...SIBLING_VERB_MUTATIONS,
  ...CONVERSION_MUTATIONS,
  ...ORDER_MUTATIONS,
]
