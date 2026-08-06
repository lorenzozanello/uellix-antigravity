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
]

/**
 * The rules that apply to one prepared script.
 *
 * Takes the FILE NAME (with or without `.sql`, with or without a directory) so
 * the migrator can hand it whatever it was given. Matching is on the basename
 * without extension and is exact — a prefix match would make `stella_0014b`
 * inherit `stella_0014`'s rules silently.
 */
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
