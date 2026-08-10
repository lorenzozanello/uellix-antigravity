// db/hosted/authority/certification/remediation-failure-injection.ts
// COMMIT 5.3 — nine places the prechain remediation can die, chosen for what
// each one would leave behind if the transaction did not hold.
//
// ---------------------------------------------------------------------------
// WHY THIS PACKAGE NEEDS ROLLBACK EVIDENCE MORE THAN THE CHAIN DOES
// ---------------------------------------------------------------------------
// Every governed package has a rollback script and a witness that says whether
// it is installed. `stella_hosted_0002` has NEITHER, deliberately: undoing a
// committed authority reconciliation would mean revoking privileges the chain
// may already depend on and removing CREATEROLE from a role that may already
// have created capability roles. Commit 5.2 accepted that and defined recovery
// behaviourally — "pre-commit failure rolls back, and that is measured".
//
// It had not been measured. This is the file that makes the sentence checkable,
// and the claim it supports is narrow and load-bearing: for this package, the
// TRANSACTION is the only rollback there is. If one of these nine points leaves
// a residue, the package's whole recovery story fails with it — there is no
// script to run afterwards.
//
// ---------------------------------------------------------------------------
// WHY THESE NINE AND NOT NINE OTHERS
// ---------------------------------------------------------------------------
// Not coverage. Each point is the first statement AFTER a distinct kind of
// authority change, so the nine catalog states are materially different from
// one another:
//
//   R1  nothing mutated              the control: proves the harness would
//                                    notice if a doomed apply changed anything
//   R2  a ROLE ATTRIBUTE changed     the one change a reviewer might expect to
//                                    survive, because it is not DDL on an object
//   R3  a DATABASE-level ACL changed the only grant outside any schema
//   R4  an OBJECT ACL changed        with the other six E-01 grants unissued
//   R5  the session is ELEVATED      SET ROLE open, nothing done as the owner
//   R6  the BORROWED grant is open   the residue the package is measured on
//   R7  a FUNCTION BODY is replaced  invisible to a presence check
//   R8  elevated again, borrow open  the last point before the give-back
//   R9  borrowed grant returned      everything done, verification unrun
//
// Points R5, R6 and R8 are inside or around the one `SET ROLE uellix_owner`
// window. R6 and R8 differ by everything the owner phase does in between.
//
// ---------------------------------------------------------------------------
// THE ANCHOR IS AN EXACT LINE, AND THE OCCURRENCE IS COUNTED
// ---------------------------------------------------------------------------
// Same rule as the chain's injections, for the same reason: an injection that
// lands somewhere other than where it claims produces a result about a
// different failure point, reported under this one's name. `SET ROLE
// uellix_owner;` occurs twice in this package and `END $$;` four times, so the
// occurrence is not decoration — it is the difference between R5 and R8, and
// between R1 and R7.
//
// The remediation is PINNED, so unlike the generated chain these anchors cannot
// drift without the pin failing first. They are still counted, because a pin
// that is repinned for a good reason must not silently relocate a measurement.

import type { AnchoredInjection } from './failure-injection'
import { PRECHAIN_REMEDIATION } from '../../prechain-remediation'

export interface RemediationFailureInjection extends AnchoredInjection {
  readonly description: string
  /**
   * The authority actually open at that instant, in the words the report uses.
   *
   * Written from the SQL rather than from intent: R6 says "borrowed USAGE and
   * CREATE on uellix_bootstrap are held by postgres" because that is what the
   * catalog would show, and it is precisely what must NOT survive.
   */
  readonly authorityStateAtInjection: string
  /**
   * What a NON-transactional apply would leave behind here.
   *
   * The claim each point is testing, stated before the result so a green run
   * cannot be read as "nothing happens at this point".
   */
  readonly residueIfNotTransactional: string
}

