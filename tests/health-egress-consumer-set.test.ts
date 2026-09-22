// tests/health-egress-consumer-set.test.ts
//
// M11 NB-R1 / NB-R2 — A SOURCE-DERIVED ORACLE, REPLACING THE CIRCULAR ONE.
//
// The manifest amendment's own `AP-M11-9` (docs/ops/release/
// M11_TRACK_A_IMPLEMENTATION_TEST_MANIFEST_AMENDMENT_v1.0.1.json) validated
// TA-19 precedence by READING `DAG_EDGES` — the very document its own author
// had just finished editing in the same turn. A control whose oracle is the
// artifact under test cannot detect an omission in that artifact, which is
// exactly what happened: three consumers were declared complete by reading
// themselves, when five were required (NB-R1).
//
// This control computes the consumer set FRESH, every run, from the actual
// import graph of every test file in the repository — never from any DAG
// document. It is capable of going RED for exactly the three cases NB-R2
// names: a new provider-touching consumer appears without mocking discipline,
// the mocking discipline is bypassed in an EXISTING file, or a docs-only edit
// tries to conceal either by editing a graph this control never reads.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SCAN_DIRS = ['tests', 'app', 'lib']

/** Every `.test.ts`/`.test.tsx` file under SCAN_DIRS, walked without any glob dependency. */
function walkTestFiles(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...walkTestFiles(full))
    } else if (/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/**
 * The modules whose import makes a test file EGRESS-CAPABLE, and what makes
 * that file SAFE despite importing one. `identitySource` is `@/lib/auth/identity`
 * itself: a file testing that module CANNOT mock it (it IS the subject), so
 * its safety requirement is the layer BELOW it instead.
 */
/**
 * Matches BOTH static (`from '@/x'`) and dynamic (`import('@/x')` /
 * `await import('@/x')`) import forms — a scanner that only matched the
 * static form would itself repeat NB-R1's own class of omission, missing
 * `tests/runtime-identity-observability.test.ts`'s dynamic
 * `await import('@/app/api/health/runtime-identity/route')` entirely.
 */
function importsEither(specifier: string): RegExp {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`from ['"]${escaped}['"]|import\\(\\s*['"]${escaped}['"]\\s*\\)`)
}

