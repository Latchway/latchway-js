import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  parseStrictJSONBytes,
  readBoundedStrictJSONFileSync,
} from "./npm-release-evidence.mjs";

export const ROOT_PATH = fileURLToPath(new URL("..", import.meta.url));
export const ARTIFACTS_PATH = fileURLToPath(new URL("../.artifacts/", import.meta.url));
export const REGISTRY_URL = "https://registry.npmjs.org/";
export const SCOPE_REGISTRY_ARGUMENT = `--@latchway:registry=${REGISTRY_URL}`;
export const SCOPE_REGISTRY_CONFIG = `@latchway:registry=${REGISTRY_URL}`;

export const RELEASE_PACKAGE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "client",
    name: "@latchway/client",
    directory: ".",
    topLevelFiles: Object.freeze([
      "CHANGELOG.md", "LICENSE", "NOTICE", "README.md", "SECURITY.md", "contract.lock", "package.json",
    ]),
    contentDirectories: Object.freeze({ dist: "dist", docs: "docs" }),
    runtimeExports: Object.freeze([
      ["@latchway/client", "createLatchwayClient"],
      ["@latchway/client/browser", "createBrowserLatchwayClient"],
      ["@latchway/client/node", "createNodeLatchwayClient"],
      ["@latchway/client/firebase", "createFirebaseAppCheckProvider"],
      ["@latchway/client/turnstile", "createTurnstileProvider"],
    ]),
  }),
  Object.freeze({
    id: "openai",
    name: "@latchway/openai",
    directory: "packages/openai",
    topLevelFiles: Object.freeze(["LICENSE", "NOTICE", "README.md", "package.json"]),
    contentDirectories: Object.freeze({ dist: "dist" }),
    runtimeExports: Object.freeze([["@latchway/openai", "createLatchwayOpenAI"]]),
  }),
  Object.freeze({
    id: "vercel-ai",
    name: "@latchway/vercel-ai",
    directory: "packages/vercel-ai",
    topLevelFiles: Object.freeze(["LICENSE", "NOTICE", "README.md", "package.json"]),
    contentDirectories: Object.freeze({ dist: "dist" }),
    runtimeExports: Object.freeze([["@latchway/vercel-ai", "createLatchwayProvider"]]),
  }),
  Object.freeze({
    id: "langchain",
    name: "@latchway/langchain",
    directory: "packages/langchain",
    topLevelFiles: Object.freeze(["LICENSE", "NOTICE", "README.md", "package.json"]),
    contentDirectories: Object.freeze({ dist: "dist" }),
    runtimeExports: Object.freeze([
      ["@latchway/langchain", "createLatchwayChatOpenAI"],
      ["@latchway/langchain", "createLatchwayEmbeddings"],
    ]),
  }),
]);

const RELEASE_PACKAGE_NAMES = new Set(RELEASE_PACKAGE_DEFINITIONS.map(({ name }) => name));
const DIST_EXTENSION = /(?:\.d\.ts(?:\.map)?|\.js(?:\.map)?)$/u;
const UNSAFE_LIFECYCLE_SCRIPTS = new Set([
  "install",
  "postinstall",
  "postpack",
  "postpublish",
  "preinstall",
  "prepack",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "publish",
]);
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.yarnrc(?:\.yml)?$|credentials(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|secrets?(?:\.|$))|\.(?:key|p12|pfx|pem)$/iu;
const SECRET_CONTENT = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9_-]{32,})\b/u,
  /\bsk-[A-Za-z0-9]{20,}\b/u,
  /\/\/registry\.npmjs\.org\/:_authToken\s*=\s*(?!\$\{)[^\s$][^\s]*/u,
];
const MAXIMUM_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
const MAXIMUM_NPM_COMMAND_MILLISECONDS = 5 * 60 * 1000;
const MAXIMUM_RUNTIME_COMMAND_MILLISECONDS = 60 * 1000;
const MAXIMUM_TYPESCRIPT_COMMAND_MILLISECONDS = 2 * 60 * 1000;

export async function readRootManifest() {
  return JSON.parse(await readFile(join(ROOT_PATH, "package.json"), "utf8"));
}

