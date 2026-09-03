import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
  NPM_PUBLISH_TIMEOUT_MILLISECONDS,
  PUBLISH_CONFIRMATION,
  REGISTRY_VERIFY_TIMEOUT_MILLISECONDS,
  bootstrapManifest,
  buildBootstrapArchives,
  parseArguments,
  publishArguments,
  reconcileBootstrapRegistry,
  runNpmPublish,
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
  assert.equal(REGISTRY_VERIFY_TIMEOUT_MILLISECONDS, 20 * 60 * 1000);
  assert.equal(NPM_PUBLISH_TIMEOUT_MILLISECONDS, 20 * 60 * 1000);
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
      join(homedir(), "latchway-bootstrap-unsafe-output"),
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
  assert.equal(first.schema_version, 2);
  assert.equal(first.stable_release, false);
  assert.equal(first.registry_latest_alias_policy, "allow_only_exact_singleton_bootstrap");
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
    sourceIdentity,
    waitImplementation: async () => {},
  });
  assert.deepEqual(published, ["@latchway/langchain", "@latchway/react-native"]);
  assert.equal(completed.kind, "latchway_npm_namespace_bootstrap_completed");
  assert.equal(completed.package_count, 5);
  assert.equal(completed.schema_version, 2);
  assert.equal(completed.stable_release, false);
  assert.equal(completed.registry_latest_alias_policy, "allow_only_exact_singleton_bootstrap");
  for (const package_ of completed.packages) {
    assert.deepEqual(package_.observed_dist_tags, { bootstrap: BOOTSTRAP_VERSION });
    assert.equal(package_.registry_latest_alias, false);
  }
  assert.deepEqual(completed.source, sourceIdentity.source);
  assert.deepEqual(completed.toolchain, { npm: BOOTSTRAP_NPM_VERSION });
  assert.deepEqual(completed.packages.map(({ name }) => name), BOOTSTRAP_PACKAGES.map(({ name }) => name));
  assert.deepEqual(JSON.parse(await readFile(join(output, "completed.json"), "utf8")), completed);

  const rerun = await reconcileBootstrapRegistry(output, {
    fetchImplementation: registry.fetch,
    publish: async () => assert.fail("an exact existing bootstrap package must be adopted"),
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
    sourceIdentity,
    waitImplementation: async () => {},
  });
  assert.equal(completed.package_count, 5);
});

test("registry reconciliation records the exact first-publish latest alias without modifying tags", async (context) => {
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
  const completed = await reconcileBootstrapRegistry(output, {
    fetchImplementation: registry.fetch,
    publish: async (definition) => {
      published.push(definition.name);
      registry.present.add(definition.name);
      latestNames.add(definition.name);
    },
    sourceIdentity,
    waitImplementation: async () => {},
  });
  assert.deepEqual(published, ["@latchway/client"]);
  assert.equal(completed.package_count, 5);
  assert.deepEqual([...latestNames], ["@latchway/client"]);
  assert.deepEqual(completed.packages[0].observed_dist_tags, {
    bootstrap: BOOTSTRAP_VERSION,
    latest: BOOTSTRAP_VERSION,
  });
  assert.equal(completed.packages[0].registry_latest_alias, true);
  assert.equal(completed.stable_release, false);

  const resumed = await reconcileBootstrapRegistry(output, {
    fetchImplementation: registry.fetch,
    publish: async () => assert.fail("a byte-identical existing record must not be republished"),
    sourceIdentity,
    waitImplementation: async () => {},
  });
  assert.deepEqual(resumed, completed);
});

test("receipt canonicalizes first-publish aliases regardless of registry tag order", async (context) => {
  const { output, inspection, sourceIdentity } = await bootstrapFixture(context, "tag-order");
  let reverse = false;
  const registry = await registryFixture(output, inspection, allPackageNames(), {
    mutatePackument: (_definition, packument) => {
      packument["dist-tags"] = reverse ?
        { latest: BOOTSTRAP_VERSION, bootstrap: BOOTSTRAP_VERSION } :
        { bootstrap: BOOTSTRAP_VERSION, latest: BOOTSTRAP_VERSION };
    },
  });
  const options = {
    fetchImplementation: registry.fetch,
    publish: async () => assert.fail("existing exact packages must be adopted"),
    sourceIdentity,
    waitImplementation: async () => {},
  };
  const first = await reconcileBootstrapRegistry(output, options);
  reverse = true;
  assert.deepEqual(await reconcileBootstrapRegistry(output, options), first);
  assert.equal(first.packages.every((package_) => package_.registry_latest_alias), true);
});