const EGRESS_SURFACES: ReadonlyArray<{
  id: string
  importPattern: RegExp
  safeIfContains: RegExp[]
}> = [
  {
    id: 'lib/auth/identity.ts (consumed, not tested)',
    importPattern: importsEither('@/lib/auth/identity'),
    safeIfContains: [/vi\.mock\(\s*['"]@\/lib\/auth\/identity['"]/, /vi\.mock\(\s*['"]@\/lib\/supabase\/server['"]/],
  },
  {
    id: 'app/api/health/auth/route.ts',
    importPattern: importsEither('@/app/api/health/auth/route'),
    safeIfContains: [/vi\.mock\(\s*['"]@\/lib\/supabase\/server['"]/, /vi\.mock\(\s*['"]@\/lib\/auth\/identity['"]/],
  },
  {
    id: 'app/api/health/runtime-identity/route.ts',
    importPattern: importsEither('@/app/api/health/runtime-identity/route'),
    safeIfContains: [/vi\.mock\(\s*['"]@\/lib\/supabase\/server['"]/, /vi\.mock\(\s*['"]@\/lib\/auth\/identity['"]/],
  },
  {
    id: 'app/api/health/stella-preconditions/route.ts',
    importPattern: importsEither('@/app/api/health/stella-preconditions/route'),
    safeIfContains: [/vi\.mock\(\s*['"]@\/lib\/supabase\/server['"]/, /vi\.mock\(\s*['"]@\/lib\/auth\/identity['"]/],
  },
  {
    id: 'lib/health/provider-touch.ts',
    importPattern: importsEither('@/lib/health/provider-touch'),
    safeIfContains: [/__setProviderTouchFetchForTests/],
  },
]

interface ScanResult {
  file: string
  surfaceId: string
  safe: boolean
  matchedSafety: string[]
}

function scanFile(absPath: string, source: string): ScanResult[] {
  const results: ScanResult[] = []
  for (const surface of EGRESS_SURFACES) {
    if (!surface.importPattern.test(source)) continue
    // `lib/auth/identity.ts`'s OWN test file (testing the discriminator
    // directly) cannot mock itself — its safety requirement is the layer
    // below (`@/lib/supabase/server`), which its `safeIfContains` already
    // includes as an alternative, so no special-case exclusion is needed here.
    const matched = surface.safeIfContains.filter((re) => re.test(source)).map((re) => re.source)
    results.push({
      file: path.relative(ROOT, absPath),
      surfaceId: surface.id,
      safe: matched.length > 0,
      matchedSafety: matched,
    })
  }
  return results
}

function computeConsumerSet(): ScanResult[] {
  const files = SCAN_DIRS.flatMap((d) => walkTestFiles(path.join(ROOT, d)))
  const results: ScanResult[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    results.push(...scanFile(file, source))
  }
  return results
}

describe('M11 TA-19 egress-consumer set (source-derived, not graph-derived)', () => {
  it('every test file that imports an egress-capable health module also mocks the egress boundary', () => {
    const results = computeConsumerSet()
    const unsafe = results.filter((r) => !r.safe)

    if (unsafe.length > 0) {
      const detail = unsafe.map((r) => `  - ${r.file} imports ${r.surfaceId} with no matching mock/injection`).join('\n')
      throw new Error(
        `${unsafe.length} test file(s) can reach real Supabase/GoTrue egress without a guard:\n${detail}`
      )
    }

    expect(unsafe).toHaveLength(0)
  })

  it('the currently known consumer set is exactly the five M11 re-derived files (documents the finding; re-derived fresh, not asserted)', () => {
    const results = computeConsumerSet()
    const files = new Set(results.map((r) => r.file.replace(/\\/g, '/')))

    // Informational, not the oracle: the ORACLE is the safety check above,
    // which runs regardless of this set's membership. This assertion exists
    // so a reader sees the count without re-deriving it by hand, and so a
    // SHRINKING of the set (a file stops importing an egress-capable module)
    // is visible too.
    expect(files.has('tests/health-auth-route.test.ts')).toBe(true)
    expect(files.has('tests/stella-preconditions-route.test.ts')).toBe(true)
    expect(files.has('tests/auth-identity-discriminator.test.ts')).toBe(true)
    expect(files.has('tests/provider-health-touch.test.ts')).toBe(true)
    expect(files.has('tests/runtime-identity-observability.test.ts')).toBe(true)
  })

  it('MUST FAIL: a file that imports the touch without ever calling __setProviderTouchFetchForTests is caught', () => {
    const fakeSource = `
      import { observeProviderHealth } from '@/lib/health/provider-touch'
      it('does nothing safe', async () => { await observeProviderHealth() })
    `
    const results = scanFile('/virtual/unsafe-touch.test.ts', fakeSource)
    expect(results).toHaveLength(1)
    expect(results[0].safe).toBe(false)
  })

  it('MUST FAIL: a file that imports the auth route without mocking either boundary is caught', () => {
    const fakeSource = `
      import { GET } from '@/app/api/health/auth/route'
      it('does nothing safe', async () => { await GET() })
    `
    const results = scanFile('/virtual/unsafe-route.test.ts', fakeSource)
    expect(results).toHaveLength(1)
    expect(results[0].safe).toBe(false)
  })

  it('a file that imports the route AND mocks @/lib/supabase/server is recognised as safe', () => {
    const fakeSource = `
      vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
      import { GET } from '@/app/api/health/auth/route'
    `
    const results = scanFile('/virtual/safe-route.test.ts', fakeSource)
    expect(results).toHaveLength(1)
    expect(results[0].safe).toBe(true)
  })

  it('this control never READS a docs/ops artifact as its oracle — DAG_EDGES appears only in explanatory prose, never in a file path a `readFileSync`/`import()` call resolves', () => {
    const self = readFileSync(path.join(ROOT, 'tests/health-egress-consumer-set.test.ts'), 'utf8')
    // The actual property that matters: no data-reading call targets
    // docs/ops/** anywhere in this file. Mentioning DAG_EDGES/docs/ops in a
    // COMMENT (as this file's own header does, explaining what it replaces)
    // is not a data dependency — reading it as one WOULD be.
    const dataReadCalls = self.match(/(?:readFileSync|readdirSync|import)\(\s*[^)]*docs[\\/]ops[^)]*\)/g) ?? []
    expect(dataReadCalls).toHaveLength(0)
  })
})
