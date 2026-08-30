// tests/stella-insert-policy-probe-doctrine.test.ts
//
// MSC-07B.8-R9T — verifier-only remediation of R9S-X root cause B
// (SELF_VERIFICATION_CANONICALIZATION_DEFECT): eight INSERT-policy verifier
// sites, across six prepared stella_* packages, used to prove the canonical
// stella_suggestion_decisions_insert_member_or_admin WITH CHECK by comparing
// pg_get_expr(polwithcheck, polrelid, true) — the PRETTY-PRINT (3-arg) form —
// against a handwritten predicted deparse literal that was never validated
// live against a real PostgreSQL deparser (Fable 5 R9S-X, ROOT_CAUSE_
// CONFIDENCE=HIGH).
//
// The replacement doctrine proves the SAME claim a different way: at each
// site, a disjoint, temporary policy carrying the identical WITH CHECK
// source is created on public.stella_suggestion_decisions in the SAME
// session, and the real policy's pg_get_expr(polwithcheck, polrelid) — the
// 2-arg form — is compared to the probe's OWN observation of itself, using
// the identical deparser call on both sides. Nothing is predicted; both
// sides are observed.
//
// This suite is strictly DB-free and source-bound: it reads db/prepared/*.sql
// as text and reasons about it structurally. It never connects to Postgres,
// never invokes Docker, and never uses the network — see
// tests/database-role-safety.test.ts and tests/database-default-privileges.test.ts
// for the live counterparts this suite is deliberately NOT.
//
// CREATE POLICY authority itself is untouched by this remediation — only the
// verifier's PROOF MECHANISM changed. T14/T26/T27/T28 exist to make that an
// assertion, not a claim.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const PREPARED = path.join(ROOT, 'db', 'prepared')
const read = (name: string) => readFileSync(path.join(PREPARED, name), 'utf8')

// The frozen parent commit this remediation branched from (MSC-07B.8-R9T
// authorization). `git show <ref>:<path>` reads a file's content AT that
// commit without touching the working tree or requiring a checkout.
const PARENT_HEAD = '38f4d9a27230b02f3b844e8aff7585e68837e10b'

// MSC-07B.8-R10J rebaseline: T27 (stella_0004, one of the six packages below)
// must keep describing R9T's own diff-shape — that its remediation touched
// only the verifier's proof mechanism, never authority — regardless of what
// lands in stella_0004 afterward. Pinning the diff's second endpoint to the
// mutable working tree (git's default when only one ref is given) would
// silently absorb R10J's own, separately authorized
// `REVOKE ... FROM service_role` addition and misreport it as an R9T
// authority regression. Pinning it instead to 113e857 — this package's own
// frozen pre-R10J parent HEAD — keeps every comparison in this file scoped to
// history strictly before R10J.
const R10J_PARENT_HEAD = '113e857fc1ed9016fe0aeb0215d4c54fddb60640'

