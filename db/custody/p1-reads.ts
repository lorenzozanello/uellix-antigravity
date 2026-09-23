// db/custody/p1-reads.ts
//
// THE PHASE P1 READ SET, AS THE AUTHORITY WRITES IT, WITH PROVENANCE PER
// STATEMENT. N14 issues it to measure the prestate; N22 re-issues THE SAME
// statements to assert the poststate ("the SAME QUERIES against the CHANGED
// state", AUTHORIZED_FUTURE_SQL.PHASE_P3_POSTSTATE_READS); N21 uses the subset
// its three booleans need.
//
// Source: docs/ops/release/FIBDB053_D1_AUDITOR_CAPABILITY_PROVISIONING_AUTHORITY_v1.0.0.json
//   AUTHORIZED_FUTURE_SQL.PHASE_P1_OBSERVATION_ONLY_READS[0..13]  (EXHAUSTIVE)
//   EFFECTIVE_PRIVILEGE_CONTRACT EP-1..EP-5                       (the named lists)
//
// TWO FORMS OF PROVENANCE, NEVER MIXED UP:
//
//   VERBATIM      the statement text IS a member of the authorized list, byte
//                 for byte. A test compares it against the authority file.
//   DESCRIBED     the authorized list describes the read in prose ("SELECT over
//                 pg_auth_members joined to pg_roles, filtered to uellix_auditor
//                 in BOTH directions, projecting ..."). The text below realizes
//                 exactly that description over exactly the named objects, and
//                 is declared as a realization for independent review, never
//                 passed off as a quotation.
//
// AUTHORITY CONFLICTS ARE NOT RESOLVED HERE. Where the authority requires a
// read its own exhaustive list does not contain, or a read that raises on the
// state the authority expects, the statement is registered as BLOCKED with its
// conflict id and NO node issues it. The node then cannot meet its exit, which
// is the fail-closed outcome: nothing is measured by an unauthorized read, and
// nothing is reported as measured that was not.

export const AUDITOR = 'uellix_auditor'

/** EP-3's named role list. "every uellix_cap_* role present" is AC-2 below. */
export const EP3_NAMED_ROLES = [
  'uellix_owner',
  'uellix_migrator',
  'uellix_app',
  'uellix_writer',
  'postgres',
  'supabase_admin',
  'service_role',
  'authenticator',
] as const

/** EP-5's named schema list. */
export const EP5_NAMED_SCHEMAS = ['public', 'uellix_bootstrap', 'uellix_stella_ops', 'uellix_grounding', 'uellix_stella', 'auth', 'storage'] as const

/** The two canonical literals, as frozen by the parent's CANONICAL_SIGNATURE_CONTRACT. */
export const NINE_ARGUMENT_CANONICAL_LITERAL =
  'uellix_stella_ops.complete_operation_ticket(character,uuid,character,character varying,character varying,integer,jsonb,character varying,text[])'
export const SEVEN_ARGUMENT_PREDECESSOR_LITERAL =
  'uellix_stella_ops.complete_operation_ticket(character,uuid,character,character varying,character varying,integer,jsonb)'

const q = (s: readonly string[]): string => s.map((x) => `'${x}'`).join(',')

export type P1Id =
  | 'IDENTITY'
  | 'READ_ONLY'
  | 'SERVER_VERSION'
  | 'SENTINEL'
  | 'ROLE_ATTRIBUTES'
  | 'MEMBERSHIPS'
  | 'REACH'
  | 'DATABASE_PRIVILEGES'
  | 'SCHEMA_PRIVILEGES'
  | 'STELLA_OPS_EXISTS'
  | 'OWNERSHIP'
  | 'DATDBA'
  | 'DEFAULT_ACL'
  | 'FUNCTION_EXECUTE'
  | 'TABLE_PRIVILEGES'

export type ConflictId = 'AC-1' | 'AC-2' | 'AC-3'

