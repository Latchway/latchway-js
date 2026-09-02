import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const minimumNpm = [11, 5, 1];
if (process.version !== "v24.19.0") {
  throw new Error(`The publish job requires Node v24.19.0, received ${process.version}.`);
}
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmVersion = execFileSync(npmCommand, ["--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
const npmParts = npmVersion.split(".").map(Number);
if (npmParts.length !== 3 || npmParts.some((part) => !Number.isInteger(part)) ||
    compareVersions(npmParts, minimumNpm) < 0) {
  throw new Error(`npm ${minimumNpm.join(".")} or newer is required for OIDC trusted publishing.`);
}

if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("npm trusted publishing requires a GitHub-hosted Actions runner.");
}
if (typeof process.env.ACTIONS_ID_TOKEN_REQUEST_URL !== "string" ||
    typeof process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== "string") {
  throw new Error("The publish job is missing GitHub OIDC id-token permission.");
}
for (const name of ["NODE_AUTH_TOKEN", "NPM_TOKEN"]) {
  if (process.env[name] !== undefined) throw new Error(`${name} must not be present in the OIDC publish job.`);
}
if (process.env.NPM_CONFIG_PROVENANCE === "false" || process.env.npm_config_provenance === "false") {
  throw new Error("npm provenance cannot be disabled in the publish job.");
}

const userconfig = process.env.NPM_CONFIG_USERCONFIG;
const runnerTemp = process.env.RUNNER_TEMP;
const userconfigRelative = typeof userconfig === "string" && typeof runnerTemp === "string"
  ? relative(resolve(runnerTemp), resolve(userconfig))
  : "..";
if (typeof userconfig !== "string" || typeof runnerTemp !== "string" || runnerTemp.length === 0 ||
    userconfigRelative === "" || userconfigRelative === ".." || userconfigRelative.startsWith(`..${sep}`) ||
    isAbsolute(userconfigRelative)) {
  throw new Error("The publish job must use an isolated npm user configuration under RUNNER_TEMP.");
}
await mkdir(dirname(userconfig), { recursive: true });
await writeFile(userconfig, [
  "registry=https://registry.npmjs.org/",
  "@latchway:registry=https://registry.npmjs.org/",
  "provenance=true",
  "",
].join("\n"), {
  flag: "wx",
  mode: 0o600,
});

process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  node: process.version,
  npm: npmVersion,
  github_hosted: true,
  oidc_available: true,
  long_lived_npm_token_present: false,
  provenance: true,
}, null, 2)}\n`);

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}
