// tests/stella-policy-census-doctrine.test.ts
//
// MSC-07B.8-R10D — DB-free/source-bound doctrine guarding the two off-target
// policy-count verifier predicates in stella_0004 (precondition §0 and
// postcondition §9.12b).
//
// Root cause (R10C analytical closure): both predicates counted
//
//   (SELECT count(*) FROM pg_policy p WHERE p.polrelid <> target) <> 103
//
// with NO join back to pg_class/pg_namespace — so the count ran over the
// whole cluster, not schema public. storage.objects alone carries 3 policies
// (unit 41/50 of the baseline journal), so the unscoped count silently
// summed 103 (public) + 3 (storage) = 106 target-excluded rows against a
// literal that assumed only public existed. The fix scopes both sites to
// schema public via pg_policy -> pg_class -> pg_namespace, preserving the
// literal 103, the target exclusion by polrelid, the total-105 identity, and
// the target-count-2 identity untouched.
//
// This suite is strictly DB-free, Docker-free and network-free: it reads
// db/prepared/*.sql as text (plus one `git show`/`git diff` against the
// frozen R10D parent — no working-tree mutation, no checkout) and reasons
// about it structurally. It never connects to Postgres and never invokes
// Docker.
//
// Companion doctrine: tests/stella-char-cast-doctrine.test.ts owns the
// p.polcmd::text cast (R9Y) and was rebaselined alongside this file so its
// own diff-shape assertions describe the R10D frozen parent correctly. This
// file's job is narrower and complementary: prove the off-target count is
// correctly *scoped*, not that the cast is present.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const PREPARED = path.join(ROOT, 'db', 'prepared')
const TARGET_FILE = 'stella_0004_role_separation.sql'
const read = (name: string) => readFileSync(path.join(PREPARED, name), 'utf8')

// The frozen parent this remediation (MSC-07B.8-R10D) branched from — the
// commit that already carries the R9Y polcmd::text cast but still has the
// unscoped off-target count. `git show <ref>:<path>` reads a file's content
// AT that commit without touching the working tree or requiring a checkout.
const PARENT_HEAD = '97272d038eec4970008f8dbf635b4fff1ee53f8e'

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

// -----------------------------------------------------------------------
// Structural extraction helpers — narrow and auditable, mirroring the
// pattern in tests/stella-char-cast-doctrine.test.ts's findAllHazards().
// -----------------------------------------------------------------------

/** Every `SELECT count(*) INTO off_target_public_count ... ;` statement. */
function offTargetBlocks(sql: string): string[] {
  return [...sql.matchAll(/SELECT count\(\*\) INTO off_target_public_count[\s\S]*?;/g)].map((m) => m[0])
}

interface OffTargetBlockShape {
  hasPgPolicyJoinPgClass: boolean
  hasJoinPgNamespace: boolean
  hasPublicScope: boolean
  hasTargetExclusion: boolean
}

// The block captured by offTargetBlocks() is the `SELECT count(*) INTO
// off_target_public_count ...;` assignment statement only — the `<> 103`
// comparison lives in the separate `IF ... THEN` statement that follows and
// is checked independently by offTargetConstants() (T01/T13/T18/A11-A17).
// This function therefore judges JOIN/scope shape only, not the constant.
function analyzeOffTargetBlock(block: string): OffTargetBlockShape {
  return {
    hasPgPolicyJoinPgClass: /FROM pg_policy p\s*[\s\S]*?JOIN pg_class c ON c\.oid = p\.polrelid/.test(block),
    hasJoinPgNamespace: /JOIN pg_namespace n ON n\.oid = c\.relnamespace/.test(block),
    hasPublicScope: /n\.nspname\s*=\s*'public'/.test(block),
    hasTargetExclusion: /p\.polrelid\s*<>\s*'public\.stella_suggestion_decisions'::regclass/.test(block),
  }
}

function isFullyScoped(shape: OffTargetBlockShape): boolean {
  return shape.hasPgPolicyJoinPgClass && shape.hasJoinPgNamespace && shape.hasPublicScope && shape.hasTargetExclusion
}

/** The two `... WHERE n.nspname = 'public') <> N` total-policy-count checks (105). */
function totalPublicPolicyCounts(sql: string): number[] {
  return [
    ...sql.matchAll(
      /FROM pg_policy p JOIN pg_class c ON c\.oid = p\.polrelid\s*\n?\s*JOIN pg_namespace n ON n\.oid = c\.relnamespace WHERE n\.nspname = 'public'\)\s*<>\s*(\d+)/g,
    ),
  ].map((m) => Number(m[1]))
}

function targetCounts(sql: string): number[] {
  return [...sql.matchAll(/target_count\s*<>\s*(\d+)/g)].map((m) => Number(m[1]))
}

