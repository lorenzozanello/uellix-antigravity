# Uellix Beta Technical Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a closed-beta candidate that passes all local release gates without modifying Supabase or Vercel production.

**Architecture:** Retain Next.js 16 `proxy.ts` as the single request interception entry point and move the security behavior currently duplicated in `middleware.ts` into focused, testable helpers. Repair type drift between the Drizzle organization model and application session types, then address isolated API, Sentry, invitation, report, UI, and PDF failures one root cause at a time.

**Tech Stack:** Next.js 16.2.9, React 19.2.4, TypeScript 5, Vitest 4, Supabase SSR, Drizzle ORM, Sentry, pnpm 9.

## Global Constraints

- Work only on `codex/beta-stabilization`.
- Preserve the current Vercel production deployment.
- Do not mutate Supabase or Vercel production.
- Read the relevant Next.js 16 guide in `node_modules/next/dist/docs/` before changing proxy conventions.
- Use failing tests before behavior changes.
- Stage and commit only files belonging to the current task.
- Do not commit `.env`, `.env.local`, credentials, or generated `.next` files.

---

### Task 1: Preserve and document the baseline

**Files:**
- Modify: `.gitignore`
- Create: `.env.example`
- Create: `docs/ops/BETA_RELEASE_BASELINE.md`

**Interfaces:**
- Consumes: environment variable names already used by `app/`, `lib/`, Sentry, Stripe, Supabase, and Upstash.
- Produces: a versioned environment contract and a release baseline record with no secret values.

- [ ] **Step 1: Capture branch, status, current commit, and validation failures in the baseline document.**
- [ ] **Step 2: Change `.gitignore` from a blanket `.env*` exclusion to `.env*` plus `!.env.example`.**
- [ ] **Step 3: Populate `.env.example` with names, safe empty values, and comments describing preview/production ownership.**
- [ ] **Step 4: Verify secrets are not tracked.**

Run: `git ls-files .env .env.local`  
Expected: no output.

- [ ] **Step 5: Commit only the baseline files.**

### Task 2: Consolidate the Next.js 16 proxy boundary

**Files:**
- Delete: `middleware.ts`
- Modify: `proxy.ts`
- Modify: `lib/supabase/proxy.ts`
- Create: `tests/proxy-security.test.ts`

**Interfaces:**
- Produces: `applySecurityHeaders(response: NextResponse): NextResponse` and `extractClientIp(request: NextRequest): string`.
- Preserves: `proxy(request: NextRequest): Promise<NextResponse>` as the only framework entry point.

- [ ] **Step 1: Read the installed Next.js proxy and middleware migration guides.**
- [ ] **Step 2: Write tests proving every response receives HSTS, frame, MIME, referrer, and permissions headers.**
- [ ] **Step 3: Run the new test and verify RED because the helpers are absent.**
- [ ] **Step 4: Implement the helpers and integrate them into `proxy.ts` without changing authentication semantics.**
- [ ] **Step 5: Remove `middleware.ts`.**
- [ ] **Step 6: Run the focused test and `pnpm build`.**

Expected: the duplicate middleware/proxy error is absent.

### Task 3: Repair organization session type drift

**Files:**
- Modify: `lib/auth/session.ts`
- Modify: `tests/auth/session.test.ts`

**Interfaces:**
- Extends `Organization` with `onboardingCompleted`, `baseCurrency`, `whiteLabelEnabled`, `brandColor`, `logoUrl`, `stripeCustomerId`, `stripeSubscriptionId`, `stripePriceId`, `stellaMonthlyQuota`, and `stellaPlanLabel` using the nullability declared in `db/schema.ts`.

- [ ] **Step 1: Add failing assertions that `requireOrganizationAccess()` returns the beta organization fields.**
- [ ] **Step 2: Run `pnpm test:unit tests/auth/session.test.ts` and verify RED.**
- [ ] **Step 3: Extend the interface and both organization mapping blocks.**
- [ ] **Step 4: Re-run the focused test and `pnpm typecheck`.**

### Task 4: Remove unsafe `any` error handling

**Files:**
- Modify: `app/api/marketing/lead/route.ts`
- Modify: `app/api/webhooks/stripe/route.ts`
- Modify: `app/app/organization/onboarding/page.tsx`
- Modify: `app/app/organization/settings/settings-form.tsx`
- Create: `tests/error-message.test.ts`

