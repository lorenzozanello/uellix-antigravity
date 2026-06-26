# Sprint 9C — Stella Advisor UI Closure

**Date:** 2026-06-26  
**Status:** Operationally Closed

---

## 1. Executive Summary

Sprint 9C integrated the first visible Stella Advisor experience into the Uellix SROI pipeline. Built on the Stella/Gemini foundation delivered in Sprint 9B, the feature operates as an advisory assistant — not as a Validator, not as a Composer, and not as a replacement for human judgment.

**Key principles:**
- Stella Advisor is advisory-only; humans decide, approve, and persist
- Feature flags default `false` — no production rollout without explicit activation
- Production data to Gemini remains blocked pending DPA/data-retention review
- Calculation page untouched and deferred to Sprint 9D Validator scope
- All 213 tests passing; all validation gates green

---

## 2. Git and PR

| Field | Value |
|---|---|
| **PR Number** | #11 |
| **PR Title** | `feat: add sprint 9c stella advisor ui` |
| **PR URL** | https://github.com/lorenzozanello/uellix-antigravity/pull/11 |
| **Base Branch** | `main` |
| **Head Branch** | `feature/sprint-9c-stella-advisor-ui` |
| **Merge Commit** | `1780bb3` |
| **Merge Strategy** | Create a merge commit (preserve PR trazabilidad) |
| **Merged At** | 2026-06-26 |

### Commits Included

| Hash | Message |
|---|---|
| `f7a2f90` | feat: add sprint 9c-1 stella advisor foundation |
| `93a1f9b` | feat: add stella advisor panel |
| `e9b3d06` | feat: integrate stella advisor into narrative and outcomes |
| `52bf64e` | feat: integrate stella advisor into stakeholders and indicators |
| `b70c4e7` | feat: integrate stella advisor into evidence and proxies |

---

## 3. Scope Delivered

### Sprint 9C-1: Foundation

**Files:**
- `lib/stella/context/build-advisor-context.ts` — Metadata-only context builder
- `lib/stella/context/__tests__/build-advisor-context.test.ts` — Context boundary tests
- `lib/stella/context/index.ts` — Re-exports
- `app/actions/stella/advisor.ts` — Server action with auth + feature flag gate
- `app/actions/stella/__tests__/advisor.test.ts` — Server action tests
- `lib/stella/index.ts` — Module exports

**Key features:**
- Org-scoped context building (projectId + organizationId verified)
- Triple feature flag gate: `STELLA_ENABLED` && `STELLA_ADVISOR_ENABLED` && `canUseStella`
- Explicit rejection of Calculation step (deferred to Sprint 9D Validator)
- Metadata-only context: no raw files, no storage paths, no full snapshots
- Server-side auth boundary via `requireOrganizationAccess()`

### Sprint 9C-2: Component

**Files:**
- `components/stella/StellaAdvisorPanel.tsx` — Client component with state machine
- `components/stella/__tests__/StellaAdvisorPanel.test.tsx` — 33 component tests
- `components/stella/index.ts` — Re-exports
- `package.json` — Added `@testing-library/react` and `jsdom` to devDependencies

**Key features:**
- State machine: `idle` → `loading` → (`success` | `error` | `disabled`)
- No auto-invocation; manual trigger via "Ask Stella" button only
- Disabled state returns `null` — cleanly vanishes when feature flag off
- Accessible: `aria-live`, `role="alert"`, `aria-busy`, semantic lists
- Advisory-only copy: "Human review is required before external use"

### Sprint 9C-3: Narrative + Outcomes Integration

**Pages modified:**
- `app/app/projects/[projectId]/pipeline/narrative/page.tsx`
- `app/app/projects/[projectId]/pipeline/outcomes/page.tsx`

**Changes:** Replaced `StellaPlaceholder` with `StellaAdvisorPanel`; added `projectId` prop

### Sprint 9C-4: Stakeholders + Indicators Integration

**Pages modified:**
- `app/app/projects/[projectId]/pipeline/stakeholders/page.tsx`
- `app/app/projects/[projectId]/pipeline/indicators/page.tsx`

**Changes:** Replaced `StellaPlaceholder` with `StellaAdvisorPanel`; added `projectId` prop

### Sprint 9C-5: Evidence + Proxies Integration

**Pages modified:**
- `app/app/projects/[projectId]/pipeline/evidence/page.tsx` — Added panel after `PipelineStepHeader`
- `app/app/projects/[projectId]/pipeline/proxies/page.tsx` — Added panel after `PipelineStepHeader`

**Changes:** Fresh insertion (no placeholder to replace); consistent layout positioning

---

## 4. Pages Integrated

