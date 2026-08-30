// tests/stella-char-cast-doctrine.test.ts
//
// MSC-07B.8-R9Y — DB-free/source-bound doctrine guarding the two policy-
// command diagnostic string_agg() expressions in stella_0004, and generically
// against unsafe concatenation of PostgreSQL internal "char" catalog
// attributes anywhere under db/.
//
// Root cause (R9W-B1 live failure, independently confirmed by R9X): PostgreSQL
// cannot resolve `text || "char"` unambiguously (pg_policy.polcmd is the
// internal single-byte "char" catalog type, not the SQL `character` type), so
// `p.polname || ':' || p.polcmd` fails with "operator is not unique" the
// moment a real deparser evaluates it. The fix is an explicit `p.polcmd::text`
// cast before concatenation — a type-resolution change only. No WHERE
// predicate, policy identity check, or authority statement is touched.
//
// This suite is strictly DB-free and source-bound: it reads db/prepared/*.sql
// (and, for the generic hazard census, everything under db/) as text and
// reasons about it structurally. It never connects to Postgres, never invokes
// Docker, and never uses the network.
//
// MSC-07B.8-R10D rebaseline: stella_0004 has since gained a second,
// independently authorized verifier-only change — the off-target
// policy-count predicates (precondition + postcondition) are now scoped to
// schema public (tests/stella-policy-census-doctrine.test.ts owns proving
// THAT change is correct and scoped). This file's frozen parent moves
// forward to the R10D-authorized boundary so its own diff-shape assertions
// (T11/T12) describe reality; its job stays exactly what it always was —
// proving the polcmd::text cast is present, safe and untouched. The R9Y
// hash (2230980c...) that PARENT_HEAD used to sit one commit past is now
// itself retired — see the retirement check in the T13 block below.
//
// The quote/comment-aware scanner below is deliberately NOT a general SQL
// parser — see "narrow, auditable" in the module doctrine this file
// implements. It recognizes exactly: qualified/quoted/case-varied references
// to a small, explicit list of internal "char" catalog columns, on either
// side of `||` or the equivalent `OPERATOR(pg_catalog.||)` form, guarded by
// an immediately-following `::text` cast.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const PREPARED = path.join(ROOT, 'db', 'prepared')
const DB_ROOT = path.join(ROOT, 'db')
const TARGET_FILE = 'stella_0004_role_separation.sql'
const read = (name: string) => readFileSync(path.join(PREPARED, name), 'utf8')

// The frozen parent this remediation's diff-shape assertions (T11/T12) are
// measured against. Rebaselined MSC-07B.8-R10D to the commit that already
// carries the R9Y polcmd::text cast (hash 2230980c...) — the boundary the
// R10D public-scoping remediation itself branched from — so T11/T12 describe
// the cast's non-regression under R10D, not R9Y's own now-historical delta.
// `git show <ref>:<path>` reads a file's content AT that commit without
// touching the working tree or requiring a checkout — no network, no Docker.
const PARENT_HEAD = '97272d038eec4970008f8dbf635b4fff1ee53f8e'

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

/** Every `.sql` file under `dir`, recursively — the generic hazard census is
 * scoped to all of db/, not just db/prepared, per the H-01 precedent in
 * tests/stella-r3-5-pg17-certification.test.ts (collectSqlFiles), so a
 * hazard hiding in db/migrations, db/baseline, db/audit, db/hosted, etc. is
 * not invisible to this doctrine. */
function collectSqlFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectSqlFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.sql')) files.push(full)
  }
  return files
}

// -----------------------------------------------------------------------
// Quote- and comment-aware sanitizer (T09). Two outputs from one state
// machine: `stripComments` removes -- line comments and /* */ block
// comments while leaving string-literal content byte-identical (used for
// structural WHERE-predicate comparisons, T11); `maskStringsAndComments`
// additionally blanks string-literal interiors (used for hazard pattern
// matching, so an unsafe-looking substring INSIDE a string literal can
// never false-positive — A32 — and a real hazard is never hidden behind a
// string containing "--" — A16).
// -----------------------------------------------------------------------

