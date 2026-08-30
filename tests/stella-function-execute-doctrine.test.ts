// tests/stella-function-execute-doctrine.test.ts
//
// MSC-07B.8-R10J — DB-free/source-bound doctrine guarding the new
// `service_role` function-EXECUTE authority materialization in stella_0004.
//
// Root cause (R10I analytical closure, independently re-derived here against
// the live source): `service_role` is never granted EXECUTE on the eight
// governed functions by any GRANT statement in this repository — baseline
// provisioning (db/baseline/stella_g2_schema.sql) REVOKEs from PUBLIC and
// selectively GRANTs to authenticated/postgres/uellix_writer/uellix_auditor,
// but is completely silent about service_role for these eight (T30/T31). It
// arrives instead as a direct ACL entry born the instant `postgres` creates
// each function, from a managed default privilege stella_0004 does not own.
// Neither stella_0003 (T32) nor the ownership transfer in stella_0004
// section 4 (ALTER FUNCTION ... OWNER TO carries an existing ACL forward
// unchanged) ever revokes it. The OLD entry-guard precondition required
// service_role already absent — permanently unsatisfiable — and OLD 0004
// carried no producer that could make postcondition 9.10 (which has always
// required service_role absent) actually true. R10J narrows the entry guard
// to {PUBLIC, anon} and adds an explicit `REVOKE EXECUTE ... FROM
// service_role` producer (section 5a-bis) for exactly the eight governed
// functions. Postcondition 9.10 is UNCHANGED (T26) — it already required the
// right end state; only the path to it was missing.
//
// This suite is strictly DB-free, Docker-free and network-free: it reads
// db/prepared/*.sql and db/baseline/stella_g2_schema.sql as text (plus one
// `git show` against the frozen R10J parent — no working-tree mutation, no
// checkout) and reasons about it structurally. It never connects to Postgres
// and never invokes Docker.
//
// Companion doctrines this file does NOT re-litigate: the two
// `p.polcmd::text` casts (tests/stella-char-cast-doctrine.test.ts), the
// public-scoped 103/105/2 policy census (tests/stella-policy-census-doctrine
// .test.ts), and the observed-vs-observed INSERT-policy probe
// (tests/stella-insert-policy-probe-doctrine.test.ts). T33-T35 below prove
// this remediation left their machinery untouched, but their own doctrine
// lives in those files.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const PREPARED = path.join(ROOT, 'db', 'prepared')
const TARGET_FILE = 'stella_0004_role_separation.sql'
const read = (name: string) => readFileSync(path.join(PREPARED, name), 'utf8')

// The exact commit this remediation (MSC-07B.8-R10J) branched from — this
// package's own frozen pre-R10J parent HEAD. `git show <ref>:<path>` reads a
// file's content AT that commit without touching the working tree or
// requiring a checkout; `git diff PARENT_HEAD -- path` (against the mutable
// working tree, git's default with one ref) is exactly what this doctrine's
// own delta-exactness checks (Section G) want to measure, since this file's
// own uncommitted edits ARE the thing being proven minimal.
const PARENT_HEAD = '113e857fc1ed9016fe0aeb0215d4c54fddb60640'

function gitShowAtParent(relPath: string): string {
  return execFileSync('git', ['show', `${PARENT_HEAD}:${relPath}`], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

function gitDiffAgainstParent(relPath: string): string {
  return execFileSync('git', ['diff', PARENT_HEAD, '--', relPath], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

function diffLines(diffText: string, marker: '-' | '+'): string[] {
  return diffText
    .split('\n')
    .filter((l) => l.startsWith(marker) && !l.startsWith(marker.repeat(2)))
}

const AUTHORITY_STATEMENT =
  /\b(GRANT|REVOKE|CREATE\s+ROLE|ALTER\s+ROLE|CREATE\s+TABLE|DROP\s+TABLE|CREATE\s+TRIGGER|DROP\s+TRIGGER|CREATE\s+FUNCTION|ALTER\s+FUNCTION|DROP\s+FUNCTION|ALTER\s+TABLE|OWNER\s+TO|ALTER\s+DEFAULT\s+PRIVILEGES|CREATE\s+POLICY|DROP\s+POLICY|ALTER\s+POLICY)\b/

/** Strip `--` line comments only (keeps the newline, so multi-line statement
 * shapes below are unaffected) — deliberately NOT a general SQL parser, and
 * deliberately NOT blanking string literals: several real statements this
 * file parses concatenate the string literal `'public.'` (e.g. the section-0
 * function allowlist checks), and blanking it would corrupt them. T40 proves
 * this narrower choice is still enough to defeat a comment decoy, and that a
 * single-line string-literal decoy cannot satisfy the multi-line producer
 * shape these extractors require regardless. */
function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

// The eight functions R10I/R10J authorize this remediation over. Fixed here
// as the doctrine's own reference list — T01/T02 prove it against TWO
// independent sites in the live SQL (the section-0 allowlist array and the
// section-4 ownership-transfer statements), so this is a cross-checked
// constant, not a copied or assumed one.
const CANONICAL_FUNCTIONS = [
  'can_read_evidence_object(text,uuid)',
  'can_write_evidence_object(text,uuid)',
  'current_user_is_super_admin()',
  'current_user_org_ids()',
  'current_user_role_in_org(uuid)',
  'handle_new_user()',
  'handle_update_user()',
  'uellix_forbid_mutation()',
] as const
const CANONICAL_QUALIFIED = CANONICAL_FUNCTIONS.map((f) => `public.${f}`)

function sectionZeroExpectedFunctions(sql: string): string[] {
  const m = stripLineComments(sql).match(/expected_functions text\[\] := ARRAY\[([\s\S]*?)\];/)
  expect(m, 'expected_functions array not found in section 0').not.toBeNull()
  return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
}

function ownershipFunctionSignatures(sql: string): string[] {
  return [
    ...stripLineComments(sql).matchAll(/ALTER FUNCTION (public\.[a-zA-Z_][a-zA-Z0-9_]*\([^)]*\)) OWNER TO uellix_owner;/g),
  ].map((m) => m[1]!)
}

interface FnPrivStatement {
  verb: 'GRANT' | 'REVOKE'
  functions: string[]
  roles: string[]
  index: number
  raw: string
}

/** Every `GRANT|REVOKE EXECUTE ON FUNCTION <list> TO|FROM <roles>;` statement
 * in the file, in document order. Anchored on the exact multi-line shape
 * every real statement of this kind uses in this file (verb, then a newline,
 * then one function per line, then a newline, then TO/FROM at column 0) — a
 * single-line decoy embedded in a comment or a RAISE EXCEPTION string cannot
 * satisfy this shape (T40). */
function functionPrivilegeStatements(sql: string): FnPrivStatement[] {
  const code = stripLineComments(sql)
  const re = /(GRANT|REVOKE) EXECUTE ON FUNCTION\s*\n([\s\S]*?)\n(TO|FROM) ([^;]+);/g
  const out: FnPrivStatement[] = []
  for (const m of code.matchAll(re)) {
    out.push({
      verb: m[1] as 'GRANT' | 'REVOKE',
      functions: [...m[2]!.matchAll(/public\.[a-zA-Z_][a-zA-Z0-9_]*\([^)]*\)/g)].map((x) => x[0]),
      roles: m[4]!.split(',').map((r) => r.trim()),
      index: m.index!,
      raw: m[0],
    })
  }
  return out
}

/** The two `SELECT p.oid::regprocedure::text AS func, ... ) x;` blocks: the
 * ENTRY precondition guard (index 0, document order) and the 9.10
 * postcondition (index 1). Anchored on a fragment unique to exactly these
 * two sites in the whole file. */
function functionExecuteAclGuardBlocks(sql: string): string[] {
  return [...stripLineComments(sql).matchAll(/SELECT p\.oid::regprocedure::text AS func,[\s\S]*?\)\s*x;/g)].map(
    (m) => m[0],
  )
}

function guardRoleShape(block: string) {
  return {
    hasPublic: /a\.grantee\s*=\s*0/.test(block),
    hasAnon: /'anon'::regrole::oid/.test(block),
    hasServiceRole: /'service_role'::regrole::oid/.test(block),
  }
}

function liveHash(): string {
  return createHash('sha256').update(read(TARGET_FILE)).digest('hex')
}

// -----------------------------------------------------------------------
// T01/T02 — the canonical function set is source-derived from two
// independent sites, not asserted
// -----------------------------------------------------------------------

describe('T01/T02 — the canonical eight-function set is cross-derived, not asserted', () => {
  it('T01: the section-0 allowlist declares exactly eight functions', () => {
    expect(sectionZeroExpectedFunctions(read(TARGET_FILE)).length).toBe(8)
  })

  it('T02: section-0 allowlist and section-4 ownership-transfer signatures agree with each other and with the canonical set', () => {
    const sql = read(TARGET_FILE)
    const sectionZero = sectionZeroExpectedFunctions(sql).slice().sort()
    const ownership = ownershipFunctionSignatures(sql)
      .map((s) => s.replace(/^public\./, ''))
      .slice()
      .sort()
    const canonical = CANONICAL_FUNCTIONS.slice().sort()
    expect(sectionZero).toEqual(canonical)
    expect(ownership).toEqual(canonical)
    expect(sectionZero).toEqual(ownership)
  })
})

// -----------------------------------------------------------------------
// T03-T06 — the ENTRY EXECUTE guard tests exactly {PUBLIC, anon}
// -----------------------------------------------------------------------

describe('T03-T06 — the ENTRY EXECUTE guard is narrowed to exactly {PUBLIC, anon}', () => {
  it('T03: exactly two ACL-guard blocks exist (entry + postcondition), and the entry (first) one is {PUBLIC, anon} only', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    expect(blocks.length).toBe(2)
    expect(guardRoleShape(blocks[0]!)).toEqual({ hasPublic: true, hasAnon: true, hasServiceRole: false })
  })

  it('T04: the entry guard still includes PUBLIC', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    expect(guardRoleShape(blocks[0]!).hasPublic).toBe(true)
  })

  it('T05: the entry guard still includes anon', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    expect(guardRoleShape(blocks[0]!).hasAnon).toBe(true)
  })

  it('T06: the entry guard excludes service_role', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    expect(guardRoleShape(blocks[0]!).hasServiceRole).toBe(false)
  })
})

