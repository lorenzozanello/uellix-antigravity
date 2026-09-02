// tests/helpers/stella-category-binding-mutations.ts
//
// The catalogue of deliberate breakages for the category-binding package
// (stella_0018, R6a and R6b).
//
// Each entry names ONE property of the closure, the edit that removes it, and
// the gate in tests/helpers/stella-category-binding-gates.ts that must refuse
// the result. tests/stella-category-binding-mutation.test.ts applies them to an
// in-memory copy — nothing here writes to db/prepared.
//
// The three rules carry over from the three predecessor catalogues, and they are
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
//
// IDS. K-112 onwards, continuing the stella_0014, stella_0015, stella_0016 and
// stella_0017 catalogues rather than restarting — the mutation suite asserts the
// five sets are disjoint, so "K-86" can only ever mean one thing.

import { CATEGORY_FORWARD, CATEGORY_ROLLBACK } from './stella-category-binding-gates'

export interface Mutation {
  readonly id: string
  readonly file: string
  readonly severity: 'CRITICAL' | 'MAJOR' | 'MINOR'
  /** The clause of the train-4.3 closeout the property comes from. */
  readonly clause: string
  readonly change: string
  readonly breaks: string
  readonly expectedGate: readonly string[]
  readonly apply: (sql: string) => string
}

/**
 * Replace the first occurrence, or return the input unchanged.
 *
 * The replacement goes through a FUNCTION, not a string: `String.replace` with a
 * string replacement treats `$$` as an escape for a literal `$`, and several
 * anchors below sit next to PostgreSQL dollar quotes.
 */
const sub = (from: string, to: string) => (sql: string) => sql.replace(from, () => to)

/* -------------------------------------------------------------------------- */
/* (1) R6a — the comparison itself                                            */
/* -------------------------------------------------------------------------- */

