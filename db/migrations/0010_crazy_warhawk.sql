-- Sprint 6B correctiva: snapshot_json + columnas reales en sroi_calculation_runs y sroi_calculation_line_items
--> statement-breakpoint
ALTER TABLE "sroi_calculation_runs"
  ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "currency" varchar(10),
  ADD COLUMN IF NOT EXISTS "gross_social_value" varchar(255),
  ADD COLUMN IF NOT EXISTS "net_social_value" varchar(255),
  ADD COLUMN IF NOT EXISTS "snapshot_json" jsonb,
  ADD COLUMN IF NOT EXISTS "calculated_by" uuid REFERENCES "public"."users"("id"),
  ADD COLUMN IF NOT EXISTS "calculated_at" timestamp DEFAULT now();
--> statement-breakpoint
ALTER TABLE "sroi_calculation_runs" DROP CONSTRAINT IF EXISTS "sroi_calculation_runs_run_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "sroi_calculation_runs" DROP COLUMN IF EXISTS "run_by";
--> statement-breakpoint
-- Renombrar columnas legacy si existen (run_by -> calculated_by ya gestionado arriba como nueva columna)
-- total_value -> net_social_value ya se añade como nueva columna
-- Ajustar constraint de status para incluir 'calculated'
ALTER TABLE "sroi_calculation_runs" DROP CONSTRAINT IF EXISTS "sroi_calculation_runs_status_check";
--> statement-breakpoint
ALTER TABLE "sroi_calculation_runs"
  ADD CONSTRAINT "sroi_calculation_runs_status_check"
  CHECK ("sroi_calculation_runs"."status" IN ('calculated', 'failed', 'pending'));
--> statement-breakpoint
-- Añadir columnas de desglose real a line_items
ALTER TABLE "sroi_calculation_line_items"
  ADD COLUMN IF NOT EXISTS "outcome_id" uuid REFERENCES "public"."outcomes"("id"),
  ADD COLUMN IF NOT EXISTS "proxy_id" uuid REFERENCES "public"."financial_proxies"("id"),
  ADD COLUMN IF NOT EXISTS "quantity" varchar(255),
  ADD COLUMN IF NOT EXISTS "proxy_value" varchar(255),
  ADD COLUMN IF NOT EXISTS "currency" varchar(10),
  ADD COLUMN IF NOT EXISTS "adjusted_value" varchar(255),
  ADD COLUMN IF NOT EXISTS "deadweight_pct" varchar(255),
  ADD COLUMN IF NOT EXISTS "attribution_pct" varchar(255),
  ADD COLUMN IF NOT EXISTS "displacement_pct" varchar(255),
  ADD COLUMN IF NOT EXISTS "dropoff_pct" varchar(255),
  ADD COLUMN IF NOT EXISTS "duration_years" integer;