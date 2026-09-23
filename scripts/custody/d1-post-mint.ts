// scripts/custody/d1-post-mint.ts
//
// THE POST-MINT PATH, AS DATA AND AS A PURE EVALUATOR. Executes nothing.
//
// DAG amendment v1.0.4 splits N11's exit: its ACT exit (the mutation is
// accepted with VALID UNTIL = N09, and the value exists only in transit to
// N30) enables N30 and N12; N11 is CLOSED only when N13's KP-1 has passed on a
// session delivered from the N30 entry. This module is where that split is
// computed, so "N11 closed before the verification it requires" is a test
// failure rather than a reading of prose.
//
// It also carries the post-mint failure table (lane section 8) and the mint
// route analysis (section 9) as frozen, non-secret data, so the execution
// record can cite it and a test can pin it.

export type N11Status =
  | 'NOT_EXECUTED'
  | 'FAILED_BEFORE_ACCEPTANCE'
  | 'ACT_COMPLETE__USABILITY_PENDING'
  | 'ACT_COMPLETE__USABILITY_FAILED'
  | 'CLOSED'

export interface PostMintFacts {
  /** The credential-set mutation was issued at all. */
  readonly mutationIssued: boolean
  /** The target accepted it (management-plane success or the statement completed). */
  readonly mutationAccepted: boolean
  /** The VALID UNTIL set equals the N09 value. */
  readonly validUntilEqualsN09: boolean
  /** N30's exit: exactly one entry, post-write probe present, round trip equal. */
  readonly n30ExitMet: boolean
  /** N13 ran on a value delivered from the N30 entry by the N05 path. */
  readonly n13RanOnDeliveredValue: boolean
  /** N13's KP-1 passed (current_user = session_user = uellix_auditor, from the server). */
  readonly n13Kp1Passed: boolean
}

/** N11 under the v1.0.4 exit split. CLOSED requires N30 AND a delivered KP-1. */
export function n11Status(f: PostMintFacts): N11Status {
  if (!f.mutationIssued) return 'NOT_EXECUTED'
  if (!f.mutationAccepted || !f.validUntilEqualsN09) return 'FAILED_BEFORE_ACCEPTANCE'
  if (!f.n30ExitMet || !f.n13RanOnDeliveredValue) return 'ACT_COMPLETE__USABILITY_PENDING'
  if (!f.n13Kp1Passed) return 'ACT_COMPLETE__USABILITY_FAILED'
  return 'CLOSED'
}

export type Compensation =
  | 'NONE__NOTHING_CHANGED'
  | 'ROTATE_AGAIN_OR_PASSWORD_NULL__UNDER_A_FRESH_HUMAN_CONFIRMATION'
  | 'GOVERNED_REMOVAL_OF_THE_ENTRY_THEN_ROTATE_AGAIN_OR_PASSWORD_NULL'
  | 'GOVERNED_REMOVAL_OF_THE_ENTRY'
  | 'NONE__ENTRY_STAYS_IN_CUSTODY_UNTIL_RESUMED_OR_R'

export interface PostMintScenario {
  readonly id: string
  readonly scenario: string
  readonly state_after: string
  readonly value_location: string
  readonly compensation: Compensation
  readonly fresh_hc1_required_before_any_further_credential_mutation: true
  readonly rotate_again_mandatory: boolean | 'OWNER_DECISION'
  readonly password_null_permitted: 'AUTHORIZED_AS_N11_COMPENSATION__CONFIRMATION_REQUIREMENT_UNRESOLVED_NB8'
  readonly why: string
}

const PN = 'AUTHORIZED_AS_N11_COMPENSATION__CONFIRMATION_REQUIREMENT_UNRESOLVED_NB8' as const