test("registry visibility waits through minutes of metadata scanning after an uncertain publish", async (context) => {
  const { output, inspection, sourceIdentity } = await bootstrapFixture(context, "metadata-delay");
  const clock = registryClock();
  const delayedName = BOOTSTRAP_PACKAGES[4].name;
  const registry = await registryFixture(output, inspection, allPackageNames(delayedName), {
    metadataStatus: (definition) => definition.name === delayedName && clock.elapsed() < 90_000 ? 404 : undefined,
  });
  const published = [];
  const progress = [];
  const completed = await reconcileBootstrapRegistry(output, {
    ...clock,
    fetchImplementation: registry.fetch,
    publish: async (definition) => {
      published.push(definition.name);
      registry.present.add(definition.name);
      throw new Error("simulated uncertain response with credential-like details that must not escape");
    },
    progressImplementation: (event) => progress.push(event),
    sourceIdentity,
  });
  assert.deepEqual(published, [delayedName]);
  assert.equal(clock.elapsed(), 90_000);
  assert.equal(completed.package_count, 5);
  assert.deepEqual(progress.map((event) => event.elapsed_milliseconds), [0, 30_000, 60_000]);
  assert.equal(progress.every((event) => event.visibility === "metadata"), true);
});

test("an existing package whose scanned archive is pending is waited for, never republished", async (context) => {
  const { output, inspection, sourceIdentity } = await bootstrapFixture(context, "archive-delay");
  const clock = registryClock();
  const registry = await registryFixture(output, inspection, allPackageNames(), {
    archiveStatus: (definition) => definition.name === "@latchway/client" && clock.elapsed() < 120_000 ? 404 : undefined,
  });
  const completed = await reconcileBootstrapRegistry(output, {
    ...clock,
    fetchImplementation: registry.fetch,
    publish: async () => assert.fail("pending registry archive must not cause publication"),
    sourceIdentity,
  });
  assert.equal(clock.elapsed(), 120_000);
  assert.equal(completed.package_count, 5);
});

test("visibility ceiling reports pending without completion or publishing a following package", async (context) => {
  const { output, inspection, sourceIdentity } = await bootstrapFixture(context, "visibility-timeout");
  const clock = registryClock();
  const registry = await registryFixture(output, inspection, allPackageNames("@latchway/client", "@latchway/openai"), {
    metadataStatus: (definition) => definition.name === "@latchway/client" ? 404 : undefined,
  });
  const published = [];
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    ...clock,
    fetchImplementation: registry.fetch,
    publish: async (definition) => {
      published.push(definition.name);
      throw new Error("sensitive subprocess output must not appear in the pending error");
    },
    sourceIdentity,
  }), (error) => {
    assert.equal(error.code, "LATCHWAY_BOOTSTRAP_REGISTRY_PENDING");
    assert.equal(error.state, "pending");
    assert.equal(error.publication_response, "failed_or_unknown");
    assert.equal(error.package_name, "@latchway/client");
    assert.equal(error.visibility, "metadata");
    assert.match(error.message, /within 20 minutes/u);
    assert.doesNotMatch(error.message, /sensitive subprocess output/u);
    return true;
  });
  assert.equal(clock.elapsed(), REGISTRY_VERIFY_TIMEOUT_MILLISECONDS);
  assert.deepEqual(published, ["@latchway/client"]);
  await assert.rejects(() => readFile(join(output, "completed.json")), { code: "ENOENT" });
});

test("unsafe metadata appearing during scanning fails immediately without waiting out the deadline", async (context) => {
  const { output, inspection, sourceIdentity } = await bootstrapFixture(context, "scanning-conflict");
  const clock = registryClock();
  const registry = await registryFixture(output, inspection, allPackageNames("@latchway/client"), {
    metadataStatus: (definition) => definition.name === "@latchway/client" && clock.elapsed() < 30_000 ? 404 : undefined,
    mutatePackument: (definition, packument) => {
      if (definition.name === "@latchway/client") packument["dist-tags"].latest = "1.0.0";
    },
  });
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    ...clock,
    fetchImplementation: registry.fetch,
    publish: async (definition) => registry.present.add(definition.name),
    sourceIdentity,
  }), /at most its exact singleton latest alias/u);
  assert.equal(clock.elapsed(), 30_000);
});

