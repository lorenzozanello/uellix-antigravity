import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(process.cwd())
const PREPARED = path.join(ROOT, 'db', 'prepared')

function read(name: string): string {
  return readFileSync(path.join(PREPARED, name), 'utf8')
}

function executable(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
}

type MembershipRow = {
  memberName: string
  roleName: string
  grantorName: string
  inheritOption: boolean
  setOption: boolean
  adminOption: boolean
}

const CANONICAL_MEMBERSHIPS: readonly MembershipRow[] = [
  {
    memberName: 'uellix_migrator',
    roleName: 'uellix_owner',
    grantorName: 'postgres',
    inheritOption: false,
    setOption: true,
    adminOption: false,
  },
  {
    memberName: 'uellix_app',
    roleName: 'uellix_writer',
    grantorName: 'postgres',
    inheritOption: true,
    setOption: false,
    adminOption: false,
  },
  {
    memberName: 'postgres',
    roleName: 'uellix_writer',
    grantorName: 'postgres',
    inheritOption: true,
    setOption: false,
    adminOption: false,
  },
]

function isControlledMembership(row: MembershipRow): boolean {
  return (
    ['uellix_app', 'uellix_writer', 'uellix_migrator'].includes(row.memberName) ||
    ['uellix_app', 'uellix_writer', 'uellix_owner', 'uellix_migrator'].includes(row.roleName)
  )
}

function matchesCanonicalTuple(row: MembershipRow, expected: MembershipRow): boolean {
  return (
    row.memberName === expected.memberName &&
    row.roleName === expected.roleName &&
    row.grantorName === expected.grantorName &&
    row.inheritOption === expected.inheritOption &&
    row.setOption === expected.setOption &&
    row.adminOption === expected.adminOption
  )
}

function exactInventoryAccepts(rows: readonly MembershipRow[]): boolean {
  const controlled = rows.filter(isControlledMembership)

  return (
    controlled.every((row) => CANONICAL_MEMBERSHIPS.some((expected) => matchesCanonicalTuple(row, expected))) &&
    CANONICAL_MEMBERSHIPS.every(
      (expected) => controlled.filter((row) => matchesCanonicalTuple(row, expected)).length === 1,
    )
  )
}

function expectProductionVerifierToCompareGrantor(sql: string): void {
  expect(sql).toMatch(
    /expected\(member_name, role_name, grantor_name, inherit_option, set_option, admin_option\)/,
  )
  expect(sql).toMatch(/\('uellix_migrator', 'uellix_owner', 'postgres', false, true, false\)/)
  expect(sql).toMatch(/\('uellix_app', 'uellix_writer', 'postgres', true, false, false\)/)
  expect(sql).toMatch(/\('postgres', 'uellix_writer', 'postgres', true, false, false\)/)
  expect(sql).toMatch(/(?:a\.grantor_name = e\.grantor_name|e\.grantor_name = a\.grantor_name)/)
}

