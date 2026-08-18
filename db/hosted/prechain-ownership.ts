// db/hosted/prechain-ownership.ts
// M-2 — the identity and pin of the prechain administrative units.
//
// ---------------------------------------------------------------------------
// WHAT THE NAME SAYS AND WHAT THE REGISTRY HOLDS
// ---------------------------------------------------------------------------
// It was named for its first member, which transfers an owner. It has since
// become the registry of the CHANNEL rather than of the operation: RT-01
// publishes function bodies, RT-02 restores a table privilege contract, and
// G1-B adds a policy and a column default. None of those transfers ownership,
// and all five later units carry `normalisedFunctions: []` to say so.
//
// What every member DOES share, and what the registry actually pins:
//
//   * it is a governed SQL file, pinned here by SHA-256 over LF-normalized
//     bytes, so a byte change fails the gate rather than certifying a file
//     nobody reviewed;
//   * it is applied by the ADMINISTRATIVE hosted session, not by
//     `uellix_migrator` — which is precisely why it cannot be a chain link;
//   * it is a PREREQUISITE, so it takes no chain witness and appears in no
//     `nextChainPackage`;
//   * both certification harnesses apply every member, in order, and refuse on
//     PRECHAIN_ADMIN_PIN_MISMATCH before they do.
//
// Two things that were once true of every member and are no longer laws:
// forward-only (see `rollbackFile`), and "transfers an owner". Renaming the
// kind would churn two installed units' declarations to buy a better noun; the
// honest fix is to say what the set is, here, where the reader looks.
//
// ---------------------------------------------------------------------------
// WHY A SECOND PRECHAIN PACKAGE AND NOT AN EDIT TO THE FIRST
// ---------------------------------------------------------------------------
// `stella_hosted_0002_prechain_authority_reconciliation` is the obvious place
// to put "one more thing the installer cannot do for itself", and it is the
// wrong one, for two independent reasons that are both matters of record:
//
//   IT IS INSTALLED. artifacts/hosted-remediation-attempts.jsonl carries a
//   CONSUMED line for it against project bvyzblhqymxruxdguaee, and
//   docs/ops/staging/evidence records the post-apply witness reading INSTALLED.
//   Editing its bytes would make the installed artefact and the repository
//   disagree about what ran — the same rule that keeps baseline unit 41 and
//   grounding_0002 frozen.
//
//   ITS CONTRACT SAYS OTHERWISE. Its own pinned `purpose` ends "It creates no
//   capability role and transfers no ownership." Widening that sentence to
//   accommodate a transfer would retire the only description of the package a
//   reviewer can check it against.
//
// So this is a NEW forward-only package, which is exactly what that registry
// prescribes for a correction: "INSTALLED is never re-applied, and a correction
// is a NEW forward-only package."
//
// ---------------------------------------------------------------------------
// WHY IT REUSES THE SHAPE INSTEAD OF INVENTING A MECHANISM
// ---------------------------------------------------------------------------
// The prechain KIND is reusable and is reused verbatim: a governed SQL file,
// pinned by digest, forward-only, applied before HOSTED_CHAIN by a principal
// the chain installer is not. What is deliberately NOT reused is the ATTEMPT
// LEDGER of `remediation-attempt.ts`. That protocol exists because
// stella_hosted_0002 is a one-shot authority reconciliation with an ambiguous
// outcome — it can leave a project in a state only a fresh observation can
// classify, so it must never be blindly retried.
//
// `ALTER FUNCTION … OWNER TO` has no such outcome. It is idempotent, it is
// convergent, and re-running it against a pair that already moved is a no-op
// whose ACL is byte-identical afterwards — MEASURED on PG 17.6. A package that
// cannot be harmed by retrying does not need a mechanism whose whole purpose is
// to prevent retrying, and attaching one would be ceremony that a later reader
// would reasonably mistake for a real hazard.
//
// ---------------------------------------------------------------------------
// WHY IT IS NOT IN HOSTED_CHAIN
// ---------------------------------------------------------------------------
// Two reasons, and the second is the one that matters most.
//
//   IT IS A PREREQUISITE, NOT A LINK. The same argument prechain-remediation.ts
//   makes: a chain member acquires witnesses, appears in `nextChainPackage`,
//   and becomes something an operator can be told to apply "next".
//
//   IT IS APPLIED BY A DIFFERENT PRINCIPAL. Every link of HOSTED_CHAIN is
//   applied by `uellix_migrator`. This one cannot be — that is its entire
//   reason for existing. Counting it as a chain member would make the chain's
//   installed count a number no single identity can produce, and would quietly
//   assert that the governed installer had done something it is specifically
//   unable to do.

import { createHash } from 'node:crypto'

/** Deliberately distinct from `PreparedPackageKind` in prechain-remediation.ts. */
export type PrechainOwnershipKind = 'prechain-ownership'

