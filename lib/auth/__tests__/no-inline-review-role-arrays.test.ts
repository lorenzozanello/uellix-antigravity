// lib/auth/__tests__/no-inline-review-role-arrays.test.ts
// FIBIU-29 (FIBC-041) regression guard: "no divergent inline role arrays
// remain for governed actions" in the target surfaces this unit named
// (lib/pipeline/sroi-results.ts, lib/pipeline/methodology-review.ts). A
// literal `['super_admin', 'organization_admin', 'impact_manager', ...]`
// reappearing in either file means someone re-introduced a duplicate of the
// review set instead of importing isInReviewSet from lib/auth/permissions.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const TARGET_FILES = [
  'lib/pipeline/sroi-results.ts',
  'lib/pipeline/methodology-review.ts',
]

// Matches an inline array literal containing the 'reviewer' role string —
// the marker unique to a re-declared review set. Other hierarchy-threshold
// arrays in these files (e.g. analyst+/impact_manager+ for unrelated
// permissions) never include 'reviewer' and are not what this guards
// against — only a re-duplicated review set is.
const INLINE_REVIEW_SET_ARRAY_RE = /\[\s*(?:['"][a-z_]+['"]\s*,\s*)*['"]reviewer['"]/

describe('no divergent inline review-role arrays in FIBIU-29 target surfaces', () => {
  for (const relPath of TARGET_FILES) {
    it(`${relPath} contains no inline review-role array literal`, () => {
      const contents = readFileSync(path.resolve(process.cwd(), relPath), 'utf8')
      expect(contents).not.toMatch(INLINE_REVIEW_SET_ARRAY_RE)
    })
  }

  it('both target files import the canonical permission instead', () => {
    for (const relPath of TARGET_FILES) {
      const contents = readFileSync(path.resolve(process.cwd(), relPath), 'utf8')
      expect(contents).toMatch(/isInReviewSet/)
    }
  })
})
