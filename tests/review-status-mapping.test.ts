// tests/review-status-mapping.test.ts
// W2-B2-R1 / R-B2-01 — the single live<->version review-status crossing
// (W2_B2_REMEDIATION_AUTHORITY_v1.0.0 live_to_version_review_status_mapping,
// FROZEN) and the LIVE_VERSION_STATUS_COUPLING invariant. Closes B2-AR-B1's
// DB-free half; the real-PostgreSQL half (NC-3) lives in
// tests/postgres/b2-remediation.pg.test.ts.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LIVE_REVIEW_STATUSES,
  VERSION_REVIEW_STATUSES,
  toVersionReviewStatus,
  toLiveReviewStatus,
  assertLiveVersionStatusCoupling,
} from '@/lib/pipeline/financial-proxy-versions'

const FROZEN_MAP: Record<string, string> = {
  suggested: 'draft',
  pending_review: 'under_review',
  approved: 'approved',
  rejected: 'rejected',
  archived: 'archived',
}

describe('live -> version review-status mapping (frozen)', () => {
  it('is exactly the frozen five-pair map', () => {
    for (const [live, version] of Object.entries(FROZEN_MAP)) {
      expect(toVersionReviewStatus(live)).toBe(version)
    }
  })

  it('is total over the live vocabulary and onto the version vocabulary (a bijection)', () => {
    const images = LIVE_REVIEW_STATUSES.map((s) => toVersionReviewStatus(s))
    expect(new Set(images).size).toBe(LIVE_REVIEW_STATUSES.length)
    expect([...images].sort()).toEqual([...VERSION_REVIEW_STATUSES].sort())
  })

  it('round-trips through its inverse in both directions', () => {
    for (const live of LIVE_REVIEW_STATUSES) expect(toLiveReviewStatus(toVersionReviewStatus(live))).toBe(live)
    for (const version of VERSION_REVIEW_STATUSES) expect(toVersionReviewStatus(toLiveReviewStatus(version))).toBe(version)
  })

  it('NEGATIVE: a version token is not accepted as a live token, and vice versa (no coincidental pass-through)', () => {
    expect(() => toVersionReviewStatus('draft')).toThrow(/Unmapped live review status "draft"/)
    expect(() => toVersionReviewStatus('under_review')).toThrow(/Unmapped live review status/)
    expect(() => toLiveReviewStatus('suggested')).toThrow(/Unmapped version review status "suggested"/)
    expect(() => toLiveReviewStatus('pending_review')).toThrow(/Unmapped version review status/)
  })

  it('NEGATIVE: an unknown token fails closed', () => {
    expect(() => toVersionReviewStatus('')).toThrow()
    expect(() => toVersionReviewStatus('APPROVED')).toThrow()
    expect(() => toLiveReviewStatus('published')).toThrow()
  })
})

describe('LIVE_VERSION_STATUS_COUPLING', () => {
  it('holds for every mapped pair', () => {
    for (const [live, version] of Object.entries(FROZEN_MAP)) {
      expect(() => assertLiveVersionStatusCoupling(live, version)).not.toThrow()
    }
  })

  it('NEGATIVE: live pending_review beside a version draft (the pre-R1 fork shape) is a violation', () => {
    expect(() => assertLiveVersionStatusCoupling('pending_review', 'draft')).toThrow(/COUPLING violated/)
  })

  it('NEGATIVE: live archived beside a version approved (the pre-R1 archive shape) is a violation', () => {
    expect(() => assertLiveVersionStatusCoupling('archived', 'approved')).toThrow(/COUPLING violated/)
  })

  it('NEGATIVE: a live token copied verbatim into the version slot is a violation, not a coincidence', () => {
    expect(() => assertLiveVersionStatusCoupling('pending_review', 'pending_review')).toThrow()
    expect(() => assertLiveVersionStatusCoupling('suggested', 'suggested')).toThrow()
  })
})

// Static control: no transition site may write a version-vocabulary literal
// or pass the raw live token into a version write. The mapping module is the
// only place the version tokens may appear as literals.
describe('no transition site bypasses the mapping (static)', () => {
  const ROOT = process.cwd()
  const TRANSITION_SITES = [
    'lib/pipeline/proxies.ts',
    'lib/admin/proxies.ts',
    'lib/pipeline/proxy-material-change.ts',
    'lib/pipeline/financial-proxy-rubric.ts',
  ]

  /** Every balanced `<fn>(` … `)` call block in `src`. */
  function callBlocks(src: string, fn: string): string[] {
    const blocks: string[] = []
    let from = 0
    for (;;) {
      const start = src.indexOf(`${fn}(`, from)
      if (start < 0) break
      let depth = 0
      let i = start + fn.length
      for (; i < src.length; i += 1) {
        if (src[i] === '(') depth += 1
        else if (src[i] === ')') {
          depth -= 1
          if (depth === 0) break
        }
      }
      blocks.push(src.slice(start, i + 1))
      from = i + 1
    }
    return blocks
  }

  const VERSION_WRITERS = ['createFinancialProxyVersion', 'updateCurrentFinancialProxyVersion']

  it.each(TRANSITION_SITES)('%s writes no version-vocabulary literal into reviewStatus anywhere', (file) => {
    const src = readFileSync(path.join(ROOT, file), 'utf8')
    expect(src).not.toMatch(/reviewStatus:\s*'(draft|under_review)'/)
  })

  it.each(TRANSITION_SITES)('%s: every reviewStatus inside a version write goes through toVersionReviewStatus (no raw token, no literal)', (file) => {
    const src = readFileSync(path.join(ROOT, file), 'utf8')
    const blocks = VERSION_WRITERS.flatMap((fn) => callBlocks(src, fn))
    for (const block of blocks) {
      const writes = block.match(/reviewStatus:\s*[^,\n]+/g) ?? []
      for (const write of writes) {
        expect(write, `${file}: ${write}`).toMatch(/reviewStatus:\s*toVersionReviewStatus\(/)
      }
    }
  })

  it.each(TRANSITION_SITES)('%s imports the mapping primitive', (file) => {
    const src = readFileSync(path.join(ROOT, file), 'utf8')
    expect(src).toMatch(/toVersionReviewStatus|toLiveReviewStatus/)
  })
})
