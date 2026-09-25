// db/custody/n05-control-state.ts
//
// THE N05 EVIDENCE RECORD, AS A TYPE, AND THE TRI-STATE THAT MAKES A SKIPPED
// CONTROL IMPOSSIBLE TO REPORT AS A PASS.
//
// ---------------------------------------------------------------------------
// WHY A THIRD STATE EXISTS
// ---------------------------------------------------------------------------
// The N05 test manifest names NM1 as the most important mutation control it
// carries, and its subject is this repository's own established idiom. Every
// CI runner here is ubuntu-latest; the Windows-only controls cannot execute on
// any of them; and `describe.skipIf` would make a skipped control and a
// passing control produce the same green summary line, on the only runner that
// exists, for the only conditions whose behaviour actually matters.
//
// A boolean cannot express the difference, so this module does not use one. A
// control is PASSED, FAILED or NOT_RUN, `isSatisfied` is total over all three,
// and it returns true for exactly one of them. There is no code path by which
// a control that did not execute contributes to a satisfied aggregate, because
// there is no representation in which it could.
//
// The same reasoning is why `summarizeN05Controls` returns NOT_SATISFIED —
// never SATISFIED — for a record with any NOT_RUN control, and why it reports
// the NOT_RUN ids rather than a count. RC-1's standard of proof asks whether
// an independent reader could tell two demonstrations apart; a bare count
// cannot answer that and a list can.

/**
 * A control outcome. Deliberately not a boolean, and deliberately not
 * `boolean | undefined` — an optional boolean reads as false at every call
 * site that forgets to check, which is the failure this type exists to make
 * unrepresentable.
 */
export type ControlState = 'PASSED' | 'FAILED' | 'NOT_RUN'

/** Total over `ControlState`, and true for exactly one member. */
export function isSatisfied(state: ControlState): boolean {
  return state === 'PASSED'
}

/**
 * The controls this lane's demonstration is responsible for.
 *
 * NP9 through NP12 are the PLATFORM_DEPENDENT positive controls the N05 test
 * manifest declares. The five RC-derived ids that follow are the observations
 * the readiness contract requires that the manifest does not number.
 *
 * RC7_CONSUMER_SPAWNS_NO_ENV_INHERITING_CHILD is a control and not merely a
 * statement, which needs justifying because RC-7 is DISCHARGED BY STATEMENT.
 * Its own binding_status supplies the exception: the statement fires
 * STOP_SECRET_DELIVERY_NONCOMPLIANT when it "reveals a child that retains,
 * forwards or logs the value, in which case WCM-C1's own scope is breached and
 * the token fires on that ground". The first run of this demonstration
 * revealed exactly such a child, so the observation is carried as a control
 * that can fail rather than as prose a reader has to interpret.
 *
 * Three ids were added by the remediation of the independent certification's
 * blocker B-1, each because the certification showed a green result that
 * could not have been red:
 *
 *   OBS0  the process observer is proven, per run, to SEE every governed
 *         representation in both a command line and an environment block,
 *         by finding an injected fixture. RC3, NP10 and RC7 are NOT_RUN
 *         until it has.
 *   B1    the launcher-console precondition that removes the credential-
 *         bearing conhost.exe is proven able to REFUSE, on a process that
 *         really has no console.
 *   RC5   abrupt termination: a killed consumer leaves no process holding the
 *         value, and a killed depositor's vault entry is found and removed by
 *         the bounded recovery sweep. RC-5's derived gap asks for a statement;
 *         this is the statement, measured.
 */
export const N05_DEMONSTRATION_CONTROL_IDS = [
  'NP9_FRESH_SHELL_ABSENT',
  'NP10_EXTERNAL_COMMAND_LINE_CLEAN',
  'NP11_BOTH_REMOVAL_PATHS_EXERCISED',
  'NP12_ABSENCE_CHECK_PROVEN_CAPABLE_OF_FALSE',
  'RC2_CONSUMER_RESOLVED_VALUE',
  'RC3_DEPOSIT_ARGV_CLEAN',
  'RC4_HISTORY_SINKS_CLEAN',
  'RC6_VAULT_ENTRY_ABSENT_AFTER_CLEANUP',
  'RC7_CONSUMER_SPAWNS_NO_ENV_INHERITING_CHILD',
  'OBS0_OBSERVER_DETECTS_INJECTED_FIXTURE',
  'B1_CONSOLE_PRECONDITION_CAPABLE_OF_REFUSING',
  'RC5_ABRUPT_TERMINATION_RECOVERED',
] as const

