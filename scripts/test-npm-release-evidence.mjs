import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  PROVENANCE_TYPE,
  assertSafeRetainedOutput,
  buildAdoptionRecord,
  buildRegistryManifest,
  parseProvenanceOrigin,
  requireCurrentPublicationOrigin,
  sha256,
  verifyProvenanceStatement,
} from "./npm-release-evidence.mjs";

const repository = "https://github.com/Latchway/latchway-js";
const commit = "a".repeat(40);
const sha512 = "b".repeat(128);

test("provenance from a prior failed run can be adopted by a later attempt", () => {
  const statement = provenanceStatement(`${repository}/actions/runs/41/attempts/1`);
  const origin = verifyProvenanceStatement(statement, {
    packageName: "@latchway/client",
    packageVersion: "1.0.0",
    sha512,
    expectedRepositoryURL: repository,
    expectedCommit: commit,
    expectedEvent: "repository_dispatch",
  });
  assert.deepEqual(origin, {
    invocation_id: `${repository}/actions/runs/41/attempts/1`,
    run_id: 41,
    run_attempt: 1,
  });
  requireCurrentPublicationOrigin(origin, {
    publishPerformed: false,
    currentRunID: 99,
    currentRunAttempt: 2,
  });
  const manifest = Buffer.from("registry evidence\n");
  const adoption = buildAdoptionRecord({
    packageName: "@latchway/client",
    packageVersion: "1.0.0",
    releaseTag: "v1.0.0",
    repositoryURL: repository,
    sourceCommit: commit,
    provenanceOrigin: origin,
    tarball: {
      name: "client.tgz",
      bytes: 123,
      sha256: "d".repeat(64),
      sha512: "e".repeat(128),
      integrity: `sha512-${Buffer.from("e".repeat(128), "hex").toString("base64")}`,
    },
    manifestSHA256: sha256(manifest),
    currentRunID: 99,
    currentRunAttempt: 2,
    publishPerformed: false,
  });
  assert.equal(adoption.provenance.run_id, 41);
  assert.equal(adoption.adoption.run_id, 99);
  assert.equal(adoption.adoption.mode, "adopted_existing");
  assert.equal(adoption.tarball.sha256, "d".repeat(64));
});

test("fresh publication cannot adopt provenance from another run", () => {
  assert.throws(() => requireCurrentPublicationOrigin(
    { run_id: 41, run_attempt: 1 },
    { publishPerformed: true, currentRunID: 99, currentRunAttempt: 2 },
  ), /exact workflow attempt/u);
});

test("provenance rejects repository, commit, and workflow substitutions", () => {
  const cases = [
    provenanceStatement("https://github.com/attacker/repo/actions/runs/41/attempts/1"),
    provenanceStatement(`${repository}/actions/runs/41/attempts/1`, { commit: "f".repeat(40) }),
    provenanceStatement(`${repository}/actions/runs/41/attempts/1`, { workflow: "evil.yml" }),
  ];
  for (const statement of cases) {
    assert.throws(() => verifyProvenanceStatement(statement, {
      packageName: "@latchway/client",
      packageVersion: "1.0.0",
      sha512,
      expectedRepositoryURL: repository,
      expectedCommit: commit,
      expectedEvent: "repository_dispatch",
    }), /provenance/u);
  }
});

test("retained output is bounded JSON and rejects credentials", () => {
  assert.deepEqual(assertSafeRetainedOutput(Buffer.from('{"ok":true}\n'), "test", 64), { ok: true });
  assert.throws(
    () => assertSafeRetainedOutput(Buffer.from('{"token":"npm_abcdefghijklmnopqrstuvwxyz123456"}'), "test", 128),
    /credential-like/u,
  );
  assert.throws(() => assertSafeRetainedOutput(Buffer.alloc(129, 1), "test", 128), /size/u);
});

test("registry manifest hashes exact retained output bytes", () => {
  const first = Buffer.from('{"one":1}\n');
  const second = Buffer.from('{"two":2}\n');
  const manifest = buildRegistryManifest({
    packageName: "@latchway/client",
    packageVersion: "1.0.0",
    tarball: { name: "client.tgz", sha256: "c".repeat(64) },
    evidence: [{ name: "two.json", bytes: second }, { name: "one.json", bytes: first }],
  });
  assert.deepEqual(manifest.evidence.map((entry) => entry.name), ["one.json", "two.json"]);
  assert.equal(manifest.evidence[0].sha256, sha256(first));
});

test("provenance invocation parser rejects ambiguous or unbounded paths", () => {
  for (const value of [
    `${repository}/actions/runs/0/attempts/1`,
    `${repository}/actions/runs/1/attempts/0`,
    `${repository}/actions/runs/1/attempts/1/extra`,
    `${repository}@attacker/actions/runs/1/attempts/1`,
  ]) assert.throws(() => parseProvenanceOrigin(value, repository), /provenance/u);
});

