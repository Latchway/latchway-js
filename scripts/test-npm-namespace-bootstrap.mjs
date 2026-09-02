import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BOOTSTRAP_PACKAGES,
  BOOTSTRAP_NPM_VERSION,
  BOOTSTRAP_REGISTRY,
  BOOTSTRAP_SCOPE_REGISTRY_ARGUMENT,
  BOOTSTRAP_TAG,
  BOOTSTRAP_VERSION,
  PUBLISH_CONFIRMATION,
  bootstrapManifest,
  buildBootstrapArchives,
  parseArguments,
  publishArguments,
  reconcileBootstrapRegistry,
  removeUnexpectedLatestArguments,
  sourceMaterialIdentity,
  validateReviewedCheckoutState,
} from "./npm-namespace-bootstrap.mjs";

const ROOT_PATH = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL("npm-namespace-bootstrap.mjs", import.meta.url));
const REVIEWED_COMMIT = "a".repeat(40);
const TEST_TOOL_DIRECTORY = await mkdtemp(join(tmpdir(), "latchway-npm-bootstrap-tool-"));
const TEST_NPM_COMMAND = join(TEST_TOOL_DIRECTORY, "npm-fixture");
await writeFile(TEST_NPM_COMMAND, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write("${BOOTSTRAP_NPM_VERSION}\\n");
  process.exit(0);
}
const result = spawnSync("npm", process.argv.slice(2), { shell: false, stdio: "inherit" });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
await chmod(TEST_NPM_COMMAND, 0o700);
after(async () => rm(TEST_TOOL_DIRECTORY, { force: true, recursive: true }));
let testSourceIdentityPromise;

function testSourceIdentity() {
  testSourceIdentityPromise ??= sourceMaterialIdentity(REVIEWED_COMMIT, TEST_NPM_COMMAND);
  return testSourceIdentityPromise;
}

test("bootstrap inventory and publish command fix all five inert identities", () => {
  assert.equal(BOOTSTRAP_VERSION, "0.0.0-bootstrap.0");
  assert.equal(BOOTSTRAP_TAG, "bootstrap");
  assert.deepEqual(BOOTSTRAP_PACKAGES.map(({ name, repository }) => ({ name, repository })), [
    {
      name: "@latchway/client",
      repository: { type: "git", url: "git+https://github.com/Latchway/latchway-js.git" },
    },
    {
      name: "@latchway/openai",
      repository: {
        type: "git",
        url: "git+https://github.com/Latchway/latchway-js.git",
        directory: "packages/openai",
      },
    },
    {
      name: "@latchway/vercel-ai",
      repository: {
        type: "git",
        url: "git+https://github.com/Latchway/latchway-js.git",
        directory: "packages/vercel-ai",
      },
    },
    {
      name: "@latchway/langchain",
      repository: {
        type: "git",
        url: "git+https://github.com/Latchway/latchway-js.git",
        directory: "packages/langchain",
      },
    },
    {
      name: "@latchway/react-native",
      repository: {
        type: "git",
        url: "git+https://github.com/Latchway/latchway-react-native-sdk.git",
      },
    },
  ]);
  for (const definition of BOOTSTRAP_PACKAGES) {
    const manifest = bootstrapManifest(definition);
    assert.deepEqual(Object.keys(manifest), [
      "name",
      "version",
      "description",
      "license",
      "files",
      "repository",
      "publishConfig",
    ]);
    assert.equal(manifest.license, "Apache-2.0");
    assert.deepEqual(manifest.files, ["LICENSE", "README.md"]);
    assert.deepEqual(manifest.publishConfig, {
      access: "public",
      registry: BOOTSTRAP_REGISTRY,
      tag: "bootstrap",
    });
    for (const field of [
      "bin",
      "dependencies",
      "devDependencies",
      "exports",
      "main",
      "optionalDependencies",
      "peerDependencies",
      "scripts",
      "types",
    ]) {
      assert.equal(Object.hasOwn(manifest, field), false);
    }
  }
  assert.deepEqual(publishArguments("archive.tgz"), [
    "publish",
    "archive.tgz",
    "--access=public",
    "--tag=bootstrap",
    `--registry=${BOOTSTRAP_REGISTRY}`,
    BOOTSTRAP_SCOPE_REGISTRY_ARGUMENT,
    "--ignore-scripts",
  ]);
  assert.equal(
    BOOTSTRAP_SCOPE_REGISTRY_ARGUMENT,
    `--@latchway:registry=${BOOTSTRAP_REGISTRY}`,
  );
  assert.equal(publishArguments("archive.tgz").some((argument) => argument.includes("latest")), false);
  assert.deepEqual(removeUnexpectedLatestArguments("@latchway/client"), [
    "dist-tag",
    "rm",
    "@latchway/client",
    "latest",
    `--registry=${BOOTSTRAP_REGISTRY}`,
    BOOTSTRAP_SCOPE_REGISTRY_ARGUMENT,
    "--ignore-scripts",
  ]);
  assert.throws(
    () => removeUnexpectedLatestArguments("@attacker/client"),
    /fixed bootstrap package set/u,
  );
});

