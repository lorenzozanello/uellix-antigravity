// db/hosted/forward-only-packages.ts
// M-8 — the registry of prepared packages that ship NO `_rollback.sql`, and the
// reason each one does not.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A REGISTRY AND NOT A SECOND `if` IN THE TEST
// ---------------------------------------------------------------------------
// `tests/prepared-sql-source-of-truth.test.ts` requires a rollback script for
// every forward package, and until now carried exactly one exemption. Its
// comment states the rule the exemption was written under:
//
//   "Exactly ONE exemption, and it is typed rather than spelled here … Writing
//    the filename into this test instead would make the next exemption a
//    one-line edit nobody has to justify."
//
// This is the next exemption. Adding a second `if (file === '…')` would have
// been the one-line edit that comment forbids, so the shape is generalised
// instead: the test iterates THIS list, every member has to carry a reason, and
// the reason has to be long enough that it cannot be a shrug. What was a
// property of one package is now a property of a KIND of package.
//
// ---------------------------------------------------------------------------
// WHAT "FORWARD-ONLY" MEANS HERE, AND WHAT IT DOES NOT
// ---------------------------------------------------------------------------
// It means: there is no script whose job is to put the database back. It does
// NOT mean the package is irreversible, and it does not mean a failure leaves
// debris:
//
//   PRE-COMMIT FAILURE   the transaction rolls back and PostgreSQL restores the
//                        prior posture. MEASURED, per package, by the failure
//                        injections in scripts/pg176-certify.ts — never assumed
//                        from "DDL is transactional".
//   INSTALLED            never re-applied, never downgraded. A correction is a
//                        NEW forward-only package.
//   REVERSAL             where it is genuinely wanted, it goes through the
//                        surrounding unit's own rollbacks, which were written
//                        and measured for that purpose.
//
// The distinction matters because the two are easy to conflate, and conflating
// them produces the worst artefact of all: a `_rollback.sql` written to satisfy
// a registry, whose correctness nobody measured, sitting next to a package
// whose whole argument is that the state it removed should not come back.
//
// ---------------------------------------------------------------------------
// A PRECHAIN UNIT IS NOT AUTOMATICALLY A MEMBER OF THIS LIST
// ---------------------------------------------------------------------------
// Every prechain administrative unit was forward-only until G1-B, which is a
// fact about what those five units DO — reopening any of them reopens an outage
// — and never a property of the channel. stella_hosted_0008 creates one policy
// and stella_0020 drops one column default; both reverse exactly, both ship a
// `_rollback.sql`, and neither belongs here. `forwardOnlyReasonOf` throws rather
// than carrying a null into this registry, so a unit that gained a rollback and
// was left declared forward-only fails loudly at import instead of contributing
// an empty reason to a list whose entire content is reasons.

import { PRECHAIN_REMEDIATION } from './prechain-remediation'
import {
  forwardOnlyReasonOf,
  PRECHAIN_ENTITLEMENT_EVALUATOR_OWNERSHIP,
  PRECHAIN_ENTITLEMENT_GRANTS_ACL_HARDENING,
  PRECHAIN_OWNERSHIP,
  PRECHAIN_RUNTIME_HELPER_CONTRACT,
  PRECHAIN_RUNTIME_TABLE_ACL,
  PRECHAIN_STORAGE_TABLE_READ,
  PRECHAIN_STORAGE_USAGE,
} from './prechain-ownership'

export interface ForwardOnlyPackage {
  /** Basename WITHOUT `.sql`, exactly as it appears in db/prepared/. */
  readonly id: string
  /**
   * Why undoing this is not something a script can do.
   *
   * Read by the registry tripwire, which asserts it is substantial. A short
   * reason is the failure mode this field exists to make visible: "no rollback"
   * is a decision, and a decision with a one-line justification is a decision
   * nobody made.
   */
  readonly reason: string
  /** What an operator does INSTEAD, when reversal is genuinely wanted. */
  readonly reversalPath: string
}

