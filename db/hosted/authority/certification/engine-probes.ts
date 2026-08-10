// db/hosted/authority/certification/engine-probes.ts
// COMMIT 5 — the questions the engine is asked, as SQL, in one place.
//
// ---------------------------------------------------------------------------
// WHY THE PROBES ARE A MODULE AND NOT INLINE STRINGS IN THE RUNNER
// ---------------------------------------------------------------------------
// Every claim in the certification report is an answer to one of these. If the
// probe that measures "no temporary membership survives" is written beside the
// code that reports it, the two drift together and the report keeps saying yes.
// Here they are values: the runner cannot phrase the question differently from
// the tests that pin the phrasing.
//
// EVERY PROBE READS THE CATALOG. None of them reads a variable the harness set,
// and none of them accepts the applying session's word for anything — including
// its exit status. `psql` exiting 0 means the transaction committed, not that it
// committed what was intended.
//
// ---------------------------------------------------------------------------
// THE GRANTOR DISTINCTION
// ---------------------------------------------------------------------------
// pg_auth_members carries a `grantor`. Lab M2 measured that a provider-granted
// membership and an installer-granted one COEXIST as two rows distinguished by
// exactly that column, and M3a that an unqualified REVOKE removes only the
// issuing grantor's. So a probe that counted memberships by (role, member)
// alone would report the chain's cleanup incomplete whenever the provider held
// its own row — or, in the dangerous direction, report it complete because the
// provider's row was mistaken for the one the chain was supposed to remove.
// Every membership probe below therefore projects the grantor.

import { planWitnessSql } from '../../witness-sql'

/** The roles the chain creates or governs. Cluster-wide, not per-database. */
export const GOVERNED_ROLES: readonly string[] = [
  'uellix_owner',
  'uellix_migrator',
  'uellix_app',
  'uellix_writer',
  'uellix_auditor',
  'uellix_cap_grounding',
  'uellix_cap_stella_quota',
  'uellix_cap_stella_ticket',
]

/** Principals the chain must never name and must never disturb. */
export const PROVIDER_ROLES: readonly string[] = [
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_storage_admin',
  'authenticator',
  'anon',
  'authenticated',
  'service_role',
  'postgres',
]

const list = (values: readonly string[]): string =>
  values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',')

/**
 * Package witnesses, one row per (package, witness, present).
 *
 * Built from `planWitnessSql` so the engine is asked exactly what
 * `package-witnesses.ts` declares — arity and all — rather than a second
 * spelling of it.
 */
export function witnessProbeSql(): string {
  const planned = planWitnessSql()
  if (!planned.ok) {
    throw new Error(`witness probe unbuildable: ${planned.code}: ${planned.detail}`)
  }
  const rows = planned.packages.flatMap((p) =>
    p.witnesses.map(
      ([key, sql]) =>
        `SELECT '${p.packageId}'::text AS package_id, '${key.replace(/'/g, "''")}'::text AS witness, (${sql}) AS present`,
    ),
  )
  return `SET search_path = '';\n${rows.join('\nUNION ALL\n')};`
}

/**
 * Every membership row involving a governed or provider principal.
 *
 * `admin_option`, `inherit_option` and `set_option` are all projected: a
 * membership narrowed rather than removed is a different end state from a
 * membership removed, and the difference is invisible in a (role, member) pair.
 */
export const MEMBERSHIP_PROBE_SQL = `
SET search_path = '';
SELECT r.rolname   AS role,
       m.rolname   AS member,
       g.rolname   AS grantor,
       am.admin_option,
       am.inherit_option,
       am.set_option
FROM pg_catalog.pg_auth_members am
JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
JOIN pg_catalog.pg_roles m ON m.oid = am.member
JOIN pg_catalog.pg_roles g ON g.oid = am.grantor
WHERE r.rolname IN (${list([...GOVERNED_ROLES, ...PROVIDER_ROLES])})
   OR m.rolname IN (${list([...GOVERNED_ROLES, ...PROVIDER_ROLES])})
ORDER BY 1, 2, 3;`

/**
 * The owner of every function in the governed schemas, by FULL signature.
 *
 * `oid::regprocedure` rather than proname: the chain re-creates
 * `settle_reserved_quota` at two different arities and transfers both, and a
 * report keyed by name would collapse them into one line that is right about
 * neither.
 */
export const FUNCTION_OWNER_PROBE_SQL = `
SET search_path = '';
SELECT p.oid::regprocedure::text AS signature,
       n.nspname                 AS schema,
       pg_catalog.pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef               AS security_definer,
       COALESCE(array_to_string(p.proconfig, '|'), '')  AS proconfig,
       COALESCE((SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                        ELSE pg_catalog.pg_get_userbyid(a.grantee) END, ',' ORDER BY 1)
                 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE a.privilege_type = 'EXECUTE'), '') AS execute_grantees
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('uellix_grounding','uellix_stella','uellix_stella_ops','uellix_bootstrap','public')
ORDER BY 2, 1;`