test("release workflow drafts before npm and publishes GitHub only after evidence attestation", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const draft = workflow.indexOf("Preflight immutable release and create draft with fixed API calls");
  const cliCapability = workflow.indexOf("version_line=$(gh version | head -n 1)");
  const npmPublish = workflow.indexOf('"$LATCHWAY_NPM_CLI" publish "$archive"');
  const registryVerify = workflow.indexOf("node scripts/verify-published.mjs");
  const assetClosure = workflow.indexOf(
    "Validate exact JavaScript asset closure before OIDC attestation",
  );
  const evidenceAttestation = workflow.indexOf(
    "Attest exact retained registry and release evidence without candidate checkout",
  );
  const githubPublish = workflow.indexOf(
    "Reconcile, publish, and verify immutable release with fixed API calls",
  );
  assert.ok(cliCapability >= 0 && cliCapability < draft && draft < npmPublish);
  assert.ok(npmPublish < registryVerify && registryVerify < assetClosure
    && assetClosure < evidenceAttestation && evidenceAttestation < githubPublish);
  for (const asset of [
    "docs-bundle-$RELEASE_VERSION.tar.gz",
    "npm-registry-version.json",
    "npm-registry-view.json",
    "npm-attestations.json",
    "npm-audit-signatures.json",
    "npm-registry-evidence-manifest.json",
    "npm-release-adoption-",
  ]) assert.ok(workflow.slice(githubPublish).includes(asset), `final reconciliation omits ${asset}`);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|--clobber/u);
  assert.match(workflow,
    /NPM_CLI_SHA512: ee22b335fcbc95662cdf3ab8a053daf045d9cf9c6df6040d28965abb707512b2c16fa6c5eec049d34c74f78f390cebd14f697919eadb97756564d4f9eccc4954/u);
  assert.match(workflow,
    /NPM_CLI_INTEGRITY: sha512-7iKzNfy8lWYs3zq4oFPa8EXZz5xt9gQNKJZau3B1ErLBb6bF7sBJ00x09485DOvRT2l5Gerbl3VlZNT57MxJVA==/u);
  const trustedNpmJob = workflow.slice(
    workflow.indexOf("\n  trusted-npm-cli:\n"),
    workflow.indexOf("\n  github-draft:\n"),
  );
  const npmPublishJob = workflow.slice(
    workflow.indexOf("\n  npm-publish:\n"),
    workflow.indexOf("\n  publish:\n"),
  );
  assert.match(trustedNpmJob, /permissions: \{\}/u);
  assert.match(trustedNpmJob, /NPM_CONFIG_IGNORE_SCRIPTS: "true"/u);
  assert.match(trustedNpmJob, /sha512sum --check --strict/u);
  assert.doesNotMatch(trustedNpmJob,
    /actions\/checkout|secrets\.|github\.token|id-token:|attestations:|npm install|npm exec/u);
  assert.doesNotMatch(trustedNpmJob, /(?:^|\n)\s*npx\s/u);
  assert.match(npmPublishJob, /needs: \[promote, verify, trusted-npm-cli, github-draft\]/u);
  assert.match(npmPublishJob, /Verify exact npm CLI closure before extraction or execution/u);
  assert.doesNotMatch(npmPublishJob, /npm install|npm exec/u);
  assert.doesNotMatch(npmPublishJob, /(?:^|\n)\s*npx\s/u);
  assert.ok(
    npmPublishJob.indexOf("sha512sum --check --strict")
      < npmPublishJob.indexOf('tar --extract --gzip --file "$archive"')
      && npmPublishJob.indexOf('tar --extract --gzip --file "$archive"')
      < npmPublishJob.indexOf('test "$("$cli" --version)"'),
  );
  assert.equal((workflow.match(/\$\{\{\s*secrets\.LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN\s*\}\}/gu) ?? []).length, 2);
  const policyJob = workflow.slice(
    workflow.indexOf("\n  github-release-policy:\n"),
    workflow.indexOf("\n  github-release:\n"),
  );
  const releaseJob = workflow.slice(workflow.indexOf("\n  github-release:\n"));
  assert.match(policyJob, /LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN/u);
  assert.doesNotMatch(policyJob, /id-token: write|attestations: write|actions\/checkout|scripts\//u);
  assert.doesNotMatch(releaseJob, /LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN/u);
  assert.match(releaseJob, /cmp --silent "\$RUNNER_TEMP\/expected-assets\.txt"/u);
  const reconciler = await readFile(new URL("reconcile-github-release.py", import.meta.url), "utf8");
  for (const control of [
    "repos/{repository}/immutable-releases",
    'set(value) == {"enabled", "enforced_by_owner"}',
    '"gh", "release", "verify"',
    '"gh", "release", "verify-asset"',
    "validate_remote_tag",
    "_strict_json_loads",
    "expected_commit",
    "os.environ.pop",
    "_run_json_with_retries",
  ]) assert.ok(reconciler.includes(control), `release reconciler omits ${control}`);
  assert.match(workflow.slice(githubPublish), /\.object\.sha == \$commit/u);
});

test("release documentation forbids maintainer-created tags", async () => {
  const documentation = await readFile(new URL("../docs/releasing.md", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(documentation, /repository_dispatch/u);
  assert.match(documentation, /tag manually/iu);
  assert.doesNotMatch(documentation, /\n(?:git tag|git push)\s/u);
  assert.doesNotMatch(`${documentation}\n${readme}`, /tag-triggered release workflow|the tag workflow/iu);
});

function provenanceStatement(invocation, overrides = {}) {
  const resolvedCommit = overrides.commit ?? commit;
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: PROVENANCE_TYPE,
    subject: [{
      name: "pkg:npm/%40latchway/client@1.0.0",
      digest: { sha512 },
    }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository,
            path: `.github/workflows/${overrides.workflow ?? "release.yml"}`,
            ref: "refs/heads/main",
          },
        },
        resolvedDependencies: [{
          uri: `git+${repository}@${resolvedCommit}`,
          digest: { gitCommit: resolvedCommit },
        }],
        internalParameters: { github: { event_name: "repository_dispatch" } },
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: { invocationId: invocation },
      },
    },
  };
}
