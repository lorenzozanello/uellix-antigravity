# Uellix Closed Beta Stabilization Design

**Date:** 2026-07-21  
**Status:** Approved for execution by the product owner  
**Target:** Assisted closed beta with organizations and pilot projects that already exist in Supabase

## Objective

Open a controlled commercial beta without replacing the current Vercel production deployment until a preview candidate proves safer than the deployed version. The beta prioritizes tenant isolation, reproducible SROI output, evidence integrity, report generation, and rapid rollback over self-service billing or broad public acquisition.

## Non-negotiable constraints

- Preserve the current Vercel production deployment and its rollback path.
- Work only on `codex/beta-stabilization` until review.
- Do not mutate Supabase production or promote a Vercel deployment without a human gate.
- Do not expose secrets or commit environment values.
- Keep Stella disabled for real pilot data until the Google DPA and data-retention review is approved.
- Do not claim that Uellix certifies impact.
- Do not describe a report as cryptographically immutable until its content is canonically hashed and database-level immutability is enforced.
- Every production code correction follows a failing-test-first cycle when behavior can be tested.

## Delivery strategy

### Workstream A — Technical baseline

Create a reproducible candidate that passes lint, TypeScript, unit tests, and the Next.js production build. Resolve the Next.js 16 `middleware.ts`/`proxy.ts` conflict using `proxy.ts`, consolidate security behavior there, repair stale application types, and stabilize PDF rendering tests.

### Workstream B — Beta safety

Disable or correct misleading public behavior, particularly the SROI lead calculator and public report integrity claim. Keep billing manual for pilots. Validate environment contracts and make remote database migration commands explicit and guarded.

### Workstream C — Tenant and methodology validation

Run integration tests against an isolated Supabase instance, then execute a two-organization RLS matrix and a complete Golden Path. Compare the application SROI result with the independent control calculation and retain an evidence record of every step.

### Workstream D — Preview and operations

Create a Vercel preview from the stabilization branch, run authenticated smoke tests, prepare rollback and incident runbooks, and issue a GO/NO-GO report. Production promotion remains a separate human-approved action.

## Release gates

### Gate 1 — Local candidate

- `pnpm lint` exits 0.
- `pnpm typecheck` exits 0.
- `pnpm test:unit` exits 0 with no failed tests.
- `pnpm build` exits 0.
- No secrets or `.env` files are tracked.

### Gate 2 — Isolated data validation

- All Drizzle migrations rebuild an empty local Supabase database.
- RLS tests pass using authenticated clients from two organizations.
- Evidence Storage denies cross-organization access.
- Locked calculation records and audit logs reject mutation.

### Gate 3 — Pilot workflow

- One pilot completes login, project access, evidence upload, proxy assignment, SROI calculation, human review, report lock, and PDF export.
- The SROI result matches the independent control model under identical assumptions.
- A second organization cannot access any resource from the first.

### Gate 4 — Preview readiness

- Preview environment uses non-production data or explicitly approved staging data.
- Sentry receives a controlled test event.
- Rollback owner, support channel, and incident criteria are documented.
- The product owner approves production promotion.

## Deferred from the closed beta

- Self-service Stripe checkout.
- Public onboarding for unrestricted organizations.
- Production Stella processing of real evidence or personal data.
- Blockchain or external anchoring.
- Claims of certification or cryptographic report immutability.

## Failure and rollback policy

Any cross-tenant exposure, incorrect SROI result, evidence integrity failure, destructive migration, or inability to generate the contractual report is an immediate NO-GO. The existing Vercel deployment remains untouched, and all database work is first rehearsed outside production with a documented rollback.