export interface PrechainOwnershipPackage {
  readonly id: string
  readonly kind: PrechainOwnershipKind
  /** Repo-relative, POSIX. The file an operator applies, unmodified. */
  readonly sourceFile: string
  /** SHA-256 of the LF-normalized SQL. A byte change fails the gate. */
  readonly sourceSha256: string
  readonly purpose: string
  /**
   * WHEN this unit is applied, relative to HOSTED_CHAIN.
   *
   * G1-B ADDED THIS FIELD TOO, and the certification harness is what found the
   * need. Units 0003 to 0008 are prerequisites of T1: they are applied while
   * every chain package still measures ABSENT, which is the window
   * PRECHAIN_CLEAN asserts. stella_0020 cannot go there, and not as a matter of
   * preference — MEASURED by scripts/pg176-certify.ts, it ABORTS:
   *
   *     stella_0020 aborted: unexpected INSERT grant on
   *     public.stella_interactions held by [authenticated, service_role]
   *
   * Those grants are Supabase default privileges on the baseline table, and the
   * package that withdraws them is stella_0017 — T8, a CHAIN link. So
   * stella_0020's own dead-default proof is only satisfiable once the chain has
   * run, and applying it earlier is a refusal rather than a reordering.
   *
   * The honest fix was to record the WINDOW rather than to weaken the proof:
   * relaxing §0.4 so the package fits the loop would have traded a measured
   * security precondition for a convenient position in a list.
   */
  readonly applyWindow: 'prechain' | 'postchain'
  /**
   * The rollback script, repo-relative, or `null` when the unit is
   * forward-only.
   *
   * G1-B ADDED THIS FIELD, and the reason it did not exist before is worth
   * stating rather than patching over. Units 0003 to 0007 are all forward-only,
   * so "prechain administrative unit" and "ships no rollback" were the same set
   * and the type encoded the coincidence as a law:
   * `forwardOnlyNoRollbackReason` was required, so a unit WITH a rollback could
   * not be declared at all.
   *
   * That was never a property of the CHANNEL. It is a property of what those
   * five units do — transfer an owner, publish a hardened body, restore a
   * privilege contract the product cannot serve a request without — where
   * "restore the previous state" and "reopen the outage" are the same sentence.
   * A unit that creates ONE policy, or drops ONE column default, reverses
   * exactly and reviewably, so it ships the script.
   *
   * Exactly one of `rollbackFile` and `forwardOnlyNoRollbackReason` is non-null,
   * and the registry tripwire in tests/hosted/prechain-ownership.test.ts asserts
   * that — in both directions, because a unit declaring both would be a unit
   * whose author had not decided.
   */
  readonly rollbackFile: string | null
  /**
   * SHA-256 of the LF-normalized ROLLBACK, or `null` when there is none.
   *
   * F-4. The forward file was pinned from the first revision and the rollback
   * was not, which left the reversal path — the thing an operator reaches for
   * while something is already wrong — as the only ungoverned bytes in the
   * unit. `pnpm artefact:verify` had no digest to compare a rollback against,
   * so "the rollback I am about to run is the one that was reviewed" was a
   * hope rather than a check.
   *
   * Governed here rather than in a second registry so that one entry describes
   * one unit completely, and so the forward/rollback pair cannot drift into
   * being pinned by different mechanisms.
   */
  readonly rollbackSha256: string | null
  /** Why no `_rollback.sql` exists, or `null` when one does. */
  readonly forwardOnlyNoRollbackReason: string | null
  /**
   * The functions it normalises, by exact signature.
   *
   * Stated as data so the certification harness and the tests can assert the
   * catalog against the SAME list the SQL names, rather than against a second
   * transcription of it.
   */
  readonly normalisedFunctions: readonly string[]
  /** The role every entry above must be owned by afterwards. */
  readonly destinationOwner: string
  /** Which chain package is unblocked by it, and where it refuses without it. */
  readonly unblocks: string
}

export const PRECHAIN_OWNERSHIP: PrechainOwnershipPackage = {
  id: 'stella_hosted_0003_storage_helper_ownership',
  kind: 'prechain-ownership',
  sourceFile: 'db/prepared/stella_hosted_0003_storage_helper_ownership.sql',
  sourceSha256: '390c4fb9a4325f8ac6f4aed3dcfa8f63342d71fbfc7f5d50356c00280b49be60',
  purpose:
    'Transfers ownership of the two Storage helper functions from the role that created them on a ' +
    'managed project — postgres, because the fifty baseline units carry ownershipStatements = 0 and ' +
    'are applied as postgres — to uellix_owner, which is the posture stella_0004 produces locally ' +
    'and the one the governed chain is written against. It changes no function body, issues no ' +
    'GRANT or REVOKE, recreates no policy, creates no role and alters no membership. It also does ' +
    'NOT grant uellix_owner USAGE on schema storage: that is stella_0005d\'s question locally and ' +
    'remains open on the hosted side, and the package asserts the state rather than answering it.',
  applyWindow: 'prechain',
  rollbackFile: null,
  rollbackSha256: null,
  forwardOnlyNoRollbackReason:
    'FORWARD-ONLY, in the same shape grounding_0005 records. What it removes is the reason a ' +
    'governed package cannot be applied, so "restore the previous owner" and "make the chain ' +
    'uninstallable again" are the same sentence: stella_0019 would refuse once more, in the same ' +
    'guard, and a project that had already installed stella_0019 would be left holding a four-role ' +
    'body owned by postgres — a state neither package produces and nothing measures. A rollback ' +
    'script here would be one whose only effect is to reopen M-2, and whose correctness after ' +
    'stella_0019 had run nobody has measured. Deliberate reversal, if it were ever wanted, is a ' +
    'single administrative ALTER FUNCTION taken by the same principal that applied this, with the ' +
    'consequences visible at the time rather than encoded in advance.',
  normalisedFunctions: [
    'public.can_read_evidence_object(text,uuid)',
    'public.can_write_evidence_object(text,uuid)',
  ],
  destinationOwner: 'uellix_owner',
  unblocks:
    'stella_0019_storage_write_roles (T11), which republishes can_write_evidence_object through ' +
    'uellix_migrator -> SET ROLE uellix_owner and refuses in its §0.6 against a postgres-owned ' +
    'function. Measured: with this package applied first, the governed CREATE OR REPLACE succeeds ' +
    'as uellix_migrator with rolsuper = false and no administrative privilege of any kind.',
}

