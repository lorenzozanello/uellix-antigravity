// tests/database-role-safety.test.ts
//
// Coverage for the R3.4 split role authority (stella_0001) and object
// separation model (stella_0004).
//
// TWO LAYERS, AND THE BOUNDARY IS DELIBERATE:
//
//   OFFLINE (always runs) — invariants of the prepared SQL itself. These are
//     the checks that catch a bad edit before it ever reaches a database: a
//     CASCADE creeping in, an ALTER DEFAULT PRIVILEGES losing its FOR ROLE, the
//     two allowlists drifting apart, the rollback losing its confirmation gate.
//
//   LIVE (skipped when the local stack is unreachable) — the actual end state
//     read from pg_catalog. `pnpm test:unit` must stay runnable without Docker,
//     so these skip rather than fail; the offline layer never skips.
//
// Nothing here writes. The live layer connects with the `readonly_audit`
// capability, which is local-only and opens the session with
// `default_transaction_read_only = on`.
//
// ACL is read with aclexplode over COALESCE(acl, acldefault(...)). Never with
// information_schema.role_table_grants — see db/audit/canonical_acl.sql for
// the three measured reasons that view is banned as a gate source.

import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { LIVE_CATALOG, catalogSql } from './helpers/local-catalog'

const REPO_ROOT = path.resolve(__dirname, '..')
const FORWARD_PATH = path.join(REPO_ROOT, 'db/prepared/stella_0004_role_separation.sql')
const ROLLBACK_PATH = path.join(REPO_ROOT, 'db/prepared/stella_0004_rollback.sql')
const TOPOLOGY_BOOTSTRAP_PATH = path.join(
  REPO_ROOT,
  'db/prepared/stella_0001_role_topology_bootstrap.sql',
)
const TOPOLOGY_ROLLBACK_PATH = path.join(
  REPO_ROOT,
  'db/prepared/stella_0001_role_topology_bootstrap_rollback.sql',
)

const forward = readFileSync(FORWARD_PATH, 'utf8')
const rollback = readFileSync(ROLLBACK_PATH, 'utf8')
const topologyBootstrap = readFileSync(TOPOLOGY_BOOTSTRAP_PATH, 'utf8')
const topologyRollback = readFileSync(TOPOLOGY_ROLLBACK_PATH, 'utf8')

