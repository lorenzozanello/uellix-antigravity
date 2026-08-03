// tests/database-runtime-entrypoints.test.ts
//
// THE REGRESSION THIS FILE EXISTS TO CATCH.
//
// After the runtime cutover a query issued with no identity context does not
// throw. It returns zero rows. That is the correct failure direction, and it is
// also the quietest one available: a new page ships, renders an empty table,
// and nobody can tell "there is no data" from "we forgot to open a context".
//
// The only reliable moment to catch it is when the file is added. So this suite
// asks a structural question of the whole `app/` tree:
//
//     if an entry point can reach db/client.ts, does its own source open an
//     identity context?
//
// It is NOT a grep for `db.select`. Almost no entry point queries directly —
// they call services in `lib/`, which call other services. The check therefore
// builds the real import graph, resolves `@/` and relative specifiers the way
// the bundler does, and asks whether `db/client.ts` is reachable. A page that
// imports one service that imports another that finally imports the client is
// caught exactly like a page that queries inline.
//
// Everything here reads files. No database, no network, no server.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const APP = path.join(ROOT, 'app')
const DATABASE_CLIENT = path.join(ROOT, 'db', 'client.ts')

/* -------------------------------------------------------------------------- */
/* 1. Module resolution                                                       */
/* -------------------------------------------------------------------------- */

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

function resolveModule(fromFile: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) {
    base = path.join(ROOT, specifier.slice(2))
  } else if (specifier.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), specifier)
  } else {
    // Bare specifier: a package. Out of scope — nothing in node_modules
    // imports this repository's database client.
    return null
  }

  if (existsSync(base) && statSync(base).isFile()) return base
  for (const ext of EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext
  }
  for (const ext of EXTENSIONS) {
    const indexed = path.join(base, `index${ext}`)
    if (existsSync(indexed)) return indexed
  }
  return null
}

/**
 * Import specifiers that carry VALUES.
 *
 * `import type { X } from '@/lib/pipeline/...'` is erased at compile time and
 * cannot execute a query, so counting it would flag every page that merely
 * names a service's row type. Both the statement-level `import type` and the
 * inline `{ type X }` form are excluded.
 */
function valueImports(source: string): string[] {
  const specifiers: string[] = []

  const statement = /(^|\n)\s*import\s+([\s\S]*?)from\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = statement.exec(source)) !== null) {
    const clause = match[2]
    if (/^\s*type\s/.test(clause)) continue
    specifiers.push(match[3])
  }

  const sideEffect = /(^|\n)\s*import\s*['"]([^'"]+)['"]/g
  while ((match = sideEffect.exec(source)) !== null) specifiers.push(match[2])

  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((match = dynamic.exec(source)) !== null) specifiers.push(match[1])

  const reExport = /(^|\n)\s*export\s+(?!type\s)[\s\S]*?from\s*['"]([^'"]+)['"]/g
  while ((match = reExport.exec(source)) !== null) specifiers.push(match[2])

  return specifiers
}