/**
 * The storage-schema USAGE grant the owner needs once it owns the helpers.
 *
 * A SEPARATE package from the ownership transfer, for the same reason
 * stella_0005d is separate from stella_0004 locally: it grants on a schema the
 * PLATFORM owns, it answers a different question, and PRECHAIN_OWNERSHIP
 * states in its own contract that it grants nothing.
 *
 * MEASURED: with the ownership transfer applied and this absent, stella_0019
 * still refuses — at its §0.7 instead of its §0.6 — because the definer bodies
 * call storage.foldername() and would answer false for every caller.
 */
export const PRECHAIN_STORAGE_USAGE: PrechainOwnershipPackage = {
  id: 'stella_hosted_0004_storage_schema_usage',
  kind: 'prechain-ownership',
  sourceFile: 'db/prepared/stella_hosted_0004_storage_schema_usage.sql',
  sourceSha256: '00071f423801df29771bd284e33e34c1c3d731d96efbd90136f57feebedb552a',
  purpose:
    'Grants uellix_owner USAGE on schema storage — one privilege, one schema — so that the '  +
    'SECURITY DEFINER bodies of the two Storage helpers can resolve storage.foldername(name) '  +
    'once uellix_owner owns them. Without it the qualified reference raises inside the definer, '  +
    'the bodies own EXCEPTION WHEN OTHERS swallows it, and every evidence object operation is '  +
    'refused silently for every role. It is the hosted counterpart of stella_0005d and asserts '  +
    'the same three facts: the USAGE is present, storage.foldername is executable, and NO table '  +
    'privilege in storage was granted. uellix_app is compared before and after and must not move.',
  applyWindow: 'prechain',
  rollbackFile: null,
  rollbackSha256: null,
  forwardOnlyNoRollbackReason:
    'FORWARD-ONLY. Revoking it re-opens the exact failure it closes — every evidence object '  +
    'operation refused, silently, for every role — on a project whose helpers uellix_owner now '  +
    'owns, so "restore the previous state" and "return the Storage surface to denying everyone '  +
    'without saying so" are the same sentence. It is also the half of the pair that cannot be '  +
    'undone independently: with ownership already moved, removing the USAGE leaves a posture '  +
    'neither the local model nor the hosted one produces. Deliberate reversal is a single '  +
    'administrative REVOKE by the same principal, with the consequence visible at the time.',
  normalisedFunctions: [],
  destinationOwner: 'uellix_owner',
  unblocks:
    'stella_0019_storage_write_roles (T11) at its §0.7 guard, which refuses to correct a role '  +
    'list over a surface that already denies everyone. Measured: with PRECHAIN_OWNERSHIP applied '  +
    'and this absent, the chain reaches 10/11 and T11 names this exact privilege.',
}

/**
 * The table-read authority the definer needs once it owns the helpers AND can
 * resolve names in schema storage.
 *
 * A THIRD package for the third time the same argument holds: it grants on a
 * different object class than either predecessor, and both of those state in
 * their own pinned contracts what they do not do — PRECHAIN_OWNERSHIP "issues no
 * GRANT or REVOKE", PRECHAIN_STORAGE_USAGE "no table privilege in storage is
 * granted". Both are also INSTALLED on the staging project, so editing either
 * would make the installed artefact and the repository disagree about what ran.
 *
 * MEASURED, and the reason the pair before it was not enough: with 0003 and
 * 0004 both applied and this absent, the helper bodies still read
 * `public.organization_members`, uellix_owner holds no SELECT on it, the read
 * raises inside the definer, and `EXCEPTION WHEN OTHERS THEN RETURN false`
 * answers false for every role on BOTH helpers. Driven through the real
 * storage.objects policies, all nine cases of the role matrix denied.
 *
 * ONE TABLE, because `public.projects` — the other relation both bodies read —
 * is already granted by stella_hosted_0001 §7, whose list is derived from what
 * the CHAIN reads and correct for that. organization_members is absent from it
 * because no chain package touches it: when that list was written the helpers
 * were owned by `postgres`, which owns both tables. stella_hosted_0003 changed
 * who executes those bodies and moved a relation into the required-read set
 * that no list recomputed.
 */