/** SQL with `--` comments stripped, so a construct named in prose is not a hit. */
function code(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

const forwardCode = code(forward)
const rollbackCode = code(rollback)
const topologyBootstrapCode = code(topologyBootstrap)
const topologyRollbackCode = code(topologyRollback)

const UELLIX_ROLES = [
  'uellix_owner',
  'uellix_migrator',
  'uellix_app',
  'uellix_writer',
  'uellix_auditor',
] as const

const APPEND_ONLY_TABLES = [
  'audit_logs',
  'sroi_calculation_line_items',
  'sroi_calculation_runs',
  'stella_interactions',
  'stella_suggestion_decisions',
] as const

const OPERATIONAL_TABLES = [
  'evidence_items', 'financial_proxies', 'funders', 'fx_rates', 'impact_narratives',
  'indicators', 'invitations', 'marketing_leads', 'methodology_review_matrix',
  'methodology_review_matrix_items', 'organization_members', 'organizations',
  'outcome_funder_allocations', 'outcome_proxy_assignments', 'outcome_taxonomy_mappings',
  'outcomes', 'portfolios', 'project_investments', 'projects', 'proxy_sources',
  'signup_allowlist', 'sroi_assignment_inputs', 'sroi_filter_sets', 'sroi_report_sections',
  'sroi_reports', 'sroi_run_review_items', 'sroi_run_reviews', 'stakeholder_groups',
  'taxonomy_catalogs', 'taxonomy_codes', 'theory_of_change_links', 'theory_of_change_nodes',
  'users',
] as const

const ALL_TABLES = [...APPEND_ONLY_TABLES, ...OPERATIONAL_TABLES]

/** Schemas Supabase owns. No object of theirs may be touched by stella_0004. */
const SUPABASE_INTERNAL_SCHEMAS = [
  'auth', 'storage', 'realtime', 'graphql', 'graphql_public', 'vault', 'net',
  'extensions', 'supabase_functions', 'pgbouncer', '_realtime',
  'supabase_migrations', 'drizzle',
] as const

afterAll(async () => {
  await LIVE_CATALOG.close()
})

/* -------------------------------------------------------------------------- */
/* OFFLINE — invariants of the prepared SQL                                   */
/* -------------------------------------------------------------------------- */

describe('stella_0004 forward: forbidden constructs', () => {
  it('never uses CASCADE', () => {
    // A CASCADE on a REVOKE or a DROP in a privilege script silently removes
    // dependent grants and objects nobody enumerated. The whole design is an
    // allowlist; CASCADE is the opposite of an allowlist.
    expect(forwardCode).not.toMatch(/\bCASCADE\b/i)
    expect(rollbackCode).not.toMatch(/\bCASCADE\b/i)
  })

  it('never uses DROP OWNED or REASSIGN OWNED', () => {
    // Both operate on everything a role touches across the whole database,
    // which for `postgres` in a Supabase stack means Supabase's own objects.
    expect(forwardCode).not.toMatch(/\bDROP\s+OWNED\b/i)
    expect(forwardCode).not.toMatch(/\bREASSIGN\s+OWNED\b/i)
    expect(rollbackCode).not.toMatch(/\bDROP\s+OWNED\b/i)
    expect(rollbackCode).not.toMatch(/\bREASSIGN\s+OWNED\b/i)
  })

  it('never uses GRANT ALL on a table or schema', () => {
    // `GRANT ALL ON TABLE` includes TRUNCATE, REFERENCES, TRIGGER and MAINTAIN,
    // which is exactly the surplus this script exists to remove. Privileges are
    // always enumerated.
    //
    // `ALTER DEFAULT PRIVILEGES ... GRANT ALL` in the ROLLBACK is a separate,
    // separately-authorised path that restores Supabase's original (unsafe)
    // defaults on explicit request; it is excluded here by matching only the
    // plain GRANT form.
    const plainGrantAll = /(?<!ALTER\s+DEFAULT\s+PRIVILEGES[\s\S]{0,200})\bGRANT\s+ALL\b/i
    expect(forwardCode).not.toMatch(/\bGRANT\s+ALL\b/i)
    expect(plainGrantAll.test(rollbackCode.replace(/ALTER DEFAULT PRIVILEGES[^;]*;/gi, ''))).toBe(false)
  })

  it('every ALTER DEFAULT PRIVILEGES names FOR ROLE explicitly', () => {
    // Without FOR ROLE the statement silently applies to the CURRENT role. This
    // script runs as a superuser, so the entry nobody meant to create would be
    // the superuser's — invisible in review and active for every future object
    // that role creates.
    const statements = [...forwardCode.matchAll(/ALTER\s+DEFAULT\s+PRIVILEGES[\s\S]*?;/gi)]
    expect(statements.length).toBeGreaterThan(0)
    for (const [stmt] of statements) {
      expect(stmt).toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE\s+\w+/i)
    }
  })

  it('never reads information_schema.role_table_grants as a gate source', () => {
    // The comment blocks explain WHY that view is banned, so the assertion is
    // on the executable text only. Checking the raw file would forbid
    // documenting the ban, which is the opposite of the intent.
    expect(forwardCode).not.toMatch(/role_table_grants/i)
    expect(rollbackCode).not.toMatch(/role_table_grants/i)
    // ...and the explanation must still be present.
    expect(forward).toMatch(/role_table_grants/i)
  })

  it('reads every ACL through COALESCE(acl, acldefault(...)), never raw', () => {
    // A NULL acl column means "the built-in default for this object type", and
    // for functions that default is EXECUTE TO PUBLIC. Reading `proacl IS NULL`
    // as "nothing granted" is precisely how an EXECUTE-to-anon is missed, so
    // every ACL read in the script must expand the default explicitly.
    const aclReads = [...forwardCode.matchAll(/aclexplode\(\s*([A-Za-z_][\w.]*|COALESCE)/gi)]
    expect(aclReads.length).toBeGreaterThan(0)
    for (const [, head] of aclReads) {
      // pg_default_acl.defaclacl is never NULL — a row only exists when it has
      // a value — so it is the one column that needs no COALESCE.
      if (head.toLowerCase() === 'd.defaclacl') continue
      expect(head.toUpperCase(), 'ACL read without acldefault expansion').toBe('COALESCE')
    }
  })
})

describe('stella_0004 forward: allowlist integrity', () => {
  it('names every table explicitly, in both the precondition and the transfer', () => {
    for (const table of ALL_TABLES) {
      // Once in the section 0 precondition arrays, once in the section 4
      // ownership transfer, at minimum.
      const occurrences = forwardCode.split(`'${table}'`).length - 1
      expect(occurrences, `${table} must appear in the precondition and transfer allowlists`)
        .toBeGreaterThanOrEqual(2)
    }
  })

  it('classifies exactly 38 tables, split 5 append-only / 33 operational', () => {
    expect(APPEND_ONLY_TABLES.length).toBe(5)
    expect(OPERATIONAL_TABLES.length).toBe(33)
    expect(new Set(ALL_TABLES).size).toBe(38)
  })

  it('grants the append-only tables SELECT and INSERT only', () => {
    const grantBlock = forwardCode.slice(
      forwardCode.indexOf('GRANT SELECT, INSERT ON'),
      forwardCode.indexOf('-- 6b. Operational')
    )
    expect(grantBlock).toContain('TO uellix_writer')
    for (const table of APPEND_ONLY_TABLES) {
      expect(grantBlock).toContain(`public.${table}`)
    }
    // The convergence REVOKE in the same block must take back UPDATE/DELETE.
    expect(grantBlock).toMatch(/REVOKE\s+UPDATE,\s*DELETE,\s*TRUNCATE,\s*REFERENCES,\s*TRIGGER/i)
  })

  it('never grants UPDATE or DELETE on an append-only table to any Uellix role', () => {
    // Scan every GRANT statement: if it confers UPDATE or DELETE, none of the
    // five append-only tables may appear in it.
    for (const [stmt] of forwardCode.matchAll(/\bGRANT\s+[\s\S]*?;/gi)) {
      if (!/\b(UPDATE|DELETE)\b/i.test(stmt)) continue
      if (/^\s*GRANT\s+\w+\s+TO\s/i.test(stmt)) continue // role membership grant
      for (const table of APPEND_ONLY_TABLES) {
        expect(stmt, `append-only table ${table} appears in a GRANT conferring UPDATE/DELETE`)
          .not.toContain(`public.${table}`)
      }
    }
  })

  it('modifies no object in a Supabase-internal schema', () => {
    // The property is about MODIFICATION, not mention: section 9.13 legitimately
    // reads `auth.users` through has_table_privilege() to prove the new owner
    // cannot see the identity store, and forbidding the name outright would
    // forbid that proof.
    //
    // So: any line carrying a DDL/DCL verb must not also carry a qualified name
    // in an internal schema. The one documented exception — `GRANT USAGE ON
    // SCHEMA auth TO uellix_owner` — is schema-level and therefore has no dot.
    const ddl = /\b(ALTER|GRANT|REVOKE|DROP|CREATE|TRUNCATE)\b/i
    const offenders: string[] = []
    for (const line of forwardCode.split('\n')) {
      if (!ddl.test(line)) continue
      for (const schema of SUPABASE_INTERNAL_SCHEMAS) {
        if (new RegExp(`\\b${schema}\\.[A-Za-z_]`, 'i').test(line)) {
          offenders.push(`${schema}: ${line.trim().slice(0, 90)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('refuses a database whose anon/PUBLIC surface it was not designed for', () => {
    // Three preconditions added after adversarial review. Each guards a class
    // of state this script narrows but does not redesign, and each aborts
    // rather than proceeding on a database it does not recognise.
    expect(forwardCode, 'anon/PUBLIC table privileges')
      .toMatch(/precondition failed: anon or PUBLIC already hold privileges/i)
    expect(forwardCode, 'anon/service_role EXECUTE on public functions')
      .toMatch(/precondition failed: anon, service_role or PUBLIC already hold EXECUTE/i)
    expect(forwardCode, 'pre-existing GLOBAL default privilege')
      .toMatch(/precondition failed: a GLOBAL default privilege already grants/i)
  })

  it('refuses a public schema containing anything it does not classify', () => {
    // Every ownership and ACL check filters relkind IN ('r','p'). A view, a
    // matview or a sequence would fall through all of them — and a
    // postgres-owned view is read with ITS owner's rights, and postgres has
    // BYPASSRLS, so an anon-granted view in public is a complete RLS bypass
    // that the 38/104/10 fingerprint would certify as clean.
    expect(forwardCode).toMatch(/precondition failed: public contains view\/matview\/sequence/i)
    expect(forwardCode).toMatch(/precondition failed: public contains user-defined type/i)
  })

  it('verifies default privileges at GLOBAL scope, not only in schema public', () => {
    // The postcondition used to INNER JOIN pg_namespace on defaclnamespace,
    // which can never match a global row (defaclnamespace = 0) — blind to
    // exactly the class section 7c argues is the decisive one.
    const section = forwardCode.slice(forwardCode.indexOf('FROM pg_default_acl d'))
    expect(section).toMatch(/LEFT JOIN pg_namespace n ON n\.oid = d\.defaclnamespace/i)
    expect(section).toMatch(/d\.defaclnamespace = 0 OR n\.nspname = 'public'/i)
  })

  it('grants exactly one schema-level privilege outside public, and it is USAGE on auth', () => {
    // Needed because three SECURITY DEFINER functions call auth.uid() and the
    // ownership transfer changes their effective user. Without it every policy
    // that calls them errors — for every caller, including PostgREST.
    const schemaGrants = [...topologyBootstrapCode.matchAll(/\b(GRANT|REVOKE)\s+[A-Z, ]+\s+ON\s+SCHEMA\s+(\w+)[^;]*;/gi)]
    const outsidePublic = schemaGrants.filter((m) => m[2].toLowerCase() !== 'public')
    expect(outsidePublic).toHaveLength(1)
    expect(outsidePublic[0][0]).toMatch(/GRANT\s+USAGE\s+ON\s+SCHEMA\s+auth\s+TO\s+uellix_owner/i)
  })

  it('does not enable FORCE ROW LEVEL SECURITY', () => {
    // Deliberate: FORCE RLS would subject the SECURITY DEFINER helpers owned by
    // the new owner to RLS, and handle_new_user() writes to public.users from
    // an auth.users trigger with no JWT claims. Signup would break.
    expect(forwardCode).not.toMatch(/FORCE\s+ROW\s+LEVEL\s+SECURITY/i)
  })

  it('creates no policy and no trigger', () => {
    expect(forwardCode).not.toMatch(/CREATE\s+POLICY/i)
    expect(forwardCode).not.toMatch(/DROP\s+POLICY/i)
    expect(forwardCode).not.toMatch(/CREATE\s+TRIGGER/i)
    expect(forwardCode).not.toMatch(/DROP\s+TRIGGER/i)
  })

  it('sets no password on any role it creates', () => {
    // A LOGIN role with no password cannot authenticate via scram or md5 at
    // all, so the roles exist with their privileges while network access to
    // them stays a separate, explicit operational act. Credentials are
    // provisioned out of band and never live in this repository.
    //
    // Matched on the DDL rather than on the bare word: the verification
    // section legitimately reads pg_authid.rolpassword and mentions "password"
    // in a NOTICE, and a bare /password/ would flag both.
    expect(forwardCode).not.toMatch(/\b(CREATE|ALTER)\s+ROLE\b[^;]*\bPASSWORD\b/i)
    expect(forwardCode).not.toMatch(/PASSWORD\s+'/i)
  })

  it('refuses to run as a non-superuser', () => {
    // A CREATEROLE non-superuser is auto-granted ADMIN OPTION on every role it
    // creates (PostgreSQL 16+), which would let it re-grant itself SET on the
    // owner and make the separation nominal.
    expect(forwardCode).toMatch(/rolsuper[\s\S]{0,200}RAISE EXCEPTION/i)
  })
})

describe('stella_0004 rollback: authorisation and safety', () => {
  it('requires an exact confirmation token bound to the database', () => {
    expect(rollbackCode).toMatch(/uellix_rollback_confirmation/)
    expect(rollbackCode).toMatch(/'rollback-0004:'\s*\|\|\s*current_database\(\)/)
    expect(rollbackCode).toMatch(/RAISE EXCEPTION[^;]*REFUSED/i)
  })

  it('aborts on drift instead of guessing', () => {
    expect(rollbackCode).toMatch(/REFUSED: drift/i)
  })

  it('does not restore the unsafe defaults without a second, separate opt-in', () => {
    expect(rollbackCode).toMatch(/uellix_rollback_restore_unsafe_defaults/)
    // The re-grant of Supabase's original default privileges must sit behind
    // the flag, not run unconditionally.
    const unsafeSection = rollbackCode.slice(
      rollbackCode.indexOf('uellix.rollback_restore_unsafe_defaults')
    )
    expect(unsafeSection).toMatch(/RAISE WARNING/i)
  })

  it('leaves topology removal exclusively to the 0001 rollback', () => {
    expect(rollbackCode).not.toMatch(/DROP\s+ROLE\s+uellix_/i)
    for (const role of UELLIX_ROLES) {
      expect(topologyRollbackCode).toMatch(new RegExp(`DROP\\s+ROLE\\s+${role}\\b`, 'i'))
    }
  })

  it('keeps reversal of the topology-level auth USAGE in the 0001 rollback', () => {
    expect(rollbackCode).not.toMatch(/REVOKE\s+USAGE\s+ON\s+SCHEMA\s+auth\s+FROM\s+uellix_owner/i)
    expect(topologyRollbackCode).toMatch(/REVOKE\s+USAGE\s+ON\s+SCHEMA\s+auth\s+FROM\s+uellix_owner/i)
  })

  it('keeps reversal of GLOBAL topology defaults in the 0001 rollback', () => {
    // A schema-scoped re-grant would leave the global row in place, and a role
    // with a surviving pg_default_acl row cannot be dropped.
    for (const role of ['uellix_owner', 'uellix_migrator']) {
      expect(topologyRollbackCode).toMatch(
        new RegExp(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}\\s+GRANT EXECUTE ON FUNCTIONS TO PUBLIC`, 'i')
      )
      expect(topologyRollbackCode).toMatch(
        new RegExp(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}\\s+GRANT USAGE\\s+ON TYPES\\s+TO PUBLIC`, 'i')
      )
    }
  })
})

/* -------------------------------------------------------------------------- */
/* LIVE — the end state, read from pg_catalog                                 */
/* -------------------------------------------------------------------------- */

const liveDescribe = describe.skipIf(!LIVE_CATALOG.available)

liveDescribe('live catalog: role attributes', () => {
  it('all five Uellix roles exist with no dangerous attribute', async () => {
    const rows = await catalogSql<
      {
        rolname: string
        rolsuper: boolean
        rolbypassrls: boolean
        rolcreaterole: boolean
        rolcreatedb: boolean
        rolreplication: boolean
        rolinherit: boolean
        rolcanlogin: boolean
      }[]
    >`
      SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
             rolreplication, rolinherit, rolcanlogin
      FROM pg_roles WHERE rolname LIKE 'uellix\\_%' ORDER BY rolname
    `
    expect(rows.map((r) => r.rolname).sort()).toEqual([...UELLIX_ROLES].sort())
    for (const row of rows) {
      expect(row.rolsuper, `${row.rolname} superuser`).toBe(false)
      expect(row.rolbypassrls, `${row.rolname} BYPASSRLS`).toBe(false)
      expect(row.rolcreaterole, `${row.rolname} CREATEROLE`).toBe(false)
      expect(row.rolcreatedb, `${row.rolname} CREATEDB`).toBe(false)
      expect(row.rolreplication, `${row.rolname} REPLICATION`).toBe(false)
      // NOINHERIT on every role: privileges reached through membership must be
      // a per-grant decision, never a role-wide default.
      expect(row.rolinherit, `${row.rolname} INHERIT`).toBe(false)
    }
  })

  it('the owner and the writer cannot open a session', async () => {
    const rows = await catalogSql<{ rolname: string; rolcanlogin: boolean }[]>`
      SELECT rolname, rolcanlogin FROM pg_roles
      WHERE rolname IN ('uellix_owner','uellix_writer')
    `
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.rolcanlogin, `${row.rolname} must be NOLOGIN`).toBe(false)
    }
  })

  // INVERTED BY THE RUNTIME CUTOVER (stella_0005).
  //
  // Before the cutover the three LOGIN roles were credential-less, and this
  // test asserted that. That was correct while they were unused: a LOGIN role
  // with no password cannot authenticate at all, so an unused role was also an
  // unreachable one.
  //
  // The runtime now AUTHENTICATES as `uellix_app`, so the absence of a password
  // would mean the cutover had not happened. The property worth pinning is no
  // longer "no credential exists" but "credentials exist, are strongly hashed,
  // and only the LOGIN roles have one" — the owner in particular must stay
  // unreachable by password.
  //
  // The credentials themselves are minted by
  // scripts/rotate-local-role-credentials.ts and live only in gitignored env
  // files. Nothing in this test reads or reveals one; `rolpassword` is compared
  // for SHAPE, never for value.
  it('every Uellix LOGIN role carries a SCRAM-hashed password', async () => {
    const rows = await catalogSql<{ rolname: string; scheme: string | null }[]>`
      SELECT rolname,
             CASE
               WHEN rolpassword IS NULL                  THEN NULL
               WHEN rolpassword LIKE 'SCRAM-SHA-256$%'   THEN 'scram'
               WHEN rolpassword LIKE 'md5%'              THEN 'md5'
               ELSE 'plaintext'
             END AS scheme
      FROM pg_authid
      WHERE rolname LIKE 'uellix\\_%' AND rolcanlogin
      ORDER BY rolname
    `
    expect(rows.map((r) => r.rolname)).toEqual(['uellix_app', 'uellix_auditor', 'uellix_migrator'])
    for (const row of rows) {
      expect(row.scheme, `${row.rolname} password scheme`).toBe('scram')
    }
  })

  it('no NOLOGIN Uellix role has a password — the owner stays unreachable', async () => {
    const rows = await catalogSql<{ rolname: string }[]>`
      SELECT rolname FROM pg_authid
      WHERE rolname LIKE 'uellix\\_%' AND NOT rolcanlogin AND rolpassword IS NOT NULL
    `
    expect(rows.map((r) => r.rolname)).toEqual([])
  })

  it('the auditor defaults to read-only transactions', async () => {
    const rows = await catalogSql<{ setconfig: string[] }[]>`
      SELECT s.setconfig FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = 'uellix_auditor'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0].setconfig).toContain('default_transaction_read_only=on')
  })
})

liveDescribe('live catalog: memberships', () => {
  it('has exactly three memberships, with exactly the intended options', async () => {
    const rows = await catalogSql<
      {
        member: string
        member_of: string
        admin_option: boolean
        inherit_option: boolean
        set_option: boolean
      }[]
    >`
      SELECT m.rolname AS member, r.rolname AS member_of,
             a.admin_option, a.inherit_option, a.set_option
      FROM pg_auth_members a
      JOIN pg_roles m ON m.oid = a.member
      JOIN pg_roles r ON r.oid = a.roleid
      WHERE m.rolname LIKE 'uellix\\_%' OR r.rolname LIKE 'uellix\\_%'
      ORDER BY member, member_of
    `
    expect(rows).toEqual([
      // The runtime always carries the writer's DML and can never become it.
      { member: 'postgres', member_of: 'uellix_writer', admin_option: false, inherit_option: true, set_option: false },
      { member: 'uellix_app', member_of: 'uellix_writer', admin_option: false, inherit_option: true, set_option: false },
      // INHERIT FALSE is the heart of the design: the migrator does not carry
      // the owner's power, it must ask for it with an explicit SET ROLE.
      { member: 'uellix_migrator', member_of: 'uellix_owner', admin_option: false, inherit_option: false, set_option: true },
    ])
  })

  it('neither the runtime nor postgres can reach the owner', async () => {
    const rows = await catalogSql<{ label: string; reachable: boolean }[]>`
      SELECT 'app_usage'    AS label, pg_has_role('uellix_app','uellix_owner','USAGE')  AS reachable
      UNION ALL SELECT 'app_member',  pg_has_role('uellix_app','uellix_owner','MEMBER')
      UNION ALL SELECT 'pg_usage',    pg_has_role('postgres','uellix_owner','USAGE')
      UNION ALL SELECT 'pg_member',   pg_has_role('postgres','uellix_owner','MEMBER')
      UNION ALL SELECT 'auditor_writer', pg_has_role('uellix_auditor','uellix_writer','USAGE')
      UNION ALL SELECT 'auditor_owner',  pg_has_role('uellix_auditor','uellix_owner','USAGE')
    `
    for (const row of rows) {
      expect(row.reachable, `${row.label} must be unreachable`).toBe(false)
    }
  })

  it('the migrator can SET ROLE to the owner but does not inherit it', async () => {
    const rows = await catalogSql<{ can_set: boolean; inherits: boolean }[]>`
      SELECT pg_has_role('uellix_migrator','uellix_owner','MEMBER') AS can_set,
             pg_has_role('uellix_migrator','uellix_owner','USAGE')  AS inherits
    `
    expect(rows[0].can_set).toBe(true)
    expect(rows[0].inherits).toBe(false)
  })

  it('no Uellix role is a member of a Supabase API role', async () => {
    const rows = await catalogSql<{ member: string; member_of: string }[]>`
      SELECT m.rolname AS member, r.rolname AS member_of
      FROM pg_auth_members a
      JOIN pg_roles m ON m.oid = a.member
      JOIN pg_roles r ON r.oid = a.roleid
      WHERE m.rolname LIKE 'uellix\\_%'
        AND r.rolname IN ('anon','authenticated','authenticator','service_role',
                          'supabase_admin','pg_read_all_data','pg_write_all_data')
    `
    expect(rows).toEqual([])
  })
})

liveDescribe('live catalog: ownership', () => {
  it('every table and function in public belongs to uellix_owner', async () => {
    const rows = await catalogSql<{ objname: string; owner: string }[]>`
      SELECT c.relname AS objname, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      UNION ALL
      SELECT p.oid::regprocedure::text, pg_get_userbyid(p.proowner)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
      ORDER BY 1
    `
    expect(rows).toHaveLength(46) // 38 tables + 8 functions
    const wrong = rows.filter((r) => r.owner !== 'uellix_owner')
    expect(wrong.map((r) => `${r.objname}:${r.owner}`)).toEqual([])
  })

  it('no Uellix role owns anything outside public and drizzle', async () => {
    // pg_toast is excluded because a TOAST relation's owner is kept in lockstep
    // with its parent table by PostgreSQL — transferring 38 tables transfers
    // their TOAST entries as an unavoidable side effect.
    //
    // `drizzle` was added by stella_0005b. It holds `__drizzle_migrations`,
    // which is Uellix's own migration bookkeeping and was owned by `postgres`
    // only because drizzle-kit happened to create it while connected as that
    // role. Leaving it there would have kept one table in the migration chain
    // that the migrator could touch only by borrowing an administrative
    // identity. It is named EXPLICITLY rather than the filter being loosened to
    // "anything Uellix happens to own", so a future stray ownership transfer
    // still fails this test.
    const rows = await catalogSql<{ obj: string; owner: string }[]>`
      SELECT n.nspname || '.' || c.relname AS obj, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('public','pg_toast','drizzle')
        AND pg_get_userbyid(c.relowner) LIKE 'uellix\\_%'
    `
    expect(rows).toEqual([])
  })

  it('the drizzle bookkeeping schema and table belong to uellix_owner', async () => {
    const rows = await catalogSql<{ obj: string; owner: string }[]>`
      SELECT 'schema' AS obj, pg_get_userbyid(nspowner) AS owner
        FROM pg_namespace WHERE nspname = 'drizzle'
      UNION ALL
      SELECT c.relname, pg_get_userbyid(c.relowner)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'drizzle' AND c.relkind IN ('r','S')
      ORDER BY 1
    `
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.owner, `drizzle.${row.obj}`).toBe('uellix_owner')
    }
  })

  it('the public schema itself is not owned by a Uellix role', async () => {
    // Supabase's convention is pg_database_owner; changing it breaks CREATE
    // resolution for the database owner.
    const rows = await catalogSql<{ owner: string }[]>`
      SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'public'
    `
    expect(rows[0].owner).toBe('pg_database_owner')
  })
})