export async function readReleasePackages() {
  const packages = [];
  let releaseVersion;
  for (const definition of RELEASE_PACKAGE_DEFINITIONS) {
    const directory = resolve(ROOT_PATH, definition.directory);
    if (relative(ROOT_PATH, directory).startsWith(`..${sep}`)) {
      throw new Error(`Release package ${definition.id} resolves outside the repository.`);
    }
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (manifest.name !== definition.name || typeof manifest.version !== "string") {
      throw new Error(`Release package ${definition.id} has an invalid name or version.`);
    }
    assertNoUnsafeLifecycleScripts(manifest, definition.name);
    releaseVersion ??= manifest.version;
    if (manifest.version !== releaseVersion) {
      throw new Error("Every JavaScript release package must use one exact version.");
    }
    packages.push(Object.freeze({
      ...definition,
      directory,
      manifest,
      archiveName: archiveNameFor(manifest),
    }));
  }
  if (packages.length !== 4 || new Set(packages.map(({ name }) => name)).size !== 4) {
    throw new Error("The JavaScript release set must contain exactly four packages.");
  }
  return packages;
}

export function archiveNameFor(manifest) {
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error("package.json must contain a package name and version.");
  }
  const packageStem = manifest.name.replace(/^@/u, "").replaceAll("/", "-");
  if (!/^[A-Za-z0-9._-]+$/u.test(packageStem) || !/^[0-9A-Za-z.+-]+$/u.test(manifest.version)) {
    throw new Error("The package name or version cannot form a safe archive name.");
  }
  return `${packageStem}-${manifest.version}.tgz`;
}

export function artifactNameForPackage(packageID, stem) {
  if (!/^(?:client|openai|vercel-ai|langchain)$/u.test(packageID)
      || !/^[a-z][a-z0-9-]*$/u.test(stem)) {
    throw new Error("The package evidence artifact name is unsafe.");
  }
  return `npm-${packageID}-${stem}.json`;
}

export async function digestFile(path, maximumBytes = 10 * 1024 * 1024) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Release digest received an invalid file-size limit.");
  }
  const metadata = await lstat(path);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || !Number.isSafeInteger(metadata.size)
    || metadata.size < 1
    || metadata.size > maximumBytes
  ) {
    throw new Error("Release digest input must be a bounded regular file.");
  }
  const hashes = {
    sha1: createHash("sha1"),
    sha256: createHash("sha256"),
    sha512: createHash("sha512"),
  };
  let size = 0;
  for await (const chunk of createReadStream(path, {
    flags: constants.O_RDONLY | constants.O_NOFOLLOW,
    highWaterMark: 1024 * 1024,
  })) {
    size += chunk.byteLength;
    if (size > maximumBytes) throw new Error("Release digest input changed beyond its file-size limit.");
    for (const hash of Object.values(hashes)) hash.update(chunk);
  }
  if (size !== metadata.size) throw new Error("Release digest input changed while it was read.");
  return {
    bytes: size,
    sha1: hashes.sha1.digest("hex"),
    sha256: hashes.sha256.digest("hex"),
    sha512: hashes.sha512.copy().digest("hex"),
    integrity: `sha512-${hashes.sha512.digest("base64")}`,
  };
}

export async function expectedPackFiles(package_) {
  const files = new Set();
  for (const path of package_.topLevelFiles) {
    const metadata = await lstat(join(package_.directory, path));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`${package_.name} release input must be a regular file: ${path}.`);
    }
    files.add(`package/${path}`);
  }
  for (const [directory, kind] of Object.entries(package_.contentDirectories)) {
    const paths = await regularFiles(join(package_.directory, directory));
    if (paths.length === 0) throw new Error(`${package_.name} ${directory} must contain release files.`);
    for (const path of paths) {
      const normalized = path.split(sep).join("/");
      const accepted = kind === "dist" ? DIST_EXTENSION.test(normalized) : normalized.endsWith(".md");
      if (!accepted) throw new Error(`${package_.name} ${directory}/${normalized} is not an allowed release file.`);
      files.add(`package/${directory}/${normalized}`);
    }
  }
  return [...files].sort();
}

export function expectedPublishedManifest(package_) {
  const expected = JSON.parse(JSON.stringify(package_.manifest));
  for (const dependencyKind of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = expected[dependencyKind];
    if (dependencies === undefined) continue;
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range !== "string" || !range.startsWith("workspace:")) continue;
      if (!RELEASE_PACKAGE_NAMES.has(name)) {
        throw new Error(`${package_.name} has an unsupported workspace dependency on ${name}.`);
      }
      const selector = range.slice("workspace:".length);
      if (selector === "^") dependencies[name] = `^${package_.manifest.version}`;
      else if (selector === "~") dependencies[name] = `~${package_.manifest.version}`;
      else if (selector === "*") dependencies[name] = package_.manifest.version;
      else throw new Error(`${package_.name} has an unsupported workspace selector for ${name}.`);
    }
  }
  return expected;
}