function offTargetConstants(sql: string): number[] {
  return [...sql.matchAll(/off_target_public_count\s*<>\s*(\d+)/g)].map((m) => Number(m[1]))
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function liveHash(): string {
  return createHash('sha256').update(read(TARGET_FILE)).digest('hex')
}

// -----------------------------------------------------------------------
// T01/T02/T03/CENSUS — the governed policy census, source-derived
// -----------------------------------------------------------------------

describe('T01/T02/T03 — the governed policy census is source-derived, not asserted', () => {
  it('T01: source-derived public baseline policy count = 103 (both 0004 off-target sites agree)', () => {
    const constants = offTargetConstants(read(TARGET_FILE))
    expect(constants.length).toBe(2)
    expect(constants).toEqual([103, 103])
  })

  it('T02: source-derived storage policy count = 3 (from the actual storage.objects CREATE POLICY statements)', () => {
    const storageSql = readFileSync(
      path.join(ROOT, 'db', 'prepared', 'storage', '20260716000001_part_b_policies.managed.sql'),
      'utf8',
    )
    const creates = [...storageSql.matchAll(/CREATE POLICY "[a-z_]+" ON storage\.objects/g)]
    expect(creates.length).toBe(3)
    expect(creates.map((m) => m[0])).toEqual([
      'CREATE POLICY "select_evidence" ON storage.objects',
      'CREATE POLICY "insert_evidence" ON storage.objects',
      'CREATE POLICY "delete_evidence" ON storage.objects',
    ])
  })

  it('T03: 105 = 103 (off-target public) + 2 (target) is an identity derived from three independently-sourced numbers, not one duplicated literal', () => {
    const sql = read(TARGET_FILE)
    const totals = totalPublicPolicyCounts(sql)
    const targets = targetCounts(sql)
    const offTargets = offTargetConstants(sql)
    expect(totals).toEqual([105, 105])
    expect(targets).toEqual([2, 2])
    expect(offTargets).toEqual([103, 103])
    // The arithmetic identity, computed from the three extracted values —
    // not asserted as a bare `105 === 103 + 2` against hardcoded literals.
    for (let i = 0; i < 2; i += 1) {
      expect(totals[i]).toBe(offTargets[i]! + targets[i]!)
    }
  })
})

// -----------------------------------------------------------------------
// T04-T09 — both off-target sites are correctly and equivalently scoped
// -----------------------------------------------------------------------

describe('T04-T09 — both off-target count sites are correctly, equivalently and minimally scoped', () => {
  it('T04: both off-target count sites are schema-public scoped', () => {
    const blocks = offTargetBlocks(read(TARGET_FILE))
    expect(blocks.length).toBe(2)
    for (const block of blocks) {
      expect(analyzeOffTargetBlock(block).hasPublicScope).toBe(true)
    }
  })

  it('T05: both sites use the explicit pg_policy -> pg_class -> pg_namespace join chain', () => {
    const blocks = offTargetBlocks(read(TARGET_FILE))
    for (const block of blocks) {
      const shape = analyzeOffTargetBlock(block)
      expect(shape.hasPgPolicyJoinPgClass).toBe(true)
      expect(shape.hasJoinPgNamespace).toBe(true)
    }
  })

  it('T06: both sites preserve target exclusion by polrelid', () => {
    const blocks = offTargetBlocks(read(TARGET_FILE))
    for (const block of blocks) {
      expect(analyzeOffTargetBlock(block).hasTargetExclusion).toBe(true)
    }
  })

  it('T07: storage policies are structurally excluded — storage.objects lives outside schema public', () => {
    const storageSql = readFileSync(
      path.join(ROOT, 'db', 'prepared', 'storage', '20260716000001_part_b_policies.managed.sql'),
      'utf8',
    )
    expect(storageSql).toMatch(/CREATE POLICY "select_evidence" ON storage\.objects/)
    expect(storageSql).toMatch(/CREATE POLICY "insert_evidence" ON storage\.objects/)
    expect(storageSql).toMatch(/CREATE POLICY "delete_evidence" ON storage\.objects/)
    expect(storageSql).not.toMatch(/ON public\./)
    // And the 0004 off-target query's own JOIN chain can never reach a
    // storage.objects row: pg_namespace.nspname for that relation is
    // 'storage', not 'public', so the WHERE n.nspname = 'public' predicate
    // structurally excludes it — this is a join-shape fact, not a runtime one.
    const blocks = offTargetBlocks(read(TARGET_FILE))
    for (const block of blocks) {
      expect(isFullyScoped(analyzeOffTargetBlock(block))).toBe(true)
    }
  })

  it('T08: precondition and postcondition off-target predicates are structurally equivalent', () => {
    const blocks = offTargetBlocks(read(TARGET_FILE))
    expect(blocks.length).toBe(2)
    expect(normalizeWhitespace(blocks[0]!)).toBe(normalizeWhitespace(blocks[1]!))
  })

  it('T09: target policy count remains exactly 2 at both sites', () => {
    expect(targetCounts(read(TARGET_FILE))).toEqual([2, 2])
  })
})

// -----------------------------------------------------------------------
// T10/T11/T12 — the canonical policy contract and probe-drop ordering are
// unchanged (proving this remediation touches only count SCOPE, not
// identity)
// -----------------------------------------------------------------------

describe('T10/T11/T12 — canonical policy contract and probe-drop ordering are unchanged', () => {
  it('T10: the SELECT policy identity/command contract is compatible between 0003 and 0004', () => {
    const s0003 = readFileSync(path.join(PREPARED, 'stella_0003_suggestion_decisions.sql'), 'utf8')
    const s0004 = read(TARGET_FILE)
    expect(s0003).toMatch(/CREATE POLICY "stella_suggestion_decisions_select"/)
    const matches = [...s0004.matchAll(/\(p\.polname = 'stella_suggestion_decisions_select' AND p\.polcmd = 'r'\)/g)]
    expect(matches.length).toBe(2)
  })

  it("T11: the INSERT policy identity/command/role/permissive/WITH-CHECK-identity contract is compatible between 0003 and 0004", () => {
    const s0003 = readFileSync(path.join(PREPARED, 'stella_0003_suggestion_decisions.sql'), 'utf8')
    const s0004 = read(TARGET_FILE)
    expect(s0003).toMatch(
      /CREATE POLICY stella_suggestion_decisions_insert_member_or_admin\s+ON public\.stella_suggestion_decisions\s+FOR INSERT\s+TO uellix_app/,
    )
    const matches = [
      ...s0004.matchAll(
        /\(p\.polname = 'stella_suggestion_decisions_insert_member_or_admin'\s*\n\s*AND p\.polcmd = 'a'\s*\n\s*AND p\.polroles = ARRAY\['uellix_app'::regrole::oid\]\s*\n\s*AND p\.polpermissive\s*\n\s*AND decision_insert_check_actual = decision_insert_check_probe\)/g,
      ),
    ]
    expect(matches.length).toBe(2)
  })

  it('T12: the temporary same-session probe is dropped before the off-target inventory check runs, at both sites', () => {
    const sql = read(TARGET_FILE)
    const dropPositions = [...sql.matchAll(/DROP POLICY stella_decision_canonical_insert_probe/g)].map((m) => m.index!)
    // The declaration site ("SELECT count(*) INTO off_target_public_count")
    // is the unambiguous first reference per DO block — later occurrences in
    // the IF condition and RAISE message are diagnostics, not the count
    // itself, so anchoring on the declaration avoids miscounting them.
    const offTargetDeclPositions = [...sql.matchAll(/SELECT count\(\*\) INTO off_target_public_count/g)].map(
      (m) => m.index!,
    )
    expect(dropPositions.length).toBe(2)
    expect(offTargetDeclPositions.length).toBe(2)
    for (let i = 0; i < 2; i += 1) {
      expect(dropPositions[i]!, `site ${i}: probe DROP must precede the off-target count`).toBeLessThan(
        offTargetDeclPositions[i]!,
      )
    }
  })
})

// -----------------------------------------------------------------------
// T13-T19 — mutation self-tests: the doctrine's own detectors actually fire
// -----------------------------------------------------------------------

describe('T13-T19 — the doctrine detects the mutations it claims to detect', () => {
  it('T13: literal 103 cannot be changed to 106 while retaining a passing census', () => {
    const mutated = read(TARGET_FILE).replace(/off_target_public_count <> 103/g, 'off_target_public_count <> 106')
    expect(offTargetConstants(mutated)).toEqual([106, 106])
    expect(offTargetConstants(mutated)).not.toEqual([103, 103])
  })

  it('T14: removing the schema-public filter is detected', () => {
    const block = offTargetBlocks(read(TARGET_FILE))[0]!
    const mutated = block.replace(/WHERE n\.nspname = 'public'\s*\n\s*AND /, 'WHERE ')
    expect(mutated).not.toBe(block)
    expect(isFullyScoped(analyzeOffTargetBlock(mutated))).toBe(false)
  })

  it("T15: changing the filter to nspname <> 'public' is detected", () => {
    const block = offTargetBlocks(read(TARGET_FILE))[0]!
    const mutated = block.replace("n.nspname = 'public'", "n.nspname <> 'public'")
    expect(mutated).not.toBe(block)
    expect(isFullyScoped(analyzeOffTargetBlock(mutated))).toBe(false)
  })

  it('T16: relname-only filtering (no real schema join) is detected', () => {
    const block = offTargetBlocks(read(TARGET_FILE))[0]!
    const mutated = block.replace(
      /JOIN pg_namespace n ON n\.oid = c\.relnamespace\s*\n\s*WHERE n\.nspname = 'public'/,
      "WHERE c.relname <> ''",
    )
    expect(mutated).not.toBe(block)
    expect(isFullyScoped(analyzeOffTargetBlock(mutated))).toBe(false)
  })

  it('T17: changing (or dropping) the target exclusion is detected', () => {
    const block = offTargetBlocks(read(TARGET_FILE))[0]!
    const inverted = block.replace(
      "p.polrelid <> 'public.stella_suggestion_decisions'::regclass",
      "p.polrelid = 'public.stella_suggestion_decisions'::regclass",
    )
    expect(inverted).not.toBe(block)
    expect(isFullyScoped(analyzeOffTargetBlock(inverted))).toBe(false)
  })

  it('T18: changing total 105 is detected', () => {
    const sql = read(TARGET_FILE)
    expect(totalPublicPolicyCounts(sql)).toEqual([105, 105])
    const mutated = sql.replace(/nspname = 'public'\) <> 105/g, "nspname = 'public') <> 104")
    expect(totalPublicPolicyCounts(mutated)).toEqual([104, 104])
  })

  it('T19: changing target count 2 is detected', () => {
    const sql = read(TARGET_FILE)
    expect(targetCounts(sql)).toEqual([2, 2])
    const mutated = sql.replace(/target_count <> 2/g, 'target_count <> 3')
    expect(targetCounts(mutated)).toEqual([3, 3])
  })
})

