// db/hosted/baseline-recovery.ts
// TRAIN 5C0 — Phase 11. What to do when a hosted unit fails, decided BEFORE the
// first hosted write rather than at 2am with a half-migrated database open.
//
// ---------------------------------------------------------------------------
// THE THREE MEASURED FACTS THIS DECISION RESTS ON
// ---------------------------------------------------------------------------
//   1. EVERY UNIT IS ATOMIC, THE SEQUENCE IS NOT. No baseline unit contains a
//      statement PostgreSQL refuses inside a transaction — no CREATE INDEX
//      CONCURRENTLY, no VACUUM, no ALTER TYPE ... ADD VALUE. Measured across all
//      fifty. So `psql -1 -v ON_ERROR_STOP=1` makes each unit all-or-nothing,
//      and a failure at unit N leaves 1..N-1 applied and N cleanly absent.
//
//   2. THE BASELINE HAS NO ROLLBACK SCRIPTS. Zero, against 26 for the prepared
//      Stella chain. "Roll back the baseline" is not a slower option; it is not
//      an option.
//
//   3. MOST OF IT CANNOT BE RE-RUN. 28 of the 40 Drizzle units contain at least
//      one statement with no IF NOT EXISTS form — CREATE TABLE, ADD COLUMN, and
//      above all ADD CONSTRAINT, which PostgreSQL gives no guarded spelling at
//      all. Re-running the chain from the top over a partial apply raises on the
//      first already-applied unit.
//
// Those three together say something specific: after a mid-baseline failure the
// only forward paths are RESUME AT N, or start over. And resuming is only safe
// when you can prove where N is — which is a claim about a database whose last
// operation just failed.
//
// ---------------------------------------------------------------------------
// WHY DESTROY_AND_REPROVISION IS THE DEFAULT AND NOT THE LAST RESORT
// ---------------------------------------------------------------------------
// The instinct is to treat destruction as escalation. That instinct is calibrated
// for databases that hold something. This one holds nothing: it is a brand new
// Supabase project with zero rows, provisioned minutes ago, whose entire content
// is reproducible from fifty files in this repository. The cost of recreating it
// is a project-create and a re-run. The cost of a wrong hand-repair is a staging
// environment that DIFFERS from the one the manifest describes, silently, in a
// way every later verification is now measuring against the wrong baseline.
//
// So the ordering is inverted on purpose: recreate unless there is a positive
// reason not to, rather than repair unless recreation is forced.

import { BASELINE_ORDER, baselineUnit } from './baseline-manifest'
import { HOSTED_CHAIN } from './hosted-package-manifest'
import type { ProvisioningPhase } from './hosted-provisioning-runner'

export type RecoveryStrategy =
  /** Re-run the same unit. Only for an idempotent unit that failed transiently. */
  | 'RETRY_UNIT'
  /** Continue at the next unit. Only when the failed unit provably left nothing. */
  | 'RESUME_AT_NEXT_UNIT'
  /** Run the package's rollback script, then decide again. Stella phases only. */
  | 'ROLLBACK_SQL'
  /** Delete the Supabase project, create a new one, start from PHASE_BASELINE. */
  | 'DESTROY_AND_REPROVISION'
  /** Touch nothing. The state is not one this table has a safe answer for. */
  | 'HALT_AND_ESCALATE'

export type FailureKind =
  /** The connection dropped, timed out, or the pooler refused. No SQL ran. */
  | 'transport'
  /** The server rejected a statement. The unit rolled back whole. */
  | 'statement-error'
  /** The apply reported neither success nor a usable error. */
  | 'indeterminate'
  /** A postcondition of an applied unit did not hold afterwards. */
  | 'postcondition-failed'

export interface RecoverySituation {
  readonly phase: ProvisioningPhase
  /** Unit or package id that failed. */
  readonly failedUnit: string
  readonly failureKind: FailureKind
  /**
   * Did the failed unit run under `psql -1`? If this is false, nothing below
   * can reason about atomicity and the answer is always HALT_AND_ESCALATE.
   */
  readonly singleTransaction: boolean
  /**
   * Has anyone written to the target since provisioning began, outside the
   * runner? A yes makes "reproducible from the repository" false.
   */
  readonly manualWritesOccurred: boolean
  /** Does the project hold anything not reproducible from this repository? */
  readonly holdsIrreplaceableData: boolean
}

export interface RecoveryDecision {
  readonly strategy: RecoveryStrategy
  readonly rationale: string
  /** What the operator does, in order. */
  readonly steps: readonly string[]
  /** Conditions under which this decision is WRONG and must be revisited. */
  readonly revisitIf: readonly string[]
}

const DESTROY_STEPS: readonly string[] = [
  'Record the failing unit id, the SQLSTATE and the full server message in the run log. The next attempt is only better than this one if it knows what happened.',
  'Confirm the project ref you are about to delete against the sentinel row if one exists, and against the dashboard if one does not. This is the single most dangerous keystroke of the whole provisioning.',
  'Delete the Supabase project. Not the schemas — the project. A dropped-and-recreated schema keeps roles, extensions, grants and default privileges that a new project would not have, and those are exactly the things the baseline assumes it is meeting for the first time.',
  'Create a new project, re-run CHECKPOINT A0 read-only, and fill the new project ref everywhere the old one appears.',
  'Restart at PHASE_BASELINE, unit 1.',
]