/** A `'use client'` module runs in the browser and cannot open a transaction. */
function isClientModule(source: string): boolean {
  return /^\s*(['"])use client\1/.test(source.replace(/^﻿/, '').replace(/^(\s*\/\/.*\n|\s*\n)*/, ''))
}

const reachesCache = new Map<string, boolean>()

/**
 * Can `file` reach db/client.ts through value imports?
 *
 * NEGATIVE RESULTS ARE ONLY CACHED WHEN THE WALK WAS COMPLETE.
 *
 * A DFS that stops at a node already on the current path returns `false`
 * without having actually explored it. If that `false` were written to the
 * shared cache, a module inside an import cycle could be permanently recorded
 * as "does not reach the database" — and every later entry point that reaches
 * the database THROUGH it would silently drop out of the checked set. Not a
 * false pass: a file that is never asserted on at all, which is worse.
 *
 * `cycleTouched` propagates "this subtree's answer depended on a back edge", so
 * only walks that never met one are memoised. Positive results are always safe
 * to cache.
 */
function reachesDatabaseClient(
  file: string,
  seen = new Set<string>(),
  state: { cycleTouched: boolean } = { cycleTouched: false }
): boolean {
  const cached = reachesCache.get(file)
  if (cached !== undefined) return cached
  if (seen.has(file)) {
    state.cycleTouched = true
    return false
  }
  seen.add(file)

  if (path.resolve(file) === DATABASE_CLIENT) return true
  if (!existsSync(file)) return false

  const source = readFileSync(file, 'utf8')
  if (isClientModule(source)) {
    reachesCache.set(file, false)
    return false
  }

  const child = { cycleTouched: false }
  for (const specifier of valueImports(source)) {
    const resolved = resolveModule(file, specifier)
    if (resolved === null) continue
    if (resolved.includes(`${path.sep}node_modules${path.sep}`)) continue
    if (reachesDatabaseClient(resolved, seen, child)) {
      reachesCache.set(file, true)
      return true
    }
  }

  if (child.cycleTouched) state.cycleTouched = true
  else reachesCache.set(file, false)
  return false
}

/* -------------------------------------------------------------------------- */
/* 2. Entry points                                                            */
/* -------------------------------------------------------------------------- */

const ENTRY_POINT_PATTERNS = [
  /^page\.tsx?$/,
  /^layout\.tsx?$/,
  /^route\.tsx?$/,
  /^default\.tsx?$/,
  /\.action\.tsx?$/,
  /\.actions\.tsx?$/,
  /^actions\.tsx?$/,
  // Server-rendered conventions that are easy to forget precisely because they
  // are not "pages". `sitemap.ts` is the realistic future offender — "list the
  // verified reports" would ship a silently empty sitemap.
  /^template\.tsx?$/,
  /^not-found\.tsx?$/,
  /^error\.tsx?$/,
  /^sitemap\.tsx?$/,
  /^manifest\.tsx?$/,
  /^robots\.tsx?$/,
  /^opengraph-image\.tsx?$/,
  /^twitter-image\.tsx?$/,
  /^icon\.tsx?$/,
  /^apple-icon\.tsx?$/,
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      walk(full, out)
    } else {
      out.push(full)
    }
  }
  return out
}

function isEntryPoint(file: string): boolean {
  const name = path.basename(file)
  if (name.includes('.test.')) return false
  if (ENTRY_POINT_PATTERNS.some((pattern) => pattern.test(name))) return true
  // Everything under app/actions/ is a server-action module regardless of name.
  return (
    file.startsWith(path.join(APP, 'actions') + path.sep) &&
    (name.endsWith('.ts') || name.endsWith('.tsx'))
  )
}

const relative = (file: string) => path.relative(ROOT, file).split(path.sep).join('/')

const ENTRY_POINTS = walk(APP).filter(isEntryPoint).map(relative).sort()

/* -------------------------------------------------------------------------- */
/* 3. What counts as opening a context                                        */
/* -------------------------------------------------------------------------- */

/**
 * The approved wrappers. Named as strings AND asserted to exist as exports, so
 * that renaming one cannot silently turn this whole suite into a no-op.
 */
const CONTEXT_OPENERS = [
  // lib/auth/session.ts — redirect-flavoured, for pages and server actions
  'runWithOrganizationAccess',
  'runWithAdminAccess',
  'runWithOptionalOrganizationAccess',
  // lib/auth/database-context.ts — throwing, for route handlers and services
  'withOrganizationDatabaseContext',
  'withAuthenticatedDatabaseContext',
  'withSuperAdminDatabaseContext',
  'withOptionalDatabaseIdentityContext',
  // db/identity-context.ts — the mechanism, for the auth layer itself
  'withDatabaseIdentityContext',
] as const

/**
 * Strip comments AND string/template literals before looking for an opener.
 *
 * Without the literal stripping, `const TODO = 'wrap this in
 * runWithOrganizationAccess()'` would satisfy the check. The point of this file
 * is that a *call* exists, not that a name is mentioned.
 *
 * Block comments are removed AFTER line comments, deliberately: doing it the
 * other way lets a `// … /* …` line open a phantom block that swallows real
 * code, which is a way to delete an opener and pass.
 */
function maskNonCode(source: string): string {
  // LENGTH-PRESERVING: every masked character becomes a space (newlines kept),
  // so offsets computed on the original string stay valid on the masked one.
  // That matters because the `'use server'` directive IS a string literal —
  // it has to be located in the original text and matched against braces in
  // the masked text.
  const out = source.split('')
  const blank = (start: number, end: number) => {
    for (let i = start; i < end && i < out.length; i++) if (out[i] !== '\n') out[i] = ' '
  }
  let i = 0
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      const end = source.indexOf('\n', i)
      blank(i, end === -1 ? source.length : end)
      i = end === -1 ? source.length : end
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      blank(i, end === -1 ? source.length : end + 2)
      i = end === -1 ? source.length : end + 2
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      const quote = source[i]
      let j = i + 1
      while (j < source.length) {
        if (source[j] === '\\') j += 2
        else if (source[j] === quote) break
        else j++
      }
      blank(i, Math.min(j + 1, source.length))
      i = j + 1
    } else {
      i++
    }
  }
  return out.join('')
}