/**
 * Every row fails closed. Two facts decide most of them:
 *
 *   HC-1 is spent when its act completes or its lane stops, so ANY further
 *   credential mutation (ROTATE AGAIN is an MR-2 credential set) needs a fresh
 *   HC-1. That is read from the HC-1 contract, not added to it.
 *
 *   N11's rollback field names two compensations, ROTATE AGAIN and PASSWORD
 *   NULL, and the PRE-HC1 certification's NB-8 records that no authority says
 *   whether PASSWORD NULL needs its own human confirmation. This table does
 *   not answer NB-8; it carries it.
 */
export const POST_MINT_SCENARIOS: readonly PostMintScenario[] = [
  {
    id: 'PM-1',
    scenario: 'Mint succeeded, deposit (N30) failed',
    state_after: 'N11 ACT_COMPLETE__USABILITY_PENDING; N30 NOT MET. A live credential exists on the target that no governed store holds.',
    value_location: 'Only in the operator process that produced it, if it is still running. It must not be copied anywhere to "save" it: a second store is exactly what the custody contract forbids.',
    compensation: 'ROTATE_AGAIN_OR_PASSWORD_NULL__UNDER_A_FRESH_HUMAN_CONFIRMATION',
    fresh_hc1_required_before_any_further_credential_mutation: true,
    rotate_again_mandatory: 'OWNER_DECISION',
    password_null_permitted: PN,
    why: 'An undeposited value can never be delivered, so it can never prove usability and never serve N13. It is an orphan credential whose only safe end is withdrawal. Whether that is a re-mint (ROTATE AGAIN, then N30 again) or PASSWORD NULL is the owner\'s choice under a fresh HC-1; if the depositor failed at STOP_N30_ENTRY_ALREADY_PRESENT, the pre-existing entry is first removed by the governed removal path and the reason recorded.',
  },
  {
    id: 'PM-2',
    scenario: 'Mint succeeded, the N13 consumer failed (not an authentication failure: resolve, identity arm A, a transport error, a query error, or KP-2)',
    state_after: 'N11 ACT_COMPLETE__USABILITY_PENDING; N30 MET; N13 FAILED with a code.',
    value_location: 'The N30 entry only. The consumer process has exited and the delivery is removed with it; the launcher zeroed its buffer.',
    compensation: 'NONE__ENTRY_STAYS_IN_CUSTODY_UNTIL_RESUMED_OR_R',
    fresh_hc1_required_before_any_further_credential_mutation: true,
    rotate_again_mandatory: false,
    password_null_permitted: PN,
    why: 'The value is in its ratified store and nowhere else, so no custody rule is broken. N13 may be re-run by a fresh delivery after the cause is fixed, because a READ-ONLY re-run is not a credential mutation. If it cannot be resumed before R, the entry is removed at R by the governed removal path and the credential is withdrawn under a fresh HC-1.',
  },
  {
    id: 'PM-3',
    scenario: 'Deposit succeeded, verification failed: N13 KP-1 reports an identity other than uellix_auditor, or authentication is refused (STOP_AUDITOR_AUTHENTICATION_FAILED)',
    state_after: 'N11 ACT_COMPLETE__USABILITY_FAILED; N30 MET; N13 STOP.',
    value_location: 'The N30 entry.',
    compensation: 'GOVERNED_REMOVAL_OF_THE_ENTRY_THEN_ROTATE_AGAIN_OR_PASSWORD_NULL',
    fresh_hc1_required_before_any_further_credential_mutation: true,
    rotate_again_mandatory: 'OWNER_DECISION',
    password_null_permitted: PN,
    why: 'Either the deposited value is not the minted one or the mint did not take. Neither is repairable by re-reading. The deposited value is removed (it is either useless or wrong), and the role\'s credential state is resolved by a fresh mutation under a fresh HC-1. A KP-1 that names a DIFFERENT role is additionally a target-identity incident and is recorded as such.',
  },
  {
    id: 'PM-4',
    scenario: 'The launcher dies (killed, crashed, host lost) while a consumer holds the value',
    state_after: 'The consumer is terminated with it by the kill-on-close job (re-measured by the topology demonstration). N30 MET; the node that was running is NOT MET.',
    value_location: 'The N30 entry. No live process: re-verified by an external observation after the kill.',
    compensation: 'NONE__ENTRY_STAYS_IN_CUSTODY_UNTIL_RESUMED_OR_R',
    fresh_hc1_required_before_any_further_credential_mutation: true,
    rotate_again_mandatory: false,
    password_null_permitted: PN,
    why: 'The delivery dies with its process tree, so no value is left set. The interrupted read-only node is re-run by a fresh delivery. OF-CUST-1 is carried: the dead launcher\'s heap held copies, and a crash dump of it would contain them; a crash dump written in that window is itself a custody incident.',
  },
  {
    id: 'PM-5',
    scenario: 'WCM cleanup (governed removal) fails at R, N24 or N28',
    state_after: 'The entry is PRESENT past its planned removal. Custody is out of contract.',
    value_location: 'The N30 entry, past R.',
    compensation: 'GOVERNED_REMOVAL_OF_THE_ENTRY_THEN_ROTATE_AGAIN_OR_PASSWORD_NULL',
    fresh_hc1_required_before_any_further_credential_mutation: true,
    rotate_again_mandatory: 'OWNER_DECISION',
    password_null_permitted: PN,
    why: 'The removal is retried by the governed path until a positive absence check holds; it is never replaced by a sweep, because the real entry is outside the sweepable namespace by construction. Independently, a value that outlived its planned removal is withdrawn on the target, because the custody guarantee it was minted under no longer holds. VALID UNTIL (E) bounds the damage, and is not a substitute for either act.',
  },
  {
    id: 'PM-6',
    scenario: 'The operator aborts after the mint and before N30 or N13 completes',
    state_after: 'As PM-1 if N30 is not met; as PM-2 if N30 is met.',
    value_location: 'As PM-1 or PM-2.',
    compensation: 'ROTATE_AGAIN_OR_PASSWORD_NULL__UNDER_A_FRESH_HUMAN_CONFIRMATION',
    fresh_hc1_required_before_any_further_credential_mutation: true,
    rotate_again_mandatory: 'OWNER_DECISION',
    password_null_permitted: PN,
    why: 'An abort is not a pause: HC-1 was spent by the act. If the value was deposited it may stay in custody until R and the lane may be resumed read-only; if it was not, PM-1 applies. Nothing about an abort authorizes writing the value anywhere else.',
  },
  {
    id: 'PM-0',
    scenario: 'The mint itself is refused by the target (STOP_CREDENTIAL_MUTATION_FAILED or STOP_AUDITOR_ROLE_ABSENT)',
    state_after: 'N11 FAILED_BEFORE_ACCEPTANCE. The role\'s credential state is what it was, UNKNOWN as declared at N11\'s prestate.',
    value_location: 'Only in the operator process that produced it; it was never valid anywhere and is discarded.',
    compensation: 'NONE__NOTHING_CHANGED',
    fresh_hc1_required_before_any_further_credential_mutation: true,
    rotate_again_mandatory: false,
    password_null_permitted: PN,
    why: 'A refused mutation changed nothing. HC-1 is still spent (its lane stopped), so a retry needs a fresh HC-1.',
  },
]