export interface P1Statement {
  readonly id: P1Id
  readonly sql: string
  /** Index into PHASE_P1_OBSERVATION_ONLY_READS, or null when the authority has no entry (AC-1). */
  readonly authorityIndex: number | null
  readonly form: 'VERBATIM' | 'DESCRIBED' | 'NOT_IN_AUTHORITY'
  /** A statement with an open conflict is never issued by any node. */
  readonly blockedBy: ConflictId | null
}

export const P1_STATEMENTS: Readonly<Record<P1Id, P1Statement>> = {
  IDENTITY: { id: 'IDENTITY', sql: 'SELECT current_user, session_user', authorityIndex: 0, form: 'VERBATIM', blockedBy: null },
  READ_ONLY: { id: 'READ_ONLY', sql: "SELECT current_setting('transaction_read_only')", authorityIndex: 1, form: 'VERBATIM', blockedBy: null },
  SERVER_VERSION: { id: 'SERVER_VERSION', sql: "SELECT current_setting('server_version_num')", authorityIndex: 2, form: 'VERBATIM', blockedBy: null },
  SENTINEL: { id: 'SENTINEL', sql: 'SELECT environment, project_ref FROM uellix_bootstrap.staging_sentinel', authorityIndex: 3, form: 'VERBATIM', blockedBy: null },
  ROLE_ATTRIBUTES: {
    id: 'ROLE_ATTRIBUTES',
    sql: "SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit, rolconnlimit, rolvaliduntil FROM pg_catalog.pg_roles WHERE rolname = 'uellix_auditor'",
    authorityIndex: 4,
    form: 'VERBATIM',
    blockedBy: null,
  },
  MEMBERSHIPS: {
    id: 'MEMBERSHIPS',
    sql:
      'SELECT r.rolname AS granted_role, m.rolname AS member_role, g.rolname AS grantor, am.inherit_option, am.set_option, am.admin_option ' +
      'FROM pg_catalog.pg_auth_members am JOIN pg_catalog.pg_roles r ON r.oid = am.roleid JOIN pg_catalog.pg_roles m ON m.oid = am.member ' +
      "LEFT JOIN pg_catalog.pg_roles g ON g.oid = am.grantor WHERE r.rolname = 'uellix_auditor' OR m.rolname = 'uellix_auditor'",
    authorityIndex: 5,
    form: 'DESCRIBED',
    blockedBy: null,
  },
  REACH: {
    id: 'REACH',
    // A keyed lookup over the NAMED list. Written against pg_roles rather than
    // as bare pg_has_role(<name>) calls because pg_has_role raises on a role
    // name that does not exist, and EP-3 names roles a hosted target may lack.
    sql:
      "SELECT r.rolname AS role_name, pg_catalog.pg_has_role('uellix_auditor', r.oid, 'MEMBER') AS can_member, " +
      "pg_catalog.pg_has_role('uellix_auditor', r.oid, 'USAGE') AS can_usage, pg_catalog.pg_has_role('uellix_auditor', r.oid, 'SET') AS can_set " +
      `FROM pg_catalog.pg_roles r WHERE r.rolname = ANY (ARRAY[${q(EP3_NAMED_ROLES)}])`,
    authorityIndex: 6,
    form: 'DESCRIBED',
    blockedBy: null,
  },
  DATABASE_PRIVILEGES: {
    id: 'DATABASE_PRIVILEGES',
    sql:
      "SELECT pg_catalog.has_database_privilege('uellix_auditor', current_database(), 'CONNECT') AS auditor_connect, " +
      "pg_catalog.has_database_privilege('uellix_auditor', current_database(), 'TEMP') AS auditor_temp, " +
      "pg_catalog.has_database_privilege('public', current_database(), 'CONNECT') AS public_connect, " +
      "pg_catalog.has_database_privilege('public', current_database(), 'TEMP') AS public_temp",
    authorityIndex: 7,
    form: 'DESCRIBED',
    blockedBy: null,
  },
  SCHEMA_PRIVILEGES: {
    id: 'SCHEMA_PRIVILEGES',
    // Guarded by to_regnamespace per KP-3, so an absent schema yields NULL and
    // never reaches has_schema_privilege (E-6: that raises 3F000).
    sql:
      'SELECT s.name AS schema_name, pg_catalog.to_regnamespace(s.name) IS NOT NULL AS present, ' +
      "CASE WHEN pg_catalog.to_regnamespace(s.name) IS NULL THEN NULL ELSE pg_catalog.has_schema_privilege('uellix_auditor', s.name, 'USAGE') END AS can_usage, " +
      "CASE WHEN pg_catalog.to_regnamespace(s.name) IS NULL THEN NULL ELSE pg_catalog.has_schema_privilege('uellix_auditor', s.name, 'CREATE') END AS can_create " +
      `FROM unnest(ARRAY[${q(EP5_NAMED_SCHEMAS)}]) AS s(name)`,
    authorityIndex: 8,
    form: 'DESCRIBED',
    blockedBy: null,
  },
  STELLA_OPS_EXISTS: { id: 'STELLA_OPS_EXISTS', sql: "SELECT pg_catalog.to_regnamespace('uellix_stella_ops') IS NOT NULL", authorityIndex: 9, form: 'VERBATIM', blockedBy: null },
  OWNERSHIP: {
    id: 'OWNERSHIP',
    sql:
      "SELECT (SELECT count(*) FROM pg_catalog.pg_class WHERE relowner = 'uellix_auditor'::regrole) AS classes, " +
      "(SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspowner = 'uellix_auditor'::regrole) AS namespaces, " +
      "(SELECT count(*) FROM pg_catalog.pg_proc WHERE proowner = 'uellix_auditor'::regrole) AS procs, " +
      "(SELECT count(*) FROM pg_catalog.pg_type WHERE typowner = 'uellix_auditor'::regrole) AS types",
    authorityIndex: 10,
    form: 'DESCRIBED',
    blockedBy: null,
  },
  DATDBA: {
    id: 'DATDBA',
    sql: "SELECT datdba = 'uellix_auditor'::regrole FROM pg_catalog.pg_database WHERE datname = current_database()",
    authorityIndex: 11,
    form: 'VERBATIM',
    blockedBy: null,
  },
  DEFAULT_ACL: {
    id: 'DEFAULT_ACL',
    sql:
      'SELECT d.defaclrole::regrole::text AS owner_role, CASE WHEN d.defaclnamespace = 0 THEN NULL ELSE d.defaclnamespace::regnamespace::text END AS schema_name, ' +
      'd.defaclobjtype AS object_type, a.privilege_type FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a ' +
      "WHERE a.grantee = 'uellix_auditor'::regrole",
    authorityIndex: 12,
    form: 'DESCRIBED',
    blockedBy: null,
  },
  FUNCTION_EXECUTE: {
    id: 'FUNCTION_EXECUTE',
    sql:
      `SELECT pg_catalog.has_function_privilege('uellix_auditor', '${NINE_ARGUMENT_CANONICAL_LITERAL}', 'EXECUTE') AS nine_execute, ` +
      `pg_catalog.has_function_privilege('uellix_auditor', '${SEVEN_ARGUMENT_PREDECESSOR_LITERAL}', 'EXECUTE') AS seven_execute`,
    authorityIndex: 13,
    form: 'DESCRIBED',
    blockedBy: 'AC-3',
  },
  TABLE_PRIVILEGES: {
    id: 'TABLE_PRIVILEGES',
    sql:
      "SELECT pg_catalog.has_table_privilege('uellix_auditor', 'uellix_bootstrap.staging_sentinel', 'SELECT') AS sentinel_select, " +
      "pg_catalog.has_table_privilege('uellix_auditor', 'uellix_bootstrap.staging_sentinel', 'INSERT') AS sentinel_insert, " +
      "pg_catalog.has_table_privilege('uellix_auditor', 'uellix_bootstrap.staging_sentinel', 'UPDATE') AS sentinel_update, " +
      "pg_catalog.has_table_privilege('uellix_auditor', 'uellix_bootstrap.staging_sentinel', 'DELETE') AS sentinel_delete, " +
      "pg_catalog.has_table_privilege('uellix_auditor', 'uellix_bootstrap.staging_sentinel', 'TRUNCATE') AS sentinel_truncate, " +
      "pg_catalog.has_table_privilege('uellix_auditor', 'public.users', 'SELECT') AS users_select",
    authorityIndex: null,
    form: 'NOT_IN_AUTHORITY',
    blockedBy: 'AC-1',
  },
}

