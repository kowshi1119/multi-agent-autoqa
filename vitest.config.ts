import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several Phase-1 tests launch a real Chromium instance and drive a
    // real local HTTP server (safety/navigation-guard, dialog handling).
    // The 5000ms default is too tight for a browser launch + navigation.
    testTimeout: 30_000,
    // tsconfig.json intentionally compiles tests/**/*.ts into
    // dist/tests/**/*.js (tsc needs to typecheck tests too). Vitest 2's
    // defaultExclude included "**/dist/**", which masked that compiled
    // copy by accident; Vitest 4 dropped that entry from its defaults
    // (confirmed: v2.1.4's defaultExclude included "**/dist/**", v4.1.11's
    // is only node_modules/.git), so once dist/ exists on disk both the
    // source and compiled copies of every test file get collected and run
    // concurrently -- duplicate test counts and, for the two files that
    // bind a real server socket, EADDRINUSE. Scope explicitly instead of
    // relying on whichever exclusions a given Vitest version ships with.
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