export async function inspectTarball(archivePath, package_) {
  const archiveStats = await stat(archivePath);
  if (!archiveStats.isFile() || archiveStats.size === 0 || archiveStats.size > 10 * 1024 * 1024) {
    throw new Error("The npm archive must be a non-empty regular file no larger than 10 MiB.");
  }

  const entries = commandOutput("tar", ["-tzf", archivePath])
    .split("\n")
    .filter((entry) => entry.length > 0);
  if (entries.length === 0 || entries.length > 512 || new Set(entries).size !== entries.length) {
    throw new Error("The npm archive has an invalid or duplicate entry list.");
  }
  for (const entry of entries) assertSafeArchiveEntry(entry, package_);

  const verboseEntries = commandOutput("tar", ["-tvzf", archivePath])
    .split("\n")
    .filter((entry) => entry.length > 0);
  if (verboseEntries.length !== entries.length || verboseEntries.some((entry) => entry[0] !== "-")) {
    throw new Error("The npm archive may contain only regular files (no links, devices, or directories).");
  }

  const extraction = await mkdtemp(join(tmpdir(), "latchway-package-inspect-"));
  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", extraction], {
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: MAXIMUM_RUNTIME_COMMAND_MILLISECONDS,
    });
    await assertExtractedTreeIsRegular(join(extraction, "package"));
    const packagedManifest = readBoundedStrictJSONFileSync(
      join(extraction, "package", "package.json"),
      `${package_.name} packaged manifest`,
      MAXIMUM_PACKAGE_MANIFEST_BYTES,
    );
    assertPackagedManifest(packagedManifest, expectedPublishedManifest(package_));

    if (package_.id === "client") {
      const sourceLock = await readFile(join(ROOT_PATH, "contract.lock"));
      const packagedLock = await readFile(join(extraction, "package", "contract.lock"));
      if (!sourceLock.equals(packagedLock)) {
        throw new Error("The client archive contract.lock differs from the reviewed source lock.");
      }
    }

    let unpackedBytes = 0;
    for (const entry of entries) {
      if (SECRET_FILE.test(entry)) throw new Error(`The package archive contains a credential-like file: ${entry}.`);
      const bytes = await readFile(join(extraction, ...entry.split("/")));
      unpackedBytes += bytes.byteLength;
      if (unpackedBytes > 25 * 1024 * 1024) throw new Error("The unpacked npm archive exceeds 25 MiB.");
      const source = bytes.toString("utf8");
      if (SECRET_CONTENT.some((pattern) => pattern.test(source))) {
        throw new Error(`The package archive contains credential-like content in ${entry}.`);
      }
    }

    return { entries: [...entries].sort(), manifest: packagedManifest, unpackedBytes };
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}

