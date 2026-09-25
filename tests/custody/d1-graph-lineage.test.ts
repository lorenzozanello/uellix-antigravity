// @vitest-environment node
// tests/custody/d1-graph-lineage.test.ts
//
// NB-6: THE DAG LINEAGE IS DERIVED CLOSED-WORLD AND CHECKED AGAINST THE PINNED LIST.
//
// Before this, readChain read a fixed GRAPH_SOURCES list: a successor amendment
// written to disk but not registered would have been ignored without a word.
// Each case copies the release directory to a temporary root, changes one
// thing, and watches the derivation (and the chain PMR reads) fail closed.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { GRAPH_SOURCES, deriveGraphLineage } from '@/scripts/custody/d1-dag-validate'
import { readChain } from '@/scripts/custody/d1-pre-hc1-post-mint'

const ROOT = process.cwd()
const RELEASE = 'docs/ops/release'
const BASE = 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_v1.0.0.json'
const amendment = (v: string) => `FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_AMENDMENT_v${v}.json`

function copyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'd1-lineage-'))
  for (const d of [RELEASE, 'docs/ops/owner-ratifications']) cpSync(join(ROOT, d), join(root, d), { recursive: true })
  return root
}
const release = (root: string) => join(root, RELEASE)
// The next amendment is the one after the LAST registered source, whatever version that is:
// a fixed literal becomes the live amendment once the lineage grows past it.
const LAST = /_v(\d+)\.(\d+)\.(\d+)\.json$/.exec(GRAPH_SOURCES[GRAPH_SOURCES.length - 1]!)!
const NEXT = `${LAST[1]}.${LAST[2]}.${Number(LAST[3]) + 1}`
const AFTER_NEXT = `${LAST[1]}.${LAST[2]}.${Number(LAST[3]) + 2}`
const esc = (v: string) => v.replace(/\./g, '\\.')
const goodNext = { version: NEXT, amends: `${RELEASE}/${BASE}`, append_only: true }

describe('the lineage on disk', () => {
  it('is exactly the pinned GRAPH_SOURCES, in version order, with no error', () => {
    expect(deriveGraphLineage(join(ROOT, RELEASE))).toEqual({ sources: [...GRAPH_SOURCES], errors: [] })
    expect(readChain(ROOT).chainErrors).toEqual([])
  })
})

describe('NB-6 controls: every deviation is an error, never a silent skip', () => {
  const cases: Array<[string, (root: string) => void, RegExp]> = [
    ['an unregistered successor amendment', (r) => writeFileSync(join(release(r), amendment(NEXT)), JSON.stringify(goodNext)), /is not the pinned GRAPH_SOURCES/],
    ['a registered amendment missing', (r) => rmSync(join(release(r), amendment('1.0.4'))), /is not the pinned GRAPH_SOURCES/],
    ['a second file claiming an existing version', (r) => writeFileSync(join(release(r), 'FIBDB053_D1_AUDITOR_PROVISIONING_DAG_AUTHORITY_v1.0.3.json'), JSON.stringify({ version: '1.0.3' })), /appears more than once/],
    ['an amendment whose body declares another version', (r) => writeFileSync(join(release(r), amendment(NEXT)), JSON.stringify({ ...goodNext, version: AFTER_NEXT })), new RegExp(`declares version ${esc(AFTER_NEXT)}, not ${esc(NEXT)}`)],
    ['an amendment of another authority', (r) => writeFileSync(join(release(r), amendment(NEXT)), JSON.stringify({ ...goodNext, amends: `${RELEASE}/SOMETHING_ELSE.json` })), /does not amend the lineage base/],
    ['a lineage-named file that is not JSON', (r) => writeFileSync(join(release(r), amendment(NEXT)), 'not json'), /is not JSON/],
    ['the base missing', (r) => rmSync(join(release(r), BASE)), /lineage base .* is missing/],
  ]
  it.each(cases)('%s', (_name, change, why) => {
    const r = copyRoot()
    try {
      change(r)
      const d = deriveGraphLineage(release(r))
      expect(d.errors.join(' | ')).toMatch(why)
      // And the chain PRE-HC1 reads carries it, so N10 cannot be READY on that tree.
      expect(readChain(r).chainErrors.join(' | ')).toMatch(why)
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })
  it('an arbitrary JSON that does not claim the lineage name is not read at all', () => {
    const r = copyRoot()
    try {
      writeFileSync(join(release(r), `FIBDB053_D1_AUDITOR_SOMETHING_AMENDMENT_v${NEXT}.json`), JSON.stringify(goodNext))
      expect(deriveGraphLineage(release(r))).toEqual({ sources: [...GRAPH_SOURCES], errors: [] })
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })
  it('a partial read requested on purpose (a test pinning an older graph) is not reported as drift', () => {
    expect(readChain(ROOT, GRAPH_SOURCES.slice(0, 6)).chainErrors).toEqual([])
    expect(JSON.parse(readFileSync(join(ROOT, RELEASE, amendment('1.0.6')), 'utf8')).amends).toBe(`${RELEASE}/${BASE}`)
  })
})
