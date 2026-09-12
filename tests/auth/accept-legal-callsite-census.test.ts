// tests/auth/accept-legal-callsite-census.test.ts
//
// CL-1 (HPO-ODS-W2-28) — independent-certification BLOCKING B-1 repair,
// deterministic call-site census.
//
// withAccountAcceptanceDischargeContext (lib/auth/database-context.ts) is
// the ONE surface exempt from the L0 gate. It is deliberately NOT a general
// "skipGates" escape hatch: its authorised callers are named, closed, and
// exactly two. This control fails the moment a THIRD call site appears —
// which is the whole point of a narrow, non-parameterised exemption rather
// than a caller-controlled list of gates to suppress.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = path.resolve(process.cwd())
const CALL_PATTERN = /\bwithAccountAcceptanceDischargeContext\s*\(/

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

describe('withAccountAcceptanceDischargeContext call-site census', () => {
  it('is invoked from EXACTLY app/(public)/accept-legal/page.tsx and .../actions.ts — no third call site', () => {
    const files = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'lib'))]
    const callers: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      // The definition site itself (lib/auth/database-context.ts) declares
      // the function; it does not CALL it, so `export async function
      // withAccountAcceptanceDischargeContext` must not be misread as a call.
      const withoutDeclaration = source.replace(/export\s+async\s+function\s+withAccountAcceptanceDischargeContext/, '')
      if (CALL_PATTERN.test(withoutDeclaration)) {
        callers.push(path.relative(ROOT, file).replace(/\\/g, '/'))
      }
    }
    expect(callers.sort()).toEqual([
      'app/(public)/accept-legal/actions.ts',
      'app/(public)/accept-legal/page.tsx',
    ])
  })

  it('is exported from exactly one module: lib/auth/database-context.ts', () => {
    const files = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'lib')), ...walk(path.join(ROOT, 'db'))]
    const definers = files.filter((file) =>
      /export\s+async\s+function\s+withAccountAcceptanceDischargeContext/.test(readFileSync(file, 'utf8'))
    )
    expect(definers.map((f) => path.relative(ROOT, f).replace(/\\/g, '/'))).toEqual([
      'lib/auth/database-context.ts',
    ])
  })

  it('takes no gate-selection parameter — the shape itself forbids a caller-controlled skip list', () => {
    const source = readFileSync(path.join(ROOT, 'lib/auth/database-context.ts'), 'utf8')
    const start = source.indexOf('export async function withAccountAcceptanceDischargeContext')
    expect(start).toBeGreaterThan(-1)
    const signatureEnd = source.indexOf('{', source.indexOf(')', start))
    const signature = source.slice(start, signatureEnd)
    for (const forbidden of [/skipGates/i, /gates\s*:/i, /bypass/i, /suppress/i]) {
      expect(signature, `signature must not accept a gate-selection parameter: ${signature}`).not.toMatch(forbidden)
    }
    // Exactly the same two-parameter shape as its sibling withAuthenticatedDatabaseContext.
    expect(signature).toMatch(/callback:\s*\(context:\s*AuthenticatedContext\)\s*=>\s*Promise<T>/)
    expect(signature).toMatch(/options:\s*DatabaseContextOptions/)
  })

  it('never calls assertAccountAcceptanceCurrentPrincipal — the omitted gate is fixed in the body, not parameterised', () => {
    const source = readFileSync(path.join(ROOT, 'lib/auth/database-context.ts'), 'utf8')
    const start = source.indexOf('export async function withAccountAcceptanceDischargeContext')
    const end = source.indexOf('\nexport ', start + 1)
    const body = source.slice(start, end === -1 ? undefined : end)
    expect(body).not.toMatch(/assertAccountAcceptanceCurrentPrincipal/)
    expect(body).not.toMatch(/assertPrincipalGates/)
    // B0 is still required.
    expect(body).toMatch(/assertEmailVerifiedPrincipal/)
  })
})
