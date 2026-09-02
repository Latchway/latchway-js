import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

export const BOOTSTRAP_VERSION = "0.0.0-bootstrap.0";
export const BOOTSTRAP_TAG = "bootstrap";
export const BOOTSTRAP_REGISTRY = "https://registry.npmjs.org/";
export const BOOTSTRAP_SCOPE_REGISTRY_ARGUMENT =
  `--@latchway:registry=${BOOTSTRAP_REGISTRY}`;
export const BOOTSTRAP_NPM_VERSION = "11.17.0";
export const PUBLISH_CONFIRMATION = "publish-five-latchway-bootstrap-packages";

const ROOT_PATH = fileURLToPath(new URL("..", import.meta.url));
const HELPER_PATH = fileURLToPath(import.meta.url);
const DEFAULT_OUTPUT_DIRECTORY = join(ROOT_PATH, ".artifacts", "npm-namespace-bootstrap");
const LICENSE_PATH = join(ROOT_PATH, "LICENSE");
const SOURCE_REPOSITORY = "https://github.com/Latchway/latchway-js";
const TRACKED_BOOTSTRAP_INPUTS = Object.freeze(["LICENSE", "scripts/npm-namespace-bootstrap.mjs"]);
const MAXIMUM_ARCHIVE_BYTES = 64 * 1024;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAXIMUM_PACKUMENT_BYTES = 512 * 1024;
const REGISTRY_VERIFY_ATTEMPTS = 12;
const REGISTRY_VERIFY_DELAY_MILLISECONDS = 2_000;
const EXPECTED_ARCHIVE_ENTRIES = Object.freeze([
  "package/LICENSE",
  "package/README.md",
  "package/package.json",
]);
const FORBIDDEN_MANIFEST_FIELDS = new Set([
  "bin",
  "bundleDependencies",
  "bundledDependencies",
  "dependencies",
  "devDependencies",
  "exports",
  "main",
  "module",
  "optionalDependencies",
  "peerDependencies",
  "scripts",
  "types",
]);
const SECRET_CONTENT = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9_-]{32,})\b/u,
  /\/\/registry\.npmjs\.org\/:_authToken\s*=\s*[^\s]+/u,
];
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export const BOOTSTRAP_PACKAGES = Object.freeze([
  packageDefinition(
    "client",
    "@latchway/client",
    "Reserved namespace bootstrap for the Latchway JavaScript client.",
    "git+https://github.com/Latchway/latchway-js.git",
  ),
  packageDefinition(
    "openai",
    "@latchway/openai",
    "Reserved namespace bootstrap for the Latchway OpenAI adapter.",
    "git+https://github.com/Latchway/latchway-js.git",
    "packages/openai",
  ),
  packageDefinition(
    "vercel-ai",
    "@latchway/vercel-ai",
    "Reserved namespace bootstrap for the Latchway Vercel AI adapter.",
    "git+https://github.com/Latchway/latchway-js.git",
    "packages/vercel-ai",
  ),
  packageDefinition(
    "langchain",
    "@latchway/langchain",
    "Reserved namespace bootstrap for the Latchway LangChain adapter.",
    "git+https://github.com/Latchway/latchway-js.git",
    "packages/langchain",
  ),
  packageDefinition(
    "react-native",
    "@latchway/react-native",
    "Reserved namespace bootstrap for the Latchway React Native client.",
    "git+https://github.com/Latchway/latchway-react-native-sdk.git",
  ),
]);

export function bootstrapManifest(definition) {
  return {
    name: definition.name,
    version: BOOTSTRAP_VERSION,
    description: definition.description,
    license: "Apache-2.0",
    files: ["LICENSE", "README.md"],
    repository: definition.repository,
    publishConfig: {
      access: "public",
      registry: BOOTSTRAP_REGISTRY,
      tag: BOOTSTRAP_TAG,
    },
  };
}

export function publishArguments(archive) {
  return [
    "publish",
    archive,
    "--access=public",
    `--tag=${BOOTSTRAP_TAG}`,
    `--registry=${BOOTSTRAP_REGISTRY}`,
    BOOTSTRAP_SCOPE_REGISTRY_ARGUMENT,
    "--ignore-scripts",
  ];
}

