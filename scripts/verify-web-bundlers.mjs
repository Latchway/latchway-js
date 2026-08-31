import { spawnSync } from "node:child_process";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = join(root, ".artifacts", "bundlers");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const pinned = {
  "@playwright/test": "1.56.0",
  "@types/react-dom": "19.2.3",
  next: "16.3.3",
  react: "19.2.8",
  "react-dom": "19.2.8",
  vite: "8.2.2",
};
for (const [name, version] of Object.entries(pinned)) {
  if (manifest.devDependencies?.[name] !== version) {
    throw new Error(`The Web matrix requires exact ${name}@${version}.`);
  }
}

await rm(artifacts, { recursive: true, force: true });
for (const fixture of ["vite-vanilla", "vite-react"]) {
  run(resolve(root, "node_modules/typescript/bin/tsc"), [
    "-p",
    `test/bundlers/${fixture}/tsconfig.json`,
    "--noEmit",
  ]);
  run(resolve(root, "node_modules/vite/bin/vite.js"), [
    "build",
    "--config",
    `test/bundlers/${fixture}/vite.config.ts`,
  ]);
}
run(resolve(root, "node_modules/next/dist/bin/next"), [
  "build",
  "test/bundlers/next-client",
]);

await assertFixture("vite-vanilla", "latchway-vite-vanilla-fixture");
await assertFixture("vite-react", "latchway-vite-react-fixture");
await assertFixture("next-client", "latchway-next-client-fixture");
process.stdout.write("Vite vanilla, React, and Next.js client bundles passed. Plain ESM is exercised by Playwright.\n");

function run(entry, arguments_) {
  const result = spawnSync(process.execPath, [entry, ...arguments_], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    maxBuffer: 16_777_216,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.signal !== null || result.error !== undefined) {
    throw new Error([
      `Web fixture command failed: ${entry} ${arguments_.join(" ")}`,
      result.stdout,
      result.stderr,
      result.error?.message,
    ].filter(Boolean).join("\n"));
  }
}

async function assertFixture(name, marker) {
  const directory = join(artifacts, name);
  const files = await filesBelow(directory);
  const scripts = files.filter((file) => file.endsWith(".js"));
  if (scripts.length === 0) throw new Error(`${name} did not emit JavaScript.`);
  const sources = await Promise.all(scripts.map((file) => readFile(file, "utf8")));
  const combined = sources.join("\n");
  if (!combined.includes(marker) || !combined.includes("habit-assistant")) {
    throw new Error(`${name} did not retain the expected Latchway client fixture.`);
  }
  for (const forbidden of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "sk-proj-",
    "quickstart-app-check-token",
    "quickstart-turnstile-token",
  ]) {
    if (combined.includes(forbidden)) throw new Error(`${name} emitted forbidden credential material: ${forbidden}`);
  }
}

async function filesBelow(directory) {
  if (!(await stat(directory)).isDirectory()) throw new Error(`${directory} is not a directory.`);
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(path));
    if (entry.isFile()) output.push(path);
  }
  return output.sort();
}