describe('R3.4 controlled PostgreSQL 17 membership inventory', () => {
  const bootstrap = () => read('stella_0001_role_topology_bootstrap.sql')
  const decisions = () => read('stella_0003_suggestion_decisions.sql')
  const separation = () => read('stella_0004_role_separation.sql')

  it('defines precisely the three canonical membership edges and their option flags', () => {
    const sql = executable(bootstrap())

    expectProductionVerifierToCompareGrantor(sql)
  })

  it('rejects wrong-grantor, duplicate-grantor, ADMIN and SET attacks against the full canonical tuple', () => {
    const canonicalRows = CANONICAL_MEMBERSHIPS.map((row) => ({ ...row }))
    const [migratorOwner, appWriter] = canonicalRows

    expect(exactInventoryAccepts(canonicalRows)).toBe(true)
    expect(
      exactInventoryAccepts([
        ...canonicalRows.filter((row) => row !== migratorOwner),
        { ...migratorOwner, grantorName: 'supabase_admin' },
      ]),
    ).toBe(false)
    expect(exactInventoryAccepts([...canonicalRows, { ...appWriter, grantorName: 'supabase_admin' }])).toBe(false)
    expect(
      exactInventoryAccepts([
        ...canonicalRows,
        { ...appWriter, grantorName: 'supabase_admin', adminOption: true },
      ]),
    ).toBe(false)
    expect(
      exactInventoryAccepts([
        ...canonicalRows,
        { ...appWriter, grantorName: 'supabase_admin', setOption: true },
      ]),
    ).toBe(false)
  })

  it('binds every production verifier to the same full grantor-aware tuple', () => {
    for (const sql of [executable(bootstrap()), executable(decisions()), executable(separation())]) {
      expectProductionVerifierToCompareGrantor(sql)
      expect(sql).toMatch(/count\(\*\)[\s\S]*?<> 1/i)
    }
  })

  it('fails the bootstrap precondition before it can reconcile a row from the wrong grantor', () => {
    const sql = bootstrap()
    const precondition = sql.indexOf('canonical membership precondition')
    const reconcile = sql.indexOf('REVOKE uellix_owner FROM uellix_migrator')

    expect(precondition).toBeGreaterThan(-1)
    expect(precondition).toBeLessThan(reconcile)
  })

  it('fails the SET=false ADMIN=true and SET=true ADMIN=false owner-edge attacks', () => {
    const sql = executable(bootstrap())

    // Both attacks are relevant perimeter rows. Exact pair/options comparison
    // must reject either one, and the perimeter must separately reject ADMIN.
    expect(sql).toMatch(/a\.admin_option/)
    expect(sql).toMatch(/unexpected relevant membership/i)
    expect(sql).toMatch(/a\.inherit_option IS NOT DISTINCT FROM e\.inherit_option/)
    expect(sql).toMatch(/a\.set_option IS NOT DISTINCT FROM e\.set_option/)
  })

  it('rejects direct and transitive SET/ADMIN escalation to the owner', () => {
    const bootstrapSql = executable(bootstrap())
    const decisionsSql = executable(decisions())

    for (const sql of [bootstrapSql, decisionsSql]) {
      // PostgreSQL resolves SET through membership paths, so this one catalogue
      // primitive covers both a direct app->owner edge and an indirect path.
      expect(sql).toMatch(/pg_has_role\(app_oid, owner_oid, 'SET'\)/)
      expect(sql).toMatch(/admin_option/)
    }
    expect(bootstrap()).toMatch(/transitive SET path/i)
    expect(decisions()).toMatch(/transitive/i)
  })

  it('makes 0003 preflight and postcheck use the same exact inventory, including wrong flags', () => {
    const sql = executable(decisions())

    expect(sql.match(/pg_auth_members/g)?.length).toBeGreaterThanOrEqual(4)
    expect(sql).toMatch(/count\(\*\)[\s\S]*?<> 1/i)
    expect(sql).toMatch(/unexpected relevant membership/i)
    expect(sql).toMatch(/wrong (?:grantor, )?membership flags/i)
  })

  it('limits the perimeter by catalogue role identity so a disjoint harmless membership is not rejected', () => {
    const sql = executable(separation())
    const disjointMembership: MembershipRow = {
      memberName: 'unrelated_uellix_reader',
      roleName: 'unrelated_uellix_reporting',
      grantorName: 'postgres',
      inheritOption: true,
      setOption: false,
      adminOption: false,
    }

    expect(exactInventoryAccepts([...CANONICAL_MEMBERSHIPS, disjointMembership])).toBe(true)
    expect(sql).toMatch(/m\.rolname IN \('uellix_app', 'uellix_writer', 'uellix_migrator'\)/)
    expect(sql).toMatch(/r\.rolname IN \('uellix_app', 'uellix_writer', 'uellix_owner', 'uellix_migrator'\)/)
    expect(sql).not.toMatch(/m\.rolname LIKE 'uellix\\_%'/)
  })
})