export type N05ControlId = (typeof N05_DEMONSTRATION_CONTROL_IDS)[number]

export type N05ControlOutcomes = Readonly<Record<N05ControlId, ControlState>>

/**
 * The evidence record. Every field of EVIDENCE_CONTRACT.required_fields is
 * present AS A FIELD, so that its later absence is a HOLE rather than a
 * silence — the authority's own rule, carried here into a type where the
 * compiler enforces it.
 *
 * MUST_NEVER_CONTAIN is enforced structurally: there is no field of this type
 * that can hold a credential, a sentinel, a connection string, userinfo, a
 * host string, a hash, a vault handle, an entry key or a lookup token. The
 * booleans record that observations happened; they never record what was
 * observed.
 */
export interface N05EvidenceRecord {
  /** RC-1: the mechanism described by what it does, not by a product name. */
  readonly mechanism_named_by_behaviour: string
  readonly sentinel_freshly_generated: boolean
  readonly wcm_c1_fresh_shell_absent: boolean
  readonly wcm_c2_external_command_line_observation_clean: boolean
  readonly wcm_c2_processes_observed: readonly string[]
  readonly wcm_c3_history_sinks_enumerated: readonly string[]
  readonly wcm_c3_all_sinks_clean: boolean
  readonly wcm_c3_invocation_contract_enforcement: string
  readonly wcm_c4_success_path_removed: boolean
  readonly wcm_c4_failure_path_removed: boolean
  readonly wcm_c4_abrupt_termination_behaviour: string
  readonly wcm_c5_check_returned_present_when_present: boolean
  readonly wcm_c5_check_returned_absent_after_removal: boolean
  readonly child_process_topology: readonly string[]
  readonly vault_read_audit_surface: string
  readonly vault_read_audit_records_handle: boolean | 'NOT_APPLICABLE'
  readonly demonstration_preceded_MR_2: boolean
  readonly working_directory_outside_the_repository_tree: boolean
  /** The tri-state outcomes. The aggregate is derived from these, never set. */
  readonly controls: N05ControlOutcomes
}

export interface N05Summary {
  readonly overall: 'SATISFIED_CANDIDATE' | 'NOT_SATISFIED'
  readonly passed: readonly N05ControlId[]
  readonly failed: readonly N05ControlId[]
  readonly notRun: readonly N05ControlId[]
  /**
   * Why the aggregate is not SATISFIED_CANDIDATE, where it is not. Empty
   * otherwise.
   */
  readonly blockingReasons: readonly string[]
}

/**
 * Derive the aggregate. Never accepts one.
 *
 * `SATISFIED_CANDIDATE` is the strongest word available to this module and it
 * is deliberately not `SATISFIED`: whether N05 is satisfied is a certifier's
 * ruling, and a harness that could print the word would be self-certifying the
 * node its own authority forbids it to close.
 */
export function summarizeN05Controls(outcomes: N05ControlOutcomes): N05Summary {
  const passed: N05ControlId[] = []
  const failed: N05ControlId[] = []
  const notRun: N05ControlId[] = []

  for (const id of N05_DEMONSTRATION_CONTROL_IDS) {
    const state = outcomes[id]
    if (state === 'PASSED') passed.push(id)
    else if (state === 'FAILED') failed.push(id)
    else notRun.push(id)
  }

  const blockingReasons: string[] = []
  if (failed.length > 0) {
    blockingReasons.push(`${failed.length} control(s) FAILED: ${failed.join(', ')}.`)
  }
  if (notRun.length > 0) {
    blockingReasons.push(
      `${notRun.length} control(s) NOT_RUN: ${notRun.join(', ')}. ` +
        'A control that did not execute is not a control that passed.'
    )
  }

  return {
    overall: blockingReasons.length === 0 ? 'SATISFIED_CANDIDATE' : 'NOT_SATISFIED',
    passed,
    failed,
    notRun,
    blockingReasons,
  }
}

/**
 * THE CONJUNCTION IS TOTAL.
 *
 * The readiness contract states that seven of eight is a stop, not a partial
 * pass. This function exists so that statement is executable: it returns the
 * token the DAG places at N05 whenever the conjunction does not hold, and the
 * harness prints what this returns rather than a verdict of its own.
 */
export function failClosedToken(summary: N05Summary): string | null {
  return summary.overall === 'SATISFIED_CANDIDATE' ? null : 'STOP_SECRET_DELIVERY_NONCOMPLIANT'
}