test("the scoped npmjs CLI pin overrides hostile environment and user config", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "latchway-npm-bootstrap-hostile-config-"));
  const userConfig = join(root, "npmrc");
  await writeFile(userConfig, "@latchway:registry=https://example.invalid/\n", { mode: 0o600 });
  context.after(async () => rm(root, { force: true, recursive: true }));
  const environment = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: userConfig,
    "npm_config_@latchway:registry": "https://another.invalid/",
  };
  const result = spawnSync(
    "npm",
    [
      "config",
      "get",
      "@latchway:registry",
      `--registry=${BOOTSTRAP_REGISTRY}`,
      BOOTSTRAP_SCOPE_REGISTRY_ARGUMENT,
    ],
    { cwd: ROOT_PATH, encoding: "utf8", env: environment, shell: false },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), BOOTSTRAP_REGISTRY);
});

test("CLI requires an explicit mode and exact publication confirmation", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "latchway-npm-bootstrap-arguments-"));
  context.after(async () => rm(output, { force: true, recursive: true }));
  assert.equal(parseArguments([
    "--dry-run",
    "--reviewed-commit",
    REVIEWED_COMMIT,
    "--output-directory",
    output,
  ]).mode, "dry-run");
  assert.equal(parseArguments([
    "--publish",
    "--confirm",
    PUBLISH_CONFIRMATION,
    "--reviewed-commit",
    REVIEWED_COMMIT,
    "--output-directory",
    output,
  ]).mode, "publish");
  assert.throws(() => parseArguments([]), /exactly one/u);
  assert.throws(() => parseArguments(["--dry-run", "--publish"]), /exactly one/u);
  assert.throws(() => parseArguments(["--publish"]), /requires --confirm/u);
  assert.throws(() => parseArguments(["--publish", "--confirm", "yes"]), /requires --confirm/u);
  assert.throws(() => parseArguments(["--dry-run", "--tag=latest"]), /Unknown/u);
  assert.throws(() => parseArguments(["--dry-run"]), /--reviewed-commit is required/u);
  assert.throws(
    () => parseArguments(["--dry-run", "--reviewed-commit", "A".repeat(40)]),
    /exact lowercase/u,
  );
  assert.throws(
    () => parseArguments([
      "--dry-run",
      "--reviewed-commit",
      REVIEWED_COMMIT,
      "--output-directory",
      join(ROOT_PATH, "unsafe-output"),
    ]),
    /\.artifacts/u,
  );

  const rejected = spawnSync(process.execPath, [SCRIPT_PATH, "--publish"], {
    cwd: ROOT_PATH,
    encoding: "utf8",
    shell: false,
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Publication requires --confirm/u);
});

test("reviewed checkout requires exact HEAD, clean tracked inputs, and pinned npm", () => {
  const valid = {
    head: `${REVIEWED_COMMIT}\n`,
    npmVersion: BOOTSTRAP_NPM_VERSION,
    reviewedCommit: REVIEWED_COMMIT,
    trackedInputs: "LICENSE\nscripts/npm-namespace-bootstrap.mjs\n",
    trackedStatus: "",
  };
  assert.doesNotThrow(() => validateReviewedCheckoutState(valid));
  assert.throws(
    () => validateReviewedCheckoutState({ ...valid, head: `${"b".repeat(40)}\n` }),
    /exact reviewed commit/u,
  );
  assert.throws(
    () => validateReviewedCheckoutState({ ...valid, trackedStatus: " M LICENSE\n" }),
    /clean tracked checkout/u,
  );
  assert.throws(
    () => validateReviewedCheckoutState({ ...valid, trackedInputs: "LICENSE\n" }),
    /tracked inputs/u,
  );
  assert.throws(
    () => validateReviewedCheckoutState({ ...valid, npmVersion: "11.16.0" }),
    /exact reviewed npm 11\.17\.0/u,
  );
});

