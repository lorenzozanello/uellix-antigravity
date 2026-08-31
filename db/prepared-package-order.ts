// db/prepared-package-order.ts
// INTEGRATION — Train 4.2, FASE 2. The answer to R2a.
//
// ---------------------------------------------------------------------------
// THE RISK, AS CAPABILITIES REPORTED IT
// ---------------------------------------------------------------------------
// `db/prepared/stella_0015_project_bound_operation_tickets.sql` REPLACES four
// of stella_0014's six governed functions and DROPS the four signatures that
// took no execution project. Applied in order, the chain converges:
//
//     stella_0013  ->  stella_0014  ->  stella_0015
//
// Applied OUT of order it does not. `stella_0014` is idempotent by design, so
// re-running it ALONE against a database that already has `stella_0015`
// succeeds — and republishes `bind_operation_ticket(character, character)` and
// its three siblings, each `SECURITY DEFINER`, each granted to `uellix_app`,
// each blind to the execution project. The fix would still be installed, next
// to a fully-functional door around it.
//
// CAPABILITIES recorded this as R2a and closed it as UNFIXABLE FROM stella_0015
// — correctly: no SQL package can prevent another package from being executed
// after it. That is a statement about packages, not about the system. The
// system has a RUNNER, and a runner can refuse.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS
// ---------------------------------------------------------------------------
// A declarative registry of SUPERSESSIONS plus one pure decision function.
// It runs no SQL and opens no connection; `db/migrator.ts` executes the probe
// inside the same transaction that would apply the script, so a refusal rolls
// the whole thing back and the unsafe signatures are never published — not
// even briefly, not even to a session that would have seen them mid-transaction.
//
// THE GATE FAILS BEFORE THE RUNTIME IS EXPOSED, which is the property FASE 2
// requires and the reason the check is a PRECONDITION rather than a
// postcondition. A postcondition that noticed the regression afterwards would
// have to un-publish functions it did not write, and would already have
// COMMITted them on any path that skipped the rollback.
//
// ---------------------------------------------------------------------------
// WHY A REGISTRY AND NOT A RULE INSIDE THE MIGRATOR
// ---------------------------------------------------------------------------
// The migrator must not learn the vocabulary of one capability campaign. It
// asks this module "may this file be applied to a database in this state?", and
// this module is the only place that knows `stella_0014` has a successor. A
// second supersession — the day some `stella_0017` replaces something — is one
// entry here and no change to `db/migrator.ts`.
//
// The registry is deliberately written over EXACT SIGNATURES rather than over
// package names in a table somewhere: there is no `schema_migrations` for
// prepared packages (that is the whole point of `db/prepared/**`), so "is the
// successor installed?" has to be answered by asking the CATALOG what it
// actually contains. A version row could be wrong; `to_regprocedure` cannot.

/**
 * One "this package must not be applied over that one" rule.
 *
 * `probe` must be a single-row, single-column SQL expression returning a
 * BOOLEAN that is TRUE when the SUPERSEDING package is installed. It is a
 * fixed literal in this file — never composed, never interpolated — and the
 * migrator runs it verbatim.
 */
export interface PreparedPackageSupersession {
  /** Basename WITHOUT `.sql` of the package whose re-application is refused. */
  readonly packageName: string
  /** Basename WITHOUT `.sql` of the package that replaced part of it. */
  readonly supersededBy: string
  /** TRUE when the successor is installed in the connected database. */
  readonly probe: string
  /**
   * What re-applying `packageName` would republish. Named exactly, because the
   * refusal message has to tell an operator what the refusal is protecting —
   * "wrong order" is not actionable, "this would restore four project-blind
   * SECURITY DEFINER functions granted to the runtime" is.
   */
  readonly wouldRepublish: readonly string[]
  /** One sentence, shown to the operator. */
  readonly why: string
}

/**
 * The canonical forward chain of the Stella operation-ticket campaign.
 *
 * Stated as data so a test can assert the chain rather than a comment claiming
 * it. `stella_0013` charges, `stella_0014` mints and settles tickets,
 * `stella_0015` welds the execution project onto all four verbs.
 */
