// db/hosted/authority/certification/failure-injection.ts
// COMMIT 5 — ten places a governed package can die, chosen for what they leave
// behind rather than for coverage.
//
// ---------------------------------------------------------------------------
// WHAT A FAILURE TEST IS ACTUALLY ASKING
// ---------------------------------------------------------------------------
// Not "does psql report an error". It will. The question is what the CATALOG
// holds afterwards, and the answers that matter are the ones a reviewer would
// otherwise assume:
//
//   * a temporary membership opened at statement 3 and never revoked, because
//     the package died at statement 4;
//   * a `GRANT CREATE ON SCHEMA` that survived;
//   * a function left owned by the capability role while the rest of the
//     package that depended on that transfer never ran;
//   * `SET ROLE` still in force for whatever the session does next.
//
// PostgreSQL rolls back DDL, memberships and ACL changes inside a transaction,
// so under `psql -1` the expected answer is "nothing survives". That is exactly
// why it has to be MEASURED: the whole apply contract rests on it, the contract
// is one `-1` away from not holding, and "transactional DDL" is the kind of
// belief that is right until the one statement where it is not.
//
// ---------------------------------------------------------------------------
// WHY THE ANCHOR IS AN EXACT LINE AND NOT A REGEX
// ---------------------------------------------------------------------------
// An injection that lands somewhere other than where it claims produces a
// result about a different failure point, reported under this one's name. So an
// anchor is the exact text of one emitted line, its occurrence is counted, and a
// mismatch REFUSES. When the generator changes, these break loudly instead of
// quietly relocating.

/**
 * The minimum an injection needs to be placed and attributed.
 *
 * Split out in Commit 5.3 so the prechain remediation's R1..R9 can use the SAME
 * anchor discipline — exact line, counted occurrence, refuse on drift — without
 * pretending to be a chain package with a `fromSnapshot`. One placement
 * implementation, two catalogues of failure points; a second `injectFailure`
 * would be a second place for the anchor rule to be almost right.
 */
export interface AnchoredInjection {
  readonly id: string
  /** What the injection is FOR, in a refusal a human has to act on. */
  readonly packageId: string
  /** The exact trimmed text of the emitted line to inject AFTER. */
  readonly anchor: string
  /** 1-based. Several packages emit the same line more than once. */
  readonly occurrence: number
}

export interface FailureInjection extends AnchoredInjection {
  readonly description: string
  /**
   * Which snapshot the instance starts from: after bootstrap, after T7, or
   * after T9.
   *
   * `T9` arrived with M-8. Its package republishes a routine T1 created and T1
   * transferred, so the state it needs is "the whole recovered chain applied" —
   * and the point of running it from a snapshot rather than from bootstrap is
   * that a rollback which restored the ROUTINE but not the nine packages around
   * it would still read as clean against an empty database.
   */
  readonly fromSnapshot: 'bootstrap' | 'T7' | 'T9'
  /** What the state at that point is, for the report. */
  readonly authorityStateAtInjection: string
}

/** The marker every injected failure raises, so it cannot be confused with a real one. */
export const INJECTION_MARKER = 'UELLIX_CERT_INJECTED_FAILURE'

