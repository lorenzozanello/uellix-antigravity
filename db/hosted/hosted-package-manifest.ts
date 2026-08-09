// db/hosted/hosted-package-manifest.ts
// TRAIN 5B — the source-of-truth manifest for the managed-Supabase chain.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR
// ---------------------------------------------------------------------------
// Two jobs, and they are the same job seen from two sides:
//
//   1. It pins WHICH canonical file each hosted artefact derives from, by
//      SHA-256, so a canonical package cannot be edited without the generation
//      refusing. An operator who patches `stella_0016` and forgets the hosted
//      side gets `HOSTED_SOURCE_SHA_MISMATCH`, not a silently stale artefact.
//
//   2. It pins HOW MANY TIMES each rewrite rule must fire per package. A hash
//      alone would not catch the other direction: if somebody loosened a rule's
//      regex, the hash of the SOURCE would be unchanged and the ARTEFACT would
//      quietly gain or lose a rewrite. The counts close that.
//
// The expected objects / owners / grants are not decoration either: they are
// what the read-only hosted inspection (CHECKPOINT A) and the post-apply
// verification compare against, so that "the package applied" and "the package
// did what it claims" stay two different questions.
//
// ---------------------------------------------------------------------------
// WHAT IT DELIBERATELY DOES NOT DO
// ---------------------------------------------------------------------------
// It does not restate package ORDER rules. `db/prepared-package-order.ts` owns
// supersessions and is the registry the migrator probes; duplicating its rules
// here would create the second source of truth this whole design exists to
// avoid. `dependsOn` below is the forward chain only, and a test asserts the
// ticket portion equals STELLA_TICKET_PACKAGE_CHAIN verbatim.

import { createHash } from 'node:crypto'

/**
 * How a package reaches managed Supabase.
 *
 * `native-hosted`                  — written for managed Supabase; not derived.
 * `derived-precondition-only`      — the canonical body is already compatible;
 *                                    only the apply-time role check changes.
 * `derived-precondition-and-auth`  — the above, plus the session-actor path is
 *                                    routed through the bootstrap shim because
 *                                    schema `auth` is not grantable here.
 */
export type HostedCompatibility =
  | 'native-hosted'
  | 'derived-precondition-only'
  | 'derived-precondition-and-auth'

export interface HostedManifestEntry {
  /** Basename without `.sql`. Also the argument to assert_hosted_capabilities. */
  readonly name: string
  /** File under `db/prepared/`. For `native-hosted`, it IS the artefact. */
  readonly sourceFile: string
  /** SHA-256 of the LF-normalized canonical source. */
  readonly sourceSha256: string
  /** Exact number of times each rule must fire. Zero is a real expectation. */
  readonly expectedRewrites: Readonly<Record<string, number>>
  /** Forward chain predecessors, in chain order. */
  readonly dependsOn: readonly string[]
  /** Objects an operator must find afterwards. Compared, never assumed. */
  readonly expectedObjects: readonly string[]
  /** Roles that must own what this package publishes. */
  readonly expectedOwners: readonly string[]
  /** Grants the package is allowed to leave behind. */
  readonly expectedGrants: readonly string[]
  readonly rollbackPolicy: string
  readonly reapplyPolicy: string
  readonly hostedCompatibility: HostedCompatibility
}

/** SHA-256 over LF-normalized text, so a CRLF checkout cannot move a pin. */
export function sha256OfSql(sql: string): string {
  return createHash('sha256')
    .update(sql.replace(/\r\n?/g, '\n'), 'utf8')
    .digest('hex')
}

/** No rewrites at all — the shape a `native-hosted` entry declares. */
const NO_REWRITES = {
  'superuser-precondition': 0,
  'auth-schema-grant': 0,
  'auth-uid-precondition': 0,
  'auth-uid-call': 0,
} as const

