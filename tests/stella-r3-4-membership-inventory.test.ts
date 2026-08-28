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

describe('R3.4 controlled PostgreSQL 17 membership inventory', () => {
  const bootstrap = () => read('stella_0001_role_topology_bootstrap.sql')
  const decisions = () => read('stella_0003_suggestion_decisions.sql')
  const separation = () => read('stella_0004_role_separation.sql')

  it('defines precisely the three canonical membership edges and their option flags', () => {
    const sql = executable(bootstrap())

    expect(sql).toMatch(/\('uellix_migrator', 'uellix_owner', false, true, false\)/)
    expect(sql).toMatch(/\('uellix_app', 'uellix_writer', true, false, false\)/)
    expect(sql).toMatch(/\('postgres', 'uellix_writer', true, false, false\)/)
  })

  it('rejects a second grantor row rather than treating positive membership existence as proof', () => {
    const sql = executable(bootstrap())

    // A second pg_auth_members row can carry the same member, role and flags
    // under another grantor. The verifier must read the row cardinality and its
    // grantor, not stop at EXISTS for the canonical-looking edge.
    expect(sql).toMatch(/pg_auth_members[\s\S]*?grantor/)
    expect(sql).toMatch(/count\(\*\)[\s\S]*?<> 1/i)
    expect(sql).toMatch(/multiple grantor|grantor row/i)
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
    expect(sql).toMatch(/wrong membership flags/i)
  })

  it('limits the perimeter by catalogue role identity so a disjoint harmless membership is not rejected', () => {
    const sql = executable(separation())

    expect(sql).toMatch(/m\.rolname IN \('uellix_app', 'uellix_writer', 'uellix_migrator'\)/)
    expect(sql).toMatch(/r\.rolname IN \('uellix_app', 'uellix_writer', 'uellix_owner', 'uellix_migrator'\)/)
    expect(sql).not.toMatch(/m\.rolname LIKE 'uellix\\_%'/)
  })
})