export const STELLA_TICKET_PACKAGE_CHAIN = [
  'stella_0013_grounded_query_quota',
  'stella_0014_operation_tickets',
  'stella_0015_project_bound_operation_tickets',
  'stella_0016_reserved_quota_semantics',
  'stella_0017_governed_stella_consumption',
  'stella_0018_category_bound_operation_tickets',
] as const

/**
 * The canonical forward chain of the GROUNDING campaign.
 *
 * A second chain, and stating it as data is what M-8 forced: the supersession
 * registry now holds a rule about grounding packages, and "the superseding
 * package must come later" needs an order to appeal to. Borrowing the ticket
 * chain's order would have been meaningless — the two campaigns are applied to
 * the same database but neither constrains the other's sequence.
 *
 * `grounding_0001` is deliberately absent: it was superseded by
 * `grounding_0003` and never applied anywhere, so it is not a link of anything.
 */
export const GROUNDING_PACKAGE_CHAIN = [
  'grounding_0002_document_versions',
  'grounding_0003_evidence_chunks',
  'grounding_0004_runtime_attestation',
  'grounding_0005_claim_advisory_lock',
] as const

/**
 * The two signatures `stella_0016` republishes IN PLACE, and the call each body
 * must contain afterwards.
 *
 * Written as data for the same reason the lists above are: the guard and the
 * package must not be able to drift into disagreeing about what "reservation
 * aware" means. `stella_0015` republishing either of these restores a `bind`
 * whose reservation count runs under an actor-scoped policy and a `complete`
 * that charges through `consume_stella_quota` — which is R1.
 */
export const RESERVATION_AWARE_TICKET_BODIES = [
  { signature: 'uellix_stella_ops.bind_operation_ticket(character, uuid, character)', mustCall: 'uellix_stella.stella_capacity' },
  { signature: 'uellix_stella_ops.complete_operation_ticket(character, uuid, character)', mustCall: 'uellix_stella.settle_reserved_quota' },
] as const

/**
 * The four signatures `stella_0015` DROPs and no database may ever hold again.
 *
 * `to_regprocedure` spellings, exactly as the package's own §4 (2)
 * self-verification writes them — one list, two readers, so the guard and the
 * package cannot drift into disagreeing about what "unsafe" means.
 */
export const PROJECT_BLIND_TICKET_SIGNATURES = [
  'uellix_stella_ops.bind_operation_ticket(character, character)',
  'uellix_stella_ops.complete_operation_ticket(character, character)',
  'uellix_stella_ops.abort_operation_ticket(character, character varying)',
  'uellix_stella_ops.inspect_operation_ticket(character)',
] as const

/** The four signatures that must exist instead. */
export const PROJECT_BOUND_TICKET_SIGNATURES = [
  'uellix_stella_ops.bind_operation_ticket(character, uuid, character)',
  'uellix_stella_ops.complete_operation_ticket(character, uuid, character)',
  'uellix_stella_ops.abort_operation_ticket(character, uuid, character varying)',
  'uellix_stella_ops.inspect_operation_ticket(character, uuid)',
] as const

/**
 * TRUE when at least one project-BOUND signature exists — i.e. `stella_0015`
 * is installed here.
 *
 * Written over the NEW signatures rather than over the absence of the old ones,
 * and the direction matters: absence proves nothing (a database with no ticket
 * protocol at all has no old signatures either), while presence of a
 * three-argument `bind_operation_ticket` can only come from `stella_0015`.
 */
const STELLA_0015_INSTALLED_PROBE =
  "SELECT to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character)') IS NOT NULL AS installed"

/**
 * TRUE when ANY project-blind signature is present. Used by
 * `assertNoProjectBlindTicketSignatures` as a postcondition an operator can run
 * on demand — the machine-checkable half of "the reapply left nothing behind".
 */
export const PROJECT_BLIND_SIGNATURES_PRESENT_PROBE =
  "SELECT (" +
  PROJECT_BLIND_TICKET_SIGNATURES.map((s) => `to_regprocedure('${s}') IS NOT NULL`).join(' OR ') +
  ') AS present'

/**
 * TRUE when the reservation-aware conversion exists — i.e. `stella_0016` is
 * installed here.
 *
 * Written over the FUNCTION `stella_0015` cannot produce rather than over the
 * absence of something, and the direction matters for the same reason it did
 * for R2a: absence proves nothing (a database with no quota campaign at all has
 * no `settle_reserved_quota` either), while the presence of a function that
 * charges without evaluating a limit can only come from `stella_0016`.
 */