export const HOSTED_PACKAGE_MANIFEST: readonly HostedManifestEntry[] = [
  {
    name: 'stella_hosted_0001_managed_role_bootstrap',
    sourceFile: 'stella_hosted_0001_managed_role_bootstrap.sql',
    // Re-pinned for S1-DEFECT-001: the package now grants uellix_owner CREATE
    // on schema public before it transfers the ledger's ownership to it. The
    // rewrite counts stay NO_REWRITES because nothing about the rewrite rules
    // changed — the added statements are native-hosted SQL, which is the whole
    // reason this package is `native-hosted` and not derived.
    // Re-pinned again for S1-DEFECT-002: the three REVOKEs now name anon,
    // authenticated and service_role, and §6 check (5) reads the ACL instead of
    // asking about four hardcoded principals.
    sourceSha256: '2b2df1abf1ba19411ba55b6a3a4a62653bfe784bc79977d3f24e6a6dc531d602',
    expectedRewrites: NO_REWRITES,
    dependsOn: [],
    expectedObjects: [
      'schema uellix_bootstrap',
      'function uellix_bootstrap.assert_hosted_capabilities(text)',
      'function uellix_bootstrap.hosted_capability_report()',
      'table uellix_bootstrap.staging_sentinel',
      'function public.uellix_auth_uid()',
      'role uellix_owner',
      'role uellix_migrator',
      'role uellix_app',
      'role uellix_writer',
      'role uellix_auditor',
    ],
    expectedOwners: [
      'uellix_owner owns schema uellix_bootstrap',
      'uellix_owner owns public.stella_interactions',
    ],
    expectedGrants: [
      'EXECUTE ON uellix_bootstrap.assert_hosted_capabilities(text) TO uellix_migrator',
      'EXECUTE ON public.uellix_auth_uid() TO uellix_app',
      // S1-DEFECT-002. Stated over all THREE functions, and over the principals
      // that must NOT hold EXECUTE, because managed Supabase grants them by
      // default privilege at CREATE time rather than by any statement here.
      'no EXECUTE for PUBLIC, anon, authenticated or service_role on any of the three functions',
      'EXECUTE on uellix_bootstrap.hosted_capability_report() TO uellix_migrator, uellix_auditor',
      // S1-DEFECT-001. Persistent, and declared here so it is reviewed as a
      // contract rather than found as a surprise: PostgreSQL checks CREATE on
      // the namespace against the NEW OWNER, and five chain packages create
      // tables in public inside a SET ROLE uellix_owner window.
      'USAGE ON SCHEMA public TO uellix_owner, uellix_migrator, uellix_app, uellix_writer, uellix_auditor',
      'CREATE ON SCHEMA public TO uellix_owner, and to no other role this package creates',
      'nothing revoked from PUBLIC on schema public — that ACL is baseline surface',
    ],
    rollbackPolicy:
      'stella_hosted_0001_rollback.sql drops the bootstrap schema, the shim and the five roles, and ' +
      'REFUSES while any chain package is still installed — dropping the owner out from under the ' +
      'objects it owns would abort mid-transaction and leave the operator guessing which half ran.',
    reapplyPolicy:
      'Idempotent and convergent. Re-application reconciles role attributes, grants and the shim ' +
      'body, and re-asserts every postcondition. It never re-creates a role that exists, and never ' +
      'widens an attribute it finds narrowed by hand.',
    hostedCompatibility: 'native-hosted',
  },
  {
    name: 'grounding_0002_document_versions',
    sourceFile: 'grounding_0002_document_versions.sql',
    sourceSha256: '92a2b3bca658b7a2a5fda925b099e74cec758d202edcb77f3d16438df2c05f09',
    expectedRewrites: { ...NO_REWRITES, 'superuser-precondition': 1 },
    dependsOn: ['stella_hosted_0001_managed_role_bootstrap'],
    expectedObjects: [
      'role uellix_cap_grounding',
      'schema uellix_grounding',
      'table uellix_grounding.evidence_document_versions',
      'function uellix_grounding.register_document_version',
      'function uellix_grounding.claim_active_document_version(uuid)',
    ],
    expectedOwners: ['uellix_cap_grounding owns the two SECURITY DEFINER functions'],
    expectedGrants: [
      'EXECUTE ON public.current_user_org_ids() TO uellix_cap_grounding',
      'EXECUTE ON public.current_user_is_super_admin() TO uellix_cap_grounding',
      'no GRANT USAGE ON SCHEMA auth — this package never needed one',
    ],
    rollbackPolicy:
      'grounding_0002_rollback.sql requires SET grounding.rollback_confirm=\'true\' when the table ' +
      'has rows, refuses persisted authorization via ALTER DATABASE/ROLE, and refuses while ' +
      'evidence_chunks still holds its foreign key. Version history is NOT regenerable from Storage.',
    reapplyPolicy:
      'Idempotent. Must be re-applied as part of the grounding unit (0002 -> 0003 -> 0004), never ' +
      'alone: see db/prepared/README.md AVISO OPERATIVO.',
    hostedCompatibility: 'derived-precondition-only',
  },
  {
    name: 'grounding_0003_evidence_chunks',
    sourceFile: 'grounding_0003_evidence_chunks.sql',
    sourceSha256: '99980b34b9d4560127085f1be5b67e7a49792e197fa654e9cefe825e89817bd8',
    expectedRewrites: { ...NO_REWRITES, 'superuser-precondition': 1 },
    dependsOn: ['stella_hosted_0001_managed_role_bootstrap', 'grounding_0002_document_versions'],
    expectedObjects: [
      'table public.evidence_chunks (23 columns)',
      'function uellix_grounding.insert_evidence_chunks(uuid, jsonb)',
      'function uellix_grounding.finalize_document_ingestion(uuid, integer)',
      'function uellix_grounding.chunks_in_scope(uuid, uuid, uuid)',
    ],
    expectedOwners: ['uellix_cap_grounding owns the three SECURITY DEFINER functions'],
    expectedGrants: ['SELECT ON public.evidence_chunks — narrowed again by grounding_0004'],
    rollbackPolicy:
      'grounding_0003_rollback.sql asks for no confirmation (every row is reproducible from the ' +
      'sealed file) but REFUSES while chunks_in_scope_attested is installed, and aborts if ' +
      'evidence_document_versions has disappeared by the time it finishes.',
    reapplyPolicy:
      'DANGEROUS ALONE. Re-applying it over grounding_0004 silently reverts both of that package\'s ' +
      'security repairs — it re-grants SELECT to authenticated and re-creates the policy without ' +
      'uellix_cap_grounding, after which every governed read returns the empty set in silence. ' +
      'Always re-apply 0004 immediately afterwards, in the same window.',
    hostedCompatibility: 'derived-precondition-only',
  },
  {
    name: 'grounding_0004_runtime_attestation',
    sourceFile: 'grounding_0004_runtime_attestation.sql',
    sourceSha256: 'e89828da67f142d40140b6a2c6328da013c69b54968168c0474c54db857de5c6',
    expectedRewrites: { ...NO_REWRITES, 'superuser-precondition': 1 },
    dependsOn: [
      'stella_hosted_0001_managed_role_bootstrap',
      'grounding_0002_document_versions',
      'grounding_0003_evidence_chunks',
    ],
    expectedObjects: [
      'function uellix_grounding.chunks_in_scope_attested(uuid, uuid, uuid)',
      'three new CHECK constraints on public.evidence_chunks',
      'both SELECT policies re-created naming uellix_cap_grounding',
    ],
    expectedOwners: ['uellix_cap_grounding owns chunks_in_scope_attested'],
    expectedGrants: ['REVOKE SELECT ON public.evidence_chunks FROM authenticated'],
    rollbackPolicy:
      'grounding_0004_rollback.sql REOPENS INT-CAP-002 and announces it with RAISE WARNING. Leaving ' +
      'the narrow surface in place while claiming a clean revert would make the next apply/revert ' +
      'comparison read as convergent without being so.',
    reapplyPolicy: 'Idempotent, and mandatory immediately after any re-application of grounding_0003.',
    hostedCompatibility: 'derived-precondition-only',
  },
  {
    name: 'stella_0013_grounded_query_quota',
    sourceFile: 'stella_0013_grounded_query_quota.sql',
    sourceSha256: '9fdcf86e694989b53964de169a340a12f1f7c22348eb1c1d5194bfbc6192e189',
    expectedRewrites: {
      'superuser-precondition': 1,
      'auth-schema-grant': 1,
      'auth-uid-precondition': 1,
      'auth-uid-call': 2,
    },
    dependsOn: ['stella_hosted_0001_managed_role_bootstrap'],
    expectedObjects: [
      'role uellix_cap_stella_quota',
      'schema uellix_stella',
      'column public.stella_interactions.idempotency_key',
      'unique partial index uq_stella_interactions_idempotency',
      'policy stella_interactions_quota_definer_insert',
      'function uellix_stella.consume_stella_quota(uuid, uuid, varchar, char)',
    ],
    expectedOwners: ['uellix_cap_stella_quota owns consume_stella_quota'],
    expectedGrants: [
      'EXECUTE ON public.uellix_auth_uid() TO uellix_cap_stella_quota (replaces the auth-schema grants)',
      'SELECT, INSERT ON public.stella_interactions TO uellix_cap_stella_quota',
      'NO SELECT on auth.users — re-asserted by the package postcondition',
    ],
    rollbackPolicy:
      'stella_0013_rollback.sql MAY LEGITIMATELY REFUSE: narrowing the stella_role CHECK back to six ' +
      'values over a ledger that already recorded grounded_query rows is impossible on an ' +
      'append-only table. It counts the rows and explains instead of emitting a raw violation.',
    reapplyPolicy: 'Idempotent and convergent. First package in the ticket chain.',
    hostedCompatibility: 'derived-precondition-and-auth',
  },
  {
    name: 'stella_0014_operation_tickets',
    sourceFile: 'stella_0014_operation_tickets.sql',
    sourceSha256: '92e4092c526885825b0de508d1e158cdb8c1eaf894b8b370f0346196d11a3396',
    expectedRewrites: {
      'superuser-precondition': 1,
      'auth-schema-grant': 1,
      'auth-uid-precondition': 1,
      'auth-uid-call': 10,
    },
    dependsOn: ['stella_hosted_0001_managed_role_bootstrap', 'stella_0013_grounded_query_quota'],
    expectedObjects: [
      'role uellix_cap_stella_ticket',
      'table uellix_stella.operation_tickets (8 CHECK, no payload column)',
      'two ENABLE ALWAYS triggers',
      'RLS with three policies and NO DELETE policy',
      'six SECURITY DEFINER functions in uellix_stella_ops',
    ],
    expectedOwners: ['uellix_cap_stella_ticket owns the six functions'],
    expectedGrants: [
      'EXECUTE ON public.uellix_auth_uid() TO uellix_cap_stella_ticket',
      'no EXECUTE for PUBLIC',
      'no write privilege on public.stella_interactions',
    ],
    rollbackPolicy:
      'stella_0014_rollback.sql fails while any later package\'s functions still exist — its DROP ROLE ' +
      'cannot proceed while uellix_cap_stella_ticket owns them, and the whole transaction aborts ' +
      'without destroying anything.',
    reapplyPolicy:
      'REFUSED once stella_0015 is installed (db/prepared-package-order.ts). Re-application would ' +
      'republish four project-blind SECURITY DEFINER signatures granted to uellix_app.',
    hostedCompatibility: 'derived-precondition-and-auth',
  },
  {
    name: 'stella_0015_project_bound_operation_tickets',
    sourceFile: 'stella_0015_project_bound_operation_tickets.sql',
    sourceSha256: '117f61b7f5aa28472bd24c814dce26871475763922723c0784506a46290a2db9',
    expectedRewrites: {
      'superuser-precondition': 1,
      'auth-schema-grant': 0,
      'auth-uid-precondition': 1,
      'auth-uid-call': 4,
    },
    dependsOn: [
      'stella_hosted_0001_managed_role_bootstrap',
      'stella_0013_grounded_query_quota',
      'stella_0014_operation_tickets',
    ],
    expectedObjects: [
      'bind/complete/abort/inspect with p_expected_project_id uuid and no DEFAULT',
      'the four project-blind signatures DROPPED',
      'SQLSTATE U0110',
    ],
    expectedOwners: ['uellix_cap_stella_ticket owns all six functions'],
    expectedGrants: ['no EXECUTE for PUBLIC on any of the six'],
    rollbackPolicy:
      'stella_0015_rollback.sql leaves a CLOSED surface, not a degraded one: it restores issue and ' +
      'expire (neither charges) and does NOT republish the project-blind signatures. A postcondition ' +
      'aborts the rollback if a future edit ever "restored" one.',
    reapplyPolicy:
      'REFUSED once stella_0016, 0017 or 0018 is installed. The signatures do not change, so nothing ' +
      'later would notice the arithmetic regressing to charged-rows-only (R1).',
    hostedCompatibility: 'derived-precondition-and-auth',
  },
  {
    name: 'stella_0016_reserved_quota_semantics',
    sourceFile: 'stella_0016_reserved_quota_semantics.sql',
    sourceSha256: '5eb6946438b810cfdca580e9c958b7bb90783a9691ada722efca75653a58baec',
    expectedRewrites: {
      'superuser-precondition': 1,
      'auth-schema-grant': 0,
      'auth-uid-precondition': 1,
      'auth-uid-call': 5,
    },
    dependsOn: [
      'stella_hosted_0001_managed_role_bootstrap',
      'stella_0013_grounded_query_quota',
      'stella_0014_operation_tickets',
      'stella_0015_project_bound_operation_tickets',
    ],
    expectedObjects: [
      'function uellix_stella.stella_capacity(uuid, char)',
      'function uellix_stella.consume_stella_capacity(uuid, uuid, varchar, char)',
      'function uellix_stella.settle_reserved_quota(uuid, uuid, varchar, char, char)',
      'column operation_tickets.period_month GENERATED ALWAYS',
      'fourth policy operation_tickets_capacity_select',
      'SQLSTATE U0111',
    ],
    expectedOwners: ['uellix_cap_stella_quota owns the three new functions'],
    expectedGrants: [
      'column-level SELECT excluding charge_nonce and query_hash',
      'settle_reserved_quota granted ONLY to uellix_cap_stella_ticket',
    ],
    rollbackPolicy:
      'stella_0016_rollback.sql DROPS bind and complete instead of reverting them — R1 is the ABSENCE ' +
      'of reservation-aware arithmetic, so "restore the previous version" and "republish the ' +
      'vulnerability" are the same sentence. No charge is ever deleted.',
    reapplyPolicy: 'REFUSED once stella_0017 or stella_0018 is installed.',
    hostedCompatibility: 'derived-precondition-and-auth',
  },
  {
    name: 'stella_0017_governed_stella_consumption',
    sourceFile: 'stella_0017_governed_stella_consumption.sql',
    sourceSha256: '074050dc39e4baa1b53461559dc418e653397242efc4da9beabdf9825d3d04de',
    expectedRewrites: {
      'superuser-precondition': 1,
      'auth-schema-grant': 0,
      'auth-uid-precondition': 1,
      'auth-uid-call': 2,
    },
    dependsOn: [
      'stella_hosted_0001_managed_role_bootstrap',
      'stella_0013_grounded_query_quota',
      'stella_0014_operation_tickets',
      'stella_0015_project_bound_operation_tickets',
      'stella_0016_reserved_quota_semantics',
    ],
    expectedObjects: [
      'CHECK stella_interactions_governed_identity_check, NOT VALID',
      'function uellix_stella.settle_reserved_quota(10 args)',
      'function uellix_stella_ops.complete_operation_ticket(7 args)',
    ],
    expectedOwners: ['uellix_cap_stella_quota and uellix_cap_stella_ticket own the two new functions'],
    expectedGrants: [
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stella_interactions from every runtime principal',
      'measured with has_table_privilege over pg_roles, never with relacl',
    ],
    rollbackPolicy:
      'stella_0017_rollback.sql does NOT restore the direct write path and does NOT drop the CHECK. ' +
      'The direct write is not a function this package replaced — it is the defect it closed. Its ' +
      'section 1 refuses if stella_capacity is already gone.',
    reapplyPolicy: 'REFUSED once stella_0018 is installed (eight functions vs the seven it asserts).',
    hostedCompatibility: 'derived-precondition-and-auth',
  },
  {
    name: 'stella_0018_category_bound_operation_tickets',
    sourceFile: 'stella_0018_category_bound_operation_tickets.sql',
    sourceSha256: '6a4e12575fce8cdb081bd059017b26d0f3c041db5da4d9689f7e31c1c48ac922',
    expectedRewrites: {
      'superuser-precondition': 1,
      'auth-schema-grant': 0,
      'auth-uid-precondition': 0,
      'auth-uid-call': 1,
    },
    dependsOn: [
      'stella_hosted_0001_managed_role_bootstrap',
      'stella_0013_grounded_query_quota',
      'stella_0014_operation_tickets',
      'stella_0015_project_bound_operation_tickets',
      'stella_0016_reserved_quota_semantics',
      'stella_0017_governed_stella_consumption',
    ],
    expectedObjects: [
      'function uellix_stella_ops.bind_operation_ticket(char, uuid, char, varchar) — the eighth',
      'the three-argument bind now raises U0106 unconditionally',
      'SQLSTATE U0112',
    ],
    expectedOwners: ['uellix_cap_stella_ticket owns the eighth function'],
    expectedGrants: [
      'REVOKE EXECUTE ON uellix_stella.consume_stella_capacity FROM uellix_app (closes R6b)',
      'REVOKE EXECUTE on the three-argument bind FROM uellix_app (closes R6a)',
    ],
    rollbackPolicy:
      'stella_0018_rollback.sql restores the state stella_0017 left. It is the last link, so nothing ' +
      'supersedes it.',
    reapplyPolicy: 'Idempotent. Nothing later exists to refuse it.',
    hostedCompatibility: 'derived-precondition-and-auth',
  },
]

/** The forward chain, derived from the manifest so the two cannot disagree. */
export const HOSTED_CHAIN: readonly string[] = HOSTED_PACKAGE_MANIFEST.map((e) => e.name)

/** Looks up one entry, or throws — a typo must never silently skip a package. */
export function hostedManifestEntry(name: string): HostedManifestEntry {
  const found = HOSTED_PACKAGE_MANIFEST.find((e) => e.name === name)
  if (!found) {
    throw new Error(
      `HOSTED_MANIFEST_UNKNOWN_PACKAGE: ${name} is not in the hosted chain. Known: ${HOSTED_CHAIN.join(', ')}`,
    )
  }
  return found
}