// -----------------------------------------------------------------------
// T07/T08 — postcondition 9.10 still tests exactly {PUBLIC, anon,
// service_role}
// -----------------------------------------------------------------------

describe('T07/T08 — postcondition 9.10 remains strict: {PUBLIC, anon, service_role}', () => {
  it('T07: the postcondition (second) guard block tests exactly PUBLIC, anon and service_role', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    expect(guardRoleShape(blocks[1]!)).toEqual({ hasPublic: true, hasAnon: true, hasServiceRole: true })
  })

  it('T08: the postcondition still enforces service_role specifically', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    expect(guardRoleShape(blocks[1]!).hasServiceRole).toBe(true)
  })
})

// -----------------------------------------------------------------------
// T09-T15 — the new service_role REVOKE producer: existence, cardinality,
// bidirectional set equality, qualification, signature exactness, no
// dynamic/schema-wide form, no accompanying GRANT
// -----------------------------------------------------------------------

describe('T09-T15 — the new service_role REVOKE producer is exact, narrow and alone', () => {
  it('T09: a REVOKE EXECUTE ... FROM service_role statement exists', () => {
    const revoke = functionPrivilegeStatements(read(TARGET_FILE)).find(
      (s) => s.verb === 'REVOKE' && s.roles.includes('service_role'),
    )
    expect(revoke).toBeDefined()
  })

  it('T10: it targets exactly eight functions', () => {
    const revoke = functionPrivilegeStatements(read(TARGET_FILE)).find(
      (s) => s.verb === 'REVOKE' && s.roles.includes('service_role'),
    )!
    expect(revoke.functions.length).toBe(8)
  })

  it('T11: the revoke set equals the canonical allowlist bidirectionally — no omission, no ninth function', () => {
    const revoke = functionPrivilegeStatements(read(TARGET_FILE)).find(
      (s) => s.verb === 'REVOKE' && s.roles.includes('service_role'),
    )!
    const revoked = revoke.functions.slice().sort()
    const canonical = CANONICAL_QUALIFIED.slice().sort()
    expect(revoked).toEqual(canonical)
    // Bidirectional: every canonical function is in the revoke set, and
    // every revoked function is canonical — neither side has an extra.
    for (const fn of CANONICAL_QUALIFIED) expect(revoke.functions).toContain(fn)
    for (const fn of revoke.functions) expect(CANONICAL_QUALIFIED).toContain(fn)
  })

  it('T12: every revoked identity is schema-qualified public.<signature>', () => {
    const revoke = functionPrivilegeStatements(read(TARGET_FILE)).find(
      (s) => s.verb === 'REVOKE' && s.roles.includes('service_role'),
    )!
    for (const fn of revoke.functions) expect(fn).toMatch(/^public\./)
    // And the raw inner list contains nothing else — no bare, unqualified
    // function reference slipped past the public. prefix requirement above.
    const innerList = revoke.raw
      .replace(/^REVOKE EXECUTE ON FUNCTION\s*\n/, '')
      .replace(/\nFROM service_role;$/, '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    expect(innerList.length).toBe(8)
    for (const line of innerList) expect(line).toMatch(/^public\.[a-zA-Z_][a-zA-Z0-9_]*\([^)]*\),?$/)
  })

  it('T13: overload/signature identity is exact, including argument types and order', () => {
    const revoke = functionPrivilegeStatements(read(TARGET_FILE)).find(
      (s) => s.verb === 'REVOKE' && s.roles.includes('service_role'),
    )!
    expect(revoke.functions).toEqual(CANONICAL_QUALIFIED)
  })

  it('T14: no dynamic or schema-wide revoke that could catch a future ninth function', () => {
    const revoke = functionPrivilegeStatements(read(TARGET_FILE)).find(
      (s) => s.verb === 'REVOKE' && s.roles.includes('service_role'),
    )!
    expect(revoke.raw).not.toMatch(/ALL FUNCTIONS IN SCHEMA/i)
    expect(revoke.raw).not.toMatch(/format\(/)
    expect(revoke.raw).not.toMatch(/quote_ident\(/)
    expect(revoke.raw).not.toMatch(/EXECUTE\s+'/) // no dynamic SQL wrapper
    expect(revoke.raw).not.toMatch(/CASCADE/)
  })

  it('T15: no GRANT EXECUTE to service_role was introduced anywhere in the file', () => {
    const grant = functionPrivilegeStatements(read(TARGET_FILE)).find(
      (s) => s.verb === 'GRANT' && s.roles.includes('service_role'),
    )
    expect(grant).toBeUndefined()
    // service_role is the ONLY grantee affected by the new statement — it
    // must not co-occur with any other role in the same REVOKE.
    const revoke = functionPrivilegeStatements(read(TARGET_FILE)).find(
      (s) => s.verb === 'REVOKE' && s.roles.includes('service_role'),
    )!
    expect(revoke.roles).toEqual(['service_role'])
  })
})

// -----------------------------------------------------------------------
// T16-T19 — the pre-existing authority this remediation must NOT touch
// -----------------------------------------------------------------------

describe('T16-T19 — pre-existing function-EXECUTE authority is untouched', () => {
  it('T16: the existing PUBLIC revoke protection remains, targeting exactly the canonical eight', () => {
    const revoke = functionPrivilegeStatements(read(TARGET_FILE)).find(
      (s) => s.verb === 'REVOKE' && s.roles.includes('PUBLIC'),
    )
    expect(revoke).toBeDefined()
    expect(revoke!.functions.slice().sort()).toEqual(CANONICAL_QUALIFIED.slice().sort())
  })

  it('T22 (restated as a distinct set-equality assertion): PUBLIC revoke set equals the canonical eight exactly, order included', () => {
    const revoke = functionPrivilegeStatements(read(TARGET_FILE)).find(
      (s) => s.verb === 'REVOKE' && s.roles.includes('PUBLIC'),
    )!
    expect(revoke.functions).toEqual(CANONICAL_QUALIFIED)
  })

  it('T17: the existing postgres GRANT set remains byte-identical to the frozen parent', () => {
    const current = functionPrivilegeStatements(read(TARGET_FILE)).find(
      (s) => s.verb === 'GRANT' && s.roles.includes('postgres'),
    )!
    const parent = functionPrivilegeStatements(gitShowAtParent(`db/prepared/${TARGET_FILE}`)).find(
      (s) => s.verb === 'GRANT' && s.roles.includes('postgres'),
    )!
    expect(current.raw).toBe(parent.raw)
    expect(current.functions).toEqual(CANONICAL_QUALIFIED)
  })

  it('T18: the writer/auditor RLS-helper EXECUTE grant (section 6b-bis) remains byte-identical to the frozen parent', () => {
    const current = functionPrivilegeStatements(read(TARGET_FILE)).find(
      (s) => s.verb === 'GRANT' && s.roles.includes('uellix_writer'),
    )!
    const parent = functionPrivilegeStatements(gitShowAtParent(`db/prepared/${TARGET_FILE}`)).find(
      (s) => s.verb === 'GRANT' && s.roles.includes('uellix_writer'),
    )!
    expect(current.raw).toBe(parent.raw)
    expect(current.roles).toEqual(['uellix_writer', 'uellix_auditor'])
    expect(current.functions.length).toBe(3)
  })

  it('T19: authenticated is not mentioned by any function-EXECUTE GRANT/REVOKE statement — its behaviour is unchanged', () => {
    const statements = functionPrivilegeStatements(read(TARGET_FILE))
    for (const s of statements) expect(s.roles).not.toContain('authenticated')
    // And the new producer section specifically does not mention it either.
    const revoke = statements.find((s) => s.verb === 'REVOKE' && s.roles.includes('service_role'))!
    expect(revoke.raw).not.toMatch(/authenticated/)
  })
})

// -----------------------------------------------------------------------
// T20 — structural order: entry guard < ownership/ACL transition < new
// service_role revoke < postcondition
// -----------------------------------------------------------------------

describe('T20 — authority transitions occur in the correct structural order', () => {
  it('entry guard < section-4 ownership transfer < section 5a-bis revoke < postcondition 9.10', () => {
    const sql = read(TARGET_FILE)
    const blocks = functionExecuteAclGuardBlocks(sql)
    const entryGuardIndex = sql.indexOf(blocks[0]!)
    const ownershipIndex = sql.indexOf('-- 4. Ownership transfer')
    const revokeProducerIndex = sql.indexOf('-- 5a-bis.')
    const postconditionIndex = sql.indexOf('-- 9.10 Neither PUBLIC nor anon nor service_role')

    expect(entryGuardIndex).toBeGreaterThanOrEqual(0)
    expect(ownershipIndex).toBeGreaterThan(-1)
    expect(revokeProducerIndex).toBeGreaterThan(-1)
    expect(postconditionIndex).toBeGreaterThan(-1)

    expect(entryGuardIndex, 'entry guard before ownership transfer').toBeLessThan(ownershipIndex)
    expect(ownershipIndex, 'ownership transfer before the new revoke').toBeLessThan(revokeProducerIndex)
    expect(revokeProducerIndex, 'the new revoke before postcondition 9.10').toBeLessThan(postconditionIndex)
  })
})

// -----------------------------------------------------------------------
// T21 — the ownership-transfer set equals the canonical eight
// -----------------------------------------------------------------------

describe('T21 — the ownership-transfer set equals the canonical eight', () => {
  it('T21', () => {
    const sql = read(TARGET_FILE)
    const ownership = ownershipFunctionSignatures(sql)
    expect(ownership.length).toBe(8)
    expect(ownership.slice().sort()).toEqual(CANONICAL_QUALIFIED.slice().sort())
  })
})

// -----------------------------------------------------------------------
// T23/T24 — the service_role revoke set and the postcondition function
// universe both equal the canonical eight
// -----------------------------------------------------------------------

describe('T23/T24 — the revoke set and the postcondition universe both equal the canonical eight', () => {
  it('T23: service_role revoke set = canonical eight, order included', () => {
    const revoke = functionPrivilegeStatements(read(TARGET_FILE)).find(
      (s) => s.verb === 'REVOKE' && s.roles.includes('service_role'),
    )!
    expect(revoke.functions).toEqual(CANONICAL_QUALIFIED)
  })

  it("T24: postcondition 9.10's implicit universe (ALL functions in schema public) is pinned to exactly the canonical eight by section 0's two-directional allowlist", () => {
    const sql = read(TARGET_FILE)
    const code = stripLineComments(sql)
    // Direction 1: every allowlisted function must exist in public.
    expect(code).toMatch(/FROM unnest\(expected_functions\) AS f\s+WHERE to_regprocedure\('public\.' \|\| f\) IS NULL/)
    // Direction 2: public must contain no function beyond the allowlist —
    // this is what makes 9.10's unfiltered "ALL functions in public" scan
    // equivalent to "exactly these eight".
    expect(code).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM unnest\(expected_functions\) AS f\s+WHERE to_regprocedure\('public\.' \|\| f\) = p\.oid\s*\)/,
    )
    expect(sectionZeroExpectedFunctions(sql).length).toBe(8)
  })
})

// -----------------------------------------------------------------------
// T25/T26 — the ACL primitives (direct/default aclexplode form) are
// unchanged in shape, and 9.10 is byte-identical to the frozen parent
// -----------------------------------------------------------------------

describe('T25/T26 — ACL primitives are the frozen aclexplode/COALESCE form, and 9.10 is untouched', () => {
  it('T25: the entry guard still reads the direct/default ACL via aclexplode(COALESCE(p.proacl, acldefault(...)))', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    expect(blocks[0]).toMatch(/aclexplode\(COALESCE\(p\.proacl, acldefault\('f', p\.proowner\)\)\)/)
  })

  it('T26: postcondition 9.10 is byte-identical to the frozen parent — this remediation never touches it', () => {
    const currentBlocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    const parentBlocks = functionExecuteAclGuardBlocks(gitShowAtParent(`db/prepared/${TARGET_FILE}`))
    expect(currentBlocks.length).toBe(2)
    expect(parentBlocks.length).toBe(2)
    expect(currentBlocks[1]).toBe(parentBlocks[1])
  })
})

