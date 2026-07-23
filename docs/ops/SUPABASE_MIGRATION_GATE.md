# Supabase migration gate for the closed beta

Four pieces remain versioned candidates only, and must not be applied to
production by an automated agent or as a side effect of a Vercel deployment:
- `0035_phase5_marketing_leads.sql` + RLS policy `008`
  (`db/policies/008_marketing_leads_rls.sql`)
- `supabase/migrations/20260716000000_auth_trigger.sql` — the
  `auth.users` → `public.users` sync trigger that `0033`'s "trigger manages
  INSERT" comment assumed existed. It never got applied; found 2026-07-22
  while scoping this gate.
- `supabase/migrations/20260716000001_storage_policies.sql` — Storage RLS for
  the `uellix-evidence` bucket. Supersedes `0039_grant_rls_helper_execution.sql`
  (see that file's header); apply this one instead.

`0034`, `0036`, `0037`, and `0038` are **already live in production** — see
the 2026-07-22 incident below.

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

## Follow-up hardening: 2026-07-22 Supabase linter warnings

The same day, Supabase's database linter reported: `uellix_forbid_mutation`
had a mutable `search_path`, and the three core RLS helper functions were
callable as public RPC endpoints by both `anon` and `authenticated` (Supabase
rules 0011, 0028, 0029). Applied directly to production with the user's
authorization:

- `ALTER FUNCTION public.uellix_forbid_mutation() SET search_path = ''` —
  the function only touches trigger-local variables, so this has no
  functional effect.
- Moved `current_user_is_super_admin`, `current_user_org_ids`, and
  `current_user_role_in_org` from `public` to a new `private` schema, with
  `GRANT USAGE ON SCHEMA private` limited to `authenticated` (never `anon` or
  `PUBLIC`). PostgREST only auto-exposes `public` as RPC, so this fully closes
  both the `anon` and `authenticated` "SECURITY DEFINER function executable
  via RPC" warnings without touching the RLS policies that call them — those
  reference the functions by OID, resolved at each `CREATE POLICY`, and are
  unaffected by a later schema move. Verified inline (transaction, rolled
  back for the negative check): `authenticated` can still read every
  RLS-protected table exercised, and `anon` gets `permission denied for
  schema private` when attempting to call the moved functions directly.
- `0030_immutability.sql`, `0031_rls_core.sql`, `0032_rls_specialized.sql`,
  and `0039_grant_rls_helper_execution.sql` were updated in the same commit
  so a future preview/prod apply of these still-pending migration files
  produces the same `private`-schema layout production now actually has.
  `0039` no longer grants the three core helpers — `0031` now creates and
  grants them directly — since they never sit in `public` for `0033`'s
  blanket revoke to touch in the first place.

Not addressed (needs a human, not SQL): Supabase Auth's "Leaked password
protection" is a project Auth setting, not a database object — enable it at
Authentication → Policies → Password Security in the Supabase dashboard.

## Incident continued: 2026-07-22 login outage, real root cause

The grant fix above did not actually resolve the login outage — a user
report of the same "Something went wrong" error after the grant fix proved
it. Re-investigation found the true cause: production's Drizzle client
connects via `DATABASE_URL` as the `postgres` role, which has `rolbypassrls`
and owns every table, so **RLS and grants were never the blocker for the
app's own server-side queries** — that whole first fix was real, correct
hardening, but orthogonal to this outage.

The actual cause: `db/schema.ts` (already deployed) defines columns that only
exist starting in migrations `0034`, `0036`, `0037`, and `0038`, none of
which had been applied to production. Since Drizzle generates explicit
column lists (not `SELECT *`), every `db.select().from(users)` or
`db.select().from(organizations)` failed with `column "..." does not exist`,
reproduced directly against production using the app's own `db` client and
schema imports:

```
db.select().from(users) -> column "deleted_at" does not exist
db.select().from(organizations) -> column "stripe_customer_id" does not exist
```

Fix: the user applied the `ALTER TABLE ADD COLUMN` / `ADD CONSTRAINT`
statements from `0034_phase3_white_label.sql`, `0036_phase2_onboarding.sql`,
`0037_phase1_stripe.sql`, and `0038_sprint_a_gdpr_users.sql` directly via the
Supabase SQL editor on 2026-07-22 — purely additive (no `DROP`), safe against
the closed beta's small row count. Re-verified with the same reproduction:
all four tables (`users`, `organizations`, `organization_members`,
`sroi_reports`) now select cleanly through the real `db` client, and the user
confirmed login works end-to-end on uellix.com.

`0035_phase5_marketing_leads.sql` + policy `008`, and the two Storage helper
`GRANT`s in `0039`, remain unapplied — nothing in the login/dashboard path
depends on them. The Drizzle journal (`drizzle.__drizzle_migrations`) still
does not reflect any of `0030` through `0038` — see "reconcile the journal"
below before running `pnpm db:migrate` against production.

## Required approval sequence (scope: marketing leads, auth trigger, Storage RLS)

1. Create or select an isolated Supabase preview project with no production data.
2. Record a production backup and confirm that a human can restore it.
3. Review the SQL and approve this order: `0035_phase5_marketing_leads.sql`,
   `db/policies/008_marketing_leads_rls.sql`,
   `supabase/migrations/20260716000000_auth_trigger.sql`,
   `supabase/migrations/20260716000001_storage_policies.sql`. Skip
   `0039_grant_rls_helper_execution.sql` entirely — superseded, see its header.
4. Apply the candidate SQL to preview only.
5. Run the integration/RLS suite against preview and exercise: marketing lead
   submission (anon), signup/login end-to-end (to exercise the new auth
   trigger instead of the app-level `syncUserProfile` upsert), and an evidence
   file upload/download in the app.
6. Review logs and row counts; verify that anonymous users can only insert
   marketing leads and cannot read/update/delete them; verify the auth
   trigger correctly populates `public.users` on signup without relying on
   the `authenticated` INSERT grant added during the 2026-07-22 incident
   (that grant can stay as defense-in-depth either way).
7. Obtain an explicit human go/no-go decision before any production migration.

## Rollback plan to review before approval

- `0039`: revoke `EXECUTE` from `authenticated` on the two Storage helpers
  granted by this migration. Not yet applied.
- `0038` (already live): drop `users.deleted_by`, then `users.deleted_at`.
- `0037` (already live): drop the Stripe unique constraints, then the three
  Stripe columns.
- `0036` (already live): drop `organizations.onboarding_completed`, then
  `base_currency`.
- `0035` + policy `008`: export leads if required, then drop
  `marketing_leads` (its policies are removed with the table). Not yet applied.
- `0034` (already live): drop the report hash constraint and column, then the
  three branding columns.

Production rollback commands must be prepared and peer-reviewed for the actual
Supabase schema before execution; this document is a checklist, not execution
authorization.

## Resolved: Drizzle migration journal reconciled (2026-07-22)

`drizzle.__drizzle_migrations` was stuck at `0029_integrity` while production
actually matched `0030`-`0034`, `0036`-`0038` (plus the `private`-schema
hardening). Inserted rows for those 8 migrations using the same
`sha256(file content)` hash `drizzle-orm`'s migrator itself computes
(`node_modules/drizzle-orm/migrator.cjs`), with `created_at` taken from each
entry's `when` in `meta/_journal.json`. `0035` and `0039` were deliberately
left out since they're still not applied. Verified by reproducing
`drizzle-kit migrate`'s own file-vs-journal-hash comparison: only `0035` and
`0039` now show as pending.

**Separate, pre-existing finding (not fixed, out of scope):** that same
comparison shows `0010`, `0013`-`0019`, `0021`-`0023`, and `0026`-`0029` also
hash-mismatch against the journal — their on-disk content has diverged from
whatever was actually applied to production back when each one ran (edited
post-hoc in the repo, most likely). This predates today's incident and isn't
blocking anything; flagging it here so a future `pnpm db:migrate` doesn't
get run against production without someone deciding how to handle it first
(likely: diff each file against its git history at apply time, or just
re-hash-reconcile the same way once confirmed harmless).