const STELLA_0016_INSTALLED_PROBE =
  "SELECT to_regprocedure('uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character)') IS NOT NULL AS installed"

/**
 * The two objects `stella_0017` publishes, and what each one is for.
 *
 * Written as data for the same reason the lists above are: the guard and the
 * package must not be able to drift into disagreeing about what "governed
 * consumption" means. Re-applying `stella_0015` or `stella_0016` over
 * `stella_0017` does not restore a vulnerable FUNCTION — both would abort on
 * their own `count(*) = 6` assertion over `uellix_stella_ops`, which is
 * fail-closed. What the registry buys is that the operator gets a refusal that
 * names the reason instead of an assertion failure that names a number.
 */
export const GOVERNED_CONSUMPTION_OBJECTS = [
  {
    signature:
      'uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)',
    purpose: 'the completion verb for the five sibling Stella categories',
  },
  {
    signature:
      'uellix_stella.settle_reserved_quota(uuid, uuid, character varying, character, character, character varying, character, character varying, integer, jsonb)',
    purpose: 'the payload-carrying conversion the sibling verb charges through',
  },
] as const

/**
 * TRUE when the sibling completion verb exists — i.e. `stella_0017` is
 * installed here.
 *
 * Written over the FUNCTION no earlier package can produce rather than over the
 * absence of something, and the direction matters for the same reason it did for
 * R2a and for R1: absence proves nothing (a database with no quota campaign at
 * all has no seven-argument `complete_operation_ticket` either), while the
 * presence of a completion verb that carries an interaction payload can only
 * come from `stella_0017`.
 *
 * NOT written over the REVOKE that `stella_0017` §1 performs, and the choice is
 * deliberate: "uellix_writer holds no INSERT on stella_interactions" is also
 * true of a database where somebody revoked it by hand, and a probe that cannot
 * tell a package apart from an operator is a probe that refuses the wrong
 * things.
 */
const STELLA_0017_INSTALLED_PROBE =
  "SELECT to_regprocedure('uellix_stella_ops.complete_operation_ticket(character, uuid, character, character varying, character varying, integer, jsonb)') IS NOT NULL AS installed"

/**
 * The two objects `stella_0018` publishes, and what each one is for.
 *
 * R6a and R6b were MEASURED on a database with the whole 0013→0017 chain
 * installed, not inferred: an `advisor` ticket bound and completed through the
 * grounded path produced a `stella_role = 'advisor'` charge for a grounded
 * query, and `uellix_app` charged a unit through BOTH `consume_stella_capacity`
 * and `consume_stella_quota` with no ticket and an idempotency key of its own
 * choosing. The first is closed by a mandatory argument on a new signature, the
 * second by two withdrawn grants.
 */
export const CATEGORY_BOUND_TICKET_OBJECTS = [
  {
    signature:
      'uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)',
    purpose: 'the bind verb that re-imposes the expected capability in SQL, before anything is reserved (R6a)',
  },
  {
    signature: 'uellix_stella_ops.bind_operation_ticket(character, uuid, character)',
    purpose:
      'the unchecked three-argument bind, which now RAISES U0106 unconditionally and is no longer executable by uellix_app — a signature that still binds is a route, whatever its grant says',
  },
] as const

/**
 * TRUE when the category-bound bind exists — i.e. `stella_0018` is installed.
 *
 * Written over the FUNCTION no earlier package can produce. Deliberately NOT
 * written over the two REVOKEs `stella_0018` performs, for the reason
 * `STELLA_0017_INSTALLED_PROBE` states: "uellix_app cannot execute
 * consume_stella_capacity" is also true of a database where an operator revoked
 * it by hand, and a probe that cannot tell a package from an operator refuses
 * the wrong things.
 */
const STELLA_0018_INSTALLED_PROBE =
  "SELECT to_regprocedure('uellix_stella_ops.bind_operation_ticket(character, uuid, character, character varying)') IS NOT NULL AS installed"