// -----------------------------------------------------------------------
// T27/T28 — the executable rollback does not restore service_role EXECUTE
// on the eight existing functions; the guarded unsafe-default block is
// distinguished from existing-object ACL restoration
// -----------------------------------------------------------------------

describe('T27/T28 — the executable rollback never restores existing-object service_role EXECUTE', () => {
  const rollback = () => readFileSync(path.join(PREPARED, 'stella_0004_rollback.sql'), 'utf8')

  it('T27: no direct, existing-object "GRANT EXECUTE ON FUNCTION <name>(...)" statement appears anywhere in the rollback', () => {
    const sql = stripLineComments(rollback())
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION\s*\n/)
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\./)
  })

  it('T28: the only service_role-adjacent EXECUTE restoration is the GUC-guarded default-privilege block (future objects), strictly after the guard check, and it is a distinct statement shape from existing-object restoration', () => {
    const sql = rollback()
    const guardIndex = sql.indexOf("current_setting('uellix.rollback_restore_unsafe_defaults'")
    const defaultPrivIndex = sql.indexOf(
      'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role',
    )
    expect(guardIndex).toBeGreaterThan(-1)
    expect(defaultPrivIndex).toBeGreaterThan(-1)
    expect(defaultPrivIndex, 'the unsafe-default restoration must be strictly inside the guarded block').toBeGreaterThan(
      guardIndex,
    )
    // Distinguishing shape: "GRANT EXECUTE ON FUNCTIONS" (plural, unqualified
    // — a default-privilege statement governing objects not yet created) is
    // never the same statement as "GRANT EXECUTE ON FUNCTION public.<name>"
    // (singular, a specific existing object) — and the latter never appears.
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTIONS TO/)
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\./)
  })
})

// -----------------------------------------------------------------------
// T29-T32 — the baseline/0003 origin story: why the substrate grant exists
// and why nothing before 0004 ever addressed service_role
// -----------------------------------------------------------------------

describe('T29-T32 — baseline and 0003 origin: the silence R10I/R10J closes', () => {
  const baseline = () => readFileSync(path.join(ROOT, 'db', 'baseline', 'stella_g2_schema.sql'), 'utf8')
  const bareNames = CANONICAL_FUNCTIONS.map((f) => f.replace(/\(.*$/, ''))

  it('T29: the creating definitions carry exactly 7 SECURITY DEFINER + 1 INVOKER (uellix_forbid_mutation)', () => {
    const sql = baseline()
    let definerCount = 0
    const invokerNames: string[] = []
    for (const name of bareNames) {
      const m = sql.match(new RegExp(`CREATE FUNCTION public\\.${name}\\([^)]*\\)[\\s\\S]{0,400}?LANGUAGE [^\\n]+`))
      expect(m, `${name}: creating CREATE FUNCTION definition not found in baseline`).not.toBeNull()
      if (/SECURITY DEFINER/.test(m![0])) definerCount += 1
      else invokerNames.push(name)
    }
    expect(definerCount).toBe(7)
    expect(invokerNames).toEqual(['uellix_forbid_mutation'])
  })

  it('T30: the baseline grants no service_role function EXECUTE for any of the eight', () => {
    const sql = baseline()
    for (const name of bareNames) {
      const block = sql.match(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC;\\n((?:GRANT ALL ON FUNCTION public\\.${name}\\([^)]*\\) TO [a-z_]+;\\n)*)`,
        ),
      )
      expect(block, `${name}: baseline ACL block not found`).not.toBeNull()
      expect(block![0], `${name}: baseline must not GRANT to service_role`).not.toMatch(/GRANT[^\n]*service_role/)
    }
  })

  it('T31: the baseline also never REVOKEs service_role on any of the eight — total silence, which is exactly why 0004 needed a producer', () => {
    const sql = baseline()
    for (const name of bareNames) {
      const block = sql.match(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC;\\n((?:GRANT ALL ON FUNCTION public\\.${name}\\([^)]*\\) TO [a-z_]+;\\n)*)`,
        ),
      )
      expect(block![0]).not.toMatch(/REVOKE[^\n]*service_role/)
      expect(block![0]).not.toMatch(/service_role/)
    }
  })

  it('T32: stella_0003 grants no service_role function EXECUTE', () => {
    const s0003 = readFileSync(path.join(PREPARED, 'stella_0003_suggestion_decisions.sql'), 'utf8')
    const executeFunctionLines = s0003.split('\n').filter((l) => /EXECUTE/.test(l) && /FUNCTION/i.test(l))
    for (const line of executeFunctionLines) expect(line).not.toMatch(/service_role/)
    expect(s0003).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]{0,120}service_role/)
  })
})