function gitShowAtParent(relPath: string): string {
  return execFileSync('git', ['show', `${PARENT_HEAD}:${relPath}`], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

function gitDiffAgainstParent(relPath: string): string {
  return execFileSync('git', ['diff', PARENT_HEAD, R10J_PARENT_HEAD, '--', relPath], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

const SIX_PACKAGES = [
  'stella_0003_suggestion_decisions.sql',
  'stella_0004_role_separation.sql',
  'stella_0005_runtime_cutover.sql',
  'stella_0005_rollback.sql',
  'stella_0005c_runtime_policy_scope.sql',
  'stella_0005c_rollback.sql',
] as const

const EXPECTED_SITE_COUNT: Record<(typeof SIX_PACKAGES)[number], number> = {
  'stella_0003_suggestion_decisions.sql': 1,
  'stella_0004_role_separation.sql': 2,
  'stella_0005_runtime_cutover.sql': 1,
  'stella_0005_rollback.sql': 1,
  'stella_0005c_runtime_policy_scope.sql': 2,
  'stella_0005c_rollback.sql': 1,
}

const PROBE_NAME = 'stella_decision_canonical_insert_probe'
const CANONICAL_NAME = 'stella_suggestion_decisions_insert_member_or_admin'

/** Strips `--` line comments. Several assertions below are about LIVE code
 * only — this file's own prose (like the header above) names the retired
 * doctrine to explain what changed, and a raw-text match must not
 * false-positive on that explanation. */
function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

/**
 * Quote-aware compaction (Section S): removes whitespace OUTSIDE single-quoted
 * string literals, and leaves everything INSIDE a literal — including
 * whitespace and punctuation — byte-for-byte untouched. `''` (an escaped
 * quote inside a string) is treated as two literal characters, not a
 * close-then-reopen, mirroring stripAllComments() in
 * tests/prepared-stella-sql.test.ts.
 *
 * This is deliberately NOT the same as the naive `sql.replace(/\s+/g, '')`
 * compactor used elsewhere in this test suite (e.g.
 * tests/stella-r3-3-role-topology.test.ts): that compactor is QUOTE-BLIND —
 * it would silently strip a smuggled space out of a GUC literal like
 * `'app.organization_id '`, making a wrong setting name look identical to
 * the canonical one. See 'quote-aware comparator' below for the mutation
 * this difference exists to catch.
 */
function quoteAwareCompact(sql: string): string {
  let result = ''
  let inString = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    if (ch === "'") {
      if (inString && sql[i + 1] === "'") {
        result += "''"
        i++
        continue
      }
      inString = !inString
      result += ch
      continue
    }
    if (!inString && /\s/.test(ch)) continue
    result += ch
  }
  return result
}

const CANONICAL_CHECK_COMPACT =
  "organization_id=current_setting('app.organization_id',true)::uuidANDorganization_id=ANY(public.current_user_org_ids())ANDdecided_by=auth.uid()"

/** Every occurrence of the probe's CREATE POLICY ... WITH CHECK (...) body in
 * one file. `[^;]+` (not the lazier `[\s\S]*?\);`) mirrors
 * insertPolicyBody() in tests/stella-r3-3-role-topology.test.ts: the body
 * contains no semicolon, so stopping at the first one is exact, not lazy. */
function probeCheckBodies(sql: string): string[] {
  return [
    ...sql.matchAll(
      new RegExp(`CREATE POLICY ${PROBE_NAME}[\\s\\S]*?WITH CHECK\\s*\\(([^;]+)\\);`, 'g'),
    ),
  ].map((m) => m[1]!)
}

function canonicalCheckBody(sql: string): string {
  const m = sql.match(
    new RegExp(`CREATE POLICY ${CANONICAL_NAME}[\\s\\S]*?WITH CHECK\\s*\\(([^;]+)\\);`),
  )
  expect(m, 'canonical decision INSERT policy CREATE block').not.toBeNull()
  return m![1]!
}

// -----------------------------------------------------------------------
// T01 / T02 — exact total and per-package distribution
// -----------------------------------------------------------------------

describe('T01/T02 — probe-verifier site inventory', () => {
  const perFile = SIX_PACKAGES.map((file) => [file, probeCheckBodies(read(file)).length] as const)

  it('T01: exactly 8 probe-verifier sites across the six packages', () => {
    const total = perFile.reduce((sum, [, count]) => sum + count, 0)
    expect(total).toBe(8)
  })

  it('T02: the distribution is exactly 1/2/1/1/2/1', () => {
    expect(Object.fromEntries(perFile)).toEqual(EXPECTED_SITE_COUNT)
  })

  it.each(perFile)('%s carries exactly %i probe site(s) (also via CREATE/DROP pairing)', (file, count) => {
    const sql = read(file)
    const creates = [...sql.matchAll(new RegExp(`CREATE POLICY ${PROBE_NAME}\\b`, 'g'))].length
    const drops = [...sql.matchAll(new RegExp(`DROP POLICY ${PROBE_NAME}\\b`, 'g'))].length
    expect(creates).toBe(count)
    expect(drops).toBe(count)
  })
})

// -----------------------------------------------------------------------
// T03 / T04 — probe name disjoint from canonical, no collision
// -----------------------------------------------------------------------

describe('T03/T04 — probe name is disjoint from the canonical policy name', () => {
  it('T03: the probe name and the canonical name share no substring relationship', () => {
    expect(PROBE_NAME).not.toBe(CANONICAL_NAME)
    expect(PROBE_NAME.startsWith(CANONICAL_NAME)).toBe(false)
    expect(CANONICAL_NAME.startsWith(PROBE_NAME)).toBe(false)
    expect(PROBE_NAME.includes(CANONICAL_NAME)).toBe(false)
    expect(CANONICAL_NAME.includes(PROBE_NAME)).toBe(false)
  })

  it('T04: no CREATE POLICY anywhere in the six packages uses the probe name as ITS canonical identity', () => {
    for (const file of SIX_PACKAGES) {
      const sql = read(file)
      // The probe name legitimately appears in its own preexistence guard
      // (`polname = '<probe>'`, with no polcmd nearby) — that is not a
      // canonical-identity claim. A canonical-identity structural check is
      // the one that ALSO asserts polcmd = 'a' nearby; the probe name must
      // never be the name inside ONE of those.
      const structuralIdentityChecks = [
        ...sql.matchAll(/polname\s*=\s*'([^']+)'[\s\S]{0,80}?polcmd\s*=\s*'a'/g),
      ].map((m) => m[1])
      expect(structuralIdentityChecks.length, `${file}: at least one structural identity check`).toBeGreaterThan(0)
      expect(structuralIdentityChecks).not.toContain(PROBE_NAME)
      expect(structuralIdentityChecks.every((n) => n === CANONICAL_NAME)).toBe(true)
    }
  })
})

// -----------------------------------------------------------------------
// T05 / T06 — every probe is FOR INSERT TO uellix_app
// -----------------------------------------------------------------------

describe('T05/T06 — every probe carries the same command and role as the canonical policy', () => {
  for (const file of SIX_PACKAGES) {
    it(`${file}: every probe site is FOR INSERT TO uellix_app`, () => {
      const sql = read(file)
      const blocks = [
        ...sql.matchAll(new RegExp(`CREATE POLICY ${PROBE_NAME}[\\s\\S]*?;`, 'g')),
      ].map((m) => m[0])
      expect(blocks.length).toBe(EXPECTED_SITE_COUNT[file as (typeof SIX_PACKAGES)[number]])
      for (const block of blocks) {
        expect(block, 'T05 FOR INSERT').toMatch(/FOR INSERT/)
        expect(block, 'T06 TO uellix_app').toMatch(/TO uellix_app/)
        expect(block, 'no other role').not.toMatch(/TO\s+(authenticated|service_role|anon|PUBLIC)\b/)
      }
    })
  }
})

// -----------------------------------------------------------------------
// T07 — creator <-> probe WITH CHECK authority equivalence, at every site,
// against the FROZEN canonical contract (not merely against each other,
// which two drifting copies could still satisfy).
// -----------------------------------------------------------------------

describe('T07 — every probe body is quote-aware-identical to the frozen canonical contract', () => {
  it('the canonical CREATE POLICY in stella_0003 still matches the frozen contract', () => {
    const body = canonicalCheckBody(read('stella_0003_suggestion_decisions.sql'))
    expect(quoteAwareCompact(body)).toBe(CANONICAL_CHECK_COMPACT)
  })

  for (const file of SIX_PACKAGES) {
    it(`${file}: every probe body matches the frozen contract exactly`, () => {
      const bodies = probeCheckBodies(read(file))
      expect(bodies.length).toBe(EXPECTED_SITE_COUNT[file as (typeof SIX_PACKAGES)[number]])
      for (const body of bodies) {
        expect(quoteAwareCompact(body)).toBe(CANONICAL_CHECK_COMPACT)
      }
    })
  }
})

// -----------------------------------------------------------------------
// T08 / T09 / T10 / T11 / T12 / T13 — the three conjuncts, AND (not OR), and
// no widened role/branch, are present in the frozen contract itself. Real
// drift is caught by T07 (equality to this same constant); this documents
// WHAT the constant asserts so a future edit to the constant cannot
// silently widen the contract unnoticed.
// -----------------------------------------------------------------------

describe('T08-T13 — the frozen canonical contract has exactly the intended shape', () => {
  it('T08: organization GUC branch is present', () => {
    expect(CANONICAL_CHECK_COMPACT).toContain("current_setting('app.organization_id',true)")
  })
  it('T09: current_user_org_ids branch is present', () => {
    expect(CANONICAL_CHECK_COMPACT).toContain('current_user_org_ids()')
  })
  it('T10: auth.uid branch is present', () => {
    expect(CANONICAL_CHECK_COMPACT).toContain('decided_by=auth.uid()')
  })
  it('T11: the three branches are joined by AND, not OR', () => {
    expect(CANONICAL_CHECK_COMPACT.match(/AND/g)).toHaveLength(2)
    expect(CANONICAL_CHECK_COMPACT).not.toMatch(/\bOR\b/)
  })
  it('T12: no super_admin branch', () => {
    expect(CANONICAL_CHECK_COMPACT).not.toMatch(/super_admin/i)
  })
  it('T13: no broadened role surfaces in any probe TO clause', () => {
    for (const file of SIX_PACKAGES) {
      const sql = read(file)
      const blocks = [
        ...sql.matchAll(new RegExp(`CREATE POLICY ${PROBE_NAME}[\\s\\S]*?;`, 'g')),
      ].map((m) => m[0])
      for (const block of blocks) {
        expect(block).not.toMatch(/TO\s+(authenticated|service_role|anon|PUBLIC)\b/)
      }
    }
  })
})

// -----------------------------------------------------------------------
// T14 / T26 / T27 / T28 — canonical CREATE POLICY authority is unchanged
// from the frozen parent, and the diff against that parent touches no
// GRANT/REVOKE/role/ownership/table/trigger/function authority statement in
// any of the six packages — only the verifier mechanism changed.
// -----------------------------------------------------------------------

const AUTHORITY_STATEMENT = /\b(GRANT|REVOKE|CREATE\s+ROLE|ALTER\s+ROLE|CREATE\s+TABLE|DROP\s+TABLE|CREATE\s+TRIGGER|DROP\s+TRIGGER|CREATE\s+FUNCTION|ALTER\s+FUNCTION|DROP\s+FUNCTION|ALTER\s+TABLE|OWNER\s+TO|ALTER\s+DEFAULT\s+PRIVILEGES)\b/

function diffLines(diffText: string, marker: '-' | '+'): string[] {
  return diffText
    .split('\n')
    .filter((l) => l.startsWith(marker) && !l.startsWith(marker.repeat(2)))
}

describe('T14/T26 — the canonical CREATE POLICY block in stella_0003 is byte-identical to the frozen parent', () => {
  it('quote-aware-compacted, current 0003 canonical policy equals the parent one', () => {
    const parentSql = gitShowAtParent('db/prepared/stella_0003_suggestion_decisions.sql')
    const currentSql = read('stella_0003_suggestion_decisions.sql')
    expect(quoteAwareCompact(canonicalCheckBody(currentSql))).toBe(
      quoteAwareCompact(canonicalCheckBody(parentSql)),
    )
  })

  it('the diff against the parent for stella_0003 removes and adds no authority statement', () => {
    const diffText = gitDiffAgainstParent('db/prepared/stella_0003_suggestion_decisions.sql')
    const removedAuthority = diffLines(diffText, '-').filter((l) => AUTHORITY_STATEMENT.test(l))
    const addedAuthority = diffLines(diffText, '+').filter((l) => AUTHORITY_STATEMENT.test(l))
    expect(removedAuthority, 'removed authority line in stella_0003').toEqual([])
    expect(addedAuthority, 'added authority line in stella_0003').toEqual([])
  })
})

describe('T27 — stella_0004: the diff against the parent touches no authority statement', () => {
  it('removes and adds no GRANT/REVOKE/role/ownership/table/trigger/function statement', () => {
    const diffText = gitDiffAgainstParent('db/prepared/stella_0004_role_separation.sql')
    const removedAuthority = diffLines(diffText, '-').filter((l) => AUTHORITY_STATEMENT.test(l))
    const addedAuthority = diffLines(diffText, '+').filter((l) => AUTHORITY_STATEMENT.test(l))
    expect(removedAuthority, 'removed authority line in stella_0004').toEqual([])
    expect(addedAuthority, 'added authority line in stella_0004').toEqual([])
  })
})

describe('T28 — the 0005 family: the diff against the parent touches no authority statement', () => {
  const FAMILY = [
    'stella_0005_runtime_cutover.sql',
    'stella_0005_rollback.sql',
    'stella_0005c_runtime_policy_scope.sql',
    'stella_0005c_rollback.sql',
  ] as const

  it.each(FAMILY)('%s removes and adds no authority statement', (file) => {
    const diffText = gitDiffAgainstParent(`db/prepared/${file}`)
    const removedAuthority = diffLines(diffText, '-').filter((l) => AUTHORITY_STATEMENT.test(l))
    const addedAuthority = diffLines(diffText, '+').filter((l) => AUTHORITY_STATEMENT.test(l))
    expect(removedAuthority, `removed authority line in ${file}`).toEqual([])
    expect(addedAuthority, `added authority line in ${file}`).toEqual([])
  })

  it('none of the four packages gained or lost a CREATE POLICY beyond the probe', () => {
    for (const file of FAMILY) {
      const diffText = gitDiffAgainstParent(`db/prepared/${file}`)
      const addedCreatePolicy = diffLines(diffText, '+').filter((l) => /CREATE POLICY/.test(l))
      const removedCreatePolicy = diffLines(diffText, '-').filter((l) => /CREATE POLICY/.test(l))
      expect(addedCreatePolicy.every((l) => l.includes(PROBE_NAME)), `${file}: unexpected added CREATE POLICY`).toBe(true)
      expect(removedCreatePolicy, `${file}: no CREATE POLICY should be removed`).toEqual([])
    }
  })
})

// -----------------------------------------------------------------------
// T15 / T16 / T17 / T18 / T19 — deparse-doctrine hygiene
// -----------------------------------------------------------------------

describe('T15-T19 — deparse doctrine: observed-vs-observed, both sides the same 2-arg form', () => {
  for (const file of SIX_PACKAGES) {
    it(`${file}: no 3-arg pretty-print pg_get_expr, no handwritten literal, no regexp_replace normalization`, () => {
      const live = stripLineComments(read(file))
      // T16
      expect(live).not.toMatch(/pg_get_expr\([^)]*,\s*true\)/)
      // T17
      expect(live).not.toMatch(/expected_decision_insert_check/)
      // T18
      expect(live).not.toMatch(/regexp_replace\(\s*regexp_replace\(pg_get_expr/)
      // T15/T19: every live pg_get_expr call touching polwithcheck/polqual for
      // this policy is the SAME 2-arg form — real and probe observations use
      // an identical deparser call, so neither side can drift independently.
      const pgGetExprCalls = [...live.matchAll(/pg_get_expr\(([^)]*)\)/g)].map((m) => m[1])
      for (const args of pgGetExprCalls) {
        const argCount = args.split(',').length
        expect(argCount, `pg_get_expr(${args}) must be 2-arg`).toBe(2)
      }
    })
  }

  it('T15: both the real and probe observations in every site use identical SELECT shape', () => {
    for (const file of SIX_PACKAGES) {
      const sql = read(file)
      const realObs = [
        ...sql.matchAll(
          /SELECT pg_get_expr\(polwithcheck, polrelid\) INTO decision_insert_check_actual/g,
        ),
      ].length
      const probeObs = [
        ...sql.matchAll(
          /SELECT pg_get_expr\(polwithcheck, polrelid\) INTO decision_insert_check_probe/g,
        ),
      ].length
      expect(realObs, `${file}: real observation count`).toBe(EXPECTED_SITE_COUNT[file as (typeof SIX_PACKAGES)[number]])
      expect(probeObs, `${file}: probe observation count`).toBe(EXPECTED_SITE_COUNT[file as (typeof SIX_PACKAGES)[number]])
    }
  })
})

// -----------------------------------------------------------------------
// T20 — probe dropped before any inventory/count check runs while it exists
// -----------------------------------------------------------------------

describe('T20 — no policy-count/inventory assertion runs while the probe still exists', () => {
  for (const file of SIX_PACKAGES) {
    it(`${file}: nothing between each probe's CREATE and its DROP counts pg_policy/pg_policies`, () => {
      const sql = read(file)
      const spans = [
        ...sql.matchAll(new RegExp(`CREATE POLICY ${PROBE_NAME}[\\s\\S]*?DROP POLICY ${PROBE_NAME}[^;]*;`, 'g')),
      ].map((m) => m[0])
      expect(spans.length).toBe(EXPECTED_SITE_COUNT[file as (typeof SIX_PACKAGES)[number]])
      for (const span of spans) {
        expect(span, 'a count ran while the probe existed').not.toMatch(/count\(\*\)[\s\S]{0,80}FROM pg_polic/i)
      }

      // Every probe created must also be dropped — a CREATE with no
      // matching DROP would leave it on the table permanently (Section H:
      // "the probe must never survive successful verification"), which the
      // paired-span count above cannot see on its own once the counts stop
      // matching 1:1.
      const creates = [...sql.matchAll(new RegExp(`CREATE POLICY ${PROBE_NAME}\\b`, 'g'))].length
      const drops = [...sql.matchAll(new RegExp(`DROP POLICY ${PROBE_NAME}\\b`, 'g'))].length
      expect(creates, `${file}: CREATE/DROP parity`).toBe(drops)
      expect(creates).toBe(EXPECTED_SITE_COUNT[file as (typeof SIX_PACKAGES)[number]])
    })

    it(`${file}: every probe targets public.stella_suggestion_decisions, never another table`, () => {
      const sql = read(file)
      const blocks = [
        ...sql.matchAll(new RegExp(`CREATE POLICY ${PROBE_NAME}[\\s\\S]*?;`, 'g')),
      ].map((m) => m[0])
      expect(blocks.length).toBe(EXPECTED_SITE_COUNT[file as (typeof SIX_PACKAGES)[number]])
      for (const block of blocks) {
        expect(block).toMatch(/ON public\.stella_suggestion_decisions/)
      }
    })
  }
})

// -----------------------------------------------------------------------
// T21 / T22 — fail-closed preexistence guard, no exception swallowing
// -----------------------------------------------------------------------

describe('T21/T22 — fail-closed probe lifecycle', () => {
  for (const file of SIX_PACKAGES) {
    it(`${file}: every probe site guards against a preexisting probe and swallows nothing`, () => {
      const sql = read(file)
      const guards = [
        ...sql.matchAll(
          new RegExp(
            `IF EXISTS \\(\\s*SELECT 1 FROM pg_policy\\s*WHERE polrelid = [\\s\\S]{0,120}?AND polname = '${PROBE_NAME}'\\s*\\n\\s*\\) THEN\\s*\\n\\s*RAISE EXCEPTION`,
            'g',
          ),
        ),
      ].length
      expect(guards, `${file}: preexistence guard count`).toBe(EXPECTED_SITE_COUNT[file as (typeof SIX_PACKAGES)[number]])

      // T22: no EXCEPTION handler wraps any probe lifecycle span. Checked
      // with a MARGIN on both sides — not just the exact CREATE..DROP
      // span — because a `BEGIN` placed just before CREATE and an
      // `EXCEPTION WHEN ... END;` placed just after DROP would wrap
      // (and could swallow) the whole probe lifecycle from OUTSIDE the
      // literal CREATE..DROP substring.
      const lifecycleRe = new RegExp(`CREATE POLICY ${PROBE_NAME}[\\s\\S]*?DROP POLICY ${PROBE_NAME}[^;]*;`, 'g')
      for (const m of sql.matchAll(lifecycleRe)) {
        const withMargin = sql.slice(Math.max(0, m.index! - 60), m.index! + m[0].length + 250)
        expect(withMargin).not.toMatch(/EXCEPTION\s+WHEN/)
      }
    })
  }
})

// -----------------------------------------------------------------------
// T23 / T24 — mismatch diagnostics carry BOTH observed values
// -----------------------------------------------------------------------

describe('T23/T24 — mismatch diagnostics include both the actual and probe observed expressions', () => {
  for (const file of SIX_PACKAGES) {
    it(`${file}: the same-session probe mismatch RAISE names both variables`, () => {
      const sql = read(file)
      const raises = [
        ...sql.matchAll(
          /RAISE EXCEPTION '[^']*does not match the same-session probe\. actual=%, probe=%',\s*\n\s*COALESCE\(decision_insert_check_actual, '<absent>'\), COALESCE\(decision_insert_check_probe, '<absent>'\);/g,
        ),
      ].length
      expect(raises, `${file}: mismatch diagnostic count`).toBe(EXPECTED_SITE_COUNT[file as (typeof SIX_PACKAGES)[number]])
    })
  }
})

// -----------------------------------------------------------------------
// T25 — independent structural checks (name/cmd/role/permissive) remain
// -----------------------------------------------------------------------

describe('T25 — structural checks around the canonical policy survive the remediation', () => {
  for (const file of SIX_PACKAGES) {
    it(`${file}: every canonical-identity check still requires table, name, INSERT, uellix_app and permissive`, () => {
      const sql = read(file)
      // Anchored on the polname/polcmd pairing (a SHORT, unambiguous window —
      // the same anchor T04 uses), then a BOUNDED forward span to the
      // comparison, plus a bounded BACKWARD slice for the polrelid table
      // scope, which textually precedes polname in every site. Bounding both
      // directions matters: an unbounded lazy `[\s\S]*?` could otherwise
      // anchor from — or reach past — an unrelated, untouched occurrence of
      // the same literals elsewhere in the file (e.g. the probe's own
      // observation query) and report a false green for a weakened check.
      const identityAnchors = [
        ...sql.matchAll(new RegExp(`polname = '${CANONICAL_NAME}'[\\s\\S]{0,80}?polcmd = 'a'`, 'g')),
      ]
      expect(identityAnchors.length).toBe(EXPECTED_SITE_COUNT[file as (typeof SIX_PACKAGES)[number]])
      for (const anchor of identityAnchors) {
        const before = sql.slice(Math.max(0, anchor.index! - 200), anchor.index!)
        const forward = sql.slice(anchor.index!, anchor.index! + 500)
        expect(before, 'polrelid table scope precedes the identity check').toMatch(
          /polrelid\s*=\s*(?:tbl_oid|'public\.stella_suggestion_decisions'::regclass)/,
        )
        expect(forward).toMatch(/polroles = ARRAY\[(?:app_oid|'uellix_app'::regrole::oid)\]/)
        expect(forward).toMatch(/polpermissive/)
        expect(forward).toMatch(/decision_insert_check_actual = decision_insert_check_probe/)
      }
    })
  }
})

// -----------------------------------------------------------------------
// T29 — hash witnesses are exact and mutually consistent
// -----------------------------------------------------------------------

describe('T29 — active hash witnesses are exact', () => {
  it('the three active witness files agree with each other and with the live bytes', async () => {
    const { createHash } = await import('node:crypto')
    const sha256 = (name: string) => createHash('sha256').update(read(name)).digest('hex')

    const inputsTs = readFileSync(path.join(ROOT, 'db', 'r3-5-pg17-certification-inputs.ts'), 'utf8')
    const certTest = readFileSync(path.join(ROOT, 'tests', 'stella-r3-5-pg17-certification.test.ts'), 'utf8')
    const preparedTest = readFileSync(path.join(ROOT, 'tests', 'prepared-stella-sql.test.ts'), 'utf8')

    for (const file of ['stella_0003_suggestion_decisions.sql', 'stella_0004_role_separation.sql']) {
      const live = sha256(file)
      const inInputs = inputsTs.match(new RegExp(`'${file}':\\s*'([0-9a-f]{64})'`))
      const inCertTest = certTest.match(new RegExp(`'${file}':\\s*'([0-9a-f]{64})'`))
      const inPreparedTest = preparedTest.match(
        new RegExp(`sha256\\('${file}'\\)\\)\\.toBe\\(\\s*'([0-9a-f]{64})'`),
      )
      expect(inInputs, `${file} missing from r3-5-pg17-certification-inputs.ts`).not.toBeNull()
      expect(inCertTest, `${file} missing from stella-r3-5-pg17-certification.test.ts`).not.toBeNull()
      expect(inPreparedTest, `${file} missing from prepared-stella-sql.test.ts T10`).not.toBeNull()
      expect(inInputs![1]).toBe(live)
      expect(inCertTest![1]).toBe(live)
      expect(inPreparedTest![1]).toBe(live)
    }
  })

  it('the five packages this remediation does NOT touch keep their frozen hashes', async () => {
    const { createHash } = await import('node:crypto')
    const sha256 = (name: string) => createHash('sha256').update(read(name)).digest('hex')
    const UNCHANGED: Record<string, string> = {
      'stella_0001_role_topology_bootstrap.sql':
        '9f21955e505e5c2a5212fabcb683f7e1e514c6665fbc8726041a1cc631e4f7b3',
      'stella_0001_role_topology_bootstrap_rollback.sql':
        '7db648d44a93abd3bfe545b7301b436303a51d07148c69e07b1c8b1f35154f96',
      'stella_0002_interactions_hardening.sql':
        'cbf860b12d3f32205f2e0efba7c3c1c2d9a4658bafc3ab7949d2de4089e9ec9e',
      'stella_0002b_append_only_truncate_hardening.sql':
        '3fda2dfd117616e09b86da45b75e6f070bcc7a857e5a1c2da752670a83ac47b5',
      'stella_0004_rollback.sql':
        '22afa4cfddfe407abc6171b452659bf56d2a833663a818bfd55c6fab002f7cb6',
    }
    for (const [file, expected] of Object.entries(UNCHANGED)) {
      expect(sha256(file), file).toBe(expected)
    }
  })
})

// -----------------------------------------------------------------------
// T30 — dated historical evidence is untouched
// -----------------------------------------------------------------------

describe('T30 — dated historical evidence is unchanged by this remediation', () => {
  it('the docs/ops/staging/evidence/*.json snapshots have no diff against the parent', () => {
    const diffText = execFileSync(
      'git',
      ['diff', PARENT_HEAD, '--name-only', '--', 'docs/ops/staging/evidence/'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    expect(diffText.trim(), 'historical evidence must not change').toBe('')
  })
})

// -----------------------------------------------------------------------
// Quote-aware comparator (Section S) — proves the naive compactor used
// elsewhere in this suite is unsafe for THIS purpose, and that the
// quote-aware one this file uses is not.
// -----------------------------------------------------------------------

describe('quote-aware comparator: mutations inside a quoted literal', () => {
  /** The naive comparator other tests in this repo use (e.g. compact() in
   * tests/stella-r3-3-role-topology.test.ts): strips ALL whitespace,
   * including inside string literals. */
  const naiveCompact = (sql: string) => sql.replace(/\s+/g, '')

  const canonical = "current_setting('app.organization_id', true)"

  it('a smuggled space inside the GUC literal is INVISIBLE to the naive comparator', () => {
    const mutated = "current_setting('app.organization_id ', true)" // trailing space INSIDE the quotes
    expect(naiveCompact(mutated)).toBe(naiveCompact(canonical)) // false green, by construction
  })

  it('the quote-aware comparator DETECTS the same smuggled space', () => {
    const mutated = "current_setting('app.organization_id ', true)"
    expect(quoteAwareCompact(mutated)).not.toBe(quoteAwareCompact(canonical))
  })

  it('the quote-aware comparator still ignores formatting whitespace OUTSIDE literals', () => {
    const reformatted = "current_setting(\n  'app.organization_id',\n  true\n)"
    expect(quoteAwareCompact(reformatted)).toBe(quoteAwareCompact(canonical))
  })

  it('detects a same-looking expression with an altered quoted literal (different GUC)', () => {
    const mutated = "current_setting('app.org_id', true)"
    expect(quoteAwareCompact(mutated)).not.toBe(quoteAwareCompact(canonical))
  })

  it('detects a changed function name', () => {
    const mutated = "current_settingx('app.organization_id', true)"
    expect(quoteAwareCompact(mutated)).not.toBe(quoteAwareCompact(canonical))
  })

  it('detects a changed role in a TO clause', () => {
    const canonicalRole = 'TO uellix_app'
    const mutated = 'TO authenticated'
    expect(quoteAwareCompact(mutated)).not.toBe(quoteAwareCompact(canonicalRole))
  })

  it('applied to the real canonical body: still equals the frozen contract', () => {
    const body = canonicalCheckBody(read('stella_0003_suggestion_decisions.sql'))
    expect(quoteAwareCompact(body)).toBe(CANONICAL_CHECK_COMPACT)
    // ...and a one-character mutation inside the org GUC literal is caught.
    const tampered = body.replace("'app.organization_id'", "'app.organization_id_'")
    expect(quoteAwareCompact(tampered)).not.toBe(CANONICAL_CHECK_COMPACT)
  })
})

// -----------------------------------------------------------------------
// Lock-timeout doctrine (Section L)
// -----------------------------------------------------------------------

describe('lock_timeout doctrine — CREATE/DROP POLICY fails closed instead of stalling', () => {
  it.each(SIX_PACKAGES)('%s sets lock_timeout before any CREATE/DROP POLICY', (file) => {
    const sql = read(file)
    const lockIdx = sql.search(/SET lock_timeout = '5s';/)
    const firstPolicyDdlIdx = sql.search(/^\s*(CREATE|DROP) POLICY/m)
    expect(lockIdx, `${file}: SET lock_timeout present`).toBeGreaterThan(-1)
    if (firstPolicyDdlIdx > -1) {
      expect(lockIdx).toBeLessThan(firstPolicyDdlIdx)
    }
  })
})
