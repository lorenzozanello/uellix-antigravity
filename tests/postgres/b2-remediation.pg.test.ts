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
  deterministicUuid,
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

  // -------------------------------------------------------------------------
  // R-B2-03 — migration 0056 applied as part of the provision: the
  // editability column and CHECK exist, registry_version 1.1.0 is exhaustive
  // (70 rows) and 1.0.0 is byte-for-byte historical (39 rows, NULL
  // editability), and the governed model resolves 1.1.0 as current.
  // -------------------------------------------------------------------------
  describe('R-B2-03 — registry editability + 1.1.0 seed (real PostgreSQL)', () => {
    it('registry_version 1.1.0 holds exactly 70 rows, one per persisted column, every row classified on both dimensions', () => {
      expect(db.scalar(`SELECT count(*) FROM public.proxy_material_fields_registry WHERE registry_version = '1.1.0'`)).toBe('70')
      expect(db.scalar(`SELECT count(*) FROM public.proxy_material_fields_registry WHERE registry_version = '1.1.0' AND editability IS NULL`)).toBe('0')
      // Reflected from the live catalog, not from a list.
      const live = db.scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'financial_proxies'`)
      const ver = db.scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'financial_proxy_versions'`)
      expect(Number(live) + Number(ver)).toBe(70)
      const unregistered = db.query(`
        SELECT c.table_name || '.' || c.column_name
        FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name IN ('financial_proxies','financial_proxy_versions')
          AND NOT EXISTS (SELECT 1 FROM public.proxy_material_fields_registry r
                          WHERE r.registry_version = '1.1.0' AND r.table_name = c.table_name AND r.field_name = c.column_name)`)
      expect(unregistered).toEqual([])
      const phantom = db.query(`
        SELECT r.table_name || '.' || r.field_name FROM public.proxy_material_fields_registry r
        WHERE r.registry_version = '1.1.0' AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = r.table_name AND c.column_name = r.field_name)`)
      expect(phantom).toEqual([])
    })

    it('registry_version 1.0.0 is untouched: 39 rows, all with NULL editability', () => {
      expect(db.scalar(`SELECT count(*) FROM public.proxy_material_fields_registry WHERE registry_version = '1.0.0'`)).toBe('39')
      expect(db.scalar(`SELECT count(*) FROM public.proxy_material_fields_registry WHERE registry_version = '1.0.0' AND editability IS NOT NULL`)).toBe('0')
    })

    it('NC-7 (DB): no approval/audit metadata row is user_editable', () => {
      expect(db.scalar(`SELECT count(*) FROM public.proxy_material_fields_registry WHERE registry_version = '1.1.0' AND editability = 'user_editable' AND field_name IN ('review_status','reviewer_id','reviewed_at','created_by','created_at','updated_at','id','organization_id','financial_proxy_id','ordinal','supersedes_version_id')`)).toBe('0')
    })

    it('NEGATIVE: the editability CHECK rejects a value outside the frozen three', () => {
      const error = db.expectError(`INSERT INTO public.proxy_material_fields_registry (registry_version, table_name, field_name, category, editability) VALUES ('9.9.9','financial_proxies','id','non_material','anything_goes')`)
      expect(error).toContain('proxy_material_fields_registry_editability_check')
    })

    it('NEGATIVE: the category CHECK is unchanged — an eleventh material category is still rejected', () => {
      const error = db.expectError(`INSERT INTO public.proxy_material_fields_registry (registry_version, table_name, field_name, category, editability) VALUES ('9.9.9','financial_proxies','id','governance_metadata','system_sealed')`)
      expect(error).toContain('proxy_material_fields_registry_category_check')
    })

    it('manual-FX successor shape (R-B2-04, DB-relevant half): an approved V1 and its under_review V2 coexist, V2 carries its own fx_rate_id/value_usd, V1 keeps its own', () => {
      const f = seedProxyFixture(db, 'r4')
      const fxOld = deterministicUuid('r4:fx:old')
      const fxNew = deterministicUuid('r4:fx:new')
      // MEASURED on real PostgreSQL while writing this probe: shared fx_rates
      // rows (organization_id IS NULL) are unique per (currency, rate_date)
      // regardless of source_type (0017 fx_rates_shared_currency_date_unique).
      // Two manual entries for the same currency/reference year therefore
      // collide — a pre-existing property of the manual-FX path, outside this
      // remediation's nodes; recorded, not repaired. Distinct dates here.
      db.exec(`
        INSERT INTO public.fx_rates (id, currency, rate_date, rate_to_usd, source, source_type, organization_id, created_by)
          VALUES ('${fxOld}', 'EUR', '2023-12-31', '0.92', 'ECB', 'manual', NULL, '${f.userId}'),
                 ('${fxNew}', 'EUR', '2024-12-31', '0.90', 'ECB', 'manual', NULL, '${f.userId}')
          ON CONFLICT (id) DO NOTHING;
        INSERT INTO public.financial_proxy_versions (id, financial_proxy_id, ordinal, source_id, review_status, value_usd, fx_rate_id, reviewer_id, reviewed_at, created_by)
          VALUES ('${deterministicUuid('r4:v1')}', '${f.proxyId}', 1, '${f.sourceId}', 'approved', '100.0000', '${fxOld}', '${f.userId}', now(), '${f.userId}');
        INSERT INTO public.financial_proxy_versions (id, financial_proxy_id, ordinal, source_id, review_status, value_usd, fx_rate_id, supersedes_version_id, created_by)
          VALUES ('${deterministicUuid('r4:v2')}', '${f.proxyId}', 2, '${f.sourceId}', 'under_review', '102.2222', '${fxNew}', '${deterministicUuid('r4:v1')}', '${f.userId}');
      `)
      const rows = db.query(`SELECT ordinal, review_status, value_usd, fx_rate_id, supersedes_version_id IS NOT NULL FROM public.financial_proxy_versions WHERE financial_proxy_id = '${f.proxyId}' ORDER BY ordinal`)
      expect(rows).toEqual([
        ['1', 'approved', '100.0000', fxOld, 'f'],
        ['2', 'under_review', '102.2222', fxNew, 't'],
      ])
      // The unique (proxy, ordinal) constraint refuses a second "current".
      const dup = db.expectError(`INSERT INTO public.financial_proxy_versions (financial_proxy_id, ordinal, source_id, review_status, created_by) VALUES ('${f.proxyId}', 2, '${f.sourceId}', 'under_review', '${f.userId}')`)
      expect(dup).toContain('financial_proxy_versions_proxy_ordinal_unique')
    })

    it('governed_model_registry resolves PROXY_MATERIAL_FIELDS 1.1.0 as current and still holds 1.0.0', () => {
      const versions = db.query(`SELECT version FROM public.governed_model_registry WHERE model_id = 'PROXY_MATERIAL_FIELDS' ORDER BY version`).map((r) => r[0])
      expect(versions).toEqual(['1.0.0', '1.1.0'])
      expect(db.scalar(`SELECT version FROM public.governed_model_registry WHERE model_id = 'PROXY_MATERIAL_FIELDS' ORDER BY effective_from DESC LIMIT 1`)).toBe('1.1.0')
    })
  })
})