/** Owners of every relation the chain creates or re-owns. */
export const RELATION_OWNER_PROBE_SQL = `
SET search_path = '';
SELECT n.nspname || '.' || c.relname AS relation,
       c.relkind::text              AS kind,
       pg_catalog.pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity             AS rls_enabled,
       c.relforcerowsecurity        AS rls_forced
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p','v','m')
  AND n.nspname IN ('uellix_grounding','uellix_stella','uellix_stella_ops','uellix_bootstrap','public')
ORDER BY 1;`

/** Owners of the governed schemas, and every non-default ACL on them. */
export const SCHEMA_ACL_PROBE_SQL = `
SET search_path = '';
SELECT n.nspname AS schema,
       pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
       COALESCE((SELECT string_agg(
                   (CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                         ELSE pg_catalog.pg_get_userbyid(a.grantee) END)
                   || ':' || a.privilege_type, ',' ORDER BY 1)
                 FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a), '') AS acl
FROM pg_catalog.pg_namespace n
WHERE n.nspname IN ('uellix_grounding','uellix_stella','uellix_stella_ops','uellix_bootstrap','public','auth','storage')
ORDER BY 1;`

/**
 * Any CREATE privilege on a governed schema, held by anyone.
 *
 * This is the residual probe for section 13. It reads the ACL rather than
 * counting grant statements, because the question is what the catalog holds
 * after the chain, not what the chain said.
 */
export const SCHEMA_CREATE_RESIDUAL_PROBE_SQL = `
SET search_path = '';
SELECT n.nspname AS schema,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee
FROM pg_catalog.pg_namespace n
CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
WHERE a.privilege_type = 'CREATE'
  AND n.nspname IN ('uellix_grounding','uellix_stella','uellix_stella_ops','uellix_bootstrap','public')
ORDER BY 1, 2;`

/** RLS state and the full policy inventory for every governed table. */
export const POLICY_PROBE_SQL = `
SET search_path = '';
SELECT p.schemaname || '.' || p.tablename AS relation,
       p.policyname,
       p.permissive,
       array_to_string(p.roles, ',') AS roles,
       p.cmd,
       COALESCE(p.qual, '')       AS qual,
       COALESCE(p.with_check, '') AS with_check
FROM pg_catalog.pg_policies p
WHERE p.schemaname IN ('public','uellix_grounding','uellix_stella','uellix_stella_ops','storage')
ORDER BY 1, 2;`

/** Table-level privileges held by runtime and capability principals. */
export const TABLE_GRANT_PROBE_SQL = `
SET search_path = '';
SELECT n.nspname || '.' || c.relname AS relation,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee,
       a.privilege_type
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
WHERE c.relkind IN ('r','p','v')
  AND n.nspname IN ('uellix_grounding','uellix_stella','uellix_stella_ops')
ORDER BY 1, 2, 3;`

/** Role attributes. NOLOGIN / NOBYPASSRLS are security properties, not style. */
export const ROLE_ATTRIBUTE_PROBE_SQL = `
SET search_path = '';
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolbypassrls
FROM pg_catalog.pg_roles
WHERE rolname IN (${list([...GOVERNED_ROLES, ...PROVIDER_ROLES])})
ORDER BY 1;`

/** Triggers on governed tables, so an append-only guard cannot go missing. */
export const TRIGGER_PROBE_SQL = `
SET search_path = '';
SELECT n.nspname || '.' || c.relname AS relation,
       t.tgname,
       pg_catalog.pg_get_userbyid(p.proowner) AS function_owner
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND n.nspname IN ('public','uellix_grounding','uellix_stella','uellix_stella_ops')
ORDER BY 1, 2;`

/** The session's own residual state. A committed package must leave none. */
export const SESSION_STATE_PROBE_SQL = `
SET search_path = '';
SELECT current_user AS current_user, session_user AS session_user, current_setting('role') AS role_setting;`

/* -------------------------------------------------------------------------- */
/* The prechain authority observation (COMMIT 5.1)                             */
/* -------------------------------------------------------------------------- */

/**
 * Everything `validateHostedPrechainAuthorityContract` consumes, as ONE row of
 * JSON.
 *
 * One row rather than eight result sets because the gate has to reason across
 * them — "uellix_owner holds SELECT on organizations" and "uellix_owner OWNS
 * organizations" are the same answer arriving two different ways, and a gate
 * that received them in separate round trips could see a database that changed
 * in between.
 *
 * `has_table_privilege(role, oid, 'SELECT WITH GRANT OPTION')` is the exact
 * question the engine refused on at T1 line 278: the plain privilege was held
 * and the grant option was not.
 */