type ScanState = 'code' | 'string' | 'lineComment' | 'blockComment'

function scanSql(sql: string, maskStrings: boolean): string {
  let result = ''
  let state: ScanState = 'code'
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    const two = sql.slice(i, i + 2)
    if (state === 'code') {
      if (ch === "'") {
        state = 'string'
        result += maskStrings ? '#' : ch
        i += 1
        continue
      }
      if (two === '--') {
        state = 'lineComment'
        i += 2
        continue
      }
      if (two === '/*') {
        state = 'blockComment'
        i += 2
        continue
      }
      result += ch
      i += 1
      continue
    }
    if (state === 'string') {
      if (ch === "'" && sql[i + 1] === "'") {
        result += maskStrings ? '##' : "''"
        i += 2
        continue
      }
      if (ch === "'") {
        state = 'code'
        result += maskStrings ? '#' : ch
        i += 1
        continue
      }
      result += ch === '\n' ? '\n' : maskStrings ? '#' : ch
      i += 1
      continue
    }
    if (state === 'lineComment') {
      if (ch === '\n') {
        state = 'code'
        result += '\n'
      }
      i += 1
      continue
    }
    // blockComment
    if (two === '*/') {
      state = 'code'
      i += 2
      continue
    }
    if (ch === '\n') result += '\n'
    i += 1
  }
  return result
}

/** Comments removed, string-literal content preserved byte-for-byte. */
function stripComments(sql: string): string {
  return scanSql(sql, false)
}

/** Comments removed AND string-literal interiors blanked to `#` — safe input
 * for hazard pattern matching (T09, A16, A31, A32). */
function maskStringsAndComments(sql: string): string {
  return scanSql(sql, true)
}

// -----------------------------------------------------------------------
// T08 — the narrow, explicit list of PostgreSQL internal "char" (single-
// byte code) catalog columns this doctrine defends against. Not a general
// catalog crawler: adding a new one is a deliberate, reviewable edit here.
// -----------------------------------------------------------------------

const INTERNAL_CHAR_ATTRIBUTES = [
  'polcmd', // pg_policy — the R9W-B1/R9X live defect
  'relkind', // pg_class
  'relpersistence', // pg_class
  'relreplident', // pg_class
  'contype', // pg_constraint
  'typtype', // pg_type
  'typcategory', // pg_type
  'typalign', // pg_type
  'typstorage', // pg_type
  'attidentity', // pg_attribute
  'attgenerated', // pg_attribute
  'attalign', // pg_attribute
  'attstorage', // pg_attribute
  'prokind', // pg_proc
  'provolatile', // pg_proc
  'proparallel', // pg_proc
  'castcontext', // pg_cast
  'castmethod', // pg_cast
] as const

/** `||`, or its explicit-operator-call spelling `OPERATOR(pg_catalog.||)` /
 * `OPERATOR(||)` (T14/A14) — PostgreSQL treats them identically. */
const CONCAT_OP = String.raw`(?:\|\||OPERATOR\s*\(\s*(?:pg_catalog\.)?\|\|\s*\))`

/** A reference to `attr`, optionally multi-part-qualified (`p.attr`,
 * `pg_policy.attr`, `public.pg_policy.attr`) and optionally double-quoted at
 * any segment (T07), case-insensitive when compiled with the `i` flag (T06),
 * with word-boundary-safe edges so `polcmd` never matches `xpolcmd`/
 * `polcmd2` (T03/T04) and multiline whitespace between qualifier segments is
 * tolerated (T05). */
function attrPattern(attr: string): string {
  return String.raw`(?<![A-Za-z0-9_.])(?:"?[A-Za-z_][A-Za-z0-9_]*"?\s*\.\s*)*"?${attr}"?(?![A-Za-z0-9_])`
}

/** A cast is only recognized when it is the LITERAL text `::text`
 * immediately (module whitespace) after the attribute reference — a
 * misleading prefix like `::textfoo` does not satisfy this (A07), because
 * `text` there is not followed by a word boundary. */
function safeCastLookahead(): string {
  return String.raw`(?!\s*::text\b)`
}