/**
 * Decides. Deliberately a pure function over a described situation rather than a
 * runbook section, so the attack matrix can assert that the dangerous inputs
 * reach the conservative answers.
 */
export function decideRecovery(situation: RecoverySituation): RecoveryDecision {
  // (0) Anything not applied inside one transaction is outside this table's
  //     competence. Without atomicity we cannot say whether the unit left half
  //     of itself behind, and every other branch below assumes we can.
  if (!situation.singleTransaction) {
    return {
      strategy: 'HALT_AND_ESCALATE',
      rationale:
        'The unit was not applied with psql -1, so it may have left a partial effect. Every strategy ' +
        'below depends on knowing that a failed unit left nothing, and that is now unknown.',
      steps: [
        'Stop. Run no further units.',
        'Capture the schema state read-only, in full, before anything else touches the database.',
        'Decide with a human whether the partial effect is characterisable. If it is not, the answer is DESTROY_AND_REPROVISION.',
      ],
      revisitIf: ['the partial effect turns out to be fully characterised and reversible'],
    }
  }

  // (1) Irreplaceable data outranks everything. It should never be true during a
  //     first provisioning — there is nothing to be irreplaceable yet — but a
  //     recovery table that only handles the expected case is one that gives
  //     confident wrong answers in the case that actually hurts.
  if (situation.holdsIrreplaceableData) {
    return {
      strategy: 'HALT_AND_ESCALATE',
      rationale:
        'The project holds something not reproducible from this repository. DESTROY_AND_REPROVISION is ' +
        'cheap precisely and only because nothing is lost by it, and that premise is false here.',
      steps: [
        'Stop.',
        'Establish what the irreplaceable data is and whether it should be on a staging project at all — §1 P4 says no production data, ever.',
        'Do not resume the sequence until that question has an answer.',
      ],
      revisitIf: ['the data turns out to be reproducible after all', 'the data is exported and verified restorable'],
    }
  }

  // (2) Indeterminate outcome. The one case where doing nothing is the active,
  //     correct choice — an apply whose result nobody knows is an apply whose
  //     retry could be the second half of a double application.
  if (situation.failureKind === 'indeterminate') {
    return {
      strategy: 'DESTROY_AND_REPROVISION',
      rationale:
        'The apply reported neither success nor a usable error, so whether the unit landed is unknown. ' +
        'On a populated database that would justify a careful investigation; on an empty new project it ' +
        'justifies a new project, because investigation costs more than the thing being investigated.',
      steps: DESTROY_STEPS,
      revisitIf: ['the server log later establishes exactly what ran'],
    }
  }

  // (3) Transport failures. No SQL reached the server, so the target is exactly
  //     where it was. This is the one situation where a plain retry is right,
  //     and it is right regardless of the unit's reapply class — because the
  //     unit did not run.
  if (situation.failureKind === 'transport') {
    return {
      strategy: 'RETRY_UNIT',
      rationale:
        'The connection failed before the server committed anything, so the target is unchanged. Retrying ' +
        'the same unit is not a second application — it is the first one.',
      steps: [
        'Re-probe the target read-only and confirm the failed unit is genuinely absent. A transport error during COMMIT looks identical to one before it.',
        'If it is absent, re-run exactly that unit with psql -1.',
        'If it is PRESENT, the commit succeeded and the transport failed afterwards: resume at the NEXT unit instead.',
      ],
      revisitIf: [
        'the re-probe shows the unit partially present, which under psql -1 should be impossible and therefore means the -1 was not actually used',
      ],
    }
  }

  // (4) A statement error in PHASE_BASELINE. The main line of this whole module.
  if (situation.phase === 'PHASE_BASELINE') {
    const position = BASELINE_ORDER.indexOf(situation.failedUnit)
    const isFirst = position === 0
    let idempotent = false
    try {
      idempotent = baselineUnit(situation.failedUnit).reapply === 'idempotent'
    } catch {
      // An unknown unit id is itself a reason not to improvise.
      return {
        strategy: 'HALT_AND_ESCALATE',
        rationale: `${situation.failedUnit} is not a unit of the baseline manifest. Something outside the fifty ran.`,
        steps: ['Stop.', 'Establish what was applied and by whom before touching the target again.'],
        revisitIf: ['the unit is identified and added to the manifest'],
      }
    }

    if (isFirst && !situation.manualWritesOccurred) {
      return {
        strategy: 'RETRY_UNIT',
        rationale:
          'The failure is on unit 1, which rolled back whole, so the target is still virgin. There is no ' +
          'partial state to inherit and fixing the cause then retrying costs nothing.',
        steps: [
          'Diagnose the SQLSTATE. A 42704 here usually means the Supabase roles are not present, which means the target is not a Supabase project.',
          'Fix the cause, then re-run PHASE_BASELINE from unit 1.',
        ],
        revisitIf: ['the retry fails for a different reason, which makes the target itself the suspect'],
      }
    }

    return {
      strategy: 'DESTROY_AND_REPROVISION',
      rationale:
        `Unit ${situation.failedUnit} (position ${position + 1} of ${BASELINE_ORDER.length}) failed after ` +
        `${position} unit(s) had already committed. The baseline has no rollback scripts and ${''}` +
        'most of it cannot be re-applied — ADD CONSTRAINT alone has no guarded form. Resuming would mean ' +
        'trusting that the ledger of what applied is exactly right about a database whose last operation ' +
        'just failed, and being wrong about that produces a staging environment that differs from the ' +
        'manifest in a way nothing downstream would detect. Recreating costs one project-create.' +
        (idempotent
          ? ' The failed unit itself is idempotent, which makes retrying IT safe — but the units before it are what make resuming unsafe.'
          : ' The failed unit is not idempotent, so even retrying it in place is not available.'),
      steps: DESTROY_STEPS,
      revisitIf: [
        'a future train adds down-migrations for the Drizzle chain, at which point ROLLBACK_SQL becomes reachable here',
        'the failure is diagnosed as environmental (wrong connection, exhausted quota) rather than as something the applied units did',
      ],
    }
  }

  // (5) Statement errors in the two Stella phases. Different answer, and the
  //     difference is not a preference: these packages HAVE rollbacks, they were
  //     written to refuse rather than half-apply, and Train 5B measured the
  //     conditions under which each one legitimately declines to revert.
  const known = HOSTED_CHAIN.includes(situation.failedUnit)
  if (!known) {
    return {
      strategy: 'HALT_AND_ESCALATE',
      rationale: `${situation.failedUnit} is not a member of the hosted chain.`,
      steps: ['Stop.', 'Establish what ran.'],
      revisitIf: [],
    }
  }

  if (situation.phase === 'PHASE_STELLA_BOOTSTRAP') {
    return {
      strategy: 'DESTROY_AND_REPROVISION',
      rationale:
        'stella_hosted_0001 creates five roles, a schema, two functions and a shim, and transfers the ' +
        'ownership of public.stella_interactions. Its rollback exists but REFUSES while any chain package ' +
        'is installed, and at this point in the sequence the baseline underneath is still a fresh, empty, ' +
        'fully reproducible corpus. Recreating is both cheaper and more certain than unwinding a ' +
        'half-established role model.',
      steps: DESTROY_STEPS,
      revisitIf: [
        'the bootstrap failed at its own precondition check having written nothing, in which case it is idempotent and convergent by design and RETRY_UNIT applies',
      ],
    }
  }

  return {
    strategy: 'ROLLBACK_SQL',
    rationale:
      'The chain packages were written with rollbacks, and with rollbacks that refuse rather than degrade: ' +
      'stella_0013 declines when the ledger already holds grounded_query rows, stella_0016 drops rather ' +
      'than reverts because reverting would republish R1, grounding_0004 announces that it reopens ' +
      'INT-CAP-002. Those refusals are information, and they are only available if the rollback is what ' +
      'runs. Destroying the project here would also discard a correct baseline and a correct bootstrap.',
    // RE-PROBE FIRST. Adversarial review A: the first instruction used to be
    // "run the failed package's rollback", and under `singleTransaction: true`
    // that package rolled back whole and left nothing — so the rollback has
    // nothing to undo and the first action at 2am pointed at the wrong object.
    // What needs unwinding, if anything, is the packages that SUCCEEDED before
    // it, and which those are is a question for a read-only probe.
    steps: [
      'Re-probe read-only FIRST. The failed package ran under psql -1, so it left nothing; what matters is which EARLIER packages committed. Do not run any rollback before you know that.',
      'Re-plan PHASE_STELLA_CHAIN with the fresh probe. The planner refuses a partial chain, so it will tell you whether the state is resumable — and resuming is cheaper and safer than unwinding.',
      'ONLY if the state is not resumable: run the rollback of the LAST SUCCESSFULLY APPLIED package, not of the one that failed. Confirm the exact filename against db/prepared/ — the naming follows the package.',
      'Read what a rollback says. A rollback that refuses is telling you something about the state; do not force past it.',
    ],
    revisitIf: [
      'the rollback itself fails, which returns the situation to indeterminate and therefore to DESTROY_AND_REPROVISION',
      'more than one package is in an unknown state',
    ],
  }
}

/**
 * The strategies, ordered by how much they assume about a database that just
 * misbehaved. Used by the docs and by a test that asserts the table never
 * answers a more-uncertain situation with a more-assuming strategy.
 */
export const RECOVERY_STRATEGIES_BY_CONFIDENCE_REQUIRED: readonly RecoveryStrategy[] = [
  'DESTROY_AND_REPROVISION',
  'HALT_AND_ESCALATE',
  'ROLLBACK_SQL',
  'RETRY_UNIT',
  'RESUME_AT_NEXT_UNIT',
]