test("dry-run builds deterministic bounded archives and a reviewable inspection", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "latchway-npm-bootstrap-dry-run-"));
  context.after(async () => rm(output, { force: true, recursive: true }));
  const sourceIdentity = await testSourceIdentity();
  const first = await buildBootstrapArchives(output, TEST_NPM_COMMAND, sourceIdentity);
  const second = await buildBootstrapArchives(output, TEST_NPM_COMMAND, sourceIdentity);
  assert.deepEqual(second, first);
  assert.deepEqual({
    version: first.version,
    distTag: first.dist_tag,
    packageCount: first.package_count,
    publicationPerformed: first.publication_performed,
    source: first.source,
    toolchain: first.toolchain,
  }, {
    version: "0.0.0-bootstrap.0",
    distTag: "bootstrap",
    packageCount: 5,
    publicationPerformed: false,
    source: sourceIdentity.source,
    toolchain: { npm: BOOTSTRAP_NPM_VERSION },
  });
  assert.deepEqual((await readdir(output)).sort(), [
    "inspection.json",
    "latchway-client-0.0.0-bootstrap.0.tgz",
    "latchway-langchain-0.0.0-bootstrap.0.tgz",
    "latchway-openai-0.0.0-bootstrap.0.tgz",
    "latchway-react-native-0.0.0-bootstrap.0.tgz",
    "latchway-vercel-ai-0.0.0-bootstrap.0.tgz",
  ]);
  for (const package_ of first.packages) {
    assert.deepEqual(package_.entries, [
      "package/LICENSE",
      "package/README.md",
      "package/package.json",
    ]);
    assert.match(package_.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(package_.bytes > 0 && package_.bytes <= 64 * 1024, true);
    assert.equal(package_.publish_command.includes("--tag=bootstrap"), true);
    assert.equal(package_.publish_command.some((argument) => argument.includes("latest")), false);
  }
  assert.deepEqual(
    JSON.parse(await readFile(join(output, "inspection.json"), "utf8")),
    first,
  );
});

test("temp output accepts canonical macOS paths but rejects a symlink final leaf", async (context) => {
  const canonicalTempRoot = await realpath("/tmp");
  const canonicalOutput = await mkdtemp(join(canonicalTempRoot, "latchway-npm-bootstrap-canonical-"));
  const symlinkParent = await mkdtemp(join(tmpdir(), "latchway-npm-bootstrap-symlink-"));
  const symlinkOutput = join(symlinkParent, "output-link");
  await symlink(canonicalOutput, symlinkOutput, "dir");
  context.after(async () => {
    await rm(symlinkParent, { force: true, recursive: true });
    await rm(canonicalOutput, { force: true, recursive: true });
  });
  assert.equal(
    parseArguments([
      "--dry-run",
      "--reviewed-commit",
      REVIEWED_COMMIT,
      "--output-directory",
      canonicalOutput,
    ]).outputDirectory,
    canonicalOutput,
  );
  await assert.rejects(
    async () => buildBootstrapArchives(symlinkOutput, TEST_NPM_COMMAND, await testSourceIdentity()),
    /non-symlink directory/u,
  );
});

