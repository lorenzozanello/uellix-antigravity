// tests/health-egress-consumer-set.test.ts
//
// M11 NB-R1 / NB-R2 — A SOURCE-DERIVED ORACLE, REPLACING THE CIRCULAR ONE.
//
// The manifest amendment's own `AP-M11-9` (docs/ops/release/
// M11_TRACK_A_IMPLEMENTATION_TEST_MANIFEST_AMENDMENT_v1.0.1.json) validated
// TA-19 precedence by READING `DAG_EDGES` — the very document its own author
// had just finished editing in the same turn. A control whose oracle is the
// artifact under test cannot detect an omission in that artifact.
//
// ---------------------------------------------------------------------------
// v2 (M11 hardening pass, NB-IC-3/NB-IC-5) — WHY THE FIRST DRAFT WAS ITSELF
// UNSOUND, NOT JUST INCOMPLETE
// ---------------------------------------------------------------------------
// The first draft matched imports with a TEXT regex over the whole file
// source. Two consequences, both measured by an independent certification of
// this exact file:
//
//   1. IT MATCHED ITSELF. Its own `it(...)` fixtures embedded fake source as
//      TEMPLATE-LITERAL STRINGS containing the substring
//      `from '@/app/api/health/auth/route'`, and its own `safeIfContains`
//      array embedded the LITERAL TEXT `__setProviderTouchFetchForTests` as a
//      regex source. A text scanner cannot tell "this file REALLY imports X"
//      from "this file's own PROSE CONTAINS THE WORDS 'imports X'" — so this
//      file counted itself as a sixth, spuriously-safe consumer, while its
//      own assertions only checked five NAMES were PRESENT in the result set
//      and never asserted the set's TOTAL SIZE, so the sixth, bogus member
//      was invisible to every assertion in the file.
//   2. IT ONLY MATCHED THE `@/` ALIAS FORM. A file importing the same module
//      via a RELATIVE path (`from '../../lib/health/provider-touch'`) would
//      never match the pattern at all and would be silently absent from the
//      scan — the exact shape of omission this file exists to catch,
//      reproduced by its own detection mechanism.
//
// The fix is not a patch on the regex; it is a different KIND of oracle: this
// file now parses every candidate with the TypeScript compiler API
// (`ts.createSourceFile`) and walks the REAL AST for `ImportDeclaration`,
// dynamic `import(...)`, and `require(...)` nodes ONLY. A string that merely
// CONTAINS import-shaped text — inside a template literal, a comment, or a
// regex literal — produces no such AST node and is never extracted. Every
// extracted specifier is then RESOLVED to an absolute, extension-stripped
// path (handling both the `@/` alias and relative paths against the
// importing file's own directory) before being compared against the five
// target modules' own canonical paths — so a relative import is caught
// exactly as reliably as an aliased one. The same AST-only discipline is
// applied to detecting `vi.mock(...)` calls, so a COMMENT claiming a mock
// exists can no longer be mistaken for one.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()
const SCAN_DIRS = ['tests', 'app', 'lib']
const SELF_PATH = path.join(ROOT, 'tests/health-egress-consumer-set.test.ts')

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

/** Strip a trailing `.ts`/`.tsx`/`.js`/`.jsx` extension, if present, for path comparison. */
function stripExt(p: string): string {
  return p.replace(/\.(tsx|ts|jsx|js)$/, '')
}

/**
 * Resolve an import specifier found in `fromFile` to an absolute,
 * extension-stripped path. Handles the `@/` alias (tsconfig `paths`:
 * `"@/*": ["./*"]`) and relative paths against the IMPORTING file's own
 * directory — never the repo root, which would silently mis-resolve any
 * relative import not colocated with this scanner. A bare package specifier
 * (`vitest`, `@supabase/supabase-js`, ...) is returned unresolved: it can
 * never equal one of our absolute target paths, so it simply never matches.
 */
function resolveSpecifier(fromFile: string, specifier: string): string {
  if (specifier.startsWith('@/')) {
    return stripExt(path.join(ROOT, specifier.slice(2)))
  }
  if (specifier.startsWith('.')) {
    return stripExt(path.resolve(path.dirname(fromFile), specifier))
  }
  return specifier
}

/** A real import/require, extracted from the AST — never from comments, strings, or prose. */
interface RealImport {
  specifier: string
  resolved: string
}