export function prechainObservationSql(
  objects: readonly { object: string; objectType: 'table' | 'function'; privileges: readonly string[] }[],
): string {
  const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`

  const objectArms = objects.map((o) => {
    // Keyed off the DERIVED type, never off a '()' suffix. `public.current_user_org_ids`
    // arrives from a GRANT identity with no argument list and would be resolved as a
    // TABLE by a suffix test — which is how the gate first reported two functions
    // ABSENT on a database that had them.
    const isFunction = o.objectType === 'function'
    const resolvable = isFunction && !o.object.endsWith('()') ? `${o.object}()` : o.object
    const resolve = isFunction
      ? `pg_catalog.to_regprocedure(${lit(resolvable)})`
      : `pg_catalog.to_regclass(${lit(resolvable)})`
    const ownerExpr = isFunction
      ? `(SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = ${resolve})`
      : `(SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = ${resolve})`
    const priv = (name: string, withOption: boolean): string => {
      const spec = withOption ? `${name} WITH GRANT OPTION` : name
      return isFunction
        ? `(${resolve} IS NOT NULL AND pg_catalog.has_function_privilege('uellix_owner', ${resolve}, ${lit(spec)}))`
        : `(${resolve} IS NOT NULL AND pg_catalog.has_table_privilege('uellix_owner', ${resolve}, ${lit(spec)}))`
    }
    const held = o.privileges.map((n) => `${lit(n)}, ${priv(n, false)}`).join(', ')
    const withOpt = o.privileges.map((n) => `${lit(n)}, ${priv(n, true)}`).join(', ')
    return `jsonb_build_object(
        'object', ${lit(o.object)},
        'present', (${resolve} IS NOT NULL),
        'owner', ${ownerExpr},
        'held', jsonb_build_object(${held}),
        'heldWithGrantOption', jsonb_build_object(${withOpt}))`
  })

  const capabilityArms = ['uellix_cap_grounding', 'uellix_cap_stella_quota', 'uellix_cap_stella_ticket']
    .map(
      (cap) => `${lit(cap)}, COALESCE((
        SELECT jsonb_agg(r.rolname ORDER BY r.rolname)
        FROM pg_catalog.pg_roles r
        WHERE r.rolname <> ${lit(cap)}
          AND NOT r.rolsuper
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles c WHERE c.rolname = ${lit(cap)})
          AND pg_catalog.pg_has_role(r.rolname, ${lit(cap)}, 'SET')), '[]'::jsonb)`,
    )
    .join(', ')

  const schemaArms = ['public', 'uellix_grounding', 'uellix_stella', 'uellix_stella_ops']
    .map(
      (s) => `${lit(s)}, COALESCE((
        SELECT pg_catalog.has_schema_privilege('uellix_owner', n.oid, 'CREATE')
        FROM pg_catalog.pg_namespace n WHERE n.nspname = ${lit(s)}), true)`,
    )
    .join(', ')

  return `SET search_path = '';
SELECT jsonb_build_object(
  'roles', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'name', r.rolname, 'canLogin', r.rolcanlogin,
             'createRole', r.rolcreaterole, 'isSuper', r.rolsuper) ORDER BY r.rolname)
    FROM pg_catalog.pg_roles r WHERE r.rolname LIKE 'uellix\\_%'), '[]'::jsonb),
  'memberships', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'role', r.rolname, 'member', m.rolname, 'grantor', g.rolname,
             'adminOption', am.admin_option, 'inheritOption', am.inherit_option,
             'setOption', am.set_option) ORDER BY r.rolname, m.rolname)
    FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
    JOIN pg_catalog.pg_roles m ON m.oid = am.member
    JOIN pg_catalog.pg_roles g ON g.oid = am.grantor
    WHERE r.rolname LIKE 'uellix\\_%' OR m.rolname LIKE 'uellix\\_%'), '[]'::jsonb),
  'objects', jsonb_build_array(${objectArms.join(',\n      ')}),
  'schemaCreate', jsonb_build_object(${schemaArms}),
  'installerCanSetOwner', COALESCE((
    SELECT pg_catalog.pg_has_role('uellix_migrator', 'uellix_owner', 'SET')
    FROM pg_catalog.pg_roles WHERE rolname = 'uellix_migrator'), false),
  'capabilityReachableBy', jsonb_build_object(${capabilityArms})
)::text;`
}

export const ENGINE_IDENTITY_PROBE_SQL = `
SET search_path = '';
SELECT current_setting('server_version')          AS server_version,
       current_setting('server_version_num')      AS server_version_num,
       current_setting('createrole_self_grant')    AS createrole_self_grant,
       (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user)::text AS installer_is_superuser,
       current_user                                AS installer;`
