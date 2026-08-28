import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ARTIFACTS_PATH } from "./release-utils.mjs";
import { assertReleaseCoordinates } from "./release-policy.mjs";

const evidence = JSON.parse(await readFile(join(ARTIFACTS_PATH, "package-evidence.json"), "utf8"));
assertReleaseCoordinates(process.env.GITHUB_REF_NAME, evidence.version);
for (const [field, pattern] of [
  ["tarball", /^[A-Za-z0-9._-]+\.tgz$/u],
  ["sha256", /^[0-9a-f]{64}$/u],
  ["integrity", /^sha512-[A-Za-z0-9+/]+={0,2}$/u],
]) {
  if (typeof evidence[field] !== "string" || !pattern.test(evidence[field])) {
    throw new Error(`Package evidence contains an invalid ${field}.`);
  }
}

const output = [
  `version=${evidence.version}`,
  `tarball=${evidence.tarball}`,
  `sha256=${evidence.sha256}`,
  `integrity=${evidence.integrity}`,
  `artifact_name=npm-release-${evidence.version}`,
].join("\n");
process.stdout.write(`${output}\n`);
