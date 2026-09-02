// tests/helpers/stella-category-binding-gates.ts
//
// The static contract for the category-binding package (stella_0018, R6a and
// R6b) as a PURE FUNCTION over file contents.
//
// It is a pure function for the same reason its three predecessors are:
// tests/stella-category-binding-mutation.test.ts has to run exactly this code
// over deliberately broken copies. A gate that lives inside an assertion which
// reads the disk itself cannot be shown to go red, and a gate that has never
// gone red is indistinguishable from a gate that cannot.
//
// SCOPE. These gates judge the TWO stella_0018 files and nothing else. They are
// deliberately NOT folded into evaluateGovernedConsumptionGates(): that contract
// asserts exact facts about the two stella_0017 files, and this package changes
// none of them. Same argument stella-governed-consumption-gates.ts makes for not
// joining the stella_0016 contract, one train earlier.
//
// WHAT THESE GATES CANNOT SEE, SAID ONCE. They read TEXT. "uellix_app cannot
// execute the three-argument bind" is a fact about a CATALOGUE, and the only
// honest way to assert it is against a running server —
// scripts/stella-category-binding-dry-run.sh §7 and §9 do exactly that against a
// restored baseline, and scripts/stella-ticket-e2e.sh §4f asserts it again on the
// database the runtime battery actually drives. What these gates assert is the
// half that CAN be read from the text: that the package states the comparison,
// states it ABOVE the point of no return, and withdraws the two grants over the
// principal that actually holds them.

import { unparsedSecurityStatements } from './sql-structure'

export const CATEGORY_FORWARD = 'stella_0018_category_bound_operation_tickets.sql'
export const CATEGORY_ROLLBACK = 'stella_0018_rollback.sql'

export const CATEGORY_SQL_FILES = [CATEGORY_FORWARD, CATEGORY_ROLLBACK] as const

export type Sources = Record<string, string>

export interface Violation {
  readonly gate: string
  readonly detail: string
}

/** The runtime identity — the principal both withdrawals are about. */
const RUNTIME_ROLE = 'uellix_app'
/** stella_0014's definer, and the owner both bind bodies must keep. */
const TICKET_ROLE = 'uellix_cap_stella_ticket'

/** The SQLSTATE a cross-category presentation must raise. */
export const CATEGORY_MISMATCH_SQLSTATE = 'U0112'

/** The signature that carries the expectation, in to_regprocedure spelling. */
export const CATEGORY_BOUND_BIND =
  'uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)'

/** The signature that does NOT, and which no runtime principal may execute. */
export const UNCHECKED_BIND = 'uellix_stella_ops.bind_operation_ticket(character, uuid, character)'

/** The ticketless consumption surface R6b is about. */
export const TICKETLESS_CONSUMER =
  'uellix_stella.consume_stella_capacity(uuid, uuid, character varying, character)'

/**
 * The two ARGUMENT-LIST spellings, as the CREATE statements write them.
 *
 * Kept apart from the `to_regprocedure` spellings above on purpose: PostgreSQL
 * prints `character varying` where the source writes `varchar(50)`, and a gate
 * that looked for one in the other's place would pass on a package that
 * published nothing.
 */
const CREATE_CATEGORY_BOUND = 'p_expected_category varchar(50)'

/**
 * Every principal that can reach a session in this product.
 *
 * The withdrawal has to be asserted over the one that ACTUALLY holds the grant.
 * `uellix_app` holds EXECUTE on both surfaces by an EXPLICIT grant from
 * stella_0016 §7 — not by inheritance — so a `REVOKE … FROM PUBLIC` alone is a
 * no-op over it, which is the same class of defect stella_0017 §1 records for
 * the inherited INSERT and the reason both revokes below are asserted by name.
 */
export const RUNTIME_PRINCIPALS = [
  'uellix_app',
  'authenticated',
  'anon',
  'service_role',
  'uellix_writer',
  'uellix_reader',
  'uellix_auditor',
  // stella_0017 §1 counted it a runtime principal when it revoked over the
  // ledger. An assertion that measured a narrower set than the train declared
  // would report a closure over a principal nobody asked about.
  'authenticator',
] as const

/**
 * Judge the two stella_0018 files.
 *
 * Returns every violation rather than the first: a mutation suite that stopped
 * at the first complaint could not tell "this gate fired" from "some gate
 * fired", and rule 2 of the mutation catalogue turns on the difference.
 */