test("registry reconciliation adopts exact entries, creates only missing names, and is resumable", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "latchway-npm-bootstrap-reconcile-"));
  context.after(async () => rm(output, { force: true, recursive: true }));
  const sourceIdentity = await testSourceIdentity();
  const inspection = await buildBootstrapArchives(output, TEST_NPM_COMMAND, sourceIdentity);
  const initiallyPresent = new Set(BOOTSTRAP_PACKAGES.slice(0, 3).map(({ name }) => name));
  const registry = await registryFixture(output, inspection, initiallyPresent);
  const published = [];
  const completed = await reconcileBootstrapRegistry(output, {
    fetchImplementation: registry.fetch,
    publish: async (definition, archive) => {
      published.push(definition.name);
      assert.equal(basename(archive).startsWith("latchway-"), true);
      registry.present.add(definition.name);
    },
    removeUnexpectedLatest: async () => assert.fail("latest must not be removed from an exact record"),
    sourceIdentity,
    waitImplementation: async () => {},
  });
  assert.deepEqual(published, ["@latchway/langchain", "@latchway/react-native"]);
  assert.equal(completed.kind, "latchway_npm_namespace_bootstrap_completed");
  assert.equal(completed.package_count, 5);
  assert.deepEqual(completed.source, sourceIdentity.source);
  assert.deepEqual(completed.toolchain, { npm: BOOTSTRAP_NPM_VERSION });
  assert.deepEqual(completed.packages.map(({ name }) => name), BOOTSTRAP_PACKAGES.map(({ name }) => name));
  assert.deepEqual(JSON.parse(await readFile(join(output, "completed.json"), "utf8")), completed);

  const rerun = await reconcileBootstrapRegistry(output, {
    fetchImplementation: registry.fetch,
    publish: async () => assert.fail("an exact existing bootstrap package must be adopted"),
    removeUnexpectedLatest: async () => assert.fail("latest must not be removed from an exact record"),
    sourceIdentity,
    waitImplementation: async () => {},
  });
  assert.deepEqual(rerun, completed);
});

test("registry reconciliation accepts a publish collision only when exact bytes appear", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "latchway-npm-bootstrap-collision-"));
  context.after(async () => rm(output, { force: true, recursive: true }));
  const sourceIdentity = await testSourceIdentity();
  const inspection = await buildBootstrapArchives(output, TEST_NPM_COMMAND, sourceIdentity);
  const initiallyPresent = new Set(BOOTSTRAP_PACKAGES.slice(0, 4).map(({ name }) => name));
  const registry = await registryFixture(output, inspection, initiallyPresent);
  const completed = await reconcileBootstrapRegistry(output, {
    fetchImplementation: registry.fetch,
    publish: async (definition) => {
      registry.present.add(definition.name);
      throw new Error("simulated publish response loss");
    },
    removeUnexpectedLatest: async () => assert.fail("latest must not be removed from an exact record"),
    sourceIdentity,
    waitImplementation: async () => {},
  });
  assert.equal(completed.package_count, 5);
});

test("registry reconciliation removes only the exact npm first-publish latest alias", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "latchway-npm-bootstrap-latest-recovery-"));
  context.after(async () => rm(output, { force: true, recursive: true }));
  const sourceIdentity = await testSourceIdentity();
  const inspection = await buildBootstrapArchives(output, TEST_NPM_COMMAND, sourceIdentity);
  const initiallyPresent = new Set(BOOTSTRAP_PACKAGES.slice(1).map(({ name }) => name));
  const latestNames = new Set();
  const registry = await registryFixture(output, inspection, initiallyPresent, {
    mutatePackument: (definition, packument) => {
      if (definition.name === "@latchway/client") {
        delete packument.versions[BOOTSTRAP_VERSION].files;
      }
      if (latestNames.has(definition.name)) {
        packument["dist-tags"].latest = BOOTSTRAP_VERSION;
      }
    },
  });
  const published = [];
  const removed = [];
  const completed = await reconcileBootstrapRegistry(output, {
    fetchImplementation: registry.fetch,
    publish: async (definition) => {
      published.push(definition.name);
      registry.present.add(definition.name);
      latestNames.add(definition.name);
    },
    removeUnexpectedLatest: async (definition) => {
      removed.push(definition.name);
      latestNames.delete(definition.name);
    },
    sourceIdentity,
    waitImplementation: async () => {},
  });
  assert.deepEqual(published, ["@latchway/client"]);
  assert.deepEqual(removed, ["@latchway/client"]);
  assert.equal(completed.package_count, 5);
  assert.deepEqual([...latestNames], []);

  latestNames.add("@latchway/client");
  const resumed = await reconcileBootstrapRegistry(output, {
    fetchImplementation: registry.fetch,
    publish: async () => assert.fail("a byte-identical existing record must not be republished"),
    removeUnexpectedLatest: async (definition) => {
      removed.push(definition.name);
      latestNames.delete(definition.name);
      throw new Error("simulated dist-tag response loss");
    },
    sourceIdentity,
    waitImplementation: async () => {},
  });
  assert.deepEqual(resumed, completed);
  assert.deepEqual(removed, ["@latchway/client", "@latchway/client"]);
});