/**
 * The signature `grounding_0005` republishes IN PLACE, and what must be true of
 * its body afterwards.
 *
 * Same shape and same purpose as `RESERVATION_AWARE_TICKET_BODIES`: the guard
 * and the package must not be able to drift into disagreeing about what
 * "repaired" means. `grounding_0005` introduces NO new signature — it changes a
 * BODY — so this is the only form in which the fact is statable.
 */
export const ADVISORY_LOCKED_CLAIM_BODY = {
  signature: 'uellix_grounding.claim_active_document_version(uuid)',
  mustCall: 'pg_advisory_xact_lock',
  mustNotContain: 'FOR UPDATE',
} as const

/**
 * TRUE when `claim_active_document_version` takes an advisory lock — i.e.
 * `grounding_0005` is installed here.
 *
 * WHY THE PROBE READS A BODY AND NOT A CATALOGUE ENTRY. Every other probe in
 * this file is written over a FUNCTION no earlier package can produce, because
 * every other superseding package introduces one. `grounding_0005` introduces
 * nothing: it replaces a body at a signature `grounding_0002` already created,
 * which is exactly what makes re-applying `grounding_0002` over it invisible to
 * a signature-shaped check. So the body IS the discriminator, and there is no
 * weaker form of this question available.
 *
 * WHY THE COMMENTS ARE STRIPPED FIRST. `pg_get_functiondef` returns the source
 * verbatim, and `grounding_0002`'s own body explains the train-2 repair by
 * quoting the tokens involved. A probe over the raw text would answer "yes,
 * advisory" for a function that still takes the row lock, purely because a
 * comment above it discusses advisory locks — the F-08C failure, in the one
 * place where a false positive means the runner ALLOWS the regression it exists
 * to refuse.
 *
 * WHY `chr(10)` AND NOT `\n`. This exact string is transcribed into
 * `scripts/stella-ticket-e2e.sh`, inside a shell heredoc, and
 * `tests/cross-workstream/project-binding.test.ts` compares the two so they
 * cannot drift. A backslash escape does not survive that round trip intact —
 * measured, it arrived as a literal newline inside the SQL literal and changed
 * what the regex matched. `chr(10)` carries no backslash at all, so the shell,
 * this file and PostgreSQL all read the same characters.
 */
const GROUNDING_0005_INSTALLED_PROBE =
  "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p " +
  "JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace " +
  "WHERE n.nspname = 'uellix_grounding' " +
  "AND p.proname = 'claim_active_document_version' " +
  "AND position('pg_advisory_xact_lock' in " +
  "regexp_replace(pg_catalog.pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g')) > 0) AS installed"

