import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { assertReleaseCoordinates } from "./release-policy.mjs";
import {
  ARTIFACTS_PATH,
  digestFile,
  inspectTarball,
  readRootManifest,
  runConsumerSmoke,
} from "./release-utils.mjs";

const expected = {
  version: requiredEnvironment("EXPECTED_VERSION", /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
  tarball: requiredEnvironment("EXPECTED_TARBALL", /^[A-Za-z0-9._-]+\.tgz$/u),
  sha256: requiredEnvironment("EXPECTED_SHA256", /^[0-9a-f]{64}$/u),
  integrity: requiredEnvironment("EXPECTED_INTEGRITY", /^sha512-[A-Za-z0-9+/]+={0,2}$/u),
  commit: requiredEnvironment("EXPECTED_SOURCE_COMMIT", /^[0-9a-f]{40}$/u),
  tag: requiredEnvironment("EXPECTED_RELEASE_TAG", /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
};
const manifest = await readRootManifest();
assertReleaseCoordinates(expected.tag, expected.version);
if (manifest.version !== expected.version) throw new Error("The checkout version differs from the verified artifact version.");

const archivePath = join(ARTIFACTS_PATH, expected.tarball);
if (basename(archivePath) !== expected.tarball) throw new Error("The release archive name is unsafe.");
const digest = await digestFile(archivePath);
if (digest.sha256 !== expected.sha256 || digest.integrity !== expected.integrity) {
  throw new Error("The downloaded release archive does not match the verify-job digest.");
}
const checksum = await readFile(join(ARTIFACTS_PATH, "SHA256SUMS"), "utf8");
if (checksum !== `${expected.sha256}  ${expected.tarball}\n`) {
  throw new Error("SHA256SUMS does not exactly bind the downloaded release archive.");
}

const packageEvidence = JSON.parse(await readFile(join(ARTIFACTS_PATH, "package-evidence.json"), "utf8"));
if (packageEvidence.version !== expected.version || packageEvidence.tarball !== expected.tarball ||
    packageEvidence.sha256 !== expected.sha256 || packageEvidence.integrity !== expected.integrity ||
    packageEvidence.double_pack_byte_identical !== true || packageEvidence.consumer?.node_esm !== true ||
    packageEvidence.consumer?.typescript !== true || packageEvidence.archive_allowlist_verified !== true ||
    packageEvidence.archive_regular_files_only !== true || packageEvidence.credential_scan !== "passed") {
  throw new Error("The downloaded package evidence is incomplete or does not match workflow outputs.");
}
const inspection = await inspectTarball(archivePath, manifest);
if (JSON.stringify(inspection.entries) !== JSON.stringify(packageEvidence.entries)) {
  throw new Error("The downloaded release archive entry list differs from package evidence.");
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
  "examples",
  "exports",
  "build-reproducibility",
  "package-conformance",
];
if (candidate.version !== expected.version || candidate.source_commit !== expected.commit ||
    candidate.worktree_clean !== true || candidate.stable_version !== true || candidate.node !== "v24.19.0" ||
    candidate.pnpm !== "10.15.0" ||
    JSON.stringify(candidate.gates?.map((gate) => gate.name)) !== JSON.stringify(requiredGates) ||
    candidate.gates.some((gate) => gate.status !== "passed")) {
  throw new Error("The release-candidate evidence is incomplete, dirty, or for a different commit.");
}

const tagEvidence = JSON.parse(await readFile(join(ARTIFACTS_PATH, "tag-evidence.json"), "utf8"));
if (tagEvidence.tag !== `v${expected.version}` || tagEvidence.commit !== expected.commit ||
    tagEvidence.annotated !== true) {
  throw new Error("The annotated tag evidence does not bind this release artifact.");
}

const reproducibility = JSON.parse(await readFile(join(ARTIFACTS_PATH, "build-reproducibility.json"), "utf8"));
const contract = JSON.parse(await readFile(join(ARTIFACTS_PATH, "contract-evidence.json"), "utf8"));
if (reproducibility.identical !== true || !/^[0-9a-f]{64}$/u.test(reproducibility.sha256) ||
    contract.contract_version !== "0.5.1" || !/^[0-9a-f]{64}$/u.test(contract.contract_lock_sha256)) {
  throw new Error("Contract or reproducible-build evidence is incomplete.");
}

const consumer = await runConsumerSmoke(archivePath, { typescript: false });
const publishInput = {
  schema_version: 1,
  package: manifest.name,
  version: expected.version,
  source_commit: expected.commit,
  tarball: expected.tarball,
  sha256: digest.sha256,
  integrity: digest.integrity,
  verified_job_evidence: true,
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
