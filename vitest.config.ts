import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Required so @testing-library/react's afterEach(cleanup) auto-registers
    // (it feature-detects a global `afterEach`); without this, DOM from one
    // test leaks into the next within the same file.
    globals: true,
    // Exclude nested git worktrees (created under .claude/worktrees by
    // spawned background sessions) in addition to vitest's own defaults —
    // otherwise a worktree's copy of tests/ gets picked up and every test
    // silently runs twice.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/.claude/**"],
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