export interface AuthorityConflict {
  readonly id: ConflictId
  readonly summary: string
  readonly clauses: readonly string[]
  readonly affects: readonly string[]
  readonly basis: 'READ_FROM_THE_AUTHORITY' | 'DERIVED_FROM_DOCUMENTED_ENGINE_SEMANTICS_UNMEASURED'
}

export const AUTHORITY_CONFLICTS: readonly AuthorityConflict[] = [
  {
    id: 'AC-1',
    summary:
      'POSTSTATE_VERIFICATION PV-22, PV-28 and PV-32 assert has_table_privilege, but AUTHORIZED_FUTURE_SQL is EXHAUSTIVE and PHASE_P1_OBSERVATION_ONLY_READS contains no has_table_privilege read; PHASE_P3 is "the PHASE_P1 read list, re-issued in full".',
    clauses: ['AUTHORIZED_FUTURE_SQL.rule', 'AUTHORIZED_FUTURE_SQL.PHASE_P3_POSTSTATE_READS', 'POSTSTATE_VERIFICATION PV-22, PV-28, PV-32', 'N14.act (prohibited privileges prestate)'],
    affects: ['N14 prestate of PV-22/PV-28/PV-32', 'N22 rows PV-22, PV-28, PV-32', 'READ_ONLY_PROOF layer GRANTS'],
    basis: 'READ_FROM_THE_AUTHORITY',
  },
  {
    id: 'AC-2',
    summary:
      'EP-3 requires pg_has_role over "every uellix_cap_* role present", which can only be known by a pattern scan of pg_roles, while the authorized catalog reads are "keyed lookups over named objects, never scans". The REACH read covers the eight NAMED roles only.',
    clauses: ['EFFECTIVE_PRIVILEGE_CONTRACT EP-3.probe', 'AUTHORIZED_FUTURE_SQL.EXPLICITLY_UNAUTHORIZED_SQL (enumeration)', 'PHASE_P1_OBSERVATION_ONLY_READS[6] (NAMED role list)'],
    affects: ['N14 membership prestate', 'N22 PV-14'],
    basis: 'READ_FROM_THE_AUTHORITY',
  },
  {
    id: 'AC-3',
    summary:
      'PHASE_P1_OBSERVATION_ONLY_READS[13] and PV-24/PV-25 call has_function_privilege on the two canonical text signatures. A function given by name is parsed as regprocedure input, which raises (42883) when the function does not exist, and CANONICAL_SIGNATURE_CONTRACT requires the NINE-argument function to be ABSENT on OLD_DB. The only non-raising guard, to_regprocedure over the literal, is EXPLICITLY_UNAUTHORIZED (mutant M20). On the state the authority expects, the read aborts the read-only transaction.',
    clauses: ['PHASE_P1_OBSERVATION_ONLY_READS[13]', 'POSTSTATE_VERIFICATION PV-24, PV-25', 'N21.act', 'EXPLICITLY_UNAUTHORIZED_SQL[0]', 'OLD_DB CANONICAL_SIGNATURE_CONTRACT.NINE_ARGUMENT_CANONICAL_LITERAL.required_resolution_for_OLD_DB'],
    affects: ['N14 prestate of PV-24/PV-25', 'N21 (all of its EXECUTE assertions)', 'N22 rows PV-24, PV-25'],
    basis: 'DERIVED_FROM_DOCUMENTED_ENGINE_SEMANTICS_UNMEASURED',
  },
]

/** The statements a node may issue: the ones it names, minus every blocked one. */
export function issuable(ids: readonly P1Id[]): { issued: P1Statement[]; blocked: P1Statement[] } {
  const all = ids.map((id) => P1_STATEMENTS[id])
  return { issued: all.filter((s) => s.blockedBy === null), blocked: all.filter((s) => s.blockedBy !== null) }
}
