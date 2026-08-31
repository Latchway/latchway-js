import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ARTIFACTS_PATH, ROOT_PATH, readRootManifest } from "./release-utils.mjs";

const evidencePath = join(ARTIFACTS_PATH, "release-candidate-evidence.json");
await mkdir(ARTIFACTS_PATH, { recursive: true });
await rm(evidencePath, { force: true });
const manifest = await readRootManifest();
if (process.version !== "v24.19.0") {
  throw new Error(`The reproducible release gate requires Node v24.19.0, received ${process.version}.`);
}
const pnpmVersion = packageManagerOutput(["--version"]);
if (pnpmVersion !== manifest.engines.pnpm) {
  throw new Error(`The release gate requires pnpm ${manifest.engines.pnpm}, received ${pnpmVersion}.`);
}

const gates = [];
for (const [name, script] of [
  ["workflow-policy", "verify:workflows"],
  ["contract-lock", "verify:contracts"],
  ["release-policy", "verify:release-policy"],
  ["lint", "lint"],
  ["typecheck", "typecheck"],
  ["clean-build", "build"],
  ["unit-tests", "test"],
  ["offline-release-tests", "test:offline-release"],
  ["examples", "examples:check"],
  ["exports", "exports:check"],
  ["web-browser-and-bundler-conformance", "web:verify"],
  ["build-reproducibility", "verify:reproducible"],
  ["package-conformance", "pack:check"],
]) {
  const started = Date.now();
  runPackageScript(script);
  gates.push({ name, status: "passed", duration_ms: Date.now() - started });
}

const sourceCommit = commandOutput("git", ["rev-parse", "HEAD"]);
const worktreeStatus = commandOutput("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
const evidence = {
  schema_version: 1,
  package: manifest.name,
  version: manifest.version,
  source_commit: sourceCommit,
  worktree_clean: worktreeStatus.length === 0,
  stable_version: /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(manifest.version),
  node: process.version,
  pnpm: pnpmVersion,
  gates,
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

function runPackageScript(name) {
  packageManagerOutput([name], "inherit");
}

function packageManagerOutput(arguments_, stdio = ["ignore", "pipe", "pipe"]) {
  const packageManager = process.env.npm_execpath;
  if (packageManager === undefined) throw new Error("Run release-candidate verification through pnpm.");
  if (/\.[cm]?js$/u.test(packageManager)) {
    return execFileSync(process.execPath, [packageManager, ...arguments_], {
      cwd: ROOT_PATH,
      encoding: stdio === "inherit" ? undefined : "utf8",
      stdio,
    })?.trim() ?? "";
  }
  return execFileSync(packageManager, arguments_, {
    cwd: ROOT_PATH,
    encoding: stdio === "inherit" ? undefined : "utf8",
    stdio,
  })?.trim() ?? "";
}

function commandOutput(command, arguments_) {
  return execFileSync(command, arguments_, {
    cwd: ROOT_PATH,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