liveDescribe('live catalog: table ACLs', () => {
  it('no non-owner holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN anywhere in public', async () => {
    const rows = await catalogSql<{ relname: string; grantee: string; privilege_type: string }[]>`
      SELECT c.relname,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
             a.privilege_type
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace,
      LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND a.privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
        AND a.grantee <> c.relowner
      ORDER BY 1, 2, 3
    `
    expect(rows.map((r) => `${r.relname}:${r.grantee}:${r.privilege_type}`)).toEqual([])
  })

  it('anon and PUBLIC hold nothing at all in public', async () => {
    const rows = await catalogSql<{ relname: string; grantee: string; privilege_type: string }[]>`
      SELECT c.relname,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
             a.privilege_type
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace,
      LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND (a.grantee = 0 OR a.grantee = 'anon'::regrole::oid)
    `
    expect(rows.map((r) => `${r.relname}:${r.grantee}:${r.privilege_type}`)).toEqual([])
  })

  it('the writer holds SELECT+INSERT everywhere and nothing more on append-only tables', async () => {
    const rows = await catalogSql<{ relname: string; privileges: string }[]>`
      SELECT c.relname,
             string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privileges
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace,
      LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND a.grantee = 'uellix_writer'::regrole::oid
      GROUP BY c.relname ORDER BY c.relname
    `
    const byTable = new Map(rows.map((r) => [r.relname, r.privileges]))
    expect(byTable.size).toBe(38)
    for (const table of APPEND_ONLY_TABLES) {
      expect(byTable.get(table), `${table} is append-only`).toBe('INSERT,SELECT')
    }
    for (const table of OPERATIONAL_TABLES) {
      expect(byTable.get(table), `${table} is operational`).toBe('DELETE,INSERT,SELECT,UPDATE')
    }
  })

  it('the auditor holds SELECT and only SELECT', async () => {
    const rows = await catalogSql<{ privileges: string }[]>`
      SELECT DISTINCT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privileges
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace,
      LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND a.grantee = 'uellix_auditor'::regrole::oid
      GROUP BY c.relname
    `
    expect(rows.map((r) => r.privileges)).toEqual(['SELECT'])
  })

  it('the app and the migrator hold no direct table privilege', async () => {
    // Everything the app can do arrives through uellix_writer, so the write
    // surface is one role's grants rather than 38 ACLs.
    const rows = await catalogSql<{ relname: string; grantee: string }[]>`
      SELECT c.relname, pg_get_userbyid(a.grantee) AS grantee
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace,
      LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND a.grantee IN ('uellix_app'::regrole::oid, 'uellix_migrator'::regrole::oid)
    `
    expect(rows).toEqual([])
  })
})

