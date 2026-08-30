import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

// Trusted publishing uses the separately authenticated npm 11.6.2 handoff.
// This tokenless job only needs the npm audit-signature commands available in
// the exact Node 24 runtime, whose supported floor is npm 10.9.3.
const minimumNpm = [10, 9, 3];
if (process.version !== "v24.19.0") {
  throw new Error(`The registry-evidence job requires Node v24.19.0, received ${process.version}.`);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmVersion = execFileSync(npmCommand, ["--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
const npmParts = npmVersion.split(".").map(Number);
if (npmParts.length !== 3 || npmParts.some((part) => !Number.isInteger(part)) ||
    compareVersions(npmParts, minimumNpm) < 0) {
  throw new Error(`npm ${minimumNpm.join(".")} or newer is required for registry evidence verification.`);
}

if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("Registry evidence verification requires a GitHub-hosted Actions runner.");
}
for (const name of ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) {
  if (process.env[name] !== undefined) {
    throw new Error(`${name} must not be present in the tokenless registry-evidence job.`);
  }
}
for (const name of ["NODE_AUTH_TOKEN", "NPM_TOKEN"]) {
  if (process.env[name] !== undefined) {
    throw new Error(`${name} must not be present in the tokenless registry-evidence job.`);
  }
}

const runnerTemp = process.env.RUNNER_TEMP;
const userconfig = requireIsolatedPath("NPM_CONFIG_USERCONFIG", process.env.NPM_CONFIG_USERCONFIG, runnerTemp);
const cache = requireIsolatedPath("NPM_CONFIG_CACHE", process.env.NPM_CONFIG_CACHE, runnerTemp);
if (userconfig === cache || userconfig.startsWith(`${cache}${sep}`)) {
  throw new Error("The isolated npm user configuration must not be inside the npm cache.");
}

await mkdir(cache, { recursive: true, mode: 0o700 });
await writeFile(userconfig, [
  "registry=https://registry.npmjs.org/",
  "fund=false",
  "update-notifier=false",
  "",
].join("\n"), { flag: "wx", mode: 0o600 });

process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  node: process.version,
  npm: npmVersion,
  github_hosted: true,
  oidc_available: false,
  long_lived_npm_token_present: false,
  registry: "https://registry.npmjs.org/",
}, null, 2)}\n`);

function requireIsolatedPath(name, value, runnerTemp) {
  const relativePath = typeof value === "string" && typeof runnerTemp === "string"
    ? relative(resolve(runnerTemp), resolve(value))
    : "..";
  if (typeof value !== "string" || typeof runnerTemp !== "string" || runnerTemp.length === 0 ||
      relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)) {
    throw new Error(`${name} must resolve to an isolated path under RUNNER_TEMP.`);
  }
  return resolve(value);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}
