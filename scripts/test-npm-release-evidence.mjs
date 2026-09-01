import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROVENANCE_TYPE,
  assertSafeRetainedOutput,
  buildAdoptionRecord,
  buildRegistrySetManifest,
  decodeBase64Strict,
  npmReleaseArtifactName,
  normalizePublishStateForConsumerAttempt,
  parseStrictJSONBytes,
  parseProvenanceOrigin,
  readBoundedStrictJSONFileSync,
  requireCurrentPublicationOrigin,
  sha256,
  verifyProvenanceStatement,
} from "./npm-release-evidence.mjs";
import {
  artifactNameForPackage,
  expectedPublishedManifest,
  readReleasePackages,
} from "./release-utils.mjs";

const repository = "https://github.com/Latchway/latchway-js";
const commit = "a".repeat(40);
const sha512 = "b".repeat(128);

test("release package inventory is fixed and workspace peers become registry-safe", async () => {
  const packages = await readReleasePackages();
  assert.deepEqual(packages.map(({ name }) => name), [
    "@latchway/client",
    "@latchway/openai",
    "@latchway/vercel-ai",
    "@latchway/langchain",
  ]);
  assert.deepEqual(packages.map(({ archiveName }) => archiveName), [
    "latchway-client-1.0.0.tgz",
    "latchway-openai-1.0.0.tgz",
    "latchway-vercel-ai-1.0.0.tgz",
    "latchway-langchain-1.0.0.tgz",
  ]);
  for (const package_ of packages.slice(1)) {
    assert.equal(expectedPublishedManifest(package_).peerDependencies["@latchway/client"], "^1.0.0");
  }
  assert.equal(artifactNameForPackage("vercel-ai", "audit-signatures"),
    "npm-vercel-ai-audit-signatures.json");
  assert.throws(() => artifactNameForPackage("../escape", "registry-view"), /unsafe/u);
});

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

test("failed-job rerun reclassifies a prior successful npm producer as adoption", () => {
  const produced = {
    "@latchway/client": true,
    "@latchway/openai": false,
  };
  assert.deepEqual(normalizePublishStateForConsumerAttempt(produced, {
    producerRunID: 41,
    producerRunAttempt: 1,
    currentRunID: 41,
    currentRunAttempt: 1,
  }), produced);
  assert.deepEqual(normalizePublishStateForConsumerAttempt(produced, {
    producerRunID: 41,
    producerRunAttempt: 1,
    currentRunID: 41,
    currentRunAttempt: 2,
  }), {
    "@latchway/client": false,
    "@latchway/openai": false,
  });
  for (const coordinates of [
    { producerRunID: 40, producerRunAttempt: 1, currentRunID: 41, currentRunAttempt: 2 },
    { producerRunID: 41, producerRunAttempt: 3, currentRunID: 41, currentRunAttempt: 2 },
    {
      producerRunID: Number.MAX_SAFE_INTEGER + 1,
      producerRunAttempt: 1,
      currentRunID: Number.MAX_SAFE_INTEGER + 1,
      currentRunAttempt: 2,
    },
  ]) {
    assert.throws(
      () => normalizePublishStateForConsumerAttempt(produced, coordinates),
      /producer workflow attempt/u,
    );
  }
});

