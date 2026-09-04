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
import { EntrypointScanner } from './helpers/entrypoint-scanner'
// Statically imported (not `await import(...)` inside the test below) so the
// module graph loads during this file's own collection, which carries no
// per-test timeout, rather than inside a 5s `it()` body. Under the full
// battery this cold import competed with every other worker for CPU and
// occasionally missed vitest's default testTimeout — a load-driven flake, not
// a defect in the modules or the check itself (see docs/ops/workstreams/RELEASE.md,
// "flake por carga"). The three modules are read-only inspected for their
// export names below; importing them has no database or network effect (proven
// by tests/database-entrypoint-safety.test.ts's "no import-time connection"
// coverage of db/client.ts, which db/identity-context.ts sits in front of).
import * as sessionModule from '@/lib/auth/session'
import * as databaseContextModule from '@/lib/auth/database-context'
import * as identityContextModule from '@/db/identity-context'

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
  'app/(authenticated)/layout.tsx':
    'requireAuth() only — resolves the memoised principal and issues no query of its own, exactly as app/app/layout.tsx does for the organisation gate.',
  // Served at /app/onboarding. It sits in the (authenticated) route group
  // rather than under app/app/ because the organisation gate redirects TO it:
  // nested under that gate it redirected to itself. See
  // tests/auth/route-authorization-boundary.test.ts.
  'app/(authenticated)/app/onboarding/page.tsx':
    'requireAuth() + getCurrentMembership(); both read the memoised principal.',

  // ---- Observes the CONNECTION, deliberately outside any context ----------
  'app/api/health/runtime-identity/route.ts':
    'STELLA_STAGING_B. Reads session_user/current_user/rolbypassrls and the in-database staging sentinel off the runtime pool. An identity context is the wrong tool and would defeat the probe: it opens a transaction whose claims are a REQUEST property, while this route observes a CONNECTION property, and db/identity-context.ts would answer with a certification this route exists to take fresh. It touches no application table, holds a read-only transaction, and returns booleans plus two role names.',

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
    'createFileEvidenceForProject owns three contexts with a storage upload of up to 25 MB between them, and the G-01 auto-index it then calls owns three more. An outer context would be reused by all of them and put both the upload and the grounding storage read back inside a transaction. Covered by SERVICE_OWNED_CONTEXTS below.',
  'app/app/projects/[projectId]/pipeline/evidence/verifyEvidenceIntegrity.action.ts':
    'verifyFileEvidenceIntegrity owns its contexts: the stored file is downloaded and re-hashed between the read and the write. Covered by SERVICE_OWNED_CONTEXTS below.',
  'app/app/projects/[projectId]/pipeline/evidence/indexEvidence.action.ts':
    'G-01 manual retry. ingestProjectEvidenceForProject owns three contexts — a scoped lookup, ONE that carries register -> insert -> finalize as a single transaction (M-7), and the audit write — with a Storage download between the first two. An outer context would be reused by all three, collapsing the M-7 transaction boundary and putting the download inside it. Covered by SERVICE_OWNED_CONTEXTS below.',
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
  // G-01. Where the coverage moved for `indexEvidence.action.ts`, and for the
  // second half of `createFileEvidence.action.ts`. It is separately checked as
  // an entry point of its own; naming it here is what makes those two allowlist
  // rows point at something instead of asserting themselves.
  'app/actions/grounding/ingest-evidence.ts',
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

  it('every approved wrapper name is a real export — a rename cannot silently disable this file', () => {
    const exported = new Set([
      ...Object.keys(sessionModule),
      ...Object.keys(databaseContextModule),
      ...Object.keys(identityContextModule),
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

  // The published regex-layer figures (docs/ops/DATABASE_RUNTIME_CUTOVER.md and
  // STELLA_FABLE_TEST_LEDGER.md) are pinned here so they cannot drift in silence.
  // These are the app/** entry-point counts of the REGEX layer, distinct from
  // the AST layer's 122/100/86/14 over app/** + components/**. Update BOTH the
  // number and the doc together, deliberately.
  //
  // TRAIN 3 (+1 here, +2 in the AST layer): the grounded-query server action
  // `app/actions/stella/grounded-query.ts` is an entry point by both layers.
  // `app/app/projects/[projectId]/pipeline/StellaGroundedQuerySection.tsx` is
  // seen only by the AST layer — it is a server component, not an entry point
  // (`isEntryPoint`), which is exactly the JSX-shaped gap B2 added the AST
  // layer to close. Both are `contextualized`: the action opens
  // `withOrganizationDatabaseContext` around every read, and the wrapper
  // reaches the database only through that action.
  //
  // G-01 (+1 in both layers): `app/actions/grounding/ingest-evidence.ts` is the
  // first application path that WRITES into the governed grounding corpus. It
  // is `contextualized` and, unlike most entries here, its context boundary is
  // load-bearing rather than incidental: register -> insert -> finalize must
  // share ONE transaction, because `finalize_document_ingestion` verifies the
  // chunk count without activating a version while
  // `claim_active_document_version` selects the highest ordinal with no
  // finalized-state predicate. See the module header (M-7).
  //
  // G-01 PRODUCT PATH (+2 here, +2 in the AST layer):
  // `app/actions/grounding/evidence-corpus-state.ts` is the READ model behind
  // the evidence screen's grounding column — `contextualized`, and its queries
  // sit inline in the opener's callback rather than in a helper, because the
  // decorative-wrapper shape is one this suite refuses on purpose.
  // `app/app/projects/[projectId]/pipeline/evidence/indexEvidence.action.ts` is
  // the manual retry and is ALLOWLISTED (13 -> 14): it forwards to
  // `ingestProjectEvidenceForProject`, which owns three contexts with a Storage
  // download between the first two, so an outer one would collapse the M-7
  // transaction boundary. Its coverage is named in SERVICE_OWNED_CONTEXTS.
  it('the regex-layer coverage matches the figures the docs publish', () => {
    const contextualized = databaseReaching.filter((file) => {
      if (file in ALLOWLIST) return false
      const source = readFileSync(path.join(ROOT, file), 'utf8')
      const symbols = databaseSymbols(path.join(ROOT, file), source)
      return serverRegions(source).every(
        (region) => !usesDatabase(region.body, symbols) || opensAContext(region.body)
      )
    })
    const allowlisted = databaseReaching.filter((file) => file in ALLOWLIST)
    expect({
      inventoried: ENTRY_POINTS.length,
      reaching: databaseReaching.length,
      contextualized: contextualized.length,
      allowlisted: allowlisted.length,
    // 122 -> 123 / 98 -> 99 / allowlisted 15 -> 16: STELLA_STAGING_B adds
    // `app/api/health/runtime-identity/route.ts`, allowlisted because it
    // observes the CONNECTION rather than tenant data — see its ALLOWLIST row.
    // `contextualized` is unchanged at 83: no existing module changed class.
    //
    // 123 -> 124, and REACHING STAYS 99: G1-B PRECONDITIONS adds
    // `app/api/health/stella-preconditions/route.ts`, which reads env-derived
    // configuration and opens no connection. That it moves `inventoried`
    // without moving `reaching` is the assertion — a health route that had
    // quietly started touching tenant data would move both, and would need an
    // ALLOWLIST row it does not have.
    //
    // 124 -> 127 / 99 -> 102 / contextualized 83 -> 86, allowlisted UNCHANGED
    // at 16: W2-B1-R4 (FIBIU-05/06/07 reachable governed remedies) adds three
    // new .action.ts entry points — classifyEvidenceSensitivity.action.ts,
    // requestEvidenceErasure.action.ts (both under pipeline/evidence/), and
    // calculation/runs/recordEvidenceSufficiencyDetermination.action.ts. All
    // three call runWithOrganizationAccess around their one governed write,
    // exactly like their sibling actions in the same directories, so all
    // three are `contextualized`, not allowlisted.
    //
    // 127 -> 128 / 102 -> 103 / contextualized 86 -> 87, allowlisted
    // UNCHANGED at 16: W2-B2 (FIBIU-09/FIBC-011) adds one new .action.ts
    // entry point — evaluateProxyRubric.action.ts, under pipeline/proxies/.
    // It calls runWithOrganizationAccess around its one governed write,
    // exactly like its sibling updateFinancialProxyReviewStatus.action.ts,
    // so it is `contextualized`, not allowlisted.
    //
    // 128 -> 129 / 103 -> 104 / contextualized 87 -> 88, allowlisted
    // UNCHANGED at 16: W2-B2 (FIBIU-10/FIBC-013) adds one new .action.ts
    // entry point — updateFinancialProxy.action.ts, under pipeline/proxies/.
    // Same runWithOrganizationAccess pattern as its siblings, so
    // `contextualized`, not allowlisted.
    //
    // 129 -> 130 / 104 -> 105 / contextualized 88 -> 89, allowlisted
    // UNCHANGED at 16: W2-B3 (FIBIU-12/FIBC-016) adds one new .action.ts
    // entry point — calculation/runs/recordOutcomeMonetizationDisposition.action.ts.
    // It calls runWithOrganizationAccess around its one governed write,
    // exactly like its siblings in the same directory
    // (createSroiRunReview.action.ts, recordEvidenceSufficiencyDetermination.action.ts),
    // so it is `contextualized`, not allowlisted. Registered under
    // docs/ops/wave2/W2_B3_ENTRYPOINT_INVENTORY_AUTHORITY_v1.0.0.json.
    //
    // 130 -> 131, 105 -> 106, contextualized 89 -> 90, allowlisted UNCHANGED
    // at 16: app/app/organization/onboarding/page.tsx (Product line, PR #48) —
    // already noted as "already unregistered in the shared inventory at the
    // common base" in 72c6024's own commit message, i.e. a pre-existing gap
    // this pinning never closed. ca30c2d rewrote it from a 'use client'
    // form-only page into an async server component that calls
    // requireOrganizationAccess() directly around its one read
    // (membership.role); it is `contextualized` like its siblings, not
    // allowlisted. COMMERCIAL-V1-WAVE2-RECONCILIATION-R1 (HPO-ODS-W2-08):
    // figures re-measured fresh against the reconciled tree, matching the
    // AST-layer inventory update.
    //
    // 131 -> 135, 106 -> 110, contextualized 90 -> 94, allowlisted UNCHANGED
    // at 16: W2-B4 (HPO-ODS-W2-12, FIBIU-14/15) adds FOUR new .action.ts
    // entry points — calculation/runs/recordCounterfactualAssessment.action.ts
    // and narrative/{createMethodologicalAssumption,linkAssumptionToObject,
    // updateMethodologicalAssumption}.action.ts. Each calls
    // runWithOrganizationAccess around its one governed write, exactly like
    // its siblings in the same directories, so all four are `contextualized`,
    // not allowlisted: +4 inventoried, +4 reaching, +4 contextualized.
    }).toEqual({ inventoried: 135, reaching: 110, contextualized: 94, allowlisted: 16 })
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

/* -------------------------------------------------------------------------- */
/* 5. The AST scanner — the ten shapes the regex scanner cannot see           */
/* -------------------------------------------------------------------------- */
//
// Everything above this line works on regexes over source text and only walks
// `app/**`. The reaudit demonstrated ten shapes that survive it — server JSX
// components, aliased/namespace/dynamic imports, transitive helpers,
// re-export barrels, decorative and conditional wrappers, non-canonical
// driver modules, and `db` reassignment. tests/helpers/entrypoint-scanner.ts
// closes them with a TypeScript AST + import-graph analysis; this section
// wires it to the real tree, to a versioned inventory, and to one mutant
// fixture per surviving shape.

const SCANNER_OPTIONS = {
  root: ROOT,
  scanDirs: ['app', 'components', 'lib', 'db'],
  checkedDirs: ['app', 'components'],
  contextOpeners: [...CONTEXT_OPENERS],
  contextModulePaths: [
    'lib/auth/session.ts',
    'lib/auth/database-context.ts',
    'db/identity-context.ts',
  ],
  allowlist: ALLOWLIST,
} as const

const FIXTURE_ROOT = path.join(ROOT, 'tests', 'fixtures', 'entrypoint-mutants')

describe('AST scanner — every mutant fixture is caught', () => {
  const scanner = new EntrypointScanner({
    root: FIXTURE_ROOT,
    scanDirs: ['app', 'lib', 'db'],
    checkedDirs: ['app'],
    contextOpeners: ['runWithOrganizationAccess'],
  })
  const result = scanner.scan()
  const unguarded = [...result.classified.entries()]
    .filter(([, classification]) => classification === 'unguarded')
    .map(([file]) => file)

  const MUTANTS: Array<[string, string]> = [
    ['form 1: server JSX component (old OutcomeAllocationWrapper shape)', 'app/components/LeakyWidget.tsx'],
    ['form 1: page rendering the database-reaching component', 'app/m01-jsx/page.tsx'],
    ['form 2: aliased import', 'app/m02-alias/page.tsx'],
    ['form 3: namespace import', 'app/m03-namespace/page.tsx'],
    ['form 4: dynamic import', 'app/m04-dynamic/page.tsx'],
    ['form 5: transitive local helper', 'app/m05-helper/page.tsx'],
    ['form 6: re-export barrel', 'app/m06-reexport/page.tsx'],
    ['form 7: decorative wrapper', 'app/m07-decorative/page.tsx'],
    ['form 8: conditional wrapper', 'app/m08-conditional/page.tsx'],
    ['form 9: non-canonical driver module', 'app/m09-noncanonical/page.tsx'],
    ['form 10: db reassigned to a local variable', 'app/m10-reassigned/page.tsx'],
  ]

  it.each(MUTANTS)('%s is flagged', (_label, file) => {
    expect(unguarded, `${file} must be flagged as unguarded`).toContain(file)
  })

  it('flags nothing else — the clean control page and component pass', () => {
    expect(unguarded.sort()).toEqual(MUTANTS.map(([, file]) => file).sort())
    expect(result.classified.get('app/clean/page.tsx')).toBe('contextualized')
  })

  it('the JSX usage is detected AS a JSX usage, not incidentally', () => {
    const jsxFindings = result.findings.filter((finding) => finding.form === 'jsx-component')
    expect(jsxFindings.map((finding) => finding.file)).toContain('app/m01-jsx/page.tsx')
  })

  it('the decorative wrapper fixture DOES call an opener — that is the point', () => {
    // If the fixture ever loses its opener call, it degrades into an ordinary
    // "no opener anywhere" case and stops testing coverage-by-argument.
    const source = readFileSync(path.join(FIXTURE_ROOT, 'app/m07-decorative/page.tsx'), 'utf8')
    expect(source).toMatch(/runWithOrganizationAccess\s*\(/)
  })
})

describe('AST scanner — the real tree has no unguarded server module', () => {
  const scanner = new EntrypointScanner(SCANNER_OPTIONS)
  const result = scanner.scan()

  it('is looking at a realistic tree', () => {
    expect(result.checkedModules.length).toBeGreaterThan(100)
    expect(result.databaseReaching.length).toBeGreaterThan(80)
  })

  it('every database-reaching server module is contextualized or allowlisted', () => {
    expect(
      result.findings.map(
        (finding) => `${finding.file}:${finding.line} [${finding.form}] ${finding.symbol}`
      ),
      'A server module (page, action, route, component or helper under app/ or components/)\n' +
        'reaches the database outside an identity context. As uellix_app that query returns\n' +
        'ZERO ROWS silently. Load the data inside the page\'s runWith* callback and pass it\n' +
        'down as props, or wrap the region — see docs/ops/DATABASE_RUNTIME_CUTOVER.md.'
    ).toEqual([])
  })

  it('OutcomeAllocationWrapper no longer queries — funders arrive as props', () => {
    // The B1 regression this closure fixed: the wrapper queried funders during
    // streaming render and silently vanished under RLS. Its old shape lives on
    // as the LeakyWidget fixture, which the fixture suite above proves is
    // caught. The real component still imports the (self-guarded) allocation
    // ACTIONS it passes to the client section — that is the RPC boundary and
    // it is fine — but it must never import a lib service or query itself.
    const wrapper = 'app/components/allocation-form/OutcomeAllocationWrapper.tsx'
    expect(result.classified.get(wrapper)).toBe('contextualized')
    expect(scanner.analyzeModule(path.join(ROOT, wrapper))).toEqual([])
    const source = readFileSync(path.join(ROOT, wrapper), 'utf8')
    expect(source).not.toMatch(/@\/lib\/pipeline\/funders/)
    expect(source).not.toMatch(/listFundersForCurrentOrganization/)
  })

  it('the outcomes page that feeds it stays contextualized', () => {
    expect(
      result.classified.get('app/app/projects/[projectId]/pipeline/outcomes/page.tsx')
    ).toBe('contextualized')
  })
})

describe('AST scanner — the versioned inventory stays reconciled', () => {
  // NOT a fixed count: the inventory is a semantic map of every checked,
  // database-reaching module to its classification. An unclassified addition
  // fails; a stale entry fails; a classification CHANGE fails. Counts are
  // derived from the map, never asserted as bare numbers.
  const inventory = JSON.parse(
    readFileSync(path.join(ROOT, 'tests', 'database-entrypoint-inventory.json'), 'utf8')
  ) as { checkedModules: number; databaseReaching: number; modules: Record<string, string> }

  const scanner = new EntrypointScanner(SCANNER_OPTIONS)
  const result = scanner.scan()
  const scanned = new Map([...result.classified.entries()])

  it('every scanned module is in the inventory with the same classification', () => {
    const unexpected: string[] = []
    for (const [file, classification] of scanned) {
      const recorded = inventory.modules[file]
      if (recorded !== classification) {
        unexpected.push(`${file}: scanned=${classification} inventory=${recorded ?? 'MISSING'}`)
      }
    }
    expect(
      unexpected,
      'New or re-classified database-reaching modules must be recorded DELIBERATELY in\n' +
        'tests/database-entrypoint-inventory.json after verifying their identity context.'
    ).toEqual([])
  })

  it('every inventory entry still exists in the scan — no stale rows', () => {
    const stale = Object.keys(inventory.modules).filter((file) => !scanned.has(file))
    expect(stale, 'Remove rows for modules that no longer reach the database.').toEqual([])
  })

  it('the derived totals in the inventory header match the map', () => {
    expect(inventory.databaseReaching).toBe(Object.keys(inventory.modules).length)
    expect(inventory.checkedModules).toBe(result.checkedModules.length)
  })
})

describe('AST scanner — documented residual limits (adversarial review)', () => {
  // The adversarial reviewer surfaced two structural blind spots. Neither is one
  // of the ten forms the scanner claims to close, and both are covered by the
  // live runtime suites — but they are pinned here so a regression in the
  // mitigating layer, or a silent widening of the blind spot, is visible.

  // MINOR-1: the identity layer itself (contextModulePaths) is exempt from the
  // scanner AND lives outside checkedDirs, so a NEW contextless query added to
  // one of these three files would not be flagged structurally. The mitigation
  // is that these three are the modules the runtime suites exercise most
  // directly. This test asserts the mitigation still exists.
  it('the identity-layer modules have a live runtime suite guarding them', () => {
    for (const file of ['lib/auth/session.ts', 'lib/auth/database-context.ts', 'db/identity-context.ts']) {
      expect(existsSync(path.join(ROOT, file)), `${file} missing`).toBe(true)
    }
    // These suites read the identity layer against a live database; if either is
    // deleted, the structural blind spot on the identity layer stops being
    // mitigated and this fails.
    expect(existsSync(path.join(ROOT, 'tests', 'authenticated-database-context.test.ts'))).toBe(true)
    expect(existsSync(path.join(ROOT, 'tests', 'database-runtime-rls.test.ts'))).toBe(true)
  })

  // MINOR-3: a tainted function passed BY REFERENCE to a higher-order helper
  // that invokes it (`run(listX)`) is not classified as a usage. This is a
  // genuine escape but it is "form 11", outside the ten the docs enumerate.
  // Recorded so it is a known, not a silent, gap.
  it('form 11 (tainted callback passed by reference) is a KNOWN residual, not a claim', () => {
    const scanner = new EntrypointScanner({
      root: FIXTURE_ROOT,
      scanDirs: ['app', 'lib', 'db'],
      checkedDirs: ['app'],
      contextOpeners: ['runWithOrganizationAccess'],
    })
    // The clean control page passes NO tainted reference; the ten mutants cover
    // forms 1-10. This assertion documents that form 11 has no fixture and is
    // therefore explicitly out of the closed set — see docs, "residual local
    // risks".
    const result = scanner.scan()
    const flagged = [...result.classified.entries()].filter(([, c]) => c === 'unguarded').length
    expect(flagged).toBe(11) // 10 mutant pages + LeakyWidget; no form-11 fixture
  })
})