export function removeUnexpectedLatestArguments(packageName) {
  if (!BOOTSTRAP_PACKAGES.some((definition) => definition.name === packageName)) {
    throw new Error("Unexpected-latest recovery is limited to the fixed bootstrap package set.");
  }
  return [
    "dist-tag",
    "rm",
    packageName,
    "latest",
    `--registry=${BOOTSTRAP_REGISTRY}`,
    BOOTSTRAP_SCOPE_REGISTRY_ARGUMENT,
    "--ignore-scripts",
  ];
}

export function parseArguments(arguments_) {
  let mode;
  let confirmation;
  let reviewedCommit;
  let outputDirectory = DEFAULT_OUTPUT_DIRECTORY;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--dry-run" || argument === "--publish") {
      const nextMode = argument.slice(2);
      if (mode !== undefined) throw new Error("Choose exactly one of --dry-run or --publish.");
      mode = nextMode;
    } else if (argument === "--output-directory") {
      const value = arguments_[index + 1];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("--output-directory requires a path.");
      }
      outputDirectory = resolve(value);
      index += 1;
    } else if (argument === "--confirm") {
      const value = arguments_[index + 1];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("--confirm requires the documented confirmation phrase.");
      }
      confirmation = value;
      index += 1;
    } else if (argument === "--reviewed-commit") {
      const value = arguments_[index + 1];
      if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
        throw new Error("--reviewed-commit requires the exact lowercase 40-character reviewed commit.");
      }
      reviewedCommit = value;
      index += 1;
    } else if (argument === "--help") {
      return { help: true };
    } else {
      throw new Error(`Unknown namespace-bootstrap argument: ${argument}`);
    }
  }
  if (mode === undefined) throw new Error("Choose exactly one of --dry-run or --publish.");
  if (mode === "publish" && confirmation !== PUBLISH_CONFIRMATION) {
    throw new Error(`Publication requires --confirm ${PUBLISH_CONFIRMATION}.`);
  }
  if (mode === "dry-run" && confirmation !== undefined) {
    throw new Error("--confirm is valid only with --publish.");
  }
  if (reviewedCommit === undefined) {
    throw new Error("--reviewed-commit is required for every bootstrap dry run and publication.");
  }
  return {
    confirmation,
    help: false,
    mode,
    outputDirectory: assertSafeOutputDirectory(outputDirectory),
    reviewedCommit,
  };
}