test("failed-job reruns use a new immutable npm release-set artifact", () => {
  assert.equal(npmReleaseArtifactName("1.0.0", "41", "1"), "npm-release-set-1.0.0-41-1");
  assert.equal(npmReleaseArtifactName("1.0.0", "41", "2"), "npm-release-set-1.0.0-41-2");
  assert.notEqual(
    npmReleaseArtifactName("1.0.0", "41", "1"),
    npmReleaseArtifactName("1.0.0", "41", "2"),
  );
  for (const coordinate of ["0", "01", `${Number.MAX_SAFE_INTEGER + 1}`, undefined]) {
    assert.throws(() => npmReleaseArtifactName("1.0.0", "41", coordinate), /artifact/u);
  }
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

test("retained output is strict bounded JSON and rejects encoded credentials", () => {
  assert.deepEqual(assertSafeRetainedOutput(Buffer.from('{"ok":true}\n'), "test", 64), { ok: true });
  assert.throws(
    () => assertSafeRetainedOutput(Buffer.from('{"token":"npm_abcdefghijklmnopqrstuvwxyz123456"}'), "test", 128),
    /credential-like/u,
  );
  assert.throws(() => assertSafeRetainedOutput(Buffer.alloc(129, 1), "test", 128), /size/u);
  assert.throws(
    () => assertSafeRetainedOutput(Buffer.from('{"ok":true,"ok":false}'), "test", 64),
    /duplicate JSON key/u,
  );
  assert.throws(
    () => assertSafeRetainedOutput(Buffer.from('{"ok":true,"\\u006fk":false}'), "test", 64),
    /duplicate JSON key/u,
  );
  assert.throws(
    () => assertSafeRetainedOutput(
      Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}')]),
      "test",
      64,
    ),
    /valid UTF-8/u,
  );
  assert.throws(
    () => assertSafeRetainedOutput(
      Buffer.from('{"token":"github_pat_\\u0041BCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}'),
      "test",
      128,
    ),
    /credential-like/u,
  );
});

test("strict JSON rejects non-finite and unsafe numeric values", () => {
  assert.deepEqual(
    parseStrictJSONBytes(Buffer.from(`{"value":${Number.MAX_SAFE_INTEGER}}`), "test", 128),
    { value: Number.MAX_SAFE_INTEGER },
  );
  for (const document of [
    '{"value":1e9999}',
    `{"value":${Number.MAX_SAFE_INTEGER + 1}}`,
    '{"value":-9007199254740992}',
  ]) {
    assert.throws(
      () => parseStrictJSONBytes(Buffer.from(document), "test", 128),
      /non-finite|unsafe JSON integer/u,
    );
  }
});

test("strict base64 decoding rejects noncanonical and oversized encodings", () => {
  assert.deepEqual(decodeBase64Strict("e30=", "test", 16), Buffer.from("{}"));
  for (const encoded of ["e30", "e30===", "e30=garbage", "Zh==", "===="]) {
    assert.throws(() => decodeBase64Strict(encoded, "test", 16), /base64 encoding/u);
  }
  assert.throws(
    () => decodeBase64Strict(Buffer.alloc(17, 1).toString("base64"), "test", 16),
    /base64 encoding/u,
  );
});

test("bounded strict JSON file reads reject ambiguity before parsing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "latchway-js-strict-json-"));
  try {
    const valid = join(directory, "valid.json");
    const duplicate = join(directory, "duplicate.json");
    const invalidUTF8 = join(directory, "invalid-utf8.json");
    const oversized = join(directory, "oversized.json");
    await writeFile(valid, Buffer.from('{"ok":true}'.padEnd(64, " ")));
    await writeFile(duplicate, '{"ok":true,"ok":false}');
    await writeFile(invalidUTF8, Buffer.concat([
      Buffer.from('{"value":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]));
    await writeFile(oversized, Buffer.alloc(65, 0x20));
    assert.deepEqual(readBoundedStrictJSONFileSync(valid, "test file", 64), { ok: true });
    assert.throws(
      () => readBoundedStrictJSONFileSync(duplicate, "test file", 64),
      /duplicate JSON key/u,
    );
    assert.throws(
      () => readBoundedStrictJSONFileSync(invalidUTF8, "test file", 64),
      /valid UTF-8/u,
    );
    assert.throws(
      () => readBoundedStrictJSONFileSync(oversized, "test file", 64),
      /file byte length/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registry package-set manifest preserves the dependency-safe release order", () => {
  const names = ["@latchway/client", "@latchway/openai", "@latchway/vercel-ai", "@latchway/langchain"];
  const ids = ["client", "openai", "vercel-ai", "langchain"];
  const packages = names.map((packageName, index) => ({
    id: ids[index],
    package: packageName,
    version: "1.0.0",
    tarball: {
      name: `latchway-${ids[index]}-1.0.0.tgz`,
      bytes: 100 + index,
      sha256: "c".repeat(64),
      sha512: "d".repeat(128),
      integrity: `sha512-${Buffer.from("d".repeat(128), "hex").toString("base64")}`,
    },
    evidence: ["registry-version", "registry-view", "attestations", "audit-signatures"].map((kind) => ({
      name: `npm-${ids[index]}-${kind}.json`,
      bytes: Buffer.from(`{"package":${index},"kind":"${kind}"}\n`),
    })),
  }));
  const manifest = buildRegistrySetManifest({ version: "1.0.0", publishOrder: names, packages });
  assert.equal(manifest.schema_version, 2);
  assert.deepEqual(manifest.publish_order, names);
  assert.deepEqual(manifest.packages.map(({ package: packageName }) => packageName), names);
  assert.throws(() => buildRegistrySetManifest({
    version: "1.0.0",
    publishOrder: [...names].reverse(),
    packages,
  }), /registry/u);
});

test("provenance invocation parser rejects ambiguous or unbounded paths", () => {
  for (const value of [
    `${repository}/actions/runs/0/attempts/1`,
    `${repository}/actions/runs/1/attempts/0`,
    `${repository}/actions/runs/1/attempts/1/extra`,
    `${repository}@attacker/actions/runs/1/attempts/1`,
    `${repository}/actions/runs/${Number.MAX_SAFE_INTEGER + 1}/attempts/1`,
  ]) assert.throws(() => parseProvenanceOrigin(value, repository), /provenance/u);
});

test("release workflow drafts before npm and publishes GitHub only after evidence attestation", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const publicationVerifier = await readFile(new URL("./verify-published.mjs", import.meta.url), "utf8");
  const artifactVerifier = await readFile(new URL("./verify-release-artifact.mjs", import.meta.url), "utf8");
  const registryPreflightScript = await readFile(new URL("./check-registry-state.mjs", import.meta.url), "utf8");
  const releaseUtilities = await readFile(new URL("./release-utils.mjs", import.meta.url), "utf8");
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
    "Reconcile, publish, and verify the immutable release with the fixed handoff",
  );
  assert.ok(cliCapability >= 0 && cliCapability < draft && draft < npmPublish);
  assert.ok(npmPublish < registryVerify && registryVerify < assetClosure
    && assetClosure < evidenceAttestation && evidenceAttestation < githubPublish);
  for (const asset of [
    "docs-bundle-$RELEASE_VERSION.tar.gz",
    "dependency-vulnerability-scan.json",
    "npm-$package_id-registry-version.json",
    "npm-$package_id-registry-view.json",
    "npm-$package_id-attestations.json",
    "npm-$package_id-audit-signatures.json",
    "npm-registry-evidence-manifest.json",
    "npm-release-adoption-",
  ]) assert.ok(workflow.slice(assetClosure).includes(asset), `final reconciliation omits ${asset}`);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|--clobber/u);
  assert.match(publicationVerifier, /publication_mode: "published"/u);
  assert.doesNotMatch(publicationVerifier, /publication_mode:\s*publishState/u);
  assert.doesNotMatch(publicationVerifier, /JSON\.parse|Buffer\.from\([^\n]*"base64"/u);
  for (const control of [
    "readBoundedStrictJSONFileSync",
    "parseStrictJSONBytes",
    "decodeBase64Strict",
    "MAXIMUM_PACKAGE_LOCK_BYTES",
  ]) assert.ok(publicationVerifier.includes(control), `publication verifier omits ${control}`);
  assert.doesNotMatch(artifactVerifier, /JSON\.parse/u);
  assert.match(artifactVerifier, /readBoundedStrictJSONFileSync\(/u);
  for (const limit of [
    "MAXIMUM_PACKAGE_EVIDENCE_BYTES",
    "MAXIMUM_CANDIDATE_EVIDENCE_BYTES",
    "MAXIMUM_TAG_EVIDENCE_BYTES",
    "MAXIMUM_REPRODUCIBILITY_EVIDENCE_BYTES",
    "MAXIMUM_CONTRACT_EVIDENCE_BYTES",
  ]) assert.ok(artifactVerifier.includes(limit), `artifact verifier omits ${limit}`);
  assert.doesNotMatch(registryPreflightScript, /JSON\.parse/u);
  assert.match(registryPreflightScript, /readBoundedStrictJSONFileSync\(/u);
  assert.doesNotMatch(releaseUtilities,
    /packagedManifest\s*=\s*JSON\.parse|installedManifest\s*=\s*JSON\.parse|value\s*=\s*JSON\.parse\(bytes/u);
  assert.match(releaseUtilities, /packagedManifest = readBoundedStrictJSONFileSync\(/u);
  assert.match(releaseUtilities, /installedManifest = readBoundedStrictJSONFileSync\(/u);
  assert.match(releaseUtilities, /value = parseStrictJSONBytes\(/u);
  assert.match(workflow, /all\(\.packages\[\]; \.publication_mode == "published"\)/u);
  assert.match(workflow,
    /\(\.adoption\.mode == "published"\) ==\s*\(\.provenance\.run_id == \.adoption\.run_id/u);
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
  assert.match(npmPublishJob,
    /package_names=\('@latchway\/client' '@latchway\/openai' '@latchway\/vercel-ai' '@latchway\/langchain'\)/u);
  assert.match(npmPublishJob, /archive_sha1=\$\(sha1sum "\$archive"/u);
  assert.match(npmPublishJob,
    /\.sha256 == \$sha256 and \.sha512 == \$sha512 and \.integrity == \$integrity/u);
  assert.match(npmPublishJob, /publish_state=\$\(jq --compact-output/u);
  assert.match(npmPublishJob,
    /--max-filesize 2097152[\s\S]*--output "\$metadata" --write-out '%\{http_code\}'/u);
  const registryPreflight = npmPublishJob.indexOf("publish_required=()");
  const preflightCompletion = npmPublishJob.indexOf("publish_state='{}'", registryPreflight);
  const registryMutation = npmPublishJob.indexOf('"$LATCHWAY_NPM_CLI" publish "$archive"');
  assert.ok(registryPreflight >= 0 && registryPreflight < preflightCompletion
    && preflightCompletion < registryMutation);
  assert.equal((npmPublishJob.slice(registryPreflight).match(
    /for index in "\$\{!package_names\[@\]\}"; do/gu,
  ) ?? []).length, 2);
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
  for (const control of [
    '.enforced_by_owner == true',
    'test "$GITHUB_RELEASE_POLICY_TTL_SECONDS" = 600',
    'schema_version: 2',
    'run_id: $run_id',
    'run_attempt: $run_attempt',
    'issued_at: $issued_at',
    'expires_at: $expires_at',
  ]) assert.ok(policyJob.includes(control), `immutable-policy handoff omits ${control}`);
  assert.doesNotMatch(releaseJob, /LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN/u);
  assert.match(releaseJob, /cmp --silent "\$RUNNER_TEMP\/expected-assets\.txt"/u);
  assert.match(releaseJob, /test "\$\{#expected\[@\]\}" = 35/u);
  assert.match(releaseJob, /package_ids=\(client openai vercel-ai langchain\)/u);
  assert.match(releaseJob, /python3 "\$reconciler"/u);
  assert.match(releaseJob, /--verified-immutable-policy-run-id "\$GITHUB_RUN_ID"/u);
  assert.match(releaseJob, /--verified-immutable-policy-run-attempt "\$GITHUB_RUN_ATTEMPT"/u);
  assert.doesNotMatch(releaseJob, /verify_or_upload|lookup_release\(\)/u);
  assert.equal((workflow.match(/if: needs\.github-draft\.outputs\.release_state == 'draft'/gu) ?? []).length, 2);
  assert.doesNotMatch(releaseJob, /all\([^;\n]+\s+as\s+\$[A-Za-z_][A-Za-z0-9_]*\s*;/u);
  const reconciler = await readFile(new URL("reconcile-github-release.py", import.meta.url), "utf8");
  const versionCheck = await readFile(new URL("require-gh-version.py", import.meta.url), "utf8");
  const reconcilerSHA256 = createHash("sha256").update(reconciler).digest("hex");
  const versionCheckSHA256 = createHash("sha256").update(versionCheck).digest("hex");
  assert.match(workflow, new RegExp(`GITHUB_RELEASE_RECONCILER_SHA256: ${reconcilerSHA256}`, "u"));
  assert.match(workflow, new RegExp(`GITHUB_RELEASE_VERSION_CHECK_SHA256: ${versionCheckSHA256}`, "u"));
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
    "validate_immutable_policy_evidence",
    "MAXIMUM_POLICY_TTL_SECONDS",
    "require_immutable_policy_current",
    "verify_adoption_asset",
    "_is_bounded_positive_integer",
    '_strict_json_loads(payload.decode("utf-8"))',
    'expected_tarball_name = f"latchway-{package_id}-{tag[1:]}.tgz"',
    "invalid remote asset metadata",
    '(adoption.get("mode") == "published") is not provenance_matches_adoption',
    "for name in sorted(final_adoptions)",
    'registry.get("sha256") != manifest_sha256',
  ]) assert.ok(reconciler.includes(control), `release reconciler omits ${control}`);
  assert.match(reconciler, /target\.get\("sha"\) != expected_commit/u);
});

test("release handoffs survive failed-job reruns by consuming producer outputs", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const artifactOutput = await readFile(new URL("./release-artifact-output.mjs", import.meta.url), "utf8");
  const job = (name, next) => workflow.slice(
    workflow.indexOf(`\n  ${name}:\n`),
    next === undefined ? workflow.length : workflow.indexOf(`\n  ${next}:\n`),
  );
  const authorize = job("authorize-promotion", "verify-promotion");
  const verifyPromotion = job("verify-promotion", "promote");
  const verifyJob = job("verify", "trusted-npm-cli");
  const trustedNpm = job("trusted-npm-cli", "github-draft");
  const npmPublishJob = job("npm-publish", "publish");
  const publishJob = job("publish", "github-release-policy");
  const policyJob = job("github-release-policy", "github-release");
  const releaseJob = job("github-release");

  assert.match(authorize, /report_artifact_name: \$\{\{ steps\.report_handoff\.outputs\.artifact_name \}\}/u);
  assert.match(verifyPromotion, /name: \$\{\{ needs\.authorize-promotion\.outputs\.report_artifact_name \}\}/u);
  assert.doesNotMatch(verifyPromotion, /sdk-core-promotion-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(verifyJob, /artifact_name: \$\{\{ steps\.package\.outputs\.artifact_name \}\}/u);
  assert.match(npmPublishJob, /name: \$\{\{ needs\.verify\.outputs\.artifact_name \}\}/u);
  assert.match(artifactOutput, /npmReleaseArtifactName\(/u);
  assert.match(artifactOutput, /readBoundedStrictJSONFileSync\(/u);
  assert.doesNotMatch(artifactOutput, /JSON\.parse/u);
  assert.doesNotMatch(artifactOutput,
    /artifact_name=npm-release-set-\$\{evidence\.version\}`/u);
  assert.match(trustedNpm, /artifact_name: \$\{\{ steps\.handoff\.outputs\.artifact_name \}\}/u);
  assert.match(npmPublishJob, /name: \$\{\{ needs\.trusted-npm-cli\.outputs\.artifact_name \}\}/u);
  assert.doesNotMatch(npmPublishJob, /trusted-npm-cli-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(npmPublishJob,
    /producer_run_attempt: \$\{\{ steps\.registry\.outputs\.producer_run_attempt \}\}/u);
  assert.match(npmPublishJob,
    /producer_run_id: \$\{\{ steps\.registry\.outputs\.producer_run_id \}\}/u);
  assert.match(publishJob,
    /PUBLISH_PRODUCER_RUN_ATTEMPT: \$\{\{ needs\.npm-publish\.outputs\.producer_run_attempt \}\}/u);
  assert.match(publishJob,
    /PUBLISH_PRODUCER_RUN_ID: \$\{\{ needs\.npm-publish\.outputs\.producer_run_id \}\}/u);
  assert.match(publishJob,
    /PUBLISH_STATE_JSON: \$\{\{ needs\.npm-publish\.outputs\.publish_state \}\}/u);
  assert.match(publishJob, /adoption_run_attempt: \$\{\{ steps\.registry_evidence\.outputs\.adoption_run_attempt \}\}/u);
  assert.match(publishJob, /artifact_name: \$\{\{ steps\.release_handoff\.outputs\.artifact_name \}\}/u);
  assert.match(releaseJob, /name: \$\{\{ needs\.publish\.outputs\.artifact_name \}\}/u);
  assert.match(releaseJob, /ADOPTION_RUN_ATTEMPT: \$\{\{ needs\.publish\.outputs\.adoption_run_attempt \}\}/u);
  assert.match(releaseJob,
    /npm-release-adoption-\$package_id-\$ADOPTION_RUN_ID-\$ADOPTION_RUN_ATTEMPT\.json/u);
  assert.doesNotMatch(releaseJob,
    /npm-release-adoption-\$package_id-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT\.json/u);
  assert.match(policyJob, /evidence_sha256: \$\{\{ steps\.policy\.outputs\.evidence_sha256 \}\}/u);
  assert.match(releaseJob, /POLICY_EVIDENCE_SHA256: \$\{\{ needs\.github-release-policy\.outputs\.evidence_sha256 \}\}/u);
  assert.match(releaseJob, /--verified-immutable-policy-sha256 "\$POLICY_EVIDENCE_SHA256"/u);
  assert.match(releaseJob, /--verified-immutable-policy-run-id "\$GITHUB_RUN_ID"/u);
  assert.match(releaseJob, /--verified-immutable-policy-run-attempt "\$GITHUB_RUN_ATTEMPT"/u);
});

test("release documentation forbids maintainer-created tags", async () => {
  const documentation = await readFile(new URL("../docs/releasing.md", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(documentation, /repository_dispatch/u);
  assert.match(documentation, /exclusive writer/u);
  assert.match(documentation, /pre-publish draft gate can validate only/u);
  assert.match(documentation, /enforced_by_owner: true/u);
  assert.match(documentation, /Re-run all jobs/u);
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