test("registry reconciliation rejects foreign tags, versions, identity, and archives before mutation", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "latchway-npm-bootstrap-rejection-"));
  context.after(async () => rm(output, { force: true, recursive: true }));
  const sourceIdentity = await testSourceIdentity();
  const inspection = await buildBootstrapArchives(output, TEST_NPM_COMMAND, sourceIdentity);
  const allNames = new Set(BOOTSTRAP_PACKAGES.map(({ name }) => name));
  let publishCalls = 0;
  let removalCalls = 0;
  const publish = async () => { publishCalls += 1; };
  const removeUnexpectedLatest = async () => { removalCalls += 1; };
  const waitImplementation = async () => {};

  const foreignTag = await registryFixture(output, inspection, allNames, {
    mutatePackument: (_definition, packument) => {
      packument["dist-tags"].latest = BOOTSTRAP_VERSION;
      packument["dist-tags"].next = BOOTSTRAP_VERSION;
    },
  });
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    fetchImplementation: foreignTag.fetch,
    publish,
    removeUnexpectedLatest,
    sourceIdentity,
    waitImplementation,
  }), /only an exact singleton latest alias is recoverable/u);

  const wrongLatestTarget = await registryFixture(output, inspection, allNames, {
    mutatePackument: (_definition, packument) => {
      packument["dist-tags"].latest = "1.0.0";
    },
  });
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    fetchImplementation: wrongLatestTarget.fetch,
    publish,
    removeUnexpectedLatest,
    sourceIdentity,
    waitImplementation,
  }), /only an exact singleton latest alias is recoverable/u);

  let clientMetadataReads = 0;
  const changedBeforeRemoval = await registryFixture(output, inspection, allNames, {
    mutatePackument: (definition, packument) => {
      if (definition.name !== "@latchway/client") return;
      clientMetadataReads += 1;
      packument["dist-tags"].latest = BOOTSTRAP_VERSION;
      if (clientMetadataReads > 1) packument["dist-tags"].next = BOOTSTRAP_VERSION;
    },
  });
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    fetchImplementation: changedBeforeRemoval.fetch,
    publish,
    removeUnexpectedLatest,
    sourceIdentity,
    waitImplementation,
  }), /only an exact singleton latest alias is recoverable/u);
  assert.equal(clientMetadataReads, 2);

  const foreignVersion = await registryFixture(output, inspection, allNames, {
    mutatePackument: (_definition, packument) => {
      packument["dist-tags"].latest = BOOTSTRAP_VERSION;
      packument.versions["1.0.0"] = globalThis.structuredClone(
        packument.versions[BOOTSTRAP_VERSION],
      );
      packument.versions["1.0.0"].version = "1.0.0";
    },
  });
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    fetchImplementation: foreignVersion.fetch,
    publish,
    removeUnexpectedLatest,
    sourceIdentity,
    waitImplementation,
  }), /one-version bootstrap closure/u);

  const identity = await registryFixture(output, inspection, allNames, {
    mutatePackument: (definition, packument) => {
      if (definition.name === "@latchway/client") {
        packument.versions[BOOTSTRAP_VERSION].repository.url = "git+https://github.com/attacker/repo.git";
      }
    },
  });
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    fetchImplementation: identity.fetch,
    publish,
    removeUnexpectedLatest,
    sourceIdentity,
    waitImplementation,
  }), /repository differs/u);

  const wrongFiles = await registryFixture(output, inspection, allNames, {
    mutatePackument: (_definition, packument) => {
      packument.versions[BOOTSTRAP_VERSION].files = ["LICENSE", "README.md", "index.js"];
    },
  });
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    fetchImplementation: wrongFiles.fetch,
    publish,
    removeUnexpectedLatest,
    sourceIdentity,
    waitImplementation,
  }), /manifest field files differs/u);

  const archive = await registryFixture(output, inspection, allNames, {
    mutatePackument: (_definition, packument) => {
      delete packument.versions[BOOTSTRAP_VERSION].files;
    },
    mutateArchive: (definition, bytes) => definition.name === "@latchway/client" ?
      Buffer.concat([bytes, Buffer.from("changed")]) : bytes,
  });
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    fetchImplementation: archive.fetch,
    publish,
    removeUnexpectedLatest,
    sourceIdentity,
    waitImplementation,
  }), /not byte-identical/u);
  assert.equal(publishCalls, 0);
  assert.equal(removalCalls, 0);
});

