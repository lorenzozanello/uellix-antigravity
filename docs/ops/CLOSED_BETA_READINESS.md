# Closed beta readiness decision

Date: 2026-07-21  
Branch: `codex/beta-stabilization`  
Decision: **local baseline passes; preview promotion remains gated**.

## Verified locally

- Next.js 16 production build completes and generates 44 routes.
- TypeScript has no errors.
- Unit suite passes: 75 files and 1,022 tests.
- ESLint has no errors (56 existing warnings remain).
- Production dependency audit reports no known vulnerabilities.
- Drizzle reports 37 tables and no migration drift.
- Secrets are excluded from Git and the environment contract is documented.
- The auth health endpoint does not expose PII or upstream errors.
- Stripe can remain unconfigured during build and returns a controlled runtime
  response when billing credentials are absent.
- Public lead validation no longer returns database details.

## Mandatory gates before a preview pilot

1. **Review the remaining working tree.** Marketing redesign, organization
   onboarding/settings, billing UI, public report verification, legal pages and
   distributed Stella limiting were inherited as uncommitted work. They are not
   part of the approved baseline merely because the combined working tree builds.
2. **Create an isolated Supabase preview.** Apply migrations only through
   `SUPABASE_MIGRATION_GATE.md`; then run integration and RLS tests there.
3. **Resolve remote-logo SSRF risk.** PDF rendering currently accepts an
   organization-provided URL. Require upload to a controlled storage origin (or
   implement a reviewed fetch proxy) before enabling white-label PDFs.
4. **Resolve Stella distributed-limit semantics.** The Redis path consumes at
   check time while the in-memory path records after context validation. Choose
   and test one consistent charging policy before enabling KV-based Stella limits.
5. **Legal/business approval.** Privacy and terms drafts contain contractual
   statements about retention, encryption, roles and report immutability. They
   must be approved against actual vendor contracts and operating practices.
6. **Configure preview-only services.** Verify Sentry DSN, Upstash credentials,
   Resend domain and optional Stripe test-mode credentials. Do not reuse
   production secrets in preview.
7. **Pilot UAT.** Exercise sign-in, organization isolation, invitation acceptance,
   project creation, SROI calculation, evidence upload, report lock/export and
   recovery/error paths using synthetic pilot data.

## Production gate

Production remains unchanged. Promotion requires a reviewed pull request, green
CI, preview sign-off, database backup/rollback evidence and an explicit human
go/no-go for both Vercel and Supabase.
