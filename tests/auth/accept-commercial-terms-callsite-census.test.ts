// tests/auth/accept-commercial-terms-callsite-census.test.ts
//
// L1 (HPO-ODS-W2-29) — TOPO-discharge-callsite-census.
//
// withOrganizationAcceptanceDischargeContext (lib/auth/database-context.ts) is
// the ONE surface exempt from the L1 gate, and from L1 ONLY. It is
// deliberately NOT a general escape hatch: its authorised callers are named,
// closed, and exactly two. This control fails the moment a THIRD call site
// appears — which is the whole point of a narrow, non-parameterised exemption
// rather than a caller-controlled list of gates to suppress.
//
// EQUALITY-SHAPED, never containment. A containment assertion is green for
// every superset, so it cannot fail on the exact event this census exists to
// catch (mutation MUT-L1-census-to-containment).
//
// Modelled on tests/auth/accept-legal-callsite-census.test.ts, the measured
// precedent for its L0 sibling — including the reason that file strips the
// DECLARATION before matching: `export async function <name>` is where the
// function is DEFINED, not a call, and a census that counts its own definition
// starts one over and can never reach zero.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = path.resolve(process.cwd())
const CALL_PATTERN = /\bwithOrganizationAcceptanceDischargeContext\s*\(/

/** Every tracked-shape .ts/.tsx file under app/ and lib/, walked by hand (no glob dependency). */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const relative = (file: string) => path.relative(ROOT, file).replace(/\\/g, '/')

/**
 * Comments removed, for the NEGATIVE assertions below only.
 *
 * Both discharge surfaces DOCUMENT, at length, which primitives they must not
 * reach and why — "reaching for withOrganizationDatabaseContext here would
 * reproduce CL-1's B-1 self-lock" is exactly the sentence a future reader
 * needs. A negative assertion run over raw file text fails on that sentence,
 * so the only way to make it pass would be to DELETE THE EXPLANATION. The
 * control must read the CALLS, not the prose about the calls.
 *
 * The POSITIVE census above deliberately does NOT strip: it mirrors its L0
 * sibling byte for byte, and a commented-out call is still a call site a
 * reviewer should see.
 */
const codeOf = (file: string) =>
  readFileSync(path.join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

describe('withOrganizationAcceptanceDischargeContext call-site census', () => {
  it('is invoked from EXACTLY the accept-commercial-terms page and its action — no third call site', () => {
    const files = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'lib'))]
    const callers: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const withoutDeclaration = source.replace(
        /export\s+async\s+function\s+withOrganizationAcceptanceDischargeContext/,
        ''
      )
      if (CALL_PATTERN.test(withoutDeclaration)) callers.push(relative(file))
    }
    expect(callers.sort()).toEqual([
      'app/(public)/accept-commercial-terms/actions.ts',
      'app/(public)/accept-commercial-terms/page.tsx',
    ])
  })

  it('is exported from exactly one module: lib/auth/database-context.ts', () => {
    const files = [
      ...walk(path.join(ROOT, 'app')),
      ...walk(path.join(ROOT, 'lib')),
      ...walk(path.join(ROOT, 'db')),
    ]
    const definers = files.filter((file) =>
      /export\s+async\s+function\s+withOrganizationAcceptanceDischargeContext/.test(readFileSync(file, 'utf8'))
    )
    expect(definers.map(relative)).toEqual(['lib/auth/database-context.ts'])
  })

  it('the two authorised callers do NOT reach any of the four L1 enforcement surfaces', () => {
    // If either half of the discharge surface transited an enforcement
    // surface, the subject this page exists to serve would be redirected
    // straight back to it — the CL-1 BLOCKING B-1 self-lock, one gate later
    // (mutation MUT-L1-enforce-L1-on-the-discharge-boundary).
    for (const caller of [
      'app/(public)/accept-commercial-terms/page.tsx',
      'app/(public)/accept-commercial-terms/actions.ts',
    ]) {
      const source = codeOf(caller)
      for (const surface of [
        'requireOrganizationAccess',
        'getCurrentOrganizationContext',
        'withOrganizationDatabaseContext',
        'withOptionalDatabaseIdentityContext',
        'runWithOrganizationAccess',
        'runWithOptionalOrganizationAccess',
      ]) {
        expect(source, `${caller} must not transit the L1 enforcement surface ${surface}`).not.toMatch(
          new RegExp(`\\b${surface}\\s*\\(`)
        )
      }
    }
  })

  it('the L0 discharge primitive is NOT reused for L1 — its own census stays at two callers', () => {
    // withAccountAcceptanceDischargeContext passes organizationId: null, so it
    // produces NO organisation scope and an insert into a FORCE-RLS tenant
    // relation from inside it would be refused by the very isolation T4
    // requires. It is also census-pinned to exactly two callers of its own, so
    // borrowing it here would turn tests/auth/accept-legal-callsite-census.test.ts
    // red as well.
    for (const caller of [
      'app/(public)/accept-commercial-terms/page.tsx',
      'app/(public)/accept-commercial-terms/actions.ts',
    ]) {
      const source = codeOf(caller)
      expect(source).not.toMatch(/\bwithAccountAcceptanceDischargeContext\s*\(/)
      expect(source).not.toMatch(/\bwithAuthenticatedDatabaseContext\s*\(/)
      expect(source).not.toMatch(/\bwithSuperAdminDatabaseContext\s*\(/)
    }
  })
})