export const PREPARED_PACKAGE_SUPERSESSIONS: readonly PreparedPackageSupersession[] = [
  {
    packageName: 'stella_0014_operation_tickets',
    supersededBy: 'stella_0015_project_bound_operation_tickets',
    probe: STELLA_0015_INSTALLED_PROBE,
    wouldRepublish: PROJECT_BLIND_TICKET_SIGNATURES,
    why:
      'stella_0014 publishes bind/complete/abort/inspect WITHOUT an execution project. ' +
      'stella_0015 replaced all four and dropped those signatures (R2-INT). Re-applying ' +
      'stella_0014 over stella_0015 would restore four SECURITY DEFINER functions that ' +
      'cannot compare the ticket\'s project against the project the work runs under, and ' +
      'would grant EXECUTE on them to uellix_app — reopening the attribution defect next ' +
      'to its own fix. Apply the chain in order (stella_0013 -> stella_0014 -> stella_0015); ' +
      'to genuinely revert, run stella_0015_rollback.sql first.',
  },
  {
    packageName: 'stella_0015_project_bound_operation_tickets',
    supersededBy: 'stella_0016_reserved_quota_semantics',
    probe: STELLA_0016_INSTALLED_PROBE,
    wouldRepublish: RESERVATION_AWARE_TICKET_BODIES.map((b) => b.signature),
    why:
      'stella_0015 publishes bind/complete with an arithmetic that counts CHARGED ROWS ONLY, ' +
      'and whose reservation count runs under an actor-scoped SELECT policy so it sees only the ' +
      "caller's own tickets. stella_0016 replaced both bodies IN PLACE — same names, same " +
      'signatures — so re-applying stella_0015 over it silently restores R1: a sibling Stella ' +
      'action can charge the unit a live grounded reservation is holding, and the completion of ' +
      'that reservation is then refused, giving the executed work away. Nothing about the ' +
      'signatures changes, so no later check notices. Apply the chain in order ' +
      '(stella_0013 -> stella_0014 -> stella_0015 -> stella_0016); to genuinely revert, run ' +
      'stella_0016_rollback.sql first.',
  },
  {
    packageName: 'stella_0015_project_bound_operation_tickets',
    supersededBy: 'stella_0017_governed_stella_consumption',
    probe: STELLA_0017_INSTALLED_PROBE,
    wouldRepublish: RESERVATION_AWARE_TICKET_BODIES.map((b) => b.signature),
    why:
      'stella_0017 publishes a SEVENTH function in uellix_stella_ops — the sibling completion ' +
      'verb — and stella_0015 §4 (5) asserts that schema holds exactly six. Re-applying it ' +
      'aborts on that assertion, which is fail-closed but says nothing about why; and if the ' +
      'assertion were ever relaxed it would also republish a bind/complete pair whose ' +
      'arithmetic counts charged rows only. Apply the chain in order (stella_0013 -> ' +
      'stella_0014 -> stella_0015 -> stella_0016 -> stella_0017); to genuinely revert, run ' +
      'stella_0017_rollback.sql then stella_0016_rollback.sql first.',
  },
  {
    packageName: 'stella_0016_reserved_quota_semantics',
    supersededBy: 'stella_0017_governed_stella_consumption',
    probe: STELLA_0017_INSTALLED_PROBE,
    wouldRepublish: GOVERNED_CONSUMPTION_OBJECTS.map((o) => o.signature),
    why:
      'stella_0016 §7 (2b) asserts uellix_stella_ops holds exactly six functions, and ' +
      'stella_0017 adds a seventh, so re-applying it aborts. It would also republish the ' +
      'five-argument settle_reserved_quota as a SELF-CONTAINED body while the ten-argument ' +
      'one it currently delegates to still exists — two INSERTs into the ledger from one ' +
      'schema, and two places for the idempotency semantics to drift. Apply the chain in ' +
      'order; to genuinely revert, run stella_0017_rollback.sql first — it restores exactly ' +
      'that body and drops the ten-argument function in the same transaction.',
  },
  {
    packageName: 'stella_0015_project_bound_operation_tickets',
    supersededBy: 'stella_0018_category_bound_operation_tickets',
    probe: STELLA_0018_INSTALLED_PROBE,
    wouldRepublish: CATEGORY_BOUND_TICKET_OBJECTS.map((o) => o.signature),
    why:
      'stella_0018 publishes an EIGHTH function in uellix_stella_ops — the bind verb that ' +
      'takes an expected capability — and stella_0015 §4 (5) asserts that schema holds exactly ' +
      'six. Re-applying it aborts on that assertion, and if the assertion were ever relaxed it ' +
      'would republish a three-argument bind as a SELF-CONTAINED body that grants EXECUTE to ' +
      'uellix_app — restoring R6a, under which a ticket issued for one capability can be bound ' +
      'and charged by another and the append-only row that results cannot be corrected. Apply ' +
      'the chain in order; to genuinely revert, run stella_0018_rollback.sql first.',
  },
  {
    packageName: 'stella_0016_reserved_quota_semantics',
    supersededBy: 'stella_0018_category_bound_operation_tickets',
    probe: STELLA_0018_INSTALLED_PROBE,
    wouldRepublish: CATEGORY_BOUND_TICKET_OBJECTS.map((o) => o.signature),
    why:
      'stella_0016 §7 (2b) asserts uellix_stella_ops holds exactly six functions, and ' +
      'stella_0018 makes it eight, so re-applying it aborts. Its §7 (3) additionally asserts ' +
      'that uellix_app CAN execute consume_stella_capacity — the grant stella_0018 §4 withdraws ' +
      'to close R6b — so the abort is by design and not a regression. Re-application would also ' +
      'republish the three-argument bind as a self-contained body and GRANT it to uellix_app, ' +
      'reopening R6a. Apply the chain in order; to genuinely revert, run ' +
      'stella_0018_rollback.sql then stella_0017_rollback.sql first.',
  },
  {
    packageName: 'stella_0017_governed_stella_consumption',
    supersededBy: 'stella_0018_category_bound_operation_tickets',
    probe: STELLA_0018_INSTALLED_PROBE,
    wouldRepublish: CATEGORY_BOUND_TICKET_OBJECTS.map((o) => o.signature),
    why:
      'stella_0017 §5 asserts uellix_stella_ops holds exactly seven functions, and stella_0018 ' +
      'adds an eighth, so re-applying it aborts. It publishes nothing that would reopen R6a or ' +
      'R6b on its own — the refusal exists so the operator reads a reason instead of an ' +
      'assertion that names a number. Apply the chain in order; to genuinely revert, run ' +
      'stella_0018_rollback.sql first.',
  },
  {
    // NOT a link of the ticket chain, and the only rule in this registry whose
    // `packageName` is a ROLLBACK. Found by adversarial review A: stella_0017 §1
    // names this file as the way the ledger's INSERT comes back, and stella_0018
    // §0 concedes that the NOT VALID CHECK is satisfied by any 64 hex characters
    // — so the grant surface IS the compensating control, and a runner that
    // would re-grant it without objecting is a runner that undoes the closure it
    // was written to protect.
    //
    // The probe is the CHECK rather than a function, because what this rollback
    // would undo is a privilege and not a signature — and the CHECK is the one
    // object of the governed-consumption closure that no earlier package
    // publishes.
    packageName: 'stella_0005c_rollback',
    supersededBy: 'stella_0017_governed_stella_consumption',
    probe:
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stella_interactions_governed_identity_check' AND conrelid = 'public.stella_interactions'::regclass) AS installed",
    wouldRepublish: [
      'GRANT INSERT ON public.stella_interactions TO authenticated',
      'GRANT INSERT ON public.stella_interactions TO service_role',
    ],
    why:
      'stella_0005c_rollback GRANTs INSERT on public.stella_interactions back to authenticated and ' +
      'service_role. stella_0017 §1 revoked exactly that from every runtime principal, and its own ' +
      'header names this file as the way the privilege returns. Applying it over stella_0017 ' +
      'restores a direct write to the append-only ledger by two principals a client session can ' +
      'wear — and the governed-identity CHECK does not stop it, because any 64 hex characters ' +
      'satisfy it. If the runtime cutover genuinely has to be reverted, run stella_0017_rollback.sql ' +
      'first so the closure is withdrawn deliberately rather than as a side effect.',
  },
  {
    // M-8. NOT a link of the ticket chain, and the only rule here whose
    // superseding package publishes no new object at all.
    packageName: 'grounding_0002_document_versions',
    supersededBy: 'grounding_0005_claim_advisory_lock',
    probe: GROUNDING_0005_INSTALLED_PROBE,
    wouldRepublish: [
      `${ADVISORY_LOCKED_CLAIM_BODY.signature} with SELECT ... FROM public.evidence_items ... FOR UPDATE`,
    ],
    why:
      'grounding_0002 publishes claim_active_document_version with a ROW LOCK on ' +
      'public.evidence_items, and PostgreSQL requires UPDATE privilege on a table to take one — ' +
      'which uellix_cap_grounding deliberately does not hold (§219 grants SELECT and only SELECT). ' +
      'grounding_0005 replaced that body IN PLACE with the transaction-scoped advisory lock its ' +
      'own sibling register_document_version already took. Re-applying grounding_0002 over it ' +
      'SUCCEEDS — the package is idempotent — and silently restores M-8: every governed ingestion ' +
      'call by uellix_app dies with 42501 before reading a version, and the write side of the ' +
      'corpus is dead again. NOTHING ABOUT THE SIGNATURE CHANGES, so no later package, no witness ' +
      'and no arity check notices; the only observable difference is inside the body. Apply the ' +
      'grounding unit in order (grounding_0002 -> 0003 -> 0004 -> 0005), and if 0002 genuinely has ' +
      'to be re-applied, re-apply 0005 immediately afterwards in the same window.',
  },
]

