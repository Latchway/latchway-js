import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const sourceRoot = fileURLToPath(new URL("./src/", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@latchway\/client$/u, replacement: `${sourceRoot}index.ts` },
      { find: /^@latchway\/client\/browser$/u, replacement: `${sourceRoot}browser.ts` },
      { find: /^@latchway\/client\/firebase$/u, replacement: `${sourceRoot}firebase.ts` },
      { find: /^@latchway\/client\/node$/u, replacement: `${sourceRoot}node.ts` },
      { find: /^@latchway\/client\/service-worker$/u, replacement: `${sourceRoot}service-worker.ts` },
      { find: /^@latchway\/client\/turnstile$/u, replacement: `${sourceRoot}turnstile.ts` },
    ],
  },
  test: {
    coverage: { enabled: false },
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