liveDescribe('live catalog: functions and indirect write paths', () => {
  it('PUBLIC holds EXECUTE on no function in public', async () => {
    const rows = await catalogSql<{ func: string }[]>`
      SELECT p.oid::regprocedure::text AS func
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
      LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE n.nspname = 'public' AND a.grantee = 0
    `
    expect(rows.map((r) => r.func)).toEqual([])
  })

  it('no Uellix role may EXECUTE a SECURITY DEFINER function that writes', async () => {
    const rows = await catalogSql<{ rolname: string; func: string }[]>`
      SELECT r.rolname, f.func
      FROM (VALUES ('uellix_app'),('uellix_writer'),('uellix_auditor'),('uellix_migrator')) AS r(rolname),
           (VALUES ('public.handle_new_user()'),('public.handle_update_user()')) AS f(func)
      WHERE has_function_privilege(r.rolname, f.func::regprocedure, 'EXECUTE')
    `
    expect(rows.map((r) => `${r.rolname}:${r.func}`)).toEqual([])
  })

  it('the writer and the auditor CAN execute the three read-only RLS helpers', async () => {
    // Not a concession — a requirement. Evaluating a policy needs the INVOKING
    // role to hold EXECUTE on every function the policy expression calls.
    // Without these, a SELECT fails with "permission denied for function
    // current_user_org_ids" instead of returning the rows RLS allows.
    const rows = await catalogSql<{ rolname: string; func: string; allowed: boolean }[]>`
      SELECT r.rolname, f.func, has_function_privilege(r.rolname, f.func::regprocedure, 'EXECUTE') AS allowed
      FROM (VALUES ('uellix_writer'),('uellix_auditor')) AS r(rolname),
           (VALUES ('public.current_user_org_ids()'),
                   ('public.current_user_is_super_admin()'),
                   ('public.current_user_role_in_org(uuid)')) AS f(func)
    `
    expect(rows).toHaveLength(6)
    for (const row of rows) {
      expect(row.allowed, `${row.rolname} needs EXECUTE on ${row.func}`).toBe(true)
    }
  })

  it('the owner can reach schema auth but no table inside it', async () => {
    const rows = await catalogSql<{ schema_usage: boolean; users_select: boolean }[]>`
      SELECT has_schema_privilege('uellix_owner','auth','USAGE') AS schema_usage,
             has_table_privilege('uellix_owner','auth.users','SELECT') AS users_select
    `
    expect(rows[0].schema_usage).toBe(true)
    expect(rows[0].users_select).toBe(false)
  })

  it('no Uellix role holds a privilege on a Supabase-internal relation', async () => {
    const rows = await catalogSql<{ obj: string; grantee: string; privilege_type: string }[]>`
      SELECT n.nspname || '.' || c.relname AS obj,
             pg_get_userbyid(a.grantee) AS grantee, a.privilege_type
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace,
      LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      -- drizzle is excluded because it is NOT Supabase-internal: it is Uellix's
      -- own migration bookkeeping, transferred to uellix_owner by stella_0005b.
      -- The privileges that show up there are the owner's own, which is the
      -- intended end state rather than a leak into somebody else's schema.
      -- Ownership of that schema is asserted separately above.
      WHERE n.nspname NOT IN ('public','pg_toast','drizzle')
        AND c.relkind IN ('r','p','v','m','S')
        AND pg_get_userbyid(a.grantee) LIKE 'uellix\\_%'
    `
    expect(rows.map((r) => `${r.obj}:${r.grantee}:${r.privilege_type}`)).toEqual([])
  })
})

