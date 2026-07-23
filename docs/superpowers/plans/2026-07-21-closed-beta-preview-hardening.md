# Closed Beta Preview Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a reviewable stabilization branch that can create a Vercel Preview while production and Supabase production remain unchanged.

**Architecture:** Enforce organization-logo trust at both write and PDF-render boundaries, replace Stella's split check/record flow with one atomic consume operation, then consolidate only product/audit files from the inherited workspace. Every behavioral change follows a focused red-green cycle before the full release gate and PR.

**Tech Stack:** Next.js 16, TypeScript, Vitest, Zod, Supabase Storage, Upstash Ratelimit, Drizzle, React PDF, pnpm, GitHub/Vercel.

## Global Constraints

- Work only on `codex/beta-stabilization`.
- Do not apply migrations or policies to Supabase.
- Do not change or promote Vercel production.
- Accept logos only from the configured HTTPS Supabase origin and `/storage/v1/object/public/` path.
- Both memory and Upstash Stella limiters consume exactly one token immediately before a Gemini attempt.
- Do not commit `.claude/settings.local.json` or local agent skill bundles.
- No push or PR until all release gates pass on the final tree.

---

### Task 1: Controlled Supabase logo URLs

**Files:**
- Create: `lib/organizations/logo-url.ts`
- Create: `tests/organization-logo-url.test.ts`
- Modify: `app/actions/organization.ts`
- Modify: `lib/reports/pdf/ReportPdfDocument.tsx`
- Modify: `app/(public)/verify/[hash]/pdf/route.ts`

**Interfaces:**
- Produces: `getApprovedOrganizationLogoUrl(value: string | null | undefined, configuredSupabaseUrl?: string): string | null`.
- Consumers: organization settings rejects a non-empty input when the function returns `null`; PDF routes pass only the returned URL to the renderer.

- [ ] **Step 1: Write the failing URL-policy tests**

```ts
expect(getApprovedOrganizationLogoUrl(
  'https://project.supabase.co/storage/v1/object/public/branding/logo.png',
  'https://project.supabase.co'
)).toBe('https://project.supabase.co/storage/v1/object/public/branding/logo.png')
expect(getApprovedOrganizationLogoUrl('https://evil.test/logo.png', configured)).toBeNull()
expect(getApprovedOrganizationLogoUrl('http://project.supabase.co/storage/v1/object/public/a.png', configured)).toBeNull()
expect(getApprovedOrganizationLogoUrl('https://project.supabase.co.evil.test/storage/v1/object/public/a.png', configured)).toBeNull()
expect(getApprovedOrganizationLogoUrl('https://user:pass@project.supabase.co/storage/v1/object/public/a.png', configured)).toBeNull()
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test:unit tests/organization-logo-url.test.ts`  
Expected: FAIL because `@/lib/organizations/logo-url` does not exist.

- [ ] **Step 3: Implement the minimal policy function**

```ts
export function getApprovedOrganizationLogoUrl(value, configuredSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL) {
  if (!value || !configuredSupabaseUrl) return null
  try {
    const logo = new URL(value)
    const configured = new URL(configuredSupabaseUrl)
    if (logo.protocol !== 'https:' || configured.protocol !== 'https:') return null
    if (logo.origin !== configured.origin || logo.username || logo.password) return null
    if (!logo.pathname.startsWith('/storage/v1/object/public/')) return null
    return logo.toString()
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Apply defense in depth**

In `updateOrganizationSettings`, reject a non-empty `logoUrl` not returned by the policy function. In both authenticated and public PDF paths, convert invalid persisted URLs to `null` before creating `ReportPdfDocument`. The component receives no untrusted remote URL.

- [ ] **Step 5: Verify GREEN and affected PDF tests**

Run: `pnpm test:unit tests/organization-logo-url.test.ts lib/reports/pdf/render.test.ts`  
Expected: all tests pass.

- [ ] **Step 6: Commit**

```powershell
git add -- lib/organizations/logo-url.ts tests/organization-logo-url.test.ts app/actions/organization.ts lib/reports/pdf/ReportPdfDocument.tsx 'app/(public)/verify/[hash]/pdf/route.ts'
git commit -m "fix: restrict report logos to approved storage"
```

### Task 2: Atomic Stella consumption

**Files:**
- Modify: `lib/stella/rate-limit.ts`
- Modify: `lib/stella/index.ts`
- Modify: `lib/stella/__tests__/rate-limit.test.ts`
- Modify: `app/actions/stella/advisor.ts`
- Modify: `app/actions/stella/composer.ts`
- Modify: `app/actions/stella/reviewer.ts`
- Modify: `app/actions/stella/validator.ts`
- Modify: associated action tests under `app/actions/stella/__tests__/`

**Interfaces:**
- Produces: `consumeStellaRateLimit(organizationId: string): Promise<RateLimitResult>`.
- `RateLimitResult` includes `reason: 'allowed' | 'limit' | 'unavailable'`.
- Removes action use of `checkStellaRateLimit` and `recordStellaRequest`.

- [ ] **Step 1: Rewrite the focused tests for atomic semantics**

```ts
expect(await consumeStellaRateLimit(ORG_A)).toMatchObject({ allowed: true, remaining: 2, reason: 'allowed' })
await consumeStellaRateLimit(ORG_A)
await consumeStellaRateLimit(ORG_A)
expect(await consumeStellaRateLimit(ORG_A)).toMatchObject({ allowed: false, remaining: 0, reason: 'limit' })
expect((await consumeStellaRateLimit(ORG_B)).allowed).toBe(true)
```

Update action mocks so context construction occurs before `consumeStellaRateLimit`, and Gemini generation is not called when the result is denied.

- [ ] **Step 2: Verify RED**

Run: `pnpm test:unit lib/stella/__tests__/rate-limit.test.ts app/actions/stella/__tests__`  
Expected: FAIL because the atomic function and new ordering do not exist.

- [ ] **Step 3: Implement atomic memory and Upstash paths**

The memory path increments the current-hour bucket inside the consume call and reports post-consumption remaining quota. The Upstash path calls `ratelimit.limit()` once. Catch an Upstash exception, log a generic server-side event and return `{ allowed: false, remaining: 0, limit, resetAtHourUtc, reason: 'unavailable' }`.

- [ ] **Step 4: Move consumption to the model-attempt boundary**

For each Stella action: authenticate, check feature and monthly quota, build/validate project context, consume the hourly token, then invoke Gemini. Return `RATE_LIMIT_UNAVAILABLE` for `reason === 'unavailable'` and `RATE_LIMITED` for `reason === 'limit'`.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm test:unit lib/stella/__tests__/rate-limit.test.ts app/actions/stella/__tests__`  
Expected: all focused limiter and action tests pass.