export const CATEGORY_BINDING_MUTATIONS: readonly Mutation[] = [
  {
    id: 'K-112',
    file: CATEGORY_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 3 — expected_category reimpuesta por SQL',
    change: 'the bind takes the expected category and ignores it',
    breaks:
      'This is R6a with a wider signature, and it is the mutation the whole package exists to make impossible: every call site passes its category, every review reads a four-argument bind, and a ticket issued for `advisor` still binds, runs and is charged as `advisor` through the grounded route. The append-only row that results cannot be corrected.',
    expectedGate: ['category-comparison-present'],
    apply: sub(
      '  IF v_category IS DISTINCT FROM p_expected_category THEN\n    RAISE EXCEPTION \'stella ticket: the ticket was issued for a different capability\' USING ERRCODE = \'U0112\';\n  END IF;',
      '  -- comparison removed\n  PERFORM 1;',
    ),
  },
  {
    id: 'K-113',
    file: CATEGORY_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 3 — el rechazo ocurre ANTES de reservar',
    change: 'the category refusal moves BELOW the advisory lock and the capacity read',
    breaks:
      'The refusal stops being free. A cross-category presentation now serialises the whole organization on the per-organization advisory lock before being told no, which turns an attribution defect into a denial-of-service lever; and at the cap it is answered `quota_exceeded` — a retryable business state — for a call that is never going to be legal. Exactly the ordering defect stella_0016 §4 records for the project check, reintroduced.',
    expectedGate: ['category-refusal-above-lock', 'category-refusal-above-capacity'],
    apply: (sql) => {
      const clause =
        '  IF v_category IS DISTINCT FROM p_expected_category THEN\n    RAISE EXCEPTION \'stella ticket: the ticket was issued for a different capability\' USING ERRCODE = \'U0112\';\n  END IF;\n'
      const moved = sql.replace(clause, () => '')
      return moved.replace(
        '  UPDATE uellix_stella_ops.operation_tickets t\n  SET status = \'bound\', query_hash = p_query_hash, bound_at = v_now',
        () =>
          clause +
          '\n  UPDATE uellix_stella_ops.operation_tickets t\n  SET status = \'bound\', query_hash = p_query_hash, bound_at = v_now',
      )
    },
  },
  {
    id: 'K-114',
    file: CATEGORY_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 3 — un cruce que un reintento no puede blanquear',
    change: 'the category refusal moves BELOW the idempotent re-bind short-circuit',
    breaks:
      'A mismatch only the FIRST delivery catches. The attacker binds the ticket legitimately through its own surface, then presents the SAME ticket to a sibling surface: `bind` finds `status = \'bound\'`, returns early, and the cross-category presentation is never judged. The work then runs under the wrong capability and settles.',
    expectedGate: ['category-refusal-above-rebind'],
    apply: (sql) => {
      const clause =
        '  IF v_category IS DISTINCT FROM p_expected_category THEN\n    RAISE EXCEPTION \'stella ticket: the ticket was issued for a different capability\' USING ERRCODE = \'U0112\';\n  END IF;\n'
      const moved = sql.replace(clause, () => '')
      return moved.replace(
        '  -- Serialise the reservation against every other reservation AND against every',
        () => clause + '\n  -- Serialise the reservation against every other reservation AND against every',
      )
    },
  },
  {
    id: 'K-115',
    file: CATEGORY_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 3 — el rechazo lleva su propio SQLSTATE',
    change: 'the refusal is raised without USING ERRCODE, so it arrives as P0001',
    breaks:
      '`classifyTicketError` maps on the SQLSTATE and nothing else — deliberately, so a reworded message cannot silently reclassify a security refusal. An unnamed error falls to `unavailable`, which the product renders as "Stella could not complete": the reviewer is told the system broke when in fact their ticket was refused, and an operator cannot tell a bug from an attack.',
    expectedGate: ['category-mismatch-sqlstate'],
    apply: sub(
      "    RAISE EXCEPTION 'stella ticket: the ticket was issued for a different capability' USING ERRCODE = 'U0112';",
      "    RAISE EXCEPTION 'stella ticket: the ticket was issued for a different capability';",
    ),
  },

  /* ------------------------------------------------------------------------ */
  /* (2) R1 must survive R6a's closure                                        */
  /* ------------------------------------------------------------------------ */
  {
    id: 'K-116',
    file: CATEGORY_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 3 — corrección aditiva que no debilita gates anteriores',
    change: 'the republished bind reads the ledger-only count instead of stella_capacity',
    breaks:
      'R6a closed and R1 reopened by the same package. The bind stops seeing live reservations, so a sibling can take the unit a bound ticket is holding — and because `settle_reserved_quota` evaluates no limit, the conversion then lands anyway. Consumed exceeds Limit, and every category check in the file still reads as a closure.',
    expectedGate: ['category-bind-keeps-reserved-arithmetic'],
    apply: sub(
      '  SELECT c.limit_units, c.consumed, c.reserved, c.available INTO v_cap\n  FROM uellix_stella.stella_capacity(v_org, p_ticket_id) c;',
      '  SELECT o.stella_monthly_quota AS limit_units, 0 AS consumed, 0 AS reserved,\n         o.stella_monthly_quota AS available INTO v_cap\n  FROM public.organizations o WHERE o.id = v_org;',
    ),
  },

  /* ------------------------------------------------------------------------ */
  /* (3) R6b — the two withdrawals                                            */
  /* ------------------------------------------------------------------------ */
  {
    id: 'K-117',
    file: CATEGORY_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 4 — revocar EXECUTE a uellix_app sobre el consumo sin ticket',
    change: 'the REVOKE against uellix_app on consume_stella_capacity is removed, leaving only the PUBLIC one',
    breaks:
      'R6b restored, and by exactly the no-op stella_0017 §1 warns about: `uellix_app` holds this grant EXPLICITLY from stella_0016 §7, so a REVOKE FROM PUBLIC touches nothing. One unit charged with no ticket, no reservation, no abort path, and a category and idempotency key both chosen by the caller — while the package still reads as a closure.',
    expectedGate: ['category-ticketless-consumer-withdrawn'],
    apply: sub(
      'REVOKE EXECUTE ON FUNCTION uellix_stella.consume_stella_capacity(uuid, uuid, varchar(50), char(64))\n  FROM uellix_app;',
      '-- withdrawal removed',
    ),
  },
  {
    id: 'K-118',
    file: CATEGORY_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 3 — cerrar la ruta, no sólo publicar la gobernada',
    change: 'the REVOKE against uellix_app on the three-argument bind is removed',
    breaks:
      'The package publishes a category-bound bind and leaves the unchecked one reachable next to it. Every current call site passes its category, so nothing fails — and the day a sixth action is written against the older signature, R6a is back with no test noticing. A search that finds zero callers does not close a route while the grant is still there.',
    expectedGate: ['category-unchecked-bind-withdrawn'],
    apply: sub(
      'REVOKE EXECUTE ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64))\n  FROM uellix_app;',
      '-- withdrawal removed',
    ),
  },
  {
    id: 'K-119',
    file: CATEGORY_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 3 — REVOKE antes de GRANT sobre una firma nueva',
    change: 'the PUBLIC revoke on the new signature is removed',
    breaks:
      "A fresh function's ACL is NULL, which PostgreSQL reads as the owner's default — and `acldefault('f', …)` includes EXECUTE for PUBLIC. Every role in the cluster, including `anon`, can bind a ticket it can name. The GRANT to uellix_app below is then decorative.",
    expectedGate: ['category-public-revoked-before-grant'],
    apply: sub(
      'REVOKE ALL ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64), varchar(50)) FROM PUBLIC;',
      '-- public revoke removed',
    ),
  },

  /* ------------------------------------------------------------------------ */
  /* (4) The self-verification must be able to fail                           */
  /* ------------------------------------------------------------------------ */
  {
    id: 'K-120',
    file: CATEGORY_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 4 — la verificación sigue la pertenencia de rol',
    change: 'the verification asks a VALUES list instead of pg_roles with has_function_privilege',
    breaks:
      'It stops FOLLOWING role membership, which is the whole lesson stella_0017 §1 records: a principal that reaches either surface through an intermediate role is invisible to a name list, and the package reports a closure over a database that still has the route. `has_function_privilege` additionally RAISES on a role that does not exist, which is why the question is driven from the catalogue.',
    expectedGate: ['category-verification-follows-membership'],
    apply: sub(
      '  FROM pg_roles r\n  WHERE r.rolname IN (\'uellix_app\', \'authenticated\', \'anon\', \'service_role\',\n                      \'uellix_writer\', \'uellix_reader\', \'uellix_auditor\', \'authenticator\')\n    AND has_function_privilege(r.oid, to_regprocedure(\n          \'uellix_stella_ops.bind_operation_ticket(character, uuid, character)\'), \'EXECUTE\');',
      "  FROM (VALUES ('uellix_app')) AS r(rolname)\n  WHERE false;",
    ),
  },
  {
    id: 'K-121',
    file: CATEGORY_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 4 — la verificación lee el CUERPO publicado',
    change: 'the verification stops reading pg_get_functiondef',
    breaks:
      'Every remaining check is about signatures and grants, and K-112 satisfies all of them: a bind that declares `p_expected_category` and never compares it passes the whole of §5. The body read is the only assertion that can tell "the argument exists" from "the argument is used".',
    expectedGate: ['category-verification-reads-the-body'],
    // `pg_get_viewdef` and not a suffixed name: renaming it to
    // `pg_get_functiondef_disabled` leaves the gate's needle as a SUBSTRING of
    // the replacement, so the mutant would read as dead while the property is
    // gone. The first version of this line did exactly that.
    apply: (sql) => sql.split('pg_get_functiondef(').join('pg_get_viewdef('),
  },

  /* ------------------------------------------------------------------------ */
  /* (4b) The three findings of adversarial review A                          */
  /* ------------------------------------------------------------------------ */
  {
    id: 'K-124',
    file: CATEGORY_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 15 — revisor A, F2: NULL alcanzable desde el runtime',
    change: 'the expected category becomes optional again — NULL is treated as "no expectation"',
    breaks:
      '`bind(t, project, hash, NULL)` IS the unchecked bind, and `uellix_app` is granted the four-argument signature. Withdrawing the three-argument one then buys nothing: R6a stops being structural and falls back to the Node comparison the package claims to have replaced. This is the exact shape the first draft shipped with, and no signature or grant check notices it.',
    expectedGate: ['category-expectation-mandatory'],
    apply: (sql) =>
      sql
        .replace(
          "  IF p_expected_category IS NULL THEN\n    RAISE EXCEPTION 'stella ticket: the expected capability is required' USING ERRCODE = 'U0100';\n  END IF;\n",
          () => '',
        )
        .replace(
          '  IF v_category IS DISTINCT FROM p_expected_category THEN',
          () => '  IF p_expected_category IS NOT NULL AND v_category IS DISTINCT FROM p_expected_category THEN',
        ),
  },
  {
    id: 'K-125',
    file: CATEGORY_FORWARD,
    severity: 'CRITICAL',
    clause: 'FASE 15 — revisor A, F1: la superficie sin ticket que sí tenía grant',
    change: 'the REVOKE on consume_stella_quota is removed, leaving only the wrapper withdrawn',
    breaks:
      'R6b closed for the function that never had a caller and left open for the one that does. `uellix_stella.consume_stella_quota` is granted to uellix_app by stella_0013 §7, takes the category and the idempotency key from the caller, files the ledger row, and counts CHARGED ROWS ONLY — so it is invisible to a live reservation and composes with a conversion that evaluates no limit into Consumed = 2 against Limit = 1.',
    expectedGate: ['category-ticketless-consumer-withdrawn'],
    apply: sub(
      'REVOKE EXECUTE ON FUNCTION uellix_stella.consume_stella_quota(uuid, uuid, varchar(50), char(64))\n  FROM uellix_app;',
      '-- withdrawal removed',
    ),
  },
  {
    id: 'K-126',
    file: CATEGORY_FORWARD,
    severity: 'MAJOR',
    clause: 'FASE 15 — revisor A, F2: una firma que liga es una ruta',
    change: 'the three-argument bind goes back to delegating with a NULL expectation',
    breaks:
      "A signature that still binds is a route whatever its grant says, and this one is reachable from anything owned by uellix_cap_stella_ticket — including the four-argument body itself if a later edit ever routed through it. The refusal is what makes \\u201cthe signature survives, the behaviour does not\\u201d a fact rather than a sentence in a comment.",
    expectedGate: ['category-unchecked-arity-refuses'],
    apply: sub(
      "  RAISE EXCEPTION 'stella ticket: this verb cannot name the expected capability; use the category-bound signature'\n    USING ERRCODE = 'U0106';",
      '  RETURN QUERY\n  SELECT b.outcome, b.used, b.quota\n  FROM uellix_stella_ops.operation_tickets t, uellix_stella_ops.bind_operation_ticket(\n    p_ticket_id, p_expected_project_id, p_query_hash, NULL::varchar(50)) b\n  WHERE t.ticket_id = p_ticket_id;',
    ),
  },

  /* ------------------------------------------------------------------------ */
  /* (5) The rollback                                                         */
  /* ------------------------------------------------------------------------ */
  {
    id: 'K-122',
    file: CATEGORY_ROLLBACK,
    severity: 'MAJOR',
    clause: 'FASE 5 — rollback exacto, no un estado intermedio',
    change: 'the rollback restores the three-argument bind as a delegator instead of a self-contained body',
    breaks:
      'The four-argument function is DROPped in the same transaction, so the restored delegator points at a function that no longer exists. The database reports a successful rollback and every subsequent bind fails at runtime — a state neither the forward package nor stella_0017 ever produces, reached by the script whose job is to return to one of them.',
    expectedGate: ['category-rollback-restores-implementation'],
    apply: (sql) =>
      sql
        .split('  PERFORM pg_catalog.pg_advisory_xact_lock(\n    pg_catalog.hashtextextended(\'stella/quota/\' || v_org::text, 0));')
        .join('  -- lock removed')
        .split('  FROM uellix_stella.stella_capacity(v_org, p_ticket_id) c;')
        .join('  FROM (SELECT NULL::int, 0, 0, 1) c;'),
  },
  {
    id: 'K-123',
    file: CATEGORY_ROLLBACK,
    severity: 'MAJOR',
    clause: 'FASE 5 — el rollback devuelve la base a un estado que su cadena acepta',
    change: 'the rollback does not restore uellix_app\'s EXECUTE on consume_stella_capacity',
    breaks:
      'stella_0016 §7 (3) asserts that `uellix_app` CAN execute that function. A rollback that leaves the grant withdrawn produces a database on which stella_0016 aborts — so the operator who rolled back to re-apply the chain cannot, and the failure names a privilege rather than the rollback that removed it.',
    expectedGate: ['category-rollback-restores-grants'],
    apply: sub(
      'GRANT EXECUTE ON FUNCTION uellix_stella.consume_stella_capacity(uuid, uuid, varchar(50), char(64))\n  TO uellix_app;',
      '-- grant not restored',
    ),
  },
]
