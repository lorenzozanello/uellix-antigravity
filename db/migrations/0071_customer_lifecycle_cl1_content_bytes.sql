-- CL-1 -- presentation-binding repair (independent-audit continuation,
-- HPO-ODS-W2-28). The authority's REQUIRED_ACCEPTANCE_EVIDENCE_FLOOR does not
-- require retained bytes, but the CL1-S4/S5 acceptance SURFACE cannot show a
-- subject "the exact localized/versioned instrument shown" without SOMETHING
-- to display, and 0070 shipped with none. content_bytes is OPTIONAL retained
-- content (I-T2-4 R4 / WHY_RETENTION_IS_STILL_RECOMMENDED, RECOMMENDED_NOT_
-- REQUIRED, never NOT NULL) -- a version that omits it is still fully
-- conformant and simply cannot be presented for accept (fail closed, not a
-- UI crash; see lib/auth/legal-acceptance.ts loadRequiredInstrumentsPendingAcceptance).
--
-- No RLS change: legal_instrument_versions' existing read-open/write-closed
-- posture (0070) already covers this column -- ADD COLUMN needs no new
-- policy, and there is still no tenant-role write path onto this table.
--
-- Generated cleanly by `drizzle-kit generate` from db/schema.ts. No
-- hand-authored SQL below the generated statement.

ALTER TABLE "legal_instrument_versions" ADD COLUMN "content_bytes" text;