export async function buildBootstrapArchives(outputDirectory, npmCommand = npmExecutable(), sourceIdentity) {
  await assertCurrentSourceMaterial(sourceIdentity, npmCommand);
  const safeOutput = assertSafeOutputDirectory(outputDirectory);
  await ensureOutputDirectory(safeOutput);
  const expectedFiles = expectedOutputFiles();
  await rejectUnexpectedOutputFiles(safeOutput, expectedFiles);
  const license = await readFile(LICENSE_PATH);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "latchway-npm-bootstrap-build-"));
  try {
    const packedDirectory = join(temporaryRoot, "packed");
    const emptyUserConfig = join(temporaryRoot, "empty-npmrc");
    await mkdir(packedDirectory, { mode: 0o700 });
    await writeFile(emptyUserConfig, "", { mode: 0o600 });
    const packages = [];
    for (const definition of BOOTSTRAP_PACKAGES) {
      const stagingDirectory = join(temporaryRoot, definition.id);
      await mkdir(stagingDirectory, { mode: 0o700 });
      const manifest = bootstrapManifest(definition);
      await Promise.all([
        writeFile(
          join(stagingDirectory, "package.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          { mode: 0o600 },
        ),
        writeFile(join(stagingDirectory, "README.md"), bootstrapReadme(definition), { mode: 0o600 }),
        copyFile(LICENSE_PATH, join(stagingDirectory, "LICENSE")),
      ]);
      runNpm(
        npmCommand,
        [
          "pack",
          stagingDirectory,
          "--json",
          "--ignore-scripts",
          `--pack-destination=${packedDirectory}`,
        ],
        temporaryRoot,
        "pipe",
        {
          NPM_CONFIG_CACHE: join(temporaryRoot, "npm-cache"),
          NPM_CONFIG_USERCONFIG: emptyUserConfig,
        },
      );
      const archiveName = archiveNameFor(definition);
      const packedArchive = join(packedDirectory, archiveName);
      const inspection = await inspectArchive(packedArchive, definition, manifest, license);
      const outputArchive = join(safeOutput, archiveName);
      await writeOrCompare(outputArchive, await readFile(packedArchive));
      packages.push({
        name: definition.name,
        repository: definition.repository,
        archive: archiveName,
        bytes: inspection.bytes,
        sha256: inspection.sha256,
        entries: inspection.entries,
        publish_command: [npmCommand, ...publishArguments(`./${archiveName}`)],
      });
    }
    await rejectUnexpectedOutputFiles(safeOutput, expectedFiles);
    const inspection = {
      schema_version: 1,
      kind: "latchway_npm_namespace_bootstrap_inspection",
      version: BOOTSTRAP_VERSION,
      dist_tag: BOOTSTRAP_TAG,
      registry: BOOTSTRAP_REGISTRY,
      package_count: packages.length,
      publication_performed: false,
      source: sourceIdentity.source,
      toolchain: sourceIdentity.toolchain,
      packages,
    };
    const inspectionBytes = Buffer.from(`${JSON.stringify(inspection, null, 2)}\n`);
    await writeOrCompare(join(safeOutput, "inspection.json"), inspectionBytes);
    return inspection;
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

export async function publishBootstrapArchives(
  outputDirectory,
  reviewedCommit,
  expectedSourceIdentity,
  npmCommand = npmExecutable(),
) {
  assertNoTokenEnvironment();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Namespace bootstrap publication requires an interactive terminal.");
  }
  const sourceIdentity = await verifyReviewedCheckout(reviewedCommit, npmCommand);
  if (JSON.stringify(sourceIdentity) !== JSON.stringify(expectedSourceIdentity)) {
    throw new Error("Reviewed source or npm toolchain changed between archive generation and publication.");
  }
  const safeOutput = assertSafeOutputDirectory(outputDirectory);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "latchway-npm-bootstrap-publish-"));
  try {
    return await reconcileBootstrapRegistry(safeOutput, {
      fetchImplementation: globalThis.fetch,
      publish: async (_definition, archive) => {
        runNpm(npmCommand, publishArguments(archive), safeOutput, "inherit", {
          NPM_CONFIG_CACHE: join(temporaryRoot, "npm-cache"),
        });
      },
      removeUnexpectedLatest: async (definition) => {
        runNpm(
          npmCommand,
          removeUnexpectedLatestArguments(definition.name),
          safeOutput,
          "inherit",
          { NPM_CONFIG_CACHE: join(temporaryRoot, "npm-cache") },
        );
      },
      sourceIdentity,
      waitImplementation: wait,
    });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

export async function reconcileBootstrapRegistry(outputDirectory, options) {
  const safeOutput = assertSafeOutputDirectory(outputDirectory);
  if (typeof options?.fetchImplementation !== "function" || typeof options?.publish !== "function" ||
      typeof options?.removeUnexpectedLatest !== "function" ||
      typeof options?.waitImplementation !== "function") {
    throw new Error(
      "Registry reconciliation requires explicit fetch, publish, unexpected-latest removal, and wait implementations.",
    );
  }
  assertSourceIdentityShape(options.sourceIdentity);
  const license = await readFile(LICENSE_PATH);
  const localPackages = [];
  for (const definition of BOOTSTRAP_PACKAGES) {
    const archive = join(safeOutput, archiveNameFor(definition));
    const manifest = bootstrapManifest(definition);
    const inspection = await inspectArchive(archive, definition, manifest, license);
    localPackages.push({ archive, definition, inspection, manifest });
  }

  const initialStates = [];
  for (const package_ of localPackages) {
    initialStates.push(await inspectRegistryState(package_, options.fetchImplementation));
  }
  for (let index = 0; index < localPackages.length; index += 1) {
    if (initialStates[index].state === "verified") continue;
    const package_ = localPackages[index];
    if (initialStates[index].state === "recoverable-unexpected-latest") {
      await recoverUnexpectedLatest(package_, options);
      continue;
    }
    let publishError;
    try {
      await options.publish(package_.definition, package_.archive);
    } catch (error) {
      publishError = error;
    }
    try {
      const publishedState = await waitForCreatedRegistryState(package_, options);
      if (publishedState.state === "recoverable-unexpected-latest") {
        await recoverUnexpectedLatest(package_, options);
      }
    } catch (verificationError) {
      if (publishError !== undefined) {
        throw new AggregateError(
          [publishError, verificationError],
          `${package_.definition.name} publication failed and no exact bootstrap record appeared.`,
          { cause: verificationError },
        );
      }
      throw verificationError;
    }
  }

  const packages = [];
  for (const package_ of localPackages) {
    const state = await inspectRegistryState(package_, options.fetchImplementation);
    if (state.state !== "verified") {
      throw new Error(`${package_.definition.name} disappeared during final registry-closure verification.`);
    }
    packages.push(state.record);
  }
  const completed = {
    schema_version: 1,
    kind: "latchway_npm_namespace_bootstrap_completed",
    version: BOOTSTRAP_VERSION,
    dist_tag: BOOTSTRAP_TAG,
    registry: BOOTSTRAP_REGISTRY,
    package_count: packages.length,
    source: options.sourceIdentity.source,
    toolchain: options.sourceIdentity.toolchain,
    packages,
  };
  await writeOrCompare(
    join(safeOutput, "completed.json"),
    Buffer.from(`${JSON.stringify(completed, null, 2)}\n`),
  );
  return completed;
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.help) {
    process.stdout.write(usage());
    return;
  }
  if (arguments_.mode === "publish") assertNoTokenEnvironment();
  const sourceIdentity = await verifyReviewedCheckout(arguments_.reviewedCommit);
  const inspection = await buildBootstrapArchives(
    arguments_.outputDirectory,
    npmExecutable(),
    sourceIdentity,
  );
  process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
  if (arguments_.mode === "publish") {
    const completed = await publishBootstrapArchives(
      arguments_.outputDirectory,
      arguments_.reviewedCommit,
      sourceIdentity,
    );
    process.stdout.write(`${JSON.stringify(completed, null, 2)}\n`);
  }
}