liveDescribe('live catalog: RLS and structure are untouched', () => {
  it('RLS is on for all 38 tables and FORCE is off for all 38', async () => {
    const rows = await catalogSql<{ rls_on: string; force_on: string; total: string }[]>`
      SELECT count(*) FILTER (WHERE c.relrowsecurity)::text      AS rls_on,
             count(*) FILTER (WHERE c.relforcerowsecurity)::text AS force_on,
             count(*)::text                                      AS total
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    `
    expect(rows[0]).toEqual({ rls_on: '38', force_on: '0', total: '38' })
  })

  // 104 -> 107. stella_0005 added exactly three INSERT policies, to
  // `audit_logs`, `stella_interactions` and `stella_suggestion_decisions`.
  //
  // This is the one count in the cutover that MOVED, and it moved because it
  // had to. All three tables had a SELECT policy and no INSERT policy: every
  // write to them succeeded only because the runtime was `postgres` and
  // bypassed RLS. Under `uellix_app` the same INSERT fails with "new row
  // violates row-level security policy" — measured on this stack before the
  // cutover, not predicted. Without the three policies, Stella could read its
  // interactions and never record another one.
  //
  // The number is asserted rather than relaxed to a lower bound: a policy count
  // that can only drift upwards is not an invariant.
  it('the 107 policies and 10 append-only triggers are intact and enabled', async () => {
    const rows = await catalogSql<{ policies: string; triggers: string; disabled: string }[]>`
      SELECT (SELECT count(*)::text FROM pg_policy p
              JOIN pg_class c ON c.oid = p.polrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public') AS policies,
             (SELECT count(*)::text FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND NOT t.tgisinternal) AS triggers,
             (SELECT count(*)::text FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled <> 'O') AS disabled
    `
    expect(rows[0]).toEqual({ policies: '107', triggers: '10', disabled: '0' })
  })

  it('the three added policies are INSERT-only, on exactly the three append-only tables', async () => {
    const rows = await catalogSql<{ tablename: string; policyname: string; cmd: string }[]>`
      SELECT tablename, policyname, cmd FROM pg_policies
      WHERE schemaname = 'public' AND policyname LIKE '%\\_insert\\_member\\_or\\_admin'
      ORDER BY tablename
    `
    expect(rows.map((r) => r.tablename)).toEqual([
      'audit_logs',
      'stella_interactions',
      'stella_suggestion_decisions',
    ])
    for (const row of rows) {
      expect(row.cmd, `${row.tablename} policy command`).toBe('INSERT')
    }
  })

  it('PUBLIC holds no CREATE on schema public', async () => {
    const rows = await catalogSql<{ privilege_type: string }[]>`
      SELECT a.privilege_type
      FROM pg_namespace n,
      LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
      WHERE n.nspname = 'public' AND a.grantee = 0
    `
    expect(rows.map((r) => r.privilege_type)).not.toContain('CREATE')
  })
})