export const REMEDIATION_FAILURE_INJECTIONS: readonly RemediationFailureInjection[] = [
  {
    id: 'R1',
    packageId: PRECHAIN_REMEDIATION.id,
    description: 'dies after §0 accepts the source state, before ALTER ROLE',
    anchor: 'END $$;',
    occurrence: 1,
    authorityStateAtInjection:
      'source state accepted; not one catalog row has been written yet',
    residueIfNotTransactional:
      'nothing. The CONTROL case — if the comparison reports drift here, the drift is in the ' +
      'harness or in the probe, not in the package, and every other R result is unreadable.',
  },
  {
    id: 'R2',
    packageId: PRECHAIN_REMEDIATION.id,
    description: 'dies immediately after the installer receives CREATEROLE',
    anchor: 'ALTER ROLE uellix_migrator WITH CREATEROLE;',
    occurrence: 1,
    authorityStateAtInjection: 'uellix_migrator holds CREATEROLE; nothing else has changed',
    residueIfNotTransactional:
      'a LOGIN role permanently able to create roles. E-02 delivered without any of the ' +
      'privileges that make it usable — the widest single change the package makes, and a role ' +
      'attribute is the kind of change a reviewer least expects a rollback to reach.',
  },
  {
    id: 'R3',
    packageId: PRECHAIN_REMEDIATION.id,
    description: 'dies after the database-level CREATE prerequisite',
    anchor: 'GRANT CREATE ON DATABASE postgres TO uellix_migrator;',
    occurrence: 1,
    authorityStateAtInjection:
      'uellix_migrator holds CREATEROLE and CREATE on the database; no object privilege issued',
    residueIfNotTransactional:
      'a surviving DATABASE ACL entry. The only grant this package makes outside any schema, and ' +
      'the only one a schema-scoped residual probe would never look at.',
  },
  {
    id: 'R4',
    packageId: PRECHAIN_REMEDIATION.id,
    description: 'dies after the FIRST E-01 grant, with the other six unissued',
    anchor:
      'GRANT EXECUTE ON FUNCTION public.current_user_org_ids() TO uellix_owner WITH GRANT OPTION;',
    occurrence: 1,
    authorityStateAtInjection:
      'uellix_owner holds EXECUTE WITH GRANT OPTION on one of eight prechain objects',
    residueIfNotTransactional:
      'a half-issued E-01 set. Exactly the shape the witness classifies ' +
      'PARTIAL_OR_INCONSISTENT — so a leak here would create, on a real project, the one state ' +
      'the package has no automatic recovery from.',
  },
  {
    id: 'R5',
    packageId: PRECHAIN_REMEDIATION.id,
    description: 'dies immediately after the owner phase opens',
    anchor: 'SET ROLE uellix_owner;',
    occurrence: 1,
    authorityStateAtInjection:
      'the session is acting as uellix_owner; the postgres phase is complete',
    residueIfNotTransactional:
      'a session left elevated. §5 check (5) refuses a package that COMMITS while still acting as ' +
      'the owner; this asks the other question — whether a package that DIES elevated leaves the ' +
      'connection holding authority nobody closed.',
  },
  {
    id: 'R6',
    packageId: PRECHAIN_REMEDIATION.id,
    description: 'dies with the borrowed schema privilege open',
    anchor: 'GRANT USAGE, CREATE ON SCHEMA uellix_bootstrap TO postgres;',
    occurrence: 1,
    authorityStateAtInjection:
      'postgres holds an EXPLICIT USAGE, CREATE on schema uellix_bootstrap — the borrow window is ' +
      'open and the give-back is four statements away',
    residueIfNotTransactional:
      'THE residue this package is measured on. uellix_bootstrap left open to postgres is the one ' +
      'outcome the borrow window exists to prevent, and the witness classifies it ' +
      'PARTIAL_OR_INCONSISTENT rather than INSTALLED precisely because a remediation can do ' +
      'everything else correctly and still leave it.',
  },
  {
    id: 'R7',
    packageId: PRECHAIN_REMEDIATION.id,
    description: 'dies after assert_hosted_capabilities is replaced by the certified body',
    anchor: 'END $$;',
    occurrence: 3,
    authorityStateAtInjection:
      'the capability contract in force is the CERTIFIED body; the borrowed privilege is still open',
    residueIfNotTransactional:
      'a replaced function body. Invisible to any check that asks whether a function of that name ' +
      'exists — which is why the source-state fingerprint hashes prosrc rather than counting rows.',
  },
  {
    id: 'R8',
    packageId: PRECHAIN_REMEDIATION.id,
    description: 'dies re-elevated, one statement before the borrowed privilege is revoked',
    anchor: 'SET ROLE uellix_owner;',
    occurrence: 2,
    authorityStateAtInjection:
      'elevated as uellix_owner for the give-back; every mutation this package makes is now in ' +
      'the transaction and the borrow is still open',
    residueIfNotTransactional:
      'the complete remediation MINUS the revoke — a project that would classify ' +
      'PARTIAL_OR_INCONSISTENT on the residue alone. The narrowest window in the package.',
  },
  {
    id: 'R9',
    packageId: PRECHAIN_REMEDIATION.id,
    description: 'dies after the borrowed privilege is returned, before self-verification',
    anchor: 'RESET ROLE;',
    occurrence: 2,
    authorityStateAtInjection:
      'every mutation applied, the borrow returned, the session unelevated — the transaction is ' +
      'one DO block away from committing a correct remediation',
    residueIfNotTransactional:
      'the ENTIRE remediation, unverified. The most dangerous point: the state is materially the ' +
      'target state, so a leak here would leave a project that looks INSTALLED and was never ' +
      'checked by §5.',
  },
]

/**
 * The nine ids, in order, as a value a test and a report can both read.
 *
 * Named rather than derived at each use so "nine materially distinct rollback
 * boundaries" is a claim the code makes and a test can refuse.
 */
export const REMEDIATION_ROLLBACK_BOUNDARIES: readonly string[] =
  REMEDIATION_FAILURE_INJECTIONS.map((i) => i.id)