export async function verifyReviewedCheckout(reviewedCommit, npmCommand = npmExecutable()) {
  const head = runGit(["rev-parse", "--verify", "HEAD"]);
  const trackedStatus = runGit(["status", "--porcelain=v1", "--untracked-files=no"]);
  const trackedInputs = runGit(["ls-files", "--error-unmatch", "--", ...TRACKED_BOOTSTRAP_INPUTS]);
  validateReviewedCheckoutState({
    head,
    npmVersion: npmVersion(npmCommand),
    reviewedCommit,
    trackedInputs,
    trackedStatus,
  });
  const identity = await sourceMaterialIdentity(reviewedCommit, npmCommand);
  for (const [name, path] of [["helper", "scripts/npm-namespace-bootstrap.mjs"], ["license", "LICENSE"]]) {
    const committedBytes = runGitBytes(["show", `${reviewedCommit}:${path}`]);
    const committedSHA256 = createHash("sha256").update(committedBytes).digest("hex");
    if (identity.source[name].sha256 !== committedSHA256) {
      throw new Error(`Bootstrap ${path} bytes do not match the exact reviewed commit.`);
    }
  }
  if (runGit(["rev-parse", "--verify", "HEAD"]) !== `${reviewedCommit}\n`) {
    throw new Error("Bootstrap HEAD changed during reviewed source verification.");
  }
  return identity;
}

export function validateReviewedCheckoutState({
  head,
  npmVersion: version,
  reviewedCommit,
  trackedInputs,
  trackedStatus,
}) {
  if (!/^[a-f0-9]{40}$/u.test(reviewedCommit) || head !== `${reviewedCommit}\n`) {
    throw new Error("Bootstrap HEAD is not the exact reviewed commit.");
  }
  if (trackedStatus !== "") {
    throw new Error("Bootstrap requires a clean tracked checkout with no staged or unstaged changes.");
  }
  const paths = trackedInputs.split("\n").filter(Boolean).sort();
  if (JSON.stringify(paths) !== JSON.stringify([...TRACKED_BOOTSTRAP_INPUTS].sort())) {
    throw new Error("Bootstrap helper and LICENSE must be tracked inputs in the reviewed commit.");
  }
  if (version !== BOOTSTRAP_NPM_VERSION) {
    throw new Error(`Bootstrap requires exact reviewed npm ${BOOTSTRAP_NPM_VERSION}; found ${version}.`);
  }
}

export async function sourceMaterialIdentity(reviewedCommit, npmCommand = npmExecutable()) {
  if (!/^[a-f0-9]{40}$/u.test(reviewedCommit)) {
    throw new Error("Bootstrap source identity requires an exact lowercase 40-character commit.");
  }
  const version = npmVersion(npmCommand);
  if (version !== BOOTSTRAP_NPM_VERSION) {
    throw new Error(`Bootstrap requires exact reviewed npm ${BOOTSTRAP_NPM_VERSION}; found ${version}.`);
  }
  const [helper, license] = await Promise.all([readFile(HELPER_PATH), readFile(LICENSE_PATH)]);
  return {
    source: {
      repository: SOURCE_REPOSITORY,
      commit: reviewedCommit,
      helper: {
        path: "scripts/npm-namespace-bootstrap.mjs",
        sha256: createHash("sha256").update(helper).digest("hex"),
      },
      license: {
        path: "LICENSE",
        sha256: createHash("sha256").update(license).digest("hex"),
      },
    },
    toolchain: { npm: version },
  };
}

