import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const ROOT_PATH = fileURLToPath(new URL("..", import.meta.url));
export const ARTIFACTS_PATH = fileURLToPath(new URL("../.artifacts/", import.meta.url));
export const REGISTRY_URL = "https://registry.npmjs.org/";

const TOP_LEVEL_FILES = new Set([
  "package/CHANGELOG.md",
  "package/LICENSE",
  "package/NOTICE",
  "package/README.md",
  "package/SECURITY.md",
  "package/contract.lock",
  "package/package.json",
]);
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

export async function readRootManifest() {
  return JSON.parse(await readFile(join(ROOT_PATH, "package.json"), "utf8"));
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

export async function digestFile(path) {
  const bytes = await readFile(path);
  return {
    bytes: bytes.byteLength,
    sha1: createHash("sha1").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

export async function expectedPackFiles() {
  const files = new Set(TOP_LEVEL_FILES);
  for (const [directory, accept] of [
    ["dist", (path) => DIST_EXTENSION.test(path)],
    ["docs", (path) => path.endsWith(".md")],
  ]) {
    const paths = await regularFiles(join(ROOT_PATH, directory));
    if (paths.length === 0) throw new Error(`${directory} must contain release files.`);
    for (const path of paths) {
      const normalized = path.split(sep).join("/");
      if (!accept(normalized)) throw new Error(`${directory}/${normalized} is not an allowed release file.`);
      files.add(`package/${directory}/${normalized}`);
    }
  }
  return [...files].sort();
}

export async function inspectTarball(archivePath, expectedManifest) {
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
  for (const entry of entries) assertSafeArchiveEntry(entry);

  const verboseEntries = commandOutput("tar", ["-tvzf", archivePath])
    .split("\n")
    .filter((entry) => entry.length > 0);
  if (verboseEntries.length !== entries.length || verboseEntries.some((entry) => entry[0] !== "-")) {
    throw new Error("The npm archive may contain only regular files (no links, devices, or directories).");
  }

  const extraction = await mkdtemp(join(tmpdir(), "latchway-package-inspect-"));
  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", extraction], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await assertExtractedTreeIsRegular(join(extraction, "package"));
    const packagedManifest = JSON.parse(await readFile(join(extraction, "package", "package.json"), "utf8"));
    assertPackagedManifest(packagedManifest, expectedManifest);

    const sourceLock = await readFile(join(ROOT_PATH, "contract.lock"));
    const packagedLock = await readFile(join(extraction, "package", "contract.lock"));
    if (!sourceLock.equals(packagedLock)) throw new Error("The archive contract.lock differs from the reviewed source lock.");

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

export async function runConsumerSmoke(archivePath, { typescript }) {
  const manifest = await readRootManifest();
  const consumer = await mkdtemp(join(tmpdir(), "latchway-package-consumer-"));
  try {
    const npmrc = join(consumer, ".npmrc");
    await writeFile(npmrc, "audit=false\nfund=false\nupdate-notifier=false\n", { mode: 0o600 });
    await writeFile(join(consumer, "package.json"), `${JSON.stringify({
      name: "latchway-release-consumer",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: { [manifest.name]: `file:${resolve(archivePath)}` },
    }, null, 2)}\n`);
    runNpm([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      "--package-lock=false",
      "--engine-strict=false",
    ], consumer, npmrc);

    const installedManifest = JSON.parse(await readFile(
      join(consumer, "node_modules", "@latchway", "client", "package.json"),
      "utf8",
    ));
    if (installedManifest.name !== manifest.name || installedManifest.version !== manifest.version) {
      throw new Error("The clean consumer did not install the exact package archive version.");
    }

    await writeFile(join(consumer, "consumer.mjs"), `import assert from "node:assert/strict";
import { createLatchwayClient } from "@latchway/client";
import { createBrowserLatchwayClient } from "@latchway/client/browser";
import { createNodeLatchwayClient } from "@latchway/client/node";
import { createFirebaseAppCheckProvider } from "@latchway/client/firebase";
import { createTurnstileProvider } from "@latchway/client/turnstile";

for (const exported of [
  createLatchwayClient,
  createBrowserLatchwayClient,
  createNodeLatchwayClient,
  createFirebaseAppCheckProvider,
  createTurnstileProvider,
]) assert.equal(typeof exported, "function");
`);
    execFileSync(process.execPath, [join(consumer, "consumer.mjs")], {
      cwd: consumer,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (typescript) {
      await writeFile(join(consumer, "consumer.ts"), `import { createLatchwayClient, type LatchwayClient, type LatchwayOptions } from "@latchway/client";
import { createBrowserLatchwayClient } from "@latchway/client/browser";
import { createNodeLatchwayClient, type NodeLatchwayOptions } from "@latchway/client/node";
import { createFirebaseAppCheckProvider } from "@latchway/client/firebase";
import { createTurnstileProvider, type TurnstileProviderOptions } from "@latchway/client/turnstile";

const rootFactory: (options: LatchwayOptions) => LatchwayClient = createLatchwayClient;
const browserFactory: (options: LatchwayOptions) => LatchwayClient = createBrowserLatchwayClient;
const nodeFactory: (options: NodeLatchwayOptions) => LatchwayClient = createNodeLatchwayClient;
const turnstileOptions: TurnstileProviderOptions | undefined = undefined;
void [rootFactory, browserFactory, nodeFactory, createFirebaseAppCheckProvider, createTurnstileProvider, turnstileOptions];
`);
      await writeFile(join(consumer, "tsconfig.json"), `${JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          lib: ["ES2023", "DOM", "DOM.Iterable"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          skipLibCheck: false,
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
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

    return { node_esm: true, typescript };
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
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > limit) throw new Error("The npm registry response exceeds the release-verification limit.");
  return { response, bytes };
}

export async function fetchJSON(url, options) {
  const { response, bytes } = await fetchBytes(url, options);
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    throw new Error("The npm registry returned a non-JSON content type.");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
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

function assertSafeArchiveEntry(entry) {
  if (entry.length > 512 || !entry.startsWith("package/") || entry.includes("\\") || entry.includes("\0")) {
    throw new Error(`Unsafe npm archive entry: ${entry}.`);
  }
  const segments = entry.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Unsafe npm archive path: ${entry}.`);
  }
  if (!TOP_LEVEL_FILES.has(entry) &&
      !(entry.startsWith("package/dist/") && DIST_EXTENSION.test(entry)) &&
      !(entry.startsWith("package/docs/") && entry.endsWith(".md"))) {
    throw new Error(`The npm archive entry is outside the publication allowlist: ${entry}.`);
  }
}

function assertPackagedManifest(actual, expected) {
  for (const field of ["name", "version", "type", "main", "types", "license"]) {
    if (actual[field] !== expected[field]) throw new Error(`The packaged manifest has an unexpected ${field}.`);
  }
  for (const field of ["exports", "files", "engines", "repository", "publishConfig"]) {
    if (!isDeepStrictEqual(actual[field], expected[field])) {
      throw new Error(`The packaged manifest has an unexpected ${field}.`);
    }
  }
  if (actual.private === true || actual.publishConfig?.access !== "public") {
    throw new Error("The packaged manifest is not an explicitly public package.");
  }
  for (const name of UNSAFE_LIFECYCLE_SCRIPTS) {
    if (Object.hasOwn(actual.scripts ?? {}, name)) {
      throw new Error(`The package archive may not contain the ${name} lifecycle script.`);
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

function commandOutput(command, arguments_) {
  try {
    return execFileSync(command, arguments_, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`Release archive inspection failed while running ${basename(command)}.`);
  }
}

function runNpm(arguments_, cwd, userconfig) {
  const environment = { ...process.env };
  delete environment.NODE_AUTH_TOKEN;
  delete environment.NPM_TOKEN;
  delete environment.npm_config__auth;
  delete environment.npm_config_auth;
  environment.NPM_CONFIG_USERCONFIG = userconfig;
  environment.NPM_CONFIG_CACHE = join(cwd, ".npm-cache");
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    execFileSync(command, arguments_, {
      cwd,
      env: environment,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("The clean npm package consumer failed.");
  }
}
