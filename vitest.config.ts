import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several Phase-1 tests launch a real Chromium instance and drive a
    // real local HTTP server (safety/navigation-guard, dialog handling).
    // The 5000ms default is too tight for a browser launch + navigation.
    testTimeout: 30_000,
  },
});
