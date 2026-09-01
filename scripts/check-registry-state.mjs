import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import {
  readBoundedFileSync,
  readBoundedStrictJSONFileSync,
} from "./npm-release-evidence.mjs";
import {
  ARTIFACTS_PATH,
  fetchBytes,
  fetchJSON,
  packageVersionURL,
  readReleasePackages,
} from "./release-utils.mjs";

const packages = await readReleasePackages();
const evidence = readBoundedStrictJSONFileSync(
  join(ARTIFACTS_PATH, "package-evidence.json"),
  "Package-set registry preflight evidence",
  2 * 1024 * 1024,
);
if (!Array.isArray(evidence.packages) || evidence.packages.length !== packages.length) {
  throw new Error("Package-set evidence is incomplete.");
}

const publishState = {};
for (const [index, package_] of packages.entries()) {
  const packageEvidence = evidence.packages[index];
  if (packageEvidence?.package !== package_.name || packageEvidence.tarball !== package_.archiveName) {
    throw new Error(`Package-set evidence does not bind ${package_.name}.`);
  }
  const { response, value } = await fetchJSON(packageVersionURL(package_.name, package_.manifest.version), {
    maximumBytes: 2 * 1024 * 1024,
  });
  if (response.status === 404) {
    publishState[package_.name] = true;
    continue;
  }
  if (
    response.status !== 200
    || value.name !== package_.name
    || value.version !== package_.manifest.version
    || value.dist?.integrity !== packageEvidence.integrity
    || value.dist?.shasum !== packageEvidence.sha1
  ) {
    throw new Error(`${package_.name}@${package_.manifest.version} already exists with different metadata.`);
  }
  const result = await fetchBytes(value.dist.tarball, {
    maximumBytes: 10 * 1024 * 1024,
    accept: "application/octet-stream",
  });
  const localBytes = readBoundedFileSync(
    join(ARTIFACTS_PATH, package_.archiveName),
    `${package_.name} registry-preflight archive`,
    10 * 1024 * 1024,
  );
  if (result.response.status !== 200 || !localBytes.equals(result.bytes)) {
    throw new Error(`${package_.name}@${package_.manifest.version} exists with different archive bytes.`);
  }
  publishState[package_.name] = false;
}

const output = `publish_state=${JSON.stringify(publishState)}\n`;
if (typeof process.env.GITHUB_OUTPUT === "string") {
  await appendFile(process.env.GITHUB_OUTPUT, output, { mode: 0o600 });
} else {
  process.stdout.write(output);
}