test("archive visibility deadline is pending but other HTTP failures reject immediately", async (context) => {
  const { output, inspection, sourceIdentity } = await bootstrapFixture(context, "archive-timeout");
  const clock = registryClock();
  const options = {
    ...clock,
    publish: async () => assert.fail("existing package must not be republished"),
    sourceIdentity,
  };
  const pending = await registryFixture(output, inspection, allPackageNames(), {
    archiveStatus: () => 404,
  });
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    ...options, fetchImplementation: pending.fetch,
  }), (error) => {
    assert.equal(error.code, "LATCHWAY_BOOTSTRAP_REGISTRY_PENDING");
    assert.equal(error.visibility, "archive");
    return true;
  });
  assert.equal(clock.elapsed(), REGISTRY_VERIFY_TIMEOUT_MILLISECONDS);
  for (const status of [401, 403, 429, 500]) {
    const failed = await registryFixture(output, inspection, allPackageNames(), {
      archiveStatus: () => status,
    });
    await assert.rejects(() => reconcileBootstrapRegistry(output, {
      ...options, fetchImplementation: failed.fetch,
      waitImplementation: async () => assert.fail("non-404 failure must not be retried as scanning"),
    }), new RegExp(`registry archive returned HTTP ${status}`, "u"));
  }
  await assert.rejects(() => readFile(join(output, "completed.json")), { code: "ENOENT" });
});

test("final closure rejects registry drift before writing a completion receipt", async (context) => {
  const { output, inspection, sourceIdentity } = await bootstrapFixture(context, "final-drift");
  let clientReads = 0;
  const registry = await registryFixture(output, inspection, allPackageNames(), {
    mutatePackument: (definition, packument) => {
      if (definition.name === "@latchway/client" && ++clientReads === 3) {
        packument["dist-tags"].latest = "1.0.0";
      }
    },
  });
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    fetchImplementation: registry.fetch,
    publish: async () => assert.fail("all namespaces are already present"),
    sourceIdentity,
    waitImplementation: async () => assert.fail("registry drift must fail immediately"),
  }), /at most its exact singleton latest alias/u);
  assert.equal(clientReads, 3);
  await assert.rejects(() => readFile(join(output, "completed.json")), { code: "ENOENT" });
});

test("later namespaces are rechecked after scanning delays before any publication", async (context) => {
  const { output, inspection, sourceIdentity } = await bootstrapFixture(context, "namespace-drift");
  const clock = registryClock();
  const registry = await registryFixture(output, inspection, allPackageNames("@latchway/client", "@latchway/openai"), {
    archiveStatus: (definition) => definition.name === "@latchway/client" && clock.elapsed() < 30_000 ? 404 : undefined,
    mutatePackument: (definition, packument) => {
      if (definition.name === "@latchway/openai") packument["dist-tags"].next = BOOTSTRAP_VERSION;
    },
  });
  const published = [];
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    ...clock,
    fetchImplementation: registry.fetch,
    publish: async (definition) => {
      published.push(definition.name);
      registry.present.add(definition.name);
      registry.present.add("@latchway/openai");
    },
    sourceIdentity,
  }), /at most its exact singleton latest alias/u);
  assert.deepEqual(published, ["@latchway/client"]);
  assert.equal(clock.elapsed(), 30_000);
});

test("source or archive drift before publication fails outside ambiguous-response reconciliation", async (context) => {
  const { output, inspection, sourceIdentity } = await bootstrapFixture(context, "local-drift");
  const registry = await registryFixture(output, inspection, allPackageNames("@latchway/client"));
  const options = {
    fetchImplementation: registry.fetch,
    publish: async () => assert.fail("changed inputs must not be published"),
    sourceIdentity,
    waitImplementation: async () => assert.fail("pre-publication failures must not be treated as uncertain writes"),
  };
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    ...options,
    beforePublish: async () => { throw new Error("reviewed source changed"); },
  }), /reviewed source changed/u);
  const archive = join(output, inspection.packages[0].archive);
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    ...options,
    beforePublish: async () => writeFile(archive, Buffer.concat([await readFile(archive), Buffer.from("changed")])),
  }), /local archive changed|archive|tar/u);
});

