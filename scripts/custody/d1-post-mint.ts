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

// ---------------------------------------------------------------------------
// COMPENSATIONS AND THE CONFIRMATIONS THEY NEED
// ---------------------------------------------------------------------------
//
// Both compensations MR-2 names are credential mutations, and neither is ever
// executed automatically:
//
//   ROTATE_AGAIN   is an MR-2 credential set. HUMAN_CONFIRMATION.
//                  confirmations_are_not_transferable: "A confirmation is spent
//                  when its act completes or its lane stops, and a later
//                  attempt needs a new one." It needs a FRESH HC-1.
//
//   PASSWORD_NULL  (ALTER ROLE uellix_auditor PASSWORD NULL) needs its OWN
//                  explicit human confirmation: owner decision
//                  D1_PASSWORD_NULL_REQUIRES_SEPARATE_HUMAN_CONFIRMATION = YES
//                  (docs/ops/owner-ratifications/FIBDB053_D1_AUDITOR_MINT_ROUTE_OWNER_DECISION_v1.0.0.json).
//                  No HC-1, spent or fresh, stands in for it. No authority
//                  clause makes it an automatic emergency act, so the owner
//                  decision creates no contradiction.

export type CompensationAction = 'ROTATE_AGAIN' | 'PASSWORD_NULL'

export const HUMAN_CONFIRMATION_REQUIRED_PASSWORD_NULL = 'HUMAN_CONFIRMATION_REQUIRED_PASSWORD_NULL' as const
export const HUMAN_CONFIRMATION_REQUIRED_FRESH_HC1 = 'HUMAN_CONFIRMATION_REQUIRED_FRESH_HC1' as const

/** A human confirmation as recorded: which act it names, and its identity. */
export interface Confirmation {
  readonly id: string
  readonly kind: 'HC-1' | 'PASSWORD_NULL'
  readonly signed: boolean
}

export interface CompensationGate {
  readonly permitted: boolean
  readonly requires: typeof HUMAN_CONFIRMATION_REQUIRED_PASSWORD_NULL | typeof HUMAN_CONFIRMATION_REQUIRED_FRESH_HC1
  readonly reason: string
}

/**
 * May this compensation run with this confirmation? Pure, and the only gate.
 * `spent` is every confirmation id already consumed (the HC-1 at 87520a97 and
 * the mint's own HC-1 among them).
 */
export function compensationGate(params: {
  readonly action: CompensationAction
  readonly confirmation: Confirmation | null
  readonly spent: readonly string[]
}): CompensationGate {
  const c = params.confirmation
  if (params.action === 'PASSWORD_NULL') {
    const ok = c !== null && c.kind === 'PASSWORD_NULL' && c.signed && !params.spent.includes(c.id)
    return {
      permitted: ok,
      requires: HUMAN_CONFIRMATION_REQUIRED_PASSWORD_NULL,
      reason: ok ? 'Its own, unspent, signed confirmation.' : 'PASSWORD NULL needs its OWN explicit human confirmation; an HC-1 (spent or fresh) is not one.',
    }
  }
  const ok = c !== null && c.kind === 'HC-1' && c.signed && !params.spent.includes(c.id)
  return {
    permitted: ok,
    requires: HUMAN_CONFIRMATION_REQUIRED_FRESH_HC1,
    reason: ok ? 'A fresh, unspent, signed HC-1 for this rotation.' : 'ROTATE AGAIN is an MR-2 credential set and needs a FRESH HC-1; a spent one never transfers.',
  }
}

// ---------------------------------------------------------------------------
// THE POST-MINT STATES
// ---------------------------------------------------------------------------

export type CredentialExistence = 'NO_NEW_CREDENTIAL' | 'LIVE_ON_TARGET' | 'LIVE_ON_TARGET_UNUSABLE_OR_UNPROVEN'

