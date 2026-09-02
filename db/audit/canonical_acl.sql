-- db/audit/canonical_acl.sql
-- READ-ONLY. Canonical privilege inspection for Uellix.
--
-- Every query here reads pg_catalog and expands ACLs with aclexplode().
-- Nothing in this file writes, and nothing in it may be used to grant.
--
-- ============================================================================
-- WHY information_schema.role_table_grants IS NOT USED
-- ============================================================================
-- It is banned as a gate criterion. Three defects, all measured on this stack:
--
--   1. It EXPANDS PRIVILEGES REACHED BY MEMBERSHIP. `postgres` is a member of
--      `authenticated` and `service_role` (inherit_option = true), so the view
--      attributes to `postgres` privileges its own ACL does not contain. On
--      stella_interactions it returned 11 rows against 4 real direct grants —
--      a gate reading it would have failed on a correct database.
--
--   2. IT CANNOT EXPRESS `PUBLIC`. The PUBLIC grantee is OID 0, which is not a
--      row in pg_roles, so the view simply omits it. An expectation of the
--      form "for PUBLIC: no rows" is therefore UNFALSIFIABLE — it is satisfied
--      by a database where PUBLIC holds everything.
--
--   3. It handles PostgreSQL 17's MAINTAIN inconsistently with aclexplode.
--
-- It may be retained in documentation as an informative view. It may not
-- decide whether a gate passes.
--
-- ============================================================================
-- WHY COALESCE(acl, acldefault(...)) IS EVERYWHERE
-- ============================================================================
-- A NULL ACL column does NOT mean "no privileges". It means "the built-in
-- default for this object type", which is:
--
--   relations  acldefault('r', owner) -> owner only
--   sequences  acldefault('S', owner) -> owner only
--   functions  acldefault('f', owner) -> owner AND *EXECUTE TO PUBLIC*
--   types      acldefault('T', owner) -> owner AND *USAGE TO PUBLIC*
--   schemas    acldefault('n', owner) -> owner only
--
-- Reading `proacl IS NULL` as "nothing granted" is exactly how an
-- EXECUTE-to-anon is missed. Verified: a freshly created function in `public`
-- has proacl = NULL and has_function_privilege('anon', ..., 'EXECUTE') = true.
--
-- ============================================================================
-- WHY has_*_privilege() IS ONLY CORROBORATION
-- ============================================================================
-- has_table_privilege() answers "can this role do it?", which silently folds
-- together SIX distinct causes: a direct grant, a grant inherited through
-- membership, a grant to PUBLIC, ownership, superuser, and BYPASSRLS. It is
-- the right question for "is the app going to work" and the wrong one for "is
-- this ACL correct". The queries below therefore read the ACL literally and
-- use has_*_privilege only where the effective answer is what is being
-- asserted.

\echo '=== 1. Roles: attributes ==='
SELECT r.rolname,
       r.rolsuper       AS superuser,
       r.rolcanlogin    AS login,
       r.rolinherit     AS inherit,
       r.rolbypassrls   AS bypassrls,
       r.rolcreaterole  AS createrole,
       r.rolcreatedb    AS createdb,
       r.rolreplication AS replication,
       (a.rolpassword IS NOT NULL) AS has_password
FROM pg_roles r
JOIN pg_authid a ON a.oid = r.oid
WHERE r.rolname NOT LIKE 'pg\_%'
ORDER BY r.rolname;

\echo '=== 2. Memberships: the three options that decide whether separation is real ==='
-- admin_option   -> may re-grant the role to anyone, including itself
-- inherit_option -> carries the role's privileges without asking
-- set_option     -> may SET ROLE into it
-- A membership with inherit=false and set=false confers nothing at all.
SELECT m.rolname AS member, r.rolname AS member_of,
       am.admin_option, am.inherit_option, am.set_option,
       g.rolname AS granted_by
FROM pg_auth_members am
JOIN pg_roles m ON m.oid = am.member
JOIN pg_roles r ON r.oid = am.roleid
LEFT JOIN pg_roles g ON g.oid = am.grantor
WHERE m.rolname NOT LIKE 'pg\_%' AND r.rolname NOT LIKE 'pg\_%'
ORDER BY 1, 2;

\echo '=== 3. Per-role settings (pg_db_role_setting) ==='
SELECT COALESCE(r.rolname, '(all roles)') AS rolname,
       COALESCE(d.datname, '(all databases)') AS datname,
       s.setconfig
FROM pg_db_role_setting s
LEFT JOIN pg_roles r ON r.oid = s.setrole
LEFT JOIN pg_database d ON d.oid = s.setdatabase
ORDER BY 1, 2;

\echo '=== 4. Ownership in public ==='
SELECT 'table'    AS objkind, c.relname AS objname, pg_get_userbyid(c.relowner) AS owner
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
UNION ALL
SELECT 'sequence', c.relname, pg_get_userbyid(c.relowner)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'S'
UNION ALL
SELECT 'view', c.relname, pg_get_userbyid(c.relowner)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
UNION ALL
SELECT 'function', p.oid::regprocedure::text, pg_get_userbyid(p.proowner)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
UNION ALL
SELECT 'type', t.typname, pg_get_userbyid(t.typowner)
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public' AND t.typtype IN ('e','d','r')
UNION ALL
SELECT 'schema', n.nspname, pg_get_userbyid(n.nspowner)
FROM pg_namespace n WHERE n.nspname = 'public'
ORDER BY 1, 2;