export const PRECHAIN_STORAGE_TABLE_READ: PrechainOwnershipPackage = {
  id: 'stella_hosted_0005_storage_helper_table_read',
  kind: 'prechain-ownership',
  sourceFile: 'db/prepared/stella_hosted_0005_storage_helper_table_read.sql',
  sourceSha256: '038d16303a28c7cb40de8649bc8f549b8af1dcec0925ba1a4a521a28a84e26a8',
  purpose:
    'Grants uellix_owner SELECT on public.organization_members — one privilege, one table, not ' +
    'grantable — so that the SECURITY DEFINER bodies of the two Storage helpers can execute the ' +
    'join they both run: FROM public.projects p JOIN public.organization_members om. Without it ' +
    'the read raises permission denied INSIDE the definer, the bodies own EXCEPTION WHEN OTHERS ' +
    'swallows it, and every evidence object operation is refused silently for every role on both ' +
    'the read and the write helper. public.projects is NOT granted here: stella_hosted_0001 §7 ' +
    'already issues it, and this package asserts that rather than standing in for it. It changes ' +
    'no function body, owner or ACL, recreates no policy, creates no role, alters no membership, ' +
    'and adds no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER. uellix_app and ' +
    'uellix_migrator are compared before and after and must not move, and the whole read surface ' +
    'of uellix_owner in schema public is compared as a delta that must be exactly one relation.',
  applyWindow: 'prechain',
  rollbackFile: null,
  rollbackSha256: null,
  forwardOnlyNoRollbackReason:
    'FORWARD-ONLY. Revoking it re-opens the exact outage it closes — every evidence object ' +
    'operation refused, silently, for every role, on read as well as on write — on a project ' +
    'whose helpers uellix_owner now owns and whose storage USAGE it now holds. "Restore the ' +
    'previous state" and "return the Storage surface to denying everyone without saying so" are ' +
    'the same sentence, which is the same reason stella_hosted_0004 ships none. It is also the ' +
    'third of three units that cannot be undone independently: with ownership moved and USAGE ' +
    'granted, removing this leaves a posture neither the local model nor the hosted one produces. ' +
    'Deliberate reversal is a single administrative REVOKE by the same principal, with the ' +
    'consequence visible at the time.',
  normalisedFunctions: [],
  destinationOwner: 'uellix_owner',
  unblocks:
    'stella_0019_storage_write_roles (T11) at its §0.7b guard, which refuses to correct a role ' +
    'list over a surface whose definer cannot read the relations it joins. Measured: with ' +
    'PRECHAIN_OWNERSHIP and PRECHAIN_STORAGE_USAGE applied and this absent, T11 would install and ' +
    'the role matrix would still deny all nine cases — which is why the guard exists and why ' +
    'certification now requires a FUNCTIONAL probe and not only an installed witness.',
}

/**
 * The RUNTIME half of the cutover, which the hosted path never received.
 *
 * A FOURTH package, and for the first time the argument is not "a different
 * object class" but "a different ACTOR". The prechain authority contract of
 * stella_hosted_0001 5d is derived by prechain-requirements.ts from the
 * governed chain's authority plan -- every object a non-installer EXECUTOR
 * touches -- and the executor it models is `uellix_owner`. The application
 * runtime was never in that derivation, so hosted still runs the PRE-cutover
 * helper contract: 0039_grant_rls_helper_execution.sql grants EXECUTE to
 * `authenticated` and to nobody else, which was the whole answer to "who
 * evaluates RLS" before the runtime stopped being `postgres`.
 *
 * MEASURED through the deployed application on the staging project, 2026-08-16:
 * every authenticated request answers 42501 `permission denied for function
 * current_user_is_super_admin`, raised by the check query in
 * db/identity-context.ts before any business statement runs.
 *
 * IT HARDENS AS WELL AS GRANTS, AND THE TWO CANNOT BE SPLIT. The hosted bodies
 * are SECURITY DEFINER owned by a SUPERUSER with `search_path=public` and
 * unqualified relation references; PostgreSQL searches pg_temp before any schema
 * in the path, so a caller that can `CREATE TEMP TABLE users` decides its own
 * `is_super_admin` -- the super-admin disjunct of 89 policies, computed with
 * superuser privileges. REPRODUCED on PostgreSQL 17 by
 * scripts/runtime-helper-contract-dry-run.sh, which measures `true` before the
 * package and `false` after it. Granting EXECUTE without the hardening would
 * hand that primitive to the runtime principal.
 *
 * NOT A CHAIN LINK, for the two reasons every prechain unit records: it is a
 * prerequisite rather than a step, and it is applied by a principal the chain
 * installer is not -- here necessarily so, because CREATE OR REPLACE FUNCTION
 * requires ownership and uellix_owner holds none. That same fact dissolves the
 * authority gap on `current_user_role_in_org(uuid)`, which uellix_owner cannot
 * execute at all and therefore could never have granted.
 */
export const PRECHAIN_RUNTIME_HELPER_CONTRACT: PrechainOwnershipPackage = {
  id: 'stella_hosted_0006_runtime_rls_helper_contract',
  kind: 'prechain-ownership',
  sourceFile: 'db/prepared/stella_hosted_0006_runtime_rls_helper_contract.sql',
  sourceSha256: '06514eeac2745aea962f5b22d1b6dee33c371154beb8d4fdd4418ee2fde69145',
  purpose:
    'Converges the three baseline RLS helpers - current_user_org_ids(), ' +
    'current_user_is_super_admin() and current_user_role_in_org(uuid) - to the hardened form ' +
    'db/prepared/stella_0005_runtime_cutover.sql already publishes (empty search_path with ' +
    'public.users and public.organization_members qualified), and grants EXECUTE on all three to ' +
    'uellix_writer and uellix_auditor, which is stella_0004_role_separation.sql 6b verbatim. ' +
    'uellix_app is deliberately NOT a grantee: it reaches them through its inheriting membership ' +
    'in uellix_writer, and the package asserts that EFFECTIVE privilege separately from the grant. ' +
    'It preserves every signature, SECURITY DEFINER, both owners and auth.uid() as the identity ' +
    'primitive; it grants no USAGE on schema auth, rewrites no policy, creates no role, no schema ' +
    'and no object, changes no owner and issues no REVOKE. Idempotent and post-state aware: it ' +
    'accepts an already-hardened database and REFUSES a third state rather than normalising it, ' +
    'so it can be pointed at an environment whose posture has not been measured. No project ' +
    'reference appears in it.',
  applyWindow: 'prechain',
  rollbackFile: null,
  rollbackSha256: null,
  forwardOnlyNoRollbackReason:
    'FORWARD-ONLY, and for an ASYMMETRIC reason worth stating precisely, because half of this ' +
    'package is genuinely reversible. The GRANT is: one administrative REVOKE undoes it, at the ' +
    'cost of re-opening the 42501 on every authenticated request. The HARDENING is not: restoring ' +
    'search_path=public with unqualified relation references means republishing a ' +
    'superuser-context privilege escalation, so "restore the previous body" and "republish the ' +
    'vulnerability" are the same sentence - the identical argument grounding_0005 records. A ' +
    'rollback script that reversed both would exist to reintroduce a vulnerability, and one that ' +
    'reversed only the grant would be named for something it does not do. Neither is worth ' +
    'shipping, so the reversible half is documented as an operator statement and the file is ' +
    'absent by declaration rather than by omission.',
  normalisedFunctions: [
    'public.current_user_org_ids()',
    'public.current_user_is_super_admin()',
    'public.current_user_role_in_org(uuid)',
  ],
  destinationOwner: 'postgres',
  unblocks:
    'The hosted runtime itself. With it absent, withDatabaseIdentityContext() raises 42501 before ' +
    'its first business statement, so every authenticated route fails - measured on ' +
    'dpl_Es3PkRXJ9N8QLhaqfEuDHdYbCSeG. It also closes the pg_temp shadowing escalation on the ' +
    'three helpers, which authenticated can reach on any environment that installed ' +
    '0031_rls_core.sql and 0039_grant_rls_helper_execution.sql without stella_0005.',
}

