-- 0016 — snapshot reconciliation: fold the manual numeric-columns migration
-- into the drizzle-kit chain.
--
-- REPARACIÓN HISTÓRICA EXCEPCIONAL (15-Jul-2026):
-- Corrige la reconstrucción de bases de datos limpias locales/CI añadiendo
-- cláusulas USING explícitas.
-- No debe ejecutarse manualmente contra producción.
-- No se considera automáticamente un no-op en bases existentes.
--
-- The money/quantity/ratio columns were converted varchar -> numeric via the
-- out-of-band db/manual-migrations/003_numeric_columns.sql, which drizzle-kit
-- never captured in a snapshot. As a result the latest snapshot (0015) still
-- described these columns as varchar, so `drizzle-kit generate` kept
-- re-proposing this exact diff. This migration + its snapshot make the drizzle
-- model match reality, so future `generate` runs are clean (needed before the
-- Fase 1 FX tables are generated).
--
-- Idempotent against any environment that already applied 003 (production):
-- SET DATA TYPE numeric on an already-numeric column is a no-op, and the CHECK
-- constraints are dropped-if-present then re-added identically. A fresh
-- environment applying 0000..0015 through drizzle (which never converts to
-- numeric) reaches the numeric state here instead of needing 003 separately.

ALTER TABLE "project_investments" DROP CONSTRAINT IF EXISTS "project_investments_amount_check";--> statement-breakpoint
ALTER TABLE "sroi_assignment_inputs" DROP CONSTRAINT IF EXISTS "sroi_assignment_inputs_quantity_check";--> statement-breakpoint
ALTER TABLE "financial_proxies" ALTER COLUMN "value" SET DATA TYPE numeric(20, 4) USING NULLIF(BTRIM("value"::text), '')::numeric(20, 4);--> statement-breakpoint
ALTER TABLE "project_investments" ALTER COLUMN "amount" SET DATA TYPE numeric(20, 4) USING NULLIF(BTRIM("amount"::text), '')::numeric(20, 4);--> statement-breakpoint
ALTER TABLE "sroi_assignment_inputs" ALTER COLUMN "quantity" SET DATA TYPE numeric(20, 4) USING NULLIF(BTRIM("quantity"::text), '')::numeric(20, 4);--> statement-breakpoint
ALTER TABLE "sroi_calculation_line_items" ALTER COLUMN "quantity" SET DATA TYPE numeric(20, 4) USING NULLIF(BTRIM("quantity"::text), '')::numeric(20, 4);--> statement-breakpoint
ALTER TABLE "sroi_calculation_line_items" ALTER COLUMN "proxy_value" SET DATA TYPE numeric(20, 4) USING NULLIF(BTRIM("proxy_value"::text), '')::numeric(20, 4);--> statement-breakpoint
ALTER TABLE "sroi_calculation_line_items" ALTER COLUMN "gross_value" SET DATA TYPE numeric(20, 4) USING NULLIF(BTRIM("gross_value"::text), '')::numeric(20, 4);--> statement-breakpoint
ALTER TABLE "sroi_calculation_line_items" ALTER COLUMN "adjusted_value" SET DATA TYPE numeric(20, 4) USING NULLIF(BTRIM("adjusted_value"::text), '')::numeric(20, 4);--> statement-breakpoint
ALTER TABLE "sroi_calculation_runs" ALTER COLUMN "total_investment" SET DATA TYPE numeric(20, 4) USING NULLIF(BTRIM("total_investment"::text), '')::numeric(20, 4);--> statement-breakpoint
ALTER TABLE "sroi_calculation_runs" ALTER COLUMN "gross_social_value" SET DATA TYPE numeric(20, 4) USING NULLIF(BTRIM("gross_social_value"::text), '')::numeric(20, 4);--> statement-breakpoint
ALTER TABLE "sroi_calculation_runs" ALTER COLUMN "net_social_value" SET DATA TYPE numeric(20, 4) USING NULLIF(BTRIM("net_social_value"::text), '')::numeric(20, 4);--> statement-breakpoint
ALTER TABLE "sroi_calculation_runs" ALTER COLUMN "sroi_ratio" SET DATA TYPE numeric(20, 6) USING NULLIF(BTRIM("sroi_ratio"::text), '')::numeric(20, 6);--> statement-breakpoint
ALTER TABLE "project_investments" ADD CONSTRAINT "project_investments_amount_check" CHECK ("project_investments"."amount" > 0);--> statement-breakpoint
ALTER TABLE "sroi_assignment_inputs" ADD CONSTRAINT "sroi_assignment_inputs_quantity_check" CHECK ("sroi_assignment_inputs"."quantity" > 0);