\echo '=== 5. Table ACLs in public — literal, including PUBLIC ==='
SELECT c.relname,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
       a.privilege_type,
       a.is_grantable,
       pg_get_userbyid(a.grantor) AS grantor
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace,
LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
ORDER BY c.relname, grantee, a.privilege_type;

\echo '=== 6. Dangerous privileges held by a NON-OWNER (must be empty) ==='
-- TRUNCATE is not governed by RLS and row triggers do not fire on it.
-- REFERENCES pins rows against deletion and leaks existence.
-- TRIGGER runs arbitrary code inside another role's write path.
-- MAINTAIN (PG17) includes LOCK TABLE — a denial-of-service vector.
SELECT c.relname,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
       a.privilege_type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace,
LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
  AND a.privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
  AND a.grantee <> c.relowner
ORDER BY 1, 2, 3;

\echo '=== 7. Function ACLs in public — NULL proacl expanded, so PUBLIC shows up ==='
SELECT p.oid::regprocedure::text AS func,
       p.prosecdef AS security_definer,
       COALESCE(array_to_string(p.proconfig, ','), '(no search_path pinned)') AS config,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
       a.privilege_type
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace,
LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
WHERE n.nspname = 'public'
ORDER BY 1, 4;

\echo '=== 8. Schema ACLs ==='
SELECT n.nspname,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
       a.privilege_type
FROM pg_namespace n,
LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
ORDER BY 1, 2, 3;

\echo '=== 9. Database ACL ==='
SELECT d.datname,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
       a.privilege_type
FROM pg_database d,
LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a
WHERE d.datname = current_database()
ORDER BY 2, 3;

\echo '=== 10. Default privileges — note defaclnamespace = 0 means GLOBAL ==='
-- A schema-scoped entry is MERGED ON TOP OF acldefault() and can therefore
-- only ADD privileges. Only a GLOBAL entry (defaclnamespace = 0) can suppress
-- the built-in EXECUTE-to-PUBLIC on functions or USAGE-to-PUBLIC on types.
-- Measured on PostgreSQL 17.6: the schema-scoped form of that REVOKE stores no
-- row at all and has no effect, while reporting success.
SELECT pg_get_userbyid(d.defaclrole) AS creator_role,
       COALESCE(n.nspname, '(GLOBAL)') AS scope,
       CASE d.defaclobjtype
         WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences'
         WHEN 'f' THEN 'functions' WHEN 'T' THEN 'types'
         WHEN 'n' THEN 'schemas' ELSE d.defaclobjtype::text END AS objtype,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
       a.privilege_type,
       a.is_grantable
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace,
LATERAL aclexplode(d.defaclacl) a
ORDER BY 1, 2, 3, 4, 5;

\echo '=== 11. RLS posture ==='
SELECT c.relname,
       c.relrowsecurity      AS rls_enabled,
       c.relforcerowsecurity AS force_rls,
       pg_get_userbyid(c.relowner) AS owner,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
ORDER BY 1;

\echo '=== 12. Policies and the roles they bind to (polroles = {0} means TO PUBLIC) ==='
SELECT c.relname, p.polname, p.polcmd, p.polpermissive,
       COALESCE(
         (SELECT string_agg(r.rolname, ',' ORDER BY r.rolname)
          FROM unnest(p.polroles) ro JOIN pg_roles r ON r.oid = ro),
         'PUBLIC') AS applies_to
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
ORDER BY 1, 2;

\echo '=== 13. Non-internal triggers ==='
SELECT c.relname, t.tgname, t.tgenabled,
       p.oid::regprocedure::text AS function,
       (t.tgtype & 32) = 32 AS fires_on_truncate
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE n.nspname = 'public' AND NOT t.tgisinternal
ORDER BY 1, 2;

\echo '=== 14. SECURITY DEFINER functions and their search_path ==='
-- A SECURITY DEFINER function without a pinned search_path resolves unqualified
-- names using the CALLER's search_path while running with the OWNER's rights.
SELECT p.oid::regprocedure::text AS func,
       pg_get_userbyid(p.proowner) AS runs_as,
       COALESCE(array_to_string(p.proconfig, ','), '*** NO search_path PINNED ***') AS config
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
ORDER BY 1;

\echo '=== 15. Corroboration only — effective privileges of the Uellix roles ==='
-- has_table_privilege() folds direct grants, membership, PUBLIC, ownership,
-- superuser and BYPASSRLS into one boolean. Useful to confirm the application
-- will work; useless to prove an ACL is correct. Read it alongside query 5,
-- never instead of it.
SELECT r.rolname,
       count(*) FILTER (WHERE has_table_privilege(r.rolname, c.oid, 'SELECT'))   AS can_select,
       count(*) FILTER (WHERE has_table_privilege(r.rolname, c.oid, 'INSERT'))   AS can_insert,
       count(*) FILTER (WHERE has_table_privilege(r.rolname, c.oid, 'UPDATE'))   AS can_update,
       count(*) FILTER (WHERE has_table_privilege(r.rolname, c.oid, 'DELETE'))   AS can_delete,
       count(*) FILTER (WHERE has_table_privilege(r.rolname, c.oid, 'TRUNCATE')) AS can_truncate
FROM pg_roles r,
     pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
  AND r.rolname IN ('uellix_owner','uellix_migrator','uellix_app','uellix_writer',
                    'uellix_auditor','anon','authenticated','service_role','postgres')
GROUP BY r.rolname
ORDER BY r.rolname;
