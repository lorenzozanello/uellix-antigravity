// tests/database-default-privileges.test.ts
//
// Coverage for the default-privilege half of prepared stella_0004: what a
// table, sequence, function or type that does not exist yet will be born with.
//
// THE DEFECT CLASS THIS FILE EXISTS FOR
//
// Every finding below was invisible to the migrations in this repository,
// because none of them granted anything. Supabase's bootstrap installs
// pg_default_acl entries, and PostgreSQL itself has non-empty built-in
// defaults for functions and types. Measured on this stack, PostgreSQL 17.6:
//
//   * a table created by `postgres` in `public` was born granting
//     TRUNCATE/REFERENCES/TRIGGER/MAINTAIN to `authenticated` — and TRUNCATE
//     is not governed by RLS, nor do row triggers fire on it;
//   * a table created by `supabase_admin` in `public` was born granting ALL
//     EIGHT privileges to the UNAUTHENTICATED role `anon`;
//   * a sequence created by `postgres` granted UPDATE to `anon`, and UPDATE on
//     a sequence confers nextval() and setval();
//   * a function was born EXECUTE-able by PUBLIC, and a type USAGE-able by
//     PUBLIC, because acldefault('f') and acldefault('T') are not empty.
//
// COVERAGE BOUNDARY, STATED PLAINLY
//
// The live assertions here read pg_catalog. They do NOT create a probe object,
// because this file runs under `readonly_audit`, whose session is opened with
// default_transaction_read_only = on — a test that could CREATE TABLE would
// mean the read-only guarantee was not real.
//
// The BEHAVIOURAL proof — create a table, a function and a type as the new
// owner and assert PUBLIC gets nothing — lives in section 9.11b of
// db/prepared/stella_0004_role_separation.sql, runs at apply time, and aborts
// the entire transaction on failure. That is stronger than a test that runs
// afterwards, and the offline layer below asserts that proof is still present
// in the script.

import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { LIVE_CATALOG, catalogSql } from './helpers/local-catalog'

const REPO_ROOT = path.resolve(__dirname, '..')
const forward = readFileSync(
  path.join(REPO_ROOT, 'db/prepared/stella_0004_role_separation.sql'),
  'utf8'
)