async function assertCurrentSourceMaterial(sourceIdentity, npmCommand) {
  assertSourceIdentityShape(sourceIdentity);
  const current = await sourceMaterialIdentity(sourceIdentity.source.commit, npmCommand);
  if (JSON.stringify(current) !== JSON.stringify(sourceIdentity)) {
    throw new Error("Bootstrap helper, LICENSE, or npm toolchain changed after checkout verification.");
  }
}

function assertSourceIdentityShape(value) {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.toolchain) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["source", "toolchain"]) ||
      JSON.stringify(Object.keys(value.source).sort()) !==
        JSON.stringify(["commit", "helper", "license", "repository"]) ||
      JSON.stringify(Object.keys(value.toolchain)) !== JSON.stringify(["npm"]) ||
      value.source.repository !== SOURCE_REPOSITORY ||
      !/^[a-f0-9]{40}$/u.test(value.source.commit) ||
      value.toolchain.npm !== BOOTSTRAP_NPM_VERSION) {
    throw new Error("Bootstrap source identity is malformed.");
  }
  for (const [name, path] of [["helper", "scripts/npm-namespace-bootstrap.mjs"], ["license", "LICENSE"]]) {
    const input = value.source[name];
    if (!isRecord(input) || JSON.stringify(Object.keys(input).sort()) !==
        JSON.stringify(["path", "sha256"]) || input.path !== path ||
        typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.sha256)) {
      throw new Error(`Bootstrap ${name} source identity is malformed.`);
    }
  }
}

function packageDefinition(id, name, description, repositoryURL, directory) {
  const repository = { type: "git", url: repositoryURL };
  if (directory !== undefined) repository.directory = directory;
  return Object.freeze({
    description,
    id,
    name,
    repository: Object.freeze(repository),
  });
}

function bootstrapReadme(definition) {
  return `# ${definition.name}\n\n` +
    "This is an inert, one-time namespace bootstrap package. It contains no runtime " +
    "implementation and must not be used as an SDK dependency.\n\n" +
    `The maintained source repository is ${definition.repository.url.replace(/^git\+/u, "")}.\n`;
}

function archiveNameFor(definition) {
  return `${definition.name.replace(/^@/u, "").replaceAll("/", "-")}-${BOOTSTRAP_VERSION}.tgz`;
}

function assertSafeOutputDirectory(value) {
  const output = resolve(value);
  if (!isAllowedCanonicalOutput(canonicalizeForPolicy(output))) {
    throw new Error("Bootstrap output must be below repository .artifacts/ or the operating-system temp directory.");
  }
  return output;
}

async function ensureOutputDirectory(outputDirectory) {
  await mkdir(outputDirectory, { mode: 0o700, recursive: true });
  const metadata = await lstat(outputDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Bootstrap output must be a non-symlink directory.");
  }
  if (!isAllowedCanonicalOutput(await realpath(outputDirectory))) {
    throw new Error("Bootstrap output resolves outside repository .artifacts/ and approved temp roots.");
  }
}

