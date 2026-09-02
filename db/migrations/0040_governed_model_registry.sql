-- FIBIU-01 — governed model registry and PC-01B regime boundary, stage A
-- (FIBC-003/FIBDB-002, FIBC-004/FIBDB-003/FIBDB-042).
--
-- Hand-edited from the generated schema diff to bundle the deploy-time seed
-- (BACKFILL_CLASS: SCHEMA_ONLY — 8 fixed rows, never derived from data) with
-- the additive schema change. The stage-B boundary backfill is a separate
-- unit (0041) — its DML is data-derived, not literal, a different hosted
-- baseline-manifest classification (see db/hosted/baseline-manifest.ts).
--
-- governance_regime stays nullable here (stage A) — NOT NULL is stage-E
-- hardening, deferred to a later unit (FIBIU-30) per FIB §6.2.

CREATE TABLE "governed_model_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" varchar(100) NOT NULL,
	"version" varchar(20) NOT NULL,
	"effective_from" timestamp DEFAULT now() NOT NULL,
	"definition_hash" varchar(64) NOT NULL,
	CONSTRAINT "governed_model_registry_model_version_unique" UNIQUE("model_id","version")
);
--> statement-breakpoint
-- Read-only catalog grant, mirroring 0033_public_api_grants.sql's
-- taxonomy_catalogs/taxonomy_codes treatment (no INSERT/UPDATE/DELETE).
GRANT SELECT ON public.governed_model_registry TO authenticated;--> statement-breakpoint
-- Seed the eight governed-model rows (FIBC-003). Six carry the exact literal
-- identities named by the sealed baseline; the methodology row reuses the
-- real sealed hash of docs/ops/pc01b/PC01B_HUMAN_METHODOLOGY_AUTHORITY_v1.0.0
-- (canonical_authority_sha256 in its .seal.json) rather than an invented one;
-- the engine row uses the same deterministic identity-hash function as the
-- other five (see lib/pipeline/governed-model-registry.ts) since no equivalent
-- sealed engine artifact exists yet. ON CONFLICT DO NOTHING keeps this
-- idempotent on rerun.
INSERT INTO "governed_model_registry" ("model_id", "version", "definition_hash") VALUES
	('SROI_READINESS_MODEL', '1.0.0', '8a03303659523fd750450f5bb33e214e4dda4247f751973054953f9e3c8fb53c'),
	('PROXY_DEFENDIBILITY_RUBRIC', '1.0.0', '5a0bd786b9a30929e375fd039c4f1ffdd3f628cd23425588d3874362e19d40a6'),
	('SROI_SENSITIVITY_MODEL', '1.0.0', 'c5ce3900884b140b891a18109259b21121fa682ab1e6111592c416b39a78a0d8'),
	('PUBLIC_REPORT_VERIFICATION_POLICY', '1.0.0', '72e34a0dbf48ce35ae9f9bf283f89157be6f90cee05e4dbd93069a9f485afa81'),
	('PROXY_MATERIAL_CHANGE_POLICY', '1.0.0', '0df037797db3414a6f0bf16ddc87cf9534f748f7f427288c389cf460e268267a'),
	('PROXY_MATERIAL_FIELDS', '1.0.0', 'd96ada4ebc157880a1eb3911fb942c33da68df9b44a4589ef53b947add7d582f'),
	('PC01B_HUMAN_METHODOLOGY_AUTHORITY', '1.0.0', '03212c661f07200d128c2374173f7bbd996b8eab0f3eb1b59cd517187f159938'),
	('SROI_CALCULATION_ENGINE', '1.0.0', '3bb83a2d00ab2847f7c62f6c67a748e2371cf13806dbb99c6db0690be800318c')
ON CONFLICT ("model_id", "version") DO NOTHING;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "governance_regime" varchar(20);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_governance_regime_check" CHECK ("projects"."governance_regime" IN ('pre_pc01b', 'pc01b'));