| Page | Step Parameter | Status |
|---|---|---|
| Narrative | `"Narrativa"` | ✅ Integrated |
| Stakeholders | `"Stakeholders"` | ✅ Integrated |
| Outcomes | `"Outcomes"` | ✅ Integrated |
| Indicators | `"Indicadores"` | ✅ Integrated |
| Evidence | `"Evidence"` | ✅ Integrated |
| Proxies | `"Proxies"` | ✅ Integrated |
| **Calculation** | — | ✅ **Untouched — Deferred to Sprint 9D Validator** |
| **Trust Center** | — | ✅ Untouched |

---

## 5. Stella Architecture

### Context Builder: Metadata-Only

The `buildAdvisorContext` function:
- Accepts: `projectId`, `organizationId`, `step`
- Verifies: Project ownership; org boundary
- Rejects: "calculation" and "cálculo" steps with explicit error
- Extracts: Narrative summary, stakeholder count, outcome refs, indicator refs, evidence metadata (title, type, status, truncated hash), proxy refs (name, source, confidence, risk — **NO values**)
- Returns: `StellaProjectContext` with `calculationSnapshot: null` always

**Security properties:**
- No raw evidence file content
- No Supabase storage paths
- No emails or PII beyond stakeholder count
- No financial proxy values
- Hash truncated to 8 characters
- Strings sanitized through `sanitizeString()`, `sanitizeNarrative()`, `hasForbiddenPattern()`

### Server Action: Auth + Feature Flags

The `getStellaAdvisor` server action (`'use server'`):
- Gate 1: `stellaConfig.isEnabled` (default false)
- Gate 2: `stellaConfig.isAdvisorEnabled` (default false)
- Gate 3: `stellaState.canUseStella` (default false)
- Auth: `requireOrganizationAccess()` — org context mandatory
- Call: Invokes adapter via `getGeminiAdapter().generate()`
- Validation: Parses response via `AdvisorOutputSchema`
- No writes: Zero DB mutations
- No secrets logging: No prompt, context, or API key output

**Error codes:**
- `DISABLED` — Feature flags off
- `UNAUTHORIZED` — Auth failed or project ownership denied
- `UNSUPPORTED_STEP` — Calculation or unknown step
- `GEMINI_ERROR` — Adapter error
- `PARSE_ERROR` — Response doesn't match schema
- `TIMEOUT` — Request timeout
- `UNKNOWN_ERROR` — Catch-all

### Client Component: Manual Trigger

The `StellaAdvisorPanel` client component (`'use client'`):
- No `useEffect` — no auto-invocation
- Click handler: Calls `getStellaAdvisor(projectId, step)` only on user action
- State transitions: `idle` → `loading` → (`success` | `error` | `disabled`)
- Disabled behavior: Returns `null` — panel vanishes from DOM
- Error recovery: User can retry without page reload
- Success retry: Button available in success state
- Accessibility:
  - Loading: `aria-live="polite"` + `aria-busy="true"`
  - Error: `role="alert"` + `aria-live="assertive"`
  - Success: `aria-live="polite"`
  - Lists: Semantic `<ul>/<li>` for common mistakes and suggested actions

### Gemini Boundary

- `@google/genai` imported only in `lib/stella/adapter/`
- `GEMINI_API_KEY` server-side only; never in client code
- No `NEXT_PUBLIC_GEMINI` variables
- Adapter invoked only by `getStellaAdvisor` server action
- Pipeline pages have zero Gemini imports

---

## 6. Guardrails

Stella Advisor is explicitly designed and tested to:

- **NOT calculate SROI** — Context excludes calculation data; Calculation step rejected
- **NOT approve evidence** — Panel is informational; evidence remains human-reviewed
- **NOT approve proxies** — Panel is informational; proxy assignments remain human-approved
- **NOT certify results** — Copy explicitly states "advisory guidance only"
- **NOT audit automatically** — No automatic approval, no checkbox-to-pass-audit
- **NOT guarantee impact** — Never claims fixed or guaranteed outcome values
- **NOT produce definitive validation** — Never uses absolute terms like "definitely," "certainly," "guaranteed"
- **Require human review** — Disclaimer present in idle and success states

**Enforced by:**
- Test negatives: `anti-regression.test.ts` explicitly rejects prohibited claims
- Prompt guardrails: `shared-guardrails.ts` instructs adapter to avoid certification language
- Copy validation: Component tests verify no prohibited terms in rendered output

---

## 7. Validation

### Post-Merge Gate Results

