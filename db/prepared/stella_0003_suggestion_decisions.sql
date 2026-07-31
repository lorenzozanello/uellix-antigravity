-- db/prepared/stella_0003_suggestion_decisions.sql
-- WS3b (persistence & DB security): stella_suggestion_decisions table.
--
-- PREPARED ONLY — NOT A MIGRATION. This file lives in db/prepared/ (never in
-- db/migrations/, where drizzle-kit would apply it). Application to any
-- database is the external gate G2, executed manually by Lorenzo following
-- docs/ops/gates/G2_PACKAGE.md and the process in
-- docs/ops/SUPABASE_MIGRATION_GATE.md. Rollback: stella_0003_rollback.sql.
--
-- PURPOSE: records what humans DID with Stella suggestions (accepted,
-- accepted with edits, rejected, undone) — the human-in-the-loop half of the
-- AI audit trail. The consuming server action
-- (app/actions/stella/decisions.ts, recordStellaDecision) ships DORMANT
-- behind STELLA_DECISIONS_PERSISTENCE_ENABLED=false and must stay off until
-- this script has been applied through G2.
--
-- PRIVACY INVARIANT: previous_value_hash stores a SHA-256 hex digest of the
-- value a suggestion replaced — NEVER the raw previous text. The hash is
-- computed server-side in recordStellaDecision. applied_text may store the
-- text that was actually applied (it becomes project content anyway).

CREATE TABLE IF NOT EXISTS stella_suggestion_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  -- The stella_interactions row whose suggestion was decided on; NULL when the
  -- UI cannot attribute the decision to a specific interaction.
  interaction_id uuid REFERENCES stella_interactions(id),
  -- Stable key identifying WHICH suggestion inside the interaction payload
  -- (e.g. 'advisor.suggested_next_actions[2]') — assigned by the UI layer.
  suggestion_key text NOT NULL,
  decision text NOT NULL,
  -- SHA-256 (hex) of the replaced value; raw previous text is never persisted.
  previous_value_hash text,
  applied_text text,
  rejection_reason text,
  -- Same user-FK convention as stella_interactions.created_by (public.users).
  decided_by uuid NOT NULL REFERENCES users(id),
  decided_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT stella_suggestion_decisions_decision_check
    CHECK (decision IN ('accepted', 'accepted_edited', 'rejected', 'undone')),
  CONSTRAINT stella_suggestion_decisions_prev_hash_check
    CHECK (previous_value_hash IS NULL OR previous_value_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_stella_suggestion_decisions_org_decided_at
  ON stella_suggestion_decisions (organization_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_stella_suggestion_decisions_interaction_id
  ON stella_suggestion_decisions (interaction_id);

-- ============================================================
-- Grants (0033 style — stricter than append-only: SELECT only;
-- INSERT happens exclusively via the service-role Drizzle client)
-- ============================================================
GRANT SELECT ON public.stella_suggestion_decisions TO authenticated;

-- ============================================================
-- RLS (mirrors db/policies/002_stella_interactions_rls.sql posture)
-- ============================================================
--   - SELECT: org members read their own org's decisions; super_admin sees all
--   - No INSERT policy: inserts are strictly server-side via the service-role
--     client (recordStellaDecision), which bypasses RLS — identical to
--     stella_interactions
--   - No UPDATE policy: decisions are immutable ('undone' is a NEW row, not an
--     update of the original decision)
--   - No DELETE policy: audit-trail integrity

ALTER TABLE stella_suggestion_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stella_suggestion_decisions_select" ON stella_suggestion_decisions;
CREATE POLICY "stella_suggestion_decisions_select"
ON stella_suggestion_decisions FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);

-- No INSERT policy -> INSERT denied via RLS (service role only)
-- No UPDATE policy -> UPDATE denied (immutable decisions)
-- No DELETE policy -> DELETE denied (audit trail integrity)

COMMENT ON TABLE stella_suggestion_decisions IS
  'Human decisions over Stella suggestions (WS3b, prepared stella_0003, gate G2). previous_value_hash is a SHA-256 digest — raw previous text is never stored.';
