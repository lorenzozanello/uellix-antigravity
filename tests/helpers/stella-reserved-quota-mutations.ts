// tests/helpers/stella-reserved-quota-mutations.ts
//
// The catalogue of deliberate breakages for the reserved-quota package
// (stella_0016, R1).
//
// Each entry names ONE property of the closure, the edit that removes it, and
// the gate in tests/helpers/stella-reserved-quota-gates.ts that must refuse the
// result. tests/stella-reserved-quota-mutation.test.ts applies them to an
// in-memory copy — nothing here writes to db/prepared.
//
// The three rules carry over from tests/helpers/stella-project-ticket-mutations.ts,
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
// IDS. K-54 onwards, continuing the stella_0014 and stella_0015 catalogues
// rather than restarting — tests/stella-reserved-quota-mutation.test.ts asserts
// the three sets are disjoint, so "K-17" can only ever mean one thing.

import { RESERVED_QUOTA_FORWARD, RESERVED_QUOTA_ROLLBACK } from './stella-reserved-quota-gates'

export interface Mutation {
  readonly id: string
  readonly file: string
  readonly severity: 'CRITICAL' | 'MAJOR' | 'MINOR'
  /** The clause of R1 the property comes from. */
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
/* The arithmetic — Available = Limit - Consumed - Reserved                   */
/* -------------------------------------------------------------------------- */

export const ARITHMETIC_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-54',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 2 — Available = Limit - Consumed - Reserved',
    change: 'stella_capacity stops subtracting live reservations',
    breaks:
      'This is R1 itself, restored, and it survives every signature check in the contract: a function called stella_capacity that returns Limit - Consumed reads exactly like one that works. Every consumer keeps calling it, the grounded reservation keeps being taken, and a sibling keeps taking the same unit — because from the ledger alone there is nothing to see.',
    expectedGate: ['capacity-reservation-counted'],
    apply: sub(
      '         ELSE v_limit - v_consumed - v_reserved END;',
      '         ELSE v_limit - v_consumed END;',
    ),
  },
  {
    id: 'K-55',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 6 — expiry is part of the liveness predicate, not a cron job',
    change: 'stella_capacity counts every bound ticket, expired or not',
    breaks:
      'There is no pg_cron in this project. A process that crashes between bind and complete leaves a ticket that says `bound` forever, and with the expiry test gone that ticket holds a unit until somebody notices and runs expire_operation_tickets by hand. One crash per month against a quota of one is a permanently blocked organization, and the failure looks like exhausted quota rather than like a leak.',
    expectedGate: ['capacity-expiry-in-predicate'],
    apply: sub(
      "    AND t.status = 'bound'\n    AND t.expires_at > v_now\n    AND (p_exclude_ticket_id IS NULL OR t.ticket_id <> p_exclude_ticket_id);",
      "    AND t.status = 'bound'\n    AND (p_exclude_ticket_id IS NULL OR t.ticket_id <> p_exclude_ticket_id);",
    ),
  },
  {
    id: 'K-56',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 2 — a reservation is counted in the period it will land in',
    change: 'stella_capacity filters live reservations by their recorded period',
    breaks:
      'It reads like the obviously correct thing to do — count this month\'s reservations against this month\'s cap — and it opens the boundary. A reservation taken at 23:58 on the last day converts at 00:03 into the NEXT period, where the ledger row lands; filtering it out means the new period never set that unit aside and sells it to somebody else. Fifteen minutes a month, on the organizations closest to their cap.',
    expectedGate: ['capacity-no-period-filter'],
    apply: sub(
      "    AND t.status = 'bound'\n    AND t.expires_at > v_now",
      "    AND t.status = 'bound'\n    AND t.period_month = v_month\n    AND t.expires_at > v_now",
    ),
  },
  {
    id: 'K-57',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 2 — Consumed is scoped to the current UTC month',
    change: 'stella_capacity counts charged rows for all time',
    breaks:
      'A monthly allowance measured against lifetime consumption blocks every organization permanently once it has ever spent its cap, and no reset date the product renders is true. The direction is conservative, which is exactly why it would survive review: nothing is oversold, the product simply stops working in a way that reads as correct enforcement.',
    expectedGate: ['capacity-period-scoped-consumption'],
    apply: sub(
      '  WHERE si.organization_id = p_organization_id\n    AND si.created_at >= v_month;',
      '  WHERE si.organization_id = p_organization_id;',
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* The ticketless surface — R6-INT's answer                                   */
/* -------------------------------------------------------------------------- */

export const SIBLING_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-58',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 5 — a ticketless consumer counts charges PLUS reservations',
    change: 'consume_stella_capacity charges without testing availability',
    breaks:
      'The surface the five sibling actions are being asked to migrate to would consume straight through a live reservation — the exact behaviour their current db.insert already has, now with a governed name and an advisory lock that protects nothing. The migration would be recorded as closing R1 while changing only where the defect lives.',
    expectedGate: ['capacity-limit-enforced'],
    apply: sub(
      '    IF v_cap.available <= 0 THEN\n      RETURN QUERY SELECT \'quota_exceeded\'::text, v_cap.consumed, v_cap.limit_units;\n      RETURN;\n    END IF;\n  END IF;\n\n  -- The charge, through the governed path',
      '  END IF;\n\n  -- The charge, through the governed path',
    ),
  },
  {
    id: 'K-59',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 3 — one arithmetic, not one per consumer',
    change: 'consume_stella_capacity rebuilds the count instead of asking stella_capacity',
    breaks:
      'Two implementations of the same arithmetic are one implementation plus a latent oversell, and this is not hypothetical: bind_operation_ticket had its own copy, that copy ran under an actor-scoped policy, and it counted only the caller\'s own reservations. The second copy is always the one nobody re-reads when the rule changes.',
    expectedGate: ['capacity-sibling-uses-capacity'],
    apply: sub(
      '  SELECT c.limit_units, c.consumed, c.reserved, c.available INTO v_cap\n  FROM uellix_stella.stella_capacity(p_organization_id, NULL) c;',
      '  SELECT o.stella_monthly_quota AS limit_units, 0 AS consumed, 0 AS reserved,\n         o.stella_monthly_quota AS available INTO v_cap\n  FROM public.organizations o WHERE o.id = p_organization_id;',
    ),
  },
  {
    id: 'K-60',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 5 — the consumer obtains a coherent lock',
    change: 'consume_stella_capacity drops the per-organization advisory lock',
    breaks:
      'Read-then-write with no serialisation is the defect INT-CAP-001 reported two trains ago, restated for a surface that also counts reservations: two siblings both observe available = 1 and both charge. The unique index does not help — their idempotency keys differ, because they are two different operations.',
    expectedGate: ['capacity-advisory-lock'],
    apply: sub(
      "  PERFORM pg_catalog.pg_advisory_xact_lock(\n    pg_catalog.hashtextextended('stella/quota/' || p_organization_id::text, 0));\n\n  -- REPLAY, checked under the lock and BEFORE capacity.",
      '  -- REPLAY, checked under the lock and BEFORE capacity.',
    ),
  },
  {
    id: 'K-61',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 5 — idempotent when the consumer already has a key',
    change: 'consume_stella_capacity stops short-circuiting on a known idempotency key',
    breaks:
      'A retry of an operation that already charged is not asking for headroom, but without the replay branch it is judged as though it were — so at the cap it is answered quota_exceeded, which is precisely where retries are most likely and where the answer is most wrong. The unit was already spent; the caller is told it cannot spend one.',
    expectedGate: ['capacity-idempotent'],
    apply: sub(
      "  IF v_existing IS NOT NULL THEN\n    RETURN QUERY SELECT 'replayed'::text, v_cap.consumed, v_cap.limit_units;\n    RETURN;\n  END IF;\n\n  -- The refusal.",
      '  -- The refusal.',
    ),
  },
  {
    id: 'K-62',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 5 — scope is judged before business state',
    change: 'consume_stella_capacity stops proving the project belongs to the organization',
    breaks:
      'MEASURED, not reasoned about: §11 of the dry run caught this on an organization whose quota happened to be spent. consume_stella_quota would still refuse the charge, so nothing is stolen — but the refusal arrives as `quota_exceeded`, a retryable business state that the product renders with a reset date, for a call that will never be legal in any month.',
    expectedGate: ['capacity-scope-before-state'],
    apply: sub(
      '  IF NOT EXISTS (\n    SELECT 1 FROM public.projects p\n    WHERE p.id = p_project_id AND p.organization_id = p_organization_id\n  ) THEN\n    RAISE EXCEPTION \'stella capacity: organization not found\' USING ERRCODE = \'U0102\';\n  END IF;\n\n  -- Serialise against every other reservation',
      '  -- Serialise against every other reservation',
    ),
  },
  {
    id: 'K-63',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 5 — the ledger keeps exactly one writer',
    change: 'consume_stella_capacity writes the ledger itself instead of calling consume_stella_quota',
    breaks:
      'The uniqueness guarantee stops having one implementation. Every argument stella_0013 makes about the shape of a charged row — the derived actor, the namespaced context digest, the fixed response literal, the ON CONFLICT — would have to be re-made here and kept in step forever, and the day the two disagree the ledger holds two kinds of unit that an auditor has to tell apart.',
    expectedGate: ['capacity-governed-charge'],
    apply: sub(
      '  SELECT c.outcome, c.used, c.quota INTO v_charge\n  FROM uellix_stella.consume_stella_quota(p_organization_id, p_project_id, p_stella_role, p_idempotency_key) c;\n\n  RETURN QUERY SELECT v_charge.outcome, v_charge.used, v_charge.quota;',
      "  INSERT INTO public.stella_interactions (\n    organization_id, project_id, created_by, stella_role, pipeline_step,\n    context_hash, response_json, model_used, idempotency_key)\n  VALUES (p_organization_id, p_project_id, v_actor, p_stella_role, p_stella_role,\n          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_idempotency_key, 'UTF8')), 'hex'),\n          '{}'::jsonb, 'not-applicable', p_idempotency_key);\n\n  RETURN QUERY SELECT 'consumed'::text, v_cap.consumed + 1, v_cap.limit_units;",
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* The conversion — reservation into charge                                   */
/* -------------------------------------------------------------------------- */

export const CONVERSION_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-64',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 4 — complete converts, it does not re-compete',
    change: 'complete_operation_ticket charges through consume_stella_quota again',
    breaks:
      'R1 itself, in the one line that causes it. consume_stella_quota evaluates the limit against charged rows ONLY, so the completion enters a competition its own bind was supposed to have settled — and loses it to any sibling that charged while the model was running. The work ran, the answer exists, and nothing can be billed for it.',
    expectedGate: ['capacity-complete-does-not-compete'],
    apply: sub(
      '  SELECT c.outcome, c.used, c.quota INTO v_charge\n  FROM uellix_stella.settle_reserved_quota(v_org, v_project, v_category, v_key, p_ticket_id) c;',
      '  SELECT c.outcome, c.used, c.quota INTO v_charge\n  FROM uellix_stella.consume_stella_quota(v_org, v_project, v_category, v_key) c;',
    ),
  },
  {
    id: 'K-65',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 4 — the reservation stops existing once it is charged',
    change: 'complete_operation_ticket charges but never settles the ticket',
    breaks:
      'The same unit is then counted twice — once as Consumed because the row is in the ledger, once as Reserved because the ticket still says `bound` — until the reservation expires fifteen minutes later. An organization at its cap pays for one operation and loses capacity for two, and the second unit comes back on its own, which makes the symptom intermittent and the cause invisible.',
    expectedGate: ['capacity-complete-settles'],
    apply: sub(
      "  UPDATE uellix_stella_ops.operation_tickets t\n  SET status = 'completed', completed_at = v_now\n  WHERE t.ticket_id = p_ticket_id;\n\n  RETURN QUERY SELECT 'completed'::text, v_charge.used, v_charge.quota;",
      "  RETURN QUERY SELECT 'completed'::text, v_charge.used, v_charge.quota;",
    ),
  },
  {
    id: 'K-66',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 4 — the conversion proves the reservation is live',
    change: 'settle_reserved_quota stops checking that the reservation has not expired',
    breaks:
      'This function files a unit WITHOUT evaluating the limit, so every check it skips is a way to charge past the cap. An expired reservation has already stopped counting — its unit may have been handed to a sibling minutes ago — and converting it anyway is the oversell the whole package exists to make impossible.',
    expectedGate: ['capacity-conversion-proves-reservation'],
    apply: sub(
      "  v_now := pg_catalog.timezone('UTC', pg_catalog.now());\n  IF v_expires <= v_now THEN",
      "  v_now := pg_catalog.timezone('UTC', pg_catalog.now());\n  IF FALSE THEN",
    ),
  },
  {
    id: 'K-67',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 4 — a reservation of another category cannot be consumed',
    change: 'settle_reserved_quota stops proving the ticket category matches the charge',
    breaks:
      'A grounded_query reservation could be converted into an advisor charge, or the reverse. The pool is shared so no cap is exceeded — which is exactly why it would pass review — but every downstream reading of the ledger is wrong: the per-role usage an operator sees, the attribution an auditor re-derives, and the cost model that assigns a price per capability all describe an operation that did not happen.',
    expectedGate: ['capacity-conversion-proves-reservation'],
    apply: sub(
      "     OR v_category IS DISTINCT FROM p_stella_role\n     OR v_status   IS DISTINCT FROM 'bound' THEN",
      "     OR v_status   IS DISTINCT FROM 'bound' THEN",
    ),
  },
  {
    id: 'K-68',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 4 — a reservation of another project cannot be consumed',
    change: 'settle_reserved_quota stops proving the ticket project matches the charge',
    breaks:
      'It reopens R2-INT from underneath: complete_operation_ticket still compares the ticket project against the execution project, but the function that actually files the row would no longer verify the value it was handed. The one thing that made the conversion safe to grant is that it does not trust its caller, and this removes exactly that.',
    expectedGate: ['capacity-conversion-proves-reservation'],
    apply: sub(
      '     OR v_project  IS DISTINCT FROM p_project_id\n',
      '',
    ),
  },
  {
    id: 'K-69',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 4 — the conversion is the only path that skips the limit',
    change: 'settle_reserved_quota stops requiring the ticket to be bound',
    breaks:
      'Any ticket in any state becomes convertible: an issued one that never reserved anything, an aborted one whose unit was released, an expired one, a completed one being charged a second time. The limit is never evaluated on this path, so each of those is a unit filed past the cap — and the ticket state machine, which refuses all of it upstream, would be the only thing left standing between a caller and the ledger.',
    expectedGate: ['capacity-conversion-proves-reservation'],
    apply: sub(
      "     OR v_status   IS DISTINCT FROM 'bound' THEN",
      '     OR FALSE THEN',
    ),
  },
  {
    id: 'K-70',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 4 — the conversion charges exactly once',
    change: 'settle_reserved_quota drops the replay short-circuit and the conflict clause',
    breaks:
      'Two concurrent completions of one ticket would file two units. The row lock in complete_operation_ticket makes that unreachable through the governed path, but uellix_writer\'s standing INSERT grant takes no such lock — which is the whole reason the guarantee is written as a property of the DATA. Removing it moves the invariant from "cannot happen" to "has not happened yet".',
    expectedGate: ['capacity-idempotent'],
    apply: sub(
      '  ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL\n  DO NOTHING;',
      ';',
    ),
  },
  {
    id: 'K-71',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 7 — the conversion and the settlement are one move',
    change: 'settle_reserved_quota drops the shared advisory lock',
    breaks:
      'The INSERT that files the unit and the caller\'s UPDATE that settles the ticket stop becoming visible to a competing capacity check as one move. A sibling can then observe the reservation released and the charge not yet filed — a window in which Consumed + Reserved is one short, and the cap is oversold by exactly one unit per crossing.',
    expectedGate: ['capacity-advisory-lock'],
    apply: sub(
      "  PERFORM pg_catalog.pg_advisory_xact_lock(\n    pg_catalog.hashtextextended('stella/quota/' || p_organization_id::text, 0));\n\n  SELECT si.id INTO v_existing",
      '  SELECT si.id INTO v_existing',
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* The boundaries — grants, policy, columns, order                            */
/* -------------------------------------------------------------------------- */

export const BOUNDARY_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-72',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 4 — who may convert IS the security property',
    change: 'settle_reserved_quota is granted to the runtime role',
    breaks:
      'It is the single most reasonable-looking edit in this package — the runtime executes the other two, why not the third — and it hands uellix_app a function that files a unit without evaluating the limit. Any authenticated member could then charge past the cap for any ticket whose 256-bit id it could name, and every organization\'s cap becomes advisory.',
    expectedGate: ['capacity-conversion-grant-scope'],
    apply: sub(
      'GRANT EXECUTE ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64))\n  TO uellix_cap_stella_ticket;',
      'GRANT EXECUTE ON FUNCTION uellix_stella.settle_reserved_quota(uuid, uuid, varchar(50), char(64), char(64))\n  TO uellix_app;',
    ),
  },
  {
    id: 'K-73',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 3 — availability is organization-wide, across actors',
    change: 'the capacity policy is given the actor predicate the other three carry',
    breaks:
      'This is the second cause of R1, reintroduced — and it was found by reproducing the first, not by reading. With actor_id = auth.uid() the availability arithmetic sees only the caller\'s own reservations, so two members of one organization each reserve the same last unit and both are told bound. It reads as consistency with the three policies beside it, which is exactly why it survives.',
    expectedGate: ['capacity-policy-scope'],
    apply: sub(
      'USING (\n  organization_id = ANY(public.current_user_org_ids())\n  OR public.current_user_is_super_admin()\n);',
      'USING (\n  actor_id = auth.uid()\n  AND organization_id = ANY(public.current_user_org_ids())\n);',
    ),
  },
  {
    id: 'K-74',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 3 — no unnecessary private information is exposed',
    change: 'the capacity role is granted SELECT on the whole ticket row',
    breaks:
      'The charge nonce becomes readable by a role that also holds INSERT on the ledger. From the nonce and the ticket id the idempotency key is one SHA-256 away, and with both a caller could file a unit outside the protocol under an identity the protocol believes it minted. The nonce exists for exactly one reason and this removes it.',
    expectedGate: ['capacity-column-grant'],
    apply: sub(
      'GRANT SELECT (ticket_id, organization_id, project_id, category, status, expires_at, period_month)\n  ON TABLE uellix_stella_ops.operation_tickets TO uellix_cap_stella_quota;',
      'GRANT SELECT (ticket_id, organization_id, project_id, category, status, expires_at, period_month, charge_nonce, query_hash)\n  ON TABLE uellix_stella_ops.operation_tickets TO uellix_cap_stella_quota;',
    ),
  },
  {
    id: 'K-75',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 2 — a reservation belongs unequivocally to one period',
    change: 'period_month becomes an ordinary writable column',
    breaks:
      'A period a caller can write is a period that can disagree with the reservation it describes, and there is no trigger behind it: stella_0014 asserts exactly two ENABLE ALWAYS triggers on this table, so adding a third would break its idempotency. GENERATED ALWAYS is what makes membership a fact of the type system rather than a convention somebody maintains.',
    expectedGate: ['capacity-period-generated'],
    apply: sub(
      "  ADD COLUMN IF NOT EXISTS period_month timestamp\n  GENERATED ALWAYS AS (date_trunc('month', bound_at)) STORED;",
      '  ADD COLUMN IF NOT EXISTS period_month timestamp;',
    ),
  },
  {
    id: 'K-76',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 8 — the package refuses to install out of order',
    change: 'the stella_0015 precondition is removed',
    breaks:
      'Applied over stella_0014 alone, CREATE OR REPLACE does not replace the two verbs — it MINTS a three-argument overload beside the two-argument one, and both stay callable and granted. The database would then hold a reservation-aware, project-bound pair next to a project-blind pair, which is R1 closed and R2-INT reopened in the same transaction.',
    expectedGate: ['capacity-dependency'],
    apply: sub(
      "  IF to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character)') IS NULL\n     OR to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character)') IS NULL THEN",
      '  IF FALSE THEN',
    ),
  },
  {
    id: 'K-77',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 8 — the republication replaces, it does not add',
    change: 'the republished bind_operation_ticket drops the execution project',
    breaks:
      'A different argument list is not a republication: it mints a second overload and leaves stella_0015\'s body installed and reachable. Both would then be granted to uellix_app, one reservation-aware and project-blind, the other project-bound and not — and PostgreSQL would resolve each call by argument count, so which defect a caller hits depends on how many arguments it happened to pass.',
    expectedGate: ['capacity-verb-signature'],
    apply: sub(
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.bind_operation_ticket(\n  p_ticket_id char(64),\n  p_expected_project_id uuid,\n  p_query_hash char(64)\n)',
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.bind_operation_ticket(\n  p_ticket_id char(64),\n  p_query_hash char(64)\n)',
    ),
  },
  {
    id: 'K-78',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 4 — closing R1 must not reopen R2-INT',
    change: 'the republished complete_operation_ticket loses the project comparison',
    breaks:
      'A body rewritten for one contract that quietly drops another\'s check. The signature still advertises p_expected_project_id, every gate about reserved quota still passes, and the charge lands under the ticket\'s project while the work read its evidence under the action\'s — which is R2-INT exactly, reintroduced by the package that was reviewed for something else.',
    expectedGate: ['capacity-verb-keeps-project-binding'],
    apply: sub(
      "  -- R2-INT, checked BEFORE the replay short-circuit.\n  IF v_project IS DISTINCT FROM p_expected_project_id THEN\n    RAISE EXCEPTION 'stella ticket: the ticket belongs to a different project' USING ERRCODE = 'U0110';\n  END IF;",
      '  -- R2-INT, checked BEFORE the replay short-circuit.',
    ),
  },
  {
    id: 'K-79',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 3 — bind reserves through the canonical arithmetic',
    change: 'bind_operation_ticket keeps its own reservation count',
    breaks:
      'The copy is what made cause (2) possible: it ran as uellix_cap_stella_ticket, under an actor-scoped SELECT policy, and counted only the caller\'s own tickets. Restoring it restores an arithmetic that disagrees with the one every other consumer uses — and the two only disagree when more than one member of an organization is working at once, which is when it matters.',
    expectedGate: ['capacity-bind-uses-capacity'],
    apply: sub(
      '  SELECT c.limit_units, c.consumed, c.reserved, c.available INTO v_cap\n  FROM uellix_stella.stella_capacity(v_org, p_ticket_id) c;',
      "  SELECT o.stella_monthly_quota INTO v_cap FROM public.organizations o WHERE o.id = v_org;\n  SELECT count(*)::integer INTO v_reserved\n  FROM uellix_stella_ops.operation_tickets t\n  WHERE t.organization_id = v_org AND t.status = 'bound'\n    AND t.expires_at > v_now AND t.ticket_id <> p_ticket_id;",
    ),
  },
  {
    id: 'K-80',
    file: RESERVED_QUOTA_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 8 — nothing new lands where a published package counts',
    change: 'the capacity function is published into the ticket schema instead',
    breaks:
      'stella_0015 §4 asserts EXACTLY six functions in uellix_stella_ops, so a seventh makes that package abort on its next apply — the forward chain stops being idempotent, which is the property the dry run exists to measure. It is the same defect stella_0014 §1 recorded when it refused to share stella_0013\'s schema, and it would be found the same way: on pass two.',
    expectedGate: ['capacity-no-new-ticket-function', 'capacity-definer-owner'],
    apply: sub(
      'CREATE OR REPLACE FUNCTION uellix_stella.stella_capacity(',
      'CREATE OR REPLACE FUNCTION uellix_stella_ops.stella_capacity(',
    ),
  },
]

/* -------------------------------------------------------------------------- */
/* The rollback                                                                */
/* -------------------------------------------------------------------------- */

export const ROLLBACK_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-81',
    file: RESERVED_QUOTA_ROLLBACK,
    severity: 'CRITICAL',
    clause: 'FASE 9 — the rollback does not revive vulnerable semantics',
    change: 'the rollback "restores the previous version" of complete_operation_ticket',
    breaks:
      'It reads as the most ordinary thing a rollback can do, and it is the defect. R1 is not a body a newer body fixed — it is the ABSENCE of reservation-aware arithmetic, so restoring the previous version and republishing the vulnerability are the same statement. Worse, it fires on exactly the databases that had used the protocol: the ones with real reservations and a real reason to be rolling something back.',
    expectedGate: ['capacity-rollback-safe'],
    apply: sub(
      'SET client_min_messages = notice;\n',
      "SET client_min_messages = notice;\n\nCREATE OR REPLACE FUNCTION uellix_stella_ops.complete_operation_ticket(\n  p_ticket_id char(64),\n  p_expected_project_id uuid,\n  p_query_hash char(64)\n)\nRETURNS TABLE (outcome text, used integer, quota integer)\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = ''\nAS $$\nBEGIN\n  RETURN QUERY SELECT 'completed'::text, NULL::integer, NULL::integer;\nEND;\n$$;\nGRANT EXECUTE ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64)) TO uellix_app;\n",
    ),
  },
  {
    id: 'K-82',
    file: RESERVED_QUOTA_ROLLBACK,
    severity: 'CRITICAL',
    clause: 'FASE 9 — the rollback converges',
    change: 'settle_reserved_quota is never dropped',
    breaks:
      'A callable SECURITY DEFINER function that charges without evaluating the limit survives a rollback that reports success — and because it is owned by uellix_cap_stella_quota, stella_0013\'s DROP ROLE fails forever after, which makes the whole quota campaign permanently un-uninstallable. That is INT-CAP-004 (1) exactly: the defect grounding_0003_rollback shipped.',
    expectedGate: ['capacity-rollback-convergence'],
    apply: sub(
      "  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)';\n",
      '',
    ),
  },
  {
    id: 'K-83',
    file: RESERVED_QUOTA_ROLLBACK,
    severity: 'CRITICAL',
    clause: 'FASE 9 — the rollback does not delete real charges',
    change: 'the rollback removes the units its own functions filed',
    breaks:
      'Those are units organizations actually spent. The ledger is append-only for the owner as well, the rows are indistinguishable from every other charge by construction, and a completed ticket is the only record of which operation each one paid for. A rollback that erases a consumption is not a rollback; it is a refund nobody authorised, applied to a compliance trail.',
    expectedGate: ['capacity-rollback-preserves-charges'],
    apply: sub(
      "    RAISE NOTICE 'stella_0016 rollback: % identified charge(s) remain in public.stella_interactions and are left exactly as found. Nothing here removes a consumption.', n_charged;",
      "    DELETE FROM public.stella_interactions WHERE idempotency_key IS NOT NULL;",
    ),
  },
  {
    id: 'K-84',
    file: RESERVED_QUOTA_ROLLBACK,
    severity: 'MAJOR',
    clause: 'FASE 9 — the rollback removes nothing it does not own',
    change: 'the rollback drops stella_0013\'s governed charge function',
    breaks:
      'consume_stella_quota is how the five ticketless Stella actions charge, before this package and after it. Removing it as part of undoing a reservation fix takes down five working flows that have nothing to do with R1 — and it is the kind of over-reach that reads as thoroughness in review, because the function is named in this package on almost every page.',
    expectedGate: ['capacity-rollback-scope'],
    apply: sub(
      "  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella.stella_capacity(uuid, character)';",
      "  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella.stella_capacity(uuid, character)';\n  EXECUTE 'DROP FUNCTION IF EXISTS uellix_stella.consume_stella_quota(uuid, uuid, character varying, character)';",
    ),
  },
  {
    id: 'K-85',
    file: RESERVED_QUOTA_ROLLBACK,
    severity: 'MAJOR',
    clause: 'FASE 9 — the rollback converges on the read it opened',
    change: 'the capacity policy is never dropped',
    breaks:
      'A role left with no functions keeps an organization-wide, non-actor-scoped SELECT policy on the reservation table. Nothing reads it any more, which is why it would survive review — and it stays as a widened boundary that a later package inherits without ever having argued for it.',
    expectedGate: ['capacity-rollback-convergence'],
    apply: sub(
      '    EXECUTE \'DROP POLICY IF EXISTS "operation_tickets_capacity_select" ON uellix_stella_ops.operation_tickets\';\n',
      '',
    ),
  },
]

export const RESERVED_QUOTA_MUTATIONS: readonly Mutation[] = [
  ...ARITHMETIC_MUTATIONS,
  ...SIBLING_MUTATIONS,
  ...CONVERSION_MUTATIONS,
  ...BOUNDARY_MUTATIONS,
  ...ROLLBACK_MUTATIONS,
]
