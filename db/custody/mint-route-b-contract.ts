// db/custody/mint-route-b-contract.ts
//
// THE REPOSITORY SIDE OF MINT ROUTE B. This file mints nothing, generates
// nothing and connects to nothing.
//
// Owner decisions (docs/ops/owner-ratifications/FIBDB053_D1_AUDITOR_MINT_ROUTE_OWNER_DECISION_v1.0.0.json):
//   D1_MINT_ROUTE = B_SQL_BOUND_PARAMETER
//   D1_MINT_OPERATOR_TOOL = EPHEMERAL_NODE_PG_OUTSIDE_REPOSITORY
//
// The authority forbids the live tool from being a repository script
// (SECRET_GENERATION_CONTRACT.generation_requirements.generated_where: "In the
// operator's own secure environment or by the management plane itself. NOT by
// a repository script"). So the repository holds only:
//
//   - the PINNED statements the tool must send, with the provenance of every
//     clause and the declared deltas from the precedent;
//   - the closed list of CONTRACT CLAUSES the tool must satisfy;
//   - a detector for a repository-hosted live mint script;
//   - and, in scripts/custody/d1-mint-tool-contract-harness.ts, a harness that
//     runs a candidate tool located OUTSIDE the repository against a fake
//     driver and a fake depositor and measures each clause.
//
// THE PRECEDENT. scripts/rotate-local-role-credentials.ts:222-233, which
// SECRET_GENERATION_CONTRACT.WHERE_THE_PASSWORD_MUST_NOT_TRAVEL names as the
// set_config bound-parameter pattern:
//
//   SELECT set_config('uellix.rotating_role', ${role}, true)
//   SELECT set_config('uellix.rotating_password', ${password}, true)
//   DO $rotate$ BEGIN EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L',
//     current_setting('uellix.rotating_role'),
//     current_setting('uellix.rotating_password')); END $rotate$
//
// It cannot be used verbatim for MR-2 on the hosted target, for three reasons
// the authority itself supplies. Each is a DECLARED DELTA below, for an
// independent ruling; none is silent.

export const ROUTE_B_PRECEDENT = {
  file: 'scripts/rotate-local-role-credentials.ts',
  lines: '222-233',
  format_string: 'ALTER ROLE %I LOGIN PASSWORD %L',
} as const

/** The pinned statements, as the driver sends them: bound parameters appear as $1. */
export const ROUTE_B_STATEMENTS = {
  SET_ROLE: "SELECT set_config('uellix.rotating_role', $1, true)",
  SET_PASSWORD: "SELECT set_config('uellix.rotating_password', $1, true)",
  SET_VALID_UNTIL: "SELECT set_config('uellix.rotating_valid_until', $1, true)",
  DO_BLOCK: [
    'DO $rotate$',
    'BEGIN',
    '  EXECUTE format(',
    "    'ALTER ROLE %I PASSWORD %L VALID UNTIL %L',",
    "    current_setting('uellix.rotating_role'),",
    "    current_setting('uellix.rotating_password'),",
    "    current_setting('uellix.rotating_valid_until')",
    '  );',
    'EXCEPTION WHEN OTHERS THEN',
    "  RAISE EXCEPTION USING ERRCODE = SQLSTATE, MESSAGE = 'D1_CREDENTIAL_SET_FAILED';",
    'END',
    '$rotate$',
  ].join('\n'),
} as const

/** The bound value of SET_ROLE. Fixed: MR-2 acts on one role only. */
export const ROUTE_B_ROLE = 'uellix_auditor'

/** The format string that marks a D-1 live mint (used by the detector). */
export const D1_MINT_FORMAT_MARKER = 'ALTER ROLE %I PASSWORD %L VALID UNTIL %L'

export interface RouteBDelta {
  readonly id: string
  readonly change: string
  readonly derived_from: readonly string[]
  readonly status: 'DERIVED_FROM_AUTHORITY' | 'DERIVED_SAFETY_ADDITION_UNMEASURED'
}

export const ROUTE_B_DELTAS: readonly RouteBDelta[] = [
  {
    id: 'RB-DELTA-1',
    change: 'LOGIN is removed from the format string.',
    derived_from: [
      'MUTATION_ROLLBACK_CONTRACT.MR_1_LOGIN_ATTRIBUTE: ALTER ROLE uellix_auditor LOGIN is its own mutation, under HC-3, only if P1 measured rolcanlogin = false',
      'SECRET_ROTATION_CONTRACT.what_rotation_does_NOT_do: "a rotation that also altered a privilege would be two acts wearing one name"',
      'DAG v1.0.0 N16: MR-1 is NOT REACHABLE in this DAG',
    ],
    status: 'DERIVED_FROM_AUTHORITY',
  },
  {
    id: 'RB-DELTA-2',
    change: 'VALID UNTIL %L is appended, its value carried by a third set_config bound parameter (uellix.rotating_valid_until) equal to the then-current N09.',
    derived_from: [
      'OD-3 (ratified VALID UNTIL) and DAG N11.act: "with the VALID UNTIL from N09"',
      'HC1-S4: "whether an expiry is being set, and its value"',
      'The precedent binds every value through set_config; the expiry is bound the same way so the DO block text is a fixed constant',
    ],
    status: 'DERIVED_FROM_AUTHORITY',
  },
  {
    id: 'RB-DELTA-3',
    change: 'The EXECUTE is wrapped in EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE = SQLSTATE, MESSAGE = a fixed text.',
    derived_from: [
      'WHERE_THE_PASSWORD_MUST_NOT_TRAVEL: no literal in any statement a server would log; no retained terminal output',
      'PL/pgSQL reports an error raised inside EXECUTE with a CONTEXT line quoting the executed statement, which here would carry the formatted password; a trapped error is not logged, and the re-raised one quotes only the RAISE line',
    ],
    status: 'DERIVED_SAFETY_ADDITION_UNMEASURED',
  },
]

