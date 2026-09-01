-- FIBIU-06 — human evidence sufficiency determination, stage A/B
-- (FIBC-008/FIBDB-014). Generated cleanly by drizzle-kit generate; RLS is
-- hand-authored below, following the domain_object_versions pattern (0045):
-- org-scoped SELECT, INSERT restricted to the impact_manager+ floor
-- FIBC-008 names ("HUMAN BOUNDARY: impact_manager+ determines"), no
-- UPDATE/DELETE policy — this table is append-only by design (a
-- re-determination is ordinal+1, never an edit of an existing row).

CREATE TABLE "evidence_sufficiency_determinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"determination" varchar(20) NOT NULL,
	"rationale" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"determined_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_sufficiency_determinations_outcome_ordinal_unique" UNIQUE("outcome_id","ordinal"),
	CONSTRAINT "evidence_sufficiency_determinations_determination_check" CHECK ("evidence_sufficiency_determinations"."determination" IN ('sufficient', 'insufficient'))
);
--> statement-breakpoint
ALTER TABLE "evidence_sufficiency_determinations" ADD CONSTRAINT "evidence_sufficiency_determinations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_sufficiency_determinations" ADD CONSTRAINT "evidence_sufficiency_determinations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_sufficiency_determinations" ADD CONSTRAINT "evidence_sufficiency_determinations_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_sufficiency_determinations" ADD CONSTRAINT "evidence_sufficiency_determinations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_evidence_sufficiency_determinations_outcome_id" ON "evidence_sufficiency_determinations" USING btree ("outcome_id");--> statement-breakpoint
CREATE INDEX "idx_evidence_sufficiency_determinations_project_id" ON "evidence_sufficiency_determinations" USING btree ("project_id");--> statement-breakpoint

ALTER TABLE evidence_sufficiency_determinations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "evidence_sufficiency_determinations_select" ON evidence_sufficiency_determinations;--> statement-breakpoint
CREATE POLICY "evidence_sufficiency_determinations_select" ON evidence_sufficiency_determinations FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);--> statement-breakpoint

DROP POLICY IF EXISTS "evidence_sufficiency_determinations_insert" ON evidence_sufficiency_determinations;--> statement-breakpoint
CREATE POLICY "evidence_sufficiency_determinations_insert"
ON evidence_sufficiency_determinations FOR INSERT
WITH CHECK (
  actor_user_id = auth.uid()
  AND (
    current_user_role_in_org(organization_id) IN ('super_admin', 'organization_admin', 'impact_manager')
    OR current_user_is_super_admin()
  )
);
-- No UPDATE or DELETE policy → both are denied by RLS.