import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const manifestURL = new URL("../conformance/framework-versions.json", import.meta.url);
const rootURL = new URL("../", import.meta.url);
const packageNames = ["@ai-sdk/openai", "@langchain/openai", "ai", "openai"];
const manifest = JSON.parse(await readFile(manifestURL, "utf8"));
validateManifest(manifest);

const [operation, profile] = process.argv.slice(2);
if (operation === "verify" && (profile === "minimum" || profile === "latest")) {
  await verifyExactProfile(profile);
} else if (operation === "install" && profile === "newest-compatible") {
  installNewestCompatible();
} else if (operation === "verify" && profile === "newest-compatible") {
  await verifyCandidateProfile();
} else {
  throw new Error(
    "Usage: framework-matrix.mjs verify minimum|latest|newest-compatible, or install newest-compatible.",
  );
}

async function verifyExactProfile(name) {
  const expected = manifest.profiles[name];
  const installed = await readInstalledVersions();
  for (const packageName of packageNames) {
    if (installed[packageName] !== expected[packageName]) {
      throw new Error(
        `${name} requires ${packageName}@${expected[packageName]}, received ${installed[packageName]}.`,
      );
    }
  }
  writeObservation(name, installed);
}

async function verifyCandidateProfile() {
  const installed = await readInstalledVersions();
  for (const packageName of packageNames) {
    if (!satisfiesBoundedRange(installed[packageName], manifest.newest_compatible_candidates[packageName])) {
      throw new Error(
        `${packageName}@${installed[packageName]} is outside the candidate observation bound ` +
        `${manifest.newest_compatible_candidates[packageName]}.`,
      );
    }
  }
  writeObservation("newest-compatible-candidate", installed);
}

function installNewestCompatible() {
  const packageManager = process.env.npm_execpath;
  if (packageManager === undefined) {
    throw new Error("Run the framework candidate installer through the pinned pnpm runtime.");
  }
  const specifications = packageNames.map((packageName) =>
    `${packageName}@${manifest.newest_compatible_candidates[packageName]}`);
  const arguments_ = [
    "add",
    "--workspace-root",
    "--save-dev",
    "--ignore-scripts",
    "--lockfile=false",
    "--config.strict-peer-dependencies=false",
    ...specifications,
  ];
  const executable = /\.[cm]?js$/u.test(packageManager) ? process.execPath : packageManager;
  const commandArguments = executable === process.execPath ? [packageManager, ...arguments_] : arguments_;
  execFileSync(executable, commandArguments, {
    cwd: rootURL,
    env: process.env,
    stdio: "inherit",
  });
}

async function readInstalledVersions() {
  const installed = {};
  for (const packageName of packageNames) {
    const packageURL = new URL(`node_modules/${packageName}/package.json`, rootURL);
    const packageManifest = JSON.parse(await readFile(packageURL, "utf8"));
    if (!canonicalSemver(packageManifest.version)) {
      throw new Error(`${packageName} did not expose a canonical installed SemVer.`);
    }
    installed[packageName] = packageManifest.version;
  }
  return installed;
}

function validateManifest(value) {
  if (!isRecord(value) || value.schema_version !== 1 || value.support !== "experimental" ||
      value.contract_bundle_sha256 !== "33c57d9dfeb227ca2472a4a4a964e6df37f4932699cacb423dee11ce15e8824e" ||
      !isRecord(value.profiles) || !isRecord(value.profiles.minimum) ||
      !isRecord(value.profiles.latest) || !isRecord(value.newest_compatible_candidates) ||
      !sameKeys(value.profiles.minimum, packageNames) || !sameKeys(value.profiles.latest, packageNames) ||
      !sameKeys(value.newest_compatible_candidates, packageNames)) {
    throw new Error("The framework version manifest does not match schema 1.");
  }
  for (const profile of [value.profiles.minimum, value.profiles.latest]) {
    if (packageNames.some((packageName) => !canonicalSemver(profile[packageName]))) {
      throw new Error("Minimum and latest framework profiles must contain exact canonical versions.");
    }
  }
  for (const packageName of packageNames) {
    const range = value.newest_compatible_candidates[packageName];
    if (typeof range !== "string" || !/^>=\d+\.\d+\.\d+ <\d+\.0\.0$/u.test(range)) {
      throw new Error(`${packageName} has an invalid bounded candidate range.`);
    }
  }
}

function satisfiesBoundedRange(version, range) {
  const match = /^>=(\d+\.\d+\.\d+) <(\d+\.0\.0)$/u.exec(range);
  if (match === null || match[1] === undefined || match[2] === undefined) return false;
  return compareVersions(version, match[1]) >= 0 && compareVersions(version, match[2]) < 0;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function canonicalSemver(value) {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value);
}

function sameKeys(value, expected) {
  return Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeObservation(profileName, installed) {
  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    support: manifest.support,
    profile: profileName,
    contract_bundle_sha256: manifest.contract_bundle_sha256,
    installed,
    widens_supported_range: false,
  }, null, 2)}\n`);
}
