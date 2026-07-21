# Uellix Closed Beta Release Baseline

## Safety boundary

- Working branch: `codex/beta-stabilization`
- Baseline commit: `b1c22b1c3c219401f16886b0fd687c364da3a922`
- Production policy: preserve the existing Vercel deployment.
- Data policy: do not mutate Supabase production without a human gate, verified backup, reviewed migration, and rollback plan.
- Secret policy: `.env` and `.env.local` remain ignored; `.env.example` contains names and safe defaults only.

## Starting repository state

The stabilization branch inherited an existing dirty working tree from `main`. Those changes belong to the product owner and are intentionally preserved. They include public marketing changes, organization onboarding and billing work, Sentry, Stripe, report verification, database migrations `0034` through `0038`, and related schema changes.

## Starting validation results

Recorded on 2026-07-21 before stabilization changes:

| Gate | Result |
| --- | --- |
| `pnpm lint` | Failed: 5 errors and 59 warnings |
| `pnpm typecheck` | Failed: 14 TypeScript errors |
| `pnpm test:unit` | Failed: 1009 passed, 1 PDF render timeout |
| `pnpm build` | Failed: both `middleware.ts` and `proxy.ts` detected by Next.js 16 |
| `pnpm audit --prod` | Failed: 2 high and 2 moderate advisories |

## Release gate

This candidate is not eligible for preview promotion until lint, typecheck, unit tests, and production build all exit successfully. Supabase integration and RLS validation are a separate gate executed only against an isolated environment before any production decision.

## Stabilization result (2026-07-21)

| Gate | Result |
| --- | --- |
| `pnpm lint` | Passed: 0 errors, 54 warnings |
| `pnpm typecheck` | Passed |
| `pnpm test:unit` | Passed: 78 files, 1,027 tests |
| `pnpm build` | Passed: production compile and static generation 44/44 |
| `pnpm audit --prod` | Passed: no known vulnerabilities |
| `pnpm db:generate` | Passed: 37 tables, no schema drift |

These results establish a local technical baseline; they do not authorize a
deployment. The reviewed commit set is now consolidated on
`codex/beta-stabilization` and is eligible for a GitHub/Vercel Preview review.
Supabase migrations `0034` through `0038` plus RLS policy `008` require the
separate human gate in `docs/ops/SUPABASE_MIGRATION_GATE.md`; no migration was
applied during stabilization. Product-owner approval for the privacy and terms
copy was recorded in this stabilization task; legal verification against actual
vendor contracts remains a production-release responsibility.

The dependency gate uses patched `fast-uri` 3.1.4 and `sharp` 0.35.3. The unused
optional MCP SDK edge from `@google/genai` is removed, and `shadcn` is classified
as a build/development dependency. The production build and audit both pass with
that resolved tree.
