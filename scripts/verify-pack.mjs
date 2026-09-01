import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ARTIFACTS_PATH,
  ROOT_PATH,
  digestFile,
  expectedPackFiles,
  inspectTarball,
  readReleasePackages,
  runReleaseSetConsumerSmoke,
} from "./release-utils.mjs";

runPackageManager(["build"], ROOT_PATH);
const packages = await readReleasePackages();
const releaseVersion = packages[0].manifest.version;
await mkdir(ARTIFACTS_PATH, { recursive: true });

const packageEvidence = [];
const packageArchives = [];
for (const package_ of packages) {
  const firstDirectory = join(ARTIFACTS_PATH, `pack-a-${package_.id}`);
  const secondDirectory = join(ARTIFACTS_PATH, `pack-b-${package_.id}`);
  const canonicalArchive = join(ARTIFACTS_PATH, package_.archiveName);
  await rm(canonicalArchive, { force: true });
  for (const path of [firstDirectory, secondDirectory]) {
    await rm(path, { recursive: true, force: true });
    await mkdir(path, { recursive: true });
  }

  const expectedEntries = await expectedPackFiles(package_);
  pack(package_, firstDirectory);
  pack(package_, secondDirectory);
  const firstArchive = await onlyArchive(firstDirectory, package_.archiveName);
  const secondArchive = await onlyArchive(secondDirectory, package_.archiveName);
  const [firstBytes, secondBytes] = await Promise.all([readFile(firstArchive), readFile(secondArchive)]);
  if (!firstBytes.equals(secondBytes)) {
    throw new Error(`Two independent ${package_.name} pack operations did not produce byte-identical tarballs.`);
  }
  const firstDigest = await digestFile(firstArchive);
  const secondDigest = await digestFile(secondArchive);
  if (firstDigest.sha256 !== secondDigest.sha256 || firstDigest.integrity !== secondDigest.integrity) {
    throw new Error(`The byte-identical ${package_.name} tarballs produced different cryptographic digests.`);
  }

  const inspection = await inspectTarball(firstArchive, package_);
  if (JSON.stringify(inspection.entries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`The ${package_.name} archive does not exactly match its release file allowlist.`);
  }

  await copyFile(firstArchive, canonicalArchive);
  packageArchives.push({ name: package_.name, path: canonicalArchive });
  packageEvidence.push({
    id: package_.id,
    package: package_.name,
    version: package_.manifest.version,
    tarball: package_.archiveName,
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
    published_peer_dependencies: inspection.manifest.peerDependencies ?? {},
  });
  await rm(firstDirectory, { recursive: true, force: true });
  await rm(secondDirectory, { recursive: true, force: true });
}

const consumer = await runReleaseSetConsumerSmoke(packageArchives, {
  typescript: true,
  peerSource: "reviewed",
});
const checksums = packageEvidence
  .map(({ sha256, tarball }) => `${sha256}  ${tarball}`)
  .sort()
  .join("\n");
await writeFile(join(ARTIFACTS_PATH, "SHA256SUMS"), `${checksums}\n`, { mode: 0o600 });

const evidence = {
  schema_version: 2,
  kind: "latchway_npm_package_set_evidence",
  version: releaseVersion,
  package_count: packages.length,
  publish_order: packages.map(({ name }) => name),
  packages: packageEvidence,
  consumer,
};
await writeFile(
  join(ARTIFACTS_PATH, "package-evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

function pack(package_, destination) {
  runPackageManager(["pack", "--pack-destination", destination], package_.directory);
}

function runPackageManager(arguments_, cwd) {
  const packageManager = process.env.npm_execpath;
  if (packageManager === undefined) throw new Error("Run package verification through pnpm.");
  if (/\.[cm]?js$/u.test(packageManager)) {
    execFileSync(process.execPath, [packageManager, ...arguments_], {
      cwd,
      stdio: "inherit",
    });
  } else {
    execFileSync(packageManager, arguments_, { cwd, stdio: "inherit" });
  }
}

async function onlyArchive(directory, archiveName) {
  const archives = (await readdir(directory)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1 || archives[0] !== archiveName) {
    throw new Error(`Each package operation must produce exactly ${archiveName}.`);
  }
  return join(directory, archiveName);
}