function opensAContext(source: string): boolean {
  const code = maskNonCode(source)
  return CONTEXT_OPENERS.some((opener) => new RegExp(`\\b${opener}\\s*[(<]`).test(code))
}

interface ServerRegion {
  readonly label: string
  readonly body: string
}

/** Modules that are the ANSWER, not the risk — importing them is the fix. */
const CONTEXT_MODULES = ['@/lib/auth/session', '@/lib/auth/database-context', '@/db/identity-context']

/**
 * The identifiers this file imported from modules that can reach the database.
 *
 * A region is only required to open a context if it USES one of these. Without
 * that filter the check would flag the render path of every page whose only
 * database work lives in its inline server actions — a false positive that
 * would quickly be silenced with a decorative wrapper call, which is worse than
 * no check at all.
 */
function databaseSymbols(file: string, source: string): string[] {
  const symbols: string[] = []
  const statement = /(^|\n)\s*import\s+([\s\S]*?)from\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = statement.exec(source)) !== null) {
    const clause = match[2]
    const specifier = match[3]
    if (/^\s*type\s/.test(clause)) continue
    if (CONTEXT_MODULES.includes(specifier)) continue

    const resolved = resolveModule(file, specifier)
    if (resolved === null) continue
    if (resolved.includes(`${path.sep}node_modules${path.sep}`)) continue
    if (!reachesDatabaseClient(resolved)) continue

    // DELEGATION IS ALLOWED, but only to another entry point. A page's inline
    // closure that calls `createProxySourceAction` is fine — that module is
    // itself checked by this suite and opens its own context. Calling a
    // `lib/**` service directly is not fine, even when that service happens to
    // open contexts internally, because "the service usually opens one" is
    // exactly the reasoning that let two unwrapped mutations ship.
    //
    // "Checked" means: it opens a context, or it is an allowlisted entry point
    // whose reason is recorded and separately verified (the two evidence
    // actions whose service owns its contexts).
    if (
      resolved.startsWith(APP + path.sep) &&
      (opensAContext(readFileSync(resolved, 'utf8')) || relative(resolved) in ALLOWLIST)
    ) {
      continue
    }

    for (const name of clause.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|\}|$)/g)) {
      if (name[1] !== 'type') symbols.push(name[1])
    }
  }
  return [...new Set(symbols)]
}

function usesDatabase(body: string, symbols: readonly string[]): boolean {
  if (/\bdb\s*\./.test(body)) return true
  return symbols.some((symbol) => new RegExp(`\\b${symbol}\\s*\\(`).test(body))
}

/**
 * Split a file into the regions that are independently reachable as server
 * work, so the check is PER ENTRY POINT rather than per file.
 *
 * This is the fix for the defect that let two unwrapped mutations ship: a page
 * may export a dozen inline `'use server'` closures, each of which is its own
 * POST endpoint with its own request and its own transaction. One
 * `runWithOrganizationAccess(` anywhere in the file satisfied all of them.
 *
 * Regions are found by locating each nested `'use server'` directive and
 * matching braces outward from it — string and comment content is neutralised
 * first so a brace inside a literal cannot desynchronise the match. Whatever is
 * left over (the render path, plus module-level code) is one more region.
 */