test("async publication stays responsive, bounds its child, and redacts process failures", async () => {
  let eventLoopTicked = false;
  const running = runNpmPublish(process.execPath, ["-e", "setTimeout(() => {}, 100)"], ROOT_PATH);
  await new Promise((resolve_) => setTimeout(() => { eventLoopTicked = true; resolve_(); }, 10));
  assert.equal(eventLoopTicked, true);
  await running;
  await assert.rejects(() => runNpmPublish(process.execPath, ["-e", "process.exit(1)"], ROOT_PATH), /exited unsuccessfully/u);
  await assert.rejects(() => runNpmPublish("/missing/sensitive-command-sentinel", [], ROOT_PATH), (error) => {
    assert.match(error.message, /could not start/u);
    assert.doesNotMatch(error.message, /sensitive-command-sentinel/u);
    return true;
  });
  await assert.rejects(() => runNpmPublish(process.execPath, ["-e", "setInterval(() => {}, 1000)"], ROOT_PATH, {}, {
    timeoutMilliseconds: 100,
  }), /timed out/u);
  await assert.rejects(() => runNpmPublish(process.execPath, [], ROOT_PATH, {}, {
    timeoutMilliseconds: NPM_PUBLISH_TIMEOUT_MILLISECONDS + 1,
  }), /bounded timeout/u);
  await runNpmPublish(process.execPath, ["-e",
    "process.exit(process.env.NPM_TOKEN === undefined && process.env.NODE_AUTH_TOKEN === undefined ? 0 : 1)",
  ], ROOT_PATH, { NPM_TOKEN: "test-only-not-a-real-token", NODE_AUTH_TOKEN: "test-only-not-a-real-token" });
});

test("registry reconciliation rejects foreign tags, versions, identity, and archives before mutation", async (context) => {
  const output = await mkdtemp(join(tmpdir(), "latchway-npm-bootstrap-rejection-"));
  context.after(async () => rm(output, { force: true, recursive: true }));
  const sourceIdentity = await testSourceIdentity();
  const inspection = await buildBootstrapArchives(output, TEST_NPM_COMMAND, sourceIdentity);
  const allNames = new Set(BOOTSTRAP_PACKAGES.map(({ name }) => name));
  let publishCalls = 0;
  const publish = async () => { publishCalls += 1; };
  const waitImplementation = async () => {};

  for (const distTags of [
    {},
    { latest: BOOTSTRAP_VERSION },
    { bootstrap: "1.0.0" },
    { bootstrap: BOOTSTRAP_VERSION, next: BOOTSTRAP_VERSION },
  ]) {
    const invalid = await registryFixture(output, inspection, allNames, {
      mutatePackument: (_definition, packument) => { packument["dist-tags"] = distTags; },
    });
    await assert.rejects(() => reconcileBootstrapRegistry(output, {
      fetchImplementation: invalid.fetch, publish, sourceIdentity, waitImplementation,
    }), /at most its exact singleton latest alias/u);
  }

  const foreignTag = await registryFixture(output, inspection, allNames, {
    mutatePackument: (_definition, packument) => {
      packument["dist-tags"].latest = BOOTSTRAP_VERSION;
      packument["dist-tags"].next = BOOTSTRAP_VERSION;
    },
  });
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    fetchImplementation: foreignTag.fetch,
    publish,
    sourceIdentity,
    waitImplementation,
  }), /at most its exact singleton latest alias/u);

  const wrongLatestTarget = await registryFixture(output, inspection, allNames, {
    mutatePackument: (_definition, packument) => {
      packument["dist-tags"].latest = "1.0.0";
    },
  });
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    fetchImplementation: wrongLatestTarget.fetch,
    publish,
    sourceIdentity,
    waitImplementation,
  }), /at most its exact singleton latest alias/u);

  let clientMetadataReads = 0;
  const changedBeforeAdoption = await registryFixture(output, inspection, allNames, {
    mutatePackument: (definition, packument) => {
      if (definition.name !== "@latchway/client") return;
      clientMetadataReads += 1;
      packument["dist-tags"].latest = BOOTSTRAP_VERSION;
      if (clientMetadataReads > 1) packument["dist-tags"].next = BOOTSTRAP_VERSION;
    },
  });
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    fetchImplementation: changedBeforeAdoption.fetch,
    publish,
    sourceIdentity,
    waitImplementation,
  }), /at most its exact singleton latest alias/u);
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
    sourceIdentity,
    waitImplementation,
  }), /manifest field files differs/u);

  for (const mutation of [
    (manifest) => { manifest.scripts = { install: "unexpected" }; },
    (manifest) => { manifest.dist.integrity = "sha512-wrong"; },
    (manifest) => { manifest.dist.shasum = "0".repeat(40); },
  ]) {
    const invalid = await registryFixture(output, inspection, allNames, {
      mutatePackument: (_definition, packument) => {
        packument["dist-tags"].latest = BOOTSTRAP_VERSION;
        mutation(packument.versions[BOOTSTRAP_VERSION]);
      },
    });
    await assert.rejects(() => reconcileBootstrapRegistry(output, {
      fetchImplementation: invalid.fetch, publish, sourceIdentity, waitImplementation,
    }), /forbidden field|distribution digests differ/u);
  }

  const archive = await registryFixture(output, inspection, allNames, {
    mutatePackument: (_definition, packument) => {
      delete packument.versions[BOOTSTRAP_VERSION].files;
      packument["dist-tags"].latest = BOOTSTRAP_VERSION;
    },
    mutateArchive: (definition, bytes) => definition.name === "@latchway/client" ?
      Buffer.concat([bytes, Buffer.from("changed")]) : bytes,
  });
  await assert.rejects(() => reconcileBootstrapRegistry(output, {
    fetchImplementation: archive.fetch,
    publish,
    sourceIdentity,
    waitImplementation,
  }), /not byte-identical/u);
  assert.equal(publishCalls, 0);
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
  assert.match(documentation, /Receipt schema 2/u);
  assert.match(documentation, /`observed_dist_tags` and `registry_latest_alias`/u);
  assert.match(documentation, /exits with status 2/u);
  assert.match(documentation, /never adds, moves, or removes a tag/u);
  for (const filename of ["release.yml", "single-maintainer-release.yml"]) {
    const workflow = await readFile(join(ROOT_PATH, ".github", "workflows", filename), "utf8");
    assert.doesNotMatch(workflow, /namespace-bootstrap|0\.0\.0-bootstrap|--tag[= ]bootstrap/u);
  }
});

