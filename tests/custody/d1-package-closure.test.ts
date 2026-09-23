// @vitest-environment node
// tests/custody/d1-package-closure.test.ts
//
// The execution package is DERIVED: a new imported module or a new authority
// artifact joins it without anyone editing a list, and a certification event
// never does.

import { describe, expect, it } from 'vitest'

import { CERTIFICATION_EVENT_PATTERN, EXECUTION_ENTRY_POINTS, closureDigest, deriveCodeClosure, derivePackageClosure } from '@/scripts/custody/d1-package-closure'
import { GRAPH_SOURCES } from '@/scripts/custody/d1-dag-validate'
import { eventPathFor } from '@/scripts/custody/d1-candidate-certification'

const ROOT = process.cwd()
const closure = derivePackageClosure(ROOT)

describe('the derived package', () => {
  it('contains every execution entry point, every consumer, the evaluator, the contract and the harness', () => {
    for (const f of [...EXECUTION_ENTRY_POINTS, 'scripts/custody/d1-consumer-shell.ts', 'db/custody/p1-reads.ts', 'db/custody/auditor-read-session.ts', 'scripts/custody/d1-candidate-certification.ts', 'scripts/custody/d1-package-closure.ts', 'scripts/custody/d1-delivery-matrix.ts', 'scripts/custody/d1-post-mint.ts']) {
      expect(closure.files, f).toContain(f)
    }
  })
  it('contains the whole DAG chain, every D-1 owner decision, the inventory and the runtime config', () => {
    for (const s of GRAPH_SOURCES) expect(closure.files).toContain(`docs/ops/release/${s}`)
    expect(closure.files).toContain('docs/ops/owner-ratifications/FIBDB053_D1_AUDITOR_AC1_AC3_OWNER_DECISION_v1.0.0.json')
    expect(closure.files).toContain('docs/ops/owner-ratifications/FIBDB053_D1_AUDITOR_MINT_ROUTE_OWNER_DECISION_v1.0.0.json')
    expect(closure.files).toContain('docs/ops/staging/FIBDB053_AUDITOR_CREDENTIAL_CUSTODY_INVENTORY_v1.0.0.json')
    expect(closure.files).toEqual(expect.arrayContaining(['package.json', 'pnpm-lock.yaml']))
    expect(closure.files.length).toBeGreaterThan(80)
  })
  it('never contains a certification event', () => {
    expect(CERTIFICATION_EVENT_PATTERN.test(eventPathFor('a'.repeat(40)))).toBe(true)
    expect(closure.files.some((f) => CERTIFICATION_EVENT_PATTERN.test(f))).toBe(false)
  })
  it('the digest is over path and blob, so one changed blob changes it', () => {
    expect(closure.digest).toBe(closureDigest(closure.blobs))
    const first = closure.files[0]!
    expect(closureDigest({ ...closure.blobs, [first]: '0'.repeat(40) })).not.toBe(closure.digest)
  })
  it('a NEW module imported by an entry point joins the code closure without editing any list', () => {
    const files: Record<string, string> = {
      'a/entry.ts': "import { x } from './new-module'\nexport const y = x\n",
      'a/new-module.ts': "import postgres from 'postgres'\nexport const x = postgres\n",
    }
    const got = deriveCodeClosure('/r', ['a/entry.ts'], (abs) => files[abs.replace(/\\/g, '/').replace(/^\/r\//, '')]!)
    expect(got.files).toEqual(['a/entry.ts', 'a/new-module.ts'])
    expect(got.externals).toEqual(['postgres'])
  })
})