**Interfaces:**
- Produces: `getErrorMessage(error: unknown, fallback: string): string` in an existing suitable utility module or a focused `lib/errors/get-error-message.ts`.

- [ ] **Step 1: Write tests for Error, string, Zod error, and opaque object inputs.**
- [ ] **Step 2: Verify RED because the helper does not exist.**
- [ ] **Step 3: Implement the minimal helper.**
- [ ] **Step 4: Replace all four explicit `any` catch bindings.**
- [ ] **Step 5: Run focused tests and lint.**

### Task 5: Repair invitation email contract

**Files:**
- Modify: `lib/email/provider.ts`
- Modify: `lib/invitations/email.ts`
- Modify: `lib/invitations/email.test.ts`

**Interfaces:**
- `EmailMessage` supports the provider fields actually used by invitations and demo requests, including `from?: string` only if the provider implementation consumes it.
- `SendInvitationEmailParams.inviterName` remains required in production calls.

- [ ] **Step 1: Update invitation tests to demonstrate the required inviter name and desired sender behavior.**
- [ ] **Step 2: Verify the focused tests fail for the contract mismatch.**
- [ ] **Step 3: Align the provider type and tests with the real Resend adapter.**
- [ ] **Step 4: Run invitation and Resend tests.**

### Task 6: Repair public report readiness typing and trust copy

**Files:**
- Modify: `app/(public)/verify/[hash]/pdf/route.ts`
- Modify: `app/(public)/verify/[hash]/page.tsx`
- Modify: `lib/reports/pdf/report-data.ts`
- Modify: `lib/reports/pdf/report-data.test.ts`

**Interfaces:**
- `buildMethodologyReadiness` consumes the actual review aggregate shape returned by `sroiRunReviews`.
- Public copy states that a report is registered and locked, not cryptographically immutable.

- [ ] **Step 1: Add a failing test using the actual review aggregate shape.**
- [ ] **Step 2: Verify RED at the current `pipelineStep` assumption.**
- [ ] **Step 3: Implement readiness extraction from the aggregate review.**
- [ ] **Step 4: Replace the unsupported public immutability claim.**
- [ ] **Step 5: Run report-data and PDF tests.**

### Task 7: Repair framework and integration type errors

**Files:**
- Modify: `components/marketing/HeroSection.tsx`
- Modify: `next.config.ts`
- Modify: `app/api/health/auth/route.ts`
- Modify: `.next` only through a clean rebuild, never manually.

**Interfaces:**
- Hero opacity is expressed through valid React style or motion props.
- Sentry uses options accepted by installed `@sentry/nextjs`.
- Health responses never expose upstream error strings.

- [ ] **Step 1: Add or extend tests for the health response privacy behavior.**
- [ ] **Step 2: Verify the health test fails if upstream messages are exposed.**
- [ ] **Step 3: Fix the Hero prop and Sentry configuration according to installed type definitions.**
- [ ] **Step 4: Remove stale `.next` output through the framework build path and rerun typecheck.**

### Task 8: Stabilize PDF verification

**Files:**
- Modify: `lib/reports/pdf/render.test.ts`
- Modify: `lib/reports/pdf/ReportPdfDocument.tsx` only if investigation proves production rendering is the cause.

**Interfaces:**
- PDF render test validates PDF signature and non-trivial size within a timeout based on measured local behavior.

- [ ] **Step 1: Run the focused PDF test three times and record durations.**
- [ ] **Step 2: Determine whether the failure is a fixed 5-second test budget or a rendering regression.**
- [ ] **Step 3: If environmental, set a focused test timeout justified by measurements; if functional, add the smallest failing fixture that identifies the expensive path.**
- [ ] **Step 4: Run the focused test three times again.**

### Task 9: Final local release gate

**Files:**
- Modify only files required by failures discovered above.
- Update: `docs/ops/BETA_RELEASE_BASELINE.md`

- [ ] **Step 1: Run `pnpm lint`. Expected: exit 0.**
- [ ] **Step 2: Run `pnpm typecheck`. Expected: exit 0.**
- [ ] **Step 3: Run `pnpm test:unit`. Expected: 0 failed tests.**
- [ ] **Step 4: Run `pnpm build`. Expected: exit 0.**
- [ ] **Step 5: Run `pnpm audit --prod` and record unresolved advisories without forcing incompatible upgrades.**
- [ ] **Step 6: Confirm no production database or deployment was changed.**
- [ ] **Step 7: Commit the verified baseline and prepare the next plan for isolated Supabase/RLS validation.**
