import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    // Exclude nested git worktrees (created under .claude/worktrees by
    // spawned background sessions) in addition to vitest's own defaults —
    // otherwise a worktree's copy of tests/ gets picked up and every test
    // silently runs twice.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/.claude/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
