// tests/postgres/b2-remediation.pg.test.ts
// W2-B2-R1 — REAL PostgreSQL controls for the B2 remediation
// (W2_B2_REMEDIATION_AUTHORITY_v1.0.0 R-B2-09 postgres_requirement). Every
// describe below runs against a disposable database provisioned from the
// FULL baseline manifest inside a local docker container — see
// tests/postgres/disposable-db.ts for the structural safety property.
//
// Gated: UELLIX_PG_TESTS=1. Skipped (not silently passed) otherwise.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DisposableDb,
  PG_TESTS_ENABLED,
  resolveContainer,
  seedProxyFixture,
} from './disposable-db'
import {
  LIVE_REVIEW_STATUSES,
  VERSION_REVIEW_STATUSES,
  toVersionReviewStatus,
} from '@/lib/pipeline/financial-proxy-versions'

const container = PG_TESTS_ENABLED ? resolveContainer() : null
const RUN = PG_TESTS_ENABLED && container !== null

describe.skipIf(!RUN)('B2 remediation — real PostgreSQL', () => {
  const db = new DisposableDb(container ?? 'none', 'b2_remediation')

  beforeAll(() => {
    db.provision()
  }, 600_000)

  afterAll(() => {
    db.drop()
  })

  // -------------------------------------------------------------------------
  // R-B2-01 / NC-3 — review-status vocabulary. The live CHECK and the version
  // CHECK are two different vocabularies; the frozen mapping's images must all
  // be accepted by the version CHECK, and every live-only token must be
  // REJECTED by it. This control fails if either constraint is dropped.
  // -------------------------------------------------------------------------
  describe('R-B2-01 — review-status vocabulary (NC-3)', () => {
    const fixture = () => seedProxyFixture(db, 'r1')

    const insertVersion = (status: string, ordinal: number) => {
      const f = fixture()
      return `INSERT INTO public.financial_proxy_versions (financial_proxy_id, ordinal, source_id, review_status, created_by)
        VALUES ('${f.proxyId}', ${ordinal}, '${f.sourceId}', '${status}', '${f.userId}')`
    }

    it('the version CHECK constraint exists with exactly the version vocabulary', () => {
      const def = db.scalar(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'financial_proxy_versions_review_status_check'`)
      expect(def).not.toBeNull()
      for (const v of VERSION_REVIEW_STATUSES) expect(def).toContain(`'${v}'`)
      expect(def).not.toContain(`'suggested'`)
      expect(def).not.toContain(`'pending_review'`)
    })

    it('the live CHECK constraint exists with exactly the live vocabulary', () => {
      const def = db.scalar(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'review_status_check' AND conrelid = 'public.financial_proxies'::regclass`)
      expect(def).not.toBeNull()
      for (const v of LIVE_REVIEW_STATUSES) expect(def).toContain(`'${v}'`)
      expect(def).not.toContain(`'draft'`)
      expect(def).not.toContain(`'under_review'`)
    })

    it.each([...LIVE_REVIEW_STATUSES])('POSITIVE: the mapped image of live "%s" is accepted by the version CHECK', (live) => {
      const image = toVersionReviewStatus(live)
      const ordinal = 100 + LIVE_REVIEW_STATUSES.indexOf(live)
      db.exec(`${insertVersion(image, ordinal)}; DELETE FROM public.financial_proxy_versions WHERE ordinal = ${ordinal};`)
    })

    it.each(['suggested', 'pending_review'])('NEGATIVE (NC-3): the live-only token "%s" is REJECTED by the version CHECK', (liveOnly) => {
      const error = db.expectError(insertVersion(liveOnly, 200))
      expect(error).toContain('financial_proxy_versions_review_status_check')
    })

    it.each(['draft', 'under_review'])('NEGATIVE: the version-only token "%s" is REJECTED by the live CHECK', (versionOnly) => {
      const f = fixture()
      const error = db.expectError(`UPDATE public.financial_proxies SET review_status = '${versionOnly}' WHERE id = '${f.proxyId}'`)
      expect(error).toContain('review_status_check')
    })

    it('the two vocabularies share exactly the three terminal tokens', () => {
      const shared = LIVE_REVIEW_STATUSES.filter((s) => (VERSION_REVIEW_STATUSES as readonly string[]).includes(s))
      expect([...shared].sort()).toEqual(['approved', 'archived', 'rejected'])
    })
  })
})
