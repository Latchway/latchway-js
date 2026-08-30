import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./prepare-verification-runtime.mjs", import.meta.url));

test("tokenless registry runtime rejects OIDC and creates isolated npm paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "latchway-js-verification-runtime-"));
  try {
    const environment = runtimeEnvironment(root);
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schema_version: 1,
      node: "v24.19.0",
      npm: resultNpmVersion(result.stdout),
      github_hosted: true,
      oidc_available: false,
      long_lived_npm_token_present: false,
      registry: "https://registry.npmjs.org/",
    });
    assert.equal(
      await readFile(environment.NPM_CONFIG_USERCONFIG, "utf8"),
      "registry=https://registry.npmjs.org/\nfund=false\nupdate-notifier=false\n",
    );

    const oidcRoot = await mkdtemp(join(tmpdir(), "latchway-js-verification-oidc-"));
    try {
      const rejected = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: {
          ...runtimeEnvironment(oidcRoot),
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "not-a-real-token",
        },
      });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /must not be present in the tokenless registry-evidence job/u);
    } finally {
      await rm(oidcRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runtimeEnvironment(root) {
  const forbidden = new Set([
    "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "NODE_AUTH_TOKEN", "NPM_TOKEN",
  ]);
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !forbidden.has(name))),
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_TEMP: root,
    NPM_CONFIG_CACHE: join(root, "npm-cache"),
    NPM_CONFIG_USERCONFIG: join(root, "release.npmrc"),
  };
  return environment;
}

function resultNpmVersion(output) {
  const value = JSON.parse(output);
  assert.match(value.npm, /^\d+\.\d+\.\d+$/u);
  return value.npm;
}