export const FAILURE_INJECTIONS: readonly FailureInjection[] = [
  {
    id: 'F1',
    description: 'dies immediately after the temporary transfer membership is opened',
    packageId: 'T1',
    fromSnapshot: 'bootstrap',
    anchor: 'GRANT uellix_cap_grounding TO uellix_owner WITH INHERIT FALSE, SET TRUE;',
    occurrence: 1,
    authorityStateAtInjection: 'uellix_owner may become uellix_cap_grounding; installer not yet elevated',
  },
  {
    id: 'F2',
    description: 'dies after SET ROLE uellix_owner inside the transfer segment',
    packageId: 'T1',
    fromSnapshot: 'bootstrap',
    anchor: 'SET ROLE uellix_owner;',
    occurrence: 5,
    authorityStateAtInjection: 'elevated as uellix_owner, membership open, no CREATE yet',
  },
  {
    id: 'F3',
    description: 'dies after the temporary GRANT CREATE ON SCHEMA',
    packageId: 'T1',
    fromSnapshot: 'bootstrap',
    anchor: 'GRANT CREATE ON SCHEMA uellix_grounding TO uellix_cap_grounding;',
    occurrence: 1,
    authorityStateAtInjection: 'elevated, membership open, CREATE open on uellix_grounding',
  },
  {
    id: 'F4',
    description: 'dies after the FIRST ALTER FUNCTION ... OWNER TO, with the second unrun',
    packageId: 'T1',
    fromSnapshot: 'bootstrap',
    anchor: 'OWNER TO uellix_cap_grounding;',
    occurrence: 1,
    authorityStateAtInjection: 'one of two functions transferred; the segment is half applied',
  },
  {
    id: 'F5',
    description: 'dies mid capability segment, between two REVOKEs the window governs',
    packageId: 'T1',
    fromSnapshot: 'bootstrap',
    anchor:
      'REVOKE ALL ON FUNCTION uellix_grounding.claim_active_document_version(uuid) FROM PUBLIC;',
    occurrence: 1,
    authorityStateAtInjection: 'elevated as uellix_cap_grounding, its temporary membership open',
  },
  {
    id: 'F6',
    description: 'dies after RESET ROLE but BEFORE the temporary membership is revoked',
    packageId: 'T1',
    fromSnapshot: 'bootstrap',
    anchor: 'RESET ROLE;',
    occurrence: 5,
    authorityStateAtInjection:
      'no longer elevated, transfers committed in-transaction, membership STILL OPEN — the ' +
      'narrowest window in the whole lifecycle and the one a non-transactional apply would leak',
  },
  {
    id: 'F7',
    description: 'dies inside the W47 alternation, after the ticket half of segment two',
    packageId: 'T8',
    fromSnapshot: 'T7',
    anchor:
      'REVOKE ALL ON FUNCTION uellix_stella_ops.complete_operation_ticket(char(64), uuid, char(64), varchar(100), varchar(100), integer, jsonb) FROM PUBLIC;',
    occurrence: 1,
    authorityStateAtInjection:
      'W47.S1 (quota) closed, W47.S2 (ticket) open — four further alternations unrun',
  },
  {
    id: 'F8',
    description: 'dies inside W46.S1, before the second transfer segment opens at all',
    packageId: 'T8',
    fromSnapshot: 'T7',
    anchor: 'OWNER TO uellix_cap_stella_quota;',
    occurrence: 1,
    authorityStateAtInjection:
      'quota lifecycle open and one settle transferred; the ticket lifecycle has not started',
  },
  {
    id: 'F9',
    description: 'dies immediately after the managed ALTER ROLE rewrite',
    packageId: 'T1',
    fromSnapshot: 'bootstrap',
    anchor: 'ALTER ROLE uellix_cap_grounding NOLOGIN NOCREATEROLE NOINHERIT;',
    occurrence: 1,
    authorityStateAtInjection:
      'a role ATTRIBUTE has changed — the one kind of change a reviewer might expect to survive a ' +
      'rollback, because it is not DDL on an object',
  },
  {
    id: 'F10',
    description: 'dies after an ordinary canonical DDL statement, no authority open',
    packageId: 'T1',
    fromSnapshot: 'bootstrap',
    anchor: 'CREATE SCHEMA IF NOT EXISTS uellix_grounding AUTHORIZATION uellix_owner;',
    occurrence: 1,
    authorityStateAtInjection: 'installer, unelevated — the control case',
  },

  /* ------------------------------------------------------------------ M-8 --
   * T10 republishes a routine IN PLACE. Its two windows open and close four
   * distinct privileges, and each of the five points below is a state a
   * reviewer might otherwise assume rolls back:
   *
   *   F11  a temporary GRANT CREATE on a schema the capability does not own
   *   F12  a temporary membership, with CREATE already open
   *   F13  the function body REPLACED, mid-window, both privileges open
   *   F14  CREATE given back but the membership still open — the narrowest gap
   *   F15  the second window, which needs the membership and NOT the CREATE
   *
   * F13 is the one that matters most and the one no earlier injection covers:
   * every other package in this chain CREATES objects, so a rollback that
   * worked was visible as an object disappearing. Here the object EXISTS both
   * before and after; what must roll back is its BODY. An implementation that
   * left the new body behind would pass every "the package is absent" check in
   * this harness and would have silently applied half a repair.
   */
  {
    id: 'F11',
    description: 'dies after the temporary GRANT CREATE, before any membership is opened',
    packageId: 'T10',
    fromSnapshot: 'T9',
    anchor: 'GRANT CREATE ON SCHEMA uellix_grounding TO uellix_cap_grounding;',
    occurrence: 1,
    authorityStateAtInjection:
      'uellix_cap_grounding may CREATE in a schema it does not own; no membership open, nothing elevated',
  },
  {
    id: 'F12',
    description: 'dies after the temporary membership, with CREATE already open',
    packageId: 'T10',
    fromSnapshot: 'T9',
    anchor: 'GRANT uellix_cap_grounding TO uellix_migrator WITH INHERIT FALSE, SET TRUE;',
    occurrence: 1,
    authorityStateAtInjection:
      'both temporary privileges open at once — the widest the installer ever is in this package',
  },
  {
    id: 'F13',
    description: 'dies after the function BODY is replaced, mid capability window',
    packageId: 'T10',
    fromSnapshot: 'T9',
    // The last line of the CREATE OR REPLACE. Anchoring on the closing `$$;`
    // rather than on the opening line is what puts the failure AFTER the
    // statement executed rather than before it.
    anchor: '$$;',
    occurrence: 1,
    authorityStateAtInjection:
      'elevated as uellix_cap_grounding, membership and CREATE both open, and claim_active_document_version now carries the advisory lock — the state whose rollback cannot be seen as an object disappearing',
  },
  {
    id: 'F14',
    description: 'dies after CREATE is given back but BEFORE the membership is revoked',
    packageId: 'T10',
    fromSnapshot: 'T9',
    anchor: 'REVOKE CREATE ON SCHEMA uellix_grounding FROM uellix_cap_grounding;',
    occurrence: 1,
    authorityStateAtInjection:
      'CREATE returned, membership STILL OPEN — the same narrow window F6 measures in T1, in a package that opens it twice',
  },
  {
    id: 'F15',
    description: 'dies inside the SECOND window, which holds a membership and no CREATE',
    packageId: 'T10',
    fromSnapshot: 'T9',
    anchor: 'SET ROLE uellix_cap_grounding;',
    occurrence: 2,
    authorityStateAtInjection:
      'elevated as uellix_cap_grounding for the COMMENT, with no schema CREATE open — the asymmetry the two-window split exists to produce',
  },
]