- [ ] **Step 6: Commit**

```powershell
git add -- lib/stella/rate-limit.ts lib/stella/index.ts lib/stella/__tests__/rate-limit.test.ts app/actions/stella
git commit -m "fix: consume stella limits atomically"
```

### Task 3: Consolidate approved inherited product work

**Files:**
- Review/stage: public marketing layout/page/components, organization onboarding/settings/billing, public verification, navigation, report lock/branding, legal pages and relevant tests.
- Review/stage: `docs/audits/` only when referenced as product audit evidence.
- Exclude: `.claude/settings.local.json`, `.agents/`, generated `.next/`, secrets and unrelated local fixtures.

**Interfaces:**
- Produces: a working tree containing only intentional local exclusions.
- Depends on: Tasks 1 and 2 security contracts.

- [ ] **Step 1: Review every remaining diff and untracked product file**

Run: `git status --short` and file-scoped `git diff --check`. Remove trailing whitespace in product files. Confirm no secrets with `git diff --cached -- . ':!pnpm-lock.yaml'` plus targeted scans for key/token patterns.

- [ ] **Step 2: Run focused feature tests**

Run tests for onboarding/session, Stripe, marketing leads, public-report data, FX form and report PDF.  
Expected: all focused tests pass.

- [ ] **Step 3: Stage coherent groups and inspect the staged diff**

Stage product code, required tests and approved legal pages. Do not stage local agent/editor configuration. Use `git diff --cached --stat` and `git diff --cached --check` before committing.

- [ ] **Step 4: Commit approved product work**

```powershell
git commit -m "feat: prepare closed beta commercial preview"
```

### Task 4: Final gates and Preview PR

**Files:**
- Update: `docs/ops/BETA_RELEASE_BASELINE.md`
- Update: `docs/ops/CLOSED_BETA_READINESS.md`

**Interfaces:**
- Produces: pushed branch and GitHub pull request suitable for Vercel Preview.

- [ ] **Step 1: Run the final gate on the exact tree**

```powershell
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
pnpm audit --prod
pnpm db:generate
git diff --check
```

Expected: zero command failures, zero lint errors, no known production vulnerabilities and no schema drift.

- [ ] **Step 2: Update readiness evidence and commit**

Record exact test counts, warning counts, route count and remaining external gates. Commit documentation only after rerunning any command affected by the documentation edit.

- [ ] **Step 3: Confirm Git environment and clean staged state**

Run: `git status --short`, `git rev-parse --git-dir`, `git rev-parse --git-common-dir`, `git merge-base HEAD main`.  
Expected: only intentional local exclusions remain; named stabilization branch based on `main`.

- [ ] **Step 4: Push without force and create a pull request**

```powershell
git push -u origin codex/beta-stabilization
gh pr create --base main --head codex/beta-stabilization --title "Stabilize Uellix closed beta preview" --body-file docs/ops/CLOSED_BETA_READINESS.md
```

Expected: push succeeds and GitHub returns a PR URL. Do not merge or promote production.
