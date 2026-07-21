# Supabase migration gate for the closed beta

Migrations `0034` through `0039` and policy `008` are versioned candidates only.
They must not be applied to production by an automated agent or as a side effect
of a Vercel deployment.

## Required approval sequence

1. Create or select an isolated Supabase preview project with no production data.
2. Record a production backup and confirm that a human can restore it.
3. Confirm that the Storage helpers `can_read_evidence_object(text, uuid)` and
   `can_write_evidence_object(text, uuid)` already exist in preview, then review
   the SQL and approve the order: `0034`, `0035`, policy `008`, `0036`, `0037`,
   `0038`, `0039`.
4. Apply the candidate SQL to preview only.
5. Run the integration/RLS suite against preview and exercise organization
   onboarding, report verification, marketing leads and billing-disabled paths.
6. Review logs and row counts; verify that anonymous users can only insert
   marketing leads and cannot read, update or delete them.
7. Obtain an explicit human go/no-go decision before any production migration.

## Rollback plan to review before approval

Rollback is performed in reverse order and may discard data written into new
columns or `marketing_leads`. Export that data first if the preview/pilot has
started using it.

- `0039`: revoke `EXECUTE` from `authenticated` on the three core RLS helpers
  and two Storage helpers granted by this migration.
- `0038`: drop `users.deleted_by`, then `users.deleted_at`.
- `0037`: drop the Stripe unique constraints, then the three Stripe columns.
- `0036`: drop `organizations.onboarding_completed`, then `base_currency`.
- `0035` + policy `008`: export leads if required, then drop
  `marketing_leads` (its policies are removed with the table).
- `0034`: drop the report hash constraint and column, then the three branding
  columns.

Production rollback commands must be prepared and peer-reviewed for the actual
Supabase schema before execution; this document is a checklist, not execution
authorization.