export interface ContractClause {
  readonly id: string
  readonly clause: string
  readonly source: string
  /** The harness check that measures it, or null when it can only be stated. */
  readonly measuredBy: string | null
}

export const OPERATOR_TOOL_CONTRACT: readonly ContractClause[] = [
  { id: 'OT-1', clause: 'The tool file lives outside the repository working tree and is executed from outside it.', source: 'generated_where; owner decision D1_MINT_OPERATOR_TOOL', measuredBy: 'OUTSIDE_REPOSITORY' },
  { id: 'OT-2', clause: 'Node, with the PostgreSQL driver established by measurement (postgres@3.4.9), loaded by createRequire from an explicit driver root given as --driver-root. No package is downloaded.', source: 'lane mandate section 3/4; measured driver', measuredBy: 'SEQUENCE' },
  { id: 'OT-3', clause: 'The operator\'s privileged connection material is read from UELLIX_D1_MINT_OPERATOR_DATABASE_URL in the tool\'s own environment and removed from it before any child is spawned. HOW that variable is supplied is NOT decided here and belongs to the future execution authority.', source: 'lane mandate section 3', measuredBy: 'DEPOSITOR_ENV_CLEAN' },
  { id: 'OT-4', clause: 'The target host is INJECTED as --target-host (non-secret): the execution procedure sets it to the N04-verified direct host of the pinned project, and the harness to an RFC 6761 .invalid host, so no test names or can reach a real project. Before the driver is constructed, the privileged connection host must equal it; anything else is refused with no driver call. The N30 depositor independently refuses a production DSN that does not name the pinned staging host.', source: 'HC_1.placement (after target identity is verified BY REF); TARGET_IDENTITY; recertification nonblocker on the harness naming the real staging host', measuredBy: 'REFUSES_UNPINNED_TARGET' },
  { id: 'OT-5', clause: 'The new value is generated inside the tool: >= 32 bytes from a CSPRNG, base64url (>= 43 characters of [A-Za-z0-9_-]).', source: 'generation_requirements.entropy/encoding', measuredBy: 'SECRET_SHAPE' },
  { id: 'OT-6', clause: 'One transaction: exactly SET_ROLE, SET_PASSWORD, SET_VALID_UNTIL, DO_BLOCK, in that order, then COMMIT. The value and the expiry travel ONLY as bound parameters; no statement text contains the value.', source: 'set_config bound-parameter pattern; RB-DELTA-1..3', measuredBy: 'SEQUENCE+BOUND_ONLY' },
  { id: 'OT-7', clause: 'The expiry parameter equals the then-current N09 passed as --valid-until (strict UTC Z form).', source: 'OD-3; N09', measuredBy: 'VALID_UNTIL_EQUALS_N09' },
  { id: 'OT-8', clause: 'The built N30 depositor is spawned as a child with an argument array (no shell) and an allowlisted environment (no privileged material, no value). It receives the auditor DSN on stdin once COMMIT is acknowledged OR once the commit outcome is UNKNOWN (the value may be live, so it must be in custody); its stdin is closed empty ONLY when COMMIT was provably never requested.', source: 'DAG v1.0.4 N30_ADJACENCY_RULE; DAG v1.0.6 COMMIT_OUTCOME_MODEL.N30_CUSTODY_UNDER_COMMIT_OUTCOME_UNKNOWN', measuredBy: 'HANDOFF_AFTER_COMMIT+CANDIDATE_RETAINED_IN_CUSTODY+NO_HANDOFF_WITHOUT_COMMIT+DEPOSITOR_ARGV_CLEAN+DEPOSITOR_ENV_CLEAN' },
  { id: 'OT-9', clause: 'The value never appears in argv, a file, the tool\'s stdout or stderr, or any log.', source: 'WHERE_THE_PASSWORD_MUST_NOT_TRAVEL', measuredBy: 'OUTPUT_CLEAN+FILES_CLEAN+DEPOSITOR_ARGV_CLEAN' },
  { id: 'OT-10', clause: 'The tool prints only non-secret metadata: mint COMMITTED / NOT_COMMITTED, the depositor exit, and the depositor\'s N30 booleans.', source: 'EVIDENCE_MATERIALIZATION (mechanism name only)', measuredBy: 'OUTPUT_CLEAN' },
  { id: 'OT-12', clause: 'Commit classification: COMMITTED only on an acknowledged COMMIT; DEFINITELY_NOT_COMMITTED only when the transaction never started or the callback failed before completing; every other failure after the callback completed is COMMIT_OUTCOME_UNKNOWN, reported with STOP_COMMIT_OUTCOME_UNKNOWN__CREDENTIAL_MAY_BE_LIVE and exit code 4. The tool prints a non-secret COMMIT_REQUESTED phase line as the last act of the callback and a terminal {mint: <outcome>} line; a run with no terminal line is read as COMMIT_OUTCOME_UNKNOWN.', source: 'DAG v1.0.6 COMMIT_OUTCOME_MODEL (B-1)', measuredBy: 'CLASSIFIED_COMMITTED+CLASSIFIED_DEFINITELY_NOT_COMMITTED+CLASSIFIED_COMMIT_OUTCOME_UNKNOWN+EXIT_IS_STOP' },
  { id: 'OT-11', clause: 'The tool lets go of every reference it can (no global, no cache, process exits promptly). JavaScript strings are not zeroable; this is disclosed, not claimed.', source: 'OF-CUST-1 analogue', measuredBy: null },
]