| Gate | Status | Details |
|---|---|---|
| **`pnpm lint`** | ✅ PASS | ESLint clean; 0 errors |
| **`pnpm typecheck`** | ✅ PASS | TypeScript clean; 0 errors |
| **`pnpm test`** | ✅ PASS | 213/213 tests passing; 18 test files |
| **`pnpm build`** | ✅ PASS | 27 routes compiled; all pages dynamic as expected |
| **GitHub Checks** | ✅ SUCCESS | Vercel build + preview deployed |

### Test Coverage

- **Context builder tests** (73 tests in `build-advisor-context.test.ts`)
  - Org boundary verification
  - Calculation step rejection
  - Metadata extraction
  - Sanitization and truncation
  - Error cases

- **Server action tests** (82 tests in `advisor.test.ts`)
  - Feature flag gates
  - Auth + org context
  - Error handling
  - Schema validation
  - No real Gemini calls

- **Component tests** (33 tests in `StellaAdvisorPanel.test.tsx`)
  - State transitions
  - No auto-invocation on mount
  - Click triggers action
  - Loading/error/success rendering
  - Disabled state handling
  - Accessibility attributes
  - No prohibited claims
  - No env var access

---

## 8. Security and Privacy

### Database and Schema

- **Changes:** 0
- **Migrations:** 0
- **RLS policies:** Untouched
- **Supabase:** 0 references in Stella code

### SROI Calculation

- **Deterministic engine:** Untouched
- **Calculation logic:** Zero changes
- **Calculation page:** 0 lines modified
- **SROI values:** Not sent to Gemini; not modified by Stella

### Environment and Secrets

- **`.env` / `.env.local`:** Not in commit; not in PR
- **`GEMINI_API_KEY`:** Server-side only; never in client code or logs
- **`NEXT_PUBLIC_GEMINI`:** 0 instances
- **Feature flag env vars:** All default `false` when not set

### Production Safety

- **Feature flags default `false`:**
  - `STELLA_ENABLED` (default: false)
  - `STELLA_ADVISOR_ENABLED` (default: false)
  - `canUseStella` (default: false)
- **Consequence:** Stella is disabled on production deploy unless explicitly activated
- **Data to Gemini:** BLOCKED until DPA/data-retention review completed
- **Real Gemini calls:** 0 in tests; 0 in production code path when flags off

---

## 9. Risks and Deferred Items

### Known Risks

| Risk | Mitigation | Owner |
|---|---|---|
| **Production data to Gemini** | Feature flags default false; DPA review required before activation | Security/Legal |
| **`stella_interactions` audit table** | Deferred to Sprint 9D; not required for 9C operation | Product |
| **Persistent rate limiting** | Deferred to Sprint 9D; per-request limits only | Product |
| **StellaPlaceholder cleanup** | Old component still exists but unused; candidate for future cleanup | Maintenance |

### Deferred to Sprint 9D

- **Stella Validator UI:** Separate component for Calculation page
- **Calculation page integration:** Validator role only; deferred scope
- **`stella_interactions` table:** Audit logging for Advisor/Validator usage
- **Persistent rate limiting:** Rate limit storage and enforcement

### External Blockers

- **DPA/data-retention review:** Required before activating `STELLA_ENABLED` in production
- **Legal review:** Certification/audit language guardrails confirmed compliant

---

## 10. Operational Closure

### Checklist

- ✅ PR #11 merged to `main`
- ✅ 5 Sprint 9C commits in histor
y
- ✅ All validation gates green (lint, typecheck, test, build)
- ✅ No regressions detected
- ✅ Scope boundaries enforced (Calculation untouched)
- ✅ Security properties verified (no DB, no secrets, no real Gemini calls)
- ✅ Feature flags safe for production (all default false)
- ✅ Accessibility and guardrails tested

### Sprint 9C Status

**OPERATIONALLY CLOSED**

The Stella Advisor feature is production-ready in terms of code quality, test coverage, and security properties. Feature flags must remain off until DPA review is completed and explicit decision to activate.

### Recommended Next Step

**Sprint 9D Scout Phase** (not direct implementation):

- Assess Stella Validator scope and interaction with Calculation page
- Clarify rate limiting, audit logging, and persistence requirements
- Plan Calculation page integration architecture
- Defer implementation until requirements clear

---

## 11. References

- **Sprint 9B Closure:** `docs/ops/sprint-9b-stella-gemini-adapter-guardrails-closure.md`
- **Stella Architecture:** `docs/architecture/stella-advisor.md` (inferred from code)
- **Feature Flag Config:** `lib/stella/config.ts`
- **Component Tests:** `components/stella/__tests__/StellaAdvisorPanel.test.tsx`
- **Server Action Tests:** `app/actions/stella/__tests__/advisor.test.ts`