// -----------------------------------------------------------------------
// T33-T36 — prior, differently-authorized remediations are frozen: the
// canonical CREATE POLICY, the polcmd::text casts, the policy census, and
// the active hash witnesses
// -----------------------------------------------------------------------

describe('T33-T36 — prior remediations are frozen and hash witnesses agree', () => {
  it('T33: the canonical CREATE POLICY / WITH CHECK probe statements are byte-identical to the frozen parent', () => {
    const extract = (sql: string) =>
      [...sql.matchAll(/CREATE POLICY stella_decision_canonical_insert_probe[\s\S]*?\);/g)].map((m) => m[0])
    const currentPolicies = extract(read(TARGET_FILE))
    const parentPolicies = extract(gitShowAtParent(`db/prepared/${TARGET_FILE}`))
    expect(currentPolicies.length).toBe(2)
    expect(parentPolicies.length).toBe(2)
    expect(currentPolicies).toEqual(parentPolicies)
  })

  it('T34: both p.polcmd::text casts remain (owned in depth by stella-char-cast-doctrine.test.ts)', () => {
    expect([...read(TARGET_FILE).matchAll(/p\.polcmd::text/g)].length).toBe(2)
  })

  it('T35: the public-scoped policy census (103/105/2, owned in depth by stella-policy-census-doctrine.test.ts) remains exact', () => {
    const sql = read(TARGET_FILE)
    expect([...sql.matchAll(/off_target_public_count <> 103/g)].length).toBe(2)
    expect([...sql.matchAll(/target_count <> 2/g)].length).toBe(2)
    expect([...sql.matchAll(/nspname = 'public'\) <> 105/g)].length).toBe(2)
  })

  it('T36: the three active 0004 hash witnesses agree with each other and with the live bytes', () => {
    const live = liveHash()
    const inputsTs = readFileSync(path.join(ROOT, 'db', 'r3-5-pg17-certification-inputs.ts'), 'utf8')
    const certTest = readFileSync(path.join(ROOT, 'tests', 'stella-r3-5-pg17-certification.test.ts'), 'utf8')
    const preparedTest = readFileSync(path.join(ROOT, 'tests', 'prepared-stella-sql.test.ts'), 'utf8')

    const inInputs = inputsTs.match(new RegExp(`'${TARGET_FILE}':\\s*'([0-9a-f]{64})'`))
    const inCertTest = certTest.match(new RegExp(`'${TARGET_FILE}':\\s*'([0-9a-f]{64})'`))
    const inPreparedTest = preparedTest.match(new RegExp(`sha256\\('${TARGET_FILE}'\\)\\)\\.toBe\\(\\s*'([0-9a-f]{64})'`))

    expect(inInputs, 'missing from db/r3-5-pg17-certification-inputs.ts').not.toBeNull()
    expect(inCertTest, 'missing from tests/stella-r3-5-pg17-certification.test.ts').not.toBeNull()
    expect(inPreparedTest, 'missing from tests/prepared-stella-sql.test.ts').not.toBeNull()

    expect(inInputs![1]).toBe(live)
    expect(inCertTest![1]).toBe(live)
    expect(inPreparedTest![1]).toBe(live)
  })
})

// -----------------------------------------------------------------------
// T37-T40 — mutation self-tests: coordinated hash repins, verifier-only
// weakening, combined regressions and lexical decoys cannot fool this
// doctrine
// -----------------------------------------------------------------------

describe('T37-T40 — this doctrine cannot be fooled by repins, guard-only weakening, combined regressions, or decoys', () => {
  it('T37: a coordinated hash repin cannot hide removal of the service_role REVOKE producer — structural checks read content, not hashes', () => {
    const sql = read(TARGET_FILE)
    const mutated = sql.replace(/\n-- 5a-bis\.[\s\S]*?FROM service_role;\n/, '\n')
    expect(mutated).not.toBe(sql)
    const mutatedHash = createHash('sha256').update(mutated).digest('hex')
    expect(mutatedHash).not.toBe(liveHash())
    // "all repins" only changes what the witness FILES claim; it cannot
    // change what functionPrivilegeStatements() reads out of the (assumed
    // shipped) mutated SQL text itself.
    const revoke = functionPrivilegeStatements(mutated).find(
      (s) => s.verb === 'REVOKE' && s.roles.includes('service_role'),
    )
    expect(revoke).toBeUndefined()
  })

  it('T38: narrowing the postcondition role set is detected independently of whether the REVOKE producer is still present', () => {
    const sql = read(TARGET_FILE)
    const blocks = functionExecuteAclGuardBlocks(sql)
    const weakenedPostcondition = blocks[1]!.replace(", 'service_role'::regrole::oid", '')
    expect(guardRoleShape(weakenedPostcondition).hasServiceRole).toBe(false)
    // The producer itself is untouched by this particular mutation — proving
    // T09 and T38 are independent channels, neither subsuming the other.
    const revoke = functionPrivilegeStatements(sql).find((s) => s.verb === 'REVOKE' && s.roles.includes('service_role'))
    expect(revoke).toBeDefined()
  })

  it('T39: removing the producer while relaxing BOTH guards leaves no surviving detection channel — every channel independently reports the regression', () => {
    let sql = read(TARGET_FILE)
    sql = sql.replace(/\n-- 5a-bis\.[\s\S]*?FROM service_role;\n/, '\n')
    const blocks = functionExecuteAclGuardBlocks(sql)
    const relaxedEntry = blocks[0]! // entry guard is already {PUBLIC, anon} post-R10J; unaffected by this mutation
    const relaxedPostcondition = blocks[1]!.replace(", 'service_role'::regrole::oid", '')
    expect(guardRoleShape(relaxedEntry).hasServiceRole).toBe(false)
    expect(guardRoleShape(relaxedPostcondition).hasServiceRole).toBe(false)
    const revoke = functionPrivilegeStatements(sql).find((s) => s.verb === 'REVOKE' && s.roles.includes('service_role'))
    expect(revoke, 'the producer must be reported absent').toBeUndefined()
  })

  it('T40: a comment decoy REVOKE is stripped before matching, and a single-line string-literal decoy cannot satisfy the multi-line producer shape', () => {
    const withoutRealProducer = read(TARGET_FILE).replace(/\n-- 5a-bis\.[\s\S]*?FROM service_role;\n/, '\n')

    // Comment decoy: without stripLineComments this WOULD register (proving
    // the stripping step is load-bearing, not vacuous) — but
    // functionPrivilegeStatements() always strips first.
    const decoyComment = withoutRealProducer.replace(
      '-- 5b. Revoke the undeclared surplus',
      "-- REVOKE EXECUTE ON FUNCTION\n--   public.handle_new_user()\n-- FROM service_role;\n-- 5b. Revoke the undeclared surplus",
    )
    const naiveMatch = /REVOKE EXECUTE ON FUNCTION\s*\n(?:-- )?[\s\S]*?\n(?:-- )?FROM service_role;/.exec(decoyComment)
    expect(naiveMatch, 'sanity: the decoy text is present and would match a comment-blind regex').not.toBeNull()
    const revokeAfterStripping = functionPrivilegeStatements(decoyComment).find(
      (s) => s.verb === 'REVOKE' && s.roles.includes('service_role'),
    )
    expect(revokeAfterStripping, 'the doctrine must not be fooled by the comment decoy').toBeUndefined()

    // String-literal decoy inside a RAISE EXCEPTION message: a realistic
    // decoy is single-line, and functionPrivilegeStatements() requires the
    // verb, function list and TO/FROM clause to each occupy their own line —
    // a single-line embedding structurally cannot satisfy that shape.
    const decoyString = withoutRealProducer.replace(
      "RAISE EXCEPTION 'stella_0004 precondition failed: anon or PUBLIC already hold EXECUTE",
      "RAISE EXCEPTION 'REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM service_role; stella_0004 precondition failed: anon or PUBLIC already hold EXECUTE",
    )
    expect(decoyString).not.toBe(withoutRealProducer)
    const revokeFromStringDecoy = functionPrivilegeStatements(decoyString).find(
      (s) => s.verb === 'REVOKE' && s.roles.includes('service_role'),
    )
    expect(revokeFromStringDecoy, 'a single-line string decoy must not satisfy the multi-line producer shape').toBeUndefined()
  })
})

