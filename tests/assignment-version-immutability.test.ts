// tests/assignment-version-immutability.test.ts
// W2-B2-R1 / R-B2-05 — the durable negative control AG-B2-1's
// lineitem_provenance_disposition is CONDITIONAL ON: the decision to rely on
// sroi_line_items.assignment_id -> outcome_proxy_assignments
// .financial_proxy_version_id (FIBDB-039, "immutable per run") instead of a
// new denormalised column is valid ONLY while no code path updates that
// column. Immutability is upheld by convention, not by a constraint, so this
// test is the constraint: it fails the moment any UPDATE of
// outcome_proxy_assignments names financialProxyVersionId, anywhere under
// lib/ or app/.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SCAN_ROOTS = ['lib', 'app', 'db']

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue
      collect(full, out)
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** Every balanced `<fn>(` … `)` call block in `src`, joined with the chain that follows it up to the next statement end. */
function updateBlocks(src: string): string[] {
  const blocks: string[] = []
  let from = 0
  for (;;) {
    const start = src.indexOf('.update(', from)
    if (start < 0) break
    // Take the whole chained statement: from `.update(` to the next `;` or blank line.
    let end = src.indexOf('\n\n', start)
    const semi = src.indexOf(';', start)
    if (semi >= 0 && (end < 0 || semi < end)) end = semi
    if (end < 0) end = src.length
    blocks.push(src.slice(start, end))
    from = end + 1
  }
  return blocks
}

describe('outcome_proxy_assignments.financial_proxy_version_id is written once and never updated (FIBDB-039)', () => {
  const files = SCAN_ROOTS.flatMap((r) => collect(path.join(ROOT, r)))

  it('scans a non-trivial corpus', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('no UPDATE of outcomeProxyAssignments names financialProxyVersionId', () => {
    const offenders: string[] = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      if (!src.includes('outcomeProxyAssignments')) continue
      for (const block of updateBlocks(src)) {
        // The block must BE an update of outcome_proxy_assignments (its
        // target is the first argument), not merely a statement whose
        // trailing text happens to mention the table.
        if (/^\.update\(\s*outcomeProxyAssignments\s*\)/.test(block) && /financialProxyVersionId/.test(block)) {
          offenders.push(`${path.relative(ROOT, file)}: ${block.slice(0, 120).replace(/\s+/g, ' ')}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('no raw SQL updates financial_proxy_version_id on outcome_proxy_assignments (migrations included)', () => {
    const sqlFiles = collect(path.join(ROOT, 'db')).filter((f) => f.endsWith('.ts'))
    const migrations = readdirSync(path.join(ROOT, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).map((f) => path.join(ROOT, 'db', 'migrations', f))
    const offenders: string[] = []
    for (const file of [...sqlFiles, ...migrations]) {
      const src = readFileSync(file, 'utf8')
      if (/UPDATE\s+"?outcome_proxy_assignments"?[\s\S]{0,400}financial_proxy_version_id/i.test(src)) {
        offenders.push(path.relative(ROOT, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('the ONLY write of financialProxyVersionId on assignments is the INSERT in assignProxyToOutcome', () => {
    const src = readFileSync(path.join(ROOT, 'lib/pipeline/proxies.ts'), 'utf8')
    const writes = src.match(/financialProxyVersionId:\s*[^,\n]+/g) ?? []
    expect(writes).toHaveLength(1)
    const onlyWrite = writes[0] ?? ''
    expect(onlyWrite).toMatch(/financialProxyVersionId:\s*version\.id/)
    // and it lives inside the insert, not an update
    const insertStart = src.indexOf('db.insert(outcomeProxyAssignments)')
    const writeAt = src.indexOf(onlyWrite)
    expect(insertStart).toBeGreaterThan(0)
    expect(writeAt).toBeGreaterThan(insertStart)
  })

  it('MUTATION: the scanner would catch an update naming the column', () => {
    const fake = `await db.update(outcomeProxyAssignments).set({ financialProxyVersionId: 'x' }).where(eq(outcomeProxyAssignments.id, id));`
    const hit = updateBlocks(fake).some((b) => /^\.update\(\s*outcomeProxyAssignments\s*\)/.test(b) && /financialProxyVersionId/.test(b))
    expect(hit).toBe(true)
    // …and a different table's update that merely mentions the column later is NOT a hit.
    const other = `await db.update(projectInvestments).set({ x: 1 }).where(eq(projectInvestments.id, id))\n  // financialProxyVersionId mentioned in a comment nearby\n`
    expect(updateBlocks(other).some((b) => /^\.update\(\s*outcomeProxyAssignments\s*\)/.test(b))).toBe(false)
  })
})
