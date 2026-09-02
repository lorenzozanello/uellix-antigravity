// vitest.shared.ts
//
// Exclusion lists shared by the two vitest configs.
//
// They live here because `mergeConfig` CONCATENATES arrays: the integration
// config cannot narrow an `exclude` it inherits, it can only add to it. That
// is how "exclude tests/integration from the base config" briefly turned into
// "the integration config collects zero files", which would have made the CI
// integration and RLS steps fail on every PR.

/** Never collected by any config. */
export const BASE_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  // Nested git worktrees created under .claude by spawned background
  // sessions; without this a worktree's copy of tests/ runs a second time.
  "**/.claude/**",
]

/**
 * Additionally excluded from the DEFAULT config.
 *
 * tests/integration/** create auth users and write fixtures. Their
 * fail-closed target check lives in vitest.setup.integration.ts, which only
 * vitest.integration.config.ts loads — so collecting them here would run them
 * ungated, with the shared `db` still on `app_runtime` (which permits a
 * remote target). Run them with `pnpm db:test:integration:local`.
 */
export const INTEGRATION_GLOB = "tests/integration/**"

/**
 * The disposable-database end-to-end battery (Train 4.1, INT-INT-001).
 *
 * Excluded from the default suite for the same reason as the integration glob,
 * and one more that is specific to it: `tests/e2e/**` requires a live
 * PostgreSQL with `stella_0014` applied, which only
 * `scripts/stella-ticket-e2e.sh` builds. Collected here it would not merely
 * fail — it would fail against whatever `UELLIX_RUNTIME_DATABASE_URL` happens
 * to be set to in the developer's shell, which is exactly the accident the
 * database-safety guards exist to prevent.
 */
export const E2E_GLOB = "tests/e2e/**"