function serverRegions(source: string): ServerRegion[] {
  const code = maskNonCode(source)
  const regions: ServerRegion[] = []
  const consumed: Array<[number, number]> = []

  const moduleLevelDirective = /^\s*(['"])use server\1/.test(source.replace(/^(\s*\n)*/, ''))

  // Located in the ORIGINAL text — the directive is a string literal and is
  // therefore masked out of `code`. Offsets are shared because the mask is
  // length-preserving.
  const directive = /(['"])use server\1/g
  let match: RegExpExecArray | null
  while ((match = directive.exec(source)) !== null) {
    // A module-level directive covers the whole file; the leftover region below
    // already represents it.
    if (moduleLevelDirective && match.index < 40) continue

    // Walk backwards to the `{` that opens the function containing it.
    let depth = 0
    let open = -1
    for (let i = match.index; i >= 0; i--) {
      if (code[i] === '}') depth++
      else if (code[i] === '{') {
        if (depth === 0) {
          open = i
          break
        }
        depth--
      }
    }
    if (open === -1) continue

    let close = -1
    depth = 0
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++
      else if (code[i] === '}') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    if (close === -1) continue

    // Name it from the ~120 characters before the opening brace.
    const preamble = code.slice(Math.max(0, open - 120), open)
    const named =
      /(?:export\s+)?(?:const|let|var|async\s+function|function)\s+([A-Za-z0-9_$]+)/g
    let label = `'use server' closure at offset ${open}`
    let nameMatch: RegExpExecArray | null
    while ((nameMatch = named.exec(preamble)) !== null) label = `${nameMatch[1]}()`

    regions.push({ label, body: code.slice(open, close + 1) })
    consumed.push([open, close + 1])
  }

  consumed.sort((a, b) => a[0] - b[0])
  let leftover = ''
  let cursor = 0
  for (const [start, end] of consumed) {
    leftover += code.slice(cursor, start)
    cursor = end
  }
  leftover += code.slice(cursor)
  regions.push({ label: 'module scope / render path', body: leftover })

  return regions
}

/**
 * Entry points that CAN reach db/client.ts but legitimately open no context,
 * each with the reason. An entry is a claim, and the test below checks the
 * claim: an allowlisted file that stops being an entry point, or starts
 * opening a context, fails as stale.
 */
const ALLOWLIST: Record<string, string> = {
  // ---- No protected query of their own -------------------------------------
  'app/(public)/login/page.tsx':
    'Renders the form. Reaches the client only through the login actions it imports, and those carry their own context inside syncUserProfile().',
  'app/app/organization/billing/actions.ts':
    'Stripe billing portal only. Reads organization/membership from requireOrganizationAccess() — the memoised principal — and issues no query.',
  'app/app/layout.tsx':
    'Reads organisation/membership from requireOrganizationAccess(), which resolves the memoised principal and issues no query of its own.',
  'app/admin/layout.tsx': 'requireAdminAccess() only — no query of its own.',
  'app/app/onboarding/page.tsx':
    'requireAuth() + getCurrentMembership(); both read the memoised principal.',

  // ---- Auth bootstrap: opens its context inside syncUserProfile ------------
  'app/(public)/login/actions.ts':
    'syncUserProfile() opens its own context (the users row may not exist yet); getCurrentMembership() reads the principal.',
  'app/auth/callback/route.ts':
    'Same as login/actions.ts: syncUserProfile() carries the context, getCurrentMembership() reads the principal.',

  // ---- Blocked by design after the cutover (documented, no bypass) ---------
  'app/api/webhooks/stripe/route.ts':
    'BLOCKED: no user identity exists for a webhook, and borrowing one would fabricate the audit trail. Refuses with 503 before any query. Needs a technical identity — see docs/ops/DATABASE_RUNTIME_CUTOVER.md.',
  'app/api/marketing/lead/route.ts':
    'BLOCKED: marketing_leads policies name the roles anon/authenticated, and uellix_app is a member of neither. Fails closed. Needs a {public} INSERT policy.',
  'app/(public)/verify/[hash]/page.tsx':
    'BLOCKED: public verification-by-hash has no anonymous SELECT policy, so it returns 404. Needs a capability policy, not a bypass.',
  'app/(public)/verify/[hash]/pdf/route.ts': 'BLOCKED: same as the verify page it renders.',

  // ---- The service owns its contexts, because something slow sits between --
  'app/app/projects/[projectId]/pipeline/evidence/createFileEvidence.action.ts':
    'createFileEvidenceForProject owns three contexts with a storage upload of up to 25 MB between them. An outer context would be reused by all three and put the upload back inside a transaction. Covered by SERVICE_OWNED_CONTEXTS below.',
  'app/app/projects/[projectId]/pipeline/evidence/verifyEvidenceIntegrity.action.ts':
    'verifyFileEvidenceIntegrity owns its contexts: the stored file is downloaded and re-hashed between the read and the write. Covered by SERVICE_OWNED_CONTEXTS below.',
}

/**
 * Where the coverage MOVED for the two allowlisted actions above.
 *
 * An allowlist entry that only says "trust me" is a suppression. These say
 * "the check applies over there", and this test makes sure it really does — if
 * one of these services loses its context, the allowlist entry that points at
 * it stops being true and this fails.
 */
const SERVICE_OWNED_CONTEXTS = [
  'lib/pipeline/evidence.ts',
] as const

/**
 * Entry points the audit examined and found to touch NO table at all.
 *
 * They are not in ALLOWLIST because ALLOWLIST rows must be rows the check would
 * otherwise read — an entry that can never be consulted is decoration, and
 * decoration rots. These are asserted in the OPPOSITE direction: the day one of
 * them starts reaching `db/client.ts`, this list becomes false and says so,
 * which is the moment someone needs to decide whether it wants a context.
 */
const AUDITED_NO_DATABASE_REACH: Record<string, string> = {
  'app/layout.tsx': 'Root layout: metadata and providers only.',
  'app/(public)/layout.tsx': 'Public marketing shell: navbar and footer.',
  'app/auth/signout/route.ts': 'Supabase sign-out only.',
  'app/api/health/auth/route.ts': 'Liveness probe: supabase.auth.getUser() and a boolean.',
  'app/(public)/forgot-password/actions.ts': 'Supabase Auth only.',
  'app/(public)/reset-password/actions.ts': 'Supabase Auth only.',
}

/* -------------------------------------------------------------------------- */
/* 4. The checks                                                              */
/* -------------------------------------------------------------------------- */

describe('the entry-point scanner is actually looking at something', () => {
  it('found the app tree and a realistic number of entry points', () => {
    expect(ENTRY_POINTS.length).toBeGreaterThan(40)
  })

  it('resolves `@/` specifiers — otherwise every graph walk would stop at the first import', () => {
    const resolved = resolveModule(path.join(APP, 'layout.tsx'), '@/db/client')
    expect(resolved).toBe(DATABASE_CLIENT)
  })

  it('follows the graph transitively, not just one hop', () => {
    // The dashboard imports no database client directly; it reaches it through
    // lib/projects/service.ts. If this ever returns false the suite is blind.
    expect(reachesDatabaseClient(path.join(APP, 'app', 'dashboard', 'page.tsx'))).toBe(true)
  })

  it('ignores type-only imports', () => {
    expect(valueImports(`import type { A } from '@/db/client'\n`)).toEqual([])
    expect(valueImports(`import { A } from '@/db/client'\n`)).toEqual(['@/db/client'])
  })

  it('treats a "use client" module as unable to open a transaction', () => {
    expect(isClientModule(`'use client'\nimport { db } from '@/db/client'`)).toBe(true)
    expect(isClientModule(`import { db } from '@/db/client'`)).toBe(false)
  })

  it('NEGATIVE CONTROL: the opener check is not vacuously true', () => {
    // A test that only ever passes proves nothing. lib/projects/service.ts
    // reaches the database and deliberately opens NO context — it runs inside
    // the one its caller opened. Feeding it through the same two steps the
    // check uses must therefore produce "reaches the database" AND "opens
    // nothing". If either flips, the assertion above has stopped discriminating.
    const service = path.join(ROOT, 'lib', 'projects', 'service.ts')
    expect(reachesDatabaseClient(service)).toBe(true)

    const source = readFileSync(service, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    const opens = CONTEXT_OPENERS.some((opener) =>
      new RegExp(`\\b${opener}\\s*[(<]`).test(source)
    )
    expect(opens).toBe(false)
  })

  it('NEGATIVE CONTROL: a file that cannot reach the database is reported as such', () => {
    // Otherwise "reaches" could be returning true for everything, and the
    // entry-point list would be checked for no reason.
    expect(reachesDatabaseClient(path.join(ROOT, 'lib', 'auth', 'roles.ts'))).toBe(false)
  })

  it('NEGATIVE CONTROL: the per-region split catches the defect the per-file check missed', () => {
    // This is the exact shape that shipped two unwrapped mutations: a page whose
    // RENDER path opens a context, and whose inline `'use server'` closures —
    // each an independent POST endpoint — call a service directly.
    const source = [
      `import { archiveEvidenceForProject } from '@/lib/pipeline/evidence'`,
      `import { runWithOrganizationAccess } from '@/lib/auth/session'`,
      ``,
      `export const archiveAction = async (formData: FormData) => {`,
      `  'use server'`,
      `  await archiveEvidenceForProject(formData.get('projectId'), formData.get('id'))`,
      `}`,
      ``,
      `export default async function Page() {`,
      `  const rows = await runWithOrganizationAccess(() => listEvidenceForProject('x'))`,
      `  return rows.length`,
      `}`,
    ].join('\n')

    const symbols = ['archiveEvidenceForProject', 'listEvidenceForProject']
    const unwrapped = serverRegions(source)
      .filter((region) => usesDatabase(region.body, symbols) && !opensAContext(region.body))
      .map((region) => region.label)

    expect(unwrapped).toEqual(['archiveAction()'])
    // …and the whole-file check, the one this replaced, would have passed it.
    expect(opensAContext(source)).toBe(true)
  })

  it('NEGATIVE CONTROL: a mention in a string or comment is not a call', () => {
    expect(opensAContext(`const TODO = 'wrap this in runWithOrganizationAccess(cb)'`)).toBe(false)
    expect(opensAContext(`// remember to call runWithOrganizationAccess(cb)`)).toBe(false)
    expect(opensAContext(`await runWithOrganizationAccess(() => x())`)).toBe(true)
  })

  it('every approved wrapper name is a real export — a rename cannot silently disable this file', async () => {
    const session = await import('@/lib/auth/session')
    const context = await import('@/lib/auth/database-context')
    const identity = await import('@/db/identity-context')
    const exported = new Set([
      ...Object.keys(session),
      ...Object.keys(context),
      ...Object.keys(identity),
    ])
    for (const opener of CONTEXT_OPENERS) {
      expect(exported.has(opener), `${opener} is no longer exported`).toBe(true)
    }
  })
})

describe('every entry point that can reach the database opens an identity context', () => {
  const databaseReaching = ENTRY_POINTS.filter((file) =>
    reachesDatabaseClient(path.join(ROOT, file))
  )

  it('there are database-reaching entry points to check', () => {
    expect(databaseReaching.length).toBeGreaterThan(30)
  })

  it.each(databaseReaching)('%s', (file) => {
    if (file in ALLOWLIST) return

    const source = readFileSync(path.join(ROOT, file), 'utf8')
    const symbols = databaseSymbols(path.join(ROOT, file), source)
    const missing = serverRegions(source).filter(
      (region) => usesDatabase(region.body, symbols) && !opensAContext(region.body)
    )

    expect(
      missing.map((region) => region.label),
      `${file} has ${missing.length} server region(s) that call into the database and open\n` +
        'no identity context:\n' +
        missing.map((region) => `  · ${region.label}`).join('\n') +
        '\n\nAs uellix_app a query with no context returns ZERO ROWS rather than failing, so this\n' +
        'would ship as a silently empty screen. Wrap the data phase in one of:\n' +
        `  ${CONTEXT_OPENERS.join(', ')}\n` +
        'or delegate to a `.action.ts` that does. If the entry point legitimately cannot have\n' +
        'one, add it to ALLOWLIST in this file with the reason — an allowlist entry is a\n' +
        'documented decision, not a suppression.'
    ).toEqual([])
  })
})

describe('the allowlist stays honest', () => {
  it.each(Object.keys(ALLOWLIST))('%s still exists', (file) => {
    expect(existsSync(path.join(ROOT, file)), `${file} is allowlisted but no longer exists`).toBe(
      true
    )
  })

  it.each(Object.keys(ALLOWLIST))('%s is still an entry point', (file) => {
    expect(ENTRY_POINTS, `${file} is allowlisted but is no longer an entry point`).toContain(file)
  })

  it.each(Object.entries(ALLOWLIST))('%s carries a reason', (_file, reason) => {
    expect(reason.length).toBeGreaterThan(30)
  })

  // An entry that can never be consulted is decoration, and decoration rots:
  // `app/layout.tsx`'s reason claimed it "reaches the client only through
  // metadata helpers" when it does not reach it at all. Every row must be one
  // the `it.each(databaseReaching)` block above actually reads.
  it.each(Object.keys(ALLOWLIST))('%s is a row the check would otherwise consult', (file) => {
    expect(
      reachesDatabaseClient(path.join(ROOT, file)),
      `${file} is allowlisted but cannot reach db/client.ts, so the allowlist entry is never ` +
        'consulted and its claim is never tested. Delete the row.'
    ).toBe(true)
  })

  it.each(SERVICE_OWNED_CONTEXTS)('%s really does open the contexts it was trusted with', (file) => {
    expect(opensAContext(readFileSync(path.join(ROOT, file), 'utf8'))).toBe(true)
  })

  it.each(Object.keys(AUDITED_NO_DATABASE_REACH))('%s still touches no table', (file) => {
    expect(
      reachesDatabaseClient(path.join(ROOT, file)),
      `${file} was audited as touching no table, and now reaches db/client.ts. Decide whether ` +
        'it needs an identity context, then move it to ALLOWLIST or wrap it.'
    ).toBe(false)
  })
})