/**
 * A repository-hosted LIVE mint script: a tracked file that carries the D-1
 * mint format string, a CSPRNG call and a driver load, and does NOT carry the
 * fake-only guard that makes a test fixture refuse any real driver.
 */
export const FAKE_ONLY_GUARD_MARKER = '__UELLIX_CONTRACT_FAKE__ !== true'

export function findRepositoryHostedLiveMintScripts(files: readonly { path: string; text: string }[]): string[] {
  return files
    .filter(
      (f) =>
        f.text.includes(D1_MINT_FORMAT_MARKER) &&
        /randomBytes|getRandomValues|randomUUID/.test(f.text) &&
        /createRequire|require\(['"]postgres['"]\)|from ['"]postgres['"]|require\(['"]pg['"]\)|from ['"]pg['"]/.test(f.text) &&
        !f.text.includes(FAKE_ONLY_GUARD_MARKER)
    )
    .map((f) => f.path)
}

// ---------------------------------------------------------------------------
// B-1: THE COMMIT OUTCOME, CLASSIFIED CONSERVATIVELY
// ---------------------------------------------------------------------------

export const COMMIT_UNKNOWN_TOKEN = 'STOP_COMMIT_OUTCOME_UNKNOWN__CREDENTIAL_MAY_BE_LIVE' as const

export type CommitOutcome = 'COMMITTED' | 'DEFINITELY_NOT_COMMITTED' | 'COMMIT_OUTCOME_UNKNOWN'

/**
 * The outcome from what the client can KNOW. postgres.js sends COMMIT after the
 * callback, outside its try: once the callback has completed, any failure may
 * have happened after the server committed. DEFINITELY_NOT_COMMITTED therefore
 * needs positive evidence that COMMIT was never requested.
 */
export function classifyCommitOutcome(e: {
  readonly transactionStarted: boolean
  readonly callbackCompleted: boolean
  readonly commitAcknowledged: boolean
}): CommitOutcome {
  if (e.commitAcknowledged) return 'COMMITTED'
  if (!e.transactionStarted) return 'DEFINITELY_NOT_COMMITTED'
  if (!e.callbackCompleted) return 'DEFINITELY_NOT_COMMITTED'
  return 'COMMIT_OUTCOME_UNKNOWN'
}

/**
 * The governed reading of a tool run from its stdout alone. Only a terminal
 * {mint: <outcome>} line is believed; a run that left none (killed, crashed,
 * aborted) is COMMIT_OUTCOME_UNKNOWN, because nothing proves COMMIT was not
 * requested.
 */
export function classifyToolRun(stdout: string): { outcome: CommitOutcome; token: string | null; carrier: 'TERMINAL_LINE' | 'NO_TERMINAL_LINE' } {
  let terminal: { mint?: unknown } | null = null
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const o = JSON.parse(line) as { mint?: unknown }
      if (typeof o.mint === 'string') terminal = o
    } catch {
      /* not a JSON line */
    }
  }
  if (terminal === null) return { outcome: 'COMMIT_OUTCOME_UNKNOWN', token: COMMIT_UNKNOWN_TOKEN, carrier: 'NO_TERMINAL_LINE' }
  const m = terminal.mint
  if (m === 'COMMITTED' || m === 'DEFINITELY_NOT_COMMITTED') return { outcome: m, token: null, carrier: 'TERMINAL_LINE' }
  return { outcome: 'COMMIT_OUTCOME_UNKNOWN', token: COMMIT_UNKNOWN_TOKEN, carrier: 'TERMINAL_LINE' }
}