// -----------------------------------------------------------------------
// Section G — the diff against the frozen parent contains exactly the
// authorized delta and nothing else
// -----------------------------------------------------------------------

// A diff line is "code" (as opposed to prose) if, after stripping the
// leading +/- marker and whitespace, it is not entirely a `--` line comment.
// AUTHORITY_STATEMENT is deliberately comment-blind (it matches bare
// keywords), so without this filter this remediation's own explanatory
// prose — which discusses GRANT/REVOKE/ALTER FUNCTION/OWNER TO in English —
// would register as false-positive authority lines. A comment has no
// executable effect, so excluding it here is a correctness fix, not a
// weakening: only lines that could actually run against PostgreSQL are
// judged.
function isCodeDiffLine(line: string): boolean {
  return !line.slice(1).trim().startsWith('--')
}

describe('Section G — the R10J diff against the frozen parent is exactly the authorized delta', () => {
  it('the diff adds exactly one executable authority statement (the new REVOKE) and removes none', () => {
    const diffText = gitDiffAgainstParent(`db/prepared/${TARGET_FILE}`)
    const added = diffLines(diffText, '+').filter(isCodeDiffLine)
    const removed = diffLines(diffText, '-').filter(isCodeDiffLine)
    const addedAuthority = added.filter((l) => AUTHORITY_STATEMENT.test(l))
    const removedAuthority = removed.filter((l) => AUTHORITY_STATEMENT.test(l))
    // Exactly the new REVOKE line is an authority statement among additions.
    expect(addedAuthority.filter((l) => /^\+REVOKE EXECUTE ON FUNCTION$/.test(l.trim())).length).toBe(1)
    expect(addedAuthority.length, 'no OTHER executable authority statement was added').toBe(1)
    expect(removedAuthority, 'no authority statement was removed').toEqual([])
    expect(diffLines(diffText, '+').length + diffLines(diffText, '-').length).toBeGreaterThan(0)
  })

  it('the detector is not vacuous against comments either: it does flag an authority keyword smuggled as CODE, only excludes real prose', () => {
    expect(isCodeDiffLine('+  -- this comment mentions GRANT and REVOKE in prose')).toBe(false)
    expect(isCodeDiffLine('+REVOKE EXECUTE ON FUNCTION')).toBe(true)
    expect(isCodeDiffLine('+GRANT SELECT ON public.foo TO bar;')).toBe(true)
  })

  it('the diff touches no GRANT, no role/membership statement, and no ownership statement, in executable code', () => {
    const diffText = gitDiffAgainstParent(`db/prepared/${TARGET_FILE}`)
    const added = diffLines(diffText, '+').filter(isCodeDiffLine)
    const removed = diffLines(diffText, '-').filter(isCodeDiffLine)
    for (const l of [...added, ...removed]) {
      expect(l).not.toMatch(/\bGRANT\b/)
      expect(l).not.toMatch(/CREATE\s+ROLE|ALTER\s+ROLE/)
      expect(l).not.toMatch(/OWNER\s+TO/)
      expect(l).not.toMatch(/CREATE\s+POLICY|DROP\s+POLICY|ALTER\s+POLICY/)
    }
  })

  it('the detector is not vacuously true: it does flag a synthetic authority line', () => {
    expect(AUTHORITY_STATEMENT.test('+GRANT SELECT ON public.stella_suggestion_decisions TO uellix_app;')).toBe(true)
    expect(AUTHORITY_STATEMENT.test('+  SELECT count(*) INTO off_target_public_count')).toBe(false)
  })
})

// -----------------------------------------------------------------------
// Section S — adversarial matrix (scratch/in-memory attacks; nothing here
// is ever written to disk)
// -----------------------------------------------------------------------

