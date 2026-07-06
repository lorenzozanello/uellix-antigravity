ALTER TABLE "evidence_items" ADD COLUMN "confidence_score" integer;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD COLUMN "confidence_calculated_at" timestamp;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD COLUMN "integrity_verified" boolean;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD COLUMN "integrity_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_confidence_score_check" CHECK ("evidence_items"."confidence_score" IS NULL OR ("evidence_items"."confidence_score" >= 0 AND "evidence_items"."confidence_score" <= 100));