/**
 * Walk the REAL AST of `source` and extract every `import ... from '...'`,
 * dynamic `import('...')`, and `require('...')` — nothing that merely LOOKS
 * like one inside a string, template literal, comment, or regex literal.
 */
function extractRealImports(fromFile: string, source: string): RealImport[] {
  const sourceFile = ts.createSourceFile(fromFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: RealImport[] = []

  function record(specifier: string): void {
    found.push({ specifier, resolved: resolveSpecifier(fromFile, specifier) })
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      // `export { x } from '...'` — a re-export is still a real dependency edge.
      record(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if ((isDynamicImport || isRequire) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
        record((node.arguments[0] as ts.StringLiteral).text)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return found
}

/**
 * Every REAL `vi.mock('<specifier>', ...)` call, AST-extracted the same way
 * — a comment or a prose string claiming a mock exists is not this.
 */
function extractRealMockedSpecifiers(fromFile: string, source: string): Set<string> {
  const sourceFile = ts.createSourceFile(fromFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const mocked = new Set<string>()

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'vi' &&
      node.expression.name.text === 'mock' &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      mocked.add(resolveSpecifier(fromFile, (node.arguments[0] as ts.StringLiteral).text))
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return mocked
}

/**
 * Whether `fromFile` calls the touch's own test-injection hook — an AST
 * identifier check, not a text search, so a comment mentioning the hook's
 * name cannot be mistaken for actually calling it.
 */
function callsProviderTouchInjectionHook(fromFile: string, source: string): boolean {
  const sourceFile = ts.createSourceFile(fromFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found = false

  function visit(node: ts.Node): void {
    if (found) return
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === '__setProviderTouchFetchForTests'
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return found
}

const TARGET_MODULES: ReadonlyArray<{ id: string; canonicalPath: string; safeMockSpecifiers: string[] }> = [
  {
    id: 'lib/auth/identity.ts (consumed, not tested)',
    canonicalPath: stripExt(path.join(ROOT, 'lib/auth/identity')),
    safeMockSpecifiers: ['@/lib/auth/identity', '@/lib/supabase/server'],
  },
  {
    id: 'app/api/health/auth/route.ts',
    canonicalPath: stripExt(path.join(ROOT, 'app/api/health/auth/route')),
    safeMockSpecifiers: ['@/lib/supabase/server', '@/lib/auth/identity'],
  },
  {
    id: 'app/api/health/runtime-identity/route.ts',
    canonicalPath: stripExt(path.join(ROOT, 'app/api/health/runtime-identity/route')),
    safeMockSpecifiers: ['@/lib/supabase/server', '@/lib/auth/identity'],
  },
  {
    id: 'app/api/health/stella-preconditions/route.ts',
    canonicalPath: stripExt(path.join(ROOT, 'app/api/health/stella-preconditions/route')),
    safeMockSpecifiers: ['@/lib/supabase/server', '@/lib/auth/identity'],
  },
  {
    id: 'lib/health/provider-touch.ts',
    canonicalPath: stripExt(path.join(ROOT, 'lib/health/provider-touch')),
    // Not a `vi.mock()` target — TA-16 injects a fetch implementation
    // directly via the module's own hook instead of mocking the module.
    safeMockSpecifiers: [],
  },
]

interface ScanResult {
  file: string
  surfaceId: string
  safe: boolean
}

function scanFile(absPath: string, source: string): ScanResult[] {
  const imports = extractRealImports(absPath, source)
  const mockedSpecifiers = extractRealMockedSpecifiers(absPath, source)
  const results: ScanResult[] = []

  for (const target of TARGET_MODULES) {
    const importsTarget = imports.some((imp) => imp.resolved === target.canonicalPath)
    if (!importsTarget) continue

    const mockedSafely = target.safeMockSpecifiers.some((spec) =>
      mockedSpecifiers.has(resolveSpecifier(absPath, spec))
    )
    const touchInjected = target.canonicalPath.endsWith('provider-touch') && callsProviderTouchInjectionHook(absPath, source)

    results.push({
      file: path.relative(ROOT, absPath).replace(/\\/g, '/'),
      surfaceId: target.id,
      safe: mockedSafely || touchInjected,
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

describe('M11 TA-19 egress-consumer set (AST-derived, not text-derived, not graph-derived)', () => {
  it('every test file that REALLY imports an egress-capable health module also REALLY mocks/injects the egress boundary', () => {
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

  it('the consumer set has EXACTLY the expected SIZE, not merely the expected members — closes the prior "exactly five" miscount', () => {
    const results = computeConsumerSet()
    const files = new Set(results.map((r) => r.file))

    const expected = [
      'tests/health-auth-route.test.ts',
      'tests/stella-preconditions-route.test.ts',
      'tests/auth-identity-discriminator.test.ts',
      'tests/provider-health-touch.test.ts',
      'tests/runtime-identity-observability.test.ts',
    ]
    for (const f of expected) expect(files.has(f)).toBe(true)

    // THE ASSERTION THE PRIOR VERSION LACKED: the TOTAL count, not just
    // membership. A spurious sixth member (this scanner's own prior
    // self-match) would have passed every one of the five membership checks
    // above while still being present — only a SIZE assertion catches that.
    expect(files.size).toBe(expected.length)

    // This scanner's own file must never appear in its own result set — the
    // direct, positive statement of the bug this v2 closes.
    expect(files.has('tests/health-egress-consumer-set.test.ts')).toBe(false)
  })

  it('MUST FAIL: a file that imports the touch via the @/ alias without injecting is caught', () => {
    const fakeSource = `
      import { observeProviderHealth } from '@/lib/health/provider-touch'
      it('does nothing safe', async () => { await observeProviderHealth() })
    `
    const results = scanFile(path.join(ROOT, 'tests/__virtual_unsafe_alias.test.ts'), fakeSource)
    expect(results).toHaveLength(1)
    expect(results[0].safe).toBe(false)
  })

  it('MUST FAIL: a file that imports the touch via a RELATIVE path without injecting is caught — the exact bypass the v1 scanner missed', () => {
    const fakeSource = `
      import { observeProviderHealth } from '../lib/health/provider-touch'
      it('does nothing safe', async () => { await observeProviderHealth() })
    `
    // Located at tests/ so '../lib/health/provider-touch' resolves correctly.
    const results = scanFile(path.join(ROOT, 'tests/__virtual_unsafe_relative.test.ts'), fakeSource)
    expect(results).toHaveLength(1)
    expect(results[0].safe).toBe(false)
  })

  it('MUST FAIL: a file that merely CONTAINS import-shaped text in a template literal or comment is NOT counted as a consumer', () => {
    const fakeSource = `
      // A comment mentioning import { GET } from '@/app/api/health/auth/route' should not count.
      const notAnImport = \`import { GET } from '@/app/api/health/auth/route'\`
      it('does nothing', () => { expect(notAnImport).toBeTruthy() })
    `
    const results = scanFile(path.join(ROOT, 'tests/__virtual_prose_only.test.ts'), fakeSource)
    expect(results).toHaveLength(0)
  })

  it('MUST FAIL: a comment CLAIMING a mock exists, without a real vi.mock() call, is not treated as safe', () => {
    const fakeSource = `
      // vi.mock('@/lib/supabase/server', () => ({}))  <- this is just a comment, not a real call
      import { GET } from '@/app/api/health/auth/route'
    `
    const results = scanFile(path.join(ROOT, 'tests/__virtual_fake_mock_comment.test.ts'), fakeSource)
    expect(results).toHaveLength(1)
    expect(results[0].safe).toBe(false)
  })

  it('a file that imports the route AND REALLY calls vi.mock(...) on the safe boundary is recognised as safe', () => {
    const fakeSource = `
      vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
      import { GET } from '@/app/api/health/auth/route'
    `
    const results = scanFile(path.join(ROOT, 'tests/__virtual_safe_route.test.ts'), fakeSource)
    expect(results).toHaveLength(1)
    expect(results[0].safe).toBe(true)
  })

  it('a file that imports the touch AND REALLY calls the injection hook is recognised as safe', () => {
    const fakeSource = `
      import { observeProviderHealth, __setProviderTouchFetchForTests } from '@/lib/health/provider-touch'
      __setProviderTouchFetchForTests(async () => new Response())
    `
    const results = scanFile(path.join(ROOT, 'tests/__virtual_safe_touch.test.ts'), fakeSource)
    expect(results).toHaveLength(1)
    expect(results[0].safe).toBe(true)
  })

  it('this control never READS a docs/ops artifact as its oracle — the oracle is the AST-parsed import graph alone', () => {
    const self = readFileSync(SELF_PATH, 'utf8')
    const dataReadCalls = self.match(/(?:readFileSync|readdirSync|import)\(\s*[^)]*docs[\\/]ops[^)]*\)/g) ?? []
    expect(dataReadCalls).toHaveLength(0)
  })
})