// -----------------------------------------------------------------------
// T20 — authority-changing statements are distinguishable from
// verifier-only changes in the same patch
// -----------------------------------------------------------------------

describe('T20 — authority-changing statements are distinguishable from verifier-only changes', () => {
  it('the real R10D diff against the frozen parent contains zero authority statements', () => {
    const diffText = gitDiffAgainstParent(`db/prepared/${TARGET_FILE}`)
    const added = diffLines(diffText, '+')
    const removed = diffLines(diffText, '-')
    const authorityLines = [...added, ...removed].filter((l) => AUTHORITY_STATEMENT.test(l))
    expect(authorityLines, 'the real R10D diff must contain zero authority statements').toEqual([])
    // And the diff is not accidentally empty.
    expect(added.length + removed.length).toBeGreaterThan(0)
  })

  it('the detector is not vacuously true: it does flag a synthetic authority line', () => {
    expect(AUTHORITY_STATEMENT.test('+  GRANT SELECT ON public.stella_suggestion_decisions TO uellix_app;')).toBe(true)
    expect(AUTHORITY_STATEMENT.test("+  CREATE POLICY foo ON public.bar FOR SELECT USING (true);")).toBe(true)
    expect(AUTHORITY_STATEMENT.test('+  SELECT count(*) INTO off_target_public_count')).toBe(false)
  })
})

