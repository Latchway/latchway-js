import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ARTIFACTS_PATH,
  ROOT_PATH,
  archiveNameFor,
  digestFile,
  expectedPackFiles,
  inspectTarball,
  readRootManifest,
  runConsumerSmoke,
} from "./release-utils.mjs";

runPackageManager(["build"]);
const manifest = await readRootManifest();
const archiveName = archiveNameFor(manifest);
const firstDirectory = join(ARTIFACTS_PATH, "pack-a");
const secondDirectory = join(ARTIFACTS_PATH, "pack-b");
const canonicalArchive = join(ARTIFACTS_PATH, archiveName);

await mkdir(ARTIFACTS_PATH, { recursive: true });
for (const path of [firstDirectory, secondDirectory]) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

pack(firstDirectory);
pack(secondDirectory);
const firstArchive = await onlyArchive(firstDirectory);
const secondArchive = await onlyArchive(secondDirectory);
const [firstBytes, secondBytes] = await Promise.all([readFile(firstArchive), readFile(secondArchive)]);
if (!firstBytes.equals(secondBytes)) {
  throw new Error("Two independent package operations did not produce byte-identical tarballs.");
}
const firstDigest = await digestFile(firstArchive);
const secondDigest = await digestFile(secondArchive);
if (firstDigest.sha256 !== secondDigest.sha256 || firstDigest.integrity !== secondDigest.integrity) {
  throw new Error("The byte-identical tarballs did not produce identical cryptographic digests.");
}

const inspection = await inspectTarball(firstArchive, manifest);
const expectedEntries = await expectedPackFiles();
if (JSON.stringify(inspection.entries) !== JSON.stringify(expectedEntries)) {
  throw new Error("The npm archive does not exactly match the release file allowlist.");
}
const consumer = await runConsumerSmoke(firstArchive, { typescript: true });

await copyFile(firstArchive, canonicalArchive);
await writeFile(
  join(ARTIFACTS_PATH, "SHA256SUMS"),
  `${firstDigest.sha256}  ${archiveName}\n`,
  { mode: 0o600 },
);
const evidence = {
  schema_version: 1,
  package: manifest.name,
  version: manifest.version,
  tarball: archiveName,
  bytes: firstDigest.bytes,
  sha1: firstDigest.sha1,
  sha256: firstDigest.sha256,
  sha512: firstDigest.sha512,
  integrity: firstDigest.integrity,
  double_pack_byte_identical: true,
  archive_allowlist_verified: true,
  archive_regular_files_only: true,
  credential_scan: "passed",
  entries: inspection.entries,
  unpacked_bytes: inspection.unpackedBytes,
  consumer,
};
await writeFile(
  join(ARTIFACTS_PATH, "package-evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
  { mode: 0o600 },
);
await rm(firstDirectory, { recursive: true, force: true });
await rm(secondDirectory, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

function pack(destination) {
  runPackageManager(["pack", "--pack-destination", destination]);
}

function runPackageManager(arguments_) {
  const packageManager = process.env.npm_execpath;
  if (packageManager === undefined) throw new Error("Run package verification through pnpm.");
  if (/\.[cm]?js$/u.test(packageManager)) {
    execFileSync(process.execPath, [packageManager, ...arguments_], {
      cwd: ROOT_PATH,
      stdio: "inherit",
    });
  } else {
    execFileSync(packageManager, arguments_, { cwd: ROOT_PATH, stdio: "inherit" });
  }
}

async function onlyArchive(directory) {
  const archives = (await readdir(directory)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1 || archives[0] !== archiveName) {
    throw new Error("Each package operation must produce exactly the expected npm archive.");
  }
  return join(directory, archiveName);
}