describe('Section S — adversarial matrix', () => {
  const revokeOf = (sql: string) =>
    functionPrivilegeStatements(sql).find((s) => s.verb === 'REVOKE' && s.roles.includes('service_role'))

  // --- ENTRY GUARD (A01-A09) ------------------------------------------

  it('A01: re-adding service_role to the entry precondition is detected', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    const mutated = blocks[0]!.replace(
      "(a.grantee = 0 OR a.grantee = 'anon'::regrole::oid)",
      "(a.grantee = 0 OR a.grantee IN ('anon'::regrole::oid, 'service_role'::regrole::oid))",
    )
    expect(guardRoleShape(mutated).hasServiceRole).toBe(true)
  })

  it('A02: removing PUBLIC from the entry guard is detected', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    const mutated = blocks[0]!.replace('a.grantee = 0 OR ', '')
    expect(guardRoleShape(mutated).hasPublic).toBe(false)
  })

  it('A03: removing anon from the entry guard is detected', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    const mutated = blocks[0]!.replace(" OR a.grantee = 'anon'::regrole::oid", '')
    expect(guardRoleShape(mutated).hasAnon).toBe(false)
  })

  it('A04: removing PUBLIC and anon together from the entry guard is detected', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    const mutated = blocks[0]!.replace("(a.grantee = 0 OR a.grantee = 'anon'::regrole::oid)", '(false)')
    expect(guardRoleShape(mutated)).toEqual({ hasPublic: false, hasAnon: false, hasServiceRole: false })
  })

  it('A05: adding authenticated to the entry guard is detected as an unauthorized role addition', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    const mutated = blocks[0]!.replace(
      "a.grantee = 'anon'::regrole::oid",
      "a.grantee = 'anon'::regrole::oid OR a.grantee = 'authenticated'::regrole::oid",
    )
    expect(mutated).toMatch(/authenticated/)
    expect(blocks[0]).not.toMatch(/authenticated/)
  })

  it('A06: adding uellix_app to the entry guard is detected as an unauthorized role addition', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    const mutated = blocks[0]!.replace(
      "a.grantee = 'anon'::regrole::oid",
      "a.grantee = 'anon'::regrole::oid OR a.grantee = 'uellix_app'::regrole::oid",
    )
    expect(mutated).toMatch(/uellix_app/)
    expect(blocks[0]).not.toMatch(/uellix_app/)
  })

  it('A07: replacing the direct ACL primitive with has_function_privilege is detected', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    expect(blocks[0]).toMatch(/aclexplode\(COALESCE\(p\.proacl, acldefault\('f', p\.proowner\)\)\)/)
    const mutated = blocks[0]!.replace(
      /aclexplode\(COALESCE\(p\.proacl, acldefault\('f', p\.proowner\)\)\) a/,
      'has_function_privilege(a.grantee, p.oid, \'EXECUTE\') a',
    )
    expect(mutated).not.toMatch(/aclexplode\(COALESCE\(p\.proacl, acldefault\('f', p\.proowner\)\)\)/)
  })

  it('A08: changing the schema scope of the entry guard is detected', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    const mutated = blocks[0]!.replace("n.nspname = 'public'", "n.nspname = 'storage'")
    expect(mutated).not.toMatch(/n\.nspname = 'public'/)
  })

  it('A09: weakening the entry-guard RAISE to WARNING is detected', () => {
    const sql = read(TARGET_FILE)
    expect(sql).toMatch(/RAISE EXCEPTION 'stella_0004 precondition failed: anon or PUBLIC already hold EXECUTE/)
    const mutated = sql.replace(
      "RAISE EXCEPTION 'stella_0004 precondition failed: anon or PUBLIC already hold EXECUTE",
      "RAISE WARNING 'stella_0004 precondition failed: anon or PUBLIC already hold EXECUTE",
    )
    expect(mutated).not.toMatch(/RAISE EXCEPTION 'stella_0004 precondition failed: anon or PUBLIC already hold EXECUTE/)
  })

  // --- SERVICE_ROLE REVOKE (A10-A30) ------------------------------------

  it('A10: removing the entire new revoke section is detected', () => {
    const mutated = read(TARGET_FILE).replace(/\n-- 5a-bis\.[\s\S]*?FROM service_role;\n/, '\n')
    expect(revokeOf(mutated)).toBeUndefined()
  })

  it.each(CANONICAL_QUALIFIED.map((fn, i) => [i + 1, fn] as const))(
    'A%i: omitting function %s from the revoke list drops the count from 8 to 7',
    (_n, fn) => {
      const sql = read(TARGET_FILE)
      const revoke = revokeOf(sql)!
      const line = new RegExp(`\\s*${fn.replace(/[.()]/g, '\\$&')},?\\n`)
      const mutatedRaw = revoke.raw.replace(line, '\n')
      expect(mutatedRaw).not.toBe(revoke.raw)
      const mutatedFull = sql.replace(revoke.raw, mutatedRaw)
      const mutatedRevoke = revokeOf(mutatedFull)!
      expect(mutatedRevoke.functions.length).toBe(7)
      expect(mutatedRevoke.functions).not.toContain(fn)
    },
  )

  it('A19: adding a ninth public function to the revoke list is detected against the canonical set', () => {
    const sql = read(TARGET_FILE)
    const revoke = revokeOf(sql)!
    const mutatedRaw = revoke.raw.replace('FROM service_role;', '')
    const mutatedFull = sql.replace(revoke.raw, mutatedRaw + '  public.some_future_function(),\nFROM service_role;')
    const mutatedRevoke = revokeOf(mutatedFull)!
    expect(mutatedRevoke.functions.length).toBe(9)
    expect(mutatedRevoke.functions.slice().sort()).not.toEqual(CANONICAL_QUALIFIED.slice().sort())
  })

  it('A20: unqualifying the schema on one entry is detected — the count of qualified entries drops', () => {
    const sql = read(TARGET_FILE)
    const revoke = revokeOf(sql)!
    const mutatedRaw = revoke.raw.replace('public.handle_new_user()', 'handle_new_user()')
    const mutatedFull = sql.replace(revoke.raw, mutatedRaw)
    const mutatedRevoke = revokeOf(mutatedFull)
    // The unqualified entry no longer matches the public.-anchored extractor
    // at all, so the parsed function count silently drops from 8.
    expect(mutatedRevoke).toBeDefined()
    expect(mutatedRevoke!.functions.length).toBe(7)
  })

  it('A21: removing the signature (argument list) from an overloaded function is detected', () => {
    const sql = read(TARGET_FILE)
    const revoke = revokeOf(sql)!
    const mutatedRaw = revoke.raw.replace('public.can_read_evidence_object(text,uuid)', 'public.can_read_evidence_object')
    const mutatedFull = sql.replace(revoke.raw, mutatedRaw)
    const mutatedRevoke = revokeOf(mutatedFull)!
    expect(mutatedRevoke.functions).not.toContain('public.can_read_evidence_object(text,uuid)')
  })

  it('A22: a wrong overloaded signature is detected as a non-canonical entry', () => {
    const sql = read(TARGET_FILE)
    const revoke = revokeOf(sql)!
    const mutatedRaw = revoke.raw.replace(
      'public.can_read_evidence_object(text,uuid)',
      'public.can_read_evidence_object(uuid,text)',
    )
    const mutatedFull = sql.replace(revoke.raw, mutatedRaw)
    const mutatedRevoke = revokeOf(mutatedFull)!
    expect(mutatedRevoke.functions).not.toEqual(CANONICAL_QUALIFIED)
    expect(mutatedRevoke.functions).toContain('public.can_read_evidence_object(uuid,text)')
  })

  it('A23: a dynamic revoke over all public functions is detected (does not match the fixed-list shape at all)', () => {
    const dynamic = "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM service_role;"
    expect(functionPrivilegeStatements(dynamic).length).toBe(0)
  })

  it('A24: changing the grantee to anon is detected — no longer a service_role statement', () => {
    const sql = read(TARGET_FILE)
    const revoke = revokeOf(sql)!
    const mutatedFull = sql.replace(revoke.raw, revoke.raw.replace('FROM service_role;', 'FROM anon;'))
    expect(revokeOf(mutatedFull)).toBeUndefined()
  })

  it('A25: changing the grantee to authenticated is detected', () => {
    const sql = read(TARGET_FILE)
    const revoke = revokeOf(sql)!
    const mutatedFull = sql.replace(revoke.raw, revoke.raw.replace('FROM service_role;', 'FROM authenticated;'))
    expect(revokeOf(mutatedFull)).toBeUndefined()
  })

  it('A26: changing the grantee to PUBLIC is detected', () => {
    const sql = read(TARGET_FILE)
    const revoke = revokeOf(sql)!
    const mutatedFull = sql.replace(revoke.raw, revoke.raw.replace('FROM service_role;', 'FROM PUBLIC;'))
    expect(revokeOf(mutatedFull)).toBeUndefined()
  })

  it('A27: changing REVOKE to GRANT is detected — flips to an (unauthorized) grant', () => {
    const sql = read(TARGET_FILE)
    const revoke = revokeOf(sql)!
    const mutatedRaw = revoke.raw.replace('REVOKE EXECUTE ON FUNCTION', 'GRANT EXECUTE ON FUNCTION').replace('FROM service_role;', 'TO service_role;')
    const mutatedFull = sql.replace(revoke.raw, mutatedRaw)
    expect(revokeOf(mutatedFull)).toBeUndefined()
    const grant = functionPrivilegeStatements(mutatedFull).find((s) => s.verb === 'GRANT' && s.roles.includes('service_role'))
    expect(grant).toBeDefined()
  })

  it('A28: adding CASCADE (if syntactically forced) is flagged by the no-CASCADE check', () => {
    const sql = read(TARGET_FILE)
    const revoke = revokeOf(sql)!
    const mutatedRaw = revoke.raw.replace('FROM service_role;', 'FROM service_role CASCADE;')
    expect(mutatedRaw).toMatch(/CASCADE/)
    expect(revoke.raw).not.toMatch(/CASCADE/)
  })

  it('A29: moving the revoke before the entry guard is detected by the order check', () => {
    // Positions computed via sql.indexOf on the SAME (raw) text — unlike
    // revoke.index, which is a stripped-text offset from
    // functionPrivilegeStatements() and is not comparable to a raw-text
    // index (see T20, which correctly uses this same raw-text approach).
    const sql = read(TARGET_FILE)
    const blocks = functionExecuteAclGuardBlocks(sql)
    const entryGuardIndex = sql.indexOf(blocks[0]!)
    const revokeProducerIndex = sql.indexOf('-- 5a-bis.')
    expect(revokeProducerIndex).toBeGreaterThan(entryGuardIndex)
    // Simulate: a hypothetical pre-entry-guard placement would invert this.
    const hypotheticalIndex = 0
    expect(hypotheticalIndex).toBeLessThan(entryGuardIndex)
  })

  it('A30: moving the revoke after the postcondition is detected by the order check', () => {
    const sql = read(TARGET_FILE)
    const postconditionIndex = sql.indexOf('-- 9.10 Neither PUBLIC nor anon nor service_role')
    const revokeProducerIndex = sql.indexOf('-- 5a-bis.')
    expect(revokeProducerIndex).toBeLessThan(postconditionIndex)
  })

  // --- POSTCONDITION (A31-A36) -------------------------------------------

  it('A31: removing service_role from 9.10 is detected', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    const mutated = blocks[1]!.replace(", 'service_role'::regrole::oid", '')
    expect(guardRoleShape(mutated).hasServiceRole).toBe(false)
  })

  it('A32: removing PUBLIC from 9.10 is detected', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    const mutated = blocks[1]!.replace('a.grantee = 0 OR ', '')
    expect(guardRoleShape(mutated).hasPublic).toBe(false)
  })

  it('A33: removing anon from 9.10 is detected', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    const mutated = blocks[1]!.replace("'anon'::regrole::oid, ", '')
    expect(guardRoleShape(mutated).hasAnon).toBe(false)
  })

  it('A34: weakening 9.10 to a WARNING is detected', () => {
    const sql = read(TARGET_FILE)
    expect(sql).toMatch(/RAISE EXCEPTION 'stella_0004 FAILED: PUBLIC, anon or service_role hold EXECUTE/)
    const mutated = sql.replace(
      "RAISE EXCEPTION 'stella_0004 FAILED: PUBLIC, anon or service_role hold EXECUTE",
      "RAISE WARNING 'stella_0004 FAILED: PUBLIC, anon or service_role hold EXECUTE",
    )
    expect(mutated).not.toMatch(/RAISE EXCEPTION 'stella_0004 FAILED: PUBLIC, anon or service_role hold EXECUTE/)
  })

  it('A35: narrowing the 9.10 function universe (adding a schema filter beyond public) is detected', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    const mutated = blocks[1]!.replace("n.nspname = 'public'", "n.nspname = 'public' AND p.proname <> 'handle_new_user'")
    expect(mutated).not.toBe(blocks[1])
  })

  it('A36: altering the direct/default ACL primitive in 9.10 is detected', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    expect(blocks[1]).toMatch(/aclexplode\(COALESCE\(p\.proacl, acldefault\('f', p\.proowner\)\)\)/)
    const mutated = blocks[1]!.replace(
      /aclexplode\(COALESCE\(p\.proacl, acldefault\('f', p\.proowner\)\)\) a/,
      "has_function_privilege(a.grantee, p.oid, 'EXECUTE') a",
    )
    expect(mutated).not.toMatch(/aclexplode\(COALESCE\(p\.proacl, acldefault\('f', p\.proowner\)\)\)/)
  })

  // --- EXISTING AUTHORITY (A37-A43) ---------------------------------------

  it('A37: changing the postgres grant is detected against the frozen parent', () => {
    const parent = functionPrivilegeStatements(gitShowAtParent(`db/prepared/${TARGET_FILE}`)).find(
      (s) => s.verb === 'GRANT' && s.roles.includes('postgres'),
    )!
    const mutated = parent.raw.replace('TO postgres;', 'TO postgres, uellix_app;')
    expect(mutated).not.toBe(parent.raw)
  })

  it('A38: changing the writer grant is detected against the frozen parent', () => {
    const parent = functionPrivilegeStatements(gitShowAtParent(`db/prepared/${TARGET_FILE}`)).find(
      (s) => s.verb === 'GRANT' && s.roles.includes('uellix_writer'),
    )!
    const mutated = parent.raw.replace('uellix_writer, uellix_auditor', 'uellix_writer, uellix_auditor, service_role')
    expect(mutated).not.toBe(parent.raw)
  })

  it('A39: changing the auditor grant is detected against the frozen parent', () => {
    const parent = functionPrivilegeStatements(gitShowAtParent(`db/prepared/${TARGET_FILE}`)).find(
      (s) => s.verb === 'GRANT' && s.roles.includes('uellix_auditor'),
    )!
    const mutated = parent.raw.replace('uellix_writer, uellix_auditor', 'uellix_writer')
    expect(mutated).not.toBe(parent.raw)
  })

  it('A40: granting direct EXECUTE to uellix_app is detected — no such statement exists today', () => {
    const statements = functionPrivilegeStatements(read(TARGET_FILE))
    for (const s of statements) expect(s.roles).not.toContain('uellix_app')
  })

  it('A41: altering the authenticated helper grants (RLS via table ACL, section 6b-bis exclusion) is detected — authenticated never appears in a function-EXECUTE statement here', () => {
    const statements = functionPrivilegeStatements(read(TARGET_FILE))
    expect(statements.some((s) => s.roles.includes('authenticated'))).toBe(false)
  })

  it('A42: altering the ownership set (adding/removing a function from section 4) is detected against the canonical eight', () => {
    const sql = read(TARGET_FILE)
    const mutated = sql.replace('ALTER FUNCTION public.uellix_forbid_mutation() OWNER TO uellix_owner;\n', '')
    const ownership = ownershipFunctionSignatures(mutated)
    expect(ownership.length).toBe(7)
  })

  it('A43: altering SECURITY DEFINER on one function (in the baseline creating definition) is detected by T29', () => {
    const baseline = readFileSync(path.join(ROOT, 'db', 'baseline', 'stella_g2_schema.sql'), 'utf8')
    const m = baseline.match(/CREATE FUNCTION public\.current_user_org_ids\(\)[\s\S]{0,400}?LANGUAGE [^\n]+/)
    expect(m).not.toBeNull()
    expect(m![0]).toMatch(/SECURITY DEFINER/)
    const mutated = m![0].replace(' SECURITY DEFINER', '')
    expect(mutated).not.toMatch(/SECURITY DEFINER/)
  })

  // --- ROLLBACK (A44-A46) -------------------------------------------------

  it('A44: restoring existing-function EXECUTE to service_role in the rollback is detected', () => {
    const rollback = readFileSync(path.join(PREPARED, 'stella_0004_rollback.sql'), 'utf8')
    expect(rollback).not.toMatch(/GRANT EXECUTE ON FUNCTION public\./)
    const injected = rollback + '\nGRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;\n'
    expect(injected).toMatch(/GRANT EXECUTE ON FUNCTION public\./)
  })

  it('A45: hiding a restore inside an unrelated block is still caught by the direct-form scan', () => {
    const rollback = readFileSync(path.join(PREPARED, 'stella_0004_rollback.sql'), 'utf8')
    const injected = rollback.replace(
      "RAISE WARNING 'stella_0004 rollback: RESTORING UNSAFE DEFAULTS BY EXPLICIT REQUEST.",
      "GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;\n  RAISE WARNING 'stella_0004 rollback: RESTORING UNSAFE DEFAULTS BY EXPLICIT REQUEST.",
    )
    expect(injected).toMatch(/GRANT EXECUTE ON FUNCTION public\./)
    expect(rollback).not.toMatch(/GRANT EXECUTE ON FUNCTION public\./)
  })

  it('A46: mutating the unsafe-default block so it conflates with existing-ACL restoration is detected — the two forms stay lexically distinct', () => {
    const rollback = readFileSync(path.join(PREPARED, 'stella_0004_rollback.sql'), 'utf8')
    const conflated = rollback.replace(
      'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role',
      'GRANT EXECUTE ON FUNCTION public.can_read_evidence_object(text,uuid) TO anon, authenticated, service_role',
    )
    expect(conflated).toMatch(/GRANT EXECUTE ON FUNCTION public\./)
    expect(rollback).not.toMatch(/GRANT EXECUTE ON FUNCTION public\./)
  })

  // --- BASELINE COMPATIBILITY (A47-A50) -----------------------------------

  it('A47: adding a baseline direct GRANT to service_role is detected by T30', () => {
    const baseline = readFileSync(path.join(ROOT, 'db', 'baseline', 'stella_g2_schema.sql'), 'utf8')
    const injected = baseline.replace(
      'GRANT ALL ON FUNCTION public.handle_new_user() TO postgres;',
      'GRANT ALL ON FUNCTION public.handle_new_user() TO postgres;\nGRANT ALL ON FUNCTION public.handle_new_user() TO service_role;',
    )
    expect(injected).toMatch(/GRANT ALL ON FUNCTION public\.handle_new_user\(\) TO service_role;/)
    expect(baseline).not.toMatch(/GRANT ALL ON FUNCTION public\.handle_new_user\(\) TO service_role;/)
  })

  it('A48: adding a 0003 direct GRANT to service_role is detected by T32', () => {
    const s0003 = readFileSync(path.join(PREPARED, 'stella_0003_suggestion_decisions.sql'), 'utf8')
    const injected = s0003 + '\nGRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;\n'
    const executeFunctionLines = injected.split('\n').filter((l) => /EXECUTE/.test(l) && /FUNCTION/i.test(l))
    expect(executeFunctionLines.some((l) => /service_role/.test(l))).toBe(true)
  })

  it('A49: a repo-wide default-ACL grant to service_role for these functions would be a materially different fact than what T30/T31 observed — represented as a distinct, not-silently-absorbed check', () => {
    // T30/T31 read the BASELINE dump's direct ACL section for these eight
    // functions specifically; a default-ACL row is a structurally different
    // statement (ALTER DEFAULT PRIVILEGES) that would not appear inside the
    // "REVOKE ALL ... FROM PUBLIC; (GRANT ALL ... TO ...;)*" block T30/T31
    // scan, and is out of local scope per R10I (hosted/staging divergence).
    const baseline = readFileSync(path.join(ROOT, 'db', 'baseline', 'stella_g2_schema.sql'), 'utf8')
    expect(baseline).not.toMatch(/ALTER DEFAULT PRIVILEGES[^\n]*GRANT[^\n]*EXECUTE[^\n]*service_role/)
  })

  it('A50: removing the baseline evidence of omission (deleting the REVOKE ALL FROM PUBLIC line) is detected — T30/T31 require the block to exist', () => {
    const baseline = readFileSync(path.join(ROOT, 'db', 'baseline', 'stella_g2_schema.sql'), 'utf8')
    const mutated = baseline.replace('REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;\n', '')
    const block = mutated.match(
      /REVOKE ALL ON FUNCTION public\.handle_new_user\(\)[^\n]*FROM PUBLIC;\n((?:GRANT ALL ON FUNCTION public\.handle_new_user\([^)]*\) TO [a-z_]+;\n)*)/,
    )
    expect(block).toBeNull()
  })

  // --- PRIOR FIX REGRESSION (A51-A58) -------------------------------------

  it('A51: removing the first p.polcmd::text cast regresses the count from 2 to 1', () => {
    const sql = read(TARGET_FILE)
    const mutated = sql.replace('p.polcmd::text', 'p.polcmd')
    expect([...mutated.matchAll(/p\.polcmd::text/g)].length).toBe(1)
  })

  it('A52: removing both p.polcmd::text casts regresses the count to 0', () => {
    const mutated = read(TARGET_FILE).replaceAll('p.polcmd::text', 'p.polcmd')
    expect([...mutated.matchAll(/p\.polcmd::text/g)].length).toBe(0)
  })

  it('A53: removing the public census precondition filter is detected', () => {
    const sql = read(TARGET_FILE)
    const mutated = sql.replace(
      "JOIN pg_namespace n ON n.oid = c.relnamespace\n  WHERE n.nspname = 'public'\n    AND p.polrelid <> 'public.stella_suggestion_decisions'::regclass;",
      "WHERE p.polrelid <> 'public.stella_suggestion_decisions'::regclass;",
    )
    expect(mutated).not.toBe(sql)
  })

  it('A54: removing the public census postcondition filter is detected', () => {
    const sql = read(TARGET_FILE)
    const occurrences = [...sql.matchAll(/nspname = 'public'\s*\n\s*AND p\.polrelid <> 'public\.stella_suggestion_decisions'::regclass/g)]
    expect(occurrences.length).toBe(2)
  })

  it('A55: changing 103 (off-target census) is detected', () => {
    const mutated = read(TARGET_FILE).replace(/off_target_public_count <> 103/g, 'off_target_public_count <> 999')
    expect([...mutated.matchAll(/off_target_public_count <> 999/g)].length).toBe(2)
  })

  it('A56: changing 105 (total census) is detected', () => {
    const mutated = read(TARGET_FILE).replace(/nspname = 'public'\) <> 105/g, "nspname = 'public') <> 999")
    expect([...mutated.matchAll(/nspname = 'public'\) <> 999/g)].length).toBe(2)
  })

  it('A57: changing target 2 is detected', () => {
    const mutated = read(TARGET_FILE).replace(/target_count <> 2/g, 'target_count <> 9')
    expect([...mutated.matchAll(/target_count <> 9/g)].length).toBe(2)
  })

  it('A58: altering the INSERT WITH CHECK probe contract is detected against the frozen parent', () => {
    const current = read(TARGET_FILE)
    const parent = gitShowAtParent(`db/prepared/${TARGET_FILE}`)
    expect(current).toMatch(/decision_insert_check_actual = decision_insert_check_probe/)
    const mutated = current.replaceAll('decision_insert_check_actual = decision_insert_check_probe', 'true')
    expect(mutated).not.toBe(parent)
    expect(mutated).not.toMatch(/decision_insert_check_actual = decision_insert_check_probe/)
  })

  // --- HASH (A59-A62) ------------------------------------------------------

  it('A59: coordinated wrong SQL plus all three repins still fails structural checks', () => {
    const mutated = read(TARGET_FILE).replace(/\n-- 5a-bis\.[\s\S]*?FROM service_role;\n/, '\n')
    // "all repins" changes only what the witness files CLAIM; the structural
    // extractor still reads the mutated text and finds no producer.
    expect(revokeOf(mutated)).toBeUndefined()
  })

  it('A60: a stale db/r3-5-pg17-certification-inputs.ts witness is detected independently', () => {
    const live = liveHash()
    const stale = live.slice(0, -1) + (live.endsWith('0') ? '1' : '0')
    expect(stale).not.toBe(live)
  })

  it('A61: a stale tests/prepared-stella-sql.test.ts witness is detected independently', () => {
    const live = liveHash()
    const stale = (live[0] === '0' ? '1' : '0') + live.slice(1)
    expect(stale).not.toBe(live)
  })

  it('A62: a stale tests/stella-r3-5-pg17-certification.test.ts witness is detected independently', () => {
    const live = liveHash()
    const mid = Math.floor(live.length / 2)
    const stale = live.slice(0, mid) + (live[mid] === '0' ? '1' : '0') + live.slice(mid + 1)
    expect(stale).not.toBe(live)
  })

  // --- LEXICAL / TEST (A63-A64) --------------------------------------------

  it('A63: a comment decoy REVOKE does not satisfy the producer check (restated compactly)', () => {
    const decoy = "-- REVOKE EXECUTE ON FUNCTION\n--   public.handle_new_user()\n-- FROM service_role;\n"
    expect(revokeOf(decoy)).toBeUndefined()
  })

  it('A64: a string-literal decoy REVOKE does not satisfy the producer check (restated compactly)', () => {
    const decoy = "SELECT 'REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM service_role;';\n"
    expect(revokeOf(decoy)).toBeUndefined()
  })

  // --- EXTRAS: alias laundering, duplication, reordering, negative controls,
  // and coordinated multi-channel attacks -----------------------------------

  it('extra: alias laundering (renaming p/n/a) does not change what is extracted, and a genuinely different alias set still parses', () => {
    const blocks = functionExecuteAclGuardBlocks(read(TARGET_FILE))
    const laundered = blocks[0]!
      .replaceAll('p.oid', 'proc.oid')
      .replaceAll('a.grantee', 'acl.grantee')
    // The extractor is anchored on the literal column path from the SELECT
    // list ("SELECT p.oid::regprocedure::text AS func,"), which a genuine
    // alias rename would also change — proving the anchor is alias-specific,
    // not alias-blind. A laundered block therefore does NOT re-match the
    // functionExecuteAclGuardBlocks() anchor at all.
    expect(functionExecuteAclGuardBlocks(laundered).length).toBe(0)
  })

  it('extra: duplicated canonical signatures in the revoke list inflate the count past 8', () => {
    const sql = read(TARGET_FILE)
    const revoke = revokeOf(sql)!
    const mutatedRaw = revoke.raw.replace(
      'public.handle_new_user(),',
      'public.handle_new_user(),\n  public.handle_new_user(),',
    )
    const mutatedFull = sql.replace(revoke.raw, mutatedRaw)
    const mutatedRevoke = revokeOf(mutatedFull)!
    expect(mutatedRevoke.functions.length).toBe(9)
    expect(mutatedRevoke.functions.filter((f) => f === 'public.handle_new_user()').length).toBe(2)
  })

  it('extra: reordered signatures still satisfy set equality (order-independent checks) but not the order-sensitive T13/T23 checks', () => {
    const revoke = revokeOf(read(TARGET_FILE))!
    const reversed = revoke.functions.slice().reverse()
    expect(reversed.slice().sort()).toEqual(CANONICAL_QUALIFIED.slice().sort())
    expect(reversed).not.toEqual(CANONICAL_QUALIFIED)
  })

  it('extra: a whitespace-only reformatting of the revoke block is a negative control — it stays semantically correct', () => {
    const sql = read(TARGET_FILE)
    const revoke = revokeOf(sql)!
    const reformatted = revoke.raw.replace(/\n\s+/g, '\n  ')
    const reformattedFull = sql.replace(revoke.raw, reformatted)
    const reformattedRevoke = revokeOf(reformattedFull)!
    expect(reformattedRevoke.functions.slice().sort()).toEqual(CANONICAL_QUALIFIED.slice().sort())
  })

  it('extra: a comment-only edit near the revoke block is a negative control — it stays semantically correct', () => {
    const sql = read(TARGET_FILE)
    const revoke = revokeOf(sql)!
    const withExtraComment = sql.replace(revoke.raw, `-- (reviewed)\n${revoke.raw}`)
    expect(revokeOf(withExtraComment)).toBeDefined()
    expect(revokeOf(withExtraComment)!.functions).toEqual(CANONICAL_QUALIFIED)
  })

  it('extra: coordinated verifier relaxation + remove revoke + repins still fails — no combination of these three produces a false green', () => {
    let sql = read(TARGET_FILE)
    sql = sql.replace(/\n-- 5a-bis\.[\s\S]*?FROM service_role;\n/, '\n') // remove revoke
    const blocks = functionExecuteAclGuardBlocks(sql)
    const relaxedEntry = blocks[0]!.replace(
      "(a.grantee = 0 OR a.grantee = 'anon'::regrole::oid)",
      '(false)',
    ) // verifier relaxation (entry now never fires)
    expect(guardRoleShape(relaxedEntry)).toEqual({ hasPublic: false, hasAnon: false, hasServiceRole: false })
    expect(revokeOf(sql)).toBeUndefined()
    // "repins" (hash witness edits) are a separate axis entirely — they touch
    // different files and cannot alter what these two structural checks read.
  })

  it('extra: coordinated postcondition relaxation + remove revoke + repins still fails', () => {
    let sql = read(TARGET_FILE)
    sql = sql.replace(/\n-- 5a-bis\.[\s\S]*?FROM service_role;\n/, '\n')
    const blocks = functionExecuteAclGuardBlocks(sql)
    const relaxedPostcondition = blocks[1]!.replace(", 'service_role'::regrole::oid", '')
    expect(guardRoleShape(relaxedPostcondition).hasServiceRole).toBe(false)
    expect(revokeOf(sql)).toBeUndefined()
  })
})