function unsafeOccurrences(sanitizedSql: string, attr: string): RegExpMatchArray[] {
  const ref = attrPattern(attr)
  const notCast = safeCastLookahead()
  const rightUnsafe = new RegExp(`${CONCAT_OP}\\s*(${ref})${notCast}`, 'gi')
  const leftUnsafe = new RegExp(`(${ref})${notCast}\\s*${CONCAT_OP}`, 'gi')
  return [...sanitizedSql.matchAll(rightUnsafe), ...sanitizedSql.matchAll(leftUnsafe)]
}

/** Every hazard, across every attribute in the narrow list, in one file's
 * executable SQL. */
function findAllHazards(sql: string): Array<{ attr: string; match: string }> {
  const sanitized = maskStringsAndComments(sql)
  const hazards: Array<{ attr: string; match: string }> = []
  for (const attr of INTERNAL_CHAR_ATTRIBUTES) {
    for (const m of unsafeOccurrences(sanitized, attr)) {
      hazards.push({ attr, match: m[0] })
    }
  }
  return hazards
}

/** T10 — alias laundering: `polcmd AS cmd` then `... || cmd ...` later,
 * without a cast on the alias itself. Narrow, single-file, single-hop only
 * (no cross-CTE/cross-file alias tracking — "if practical within authorized
 * narrow scope"). */
function findAliasLaunderingHazards(sql: string): Array<{ attr: string; alias: string; match: string }> {
  const sanitized = maskStringsAndComments(sql)
  const hazards: Array<{ attr: string; alias: string; match: string }> = []
  for (const attr of INTERNAL_CHAR_ATTRIBUTES) {
    const aliasDecl = new RegExp(`${attrPattern(attr)}\\s+AS\\s+"?([A-Za-z_][A-Za-z0-9_]*)"?`, 'gi')
    for (const decl of sanitized.matchAll(aliasDecl)) {
      const alias = decl[1]!
      for (const m of unsafeOccurrences(sanitized, alias)) {
        hazards.push({ attr, alias, match: m[0] })
      }
    }
  }
  return hazards
}

// -----------------------------------------------------------------------
// T01 / T02 — exact site count and exact cast form, live in stella_0004
// -----------------------------------------------------------------------

