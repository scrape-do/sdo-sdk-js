import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Clears every SDO_* variable around each test, so a developer's shell
    // (SDO_TOKEN, SDO_BASE_URL, ...) cannot change what the suite sees.
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "text-summary"],
      // A gate, not a printout: an unenforced number drifts silently.
      thresholds: {
        lines: 99,
        branches: 99,
        functions: 99,
        statements: 99,
      },
    },
  },
});