export const FORWARD_ONLY_PACKAGES: readonly ForwardOnlyPackage[] = [
  {
    // Derived from the prechain declaration rather than restated, so the two
    // cannot drift into giving different reasons for the same absence.
    id: PRECHAIN_REMEDIATION.id,
    reason: PRECHAIN_REMEDIATION.forwardOnlyNoRollbackReason,
    reversalPath:
      'There is none by script. An ambiguous result is classified by a fresh catalog observation; ' +
      'a correction is a new forward-only package.',
  },
  {
    id: 'grounding_0005_claim_advisory_lock',
    reason:
      'FORWARD-ONLY. What this package removes is a DEFECT, not a feature: grounding_0002 published ' +
      'claim_active_document_version taking a row lock on public.evidence_items, and PostgreSQL ' +
      'requires UPDATE on a table to take one, which uellix_cap_grounding deliberately does not ' +
      'hold. "Restore the previous version of claim_active_document_version" and "republish a lock ' +
      'no principal can take" are therefore the same sentence, and a rollback script would be one ' +
      'whose only effect is to make a governed function uncallable again — 42501 on every call, ' +
      'the governed ingestion path dead on the write side, which is exactly the state M-8 names. ' +
      'The same reasoning stella_0016 and stella_0017 record for R1 and R6-INT: a package that ' +
      'closes a vulnerability cannot ship a script that reopens it and call that a revert.',
    reversalPath:
      'The grounding unit\'s own rollbacks, in order: grounding_0004_rollback.sql, then ' +
      'grounding_0003_rollback.sql, then grounding_0002_rollback.sql. That withdraws the whole ' +
      'surface deliberately, which is the honest way to remove a function four packages depend on ' +
      '— rather than leaving a broken version of it behind.',
  },
  {
    // M-2. Derived from the prechain-ownership declaration for the same reason
    // the first entry is derived from the remediation one: two files must not
    // be able to give different reasons for the same absence.
    id: PRECHAIN_OWNERSHIP.id,
    reason: forwardOnlyReasonOf(PRECHAIN_OWNERSHIP),
    reversalPath:
      'There is none by script, and that is the point. A single administrative ' +
      '`ALTER FUNCTION public.can_read_evidence_object(text, uuid) OWNER TO postgres` and the same ' +
      'for can_write_evidence_object, issued by the principal that applied this package, restores ' +
      'the prior owner — with the consequence visible at the time: stella_0019 becomes ' +
      'uninstallable again, and any already-installed four-role body is left owned by a role the ' +
      'governed chain cannot reach.',
  },
  {
    // M-2, the SECOND OF THREE. It was written as "the second half of the
    // prechain pair", and the pair turned out not to be enough: see the entry
    // below. The package's own pinned SQL still says "pair" and is deliberately
    // NOT edited — it is audited and installed-shaped, and the correction
    // belongs where the reader looks (db/prepared/README.md), not in a rewrite
    // of the artefact. Separate from the first for the same reason stella_0005d
    // is separate from stella_0004 locally.
    id: PRECHAIN_STORAGE_USAGE.id,
    reason: forwardOnlyReasonOf(PRECHAIN_STORAGE_USAGE),
    reversalPath:
      'There is none by script. A single administrative `REVOKE USAGE ON SCHEMA storage FROM ' +
      'uellix_owner`, issued by the principal that applied this package, undoes it — and returns ' +
      'the two SECURITY DEFINER helpers to answering false for every caller, which is the ' +
      'outage stella_0005d was written to close locally.',
  },
  {
    // M-2, the third of the prechain trio. Separate from the first two for the
    // same reason they are separate from each other: a different object class,
    // and two pinned contracts that both say they do not do this.
    id: PRECHAIN_STORAGE_TABLE_READ.id,
    reason: forwardOnlyReasonOf(PRECHAIN_STORAGE_TABLE_READ),
    reversalPath:
      'There is none by script. A single administrative `REVOKE SELECT ON TABLE ' +
      'public.organization_members FROM uellix_owner`, issued by the principal that applied this ' +
      'package, undoes it — and returns both SECURITY DEFINER helpers to answering false for ' +
      'every caller on read and on write, which is the outage measured on the certification ' +
      'shape before this package existed.',
  },
  {
    // The runtime helper contract. The first entry in this registry whose two
    // halves reverse DIFFERENTLY, which is why its reason argues the asymmetry
    // instead of asserting irreversibility: the grant can be revoked, the
    // hardening must not be.
    id: PRECHAIN_RUNTIME_HELPER_CONTRACT.id,
    reason: forwardOnlyReasonOf(PRECHAIN_RUNTIME_HELPER_CONTRACT),
    reversalPath:
      'For the GRANT only, and never for the hardening: a single administrative REVOKE EXECUTE ' +
      'ON FUNCTION public.current_user_org_ids(), public.current_user_is_super_admin(), ' +
      'public.current_user_role_in_org(uuid) FROM uellix_writer, uellix_auditor, issued by the ' +
      'principal that applied this package. It returns every authenticated request to 42501, ' +
      'which is the state this package was written to leave. The hardened bodies STAY: reverting ' +
      'them would republish a pg_temp shadowing escalation that runs with the definer superuser ' +
      'privileges, and no operator statement in this repository does that.',
  },
  {
    // RT-02, the TABLE half of the same omission. Its reason is derived from
    // the prechain declaration for the same reason every entry above is: two
    // files must not be able to give different reasons for one absence.
    id: PRECHAIN_RUNTIME_TABLE_ACL.id,
    reason: forwardOnlyReasonOf(PRECHAIN_RUNTIME_TABLE_ACL),
    reversalPath:
      'There is none by script, and the consequence is the whole product. A single administrative ' +
      'REVOKE SELECT, INSERT, UPDATE, DELETE ON <the 37 contract tables> FROM uellix_writer, and ' +
      'the matching REVOKE SELECT FROM uellix_auditor, issued by the principal that applied this ' +
      'package — noting that public.stella_interactions is owned by uellix_owner and needs the same ' +
      'SET ROLE the forward package uses. It returns every authenticated request to 42501 ' +
      'permission denied for table users, which is the state the F1 retest measured and the one ' +
      'this package was written to leave behind.',
  },
  {
    // CE-3. Derived from the prechain-ownership declaration, like every hosted
    // entry above it: two files must not be able to give different reasons for
    // one absence. The distinction this entry adds to the registry is that its
    // reversal is INVISIBLE — every other reversalPath below describes an
    // observable regression (a refused install, a 42501, a helper answering
    // false). Here the schema keeps its exact shape and only a role name in
    // pg_proc.proowner differs, while the probes that would catch it are the
    // ones the reversal disables.
    id: PRECHAIN_ENTITLEMENT_EVALUATOR_OWNERSHIP.id,
    reason: forwardOnlyReasonOf(PRECHAIN_ENTITLEMENT_EVALUATOR_OWNERSHIP),
    reversalPath:
      'There is none by script, and the consequence is one nothing would report. A single ' +
      'administrative `ALTER FUNCTION public.entitlement_effective(uuid, varchar) OWNER TO ' +
      '<the prior owner>`, issued by the principal that applied this package, restores the previous ' +
      'owner — and with it the state in which the SECURITY DEFINER evaluator reads ' +
      'public.entitlement_grants under a BYPASSRLS role, so FORCE ROW LEVEL SECURITY is inert and ' +
      'the one policy CE-3 authored is never exercised. MEASURED on supabase/postgres:17.6.1.143: ' +
      'with the policy neutralised to USING (false), the reverted evaluator still answers UNMETERED ' +
      'while the uellix_owner-owned one answers NO_LIVE_GRANT. No object appears, none disappears, ' +
      'no query starts failing, and every CE-3 isolation probe keeps reporting green — which is ' +
      'exactly why this reversal is not something a script should make one command away.',
  },
  {
    // CE-3, the ACL half. Derived from the prechain-ownership declaration like
    // every hosted entry above it. The distinction this entry adds is that its
    // reversal is not merely invisible — it is a reversal that the two controls
    // CE-3 relies on are STRUCTURALLY unable to observe. The entry above turns
    // a policy inert; this one would restore a TRUNCATE that no policy and no
    // FOR EACH ROW trigger ever sees, and a read by a role row-level security
    // does not apply to at all.
    id: PRECHAIN_ENTITLEMENT_GRANTS_ACL_HARDENING.id,
    reason: forwardOnlyReasonOf(PRECHAIN_ENTITLEMENT_GRANTS_ACL_HARDENING),
    reversalPath:
      'There is none by script, and the two statements that would constitute one are the defect. ' +
      'An administrative `GRANT ALL ON TABLE public.entitlement_grants TO authenticated, ' +
      'service_role` and `GRANT EXECUTE ON FUNCTION public.entitlement_effective(uuid, varchar) TO ' +
      'anon, service_role`, issued by the principal that applied this package — noting that the ' +
      'evaluator is owned by uellix_owner after stella_hosted_0009 and needs the same SET ROLE the ' +
      'forward package uses for its own arm — restores the previous posture. It also restores a ' +
      'tenant role\'s ability to TRUNCATE the relation, which neither FORCE ROW LEVEL SECURITY nor ' +
      'trg_entitlement_grants_append_only can refuse, and a BYPASSRLS platform role\'s direct read ' +
      'of every organization\'s grants. Nothing would report it: no object changes shape, no query ' +
      'starts failing, and the CE-3 isolation and append-only probes keep reporting green because ' +
      'neither of them is a control over the privileges this package removes.',
  },
  {
    // P1A. db/prepared/stella_local_0000_local_role_identity_bootstrap.sql's
    // own header (WHY THIS PACKAGE REFUSES A SECOND APPLICATION) already
    // states the reason; this entry restates it here so the registry itself
    // — not just the SQL file's prose — carries the decision.
    id: 'stella_local_0000_local_role_identity_bootstrap',
    reason:
      'FORWARD-ONLY BY DESIGN, not by omission. This package is the LOCAL/CI pre-baseline role ' +
      'IDENTITY bootstrap: it refuses outright if any uellix_* role already exists, BEFORE any ' +
      'privilege mutation (its own §0 pristine-state precondition, E4). Unlike stella_hosted_0000 ' +
      'and stella_0001, which are convergent/idempotent by design, this package is deliberately ' +
      'NOT — the topology authority\'s own second-run contract requires a repeated bootstrap ' +
      'against a non-pristine database to be a DETERMINISTIC_SAFE_REJECTION, and the ONLY database ' +
      'this package is ever authorized to run against is a disposable container the gate script ' +
      'itself just created. A rollback script implies "undo this on the SAME database", which has ' +
      'no legitimate use case here: the only governed way to remove what this package established ' +
      'is to destroy the disposable environment and provision a genuinely fresh one, which the gate ' +
      'itself already does unconditionally on every invocation (P1A second_run_contract).',
    reversalPath:
      'There is none by script, and there must not be one. Destroy the disposable container and let ' +
      'the gate provision a fresh one — the only environment this package is ever authorized to ' +
      'target. A rollback script here would either be a no-op against a container about to be ' +
      'destroyed anyway, or an attempt to reverse state on a persistent database this package is ' +
      'never authorized to touch in the first place.',
  },
]

/** The ids, for a caller that only needs membership. */
export const FORWARD_ONLY_PACKAGE_IDS: readonly string[] = FORWARD_ONLY_PACKAGES.map((p) => p.id)

/** The declaration for one package, or `null` when it must ship a rollback. */
export function forwardOnlyPackage(id: string): ForwardOnlyPackage | null {
  return FORWARD_ONLY_PACKAGES.find((p) => p.id === id) ?? null
}