export async function runReleaseSetConsumerSmoke(packageArchives, { typescript, peerSource }) {
  const packages = await readReleasePackages();
  if (peerSource !== "reviewed" && peerSource !== "registry") {
    throw new Error("The clean consumer peer source must be explicitly reviewed or registry.");
  }
  if (!Array.isArray(packageArchives) || packageArchives.length !== packages.length) {
    throw new Error("The clean consumer requires all four reviewed package archives.");
  }
  const archiveByName = new Map(packageArchives.map(({ name, path }) => [name, resolve(path)]));
  if (archiveByName.size !== packages.length || packages.some(({ name }) => !archiveByName.has(name))) {
    throw new Error("The clean consumer archive set does not match the release package set.");
  }

  const consumer = await mkdtemp(join(tmpdir(), "latchway-package-consumer-"));
  try {
    const npmrc = join(consumer, ".npmrc");
    await writeFile(
      npmrc,
      `registry=${REGISTRY_URL}\n${SCOPE_REGISTRY_CONFIG}\naudit=false\nfund=false\nupdate-notifier=false\n`,
      { mode: 0o600 },
    );
    const dependencies = Object.fromEntries(
      packages.map(({ name }) => [name, `file:${archiveByName.get(name)}`]),
    );
    if (peerSource === "registry") {
      for (const package_ of packages) {
        for (const [name, version] of Object.entries(expectedPublishedManifest(package_).peerDependencies ?? {})) {
          if (!name.startsWith("@latchway/")) dependencies[name] = version;
        }
      }
    }
    await writeFile(join(consumer, "package.json"), `${JSON.stringify({
      name: "latchway-release-consumer",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies,
    }, null, 2)}\n`);
    const installArguments = [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--engine-strict=false",
    ];
    if (peerSource === "reviewed") installArguments.push("--offline", "--legacy-peer-deps");
    else installArguments.push(`--registry=${REGISTRY_URL}`, SCOPE_REGISTRY_ARGUMENT);
    runNpm(installArguments, consumer, npmrc);
    if (peerSource === "reviewed") await linkReviewedPeerDependencies(consumer);

    for (const package_ of packages) {
      const installedManifest = readBoundedStrictJSONFileSync(
        join(consumer, "node_modules", ...package_.name.split("/"), "package.json"),
        `${package_.name} installed manifest`,
        MAXIMUM_PACKAGE_MANIFEST_BYTES,
      );
      if (installedManifest.name !== package_.name || installedManifest.version !== package_.manifest.version) {
        throw new Error(`The clean consumer did not install exact ${package_.name} archive bytes.`);
      }
    }

    const runtimeImports = packages.flatMap(({ runtimeExports }) => runtimeExports);
    await writeFile(join(consumer, "consumer.mjs"), `import assert from "node:assert/strict";\n${runtimeImports.map(
      ([specifier, exported], index) => `import { ${exported} as exported${index} } from ${JSON.stringify(specifier)};`,
    ).join("\n")}\n\nfor (const exported of [${runtimeImports.map((_, index) => `exported${index}`).join(", ")}]) {\n  assert.equal(typeof exported, "function");\n}\n`);
    execFileSync(process.execPath, [join(consumer, "consumer.mjs")], {
      cwd: consumer,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: MAXIMUM_RUNTIME_COMMAND_MILLISECONDS,
    });

    if (typescript) {
      await writeFile(join(consumer, "consumer.ts"), `import { createLatchwayClient, type LatchwayClient, type LatchwayOptions } from "@latchway/client";\nimport { createLatchwayOpenAI } from "@latchway/openai";\nimport { createLatchwayProvider } from "@latchway/vercel-ai";\nimport { createLatchwayChatOpenAI, createLatchwayEmbeddings } from "@latchway/langchain";\n\nconst rootFactory: (options: LatchwayOptions) => LatchwayClient = createLatchwayClient;\nvoid [rootFactory, createLatchwayOpenAI, createLatchwayProvider, createLatchwayChatOpenAI, createLatchwayEmbeddings];\n`);
      await writeFile(join(consumer, "tsconfig.json"), `${JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          lib: ["ES2023", "DOM", "DOM.Iterable"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["consumer.ts"],
      }, null, 2)}\n`);
      execFileSync(process.execPath, [
        join(ROOT_PATH, "node_modules", "typescript", "bin", "tsc"),
        "--project",
        join(consumer, "tsconfig.json"),
      ], {
        cwd: consumer,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: MAXIMUM_TYPESCRIPT_COMMAND_MILLISECONDS,
      });
    }

    return {
      package_count: packages.length,
      packages: packages.map(({ name, manifest }) => ({ name, version: manifest.version })),
      node_esm: true,
      typescript,
      peer_source: peerSource,
    };
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

export async function fetchBytes(url, { maximumBytes, accept = "application/json" } = {}) {
  const parsed = new URL(url);
  if (parsed.origin !== REGISTRY_URL.slice(0, -1) || parsed.username !== "" || parsed.password !== "") {
    throw new Error("Release verification may fetch only from the canonical HTTPS npm registry.");
  }
  const response = await fetch(parsed, {
    headers: { accept },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const limit = maximumBytes ?? 5 * 1024 * 1024;
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > limit) {
    throw new Error("The npm registry response exceeds the release-verification limit.");
  }
  if (response.body === null) throw new Error("The npm registry returned no response body.");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error("The npm registry response exceeds the release-verification limit.");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, size);
  return { response, bytes };
}

export async function fetchJSON(url, options) {
  const { response, bytes } = await fetchBytes(url, options);
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    throw new Error("The npm registry returned a non-JSON content type.");
  }
  let value;
  try {
    value = parseStrictJSONBytes(
      bytes,
      "The npm registry response",
      options?.maximumBytes ?? 5 * 1024 * 1024,
    );
  } catch {
    throw new Error("The npm registry returned invalid JSON.");
  }
  return { response, value };
}

export function packageVersionURL(name, version) {
  return `${REGISTRY_URL}${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

export function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function assertSafeArchiveEntry(entry, package_) {
  if (entry.length > 512 || !entry.startsWith("package/") || entry.includes("\\") || entry.includes("\0")) {
    throw new Error(`Unsafe npm archive entry: ${entry}.`);
  }
  const segments = entry.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Unsafe npm archive path: ${entry}.`);
  }
  const topLevel = new Set(package_.topLevelFiles.map((path) => `package/${path}`));
  const relativeEntry = entry.slice("package/".length);
  const directory = relativeEntry.split("/", 1)[0];
  const kind = package_.contentDirectories[directory];
  const allowed = topLevel.has(entry)
    || (kind === "dist" && entry.startsWith(`package/${directory}/`) && DIST_EXTENSION.test(entry))
    || (kind === "docs" && entry.startsWith(`package/${directory}/`) && entry.endsWith(".md"));
  if (!allowed) {
    throw new Error(`The ${package_.name} archive entry is outside the publication allowlist: ${entry}.`);
  }
}