/**
 * The TABLE half of the same omission stella_hosted_0006 repaired for functions.
 *
 * A FIFTH package, and it exists because 0006 was NECESSARY BUT NOT SUFFICIENT.
 * stella_0004 §6 has four parts: §6a/§6b grant table privileges to
 * uellix_writer, §6b-bis grants EXECUTE on the three RLS helpers, and §6c gives
 * uellix_auditor SELECT. 0006 carried §6b-bis across to hosted. The other three
 * stayed behind, and MEASURED on the hosted project uellix_writer holds ZERO
 * table privileges in schema public — 0 SELECT, 0 INSERT, 0 UPDATE, 0 DELETE,
 * across all 39 tables.
 *
 * WHY IT WAS INVISIBLE UNTIL 0006 LANDED. The check query in
 * db/identity-context.ts:190 calls current_user_is_super_admin() BEFORE any
 * business statement. While the runtime lacked EXECUTE on that function every
 * request died there, so no request ever reached a table and the table-layer
 * 42501 could not be observed. Closing the first error is what made the second
 * one reachable: the F1 retest then measured `42501 permission denied for table
 * users` on both halves of the login path — the SELECT in
 * loadCurrentUserWithinContext and the INSERT ... ON CONFLICT DO UPDATE in
 * syncUserProfile (lib/auth/session.ts:303).
 *
 * IT IS NOT §6a/§6b COPIED. Two packages INSTALLED ON THE HOSTED CHAIN have
 * superseded parts of the canon since it was written, and copying it unamended
 * would regress both:
 *
 *   stella_0017 §339/§342 revokes INSERT, UPDATE, DELETE and TRUNCATE on
 *   public.stella_interactions from uellix_writer AND uellix_app (R6-INT) — the
 *   ledger is charged through the governed ticket protocol as
 *   uellix_cap_stella_quota. The amended class for that table is SELECT alone.
 *
 *   grounding_0002 and grounding_0003 revoke ALL on evidence_document_versions
 *   and evidence_chunks from uellix_writer BY NAME and grant SELECT to
 *   uellix_app DIRECTLY. Both are CAPABILITY_ONLY: this package grants nothing
 *   on them and asserts that posture instead.
 *
 * The rule it applies is one sentence: the hosted contract is stella_0004 §6,
 * amended ONLY where a package installed after it says otherwise.
 */
export const PRECHAIN_RUNTIME_TABLE_ACL: PrechainOwnershipPackage = {
  id: 'stella_hosted_0007_runtime_table_acl_contract',
  kind: 'prechain-ownership',
  sourceFile: 'db/prepared/stella_hosted_0007_runtime_table_acl_contract.sql',
  sourceSha256: 'cdfab2e126ac337d91aac32b38e87ef69baaf36c821b4a3e66ae7a8ecf98cb5e',
  purpose:
    'Restores the runtime TABLE privilege contract of stella_0004 §6a/§6b/§6c on the hosted side, ' +
    'amended only where a later INSTALLED package supersedes it. uellix_writer receives SELECT + ' +
    'INSERT on 3 append-only tables, SELECT alone on public.stella_interactions (stella_0017 ' +
    'withdrew the INSERT from every runtime principal), and SELECT + INSERT + UPDATE + DELETE on 33 ' +
    'operational tables; uellix_auditor receives SELECT on all 37 and nothing else. It grants ' +
    'NOTHING on public.evidence_chunks and public.evidence_document_versions, which grounding_0002 ' +
    'and grounding_0003 make capability-only, and NOTHING directly to uellix_app, which reaches ' +
    'every table through its inheriting membership in uellix_writer. No TRUNCATE, REFERENCES, ' +
    'TRIGGER or MAINTAIN reaches any runtime role on any table in public; no owner moves, no policy ' +
    'is created, dropped or altered, no RLS flag changes, no role is created and no schema privilege ' +
    'is granted. Idempotent and post-state aware: it accepts an already-canonical database and ' +
    'REFUSES a third state — a partial posture, an append-only widening, a structural privilege, a ' +
    'direct uellix_app grant or a runtime-owned relation — rather than normalising it. No project ' +
    'reference appears in it.',
  applyWindow: 'prechain',
  rollbackFile: null,
  rollbackSha256: null,
  forwardOnlyNoRollbackReason:
    'FORWARD-ONLY, for the reason the whole prechain trio records and this one states most ' +
    'literally: what it removes is the reason the product cannot serve a single authenticated ' +
    'request. Reverting it is one administrative REVOKE, and the consequence is total — every ' +
    'request returns to 42501 permission denied for table users, on the SELECT that loads the ' +
    'current user and on the upsert that syncs the profile, which is the state the F1 retest ' +
    'measured. "Restore the previous state" and "return the application to answering 500 for every ' +
    'logged-in user" are therefore the same sentence, and a rollback script would be one whose only ' +
    'effect is to reopen the outage. It is also the half that cannot be undone independently of ' +
    'stella_hosted_0006: with the helper EXECUTE granted and the table privileges withdrawn, the ' +
    'runtime reaches a posture neither the local model nor the hosted one produces. Deliberate ' +
    'reversal, if it were ever wanted, is a single REVOKE by the same principal, with the ' +
    'consequence visible at the time rather than encoded in advance.',
  normalisedFunctions: [],
  destinationOwner: 'postgres',
  unblocks:
    'The hosted runtime itself, on the layer stella_hosted_0006 could not reach. With it absent, ' +
    'every authenticated request fails with 42501 permission denied for table users AFTER the ' +
    'helper contract is already correct — measured on the F1 retest against ' +
    'dpl_2DcFBXoLtJFsrrs2ruo5cn9aAERm. It also restores the auditor read surface, which has been ' +
    'empty on hosted since the cutover.',
}

