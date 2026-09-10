-- CE-1 -- CommercialAccount relation and live association (HPO-ODS-W2-26).
-- Generated cleanly by drizzle-kit generate; RLS is hand-authored below.
--
-- Authority: docs/ops/commercial/COMMERCIAL_ACCOUNT_CE1_EXECUTION_AUTHORITY_v1.0.0.json
-- and its docs/ops/commercial/COMMERCIAL_ACCOUNT_CE1_EXECUTION_AUTHORITY_AMENDMENT_v1.0.1.json.
--
-- commercial_accounts: structural existence only. No user_id, no membership,
-- no role, no Stripe column, no entitlement/quota column -- those move here
-- only at CE-3/CE-6. commercial_status is a closed four-value CHECK-constrained
-- lifecycle set; 'suspended' is the commercial-lifecycle state and is NEVER
-- organizations.status (PI-1).
--
-- organizations.commercial_account_id: NULLABLE, NO DEFAULT, NO CE-1 BACKFILL
-- (CE-4's job). Every existing row is NULL immediately after this migration.
-- FK ON DELETE RESTRICT: a CommercialAccount that still governs a live
-- Organization is not deletable. Index is an ordinary non-unique b-tree --
-- uniqueness would re-impose the 1:1 cardinality CC-4 exists to remove (one
-- CommercialAccount governs one-or-more Organizations, per CA-02).
--
-- SECURITY: commercial_accounts is NOT tenant data. ENABLE + FORCE ROW LEVEL
-- SECURITY with ZERO CREATE POLICY statements -- the strongest available
-- default-deny posture for a relation with no ratified tenant-facing access
-- pattern at all. FORCE additionally binds the table owner: even a migration
-- or application role that owns the table cannot read or write rows through
-- ordinary DML once RLS is forced. Platform Admin access is CE-8's, not CE-1's.
-- This is the first application table in this repository to combine
-- ENABLE + FORCE with zero policies -- deliberate, not an omission.

CREATE TABLE "commercial_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" varchar(255),
	"billing_country" varchar(2),
	"billing_contact_email" varchar(255),
	"commercial_status" varchar(50) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "commercial_status_check" CHECK ("commercial_accounts"."commercial_status" IN ('active', 'past_due', 'suspended', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "commercial_account_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_commercial_account_id_commercial_accounts_id_fk" FOREIGN KEY ("commercial_account_id") REFERENCES "public"."commercial_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_organizations_commercial_account_id" ON "organizations" USING btree ("commercial_account_id");--> statement-breakpoint

ALTER TABLE commercial_accounts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE commercial_accounts FORCE ROW LEVEL SECURITY;
-- ZERO CREATE POLICY statements. No tenant-facing policy of any kind.