function assertPackagedManifest(actual, expected) {
  for (const field of ["name", "version", "type", "main", "types", "license", "description", "sideEffects"]) {
    if (!isDeepStrictEqual(actual[field], expected[field])) {
      throw new Error(`The packaged manifest has an unexpected ${field}.`);
    }
  }
  for (const field of [
    "exports", "files", "engines", "repository", "publishConfig",
    "dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta",
  ]) {
    if (!isDeepStrictEqual(actual[field], expected[field])) {
      throw new Error(`The packaged manifest has an unexpected ${field}.`);
    }
  }
  if (actual.private === true || actual.publishConfig?.access !== "public") {
    throw new Error("The packaged manifest is not an explicitly public package.");
  }
  assertNoUnsafeLifecycleScripts(actual, "The package archive");
}

function assertNoUnsafeLifecycleScripts(manifest, label) {
  for (const name of UNSAFE_LIFECYCLE_SCRIPTS) {
    if (Object.hasOwn(manifest.scripts ?? {}, name)) {
      throw new Error(`${label} may not contain the ${name} lifecycle script.`);
    }
  }
}

async function regularFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = relative(directory, path);
    if (entry.isSymbolicLink()) throw new Error(`Release input may not be a symbolic link: ${path}.`);
    if (entry.isDirectory()) {
      for (const nested of await regularFiles(path)) result.push(join(relativePath, nested));
    } else if (entry.isFile()) {
      result.push(relativePath);
    } else {
      throw new Error(`Release input must be a regular file: ${path}.`);
    }
  }
  return result.sort();
}

async function assertExtractedTreeIsRegular(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error("The extracted npm archive contains a symbolic link.");
    if (stats.isDirectory()) await assertExtractedTreeIsRegular(path);
    else if (!stats.isFile()) throw new Error("The extracted npm archive contains a non-regular file.");
  }
}

async function linkReviewedPeerDependencies(consumer) {
  for (const name of ["openai", "ai", "@ai-sdk/openai", "@langchain/openai"]) {
    const source = await realpath(join(ROOT_PATH, "node_modules", ...name.split("/")));
    const destination = join(consumer, "node_modules", ...name.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
  }
}

function commandOutput(command, arguments_) {
  try {
    return execFileSync(command, arguments_, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: MAXIMUM_RUNTIME_COMMAND_MILLISECONDS,
    });
  } catch {
    throw new Error(`Release archive inspection failed while running ${basename(command)}.`);
  }
}

function runNpm(arguments_, cwd, userconfig) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => {
    const normalized = name.toLowerCase();
    return normalized !== "node_auth_token"
      && normalized !== "npm_token"
      && normalized !== "npm_config_registry"
      && normalized !== "npm_config_@latchway:registry"
      && !(normalized.startsWith("npm_config_") && normalized.includes("auth"));
  }));
  environment.NPM_CONFIG_USERCONFIG = userconfig;
  environment.NPM_CONFIG_GLOBALCONFIG = `${userconfig}.global`;
  environment.NPM_CONFIG_CACHE = join(cwd, ".npm-cache");
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    execFileSync(command, arguments_, {
      cwd,
      env: environment,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: MAXIMUM_NPM_COMMAND_MILLISECONDS,
    });
  } catch {
    throw new Error("The clean npm package-set consumer failed.");
  }
}
