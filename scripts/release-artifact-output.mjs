import { join } from "node:path";

import { ARTIFACTS_PATH, readReleasePackages } from "./release-utils.mjs";
import { assertReleaseCoordinates } from "./release-policy.mjs";
import {
  npmReleaseArtifactName,
  readBoundedStrictJSONFileSync,
} from "./npm-release-evidence.mjs";

const packages = await readReleasePackages();
const evidence = readBoundedStrictJSONFileSync(
  join(ARTIFACTS_PATH, "package-evidence.json"),
  "Package-set artifact output evidence",
  2 * 1024 * 1024,
);
assertReleaseCoordinates(process.env.EXPECTED_RELEASE_TAG, evidence.version);
if (
  evidence.schema_version !== 2
  || evidence.kind !== "latchway_npm_package_set_evidence"
  || evidence.package_count !== packages.length
  || JSON.stringify(evidence.publish_order) !== JSON.stringify(packages.map(({ name }) => name))
  || !Array.isArray(evidence.packages)
  || evidence.packages.length !== packages.length
) {
  throw new Error("Package-set evidence is incomplete or has an unexpected release order.");
}
for (const [index, package_] of packages.entries()) {
  const item = evidence.packages[index];
  if (
    item?.id !== package_.id
    || item.package !== package_.name
    || item.version !== package_.manifest.version
    || item.tarball !== package_.archiveName
    || !/^[0-9a-f]{64}$/u.test(item.sha256)
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(item.integrity)
  ) {
    throw new Error(`Package-set evidence contains invalid ${package_.name} coordinates.`);
  }
}

const output = [
  `version=${evidence.version}`,
  `artifact_name=${npmReleaseArtifactName(
    evidence.version,
    process.env.GITHUB_RUN_ID,
    process.env.GITHUB_RUN_ATTEMPT,
  )}`,
].join("\n");
process.stdout.write(`${output}\n`);