export class InjectionAnchorRefusal extends Error {
  constructor(detail: string) {
    super(`CERT_INJECTION_ANCHOR: ${detail}`)
    this.name = 'InjectionAnchorRefusal'
  }
}

/**
 * Inserts a raising statement after the anchor. Pure; returns new SQL.
 *
 * The failure is a `DO` block rather than a syntax error on purpose: a syntax
 * error can be reported by the PARSER before any statement executes, which
 * would make every test pass by never reaching the state it claims to test.
 * A raise inside a DO block happens at execution time, at exactly the point
 * chosen, with everything before it already applied inside the transaction.
 */
export function injectFailure(sql: string, injection: AnchoredInjection): string {
  const lines = sql.split('\n')
  const hits: number[] = []
  for (const [index, line] of lines.entries()) {
    if (line.trim() === injection.anchor) hits.push(index)
  }

  if (hits.length < injection.occurrence) {
    throw new InjectionAnchorRefusal(
      `${injection.id}: anchor ${JSON.stringify(injection.anchor)} occurs ${hits.length} time(s) in ` +
        `${injection.packageId}, and occurrence ${injection.occurrence} was requested. The generated ` +
        `artefact moved; relocating this injection silently would report a result about a different ` +
        `failure point under this one's name.`,
    )
  }

  const at = hits[injection.occurrence - 1]
  const raise = `DO $uellix_cert$ BEGIN RAISE EXCEPTION '${INJECTION_MARKER} ${injection.id}'; END $uellix_cert$;`
  return [...lines.slice(0, at + 1), raise, ...lines.slice(at + 1)].join('\n')
}