export type MintRouteVerdict =
  | 'NOT_EVIDENCED__AUTHORITY_PREFERRED'
  | 'DOCUMENTED__COMPLIANT_ONLY_UNDER_STATED_CONSTRAINTS'

export interface MintRoute {
  readonly id: 'MINT_ROUTE_A' | 'MINT_ROUTE_B'
  readonly name: 'MANAGEMENT_PLANE' | 'SQL_BOUND_PARAMETER'
  readonly verdict: MintRouteVerdict
  readonly who_performs: string
  readonly secret_transit: string
  readonly valid_until: string
  readonly rule_compliance: string
  readonly evidence: string
  readonly handoff_to_n30: string
  readonly unresolved: readonly string[]
}

export const MINT_ROUTES: readonly MintRoute[] = [
  {
    id: 'MINT_ROUTE_A',
    name: 'MANAGEMENT_PLANE',
    verdict: 'NOT_EVIDENCED__AUTHORITY_PREFERRED',
    who_performs: 'The owner, as operator, through a Supabase management surface.',
    secret_transit: 'UNKNOWN. The consulted Supabase documentation offers a dashboard password change for the postgres role only (Database Settings). For a custom LOGIN role it documents SQL with a literal (alter user ... with password ..., create role ... with login password ...). No documented management-plane operation sets a custom role password.',
    valid_until: 'UNKNOWN. No documented management operation takes a VALID UNTIL for a custom role.',
    rule_compliance: 'UNVERIFIED, NOT DISPROVEN. The authority prefers this route "precisely because it never forms a SQL statement that a server could log". Whether a management surface that edits a custom role forms such a statement internally is not documented and cannot be measured without touching the hosted plane, which this lane may not do.',
    evidence: 'Management-plane success response only, recorded by mechanism name; server-side confirmation deferred to N13 KP-1.',
    handoff_to_n30: 'The value would have to leave the management surface (a browser form or an API client) and reach the N30 depositor stdin. A browser form offers no pipe; an API client would be an operator tool not yet named.',
    unresolved: [
      'Existence of a management-plane custom-role password operation (a negative capability claim is not made; the capability is recorded as NOT EVIDENCED).',
      'Whether such an operation forms a loggable SQL literal internally.',
      'How VALID UNTIL is set through it.',
      'How the value reaches N30 stdin without a second store.',
    ],
  },
  {
    id: 'MINT_ROUTE_B',
    name: 'SQL_BOUND_PARAMETER',
    verdict: 'DOCUMENTED__COMPLIANT_ONLY_UNDER_STATED_CONSTRAINTS',
    who_performs: 'The owner, as operator, in the operator\'s own secure environment (the authority\'s words), with a SQL client able to send a BOUND parameter. NOT a repository script: "no repository script can reach a hosted target and none may be made to" in the generation clause.',
    secret_transit: 'Generated in the operator process (>= 32 bytes CSPRNG, base64url, so URL-safe in the DSN). Sent ONLY as the bound parameter of set_config(<name>, $1, true); the DDL is built by EXECUTE inside a DO block that reads it back with current_setting, per scripts/rotate-local-role-credentials.ts. The EXECUTE is wrapped in an exception handler that re-raises with SQLSTATE only, so a failing ALTER ROLE cannot carry its text into an error CONTEXT line.',
    valid_until: 'Part of the same EXECUTEd statement, as the non-secret N09 instant (E).',
    rule_compliance: 'COMPLIANT with the set_config bound-parameter clause and with section 10 of this lane (no literal in SQL editor text, chat, repo, history, argv or logs) PROVIDED the constraints hold. Residuals that no authorized SQL can measure: a server-side audit facility that records NESTED statements (pg_stat_statements with track = all, or an audit extension logging role statements) would record the EXECUTEd text; the authorized P1 read list contains no read of those settings.',
    evidence: 'The DO block text (no value), the completion status, VALID UNTIL by value, and N13 KP-1 as the usability proof.',
    handoff_to_n30: 'The same operator process that bound the parameter composes the auditor DSN (role uellix_auditor, the direct database host of the pinned project, port 5432, database postgres) and writes it to the N30 depositor stdin pipe, then discards it. No file, clipboard, password manager or environment variable in between: each would be a second store.',
    unresolved: [
      'The operator tool that performs generation + bound-parameter execution + the pipe to N30 is not named by any authority and cannot be a repository script.',
      'The privileged session the operator uses to issue the DO block is itself a credential (not uellix_auditor) whose custody this lane does not govern.',
      'The nested-statement audit residual above.',
    ],
  },
]

export const MINT_ROUTE_DECISION_STATUS = 'OWNER_DECISION_REQUIRED_MINT_ROUTE' as const
