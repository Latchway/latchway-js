import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtureRoot = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  root: fixtureRoot,
  build: {
    outDir: `${repositoryRoot}.artifacts/bundlers/vite-vanilla`,
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