/**
 * The rules that apply to one prepared script.
 *
 * Takes the FILE NAME (with or without `.sql`, with or without a directory) so
 * the migrator can hand it whatever it was given. Matching is on the basename
 * without extension and is exact — a prefix match would make `stella_0014b`
 * inherit `stella_0014`'s rules silently.
 */
/**
 * FIBIU-28 (FIBC-040) — prepared packages retired by the FIB's collision
 * reconciliation (FIB §5.2), because the logical objects they installed are
 * now canonical in the Drizzle chain instead.
 *
 * Deliberately NOT a `PreparedPackageSupersession` entry and NOT consulted by
 * `assertPreparedPackageOrder`/`applyPreparedScript`. Every existing rule
 * above answers "does the DATABASE already show the successor installed?" —
 * exactly the wrong question here: `stella_0002`/`stella_0002b`'s triggers and
 * `stella_hosted_0008`'s policy converge to the SAME catalog shape whether
 * installed by the prepared script or by the Drizzle migration that
 * supersedes them (both are `DROP ... IF EXISTS` + `CREATE ...`), so a
 * catalog-shape probe could never distinguish "superseded, refuse" from
 * "this is exactly what the prepared script itself would produce, allow" —
 * and `stella_0002`/`stella_0002b` are still real steps of the FIXED local
 * bootstrap manifest in `scripts/stella-r3-4-local-runner.ts`, which this
 * registry must not silently start refusing on a database it has never
 * consulted. The record here is the repository-level disposition the sealed
 * FIB requires — see db/prepared/README.md's Inventario for the same fact
 * and each retired file's own banner for the full reasoning.
 */
