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

/**
 * INTEGRATION (train 4) — the `step` prop is inert.
 *
 * The canonical mount passes `step="outcomes"`. Reviewed on the explicit
 * question "does this make a project-wide query look like one limited to
 * outcome evidence?", the answer is no — but "no" was an argument about three
 * files, and an argument is not a property. These tests make it one.
 *
 * They are source scans for the same reason the block above is: the project
 * page is an async server component behind auth and database access, and the
 * seam where `step` WOULD do damage (retrieval, scope, quota) is server-side,
 * where `tests/cross-workstream/` exercises it against a real runtime.
 */
describe('grounded query — the step prop is inert', () => {
  const ACTION = path.join(process.cwd(), 'app/actions/stella/grounded-query.ts')
  const SECTION = path.join(PROJECT_ROOT, 'pipeline/StellaGroundedQuerySection.tsx')

  it('the server action takes no step parameter and knows no pipeline step type', () => {
    // The decisive one. If `step` cannot be named in the action, it cannot
    // narrow retrieval, scope, quota, the evidence set or the audit record —
    // all of which are computed there.
    const code = stripComments(read(ACTION))
    expect(code).not.toMatch(/\bAdvisorPipelineStep\b/)
    expect(code).not.toMatch(/\bstep\s*[:,)]/)
    expect(code).not.toMatch(/\brequest\.step\b/)
  })

  it('the bound server action carries the project and nothing else', () => {
    // One bound argument. A second one would be a second server-derived value
    // travelling to the client as an encrypted closure reference, and the
    // whole point of the payload being `{ query }` is that there is exactly
    // one thing the browser cannot forge.
    expect(stripComments(read(SECTION))).toMatch(
      /runStellaGroundedQueryForProject\.bind\(null,\s*projectId\)/,
    )
  })

  it('the client request type has exactly one field, and it is not step', () => {
    const contract = stripComments(
      readFileSync(path.join(process.cwd(), 'components/stella/grounded-query.ts'), 'utf8'),
    )
    const match = contract.match(/export interface StellaGroundedQueryRequest\s*\{([\s\S]*?)\n\}/)
    expect(match, 'StellaGroundedQueryRequest not found').not.toBeNull()
    const fields = [...match![1].matchAll(/^\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*[?]?\s*:/gm)].map(
      (m) => m[1],
    )
    expect(fields).toEqual(['query'])
  })

  it('the canonical mount states in words that step is inert, and says what closes it', () => {
    // The comment is load-bearing: it is the only place a reader meets the
    // value. A future edit that keeps `step="outcomes"` while deleting the
    // explanation would leave a project-wide query wearing a methodology step
    // with nothing saying it means nothing.
    const source = read(CANONICAL_SURFACE)
    expect(source).toMatch(/step`? IS INERT METADATA/i)
    expect(source).toMatch(/INT-PR-001/)
  })

  it('the panel reads step in exactly one place, and that place is the decision record', () => {
    const panel = stripComments(
      readFileSync(path.join(process.cwd(), 'components/stella/StellaGroundedQueryPanel.tsx'), 'utf8'),
    )
    // Bare `step` occurrences, excluding the two typed declarations (the prop
    // signature `step: AdvisorPipelineStep` and the import), leaves exactly
    // two: the props destructuring that binds it, and the one place it is
    // read. Pinned as a COUNT because a third occurrence is the whole risk —
    // the day someone threads it into `runQuery` or into a rendered label,
    // this goes red and the comment above the mount stops being true.
    const uses = [...panel.matchAll(/(?<![\w.])step(?![\w:])/g)]
    expect(uses.length, 'step appears somewhere beyond the binding and the decision record').toBe(2)

    // ...and the one read is the decision record.
    expect(panel).toMatch(/const record: SuggestionDecisionRecord = \{[\s\S]*?\bstep,/)

    // The negative that matters most: it never enters the request.
    expect(panel).not.toMatch(/runQuery\([^)]*\bstep\b/)
    // Train 4.1 — `runQuery({ query }, ticket)`. The REQUEST object still
    // carries `query` and nothing else; the ticket is a SECOND ARGUMENT, so
    // this assertion continues to say what it always said (the step never
    // reaches the payload) while allowing the credential that now travels
    // beside it.
    expect(panel).toMatch(/runQuery\(\{\s*query\s*\}\s*,\s*ticket\s*\)/)
  })
})
