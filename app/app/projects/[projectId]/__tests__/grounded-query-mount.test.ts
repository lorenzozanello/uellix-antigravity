// app/app/projects/[projectId]/__tests__/grounded-query-mount.test.ts
// PRODUCT TRAIN 4 — structural guards for the PRODUCT-002 canonical mount.
//
// StellaGroundedQuerySection has existed since train 3 with zero call sites
// (docs/ops/contracts/PRODUCT-002_grounded_query_orchestrator_entry_point.md,
// status IMPLEMENTED_UNMOUNTED_PENDING_CANONICAL_SURFACE). This train mounts
// it on the project-wide surface, not on any of the seven methodology
// pipeline steps. These tests fix WHERE it may be mounted and WHERE it must
// never be mounted by source-scanning the page files, the same technique
// StellaGroundedQueryPanel.test.tsx already uses for its "zero scope logic"
// guards — the project page is an async server component gated behind
// auth/DB access this train has no authorization to fake here (retrieval,
// scope validation and persistence stay out of components/**, see
// tests/cross-workstream/runtime-grounded-query.test.ts for the
// INTEGRATION-owned runtime seam).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const PROJECT_ROOT = path.join(process.cwd(), 'app/app/projects/[projectId]')
const CANONICAL_SURFACE = path.join(PROJECT_ROOT, 'page.tsx')

/** Every page.tsx under pipeline/ and report/ — the seven methodology steps plus their sub-routes. */
function findPageFilesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...findPageFilesUnder(full))
    } else if (entry === 'page.tsx') {
      found.push(full)
    }
  }
  return found
}

const METHODOLOGY_SURFACE_PAGES = [
  ...findPageFilesUnder(path.join(PROJECT_ROOT, 'pipeline')),
  ...findPageFilesUnder(path.join(PROJECT_ROOT, 'report')),
]

function read(file: string): string {
  return readFileSync(file, 'utf8')
}

/**
 * Strips block comments and whole-line `//` comments — the same technique
 * StellaGroundedQueryPanel.test.tsx uses — so an explanatory comment (e.g.
 * naming `onDecision` to say it is NOT wired) doesn't trip a scan meant to
 * catch the real thing appearing in code.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('grounded query — canonical project surface', () => {
  it('is a real inventory: at least the seven known methodology pages were found', () => {
    // Guards the guard: an empty list would make every "no offenders" assertion
    // below vacuously true.
    expect(METHODOLOGY_SURFACE_PAGES.length).toBeGreaterThanOrEqual(7)
  })

  it('mounts StellaGroundedQuerySection on the project overview page', () => {
    expect(read(CANONICAL_SURFACE)).toMatch(/<StellaGroundedQuerySection\b/)
  })

  it('does not mount it on any methodology pipeline page or the report step', () => {
    const offenders = METHODOLOGY_SURFACE_PAGES.filter((file) =>
      read(file).includes('StellaGroundedQuerySection'),
    ).map((file) => path.relative(PROJECT_ROOT, file))
    expect(offenders).toEqual([])
  })

  it('does not wire onDecision at the canonical mount — no persistence is claimed (INT-PR-001)', () => {
    expect(stripComments(read(CANONICAL_SURFACE))).not.toMatch(/onDecision/)
  })

  it('does not name organizationId, projectId-as-a-forged-value, or scope near the mount', () => {
    // The real projectId comes from the server-resolved route param above the
    // mount, never from a client payload — this only guards against someone
    // later threading a second, forgeable identifier into the props.
    const code = stripComments(read(CANONICAL_SURFACE))
    expect(code).not.toMatch(/\borganizationId\b/)
    expect(code).not.toMatch(/\bscope\b/)
  })

  it('the canonical surface stays a server component (no "use client")', () => {
    expect(read(CANONICAL_SURFACE)).not.toMatch(/^['"]use client['"]/m)
  })

  it('does not import node:crypto on the canonical surface', () => {
    expect(read(CANONICAL_SURFACE)).not.toMatch(/node:crypto|require\(['"]crypto['"]\)/)
  })
})
