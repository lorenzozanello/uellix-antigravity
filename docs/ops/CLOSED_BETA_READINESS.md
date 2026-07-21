# Closed beta readiness decision

Date: 2026-07-21  
Branch: `codex/beta-stabilization`  
Decision: **local candidate passes; PR and Vercel Preview review are authorized**.

## Verified locally

- Next.js 16 production build completes; static generation finishes 44/44.
- TypeScript has no errors.
- Unit suite passes: 78 files and 1,027 tests.
- ESLint has no errors (54 existing warnings remain).
- Production dependency audit reports no known vulnerabilities.
- Drizzle reports 37 tables and no migration drift.
- Secrets are excluded from Git and the environment contract is documented.
- The auth health endpoint does not expose PII or upstream errors.
- Stripe can remain unconfigured during build and returns a controlled runtime
  response when billing credentials are absent.
- Public lead validation no longer returns database details.
- Organization logos are limited to the configured HTTPS Supabase public-storage origin at write and PDF-render boundaries.
- Stella hourly limits consume one token atomically immediately before each Gemini attempt and fail closed if the distributed limiter is unavailable.
- Commercial lead capture reports success only after a successful API response; onboarding's fallback country uses the valid reserved code `ZZ`.
- Production dependencies have no known advisories; vulnerable optional MCP runtime code is excluded and Sharp is pinned to the compatible patched release validated by the production build.

## Completed preview-readiness gates

1. **Inherited working tree reviewed and committed.** Marketing, organization
   onboarding/settings, billing-disabled behavior, public verification, audit
   fixtures, and legal pages are part of the reviewed stabilization commits.
2. **Remote-logo SSRF mitigated.** Only the configured Supabase public-storage
   origin reaches PDF rendering.
3. **Stella distributed-limit semantics unified.** Memory and Upstash paths use
   one atomic consume operation at the model-attempt boundary.
4. **Product-owner approval recorded.** The product owner approved the full
   stabilization set, including the privacy and terms copy, for preview review.

## Mandatory gates before pilot runtime activation

1. **Create an isolated Supabase preview.** Apply migrations only through
   `SUPABASE_MIGRATION_GATE.md`; then run integration and RLS tests there.
2. **Verify legal claims operationally.** Before production, confirm retention,
   encryption, processor/controller roles and immutability language against the
   actual vendor contracts and operating controls.
3. **Configure preview-only services.** Verify Sentry DSN, Upstash credentials,
   Resend domain and optional Stripe test-mode credentials. Do not reuse
   production secrets in preview.
4. **Pilot UAT.** Exercise sign-in, organization isolation, invitation acceptance,
   project creation, SROI calculation, evidence upload, report lock/export and
   recovery/error paths using synthetic pilot data.

## Production gate

Production remains unchanged. Promotion requires a reviewed pull request, green
CI, preview sign-off, database backup/rollback evidence and an explicit human
go/no-go for both Vercel and Supabase.
