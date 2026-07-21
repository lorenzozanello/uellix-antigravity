-- =============================================================================
-- 008: Marketing Leads RLS
-- Sprint A (Security Audit): Restrict access to super_admins only.
-- Marketing leads contain email PII and must be protected.
-- =============================================================================

ALTER TABLE marketing_leads ENABLE ROW LEVEL SECURITY;

-- Super admins can read all leads (for CRM / sales pipeline)
CREATE POLICY "super_admins_read_marketing_leads"
  ON marketing_leads FOR SELECT
  TO authenticated
  USING (current_user_is_super_admin());

-- Anonymous users can INSERT leads (public demo request form)
CREATE POLICY "anon_insert_marketing_leads"
  ON marketing_leads FOR INSERT
  TO anon
  WITH CHECK (true);

-- Authenticated users can also submit leads (e.g., from the app)
CREATE POLICY "authenticated_insert_marketing_leads"
  ON marketing_leads FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- No UPDATE or DELETE policies — leads are append-only for data integrity.
