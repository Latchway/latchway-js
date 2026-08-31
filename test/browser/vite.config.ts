import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const harnessRoot = fileURLToPath(new URL("./harness/", import.meta.url));

export default defineConfig({
  root: harnessRoot,
  resolve: {
    alias: [
      { find: /^@latchway\/client$/u, replacement: `${repositoryRoot}src/index.ts` },
      { find: /^@latchway\/client\/firebase$/u, replacement: `${repositoryRoot}src/firebase.ts` },
      { find: /^@latchway\/client\/turnstile$/u, replacement: `${repositoryRoot}src/turnstile.ts` },
    ],
  },
  build: {
    outDir: `${repositoryRoot}.artifacts/browser-app`,
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    rollupOptions: { input: `${harnessRoot}index.html` },
  },
});