export interface PostMintScenario {
  readonly id: string
  readonly boundary: string
  readonly scenario: string
  readonly credential: CredentialExistence
  readonly may_exist_in: readonly string[]
  readonly next: string
  /** Every credential mutation after the mint needs a fresh HC-1 (non-transferability). */
  readonly fresh_hc1_required_before_any_credential_mutation: true
  /** Is PASSWORD NULL on the table here, and if so it needs its own confirmation. */
  readonly password_null: 'NOT_APPLICABLE' | 'AVAILABLE_ONLY_UNDER_HUMAN_CONFIRMATION_REQUIRED_PASSWORD_NULL'
  /** Whether a rotation must eventually happen (never automatically). */
  readonly rotate_again: 'NOT_REQUIRED' | 'REQUIRED_UNDER_FRESH_HC1_OR_WITHDRAW' | 'REQUIRED_AT_N28_UNDER_FRESH_HC1'
  readonly automatic_credential_mutation: false
}

const PN_ONLY = 'AVAILABLE_ONLY_UNDER_HUMAN_CONFIRMATION_REQUIRED_PASSWORD_NULL' as const

/**
 * One row per failure the lane mandate names, at each boundary of the
 * ratified route (Route B tool -> N30 -> N13 -> N14 -> [N21] -> N22 -> N23 ->
 * FINAL WITNESS). Every row: no automatic credential mutation; the value is
 * never copied to "save" it; a deposited value may wait in custody until R.
 */