function code(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

const forwardCode = code(forward)

/** Grantees that must never appear in a default ACL for schema public. */
const FORBIDDEN_DEFAULT_GRANTEES = ['anon', 'authenticated', 'service_role', 'PUBLIC']

afterAll(async () => {
  await LIVE_CATALOG.close()
})

/* -------------------------------------------------------------------------- */
/* OFFLINE                                                                    */
/* -------------------------------------------------------------------------- */

describe('stella_0004: default-privilege statements', () => {
  it('repairs the two creator roles Supabase configured', () => {
    for (const role of ['postgres', 'supabase_admin']) {
      for (const objs of ['TABLES', 'SEQUENCES', 'FUNCTIONS']) {
        expect(forwardCode).toMatch(
          new RegExp(
            `ALTER DEFAULT PRIVILEGES FOR ROLE ${role} IN SCHEMA public\\s+REVOKE ALL ON ${objs} FROM anon, authenticated, service_role`,
            'i'
          )
        )
      }
    }
  })

  it('suppresses the built-in PUBLIC defaults with the GLOBAL form, not the schema-scoped one', () => {
    // THE measured trap. On PostgreSQL 17.6:
    //
    //   ALTER DEFAULT PRIVILEGES FOR ROLE r IN SCHEMA public
    //     REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
    //       -> 0 rows in pg_default_acl, no effect, reports success.
    //
    //   ALTER DEFAULT PRIVILEGES FOR ROLE r
    //     REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
    //       -> 1 row with defaclnamespace = 0, and the new function's proacl
    //          becomes {r=X/r}: PUBLIC gets nothing.
    //
    // A schema-scoped entry is merged ON TOP OF acldefault() and can only ADD.
    // This test fails if anyone "tidies up" the global form into the scoped one.
    for (const role of ['uellix_owner', 'uellix_migrator']) {
      expect(forwardCode).toMatch(
        new RegExp(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}\\s+REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`, 'i')
      )
      expect(forwardCode).toMatch(
        new RegExp(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}\\s+REVOKE USAGE\\s+ON TYPES\\s+FROM PUBLIC`, 'i')
      )
      // And explicitly NOT the inert scoped form.
      expect(forwardCode).not.toMatch(
        new RegExp(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role} IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`, 'i')
      )
    }
  })

  it('does not apply a global default-privilege change to a Supabase-internal role', () => {
    // A global entry for `postgres` or `supabase_admin` would reach every
    // object they create in auth, storage, realtime and graphql — outside this
    // script's allowlist. Their statements must all carry IN SCHEMA public.
    for (const [stmt] of forwardCode.matchAll(/ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE\s+(\w+)[\s\S]*?;/gi)) {
      const role = /FOR\s+ROLE\s+(\w+)/i.exec(stmt)?.[1]
      if (role === 'postgres' || role === 'supabase_admin') {
        expect(stmt, `${role} default privileges must be scoped to schema public`)
          .toMatch(/IN\s+SCHEMA\s+public/i)
      }
    }
  })

  it('grants no positive default privilege to any role', () => {
    // A table created by uellix_owner must be born with relacl = NULL, i.e.
    // owner-only. Every new table then requires an explicit GRANT — which is
    // the objective: an inherited grant is a grant nobody reviewed.
    for (const [stmt] of forwardCode.matchAll(/ALTER\s+DEFAULT\s+PRIVILEGES[\s\S]*?;/gi)) {
      expect(stmt, 'no ALTER DEFAULT PRIVILEGES may GRANT').not.toMatch(/\bGRANT\b/i)
    }
  })

  it('keeps the behavioural future-object proof inside the script', () => {
    // The catalog cannot distinguish a working suppression row from an inert
    // one, so the script proves the effect at apply time.
    expect(forwardCode).toMatch(/CREATE FUNCTION public\.zz_stella_0004_probe/i)
    expect(forwardCode).toMatch(/CREATE TYPE public\.zz_stella_0004_probe_t/i)
    expect(forwardCode).toMatch(/CREATE TABLE public\.zz_stella_0004_probe_tbl/i)
    expect(forwardCode).toMatch(/has_function_privilege\('public'[\s\S]{0,120}RAISE EXCEPTION/i)
    // And cleans up after itself.
    expect(forwardCode).toMatch(/DROP FUNCTION public\.zz_stella_0004_probe/i)
    expect(forwardCode).toMatch(/DROP TYPE public\.zz_stella_0004_probe_t/i)
    expect(forwardCode).toMatch(/DROP TABLE public\.zz_stella_0004_probe_tbl/i)
  })

  it('scans BOTH schema-scoped and GLOBAL entries when verifying', () => {
    // A postcondition that INNER JOINs pg_namespace on defaclnamespace cannot
    // match a global row, so it would be blind to the only form that actually
    // suppresses the built-in PUBLIC grant — and to an
    // `ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT ALL ON TABLES TO anon`
    // that makes every future table writable by the unauthenticated role.
    expect(forwardCode).toMatch(/LEFT JOIN pg_namespace n ON n\.oid = d\.defaclnamespace/i)
    expect(forwardCode).toMatch(/WHERE \(d\.defaclnamespace = 0 OR n\.nspname = 'public'\)/i)
    // And the same class is refused up front rather than only reported at the end.
    expect(forwardCode).toMatch(/precondition failed: a GLOBAL default privilege already grants/i)
  })

  it('handles MAINTAIN explicitly and refuses to run before PostgreSQL 17', () => {
    // MAINTAIN confers VACUUM / ANALYZE / CLUSTER / REINDEX / REFRESH
    // MATERIALIZED VIEW / LOCK TABLE. LOCK TABLE alone lets a role stall
    // writers to an audit trail.
    //
    // Matched inside a REVOKE rather than as a standalone `REVOKE MAINTAIN`:
    // the token travels in the same statement as TRUNCATE/REFERENCES/TRIGGER,
    // which is possible only because section 0 already refuses any server
    // older than 17. That precondition IS the version guard — a per-statement
    // `IF` would be a second, redundant one.
    const revokes = [...forwardCode.matchAll(/\bREVOKE\b[^;]*;/gi)].map(([s]) => s)
    expect(revokes.some((s) => /\bMAINTAIN\b/i.test(s) && /\bauthenticated\b/i.test(s))).toBe(true)
    expect(revokes.some((s) => /\bMAINTAIN\b/i.test(s) && /uellix_writer/i.test(s))).toBe(true)
    expect(forwardCode).toMatch(/server_version_num[\s\S]{0,120}170000/i)
  })
})

/* -------------------------------------------------------------------------- */
/* LIVE                                                                       */
/* -------------------------------------------------------------------------- */

const liveDescribe = describe.skipIf(!LIVE_CATALOG.available)

liveDescribe('live catalog: default privileges', () => {
  it('no default ACL in schema public reaches anon, authenticated, service_role or PUBLIC', async () => {
    const rows = await catalogSql<
      { creator: string; objtype: string; grantee: string; privilege_type: string }[]
    >`
      SELECT pg_get_userbyid(d.defaclrole) AS creator,
             d.defaclobjtype::text AS objtype,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
             a.privilege_type
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace,
      LATERAL aclexplode(d.defaclacl) a
      WHERE n.nspname = 'public'
      ORDER BY 1, 2, 3, 4
    `
    const offenders = rows.filter((r) => FORBIDDEN_DEFAULT_GRANTEES.includes(r.grantee))
    expect(offenders.map((r) => `${r.creator}/${r.objtype}/${r.grantee}/${r.privilege_type}`)).toEqual([])
  })

  it('no default ACL still carries MAINTAIN for anon, authenticated, service_role or PUBLIC', async () => {
    // Scoped to the four grantees this design excludes, NOT to "anyone but the
    // creator". Supabase's own `supabase_admin -> postgres` entry legitimately
    // carries MAINTAIN: it is how the platform gives its admin role access to
    // what its bootstrap creates, it predates this change, and stella_0004
    // deliberately does not touch Supabase-internal role relationships.
    // MAINTAIN matters here because it confers LOCK TABLE — a denial-of-service
    // vector — and that argument applies to the API roles, not to the database
    // owner.
    //
    // GLOBAL rows (defaclnamespace = 0) are included: a schema-scoped-only scan
    // is exactly the blind spot that the forward script's own §9.11 had.
    const rows = await catalogSql<{ creator: string; scope: string; grantee: string }[]>`
      SELECT pg_get_userbyid(d.defaclrole) AS creator,
             CASE WHEN d.defaclnamespace = 0 THEN 'GLOBAL' ELSE n.nspname END AS scope,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
      FROM pg_default_acl d
      LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace,
      LATERAL aclexplode(d.defaclacl) a
      WHERE (d.defaclnamespace = 0 OR n.nspname = 'public')
        AND a.privilege_type = 'MAINTAIN'
        AND (a.grantee = 0
             OR a.grantee IN ('anon'::regrole::oid, 'authenticated'::regrole::oid,
                              'service_role'::regrole::oid))
    `
    expect(rows.map((r) => `${r.creator}/${r.scope}->${r.grantee}`)).toEqual([])
  })

  it('the four GLOBAL PUBLIC-suppression rows exist', async () => {
    const rows = await catalogSql<{ creator: string; objtype: string; scope: string }[]>`
      SELECT pg_get_userbyid(d.defaclrole) AS creator,
             d.defaclobjtype::text AS objtype,
             CASE WHEN d.defaclnamespace = 0 THEN 'GLOBAL' ELSE 'SCHEMA' END AS scope
      FROM pg_default_acl d
      WHERE pg_get_userbyid(d.defaclrole) IN ('uellix_owner','uellix_migrator')
        AND d.defaclobjtype IN ('f','T')
    `
    // Sorted in JS, not by the server: `ORDER BY defaclobjtype::text` depends on
    // the database collation for 'f' vs 'T', which is not a property this test
    // is about and which differs between an ICU and a C collation.
    const seen = rows.map((r) => `${r.creator}/${r.objtype}/${r.scope}`).sort()
    expect(seen).toEqual([
      'uellix_migrator/T/GLOBAL',
      'uellix_migrator/f/GLOBAL',
      'uellix_owner/T/GLOBAL',
      'uellix_owner/f/GLOBAL',
    ])
  })

  it('those rows leave PUBLIC out of the stored ACL', async () => {
    // The row existing is not the same as the row working: a schema-scoped row
    // would also be "present". PUBLIC (grantee 0) must be absent from the value.
    const rows = await catalogSql<{ creator: string; objtype: string; grantee: string }[]>`
      SELECT pg_get_userbyid(d.defaclrole) AS creator,
             d.defaclobjtype::text AS objtype,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
      FROM pg_default_acl d,
      LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclnamespace = 0
        AND pg_get_userbyid(d.defaclrole) IN ('uellix_owner','uellix_migrator')
      ORDER BY 1, 2, 3
    `
    expect(rows.filter((r) => r.grantee === 'PUBLIC')).toEqual([])
    // Each row must still hold the owner's own privilege, or the row would be
    // deleted by PostgreSQL and the built-in default would come back.
    expect(rows.length).toBe(4)
    for (const row of rows) {
      expect(row.grantee).toBe(row.creator)
    }
  })

  it('no Uellix creator role has a POSITIVE default privilege on tables or sequences', async () => {
    // Confirms 7d: a new table is born owner-only and must be granted
    // explicitly. If someone adds a convenience default here, this fails.
    const rows = await catalogSql<{ creator: string; objtype: string; grantee: string }[]>`
      SELECT pg_get_userbyid(d.defaclrole) AS creator,
             d.defaclobjtype::text AS objtype,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
      FROM pg_default_acl d,
      LATERAL aclexplode(d.defaclacl) a
      WHERE pg_get_userbyid(d.defaclrole) LIKE 'uellix\\_%'
        AND d.defaclobjtype IN ('r','S')
    `
    expect(rows.map((r) => `${r.creator}/${r.objtype}/${r.grantee}`)).toEqual([])
  })

  it('acldefault still behaves as this design assumes', async () => {
    // The whole model rests on what a NULL ACL means. If a future PostgreSQL
    // changed these, several checks elsewhere would quietly become vacuous.
    const rows = await catalogSql<{ objtype: string; acl: string }[]>`
      SELECT 'r' AS objtype, acldefault('r','uellix_owner'::regrole)::text AS acl
      UNION ALL SELECT 'S', acldefault('S','uellix_owner'::regrole)::text
      UNION ALL SELECT 'f', acldefault('f','uellix_owner'::regrole)::text
      UNION ALL SELECT 'T', acldefault('T','uellix_owner'::regrole)::text
      ORDER BY 1
    `
    const byType = new Map(rows.map((r) => [r.objtype, r.acl]))
    // An aclitem whose grantee is PUBLIC is rendered with an EMPTY name, so it
    // is the item that starts with '='. Matching on a bare '=' would match
    // `uellix_owner=arwdDxtm/...` too and make every assertion here vacuous.
    expect(byType.get('r'), 'a new relation must be owner-only').not.toContain('{=')
    expect(byType.get('S'), 'a new sequence must be owner-only').not.toContain('{=')
    // Functions and types carry a built-in grant to PUBLIC. This is the grant
    // that only a GLOBAL default-privilege row can suppress, and the reason
    // `proacl IS NULL` must never be read as "nothing granted".
    expect(byType.get('f'), 'acldefault for functions must still grant EXECUTE to PUBLIC').toContain('{=X/')
    expect(byType.get('T'), 'acldefault for types must still grant USAGE to PUBLIC').toContain('{=U/')
  })
})
