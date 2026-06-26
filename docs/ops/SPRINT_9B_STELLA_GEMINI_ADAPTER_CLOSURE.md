# Sprint 9B: Stella Gemini Adapter + Guardrails — Closure Documentation

**Status:** ✅ Operationally Closed  
**Date Closed:** 2026-06-26  
**Branch:** main (commit e344ca6)

---

## 1. Objective

Implement the server-side technical foundation for Stella, Uellix's AI methodology layer, using the official Google GenAI SDK v2.10.0 with strict guardrails, mock-safe tests, structured schemas, context sanitization, and fallback behavior.

**Outcome:** Production-ready adapter for Stella Advisor, Validator, and Composer roles. Runtime capable of calling Gemini in Sprint 9C. No real production data sent to Gemini (pending DPA/data-retention review).

---

## 2. Merge and Implementation Details

| Field | Value |
|-------|-------|
| **PR** | [#10 Stella Gemini Adapter + Guardrails](https://github.com/lorenzozanello/uellix-antigravity/pull/10) |
| **Merge Commit** | `e344ca6` Merge pull request #10 from lorenzozanello/feature/sprint-9b-stella-gemini-adapter-guardrails |
| **Implementation Commit** | `ae22ef3` feat: add sprint 9b stella gemini adapter and guardrails |
| **Base Branch** | `main` |
| **Head Branch** | `feature/sprint-9b-stella-gemini-adapter-guardrails` |
| **Merge Method** | Create a merge commit (preserves PR trazability) |
| **Merged At** | 2026-06-26 17:29:34 UTC |

---

## 3. Scope Integrated

### Files Added/Modified

**23 files changed, 1474 insertions(+), 2 deletions(-)**

#### Core Module: `lib/stella/**` (20 new files + 1 modified)

```
lib/stella/
├── __tests__/
│   └── anti-regression.test.ts          (191 lines) 16 anti-regression tests
├── adapter/
│   ├── gemini-client.ts                 (124 lines) Real GoogleGenAI v2 integration
│   ├── gemini-client.test.ts            (129 lines) Mock provider tests
│   ├── index.ts                         (3 lines) Exports
│   └── types.ts                         (32 lines) Interface definitions
├── config.ts                            (30 lines) Feature flags & env vars
├── context/
│   ├── index.ts                         (12 lines) Context exports
│   ├── sanitize.ts                      (69 lines) Prompt injection + secret detection
│   └── types.ts                         (99 lines) StellaProjectContext boundary
├── errors.ts                            (51 lines) 7 error types
├── fallbacks.ts                         (63 lines) Graceful responses when unavailable
├── index.ts                             (55 lines) Module exports (modified)
├── prompts/
│   ├── advisor-system.ts                (60 lines) Advisor role prompts
│   ├── composer-system.ts               (79 lines) Composer role prompts
│   ├── index.ts                         (16 lines) Prompt builder exports
│   ├── shared-guardrails.ts             (40 lines) 7 absolute prohibitions
│   └── validator-system.ts              (75 lines) Validator role prompts
└── schemas/
    ├── advisor-output.ts                (17 lines) Zod schema for Advisor
    ├── composer-output.ts               (40 lines) Zod schema for Composer
    ├── index.ts                         (6 lines) Schema exports
    └── validator-output.ts              (26 lines) Zod schema w/ requires_human_review: true
```

#### Dependencies

- `package.json`: Added `@google/genai ^2.10.0`
- `pnpm-lock.yaml`: Updated (258 lines)

### Out-of-Scope: Verified Clean

- ✅ `db/` — no changes
- ✅ `supabase/` — no changes
- ✅ `lib/pipeline/sroi-calculation.ts` — no changes
- ✅ `app/actions/` — no new server actions
- ✅ `app/app/` — no page changes
- ✅ `components/` — no UI components
- ✅ `.env`, `.env.local` — not touched
- ✅ Production deploy configs — untouched

---

## 4. Dependencies

### Installed

- **`@google/genai ^2.10.0`** — Official Google GenAI SDK (v2.x API, NOT v1.x legacy)

### NOT Installed (Intentional)

- ❌ `@google/generative-ai` — Legacy v1 SDK (superseded by @google/genai v2)
- ❌ Alternative SDKs

### Zod

- `zod` already present (used for output schema validation)

---

## 5. Capabilities Implemented

### Configuration (`lib/stella/config.ts`)

- `GEMINI_API_KEY` (required for production)
- `GEMINI_MODEL` (default: `gemini-2.0-flash`)
- `STELLA_ENABLED` (default: false)
- `STELLA_ADVISOR_ENABLED` (default: false)
- `STELLA_VALIDATOR_ENABLED` (default: false)
- `STELLA_COMPOSER_ENABLED` (default: false)
- `STELLA_RATE_LIMIT_PER_HOUR` (default: 100)
- Request timeout: 15 seconds

**Security:** API key read from `process.env`, never hardcoded. No `NEXT_PUBLIC_` exposure.

### Gemini Adapter (`lib/stella/adapter/gemini-client.ts`)

**Runtime (Production):**
- Dynamic import: `const { GoogleGenAI } = await import('@google/genai')`
- Constructor: `new GoogleGenAI({ apiKey })`
- Request: `ai.models.generateContent({ model, contents, config })`
- Response parsing: `response.text`
- Timeout: `AbortController` with configurable timeout (default 15s)
- JSON mode: `responseMimeType: 'application/json'` requested
- Error handling:
  - Empty response → `StellaParseError`
  - Timeout/abort → `StellaTimeoutError`
  - SDK error → `StellaGeminiError`

**Testing:**
- Mock provider: `StellaMockProvider` interface
- Implementations: `MockGeminiProvider`, `BadJsonMockProvider`
- All tests use mock; zero real Gemini calls in tests

### Schemas (Zod-validated)

#### AdvisorOutput
- `step`: Pipeline step name
- `what_to_do`: Action for user
- `why_it_matters`: Methodological importance
- `how_to_do_it`: Execution guidance
- `common_mistakes[]`: Pitfalls to avoid
- `suggested_next_actions[]`: Follow-ups

#### ValidatorOutput
- `summary`: Validation executive summary
- `risk_level`: 'low' | 'medium' | 'high'
- `evidence_gaps[]`: Unmet evidence needs
- `proxy_risks[]`: Weak proxies
- `attribution_risks[]`: Attribution challenges
- `claim_risks[]`: Overclaiming detected
- `recommendations[]`: Improvements
- **`requires_human_review: z.literal(true)`** ← Hardcoded, impossible to bypass

#### ComposerOutput
- `section_key`: Report section type
- `draft_title`: Proposed section title
- `draft_content`: Draft text (NOT persisted, user-editable)
- `assumptions[]`: Explicit assumptions
- `limitations[]`: Methodological caveats
- `evidence_references[]`: {evidenceId, title, context}
- `proxy_references[]`: {proxyId, name, context}

### Prompt Builders

#### Shared Guardrails (injected into all roles)

**7 Absolute Prohibitions:**
1. Never calculate SROI ratio
2. Never claim certification or audit
3. Never approve evidence, proxies, or filtering
4. Never invent sources, evidence, or proxies
5. Never modify data
6. Never replace human review
7. Never access forbidden data (API keys, service role, raw files, PII)

**Required Output Format:**
- Always return valid JSON
- No markdown outside JSON
- Clear, audit-ready language

**Required Language:**
- Use: "estimated," "appears to," "may," "suggests"
- Prefix risks: [LOW RISK], [MEDIUM RISK], [HIGH RISK]
- Acknowledge uncertainty
- Never use absolute terms: "definitely," "certainly," "guaranteed," "definitive"

#### Role-Specific Prompts
- `advisor-system.ts` — Step-by-step guidance builder
- `validator-system.ts` — Validation context + guardrails
- `composer-system.ts` — Report drafting + disclaimers

### Context Boundary (`lib/stella/context/`)

**StellaProjectContext** — Metadata-only, safe for Gemini

- `projectId`, `organizationId` (no emails, no usernames)
- `narrativeSummary` (non-sensitive text)
- `outcomesSnapshot[]`, `indicatorsSnapshot[]` (metadata)
- `evidenceMetadata[]` — Only metadata (id, title, type, status, hash truncated) — NO file content
- `proxySummary[]` — Proxy names/sources
- `calculationSnapshot` — Totals only (totalInvestment, grossSocialValue, netSocialValue, sroiRatio) — NO full formula
- `reportSections[]` — Section metadata
- Timestamps (no PII)

**NOT Included:**
- Raw storage files
- Supabase file paths
- Email addresses
- API keys or secrets
- Full snapshotJson
- Service role data
- User session data

### Sanitizer (`lib/stella/context/sanitize.ts`)

**Functions:**
- `sanitizeString()` — Remove control characters, limit length (max 1000 default)
- `hasForbiddenPattern()` — Detect suspicious patterns
- `sanitizeNarrative()` — Apply sanitization + forbidden pattern check
- `markAsData()` — Prefix user content as `[DATA]:` to prevent injection

**Forbidden Patterns:**
- `GEMINI_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `process.env`
- `SECRET`, `PASSWORD`
- `API_KEY`
- `sk_`, `key_`, `secret_` (API key prefixes)

### Fallbacks (`lib/stella/fallbacks.ts`)

When Stella is disabled or unavailable:
- `ADVISOR_FALLBACK` — Generic methodology guidance
- `VALIDATOR_FALLBACK` — Requires human review
- `COMPOSER_FALLBACK` — Manual composition required
- All fallbacks enforce human review requirement

### Error Types (`lib/stella/errors.ts`)

- `StellaError` — Base error
- `StellaDisabledError` — Feature not enabled
- `StellaMissingApiKeyError` — GEMINI_API_KEY not set
- `StellaParseError` — JSON or schema validation failure
- `StellaTimeoutError` — Request exceeded timeout
- `StellaRateLimitError` — Rate limit exceeded
- `StellaGeminiError` — Gemini SDK error

---

## 6. Testing

### Test Coverage: 140/140 Passing

- **Test Files:** 15
- **Test Duration:** ~2.7 seconds
- **Lint:** 0 errors, 0 warnings
- **TypeScript:** 0 errors (strict mode)
- **Build:** Successful (4.6–7.9s)

### Anti-Regression Tests (16 tests)

Enforce critical constraints:
1. No SROI calculation by Stella
2. No certification claims
3. No automatic audit
4. No evidence/proxy approval
5. No data modification
6. No DB writes without explicit action
7. No real Gemini calls in tests
8. No `NEXT_PUBLIC_GEMINI` exposure
9. `requires_human_review` always true
10. No forbidden data access
11. No invented sources/evidence
12. Fallback graceful behavior
13. Mock provider coverage
14. Schema validation enforcement
15. Guardrail enforcement
16. No streaming

### Test Files

- `lib/stella/__tests__/anti-regression.test.ts` — 16 anti-regression tests
- `lib/stella/adapter/gemini-client.test.ts` — 6 adapter integration tests
- Plus pre-existing tests (118 from main codebase)

---

## 7. Validation Results

### Pre-Merge Validation (Sprint 9B Builder → PR Review)

| Check | Result |
|-------|--------|
| `pnpm lint` | ✅ 0 errors, 0 warnings |
| `pnpm typecheck` | ✅ 0 errors |
| `pnpm test` | ✅ 140/140 tests passing |
| `pnpm build` | ✅ Compiled successfully |

### PR Review Gate Checks

| Check | Status |
|-------|--------|
| GitHub CI/CD (Vercel) | ✅ PASSED |
| Vercel Preview | ✅ Deployed |
| Diff scope | ✅ Only lib/stella/**, package.json, pnpm-lock.yaml |
| No blocked files | ✅ Verified |
| Adapter readiness | ✅ Runtime real, no placeholder |
| Schemas | ✅ All present, requires_human_review hardcoded |
| Guardrails | ✅ 7 prohibitions enforced |
| Claims audit | ✅ No prohibited claims |

### Post-Merge Validation (After merge to main)

| Check | Result |
|-------|--------|
| `pnpm lint` | ✅ 0 errors, 0 warnings |
| `pnpm typecheck` | ✅ 0 errors |
| `pnpm test` | ✅ 140/140 tests passing |
| `pnpm build` | ✅ Compiled successfully in 5.4s |
| Scope integration | ✅ 23 files, all lib/stella/**, package.json, pnpm-lock.yaml |
| No regressions | ✅ All tests pass post-merge |
| Stella core audit | ✅ Adapter runtime real, no placeholder, dynamic import confirmed |

---

## 8. Security and Boundaries

### Verified Clean

| Boundary | Status | Verification |
|----------|--------|-------------|
| **Database** | ✅ CLEAN | 0 DB schema changes |
| **Supabase** | ✅ CLEAN | 0 Supabase config changes |
| **RLS Policy** | ✅ CLEAN | No RLS modifications |
| **Migrations** | ✅ CLEAN | 0 migrations in Sprint 9B |
| **SROI Logic** | ✅ CLEAN | `lib/pipeline/sroi-calculation.ts` untouched |
| **Services/Actions** | ✅ CLEAN | No public server actions added |
| **UI Components** | ✅ CLEAN | No new components in `components/` |
| **Environment** | ✅ CLEAN | `.env`, `.env.local` untouched |
| **Production Deploy** | ✅ CLEAN | No production deployment configs modified |

### Gemini Security

| Control | Status | Implementation |
|---------|--------|-----------------|
| **API Key** | ✅ SAFE | Read from `process.env.GEMINI_API_KEY`, never hardcoded |
| **NEXT_PUBLIC** | ✅ SAFE | 0 `NEXT_PUBLIC_GEMINI*` variables |
| **Logs** | ✅ SAFE | 0 console.log calls in adapter |
| **Dynamic Import** | ✅ SAFE | Prevents client-side bundling of SDK |
| **Mock Provider** | ✅ SAFE | 100% of tests use mocks; 0 real Gemini calls |
| **Real Data Blocking** | ✅ SAFE | No production data sent to Gemini (pending DPA review) |
| **Context Boundary** | ✅ SAFE | No raw files, no PII, no secrets, hashes truncated |
| **Sanitizer** | ✅ SAFE | Forbidden patterns detected; user content marked as data |

---

## 9. Pending Tasks and Deferred Scope

### Not Implemented in Sprint 9B (As Intended)

- ❌ Stella Advisor UI — Deferred to Sprint 9C
- ❌ Stella Validator UI — Deferred to Sprint 9D+
- ❌ Stella Composer UI — Deferred to Sprint 9D+
- ❌ Public server actions for Stella — Deferred to Sprint 9C/9D
- ❌ `stella_interactions` migration (audit log) — Deferred to Sprint 9D
- ❌ Rate limiting persistence — Deferred to future sprint
- ❌ Production Gemini rollout — Blocked pending DPA/data-retention review
- ❌ Real production data to Gemini — Blocked pending DPA/data-retention review

### DPA/Data-Retention Review Required

**Blocking real production data to Gemini:**
- Data classification of project context (PII risk assessment)
- Data retention policy compliance with Google
- DPA (Data Processing Agreement) with Google
- Encryption at rest/in transit for Gemini API calls

**Status:** Staging/demo data with controlled context is OK. Production data requires formal approval.

---

## 10. Risks and Mitigations

| Risk | Severity | Context | Mitigation |
|------|----------|---------|-----------|
| **Real Gemini API untested** | ⚠️ LOW | Runtime real only tested in Sprint 9C with API key | Exhaustive mock provider tests confirm structure + error handling |
| **JSON response variability** | ⚠️ LOW | Gemini may occasionally return invalid JSON | `StellaParseError` handler + fallback behavior |
| **AbortSignal compatibility** | ⚠️ LOW | AbortController across Node.js versions | Handled for `DOMException` + `Error` with `name === 'AbortError'` |
| **Production data exposure** | ⚠️ MEDIUM | No real data to Gemini until DPA approved | Policy enforced; context boundary prevents PII leakage |
| **Rate limiting not persisted** | ℹ️ INFO | Counters reset on server restart | Acceptable for MVP; persistent storage deferred |
| **Audit logging deferred** | ℹ️ INFO | `stella_interactions` table not created | Migration planned for Sprint 9D+ |

---

## 11. Operational Closure Checklist

- ✅ Architecture finalized (Sprint 9A)
- ✅ Implementation complete (Sprint 9B)
- ✅ PR reviewed and approved (#10)
- ✅ Merged to main (commit e344ca6)
- ✅ Post-merge validation passed
- ✅ All tests passing (140/140)
- ✅ Lint clean, typecheck strict
- ✅ Build successful
- ✅ No out-of-scope changes
- ✅ Security review completed
- ✅ Guardrails enforced
- ✅ Documentation recorded

---

## 12. Next Steps

### Immediate (Optional)

1. **Feature branch cleanup:** `git push origin --delete feature/sprint-9b-stella-gemini-adapter-guardrails` (optional; can wait)

### Sprint 9C (When User Initiates)

1. **Stella Advisor UI** — Integrate Stella advisor into pipeline steps
2. **Real Gemini testing** — Call Gemini with staging data in dev/staging
3. **Advisor server actions** — Create public endpoint for UI

### Sprint 9D+ (Planned)

1. **Stella Validator + Composer UI** — Report validation and composition
2. **`stella_interactions` migration** — Audit log for Stella calls
3. **Rate limiting persistence** — Store rate limit counters
4. **DPA approval** — Formal data-retention review (gates production rollout)

### Blocked Until DPA/Data-Retention Approval

- Real production data to Gemini
- Production deployment of Stella with real data

---

## 13. References

- **PR:** [#10 Stella Gemini Adapter + Guardrails](https://github.com/lorenzozanello/uellix-antigravity/pull/10)
- **Sprint 9A Architecture:** `docs/ops/SPRINT_9_STELLA_ARCHITECTURE.md`
- **Main Branch HEAD:** `e344ca6` (Merge commit)
- **Implementation Commit:** `ae22ef3` (Sprint 9B functional changes)

---

**Recorded by:** Claude Haiku 4.5  
**Date:** 2026-06-26  
**Status:** ✅ Operationally Closed