/**
 * G1-B — the POLICY layer of the same omission RT-01 repaired for functions and
 * RT-02 for tables.
 *
 * A SIXTH unit, and the first in this registry that ships a rollback. It also
 * carries the correction that produced this revision.
 *
 * WHAT WAS WRONG WITH ITS FIRST DRAFT. It demanded `current_user =
 * uellix_owner` and called that role "the owner of the policies on
 * public.audit_logs". Locally that is true, because stella_0004 transfers every
 * relation in `public`. On the hosted project it is false, and the catalog
 * observation the package itself quotes says so: `public.audit_logs` is owned
 * by `postgres`, because stella_hosted_0001 §399 transfers exactly ONE relation
 * and stella_hosted_0007 verifies that none moved afterwards. The package was
 * therefore UNAPPLIABLE from both sides — as uellix_owner the policy DDL raises
 * 42501, as the owner the precondition aborted — and nothing in the repository
 * would have said so before the operator window.
 *
 * WHAT REPLACES IT is the shape RT-02 already proved: MEASURE pg_class.relowner,
 * proceed directly when the administrative session IS the owner, open a
 * tightly-scoped `SET LOCAL ROLE` window when it can assume the owner, refuse by
 * name otherwise, and assert `current_user = session_user` at the end on both
 * branches. MEASURED on PostgreSQL 17.6 by
 * scripts/audit-capability-identity-dry-run.sh: both branches, the fail-closed
 * third case, idempotence, the anti-second-write-policy refusal, and an owner
 * and ACL that do not move.
 *
 * IT ALSO CARRIES A SECOND PRECONDITION THAT DRY-RUN FOUND, §0.7. `CREATE
 * POLICY` analyses its WITH CHECK at creation time and this one names
 * `auth.uid()`; on managed Supabase the `auth` schema is owned by
 * supabase_admin and admits `postgres`, not the uellix_* roles. With the table
 * moved to uellix_owner the DDL dies with `permission denied for schema auth` —
 * a second wall behind the ownership one. The package now refuses in advance,
 * naming the missing privilege.
 */
export const PRECHAIN_AUDIT_LOG_WRITE_CAPABILITY: PrechainOwnershipPackage = {
  id: 'stella_hosted_0008_audit_log_write_capability',
  kind: 'prechain-ownership',
  sourceFile: 'db/prepared/stella_hosted_0008_audit_log_write_capability.sql',
  sourceSha256: '65c1605549c1bc23b9d6862fb55b7902d9a5224e60725d3850adc6c2d99bfa96',
  purpose:
    'Creates the ONE policy the hosted runtime is missing: audit_logs_insert_member_or_admin ON ' +
    'public.audit_logs FOR INSERT TO uellix_app, carrying stella_0005c\'s WITH CHECK character for ' +
    'character — the actor bound to auth.uid(), the row bound to an organization the session belongs ' +
    'to, and a super-admin widening that does not widen the actor binding. It GRANTS NOTHING to ' +
    'anyone: stella_hosted_0007 §1 already gives uellix_writer SELECT + INSERT on the table and ' +
    'uellix_app inherits it, so the missing piece was only ever the policy. It creates no policy for ' +
    'authenticated, service_role, anon or PUBLIC, does not enable, disable or force RLS, touches no ' +
    'other table, role, trigger or policy, and TRANSFERS NO OWNERSHIP. It MEASURES the owner of ' +
    'public.audit_logs rather than naming one, issues the policy DDL under the identity PostgreSQL ' +
    'requires — directly when the administrative session is already the owner, inside a SET LOCAL ' +
    'ROLE window it closes immediately when it can assume the owner — refuses fail-closed otherwise, ' +
    'and asserts current_user = session_user, an unmoved owner and a byte-identical ACL afterwards.',
  applyWindow: 'prechain',
  rollbackFile: 'db/prepared/stella_hosted_0008_rollback.sql',
  rollbackSha256: 'c950f1ac756f15d088c5ef1b67e2cc00c7e5260caa63de6f5005317319a1af53',
  forwardOnlyNoRollbackReason: null,
  normalisedFunctions: [],
  destinationOwner: 'postgres',
  unblocks:
    'G1-B itself, at assertion R3.B of docs/ops/runbooks/G1_B_GOVERNED_PREVIEW_RUNBOOK.md §4.5: the ' +
    'certified run must leave a public.audit_logs row for action stella.invoked, and an interaction ' +
    'with no audit row is a FAIL with no appeal. With this absent the row is impossible — RLS refuses ' +
    'every append from uellix_app while the table privilege is present, which is SAFE and ' +
    'FUNCTIONALLY DEAD — and logStellaAudit is fire-and-forget by design, so the operation reports ' +
    'success while leaving no trail.',
}