export function evaluateCategoryBindingGates(input: Sources): Violation[] {
  const violations: Violation[] = []
  const add = (gate: string, detail: string) => violations.push({ gate, detail })

  const forward = input[CATEGORY_FORWARD] ?? ''
  const rollback = input[CATEGORY_ROLLBACK] ?? ''

  if (forward === '') add('category-forward-present', `${CATEGORY_FORWARD} is empty or missing`)
  if (rollback === '') add('category-rollback-present', `${CATEGORY_ROLLBACK} is empty or missing`)
  if (forward === '' || rollback === '') return violations

  /* ---------------------------------------------------------------------- */
  /* (0) The published BODY, isolated once                                   */
  /* ---------------------------------------------------------------------- */
  // EVERY body property below is judged against this slice and never against
  // the whole file, and the reason was measured rather than anticipated: the
  // package's own §5 verification quotes its anchors as string literals in order
  // to assert them (`position('v_category IS DISTINCT FROM …' in def)`), and its
  // §0 preconditions name `uellix_stella.stella_capacity` to prove the chain is
  // installed. A file-wide `includes` is therefore satisfied by the package
  // TALKING ABOUT the property — a gate that reads a postcondition and calls it
  // the thing itself, and one a mutation walked straight through.
  const categoryBoundBody =
    /CREATE OR REPLACE FUNCTION uellix_stella_ops\.bind_operation_ticket\(\s*\n\s*p_ticket_id char\(64\),\s*\n\s*p_expected_project_id uuid,\s*\n\s*p_query_hash char\(64\),\s*\n\s*p_expected_category varchar\(50\)[\s\S]*?\n\$\$;/.exec(
      forward,
    )?.[0] ?? ''

  /* ---------------------------------------------------------------------- */
  /* (1) R6a — the comparison exists, and it is a comparison                 */
  /* ---------------------------------------------------------------------- */
  if (!forward.includes(CREATE_CATEGORY_BOUND) || categoryBoundBody === '') {
    add(
      'category-expected-argument-published',
      'the forward package does not publish a bind that takes p_expected_category — without an argument there is nothing to compare',
    )
  }
  if (!categoryBoundBody.includes('v_category IS DISTINCT FROM p_expected_category')) {
    add(
      'category-comparison-present',
      "the published bind body never compares the ticket row's category against the expected one. A bind that accepted the argument and ignored it would satisfy every signature check and be R6a with a wider signature",
    )
  }
  if (!categoryBoundBody.includes("ERRCODE = '" + CATEGORY_MISMATCH_SQLSTATE + "'")) {
    add(
      'category-mismatch-sqlstate',
      `a cross-category presentation must raise ${CATEGORY_MISMATCH_SQLSTATE} from the bind body; without its own SQLSTATE the adapter classifies the refusal as \`unavailable\` and the caller is told the database broke`,
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (2) R6a — the POSITION is the property                                  */
  /* ---------------------------------------------------------------------- */
  // Above the advisory lock, above the capacity read, above the idempotent
  // re-bind short-circuit. Any one of the three below it turns a free refusal
  // into a refusal that costs something — a serialised organization, a business
  // state instead of a scope refusal, or a mismatch a second delivery launders.
  const mismatchAt = categoryBoundBody.indexOf("ERRCODE = '" + CATEGORY_MISMATCH_SQLSTATE + "'")
  const ordering: readonly { readonly anchor: string; readonly gate: string; readonly why: string }[] = [
    {
      anchor: 'pg_advisory_xact_lock',
      gate: 'category-refusal-above-lock',
      why: 'a cross-category presentation would serialise the organization it is attacking before being refused',
    },
    {
      anchor: 'uellix_stella.stella_capacity',
      gate: 'category-refusal-above-capacity',
      why: 'an out-of-capability request would be answered with a business state (quota_exceeded) instead of a scope refusal — the same defect stella_0016 §4 records for the project check',
    },
    {
      anchor: "IF v_status IN ('bound', 'completed')",
      gate: 'category-refusal-above-rebind',
      why: 'a mismatch only the FIRST delivery catches is a mismatch a retry can launder',
    },
  ]
  for (const { anchor, gate, why } of ordering) {
    const anchorAt = categoryBoundBody.indexOf(anchor)
    if (mismatchAt < 0 || anchorAt < 0 || mismatchAt > anchorAt) {
      add(gate, `the ${CATEGORY_MISMATCH_SQLSTATE} refusal is not raised before \`${anchor}\`: ${why}`)
    }
  }

  /* ---------------------------------------------------------------------- */
  /* (3) The reservation arithmetic survives                                 */
  /* ---------------------------------------------------------------------- */
  // A category-bound bind that counted charged rows only would close R6a and
  // reopen R1.
  if (!categoryBoundBody.includes('uellix_stella.stella_capacity(v_org, p_ticket_id)')) {
    add(
      'category-bind-keeps-reserved-arithmetic',
      'the republished bind no longer reads uellix_stella.stella_capacity, so it cannot see live reservations (R1)',
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (3b) The expectation is MANDATORY, and the unchecked arity refuses       */
  /* ---------------------------------------------------------------------- */
  // ADVERSARIAL REVIEW A. A body that treats NULL as "no expectation" IS the
  // unchecked bind reached through the governed signature, and withdrawing the
  // three-argument one then buys nothing at all.
  if (
    !categoryBoundBody.includes('IF p_expected_category IS NULL THEN') ||
    !categoryBoundBody.includes("USING ERRCODE = 'U0100'")
  ) {
    add(
      'category-expectation-mandatory',
      'the category-bound bind does not refuse a NULL expected capability, so bind(t, project, hash, NULL) reproduces the unchecked bind through the governed signature',
    )
  }
  if (categoryBoundBody.includes('IS NOT NULL AND v_category IS DISTINCT FROM')) {
    add(
      'category-expectation-mandatory',
      'the comparison is guarded by a NULL check, so a NULL expectation skips it',
    )
  }

  // The three-argument body must REFUSE: not delegate with NULL, and not carry a
  // second copy of the arithmetic.
  const uncheckedBody =
    /CREATE OR REPLACE FUNCTION uellix_stella_ops\.bind_operation_ticket\(\s*\n\s*p_ticket_id char\(64\),\s*\n\s*p_expected_project_id uuid,\s*\n\s*p_query_hash char\(64\)\s*\n\)[\s\S]*?\n\$\$;/.exec(
      forward,
    )?.[0] ?? ''
  if (
    uncheckedBody === '' ||
    !uncheckedBody.includes("USING ERRCODE = 'U0106'") ||
    uncheckedBody.includes('pg_advisory_xact_lock') ||
    uncheckedBody.includes('stella_capacity') ||
    uncheckedBody.includes('operation_tickets')
  ) {
    add(
      'category-unchecked-arity-refuses',
      'the three-argument bind still binds — as a delegator passing NULL, or as a second implementation. A signature that binds is a route, whatever its grant says',
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (4) R6b — the withdrawals, by name                                      */
  /* ---------------------------------------------------------------------- */
  const revokesFrom = (signatureFragment: string): boolean =>
    new RegExp(
      `REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION[\\s\\S]{0,300}?${signatureFragment}[\\s\\S]{0,120}?FROM\\s+${RUNTIME_ROLE}`,
    ).test(forward)

  if (!revokesFrom('bind_operation_ticket\\(char\\(64\\), uuid, char\\(64\\)\\)')) {
    add(
      'category-unchecked-bind-withdrawn',
      `${RUNTIME_ROLE} keeps EXECUTE on the three-argument bind. It holds that grant EXPLICITLY (stella_0016 §7), so a REVOKE FROM PUBLIC is a no-op over it and R6a stays reachable through the signature the package left standing`,
    )
  }
  if (!revokesFrom('consume_stella_capacity\\(uuid, uuid, varchar\\(50\\), char\\(64\\)\\)')) {
    add(
      'category-ticketless-consumer-withdrawn',
      `${RUNTIME_ROLE} keeps EXECUTE on consume_stella_capacity — a unit may still be charged with no ticket, no reservation and a caller-chosen identity (R6b)`,
    )
  }
  // THE SECOND CONSUMER, and it is the one that mattered.
  // `consume_stella_capacity` is stella_0016's wrapper and has never had a
  // caller; `consume_stella_quota` is what that wrapper CALLS, is granted to
  // uellix_app by stella_0013 §7, and no package of the 0014→0017 chain takes it
  // back. It counts CHARGED ROWS ONLY, so it is a ticketless charge that is
  // additionally blind to a live reservation — which composes with a conversion
  // that evaluates no limit into the oversell stella_0017 §0 measured.
  // A gate that asked about only the wrapper passed over that, and did.
  if (!revokesFrom('consume_stella_quota\\(uuid, uuid, varchar\\(50\\), char\\(64\\)\\)')) {
    add(
      'category-ticketless-consumer-withdrawn',
      `${RUNTIME_ROLE} keeps EXECUTE on consume_stella_quota — the charge itself, reachable with no ticket, a caller-chosen identity and no reservation term in its arithmetic (R6b)`,
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (5) The route the runtime MUST keep                                     */
  /* ---------------------------------------------------------------------- */
  if (
    !/GRANT\s+EXECUTE\s+ON\s+FUNCTION[\s\S]{0,300}?bind_operation_ticket\(char\(64\), uuid, char\(64\), varchar\(50\)\)[\s\S]{0,80}?TO\s+uellix_app/.test(
      forward,
    )
  ) {
    add(
      'category-governed-bind-granted',
      'uellix_app is not granted the category-bound bind, so no operation can reserve a unit at all — a package that closes R6a by breaking the product',
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (6) Ownership, PUBLIC and the definer contract                          */
  /* ---------------------------------------------------------------------- */
  // REVOKE BEFORE GRANT on the NEW signature. A fresh function's ACL is NULL,
  // which PostgreSQL reads as the owner's default — and `acldefault('f', …)`
  // includes EXECUTE for PUBLIC. A package that only GRANTed would leave the
  // whole cluster able to call it.
  const publicRevokeAt = forward.indexOf(
    'REVOKE ALL ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64), varchar(50)) FROM PUBLIC',
  )
  const grantAt = forward.indexOf(
    'GRANT EXECUTE ON FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64), varchar(50))',
  )
  if (publicRevokeAt < 0 || grantAt < 0 || publicRevokeAt > grantAt) {
    add(
      'category-public-revoked-before-grant',
      "the new signature is granted without PUBLIC being revoked first; a fresh function's ACL defaults to EXECUTE for PUBLIC",
    )
  }
  if (
    !forward.includes(
      `ALTER FUNCTION uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64), varchar(50))\n  OWNER TO ${TICKET_ROLE}`,
    )
  ) {
    add(
      'category-bind-owner',
      `the category-bound bind is not owned by ${TICKET_ROLE}, so its SECURITY DEFINER privileges are not the ticket capability's`,
    )
  }
  // Counted over the CREATE blocks and not over the file: both packages discuss
  // SECURITY DEFINER in prose ("reachable only from a SECURITY DEFINER owned by
  // …"), and a file-wide count reports a mismatch that does not exist.
  for (const [label, body] of [
    ['forward', forward],
    ['rollback', rollback],
  ] as const) {
    const blocks = body.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\n\$\$;/g) ?? []
    const definers = blocks.filter((b) => b.includes('SECURITY DEFINER')).length
    const paths = blocks.filter((b) => b.includes("SET search_path = ''")).length
    if (blocks.length === 0 || definers === 0) {
      add('category-security-definer', `${label} publishes no SECURITY DEFINER body`)
    } else if (definers !== blocks.length || definers !== paths) {
      add(
        'category-empty-search-path',
        `${label} publishes ${blocks.length} function(s), ${definers} SECURITY DEFINER and ${paths} with an empty search_path — a definer with an inherited search_path is a definer a caller can redirect`,
      )
    }
  }

  /* ---------------------------------------------------------------------- */
  /* (7) The package is ADDITIVE                                             */
  /* ---------------------------------------------------------------------- */
  // It must not drop the three-argument signature: stella_0016_rollback expects
  // to find it, and STELLA_0016_INSTALLED_PROBE is written over a sibling
  // function for exactly this reason.
  if (/DROP\s+FUNCTION[^\n]*bind_operation_ticket\(char\(64\), uuid, char\(64\)\)/.test(forward)) {
    add(
      'category-forward-additive',
      'the forward package DROPs the three-argument bind. This package is additive; dropping a published signature is the destructive edit the line refuses',
    )
  }
  // ...and it must not silently republish a project-blind signature.
  if (/bind_operation_ticket\(\s*\n?\s*p_ticket_id char\(64\),\s*\n\s*p_query_hash/.test(forward)) {
    add(
      'category-no-project-blind-signature',
      'the forward package publishes a bind with no execution project — R2-INT, restored by the package that closes R6a',
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (8) The rollback is honest and complete                                 */
  /* ---------------------------------------------------------------------- */
  if (!rollback.includes(`DROP FUNCTION IF EXISTS uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64), varchar(50))`)) {
    add(
      'category-rollback-drops-new-signature',
      'the rollback leaves the category-bound signature installed, so it is not a rollback',
    )
  }
  // Scoped to the restored BODY, never to the whole file. The rollback's own
  // §4 verification mentions both anchors by name in order to assert them, so a
  // file-wide `includes` would be satisfied by the assertion about the body
  // rather than by the body — a gate that reads its own postcondition and calls
  // it a precondition.
  const restoredBody = /CREATE OR REPLACE FUNCTION uellix_stella_ops\.bind_operation_ticket\([\s\S]*?\n\$\$;/.exec(
    rollback,
  )?.[0] ?? ''
  if (!restoredBody.includes('pg_advisory_xact_lock') || !restoredBody.includes('uellix_stella.stella_capacity')) {
    add(
      'category-rollback-restores-implementation',
      'the rollback does not restore a SELF-CONTAINED three-argument bind. Dropping the four-argument body while the three-argument one still delegates to it leaves a signature whose first invocation fails at runtime',
    )
  }
  const dropAt = rollback.indexOf('DROP FUNCTION IF EXISTS uellix_stella_ops.bind_operation_ticket(char(64), uuid, char(64), varchar(50))')
  const restoreAt = rollback.indexOf('CREATE OR REPLACE FUNCTION uellix_stella_ops.bind_operation_ticket(')
  if (dropAt >= 0 && restoreAt >= 0 && dropAt < restoreAt) {
    add(
      'category-rollback-order',
      'the rollback DROPs the four-argument body before restoring the three-argument one it delegates to',
    )
  }
  if (!/GRANT\s+EXECUTE\s+ON\s+FUNCTION[\s\S]{0,200}?consume_stella_capacity[\s\S]{0,80}?TO\s+uellix_app/.test(rollback)) {
    add(
      'category-rollback-restores-grants',
      'the rollback does not restore uellix_app\'s EXECUTE on consume_stella_capacity, so stella_0016 §7 (3) would abort on its next apply — a rollback that leaves the database in a state its own chain refuses',
    )
  }
  if (!rollback.includes(CATEGORY_MISMATCH_SQLSTATE)) {
    add(
      'category-rollback-verifies-removal',
      `the rollback never mentions ${CATEGORY_MISMATCH_SQLSTATE}, so it does not verify that the restored body stopped carrying the refusal`,
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (9) The self-verification asks a question that could fail               */
  /* ---------------------------------------------------------------------- */
  // Driven from pg_roles rather than a VALUES list: `has_function_privilege`
  // RAISES on a role that does not exist, and a planner may evaluate clauses in
  // any order — the reason stella_0017 §5 (9) writes it this way.
  // ONCE PER WITHDRAWN SURFACE. The package withdraws TWO grants, so asking the
  // question once would leave the other closure verified by nothing — the same
  // half-gone shape stella-governed-consumption-mutations.ts records for the
  // privilege question stella_0017 §5 asks twice on purpose.
  const membershipQuestions = (forward.match(/has_function_privilege\(r\.oid/g) ?? []).length
  if (!forward.includes('FROM pg_roles r') || membershipQuestions < 2) {
    add(
      'category-verification-follows-membership',
      `the self-verification asks has_function_privilege over pg_roles ${membershipQuestions} time(s); it withdraws two grants and must prove both, or a principal that reaches the unverified surface by role membership goes unnoticed`,
    )
  }
  if (!forward.includes('pg_get_functiondef')) {
    add(
      'category-verification-reads-the-body',
      'the self-verification never reads the published body, so a bind that took the argument and ignored it would pass every check it makes',
    )
  }

  /* ---------------------------------------------------------------------- */
  /* (10) Structural hygiene, shared with the three predecessors             */
  /* ---------------------------------------------------------------------- */
  for (const [label, body] of [
    [CATEGORY_FORWARD, forward],
    [CATEGORY_ROLLBACK, rollback],
  ] as const) {
    for (const statement of unparsedSecurityStatements(body)) {
      add('category-unparsed-statement', `${label}: ${statement}`)
    }
    if (!/rolsuper/.test(body)) {
      add(
        'category-superuser-precondition',
        `${label} does not refuse a non-superuser session, and it withdraws grants uellix_owner cannot`,
      )
    }
  }
  // The forward package must refuse to install without its whole chain.
  for (const dependency of [
    'uellix_stella_ops.operation_tickets',
    'uellix_stella.consume_stella_capacity',
    'uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)',
  ]) {
    if (!forward.includes(dependency)) {
      add(
        'category-chain-precondition',
        `the forward package never mentions ${dependency}, so it does not prove its chain is installed before publishing over it`,
      )
    }
  }

  return violations
}