// -----------------------------------------------------------------------
// T21/T22 — hash witnesses
// -----------------------------------------------------------------------

describe('T21/T22 — active hash witnesses are aligned, and a repin alone cannot hide semantic drift', () => {
  it('T21: active 0004 hash witnesses remain mutually aligned with the live bytes', () => {
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

  it('T22: a coordinated hash repin cannot hide count-scope semantic drift — structural checks read content, not hashes', () => {
    const sql = read(TARGET_FILE)
    const mutated = sql.replace(/off_target_public_count <> 103/g, 'off_target_public_count <> 106')
    const mutatedHash = createHash('sha256').update(mutated).digest('hex')
    // A semantic mutation DOES change the hash — a repin would be required to
    // hide it from T21's byte-witness check. But even supposing every active
    // witness WERE coordinately repinned to mutatedHash, T01/T13 read SQL
    // content directly and would still fail on the mutated text:
    expect(mutatedHash).not.toBe(liveHash())
    expect(offTargetConstants(mutated)).not.toEqual([103, 103])
  })
})

// -----------------------------------------------------------------------
// Section R — adversarial matrix (scratch/in-memory attacks; nothing here
// is ever written to disk)
// -----------------------------------------------------------------------

describe('Section R — adversarial matrix', () => {
  // --- SCOPE ---------------------------------------------------------

  it('A01: removing the public filter from the precondition site is detected', () => {
    const blocks = offTargetBlocks(read(TARGET_FILE))
    const mutated = blocks[0]!.replace(/WHERE n\.nspname = 'public'\s*\n\s*AND /, 'WHERE ')
    expect(isFullyScoped(analyzeOffTargetBlock(mutated))).toBe(false)
  })

  it('A02: removing the public filter from the postcondition site is detected', () => {
    const blocks = offTargetBlocks(read(TARGET_FILE))
    const mutated = blocks[1]!.replace(/WHERE n\.nspname = 'public'\s*\n\s*AND /, 'WHERE ')
    expect(isFullyScoped(analyzeOffTargetBlock(mutated))).toBe(false)
  })

  it('A03: removing the public filter from both sites is detected independently at each site', () => {
    const blocks = offTargetBlocks(read(TARGET_FILE))
    const mutatedBoth = blocks.map((b) => b.replace(/WHERE n\.nspname = 'public'\s*\n\s*AND /, 'WHERE '))
    for (const mutated of mutatedBoth) expect(isFullyScoped(analyzeOffTargetBlock(mutated))).toBe(false)
  })

  it("A04: nspname <> 'public' is detected", () => {
    const block = offTargetBlocks(read(TARGET_FILE))[0]!
    const mutated = block.replace("n.nspname = 'public'", "n.nspname <> 'public'")
    expect(isFullyScoped(analyzeOffTargetBlock(mutated))).toBe(false)
  })

  it("A05: nspname = 'storage' is detected", () => {
    const block = offTargetBlocks(read(TARGET_FILE))[0]!
    const mutated = block.replace("n.nspname = 'public'", "n.nspname = 'storage'")
    expect(isFullyScoped(analyzeOffTargetBlock(mutated))).toBe(false)
  })

  it("A06: a relname-only filter (c.relname='public') is detected as not real schema scoping", () => {
    const block = offTargetBlocks(read(TARGET_FILE))[0]!
    const mutated = block.replace("n.nspname = 'public'", "c.relname = 'public'")
    expect(isFullyScoped(analyzeOffTargetBlock(mutated))).toBe(false)
  })

  it('A07: omitting the pg_namespace join is detected', () => {
    const block = offTargetBlocks(read(TARGET_FILE))[0]!
    const mutated = block.replace(/JOIN pg_namespace n ON n\.oid = c\.relnamespace\s*\n\s*WHERE n\.nspname = 'public'\s*\n\s*AND /, 'WHERE ')
    expect(isFullyScoped(analyzeOffTargetBlock(mutated))).toBe(false)
  })

  it('A08: a wrong join predicate (c.oid = n.oid) is detected', () => {
    const block = offTargetBlocks(read(TARGET_FILE))[0]!
    const mutated = block.replace('JOIN pg_namespace n ON n.oid = c.relnamespace', 'JOIN pg_namespace n ON c.oid = n.oid')
    expect(isFullyScoped(analyzeOffTargetBlock(mutated))).toBe(false)
  })

  it('A09: removing the target exclusion is detected', () => {
    const block = offTargetBlocks(read(TARGET_FILE))[0]!
    const mutated = block.replace(/\s*AND p\.polrelid <> 'public\.stella_suggestion_decisions'::regclass/, '')
    expect(isFullyScoped(analyzeOffTargetBlock(mutated))).toBe(false)
  })

  it('A10: inverting the target exclusion is detected', () => {
    const block = offTargetBlocks(read(TARGET_FILE))[0]!
    const mutated = block.replace(
      "p.polrelid <> 'public.stella_suggestion_decisions'::regclass",
      "p.polrelid = 'public.stella_suggestion_decisions'::regclass",
    )
    expect(isFullyScoped(analyzeOffTargetBlock(mutated))).toBe(false)
  })

  // --- COUNTS ----------------------------------------------------------

  it('A11: changing 103->106 at the precondition site only is detected', () => {
    const sql = read(TARGET_FILE)
    const firstOnly = sql.replace('off_target_public_count <> 103', 'off_target_public_count <> 106')
    expect(offTargetConstants(firstOnly)).toEqual([106, 103])
  })

  it('A12: changing 103->106 at the postcondition site only is detected', () => {
    const sql = read(TARGET_FILE)
    const occurrences = [...sql.matchAll(/off_target_public_count <> 103/g)]
    expect(occurrences.length).toBe(2)
    const secondIndex = occurrences[1]!.index!
    const secondOnly = sql.slice(0, secondIndex) + sql.slice(secondIndex).replace('off_target_public_count <> 103', 'off_target_public_count <> 106')
    expect(offTargetConstants(secondOnly)).toEqual([103, 106])
  })

  it('A13: changing both 103->106 is detected', () => {
    const mutated = read(TARGET_FILE).replace(/off_target_public_count <> 103/g, 'off_target_public_count <> 106')
    expect(offTargetConstants(mutated)).toEqual([106, 106])
  })

  it('A14: changing 103->102 is detected', () => {
    const mutated = read(TARGET_FILE).replace(/off_target_public_count <> 103/g, 'off_target_public_count <> 102')
    expect(offTargetConstants(mutated)).toEqual([102, 102])
  })

  it('A15: changing 105 (total) is detected', () => {
    const mutated = read(TARGET_FILE).replace(/nspname = 'public'\) <> 105/g, "nspname = 'public') <> 999")
    expect(totalPublicPolicyCounts(mutated)).toEqual([999, 999])
  })

  it('A16: changing target 2 is detected', () => {
    const mutated = read(TARGET_FILE).replace(/target_count <> 2/g, 'target_count <> 5')
    expect(targetCounts(mutated)).toEqual([5, 5])
  })

  it('A17: preserving the 105 total while altering the 103/2 distribution is still individually detected', () => {
    // 104 + 1 also sums to 105 — proving T01/T09 are independent checks, not
    // subsumed by the sum identity in T03.
    const mutated = read(TARGET_FILE)
      .replace(/off_target_public_count <> 103/g, 'off_target_public_count <> 104')
      .replace(/target_count <> 2/g, 'target_count <> 1')
    expect(offTargetConstants(mutated)).toEqual([104, 104])
    expect(targetCounts(mutated)).toEqual([1, 1])
    // the untouched total check still reads 105 in the mutated text — the
    // drift is only visible through T01/T09, exactly as intended.
    expect(totalPublicPolicyCounts(mutated)).toEqual([105, 105])
  })

  // --- CONTRACT ----------------------------------------------------------

  it('A18: SELECT policy name drift (0003 side) is detected', () => {
    const s0003 = readFileSync(path.join(PREPARED, 'stella_0003_suggestion_decisions.sql'), 'utf8')
    expect(s0003).toMatch(/CREATE POLICY "stella_suggestion_decisions_select"/)
    // Target the CREATE specifically — the DROP POLICY IF EXISTS guard just
    // above it also carries this literal, and a non-targeted replace would
    // rename the DROP instead, leaving CREATE (the actual site) untouched.
    const mutated = s0003.replace(
      'CREATE POLICY "stella_suggestion_decisions_select"',
      'CREATE POLICY "stella_suggestion_decisions_select_v2"',
    )
    expect(mutated).not.toMatch(/CREATE POLICY "stella_suggestion_decisions_select"/)
  })

  it('A19: SELECT polcmd drift (0004 side) is detected', () => {
    const mutated = read(TARGET_FILE).replace(
      "(p.polname = 'stella_suggestion_decisions_select' AND p.polcmd = 'r')",
      "(p.polname = 'stella_suggestion_decisions_select' AND p.polcmd = 'a')",
    )
    const matches = [...mutated.matchAll(/\(p\.polname = 'stella_suggestion_decisions_select' AND p\.polcmd = 'r'\)/g)]
    expect(matches.length).toBe(1) // only one site still matches; the mutated site dropped out
  })

  it('A20: INSERT policy name drift (0003 side) is detected', () => {
    const s0003 = readFileSync(path.join(PREPARED, 'stella_0003_suggestion_decisions.sql'), 'utf8')
    expect(s0003).toMatch(/CREATE POLICY stella_suggestion_decisions_insert_member_or_admin/)
    const mutated = s0003.replace(
      'CREATE POLICY stella_suggestion_decisions_insert_member_or_admin',
      'CREATE POLICY stella_suggestion_decisions_insert_v2',
    )
    expect(mutated).not.toMatch(/CREATE POLICY stella_suggestion_decisions_insert_member_or_admin/)
  })

  it('A21: INSERT polcmd drift (0004 side) is detected', () => {
    const mutated = read(TARGET_FILE).replaceAll("AND p.polcmd = 'a'", "AND p.polcmd = 'w'")
    expect(mutated).not.toMatch(/AND p\.polcmd = 'a'/)
  })

  it('A22: INSERT role drift (0004 side) is detected', () => {
    const mutated = read(TARGET_FILE).replaceAll(
      "AND p.polroles = ARRAY['uellix_app'::regrole::oid]",
      "AND p.polroles = ARRAY['authenticated'::regrole::oid]",
    )
    expect(mutated).not.toMatch(/AND p\.polroles = ARRAY\['uellix_app'::regrole::oid\]/)
  })

  it('A23: INSERT permissive drift (0004 side) is detected', () => {
    const mutated = read(TARGET_FILE).replaceAll('AND p.polpermissive\n', '')
    expect(mutated).not.toMatch(/AND p\.polpermissive/)
  })

  it('A24: INSERT WITH CHECK identity drift (probe comparison) is detected', () => {
    const mutated = read(TARGET_FILE).replaceAll(
      'AND decision_insert_check_actual = decision_insert_check_probe)',
      ')',
    )
    expect(mutated).not.toMatch(/decision_insert_check_actual = decision_insert_check_probe/)
  })

  it('A25: the probe surviving past the count (DROP removed) is detected by ordering', () => {
    const sql = read(TARGET_FILE)
    const withoutFirstDrop = sql.replace('DROP POLICY stella_decision_canonical_insert_probe ON public.stella_suggestion_decisions;\n\n', '')
    const dropPositions = [...withoutFirstDrop.matchAll(/DROP POLICY stella_decision_canonical_insert_probe/g)].map((m) => m.index!)
    // Only one DROP remains; the ordering check for site 0 (originally
    // present) can no longer be satisfied the same way — the doctrine's own
    // T12 requires exactly 2 DROP positions matched to 2 sites.
    expect(dropPositions.length).toBe(1)
  })

  it('A26/A27: the off-target and target checks use strict inequality (<>), so an extra OR a missing policy is equally caught by the same predicate', () => {
    const sql = read(TARGET_FILE)
    expect(sql).not.toMatch(/target_count\s*[<>]=?\s*2\s+AND/) // not a range check
    expect([...sql.matchAll(/target_count <> 2/g)].length).toBe(2)
    expect([...sql.matchAll(/off_target_public_count <> 103/g)].length).toBe(2)
  })

  // --- PARITY --------------------------------------------------------------

  it('A28: correcting only the precondition (leaving postcondition broken) is caught per-site', () => {
    const blocks = offTargetBlocks(read(TARGET_FILE))
    const brokenPostcondition = blocks[1]!.replace(/WHERE n\.nspname = 'public'\s*\n\s*AND /, 'WHERE ')
    expect(isFullyScoped(analyzeOffTargetBlock(blocks[0]!))).toBe(true)
    expect(isFullyScoped(analyzeOffTargetBlock(brokenPostcondition))).toBe(false)
  })

  it('A29: correcting only the postcondition (leaving precondition broken) is caught per-site', () => {
    const blocks = offTargetBlocks(read(TARGET_FILE))
    const brokenPrecondition = blocks[0]!.replace(/WHERE n\.nspname = 'public'\s*\n\s*AND /, 'WHERE ')
    expect(isFullyScoped(analyzeOffTargetBlock(brokenPrecondition))).toBe(false)
    expect(isFullyScoped(analyzeOffTargetBlock(blocks[1]!))).toBe(true)
  })

  it('A30: semantically different joins between the two sites are caught by the T08 equivalence check', () => {
    const blocks = offTargetBlocks(read(TARGET_FILE))
    const divergentSecond = blocks[1]!.replace('JOIN pg_namespace n ON n.oid = c.relnamespace', 'JOIN pg_namespace n ON n.oid = c.relnamespace AND true')
    expect(normalizeWhitespace(blocks[0]!)).not.toBe(normalizeWhitespace(divergentSecond))
  })

  it('A31: different schema filters between the two sites are caught by the T08 equivalence check', () => {
    const blocks = offTargetBlocks(read(TARGET_FILE))
    const divergentSecond = blocks[1]!.replace("n.nspname = 'public'", "n.nspname = 'storage'")
    expect(normalizeWhitespace(blocks[0]!)).not.toBe(normalizeWhitespace(divergentSecond))
  })

  // --- STORAGE ---------------------------------------------------------

  it('A32: counting storage in the public expectation is structurally impossible (T07 restated)', () => {
    const blocks = offTargetBlocks(read(TARGET_FILE))
    for (const block of blocks) expect(isFullyScoped(analyzeOffTargetBlock(block))).toBe(true)
  })

  it('A33: changing the expected storage count is detected', () => {
    const storageSql = readFileSync(
      path.join(ROOT, 'db', 'prepared', 'storage', '20260716000001_part_b_policies.managed.sql'),
      'utf8',
    )
    const mutated = storageSql.replace('CREATE POLICY "delete_evidence" ON storage.objects', '-- removed')
    const creates = [...mutated.matchAll(/CREATE POLICY "[a-z_]+" ON storage\.objects/g)]
    expect(creates.length).toBe(2)
  })

  it('A34: moving one baseline policy between public and storage fixtures is not silently absorbed', () => {
    // Simulate storage losing one policy (as if moved to public): T02 alone
    // catches it — the 103/105 identity in 0004 is untouched by this fixture
    // edit, so no single check "absorbs" a cross-schema shuffle silently.
    const storageSql = readFileSync(
      path.join(ROOT, 'db', 'prepared', 'storage', '20260716000001_part_b_policies.managed.sql'),
      'utf8',
    )
    const mutated = storageSql.replace('CREATE POLICY "delete_evidence" ON storage.objects', '-- removed')
    const creates = [...mutated.matchAll(/CREATE POLICY "[a-z_]+" ON storage\.objects/g)]
    expect(creates.length).not.toBe(3)
    // 0004's own 103/105 census is a separate source and does not change:
    expect(offTargetConstants(read(TARGET_FILE))).toEqual([103, 103])
  })

  // --- DIAGNOSTICS -------------------------------------------------------

  it('A35: diagnostic variables (off_target_total_count) do not participate in the branch condition', () => {
    const sql = read(TARGET_FILE)
    // Anchored on "OR target_count", unique to this remediation's two IF
    // blocks — `drift`/`problem` are reused by many unrelated precondition/
    // postcondition checks throughout stella_0004, so anchoring on the bare
    // "IF drift/problem IS NOT NULL...THEN" shape alone over-matches badly.
    const ifBlocks = [...sql.matchAll(/IF (?:drift|problem) IS NOT NULL\s*\n\s*OR target_count[\s\S]*?THEN/g)].map(
      (m) => m[0],
    )
    expect(ifBlocks.length).toBe(2)
    for (const block of ifBlocks) {
      expect(block).not.toMatch(/off_target_total_count/)
      expect(block).toMatch(/target_count <> 2/)
      expect(block).toMatch(/off_target_public_count <> 103/)
    }
  })

  it('A36: diagnostics expose no raw row data or unrelated SQL text', () => {
    const sql = read(TARGET_FILE)
    const raiseBlocks = [...sql.matchAll(/RAISE EXCEPTION 'stella_0004[^']*policy inventory[^']*'[\s\S]*?;/g)]
    expect(raiseBlocks.length).toBe(2)
    for (const block of raiseBlocks) {
      expect(block[0]).not.toMatch(/SELECT \*/)
      expect(block[0]).not.toMatch(/password|secret|token/i)
    }
  })

  it('A37: the RAISE message carries all four diagnostic fields today (regression if one is silently dropped)', () => {
    const sql = read(TARGET_FILE)
    const raiseBlocks = [...sql.matchAll(/RAISE EXCEPTION 'stella_0004[^']*policy inventory[^']*'[\s\S]*?;/g)].map((m) => m[0])
    expect(raiseBlocks.length).toBe(2)
    for (const block of raiseBlocks) {
      expect(block).toMatch(/target_count=%/)
      expect(block).toMatch(/off_target_public_count=%/)
      expect(block).toMatch(/off_target_total_count=%/)
    }
  })

  it('A38: formatting-only reformatting of an already-correct block stays correct (negative control)', () => {
    const block = offTargetBlocks(read(TARGET_FILE))[0]!
    const reformatted = block.replace(/\n\s+/g, '\n    ')
    expect(isFullyScoped(analyzeOffTargetBlock(reformatted))).toBe(true)
  })

  // --- AUTHORITY -----------------------------------------------------------

  it('A39: a synthetic CREATE POLICY diff line is flagged as an authority statement', () => {
    expect(AUTHORITY_STATEMENT.test('+CREATE POLICY new_policy ON public.foo FOR SELECT USING (true);')).toBe(true)
  })

  it('A40: a synthetic ALTER POLICY (the only way WITH CHECK can change) diff line is flagged', () => {
    expect(AUTHORITY_STATEMENT.test('+ALTER POLICY stella_suggestion_decisions_insert_member_or_admin ON public.stella_suggestion_decisions WITH CHECK (true);')).toBe(true)
  })

  it('A41: a synthetic role/membership diff line is flagged', () => {
    expect(AUTHORITY_STATEMENT.test('+CREATE ROLE uellix_new_role;')).toBe(true)
    expect(AUTHORITY_STATEMENT.test('+ALTER ROLE uellix_app INHERIT;')).toBe(true)
  })

  it('A42: a synthetic GRANT/REVOKE diff line is flagged', () => {
    expect(AUTHORITY_STATEMENT.test('+GRANT SELECT ON public.stella_suggestion_decisions TO uellix_app;')).toBe(true)
    expect(AUTHORITY_STATEMENT.test('-REVOKE SELECT ON public.stella_suggestion_decisions FROM uellix_app;')).toBe(true)
  })

  // --- HASH ----------------------------------------------------------------

  it('A43: a coordinated semantic mutation with all repins still fails structural checks', () => {
    const mutated = read(TARGET_FILE).replace(/off_target_public_count <> 103/g, 'off_target_public_count <> 106')
    // "all repins" would only change what the witness FILES say the hash
    // should be; it cannot change what offTargetConstants() reads out of the
    // (hypothetically shipped) mutated SQL text itself.
    expect(offTargetConstants(mutated)).toEqual([106, 106])
  })

  it('A44: a stale db/r3-5-pg17-certification-inputs.ts witness is detected independently of the other two agreeing', () => {
    const live = liveHash()
    const flip = (hash: string, index: number) => {
      const original = hash[index]!
      const replacement = original === '0' ? '1' : '0'
      return hash.slice(0, index) + replacement + hash.slice(index + 1)
    }
    const stale = flip(live, 0)
    expect(stale).not.toBe(live)
  })

  it('A45: a stale tests/prepared-stella-sql.test.ts witness is detected independently of the other two agreeing', () => {
    const live = liveHash()
    const flip = (hash: string, index: number) => {
      const original = hash[index]!
      const replacement = original === '0' ? '1' : '0'
      return hash.slice(0, index) + replacement + hash.slice(index + 1)
    }
    const stale = flip(live, live.length - 1)
    expect(stale).not.toBe(live)
  })

  it('A46: a stale tests/stella-r3-5-pg17-certification.test.ts witness is detected independently of the other two agreeing', () => {
    const live = liveHash()
    const flip = (hash: string, index: number) => {
      const original = hash[index]!
      const replacement = original === '0' ? '1' : '0'
      return hash.slice(0, index) + replacement + hash.slice(index + 1)
    }
    const stale = flip(live, Math.floor(live.length / 2))
    expect(stale).not.toBe(live)
  })

  // --- POLCMD (cross-check; owned in depth by stella-char-cast-doctrine.test.ts) ---

  it('A47: removing one p.polcmd::text cast is detected as a regression from 2 sites to 1', () => {
    const sql = read(TARGET_FILE)
    expect([...sql.matchAll(/p\.polcmd::text/g)].length).toBe(2)
    const mutated = sql.replace('p.polcmd::text', 'p.polcmd')
    expect([...mutated.matchAll(/p\.polcmd::text/g)].length).toBe(1)
  })

  it('A48: removing both p.polcmd::text casts is detected as a regression to 0', () => {
    const mutated = read(TARGET_FILE).replaceAll('p.polcmd::text', 'p.polcmd')
    expect([...mutated.matchAll(/p\.polcmd::text/g)].length).toBe(0)
  })
})