/**
 * G1-B — the column default that made the DATABASE choose Stella's model.
 *
 * A SEVENTH unit, and the one whose presence here is a JUDGEMENT rather than a
 * mechanical consequence. It is recorded because a later reader will ask why a
 * plain schema delta is not in db/hosted/hosted-package-manifest.ts.
 *
 * BECAUSE THAT MANIFEST IS THE CHAIN. `HOSTED_CHAIN` is literally
 * `HOSTED_PACKAGE_MANIFEST.map(e => e.name)` and `WITNESSED_PACKAGES` is that
 * list minus the bootstrap, so an entry there is a governed chain LINK: it
 * acquires a T-number in db/hosted/authority/window-plan.ts, an authority
 * window, a witness registry entry, a `.governed.sql`, and an applying identity
 * that is `uellix_migrator` and nothing else. It would also move
 * `A1_EXPECTED_PACKAGE_COUNT`, which is `HOSTED_CHAIN.length - 1`, and thereby
 * reclassify a staging project already certified and recorded at 11/11 as
 * incomplete. None of that is a description of what this package is.
 *
 * WHAT IT IS: a prerequisite applied by the ADMINISTRATIVE session before the
 * certification runs — which is the definition this registry already carries,
 * and the definition units 0006 and 0007 already stretched past "ownership"
 * without anyone pretending the kind name still described the operation.
 *
 * ITS BODY NEEDS NO DERIVATION. No `auth` schema grant, no superuser
 * precondition, no role creation, no capability window: the canonical file IS
 * the artefact on both targets, which is why it takes a digest pin and not a
 * generation rule.
 */
export const PRECHAIN_LEDGER_MODEL_DEFAULT: PrechainOwnershipPackage = {
  id: 'stella_0020_stella_interactions_model_default',
  kind: 'prechain-ownership',
  sourceFile: 'db/prepared/stella_0020_stella_interactions_model_default.sql',
  sourceSha256: 'e19e273beffb7aab02ad0fb1d7c6bcd0517c65e95adb14989d30dca887b78ef6',
  purpose:
    'Drops the DEFAULT on public.stella_interactions.model_used, which db/migrations/0012 created as ' +
    'a retired provider model id and which is therefore a SECOND and WRONG source of truth for ' +
    'Stella\'s model target beside STELLA_DEFAULT_GEMINI_MODEL. The default is DROPPED and not ' +
    'retargeted: model_used records WHICH MODEL ANSWERED, which is a measurement, and a column ' +
    'default is the database inventing one. The column stays NOT NULL, so a writer that supplies no ' +
    'model now fails with 23502 instead of silently recording a retired id. It touches no row, no ' +
    'privilege, no policy, no trigger, no role and no owner, and it PROVES the default is unreachable ' +
    'before removing it — stella_0017 left exactly one writer, and §0.4 aborts if a second has ' +
    'appeared. It carries the same measured-owner identity contract as stella_hosted_0008 and ' +
    'asserts current_user = session_user, an unmoved owner and a byte-identical ACL afterwards.',
  applyWindow: 'postchain',
  rollbackFile: 'db/prepared/stella_0020_rollback.sql',
  rollbackSha256: 'f8a274475c08c9a5ca5093f2c128d315fccbbc546ae7489b6ee325e72f6e6da9',
  forwardOnlyNoRollbackReason: null,
  normalisedFunctions: [],
  destinationOwner: 'uellix_owner',
  unblocks:
    'G1-B assertion R3.A of docs/ops/runbooks/G1_B_GOVERNED_PREVIEW_RUNBOOK.md §4.4, which requires ' +
    'the ledger row to carry the model that actually answered. While a DEFAULT exists that value is ' +
    'not evidence of anything: it could have come from the adapter or from the database, and nothing ' +
    'in the row says which. Removing the default is what makes model_used a measurement the ' +
    'certification can cite.',
}

/**
 * All seven prechain administrative units, IN APPLICATION ORDER.
 *
 * Order is load-bearing and asserted by the packages themselves rather than by
 * whatever loop applies them: stella_hosted_0004 §0.4 refuses unless a SECURITY
 * DEFINER helper is already owned by uellix_owner, and stella_hosted_0005 §0.3
 * requires the same AND §0.4 requires the storage USAGE 0004 grants. Applying
 * any of them early is a refusal rather than a silent reordering.
 */
