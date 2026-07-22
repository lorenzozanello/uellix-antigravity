# Supabase migration gate for the closed beta

Migrations `0034` through `0039` and policy `008` are versioned candidates only.
They must not be applied to production by an automated agent or as a side effect
of a Vercel deployment.

## Incident: 2026-07-22 production login outage

Production's `drizzle.__drizzle_migrations` journal stops at `0029_integrity`,
but an audit on 2026-07-22 found that RLS enablement, the RLS helper
functions (`current_user_is_super_admin`, `current_user_org_ids`,
`current_user_role_in_org`) and their `EXECUTE` grants, and all `CREATE
POLICY` statements from `0030_immutability` / `0031_rls_core` /
`0032_rls_specialized` were already live in production — applied manually,
outside the tracked migration flow, at an unknown prior date. The table-level
`GRANT SELECT/INSERT/UPDATE/DELETE` statements from `0033_public_api_grants`
were never applied alongside them, so every authenticated query against a
core business table failed with `permission denied for table ...`. This broke
login for 100% of users starting from whenever that partial RLS rollout
landed (`syncUserProfile()`'s `INSERT ... ON CONFLICT` on `public.users` is
the first authenticated write on every login, so it failed first).

Fix applied directly to production the same day, with the user's explicit
authorization, scoped to additive/reversible `GRANT` statements only:
- The table-level grants from `0033_public_api_grants.sql`.
- `INSERT` on `public.users` for `authenticated` — not part of the original
  `0033` design (which assumed a DB trigger would own inserts), but required
  because no such trigger exists; `0033_public_api_grants.sql` was updated to
  match this reality.

Not touched: `anon`'s table grants, `service_role` grants, and the `REVOKE
EXECUTE ON ALL FUNCTIONS ...` statement in `0033` (the existing `EXECUTE`
grants on the helper functions were already correct and revoking would have
re-broken them without also applying `0039` in the same pass).

**Net effect:** production's actual schema/grant state is now equivalent to
`0033_public_api_grants` applied on top of `0032_rls_specialized`, even
though the Drizzle journal still reports `0029`. Migrations `0034` onward
remain fully unapplied — see the audit below before trusting `0030`-`0033` as
"pending" in any future planning.

Post-fix audit (2026-07-22) of all 36 tables that exist in production:
- No table has RLS enabled without at least one matching policy.
- All `authenticated` grants now match `0033_public_api_grants.sql`'s intent
  (plus the `users` INSERT correction above).
- Confirmed via `information_schema.tables` that no `0034`-`0038` objects
  (`marketing_leads`, `organizations.stripe_customer_id`,
  `organizations.onboarding_completed`, `organizations.base_currency`,
  `users.deleted_at`, `users.deleted_by`) exist in production.

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