export const POST_MINT_SCENARIOS: readonly PostMintScenario[] = [
  {
    id: 'PM-0',
    boundary: 'Route B transaction, before COMMIT',
    scenario: 'The mint fails or is refused (STOP_CREDENTIAL_MUTATION_FAILED, STOP_AUDITOR_ROLE_ABSENT), or the operator aborts before COMMIT',
    credential: 'NO_NEW_CREDENTIAL',
    may_exist_in: ['the mint tool heap until it exits (never valid anywhere)'],
    next: 'Nothing to compensate: the transaction rolled back and the transaction-local GUC died with it. The tool closes the depositor stdin empty (harness check NO_HANDOFF_WITHOUT_COMMIT). A retry is a new MR-2 act.',
    fresh_hc1_required_before_any_credential_mutation: true,
    password_null: 'NOT_APPLICABLE',
    rotate_again: 'NOT_REQUIRED',
    automatic_credential_mutation: false,
  },
  {
    id: 'PM-1',
    boundary: 'After COMMIT, before the depositor received the value',
    scenario: 'Mint succeeded; the pipe to N30 failed (depositor did not start, died, or the write failed), or the operator aborted here',
    credential: 'LIVE_ON_TARGET_UNUSABLE_OR_UNPROVEN',
    may_exist_in: ['the target (as a verifier)', 'the mint tool heap until it exits'],
    next: 'STOP. The value is in no governed store and can never be delivered. It must not be copied anywhere to save it. Withdraw it: ROTATE AGAIN (then N30 again) under a fresh HC-1, or PASSWORD NULL under its own confirmation. The owner chooses.',
    fresh_hc1_required_before_any_credential_mutation: true,
    password_null: PN_ONLY,
    rotate_again: 'REQUIRED_UNDER_FRESH_HC1_OR_WITHDRAW',
    automatic_credential_mutation: false,
  },
  {
    id: 'PM-2',
    boundary: 'N30 write',
    scenario: 'The depositor received the value but the WCM write failed, or STOP_N30_ENTRY_ALREADY_PRESENT refused it',
    credential: 'LIVE_ON_TARGET_UNUSABLE_OR_UNPROVEN',
    may_exist_in: ['the target (as a verifier)', 'the depositor heap until it exits', 'the mint tool heap until it exits'],
    next: 'As PM-1. If the refusal was a pre-existing entry, that entry is removed by the governed removal path (by exact name) and the reason recorded, before any new deposit.',
    fresh_hc1_required_before_any_credential_mutation: true,
    password_null: PN_ONLY,
    rotate_again: 'REQUIRED_UNDER_FRESH_HC1_OR_WITHDRAW',
    automatic_credential_mutation: false,
  },
  {
    id: 'PM-3',
    boundary: 'N30 post-write probe',
    scenario: 'The write returned, but the post-write probe reported absent or the round trip differed (n30ExitMet false)',
    credential: 'LIVE_ON_TARGET_UNUSABLE_OR_UNPROVEN',
    may_exist_in: ['the target (as a verifier)', 'possibly one WCM entry with unknown content'],
    next: 'N30 is NOT met. Remove the entry by the governed removal path and verify absence positively; then as PM-1.',
    fresh_hc1_required_before_any_credential_mutation: true,
    password_null: PN_ONLY,
    rotate_again: 'REQUIRED_UNDER_FRESH_HC1_OR_WITHDRAW',
    automatic_credential_mutation: false,
  },
  {
    id: 'PM-4',
    boundary: 'N13',
    scenario: 'The N13 consumer failed without an authentication failure (resolve, arm A, transport, query, KP-2, sentinel)',
    credential: 'LIVE_ON_TARGET',
    may_exist_in: ['the WCM entry'],
    next: 'N11 stays ACT_COMPLETE__USABILITY_PENDING. Fix the cause and re-run N13 by a fresh delivery (a read is not a credential mutation). If it cannot be resumed before R: governed removal at R, then withdrawal under the matching confirmation.',
    fresh_hc1_required_before_any_credential_mutation: true,
    password_null: PN_ONLY,
    rotate_again: 'REQUIRED_AT_N28_UNDER_FRESH_HC1',
    automatic_credential_mutation: false,
  },
  {
    id: 'PM-5',
    boundary: 'N13 KP-1',
    scenario: 'Authentication refused (STOP_AUDITOR_AUTHENTICATION_FAILED) or KP-1 names another role',
    credential: 'LIVE_ON_TARGET_UNUSABLE_OR_UNPROVEN',
    may_exist_in: ['the target (as a verifier)', 'the WCM entry'],
    next: 'N11 is ACT_COMPLETE__USABILITY_FAILED. Remove the entry by the governed path (it is useless or wrong), then withdraw under the matching confirmation. A KP-1 naming a different role is also a target-identity incident.',
    fresh_hc1_required_before_any_credential_mutation: true,
    password_null: PN_ONLY,
    rotate_again: 'REQUIRED_UNDER_FRESH_HC1_OR_WITHDRAW',
    automatic_credential_mutation: false,
  },
  {
    id: 'PM-6',
    boundary: 'N14',
    scenario: 'N14 raised a STOP token, failed its session, or could not meet its exit (including the open AC-1 / AC-3 conflicts)',
    credential: 'LIVE_ON_TARGET',
    may_exist_in: ['the WCM entry'],
    next: 'STOP at N14. No mutation follows (N15..N21 are gated on N14). The value waits in custody until R, then governed removal and N28-style rotation under a fresh HC-1.',
    fresh_hc1_required_before_any_credential_mutation: true,
    password_null: PN_ONLY,
    rotate_again: 'REQUIRED_AT_N28_UNDER_FRESH_HC1',
    automatic_credential_mutation: false,
  },
  {
    id: 'PM-7',
    boundary: 'N21 / N22',
    scenario: 'A PV row FAILED (or is BLOCKED), or the MR-3 poststate failed',
    credential: 'LIVE_ON_TARGET',
    may_exist_in: ['the WCM entry'],
    next: 'N22.if_any_assertion_fails: roll back the corresponding mutation per MUTATION_ROLLBACK_CONTRACT and STOP; do NOT proceed to N23. For MR-2 the "rollback" is a compensation and needs its own confirmation; nothing is automatic.',
    fresh_hc1_required_before_any_credential_mutation: true,
    password_null: PN_ONLY,
    rotate_again: 'REQUIRED_AT_N28_UNDER_FRESH_HC1',
    automatic_credential_mutation: false,
  },
  {
    id: 'PM-8',
    boundary: 'N23 / PRECHECK',
    scenario: 'The PRECHECK consumer failed or returned a STOP token',
    credential: 'LIVE_ON_TARGET',
    may_exist_in: ['the WCM entry'],
    next: 'N24 still runs: remove the delivered value and verify absence. The PRECHECK lane decides its own continuation; the credential waits in custody until R or N28.',
    fresh_hc1_required_before_any_credential_mutation: true,
    password_null: PN_ONLY,
    rotate_again: 'REQUIRED_AT_N28_UNDER_FRESH_HC1',
    automatic_credential_mutation: false,
  },
  {
    id: 'PM-9',
    boundary: 'Any delivery',
    scenario: 'The launcher dies (killed, crashed, host lost) while a consumer holds the value',
    credential: 'LIVE_ON_TARGET',
    may_exist_in: ['the WCM entry', 'the dead launcher heap (OF-CUST-1; a crash dump written then is itself an incident)'],
    next: 'The consumer dies with the launcher\'s kill-on-close job (re-measured per consumer topology). Re-run the interrupted read-only node by a fresh delivery.',
    fresh_hc1_required_before_any_credential_mutation: true,
    password_null: PN_ONLY,
    rotate_again: 'REQUIRED_AT_N28_UNDER_FRESH_HC1',
    automatic_credential_mutation: false,
  },
  {
    id: 'PM-10',
    boundary: 'R, N24 or N28',
    scenario: 'The governed WCM removal fails',
    credential: 'LIVE_ON_TARGET',
    may_exist_in: ['the WCM entry, past R'],
    next: 'Retry the governed removal (exact name, never a sweep) until a positive absence check holds. Independently withdraw the credential on the target under the matching confirmation, because its custody guarantee no longer holds. VALID UNTIL (E) bounds the damage and substitutes for neither act.',
    fresh_hc1_required_before_any_credential_mutation: true,
    password_null: PN_ONLY,
    rotate_again: 'REQUIRED_UNDER_FRESH_HC1_OR_WITHDRAW',
    automatic_credential_mutation: false,
  },
  {
    id: 'PM-11',
    boundary: 'Between any two nodes after N30',
    scenario: 'The operator aborts after N30 and before the FINAL WITNESS',
    credential: 'LIVE_ON_TARGET',
    may_exist_in: ['the WCM entry'],
    next: 'An abort is not a pause of the HC-1: it was spent by the act. The value may stay in custody until R and read-only nodes may be resumed by fresh deliveries. At R: governed removal, then rotation or withdrawal under the matching confirmation.',
    fresh_hc1_required_before_any_credential_mutation: true,
    password_null: PN_ONLY,
    rotate_again: 'REQUIRED_AT_N28_UNDER_FRESH_HC1',
    automatic_credential_mutation: false,
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
      'RESOLVED BY OWNER DECISION D1_MINT_OPERATOR_TOOL = EPHEMERAL_NODE_PG_OUTSIDE_REPOSITORY: the tool is named, lives outside the repository, and is bound by OPERATOR_TOOL_CONTRACT (db/custody/mint-route-b-contract.ts).',
      'The privileged session the operator uses to issue the DO block is itself a credential (not uellix_auditor) whose custody this lane does not govern.',
      'The nested-statement audit residual above.',
    ],
  },
]

/**
 * The post-mint path lane recorded OWNER_DECISION_REQUIRED_MINT_ROUTE. The
 * owner has since ratified B (docs/ops/owner-ratifications/FIBDB053_D1_AUDITOR_MINT_ROUTE_OWNER_DECISION_v1.0.0.json).
 * Ratifying a route authorizes no credential act.
 */
export const MINT_ROUTE_DECISION_STATUS = 'RATIFIED_B_SQL_BOUND_PARAMETER' as const
export const MINT_ROUTE_OWNER_DECISION_FILE = 'docs/ops/owner-ratifications/FIBDB053_D1_AUDITOR_MINT_ROUTE_OWNER_DECISION_v1.0.0.json'