async function bootstrapFixture(context, suffix) {
  const output = await mkdtemp(join(tmpdir(), `latchway-npm-bootstrap-${suffix}-`));
  context.after(async () => rm(output, { force: true, recursive: true }));
  const sourceIdentity = await testSourceIdentity();
  const inspection = await buildBootstrapArchives(output, TEST_NPM_COMMAND, sourceIdentity);
  return { output, inspection, sourceIdentity };
}

function allPackageNames(...excluded) {
  return new Set(BOOTSTRAP_PACKAGES.map(({ name }) => name).filter((name) => !excluded.includes(name)));
}

function registryClock() {
  let now = 0;
  return {
    elapsed: () => now,
    nowImplementation: () => now,
    waitImplementation: async (delay) => { now += delay; },
  };
}

async function registryFixture(output, inspection, present, mutations = {}) {
  const byName = new Map(inspection.packages.map((package_) => [package_.name, package_]));
  const archives = new Map();
  for (const definition of BOOTSTRAP_PACKAGES) {
    const package_ = byName.get(definition.name);
    archives.set(definition.name, await readFile(join(output, package_.archive)));
  }
  return {
    present,
    fetch: async (input, options) => {
      assert.equal(options?.method ?? "GET", "GET", "registry inspection must never mutate tags or packages");
      const url = new URL(input);
      const definition = BOOTSTRAP_PACKAGES.find(({ name }) =>
        url.pathname === `/${encodeURIComponent(name)}` || url.pathname.startsWith(`/${name}/-/`));
      assert.notEqual(definition, undefined, `unexpected registry URL: ${url.href}`);
      if (!url.pathname.includes("/-/")) {
        const status = mutations.metadataStatus?.(definition);
        if (status !== undefined) return new globalThis.Response("pending", { status });
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
      const status = mutations.archiveStatus?.(definition);
      if (status !== undefined) return new globalThis.Response("pending", { status });
      const bytes = mutations.mutateArchive?.(definition, archives.get(definition.name)) ??
        archives.get(definition.name);
      return new globalThis.Response(bytes, { status: 200 });
    },
  };
}