test("documentation pins selected npm trust coordinates while release workflows exclude bootstrap publication", async () => {
  const documentation = await readFile(join(ROOT_PATH, "docs", "releasing.md"), "utf8");
  for (const [name, repository] of [
    ["@latchway/client", "Latchway/latchway-js"],
    ["@latchway/openai", "Latchway/latchway-js"],
    ["@latchway/vercel-ai", "Latchway/latchway-js"],
    ["@latchway/langchain", "Latchway/latchway-js"],
    ["@latchway/react-native", "Latchway/latchway-react-native-sdk"],
  ]) {
    assert.match(documentation, new RegExp(
      `npm trust github ${name.replace("/", "\\/")} --repository ${repository.replace("/", "\\/")} ` +
      "--file single-maintainer-release\\.yml --environment single-maintainer-v1 --allow-publish --yes " +
      '--registry="\\$npm_registry" "\\$npm_scope_registry"',
      "u",
    ));
  }
  assert.match(
    documentation,
    /npm view @latchway\/client[^\n]+--registry="\$npm_registry" "\$npm_scope_registry"/u,
  );
  assert.match(
    documentation,
    /npm trust list @latchway\/react-native[^\n]+--registry="\$npm_registry" "\$npm_scope_registry"/u,
  );
  assert.match(documentation, /npm 11\.15\.0 or newer/u);
  assert.match(documentation, /strict `release\.yml` cannot publish/u);
  assert.match(documentation, /npm permits only one trusted publisher per package/u);
  assert.doesNotMatch(documentation, /namespace:bootstrap -- --/u);
  for (const filename of ["release.yml", "single-maintainer-release.yml"]) {
    const workflow = await readFile(join(ROOT_PATH, ".github", "workflows", filename), "utf8");
    assert.doesNotMatch(workflow, /namespace-bootstrap|0\.0\.0-bootstrap|--tag[= ]bootstrap/u);
  }
});

async function registryFixture(output, inspection, present, mutations = {}) {
  const byName = new Map(inspection.packages.map((package_) => [package_.name, package_]));
  const archives = new Map();
  for (const definition of BOOTSTRAP_PACKAGES) {
    const package_ = byName.get(definition.name);
    archives.set(definition.name, await readFile(join(output, package_.archive)));
  }
  return {
    present,
    fetch: async (input) => {
      const url = new URL(input);
      const definition = BOOTSTRAP_PACKAGES.find(({ name }) =>
        url.pathname === `/${encodeURIComponent(name)}` || url.pathname.startsWith(`/${name}/-/`));
      assert.notEqual(definition, undefined, `unexpected registry URL: ${url.href}`);
      if (!url.pathname.includes("/-/")) {
        if (!present.has(definition.name)) return new globalThis.Response("not found", { status: 404 });
        const bytes = archives.get(definition.name);
        const package_ = byName.get(definition.name);
        const manifest = globalThis.structuredClone(bootstrapManifest(definition));
        const packument = {
          name: definition.name,
          "dist-tags": { bootstrap: BOOTSTRAP_VERSION },
          versions: {
            [BOOTSTRAP_VERSION]: {
              ...manifest,
              dist: {
                integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
                shasum: createHash("sha1").update(bytes).digest("hex"),
                tarball: new URL(`${definition.name}/-/${package_.archive}`, BOOTSTRAP_REGISTRY).href,
              },
            },
          },
        };
        mutations.mutatePackument?.(definition, packument);
        return globalThis.Response.json(packument);
      }
      const bytes = mutations.mutateArchive?.(definition, archives.get(definition.name)) ??
        archives.get(definition.name);
      return new globalThis.Response(bytes, { status: 200 });
    },
  };
}