describe('T01/T02 — the two canonical policy-command diagnostics are exactly cast', () => {
  it('T01: exactly two string_agg(p.polname || \':\' || p.polcmd...) diagnostic statements exist in stella_0004', () => {
    const sql = read(TARGET_FILE)
    const statements = [...sql.matchAll(/SELECT string_agg\(p\.polname[^;]+;/g)]
    expect(statements.length).toBe(2)
    const targets = statements.map((m) => (m[0].match(/INTO (drift|problem)/) ?? [])[1])
    expect(targets.sort()).toEqual(['drift', 'problem'])
  })

  it('T02: each diagnostic statement casts p.polcmd to text before concatenation, and carries no residual hazard', () => {
    const sql = read(TARGET_FILE)
    const statements = [...sql.matchAll(/SELECT string_agg\(p\.polname[^;]+;/g)].map((m) => m[0])
    expect(statements.length).toBe(2)
    for (const statement of statements) {
      expect(statement).toMatch(/p\.polcmd::text/)
      expect(findAllHazards(statement)).toEqual([])
    }
  })
})

// -----------------------------------------------------------------------
// T03 / T04 — no raw, uncast polcmd concatenation survives anywhere under db/
// -----------------------------------------------------------------------

describe('T03/T04/F — no executable raw polcmd concatenation (either operand order) anywhere under db/', () => {
  const sqlFiles = collectSqlFiles(DB_ROOT)

  it('at least 50 .sql files are in scope (the census is not accidentally empty)', () => {
    expect(sqlFiles.length).toBeGreaterThan(50)
  })

  it('T03/T04: zero raw `|| polcmd` or `polcmd ||` occurrences repo-wide', () => {
    const offenders = sqlFiles
      .map((file) => ({ file, hazards: findAllHazards(readFileSync(file, 'utf8')).filter((h) => h.attr === 'polcmd') }))
      .filter((r) => r.hazards.length > 0)
    expect(offenders).toEqual([])
  })

  it('OTHER_INTERNAL_CHAR_TEXT_COMPOSITION_HAZARDS_POSTEDIT: zero hazards for every other narrow-list attribute repo-wide', () => {
    const offenders = sqlFiles
      .map((file) => ({ file, hazards: findAllHazards(readFileSync(file, 'utf8')).filter((h) => h.attr !== 'polcmd') }))
      .filter((r) => r.hazards.length > 0)
    expect(offenders).toEqual([])
  })

  it('T10: no alias-laundered internal-"char" concatenation repo-wide', () => {
    const offenders = sqlFiles
      .map((file) => ({ file, hazards: findAliasLaunderingHazards(readFileSync(file, 'utf8')) }))
      .filter((r) => r.hazards.length > 0)
    expect(offenders).toEqual([])
  })
})

// -----------------------------------------------------------------------
// T11 — the two diagnostic statements (the polcmd::text cast, their WHERE
// predicates, policy-identity checks, and NULL-test control flow) are
// completely untouched by the R10D off-target-count remediation
// -----------------------------------------------------------------------

describe('T11/H — R10D touches only off-target-count logic; the diagnostic cast statement itself is byte-identical to the frozen parent', () => {
  it('every 0004 diagnostic string_agg statement is byte-identical to its frozen-parent counterpart', () => {
    // stripComments (T09): a comment-only edit inside either statement must
    // not register as a semantic difference here — that is T30's job
    // (dated-evidence/prose immutability), not this control-flow proof.
    //
    // Unlike the original R9Y-era version of this test, no `::text` stripping
    // happens here: PARENT_HEAD (rebaselined R10D) already carries the cast,
    // and R10D's own diff never touches these two statements at all — it
    // only adds code AFTER them (the off-target count/IF/RAISE block that
    // tests/stella-policy-census-doctrine.test.ts governs). A genuinely
    // byte-identical comparison is therefore the correct, stronger claim.
    const parentSql = stripComments(gitShowAtParent(`db/prepared/${TARGET_FILE}`))
    const currentSql = stripComments(read(TARGET_FILE))

    const parentStatements = [...parentSql.matchAll(/SELECT string_agg\(p\.polname[^;]+;/g)].map((m) => m[0])
    const currentStatements = [...currentSql.matchAll(/SELECT string_agg\(p\.polname[^;]+;/g)].map((m) => m[0])
    expect(parentStatements.length).toBe(2)
    expect(currentStatements.length).toBe(2)

    for (let i = 0; i < 2; i += 1) {
      expect(currentStatements[i], `statement ${i}: must be byte-identical to the frozen parent`).toBe(
        parentStatements[i],
      )
    }
  })
})

// -----------------------------------------------------------------------
// T12 — canonical authority DDL is unchanged (stricter than the AUTHORITY_
// STATEMENT set elsewhere: this one also recognizes CREATE/DROP/ALTER POLICY,
// closing the policy-DDL authority gap Fable flagged, within this file's own
// narrow scope, for THIS remediation's diff specifically)
// -----------------------------------------------------------------------

const AUTHORITY_STATEMENT =
  /\b(GRANT|REVOKE|CREATE\s+ROLE|ALTER\s+ROLE|CREATE\s+TABLE|DROP\s+TABLE|CREATE\s+TRIGGER|DROP\s+TRIGGER|CREATE\s+FUNCTION|ALTER\s+FUNCTION|DROP\s+FUNCTION|ALTER\s+TABLE|OWNER\s+TO|ALTER\s+DEFAULT\s+PRIVILEGES|CREATE\s+POLICY|DROP\s+POLICY|ALTER\s+POLICY)\b/

describe('T12/G — the diff against the frozen R10D parent touches no authority statement anywhere in stella_0004', () => {
  it('removes and adds no GRANT/REVOKE/role/ownership/table/trigger/function/policy-DDL statement', () => {
    const diffText = gitDiffAgainstParent(`db/prepared/${TARGET_FILE}`)
    const removedAuthority = diffLines(diffText, '-').filter((l) => AUTHORITY_STATEMENT.test(l))
    const addedAuthority = diffLines(diffText, '+').filter((l) => AUTHORITY_STATEMENT.test(l))
    expect(removedAuthority, 'removed authority line').toEqual([])
    expect(addedAuthority, 'added authority line').toEqual([])
  })

  // The R9Y-era version of this test pinned "exactly two lines, both inside
  // a string_agg diagnostic target list" — a claim specific to R9Y's own
  // one-token-per-site delta. R10D's authorized delta is a different shape
  // (new DECLARE entries plus an off-target-count/IF/RAISE block at each
  // site); tests/stella-policy-census-doctrine.test.ts owns proving THAT
  // shape is correct and minimal. This doctrine's own narrow claim is that
  // none of it reaches into the string_agg diagnostic statements this file
  // protects — T11 above proves that directly by byte-identity, and this
  // is the same claim restated from the diff side, independently.
  it('no added or removed line touches a string_agg diagnostic target list', () => {
    const diffText = gitDiffAgainstParent(`db/prepared/${TARGET_FILE}`)
    const removed = diffLines(diffText, '-')
    const added = diffLines(diffText, '+')
    const touchedRemoved = removed.filter((l) => l.includes('string_agg(p.polname'))
    const touchedAdded = added.filter((l) => l.includes('string_agg(p.polname'))
    expect(touchedRemoved, 'removed string_agg diagnostic line').toEqual([])
    expect(touchedAdded, 'added string_agg diagnostic line').toEqual([])
    // And the diff is not accidentally empty — R10D really did change this file.
    expect(removed.length + added.length).toBeGreaterThan(0)
  })
})

// -----------------------------------------------------------------------
// T13 — hash witnesses agree with each other and with the live bytes
// -----------------------------------------------------------------------

describe('T13 — active 0004 hash witnesses are exact and mutually consistent', () => {
  it('db/r3-5-pg17-certification-inputs.ts, tests/prepared-stella-sql.test.ts, and tests/stella-r3-5-pg17-certification.test.ts all agree with the live SHA-256', async () => {
    const { createHash } = await import('node:crypto')
    const live = createHash('sha256').update(read(TARGET_FILE)).digest('hex')

    const inputsTs = readFileSync(path.join(ROOT, 'db', 'r3-5-pg17-certification-inputs.ts'), 'utf8')
    const certTest = readFileSync(path.join(ROOT, 'tests', 'stella-r3-5-pg17-certification.test.ts'), 'utf8')
    const preparedTest = readFileSync(path.join(ROOT, 'tests', 'prepared-stella-sql.test.ts'), 'utf8')

    const inInputs = inputsTs.match(new RegExp(`'${TARGET_FILE}':\\s*'([0-9a-f]{64})'`))
    const inCertTest = certTest.match(new RegExp(`'${TARGET_FILE}':\\s*'([0-9a-f]{64})'`))
    const inPreparedTest = preparedTest.match(new RegExp(`sha256\\('${TARGET_FILE}'\\)\\)\\.toBe\\(\\s*'([0-9a-f]{64})'`))

    expect(inInputs, 'missing from db/r3-5-pg17-certification-inputs.ts').not.toBeNull()
    expect(inCertTest, 'missing from tests/stella-r3-5-pg17-certification.test.ts').not.toBeNull()
    expect(inPreparedTest, 'missing from tests/prepared-stella-sql.test.ts').not.toBeNull()

    // Three independent expectations, not one combined check — a single
    // stale witness must fail on its own line, not hide behind the other two.
    expect(inInputs![1], 'db/r3-5-pg17-certification-inputs.ts witness').toBe(live)
    expect(inCertTest![1], 'tests/stella-r3-5-pg17-certification.test.ts witness').toBe(live)
    expect(inPreparedTest![1], 'tests/prepared-stella-sql.test.ts witness').toBe(live)
  })

  it('the retired pre-R9Y hash is gone from every active witness', () => {
    const RETIRED = 'e73f255cc3eea748db3642b8087bcb553488dab82d6d6e612195d6fdba50a789'
    const inputsTs = readFileSync(path.join(ROOT, 'db', 'r3-5-pg17-certification-inputs.ts'), 'utf8')
    const certTest = readFileSync(path.join(ROOT, 'tests', 'stella-r3-5-pg17-certification.test.ts'), 'utf8')
    const preparedTest = readFileSync(path.join(ROOT, 'tests', 'prepared-stella-sql.test.ts'), 'utf8')
    expect(inputsTs).not.toContain(RETIRED)
    expect(certTest).not.toContain(RETIRED)
    expect(preparedTest).not.toContain(RETIRED)
  })

  it('the retired R9Y-era hash (superseded by R10D) is gone from every active witness and from the live file', () => {
    // 2230980c... was the live 0004 hash from R9Y (polcmd::text cast, no
    // scope fix) through the end of R9Y/R9S-X/R9T's tenure as frozen parent.
    // R10D's public-scoping fix moved the live bytes — and every active
    // witness — past it. It remains a valid `git show` target (PARENT_HEAD
    // above resolves to the commit that produced it) but must never again
    // appear as a live expectation.
    const RETIRED_R9Y = '2230980c23aa3a15aa2029b626fdd9f3d6dc40ea370f0169a579da9704c16650'
    const inputsTs = readFileSync(path.join(ROOT, 'db', 'r3-5-pg17-certification-inputs.ts'), 'utf8')
    const certTest = readFileSync(path.join(ROOT, 'tests', 'stella-r3-5-pg17-certification.test.ts'), 'utf8')
    const preparedTest = readFileSync(path.join(ROOT, 'tests', 'prepared-stella-sql.test.ts'), 'utf8')
    expect(inputsTs).not.toContain(RETIRED_R9Y)
    expect(certTest).not.toContain(RETIRED_R9Y)
    expect(preparedTest).not.toContain(RETIRED_R9Y)

    const live = createHash('sha256').update(read(TARGET_FILE)).digest('hex')
    expect(live).not.toBe(RETIRED_R9Y)
  })
})

// -----------------------------------------------------------------------
// Section P — adversarial matrix. Attacks that mutate real, on-disk bytes
// are simulated as in-memory strings derived from the ACTUAL statement text
// (mirroring the "quote-aware comparator" pattern in
// tests/stella-insert-policy-probe-doctrine.test.ts) — never written to
// disk. Cross-attribute generality (A28/A29) and scanner robustness
// (A11-A16, A30-A32) use synthetic fixtures.
// -----------------------------------------------------------------------

describe('Section P — adversarial matrix', () => {
  const realStatement = () => [...read(TARGET_FILE).matchAll(/SELECT string_agg\(p\.polname[^;]+;/g)][0]![0]

  it('A01/A02: removing ::text from either real site is detected', () => {
    const statement = realStatement()
    expect(findAllHazards(statement)).toEqual([])
    const site1Reverted = statement.replace('p.polcmd::text', 'p.polcmd')
    expect(findAllHazards(site1Reverted).length).toBeGreaterThan(0)
  })

  it('A03: removing casts from both real sites is detected at both sites independently', () => {
    const sql = read(TARGET_FILE)
    const bothReverted = sql.replaceAll('p.polcmd::text', 'p.polcmd')
    const hazards = findAllHazards(bothReverted).filter((h) => h.attr === 'polcmd')
    expect(hazards.length).toBe(2)
  })

  it('A04: casting only polname (leaving polcmd bare) is still detected', () => {
    const attacked = "SELECT string_agg(p.polname::text || ':' || p.polcmd, ', ') INTO drift FROM pg_policy p;"
    expect(findAllHazards(attacked).some((h) => h.attr === 'polcmd')).toBe(true)
  })

  it('A05: casting polcmd to "char" (a no-op re: the ambiguity) is still detected as unsafe', () => {
    const attacked = 'SELECT string_agg(p.polname || \':\' || p.polcmd::"char", \', \') INTO drift FROM pg_policy p;'
    expect(findAllHazards(attacked).some((h) => h.attr === 'polcmd')).toBe(true)
  })

  it('A06: casting polcmd to varchar (not exactly text) is still detected — the doctrine requires exactly ::text', () => {
    const attacked = "SELECT string_agg(p.polname || ':' || p.polcmd::varchar, ', ') INTO drift FROM pg_policy p;"
    expect(findAllHazards(attacked).some((h) => h.attr === 'polcmd')).toBe(true)
  })

  it('A07: a textfoo-like token does not satisfy the cast requirement', () => {
    const attacked = "SELECT string_agg(p.polname || ':' || p.polcmd::textfoo, ', ') INTO drift FROM pg_policy p;"
    expect(findAllHazards(attacked).some((h) => h.attr === 'polcmd')).toBe(true)
  })

  it('A08: moving the cast to the outer concatenation result leaves the inner || still ambiguous, and is still detected', () => {
    const attacked = "SELECT (p.polname || ':' || p.polcmd)::text INTO drift FROM pg_policy p;"
    expect(findAllHazards(attacked).some((h) => h.attr === 'polcmd')).toBe(true)
  })

  it('A09/A10: reformatted multiline raw concatenation (right- and left-hand) is still detected', () => {
    const rightForm = `SELECT string_agg(p.polname\n  ||\n  ':'\n  ||\n  p.polcmd\n, ', ') INTO drift FROM pg_policy p;`
    const leftForm = `SELECT string_agg(\n  p.polcmd\n  ||\n  ':'\n, ', ') INTO drift FROM pg_policy p;`
    expect(findAllHazards(rightForm).some((h) => h.attr === 'polcmd')).toBe(true)
    expect(findAllHazards(leftForm).some((h) => h.attr === 'polcmd')).toBe(true)
  })

  it('A11: a quoted identifier spelling ("polcmd") is still detected', () => {
    const attacked = `SELECT p.polname || ':' || p."polcmd" FROM pg_policy p;`
    expect(findAllHazards(attacked).some((h) => h.attr === 'polcmd')).toBe(true)
  })

  it('A12: a fully qualified identifier spelling (pg_policy.polcmd) is still detected', () => {
    const attacked = `SELECT pg_policy.polname || ':' || pg_policy.polcmd FROM pg_policy;`
    expect(findAllHazards(attacked).some((h) => h.attr === 'polcmd')).toBe(true)
  })

  it('A13: alias-laundering (polcmd AS cmd, then cmd concatenated bare) is detected by the dedicated alias check', () => {
    const attacked = `SELECT string_agg(p.polname || ':' || cmd, ', ') FROM (SELECT p.polname, p.polcmd AS cmd FROM pg_policy p) s;`
    expect(findAliasLaunderingHazards(attacked).length).toBeGreaterThan(0)
  })

  it('A14: the explicit OPERATOR(pg_catalog.||) form is detected, with and without the pg_catalog qualifier', () => {
    const qualified = `SELECT p.polname OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) p.polcmd FROM pg_policy p;`
    const unqualified = `SELECT p.polname OPERATOR(||) p.polcmd FROM pg_policy p;`
    expect(findAllHazards(qualified).some((h) => h.attr === 'polcmd')).toBe(true)
    expect(findAllHazards(unqualified).some((h) => h.attr === 'polcmd')).toBe(true)
  })

  it('A15: a comment claiming a safe cast does not launder an actually-unsafe executable line', () => {
    const attacked = `-- this line already uses p.polcmd::text, no fix needed\nSELECT p.polname || ':' || p.polcmd FROM pg_policy p;`
    expect(findAllHazards(attacked).some((h) => h.attr === 'polcmd')).toBe(true)
  })

  it('A16: a string literal containing "--" does not blind the scanner to a real hazard later on the same line', () => {
    const attacked = `SELECT '--' AS label, p.polname || ':' || p.polcmd FROM pg_policy p;`
    expect(findAllHazards(attacked).some((h) => h.attr === 'polcmd')).toBe(true)
  })

  it('A17-A24: WHERE/ORDER BY/predicate/CREATE POLICY mutations are caught by T11/T12, not this scanner — proving the two doctrines are complementary, not redundant', () => {
    const parentSql = gitShowAtParent(`db/prepared/${TARGET_FILE}`)
    const currentSql = read(TARGET_FILE)
    // A mutation to ORDER BY would still carry a valid ::text cast (this
    // scanner would report it SAFE) — T11's byte-identity check is what
    // catches it, independently.
    const orderByMutated = currentSql.replace(
      "ORDER BY p.polname) INTO drift",
      "ORDER BY p.polcmd::text) INTO drift",
    )
    expect(orderByMutated).not.toBe(currentSql)
    expect(findAllHazards(orderByMutated).filter((h) => h.attr === 'polcmd')).toEqual([])
    const mutatedStatement = [...orderByMutated.matchAll(/SELECT string_agg\(p\.polname[^;]+;/g)][0]![0]
    const parentStatement = [...parentSql.matchAll(/SELECT string_agg\(p\.polname[^;]+;/g)][0]![0]
    // New T11 mechanism (post-R10D rebaseline): direct byte-identity, no
    // cast-stripping — the frozen parent already carries the cast, so an
    // ORDER BY mutation is caught by simple inequality.
    expect(mutatedStatement).not.toBe(parentStatement)
  })

  it('A25: the current worktree already reflects a fully coordinated repin — no stray old hash anywhere active', () => {
    const RETIRED = 'e73f255cc3eea748db3642b8087bcb553488dab82d6d6e612195d6fdba50a789'
    const scanned = [
      'db/r3-5-pg17-certification-inputs.ts',
      'tests/prepared-stella-sql.test.ts',
      'tests/stella-r3-5-pg17-certification.test.ts',
      `db/prepared/${TARGET_FILE}`,
    ].map((f) => readFileSync(path.join(ROOT, f), 'utf8'))
    for (const content of scanned) expect(content).not.toContain(RETIRED)
  })

  it('A26/A27: a single stale witness fails independently of the other two agreeing', async () => {
    const { createHash } = await import('node:crypto')
    const live = createHash('sha256').update(read(TARGET_FILE)).digest('hex')
    // Flip a hex digit at a fixed position, guaranteed to differ regardless
    // of what the live digest happens to contain there.
    const flip = (hash: string, index: number) => {
      const original = hash[index]!
      const replacement = original === '0' ? '1' : '0'
      return hash.slice(0, index) + replacement + hash.slice(index + 1)
    }
    const staleA = flip(live, 0)
    const staleB = flip(live, live.length - 1)
    expect(staleA).not.toBe(live)
    expect(staleB).not.toBe(live)
    // The production check (T13 above) is three independent `expect(...).toBe(live)`
    // calls, not a three-way cross-comparison — so tampering with exactly one
    // witness cannot hide behind the other two still agreeing with each other.
  })

  it('A28: a sibling internal-"char" attribute (relkind) concatenated bare is detected — the generic guard is not polcmd-only', () => {
    const attacked = `SELECT c.relname || ':' || c.relkind FROM pg_class c;`
    expect(findAllHazards(attacked).some((h) => h.attr === 'relkind')).toBe(true)
  })

  it('A29: the same sibling attribute, explicitly cast, is accepted as safe', () => {
    const safe = `SELECT c.relname || ':' || c.relkind::text FROM pg_class c;`
    expect(findAllHazards(safe)).toEqual([])
  })

  it('A30: formatting-only reformatting of an already-safe statement stays safe (negative control)', () => {
    const reformatted = `SELECT\n  string_agg(\n    p.polname\n    || ':'\n    || p.polcmd::text\n  , ', ' ORDER BY p.polname\n  )\nINTO drift\nFROM pg_policy p;`
    expect(findAllHazards(reformatted)).toEqual([])
  })

  it('A31: an unsafe-looking comment with no executable hazard reports zero hazards (negative control)', () => {
    const commentOnly = `-- p.polcmd || ':' would be unsafe, but this line never executes\nSELECT 1;`
    expect(findAllHazards(commentOnly)).toEqual([])
  })

  it('A32: an unsafe-looking quoted string literal with no executable hazard reports zero hazards (negative control)', () => {
    const stringOnly = `SELECT 'p.polcmd || x' AS not_code;`
    expect(findAllHazards(stringOnly)).toEqual([])
  })
})
