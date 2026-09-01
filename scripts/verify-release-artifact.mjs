import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertReleaseCoordinates } from "./release-policy.mjs";
import {
  ARTIFACTS_PATH,
  digestFile,
  inspectTarball,
  readReleasePackages,
  runReleaseSetConsumerSmoke,
} from "./release-utils.mjs";

const expected = {
  version: requiredEnvironment("EXPECTED_VERSION", /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
  commit: requiredEnvironment("EXPECTED_SOURCE_COMMIT", /^[0-9a-f]{40}$/u),
  tag: requiredEnvironment("EXPECTED_RELEASE_TAG", /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
};
const packages = await readReleasePackages();
assertReleaseCoordinates(expected.tag, expected.version);
if (packages.some(({ manifest }) => manifest.version !== expected.version)) {
  throw new Error("The checkout package versions differ from the verified artifact version.");
}

const packageEvidenceBytes = await readFile(join(ARTIFACTS_PATH, "package-evidence.json"));
const packageEvidence = JSON.parse(packageEvidenceBytes.toString("utf8"));
const expectedOrder = packages.map(({ name }) => name);
if (
  packageEvidence.schema_version !== 2
  || packageEvidence.kind !== "latchway_npm_package_set_evidence"
  || packageEvidence.version !== expected.version
  || packageEvidence.package_count !== packages.length
  || JSON.stringify(packageEvidence.publish_order) !== JSON.stringify(expectedOrder)
  || !Array.isArray(packageEvidence.packages)
  || packageEvidence.packages.length !== packages.length
  || packageEvidence.consumer?.package_count !== packages.length
  || packageEvidence.consumer?.node_esm !== true
  || packageEvidence.consumer?.typescript !== true
  || packageEvidence.consumer?.peer_source !== "reviewed"
  || JSON.stringify(packageEvidence.consumer?.packages?.map(({ name }) => name)) !== JSON.stringify(expectedOrder)
) {
  throw new Error("The downloaded package-set evidence is incomplete or has an unexpected release order.");
}

const checksumLines = [];
const archives = [];
const publishPackages = [];
for (const [index, package_] of packages.entries()) {
  const evidence = packageEvidence.packages[index];
  if (
    evidence?.id !== package_.id
    || evidence.package !== package_.name
    || evidence.version !== expected.version
    || evidence.tarball !== package_.archiveName
    || evidence.double_pack_byte_identical !== true
    || evidence.archive_allowlist_verified !== true
    || evidence.archive_regular_files_only !== true
    || evidence.credential_scan !== "passed"
    || !Number.isSafeInteger(evidence.bytes)
    || evidence.bytes < 1
    || !/^[0-9a-f]{40}$/u.test(evidence.sha1)
    || !/^[0-9a-f]{64}$/u.test(evidence.sha256)
    || !/^[0-9a-f]{128}$/u.test(evidence.sha512)
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(evidence.integrity)
    || !Array.isArray(evidence.entries)
    || evidence.entries.length === 0
  ) {
    throw new Error(`The downloaded ${package_.name} evidence is incomplete.`);
  }
  const archivePath = join(ARTIFACTS_PATH, package_.archiveName);
  const digest = await digestFile(archivePath);
  for (const field of ["bytes", "sha1", "sha256", "sha512", "integrity"]) {
    if (digest[field] !== evidence[field]) {
      throw new Error(`The downloaded ${package_.name} archive does not match package-set evidence.`);
    }
  }
  const inspection = await inspectTarball(archivePath, package_);
  if (JSON.stringify(inspection.entries) !== JSON.stringify(evidence.entries)) {
    throw new Error(`The downloaded ${package_.name} archive entry list differs from package-set evidence.`);
  }
  checksumLines.push(`${digest.sha256}  ${package_.archiveName}`);
  archives.push({ name: package_.name, path: archivePath });
  publishPackages.push({
    id: package_.id,
    package: package_.name,
    version: expected.version,
    tarball: package_.archiveName,
    bytes: digest.bytes,
    sha1: digest.sha1,
    sha256: digest.sha256,
    sha512: digest.sha512,
    integrity: digest.integrity,
  });
}
const checksumBytes = await readFile(join(ARTIFACTS_PATH, "SHA256SUMS"));
if (checksumBytes.toString("utf8") !== `${checksumLines.sort().join("\n")}\n`) {
  throw new Error("SHA256SUMS does not exactly bind all four downloaded release archives.");
}

const candidate = JSON.parse(await readFile(join(ARTIFACTS_PATH, "release-candidate-evidence.json"), "utf8"));
const requiredGates = [
  "workflow-policy",
  "contract-lock",
  "release-policy",
  "lint",
  "typecheck",
  "clean-build",
  "unit-tests",
  "offline-release-tests",
  "examples",
  "exports",
  "web-browser-and-bundler-conformance",
  "build-reproducibility",
  "package-conformance",
];
if (
  candidate.schema_version !== 2
  || candidate.version !== expected.version
  || candidate.source_commit !== expected.commit
  || candidate.worktree_clean !== true
  || candidate.stable_version !== true
  || candidate.node !== "v24.19.0"
  || candidate.pnpm !== "10.15.0"
  || candidate.package_count !== packages.length
  || JSON.stringify(candidate.packages) !== JSON.stringify(expectedOrder)
  || JSON.stringify(candidate.gates?.map((gate) => gate.name)) !== JSON.stringify(requiredGates)
  || candidate.gates.some((gate) => gate.status !== "passed")
) {
  throw new Error("The release-candidate evidence is incomplete, dirty, or for a different commit.");
}

const tagEvidence = JSON.parse(await readFile(join(ARTIFACTS_PATH, "tag-evidence.json"), "utf8"));
if (tagEvidence.tag !== expected.tag || tagEvidence.commit !== expected.commit || tagEvidence.annotated !== true) {
  throw new Error("The annotated tag evidence does not bind this release artifact.");
}

const reproducibility = JSON.parse(await readFile(join(ARTIFACTS_PATH, "build-reproducibility.json"), "utf8"));
const contract = JSON.parse(await readFile(join(ARTIFACTS_PATH, "contract-evidence.json"), "utf8"));
if (
  reproducibility.identical !== true
  || reproducibility.package_count !== packages.length
  || !/^[0-9a-f]{64}$/u.test(reproducibility.sha256)
  || !Array.isArray(reproducibility.files)
  || reproducibility.files.length === 0
  || contract.contract_version !== "1.0.0"
  || contract.wire_protocol_version !== 2
  || !/^[0-9a-f]{64}$/u.test(contract.contract_lock_sha256)
) {
  throw new Error("Contract or four-package reproducible-build evidence is incomplete.");
}

const consumer = await runReleaseSetConsumerSmoke(archives, {
  typescript: false,
  peerSource: "registry",
});
const packageEvidenceDigest = await digestFile(join(ARTIFACTS_PATH, "package-evidence.json"));
const checksumDigest = await digestFile(join(ARTIFACTS_PATH, "SHA256SUMS"));
const publishInput = {
  schema_version: 2,
  kind: "latchway_npm_publish_input_evidence",
  version: expected.version,
  source_commit: expected.commit,
  release_tag: expected.tag,
  package_count: packages.length,
  publish_order: expectedOrder,
  packages: publishPackages,
  verified_job_evidence: true,
  package_evidence: { file: "package-evidence.json", sha256: packageEvidenceDigest.sha256 },
  checksums: { file: "SHA256SUMS", sha256: checksumDigest.sha256 },
  consumer,
};
await writeFile(
  join(ARTIFACTS_PATH, "publish-input-evidence.json"),
  `${JSON.stringify(publishInput, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${JSON.stringify(publishInput, null, 2)}\n`);

function requiredEnvironment(name, pattern) {
  const value = process.env[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Missing or invalid ${name}.`);
  return value;
}