export const ADMINISTRATIVE_UNITS: readonly PrechainOwnershipPackage[] = [
  PRECHAIN_OWNERSHIP,
  PRECHAIN_STORAGE_USAGE,
  PRECHAIN_STORAGE_TABLE_READ,
  PRECHAIN_RUNTIME_HELPER_CONTRACT,
  // RT-02. Its §0 refuses unless the runtime can already EXECUTE the three RLS
  // helpers — the contract RT-01 publishes — because a table grant without them
  // buys nothing. The two are halves of one cutover.
  PRECHAIN_RUNTIME_TABLE_ACL,
  // G1-B. AFTER RT-02, and enforced by the package rather than by this list:
  // its §0.3 refuses unless uellix_app already holds INSERT on
  // public.audit_logs, which is the privilege RT-02 grants, and its §0.4
  // refuses unless the runtime can EXECUTE the two helpers RT-01 publishes.
  // Applying it early is a refusal, not a silent reordering. MEASURED
  // pre-chain by scripts/pg176-certify.ts: exit 0.
  PRECHAIN_AUDIT_LOG_WRITE_CAPABILITY,
  // G1-B, and the one whose WINDOW is not `prechain`. Its dead-default proof
  // refuses while authenticated and service_role still hold the baseline INSERT
  // grant on public.stella_interactions, and the package that withdraws that is
  // stella_0017 — T8, a CHAIN link. So it is applied AFTER the chain. Ordered
  // last here as well, because that is also the order the G1-B runbook gives.
  PRECHAIN_LEDGER_MODEL_DEFAULT,
]

/**
 * The units applied BEFORE the first governed statement, in application order.
 *
 * This is the window `PRECHAIN_CLEAN` describes — every chain package still
 * measuring ABSENT — so a unit whose preconditions depend on a chain package
 * cannot be in it. Derived rather than listed a second time: a hand-kept
 * duplicate is how a member ends up in one list and not the other.
 */
export const PRECHAIN_ADMINISTRATIVE_UNITS: readonly PrechainOwnershipPackage[] =
  ADMINISTRATIVE_UNITS.filter((u) => u.applyWindow === 'prechain')

/**
 * The units applied AFTER the chain is complete, in application order.
 *
 * Same principal, same pin discipline, same refusal on a digest mismatch — only
 * the window differs, and it differs because a package said so and the
 * certification harness measured it.
 */
export const POSTCHAIN_ADMINISTRATIVE_UNITS: readonly PrechainOwnershipPackage[] =
  ADMINISTRATIVE_UNITS.filter((u) => u.applyWindow === 'postchain')

// Enforced HERE, at module load, so that a wrongly-declared unit fails on the
// first import — in a certifier, in `hosted:verify`, in any suite — rather than
// at the moment an operator reaches for a rollback that turns out to have no
// governed digest. Declared after the lists so the assertion covers the exact
// array the harnesses walk.
assertAdministrativeUnitContract(ADMINISTRATIVE_UNITS)

export function sha256OfPreparedSql(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n?/g, '\n'), 'utf8').digest('hex')
}

/** A refusal code. Stable — the tests and the runbook cite it by name. */
export const ADMINISTRATIVE_UNIT_CONTRACT_VIOLATION = 'ADMINISTRATIVE_UNIT_CONTRACT_VIOLATION'

/**
 * The reversibility contract, enforced at run time rather than only by types.
 *
 * F-4A. TypeScript can express `string | null` on three fields; it cannot
 * express "exactly one side of this is populated". A DISCRIMINATED UNION could,
 * and was considered and rejected: it would restate all seven entries and every
 * consumer's field access to buy a check this function makes in nine lines —
 * turning a governance fix into a refactor, which is how a delta stops being
 * reviewable.
 *
 * So the invariant is a function, and it runs where it matters: at module load
 * over the real registry, and therefore inside both certification harnesses,
 * `pnpm hosted:verify` and every suite that imports the registry. A unit
 * declared wrongly fails at IMPORT, not at the moment an operator reaches for a
 * rollback.
 *
 * The five refusals, all measured by tests:
 *   rollbackFile without rollbackSha256   — an ungoverned reversal path
 *   rollbackSha256 without rollbackFile   — a pin for a file that is not there
 *   forward-only WITH a rollback digest   — two contradictory declarations
 *   all three null                        — a unit nobody decided about
 *   all three non-null                    — the same, said twice
 */
export function assertAdministrativeUnitContract(
  units: readonly PrechainOwnershipPackage[],
): void {
  for (const u of units) {
    const hasFile = u.rollbackFile !== null
    const hasDigest = u.rollbackSha256 !== null
    const hasReason = u.forwardOnlyNoRollbackReason !== null

    if (hasFile !== hasDigest) {
      throw new Error(
        `${ADMINISTRATIVE_UNIT_CONTRACT_VIOLATION}: ${u.id} declares rollbackFile=${String(
          u.rollbackFile,
        )} and rollbackSha256=${String(u.rollbackSha256)}. A rollback is governed by its bytes or ` +
          `it is not governed at all.`,
      )
    }
    if (hasFile === hasReason) {
      throw new Error(
        `${ADMINISTRATIVE_UNIT_CONTRACT_VIOLATION}: ${u.id} ${
          hasFile
            ? 'ships a rollback AND declares a forward-only reason'
            : 'declares neither a rollback nor a reason for not having one'
        }. Exactly one of the two must be present.`,
      )
    }
  }
}

/**
 * The forward-only reason of a unit that HAS one, refusing loudly otherwise.
 *
 * `db/hosted/forward-only-packages.ts` derives its entries from this registry so
 * that two files cannot give different reasons for one absence. Since G1-B a
 * prechain unit may legitimately ship a rollback, so that derivation has to be
 * able to fail rather than to silently carry a null into a registry whose whole
 * purpose is "there is no rollback, and here is why".
 */
export function forwardOnlyReasonOf(unit: PrechainOwnershipPackage): string {
  if (unit.forwardOnlyNoRollbackReason === null) {
    throw new Error(
      `PRECHAIN_UNIT_SHIPS_A_ROLLBACK: ${unit.id} declares ${unit.rollbackFile ?? '(none)'} ` +
        `and therefore must not be declared forward-only.`,
    )
  }
  return unit.forwardOnlyNoRollbackReason
}