function canonicalizeForPolicy(value) {
  let existing = resolve(value);
  const missingSegments = [];
  while (true) {
    try {
      return resolve(realpathSync(existing), ...missingSegments.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missingSegments.push(basename(existing));
      existing = parent;
    }
  }
}

function isAllowedCanonicalOutput(output) {
  const roots = [join(ROOT_PATH, ".artifacts"), tmpdir()];
  if (process.platform !== "win32") roots.push("/tmp");
  return roots.some((root) => isStrictDescendant(canonicalizeForPolicy(root), output));
}

function isStrictDescendant(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== "." && path !== ".." && !isAbsolute(path) &&
    !path.startsWith(`..${sep}`);
}

function expectedOutputFiles() {
  return new Set([
    ...BOOTSTRAP_PACKAGES.map((definition) => archiveNameFor(definition)),
    "completed.json",
    "inspection.json",
  ]);
}

async function rejectUnexpectedOutputFiles(outputDirectory, expectedFiles) {
  for (const entry of await readdir(outputDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !expectedFiles.has(entry.name)) {
      throw new Error(`Bootstrap output contains an unexpected entry: ${entry.name}`);
    }
  }
}

async function writeOrCompare(path, bytes) {
  try {
    const existing = await readFile(path);
    if (!existing.equals(bytes)) {
      throw new Error(`Refusing to replace non-identical reviewed bootstrap output: ${basename(path)}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  }
}

async function inspectArchive(archive, definition, expectedManifest, expectedLicense) {
  const metadata = await lstat(archive);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAXIMUM_ARCHIVE_BYTES) {
    throw new Error(`${definition.name} bootstrap archive must be a bounded regular file.`);
  }
  const entries = tarOutput(["-tzf", archive]).split("\n").filter(Boolean).sort();
  if (JSON.stringify(entries) !== JSON.stringify(EXPECTED_ARCHIVE_ENTRIES)) {
    throw new Error(`${definition.name} bootstrap archive has an unexpected file closure.`);
  }
  const verbose = tarOutput(["-tvzf", archive]).split("\n").filter(Boolean);
  if (verbose.length !== entries.length || verbose.some((line) => !line.startsWith("-"))) {
    throw new Error(`${definition.name} bootstrap archive must contain regular files only.`);
  }
  const manifestBytes = tarBytes(archive, "package/package.json");
  const readmeBytes = tarBytes(archive, "package/README.md");
  const licenseBytes = tarBytes(archive, "package/LICENSE");
  const manifest = JSON.parse(UTF8.decode(manifestBytes));
  assertBootstrapManifest(manifest, expectedManifest, definition.name);
  if (UTF8.decode(readmeBytes) !== bootstrapReadme(definition)) {
    throw new Error(`${definition.name} bootstrap README is not the inert reviewed text.`);
  }
  if (!licenseBytes.equals(expectedLicense)) {
    throw new Error(`${definition.name} bootstrap archive does not contain the canonical Apache-2.0 license.`);
  }
  for (const bytes of [manifestBytes, readmeBytes, licenseBytes]) {
    const text = UTF8.decode(bytes);
    if (SECRET_CONTENT.some((pattern) => pattern.test(text))) {
      throw new Error(`${definition.name} bootstrap archive contains credential-like content.`);
    }
  }
  const archiveBytes = await readFile(archive);
  const sha512 = createHash("sha512").update(archiveBytes).digest();
  return {
    archiveBytes,
    bytes: archiveBytes.byteLength,
    integrity: `sha512-${sha512.toString("base64")}`,
    entries,
    shasum: createHash("sha1").update(archiveBytes).digest("hex"),
    sha256: createHash("sha256").update(archiveBytes).digest("hex"),
  };
}

function assertBootstrapManifest(value, expected, packageName) {
  if (!isRecord(value) || JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${packageName} bootstrap package.json differs from the reviewed manifest.`);
  }
  for (const field of FORBIDDEN_MANIFEST_FIELDS) {
    if (Object.hasOwn(value, field)) {
      throw new Error(`${packageName} bootstrap package.json contains forbidden field ${field}.`);
    }
  }
  if (value.publishConfig?.tag !== BOOTSTRAP_TAG || value.publishConfig?.access !== "public" ||
      value.publishConfig?.registry !== BOOTSTRAP_REGISTRY) {
    throw new Error(`${packageName} bootstrap publish configuration is unsafe.`);
  }
}

async function inspectRegistryState(package_, fetchImplementation) {
  const { archive, definition, inspection, manifest } = package_;
  const packumentURL = new URL(encodeURIComponent(definition.name), BOOTSTRAP_REGISTRY);
  const response = await fetchImplementation(packumentURL, {
    cache: "no-store",
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return { state: "absent" };
  if (!response.ok) {
    throw new Error(`${definition.name} registry metadata returned HTTP ${response.status}.`);
  }
  const packument = parseRegistryJSON(
    await readBoundedResponse(response, MAXIMUM_PACKUMENT_BYTES, `${definition.name} registry metadata`),
    `${definition.name} registry metadata`,
  );
  const { state, versionManifest } = assertRegistryIdentity(packument, definition, manifest);
  const distribution = versionManifest.dist;
  if (!isRecord(distribution) || distribution.integrity !== inspection.integrity ||
      distribution.shasum !== inspection.shasum || typeof distribution.tarball !== "string") {
    throw new Error(`${definition.name} registry distribution digests differ from the reviewed archive.`);
  }
  const tarballURL = assertRegistryTarballURL(distribution.tarball, definition.name);
  const tarballResponse = await fetchImplementation(tarballURL, {
    cache: "no-store",
    headers: { accept: "application/octet-stream" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!tarballResponse.ok) {
    throw new Error(`${definition.name} registry archive returned HTTP ${tarballResponse.status}.`);
  }
  const registryArchive = await readBoundedResponse(
    tarballResponse,
    MAXIMUM_ARCHIVE_BYTES,
    `${definition.name} registry archive`,
  );
  if (!registryArchive.equals(inspection.archiveBytes)) {
    throw new Error(`${definition.name} registry archive is not byte-identical to ${basename(archive)}.`);
  }
  return {
    state,
    record: {
      name: definition.name,
      version: BOOTSTRAP_VERSION,
      dist_tag: BOOTSTRAP_TAG,
      repository: definition.repository,
      manifest,
      archive: basename(archive),
      bytes: inspection.bytes,
      sha256: inspection.sha256,
      shasum: inspection.shasum,
      integrity: inspection.integrity,
    },
  };
}

function assertRegistryIdentity(packument, definition, manifest) {
  if (!isRecord(packument) || packument.name !== definition.name ||
      !isRecord(packument["dist-tags"]) || !isRecord(packument.versions)) {
    throw new Error(`${definition.name} registry identity is malformed.`);
  }
  if (JSON.stringify(Object.keys(packument.versions).sort()) !== JSON.stringify([BOOTSTRAP_VERSION])) {
    throw new Error(`${definition.name} registry versions are not the one-version bootstrap closure.`);
  }
  const versionManifest = packument.versions[BOOTSTRAP_VERSION];
  if (!isRecord(versionManifest)) {
    throw new Error(`${definition.name} registry version manifest is missing.`);
  }
  for (const [field, expected] of Object.entries(manifest)) {
    if (field === "files" && versionManifest[field] === undefined &&
        JSON.stringify(expected) === JSON.stringify(["LICENSE", "README.md"])) {
      // npm omits the package.json files allowlist from the public packument.
      // inspectRegistryState still requires the downloaded registry archive to
      // be byte-identical, so the reviewed package.json and three-file closure
      // remain the authority before any recovery mutation.
      continue;
    }
    if (JSON.stringify(versionManifest[field]) !== JSON.stringify(expected)) {
      throw new Error(`${definition.name} registry manifest field ${field} differs from the reviewed identity.`);
    }
  }
  for (const field of FORBIDDEN_MANIFEST_FIELDS) {
    if (Object.hasOwn(versionManifest, field)) {
      throw new Error(`${definition.name} registry manifest contains forbidden field ${field}.`);
    }
  }
  const tags = packument["dist-tags"];
  const tagNames = Object.keys(tags).sort();
  if (JSON.stringify(tagNames) === JSON.stringify([BOOTSTRAP_TAG]) &&
      tags[BOOTSTRAP_TAG] === BOOTSTRAP_VERSION) {
    return { state: "verified", versionManifest };
  }
  if (JSON.stringify(tagNames) === JSON.stringify([BOOTSTRAP_TAG, "latest"].sort()) &&
      tags[BOOTSTRAP_TAG] === BOOTSTRAP_VERSION && tags.latest === BOOTSTRAP_VERSION) {
    return { state: "recoverable-unexpected-latest", versionManifest };
  }
  throw new Error(
    `${definition.name} must have only the exact bootstrap dist-tag; only an exact singleton latest alias is recoverable.`,
  );
}

function assertRegistryTarballURL(value, packageName) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${packageName} registry archive URL is invalid.`);
  }
  const registry = new URL(BOOTSTRAP_REGISTRY);
  if (url.protocol !== "https:" || url.origin !== registry.origin || url.username !== "" ||
      url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(`${packageName} registry archive URL is outside the fixed public registry.`);
  }
  return url;
}

async function recoverUnexpectedLatest(package_, options) {
  const preflight = await inspectRegistryState(package_, options.fetchImplementation);
  if (preflight.state === "verified") return preflight;
  if (preflight.state !== "recoverable-unexpected-latest") {
    throw new Error(
      `${package_.definition.name} is not the exact singleton unexpected-latest state.`,
    );
  }
  let removalError;
  try {
    await options.removeUnexpectedLatest(package_.definition);
  } catch (error) {
    removalError = error;
  }
  try {
    return await waitForVerifiedRegistryState(package_, options);
  } catch (verificationError) {
    if (removalError !== undefined) {
      throw new AggregateError(
        [removalError, verificationError],
        `${package_.definition.name} latest removal failed and the exact bootstrap-only state did not appear.`,
        { cause: verificationError },
      );
    }
    throw verificationError;
  }
}

async function waitForCreatedRegistryState(package_, options) {
  return waitForRegistryState(package_, options, new Set([
    "verified",
    "recoverable-unexpected-latest",
  ]));
}

async function waitForVerifiedRegistryState(package_, options) {
  return waitForRegistryState(package_, options, new Set(["verified"]));
}

async function waitForRegistryState(package_, options, acceptedStates) {
  let lastError;
  for (let attempt = 1; attempt <= REGISTRY_VERIFY_ATTEMPTS; attempt += 1) {
    try {
      const state = await inspectRegistryState(package_, options.fetchImplementation);
      if (acceptedStates.has(state.state)) return state;
      lastError = state.state === "recoverable-unexpected-latest" ?
        new Error(`${package_.definition.name} still has the unexpected latest alias.`) :
        new Error(`${package_.definition.name} is not visible in the registry yet.`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < REGISTRY_VERIFY_ATTEMPTS) {
      await options.waitImplementation(REGISTRY_VERIFY_DELAY_MILLISECONDS);
    }
  }
  throw lastError;
}

async function readBoundedResponse(response, maximumBytes, label) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^(0|[1-9]\d*)$/u.test(contentLength) ||
      Number(contentLength) > maximumBytes)) {
    throw new Error(`${label} exceeds its size bound.`);
  }
  if (response.body === null) throw new Error(`${label} has no response body.`);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds its size bound.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

function parseRegistryJSON(bytes, label) {
  let value;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON.`);
  }
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function assertNoTokenEnvironment() {
  for (const name of ["NODE_AUTH_TOKEN", "NPM_TOKEN"]) {
    if (process.env[name] !== undefined) {
      throw new Error(`${name} must not be passed to the namespace bootstrap process.`);
    }
  }
}

function npmVersion(npmCommand) {
  const output = runNpm(npmCommand, ["--version"], ROOT_PATH, "pipe").trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(output)) {
    throw new Error("npm returned a non-canonical version.");
  }
  return output;
}

function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runNpm(command, arguments_, cwd, stdio, environment = {}) {
  const inheritedEnvironment = { ...process.env };
  delete inheritedEnvironment.NODE_AUTH_TOKEN;
  delete inheritedEnvironment.NPM_TOKEN;
  return execFileSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: {
      ...inheritedEnvironment,
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_ACCESS: "public",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      NPM_CONFIG_PROVENANCE: "false",
      NPM_CONFIG_REGISTRY: BOOTSTRAP_REGISTRY,
      NPM_CONFIG_TAG: BOOTSTRAP_TAG,
      ...environment,
    },
    maxBuffer: MAXIMUM_COMMAND_OUTPUT_BYTES,
    stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout: 5 * 60 * 1000,
  }) ?? "";
}

function runGit(arguments_) {
  return execFileSync("git", arguments_, {
    cwd: ROOT_PATH,
    encoding: "utf8",
    maxBuffer: MAXIMUM_COMMAND_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

function runGitBytes(arguments_) {
  return execFileSync("git", arguments_, {
    cwd: ROOT_PATH,
    encoding: "buffer",
    maxBuffer: MAXIMUM_COMMAND_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

function tarOutput(arguments_) {
  return execFileSync("tar", arguments_, {
    encoding: "utf8",
    maxBuffer: MAXIMUM_COMMAND_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

function tarBytes(archive, entry) {
  return execFileSync("tar", ["-xOzf", archive, entry], {
    encoding: "buffer",
    maxBuffer: MAXIMUM_COMMAND_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usage() {
  return `Usage:\n` +
    `  node scripts/npm-namespace-bootstrap.mjs --dry-run --reviewed-commit COMMIT ` +
    `[--output-directory PATH]\n` +
    `  node scripts/npm-namespace-bootstrap.mjs --publish --confirm ${PUBLISH_CONFIRMATION} ` +
    `--reviewed-commit COMMIT [--output-directory PATH]\n`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`npm namespace bootstrap rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