export const FIB_RETIRED_PREPARED_PACKAGES = [
  {
    packageName: 'stella_0002_interactions_hardening',
    supersededByMigration: 'db/migrations/0044_fib_audit_hardening_supersession.sql',
    fibItem: 'FIBDB-034',
    why:
      'trg_stella_interactions_append_only is now created by an idempotent Drizzle migration. ' +
      'Only that trigger is retired here — the grant and stella_role CHECK reconciliation this ' +
      'package also performs are untouched (FIBDB-034 names NEW_TRIGGER only).',
  },
  {
    packageName: 'stella_0002b_append_only_truncate_hardening',
    supersededByMigration: 'db/migrations/0044_fib_audit_hardening_supersession.sql',
    fibItem: 'FIBDB-034',
    why:
      'Its four trg_*_no_truncate triggers are now created by the same idempotent Drizzle ' +
      'migration, which also adds the fifth sibling (stella_suggestion_decisions, installed ' +
      'separately by stella_0003). Only the triggers are retired here — the grant ' +
      'reconciliation (REVOKE TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) is untouched.',
  },
  {
    packageName: 'stella_hosted_0008_audit_log_write_capability',
    supersededByMigration: 'db/migrations/0042_fib_audit_insert_policy.sql',
    fibItem: 'FIBDB-035',
    why:
      'The audit_logs_insert_member_or_admin policy this hosted twin would install is now ' +
      'created by an idempotent Drizzle migration. Never applied to any database; a genuine ' +
      'hosted role-topology divergence, if discovered, becomes a hosted addendum to that ' +
      'migration — never a second creation of this object via the prepared track.',
  },
] as const

export function supersessionsFor(file: string): readonly PreparedPackageSupersession[] {
  const base = file
    .split(/[\\/]/)
    .pop()!
    .replace(/\.sql$/i, '')
  return PREPARED_PACKAGE_SUPERSESSIONS.filter((rule) => rule.packageName === base)
}

/**
 * The decision, as a pure function of (rule, what the probe found).
 *
 * Returns the refusal message, or `null` when the application may proceed.
 * Split out from the migrator so the mutation suite can drive both answers
 * without a database — a guard whose refusing branch has never been executed is
 * a guard nobody has seen work.
 */
export function packageOrderRefusal(
  rule: PreparedPackageSupersession,
  supersederInstalled: boolean,
): string | null {
  if (!supersederInstalled) return null
  return (
    `${rule.packageName}.sql cannot be applied to this database: ${rule.supersededBy}.sql is ` +
    `already installed and supersedes it. ${rule.why} Re-application would republish: ` +
    `${rule.wouldRepublish.join(', ')}.`
  )
}
