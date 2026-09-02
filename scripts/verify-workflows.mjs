import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

const workflows = new URL("../.github/workflows/", import.meta.url);
const entries = (await readdir(workflows)).filter((name) => /\.ya?ml$/u.test(name)).sort();
if (entries.length === 0) throw new Error("At least one GitHub Actions workflow is required.");
verifyWorkflowSchema(entries);

const actionReference = /^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#\s*(v[^\s]+))?\s*$/u;
for (const name of entries) {
  const source = await readFile(new URL(name, workflows), "utf8");
  const actionLines = source.split("\n").filter((line) => /^\s*-?\s*uses:/u.test(line));
  for (const line of actionLines) {
    const match = actionReference.exec(line);
    if (match === null) throw new Error(`${name} contains an action reference the pin verifier could not parse.`);
    const reference = match[1];
    const versionComment = match[2];
    if (reference === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u.test(reference)) {
      throw new Error(`${name} contains a GitHub Action that is not pinned to a full immutable SHA.`);
    }
    if (versionComment === undefined || !/^v\d+(?:\.\d+){1,2}$/u.test(versionComment)) {
      throw new Error(`${name} must document the release version beside every pinned Action SHA.`);
    }
  }
}

const release = await readFile(new URL("release.yml", workflows), "utf8");
const singleMaintainerRelease = await readFile(new URL("single-maintainer-release.yml", workflows), "utf8");
const publicCoreVerifier = await readFile(new URL("verify-public-core-release.sh", import.meta.url), "utf8");
const singleMaintainerSurface = singleMaintainerRelease + publicCoreVerifier;
const continuousIntegration = await readFile(new URL("ci.yml", workflows), "utf8");
const frameworkCompatibility = await readFile(new URL("framework-compatibility.yml", workflows), "utf8");
const releaseDocumentation = await readFile(new URL("../docs/releasing.md", import.meta.url), "utf8");
for (const required of [
  "group: javascript-single-maintainer-v1",
  "actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT",
  "bash scripts/verify-public-core-release.sh",
  "compare/$locked_core_commit...$core_commit",
  ".merge_base_commit.sha == $locked",
  "Refuse a new dispatch or rerun-all after any v1 mutation",
  "--signer-workflow \"$core_repository/.github/workflows/single-maintainer-release.yml\"",
  "$core_repository/.github/workflows/release.yml",
  "$core_repository/.github/workflows/deployment-evidence.yml",
  "core-release-gate.json",
  "Stage or adopt exact recoverable transaction draft",
  "EXPECTED_PROVENANCE_EVENT: workflow_dispatch",
  "EXPECTED_PROVENANCE_WORKFLOW_PATH: .github/workflows/single-maintainer-release.yml",
  "node scripts/verify-published.mjs",
  "single-maintainer-npm-adoption.json",
  "Upload or adopt exact bytes then publish once",
  "(.assets | length) == 32",
]) {
  if (!singleMaintainerSurface.includes(required)) {
    throw new Error(`single-maintainer-release.yml is missing the fail-closed control: ${required}`);
  }
}
if ((singleMaintainerRelease.match(/retention-days: 90/gu) ?? []).length !== 4) {
  throw new Error("single-maintainer-release.yml must retain all four transaction artifacts for 90 days.");
}
if (!releaseDocumentation.includes("Re-run failed jobs")
  || !releaseDocumentation.includes("never use **Re-run all jobs**")) {
  throw new Error("Single-maintainer recovery must use only Re-run failed jobs after mutation.");
}
for (const forbidden of ["--clobber", "secrets.NPM_TOKEN", "secrets.NODE_AUTH_TOKEN"]) {
  if (singleMaintainerRelease.includes(forbidden)) {
    throw new Error(`single-maintainer-release.yml must not contain ${forbidden}.`);
  }
}
const singleDraft = singleMaintainerRelease.indexOf("Stage or adopt exact recoverable transaction draft");
const singleNpm = singleMaintainerRelease.indexOf('"$LATCHWAY_NPM_CLI" publish "$archive"');
const singleRegistryGate = singleMaintainerRelease.indexOf("node scripts/verify-published.mjs");
const singleFinalize = singleMaintainerRelease.indexOf("Upload or adopt exact bytes then publish once");
if (!(singleDraft >= 0 && singleDraft < singleNpm && singleNpm < singleRegistryGate
  && singleRegistryGate < singleFinalize)) {
  throw new Error("The single-maintainer transaction must stage, publish, verify, then finalize in order.");
}
const singleSentinel = "    steps:\n"
  + "      - name: Require exact single-maintainer-v1 environment policy sentinel\n"
  + "        shell: bash\n"
  + "        env:\n"
  + "          EXPECTED_POLICY_ID: latchway-release-controls-v1:latchway-js:single-maintainer-v1\n"
  + "          OBSERVED_POLICY_ID: ${{ vars.LATCHWAY_RELEASE_CONTROL_POLICY_ID }}\n"
  + "        run: |\n"
  + "          set -Eeuo pipefail\n"
  + "          test \"$OBSERVED_POLICY_ID\" = \"$EXPECTED_POLICY_ID\"\n";
const singleJobHeaders = [...singleMaintainerRelease.matchAll(/^ {2}([a-z0-9_-]+):$/gmu)];
let protectedSingleJobs = 0;
for (const [index, header] of singleJobHeaders.entries()) {
  const end = singleJobHeaders[index + 1]?.index ?? singleMaintainerRelease.length;
  const block = singleMaintainerRelease.slice(header.index, end);
  if (!block.includes("    environment: single-maintainer-v1\n")) continue;
  protectedSingleJobs += 1;
  if (block.indexOf(singleSentinel) !== block.indexOf("    steps:\n")) {
    throw new Error(`${header[1]} must check the exact single-maintainer environment sentinel first.`);
  }
}
if (protectedSingleJobs !== 5) {
  throw new Error("Exactly five single-maintainer jobs must use the protected environment sentinel.");
}
for (const required of [
  "repository_dispatch:",
  "latchway_release_promoted",
  "gh attestation verify",
  "--signer-workflow Latchway/latchway/.github/workflows/cross-repository-conformance.yml",
  "--source-ref refs/heads/main",
  "sha256sum --check --strict",
  "python3 scripts/verify-release-promotion.py",
  "id-token: write",
  "environment: npm",
  "environment: release-administration",
  "environment: github-release",
  "persist-credentials: false",
  "\"$LATCHWAY_NPM_CLI\" publish \"$archive\" --provenance --access public",
  "Prepare exact trusted-publishing npm CLI without credentials",
  "Download and authenticate npm CLI without lifecycle scripts",
  "Verify exact npm CLI closure before extraction or execution",
  "NPM_CONFIG_IGNORE_SCRIPTS",
  "sha512-7iKzNfy8lWYs3zq4oFPa8EXZz5xt9gQNKJZau3B1ErLBb6bF7sBJ00x09485DOvRT2l5Gerbl3VlZNT57MxJVA==",
  "NPM_CLI_SHA256: 585f95094ee5cb2788ee11d90f2a518a7c9ef6e083fa141d0b63ca3383675a20",
  "NPM_CLI_SHA512: ee22b335fcbc95662cdf3ab8a053daf045d9cf9c6df6040d28965abb707512b2c16fa6c5eec049d34c74f78f390cebd14f697919eadb97756564d4f9eccc4954",
  "node scripts/verify-release-tag.mjs",
  "node scripts/verify-published.mjs",
  "Verify immutable-release administration policy with the narrow token",
  "Create or verify GitHub draft with fixed API calls",
  "Reconcile, publish, and verify the immutable release with the fixed handoff",
  "npm-release-adoption-",
  "npm-$package_id-registry-version.json",
  "npm-$package_id-registry-view.json",
  "npm-$package_id-attestations.json",
  "npm-$package_id-audit-signatures.json",
  "npm-registry-evidence-manifest.json",
  "latchway-client-$RELEASE_VERSION.tgz",
  "latchway-openai-$RELEASE_VERSION.tgz",
  "latchway-vercel-ai-$RELEASE_VERSION.tgz",
  "latchway-langchain-$RELEASE_VERSION.tgz",
  "dependency-vulnerability-scan.json",
  "PUBLISH_STATE_JSON",
  "docs-bundle-$RELEASE_VERSION.tar.gz",
  "actions/attest-build-provenance@",
  "RELEASE_STATE",
  "NPM_CONFIG_CACHE=$RUNNER_TEMP/latchway-npm-cache",
  "NPM_CONFIG_USERCONFIG=$RUNNER_TEMP/latchway-release.npmrc",
  "node scripts/prepare-verification-runtime.mjs",
]) {
  if (!release.includes(required)) throw new Error(`release.yml is missing the fail-closed control: ${required}`);
}
for (const [name, source] of [["ci.yml", continuousIntegration], ["release.yml", release]]) {
  if (!source.includes("node scripts/install-actionlint.mjs")) {
    throw new Error(`${name} must install the pinned workflow-schema validator before release verification.`);
  }
}
for (const [name, source] of [["ci.yml", continuousIntegration], ["release.yml", release]]) {
  for (const required of [
    "pnpm exec playwright install --with-deps chromium firefox webkit",
    "pnpm release:check",
  ]) {
    if (!source.includes(required)) {
      throw new Error(`${name} is missing the browser release gate control: ${required}`);
    }
  }
}
for (const required of [
  "path: .artifacts/",
  "if-no-files-found: error",
  "include-hidden-files: true",
]) {
  if (!continuousIntegration.includes(required)) {
    throw new Error(`ci.yml is missing the hidden evidence-upload control: ${required}`);
  }
}
for (const required of [
  "profile: [minimum, latest]",
  "pnpm framework:verify-profile ${{ matrix.profile }}",
  "pnpm framework:install-profile newest-compatible",
  "if: github.event_name == 'schedule'",
  "issues: write",
  "needs.newest-compatible.result == 'failure'",
  "Open at most one active compatibility issue",
  "No supported range was widened",
  "persist-credentials: false",
]) {
  if (!frameworkCompatibility.includes(required)) {
    throw new Error(`framework-compatibility.yml is missing the fail-closed control: ${required}`);
  }
}
for (const forbidden of [
  "pull_request_target",
  "contents: write",
  "packages: write",
  "workflow_run",
  "pnpm update",
]) {
  if (frameworkCompatibility.includes(forbidden)) {
    throw new Error(`framework-compatibility.yml must not contain ${forbidden}.`);
  }
}
const issueJobStart = frameworkCompatibility.indexOf("\n  report-newest-failure:\n");
if (issueJobStart < 0) throw new Error("framework-compatibility.yml omitted the isolated issue job.");
const issueJob = frameworkCompatibility.slice(issueJobStart);
for (const forbidden of ["actions/checkout", "pnpm ", "node ", "scripts/"]) {
  if (issueJob.includes(forbidden)) {
    throw new Error(`The framework issue job must not execute candidate source through ${forbidden}.`);
  }
}
for (const forbidden of [
  "\n  push:",
  "\n    tags:",
  "GITHUB_EVENT_NAME=push",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "workflow_dispatch",
  "pull_request_target",
  "--clobber",
  "python3 scripts/reconcile-github-release.py",
  "--draft=false\n      - name:",
  "npm install --global npm@11.6.2",
]) {
  if (release.includes(forbidden)) throw new Error(`release.yml must not contain ${forbidden}.`);
}
const jobHeaders = [...release.matchAll(/^ {2}([a-z0-9_-]+):$/gmu)];
const expectedReleaseEnvironments = new Map([
  ["promote", "github-release"],
  ["authorize-release", "release-administration"],
  ["github-draft", "github-release"],
  ["npm-publish", "npm"],
  ["publish", "npm"],
  ["github-release-policy", "release-administration"],
  ["github-release", "github-release"],
]);
const releaseJobs = new Map();
const oidcJobs = [];
for (const [index, header] of jobHeaders.entries()) {
  const end = jobHeaders[index + 1]?.index ?? release.length;
  const block = release.slice(header.index, end);
  releaseJobs.set(header[1], block);
  const environmentMatches = [...block.matchAll(/^ {4}environment: ([a-z0-9-]+)$/gmu)];
  const expectedEnvironment = expectedReleaseEnvironments.get(header[1]);
  if (expectedEnvironment === undefined) {
    if (environmentMatches.length !== 0) {
      throw new Error(`${header[1]} must not receive protected release-environment authority.`);
    }
  } else if (environmentMatches.length !== 1 || environmentMatches[0]?.[1] !== expectedEnvironment) {
    throw new Error(`${header[1]} must use only the ${expectedEnvironment} environment.`);
  }
  if (block.includes("id-token: write") || block.includes("attestations: write")) {
    oidcJobs.push([header[1], block]);
  }
}
const expectedPolicySentinels = new Map([
  ["promote", "latchway-release-controls-v1:latchway-js:github-release"],
  ["authorize-release", "latchway-release-controls-v1:latchway-js:release-administration"],
  ["github-draft", "latchway-release-controls-v1:latchway-js:github-release"],
  ["npm-publish", "latchway-release-controls-v1:latchway-js:npm"],
  ["publish", "latchway-release-controls-v1:latchway-js:npm"],
  ["github-release-policy", "latchway-release-controls-v1:latchway-js:release-administration"],
  ["github-release", "latchway-release-controls-v1:latchway-js:github-release"],
]);
for (const [jobName, policyId] of expectedPolicySentinels) {
  const block = releaseJobs.get(jobName);
  if (block === undefined) throw new Error(`release.yml omitted protected job ${jobName}.`);
  const environment = expectedReleaseEnvironments.get(jobName);
  const sentinelPrefix = `    steps:\n      - name: Require exact ${environment} environment policy sentinel\n`
    + "        shell: bash\n"
    + "        env:\n"
    + `          EXPECTED_POLICY_ID: ${policyId}\n`
    + "          OBSERVED_POLICY_ID: ${{ vars.LATCHWAY_RELEASE_CONTROL_POLICY_ID }}\n"
    + "        run: |\n"
    + "          set -Eeuo pipefail\n"
    + '          test "$OBSERVED_POLICY_ID" = "$EXPECTED_POLICY_ID"\n';
  if (!block.includes(sentinelPrefix)) {
    throw new Error(`${jobName} must begin with its exact environment-scoped release-control sentinel.`);
  }
  const stepsStart = block.indexOf("    steps:\n");
  if (stepsStart < 0 || block.indexOf(sentinelPrefix) !== stepsStart) {
    throw new Error(`${jobName} must run its release-control sentinel as the first step.`);
  }
  const sentinelEnd = stepsStart + sentinelPrefix.length;
  for (const authority of ["secrets.", "secrets[", "github.token",
    "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) {
    const authorityIndex = block.indexOf(authority);
    if (authorityIndex >= 0 && authorityIndex < sentinelEnd) {
      throw new Error(`${jobName} must not resolve ${authority} before its policy sentinel.`);
    }
  }
  if (/^ {4}(?:container|services):/mu.test(block)) {
    throw new Error(`${jobName} must not start a job container or service before its policy sentinel.`);
  }
  const nextStep = block.indexOf("      - ", stepsStart + sentinelPrefix.length);
  const sentinelBlock = block.slice(stepsStart, nextStep < 0 ? block.length : nextStep);
  for (const forbidden of ["uses:", "secrets.", "secrets[", "github.token", "id-token:", "GH_TOKEN"] ) {
    if (sentinelBlock.includes(forbidden)) {
      throw new Error(`${jobName} sentinel must not access authority through ${forbidden}.`);
    }
  }
}
if ((release.match(/\$\{\{\s*vars\.LATCHWAY_RELEASE_CONTROL_POLICY_ID\s*\}\}/gu) ?? []).length
    !== expectedPolicySentinels.size
  || /vars\s*\[\s*["']LATCHWAY_RELEASE_CONTROL_POLICY_ID["']\s*\]/u.test(release)
  || /(?:env|github|secrets)\.LATCHWAY_RELEASE_CONTROL_POLICY_ID/u.test(release)) {
  throw new Error("Protected jobs must consume only the exact environment policy variable expression.");
}
if (oidcJobs.length === 0) throw new Error("release.yml must retain fixed OIDC publication jobs.");
for (const [name, block] of oidcJobs) {
  const forbiddenControls = [
    "actions/checkout", "scripts/", "working-directory:", "node ",
    "./gradlew", "npm install", "npm exec",
  ];
  if (name !== "github-release") forbiddenControls.push("python3 ");
  for (const forbidden of forbiddenControls) {
    if (block.includes(forbidden)) throw new Error(`${name} must not execute candidate source with OIDC permissions.`);
  }
  if (block.includes("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN")) {
    throw new Error(`${name} must not receive the protected immutable-release administration credential.`);
  }
  if (name === "github-release") {
    for (const required of [
      "trusted-github-release-reconciler",
      "GITHUB_RELEASE_RECONCILER_SHA256",
      "GITHUB_RELEASE_VERSION_CHECK_SHA256",
      "sha256sum --check --strict",
      'python3 "$reconciler"',
      "--verified-immutable-policy-sha256",
    ]) {
      if (!block.includes(required)) {
        throw new Error(`github-release must authenticate the fixed reconciler through ${required}.`);
      }
    }
  }
}
const trustedNpmStart = release.indexOf("\n  trusted-npm-cli:\n");
const authorizeReleaseStart = release.indexOf("\n  authorize-release:\n");
const draftStart = release.indexOf("\n  github-draft:\n");
const npmPublishStart = release.indexOf("\n  npm-publish:\n");
const publishStart = release.indexOf("\n  publish:\n");
if (trustedNpmStart < 0 || authorizeReleaseStart <= trustedNpmStart
  || draftStart <= authorizeReleaseStart || npmPublishStart <= draftStart
  || publishStart <= npmPublishStart) {
  throw new Error("release.yml must prepare the trusted npm CLI before the OIDC publication job.");
}
const trustedNpmJob = release.slice(trustedNpmStart, authorizeReleaseStart);
const authorizeReleaseJob = release.slice(authorizeReleaseStart, draftStart);
const draftJob = release.slice(draftStart, npmPublishStart);
const npmPublishJob = release.slice(npmPublishStart, publishStart);
for (const marker of [
  "permissions: {}",
  "NPM_CONFIG_IGNORE_SCRIPTS: \"true\"",
  "curl --proto '=https' --proto-redir '=https' --tlsv1.2",
  "--max-filesize 3145728",
  "sha256sum --check --strict",
  "sha512sum --check --strict",
  "gzip --test",
  "Transfer exact npm CLI tarball as inert data",
]) {
  if (!trustedNpmJob.includes(marker)) throw new Error(`trusted-npm-cli is missing ${marker}.`);
}
for (const forbidden of [
  "actions/checkout", "secrets.", "github.token", "id-token:", "attestations:",
  "npm install", "npm exec",
]) {
  if (trustedNpmJob.includes(forbidden)) throw new Error(`trusted-npm-cli must not contain ${forbidden}.`);
}
if (/(?:^|\n)\s*npx\s/u.test(trustedNpmJob)) {
  throw new Error("trusted-npm-cli must not execute npx.");
}
for (const marker of [
  "environment: release-administration",
  "permissions: {}",
  "needs: [promote, verify, trusted-npm-cli]",
  "LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN",
  ".enforced_by_owner == true",
  "latchway_github_immutable_release_policy_lease",
  '--arg phase "draft-and-npm-publication"',
  "prepublication-policy-%s-%s",
  "evidence_sha256: ${{ steps.policy.outputs.evidence_sha256 }}",
]) {
  if (!authorizeReleaseJob.includes(marker)) {
    throw new Error(`authorize-release is missing the isolated administration control: ${marker}`);
  }
}
for (const forbidden of [
  "actions/checkout", "scripts/", "github.token", "contents: write", "id-token:",
  "attestations:", "RELEASE_TOKEN",
]) {
  if (authorizeReleaseJob.includes(forbidden)) {
    throw new Error(`authorize-release must not contain ${forbidden}.`);
  }
}
for (const marker of [
  "environment: github-release",
  "needs: [promote, verify, authorize-release]",
  "actions: read",
  "contents: write",
  "RELEASE_TOKEN: ${{ github.token }}",
  "Create or verify GitHub draft with fixed API calls",
  "Download attempt-bound pre-publication policy lease",
  "Validate exact pre-publication policy lease before release inspection",
]) {
  if (!draftJob.includes(marker)) throw new Error(`github-draft is missing ${marker}.`);
}
if (draftJob.includes("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN")
  || draftJob.includes("environment: npm")
  || draftJob.includes("environment: release-administration")) {
  throw new Error("github-draft must receive only GitHub release authority after administration approval.");
}
const draftLeaseDownload = draftJob.indexOf("Download attempt-bound pre-publication policy lease");
const draftLeaseValidation = draftJob.indexOf(
  "Validate exact pre-publication policy lease before release inspection",
);
const draftInspection = draftJob.indexOf("Create or verify GitHub draft with fixed API calls");
const draftMutation = draftJob.indexOf('gh release create "$RELEASE_TAG"');
const draftPolicyRecheck = draftJob.lastIndexOf(
  'policy_root="$RUNNER_TEMP/prepublication-policy"',
  draftMutation,
);
if (draftLeaseDownload < 0 || draftLeaseValidation <= draftLeaseDownload
  || draftInspection <= draftLeaseValidation || draftMutation <= draftInspection
  || draftPolicyRecheck <= draftInspection || draftPolicyRecheck >= draftMutation) {
  throw new Error("github-draft must validate and freshly recheck its lease before draft mutation.");
}
for (const marker of [
  '(keys | sort) == ["expires_at", "issued_at", "kind", "phase", "repository",',
  '.kind == "latchway_github_immutable_release_policy_lease"',
  '.repository == $repository and .phase == $phase',
  '.run_id == $run_id and .run_attempt == $run_attempt',
  '(.expires_at - .issued_at) == 600',
  '.issued_at <= $now and $now < .expires_at',
  '.settings.enabled == true and .settings.enforced_by_owner == true',
  'printf \'%s  %s\\n\' "$POLICY_EVIDENCE_SHA256" "$policy" | sha256sum --check --strict',
]) {
  if ((draftJob.split(marker).length - 1) < 2 || (npmPublishJob.split(marker).length - 1) < 2) {
    throw new Error(`Draft and npm publication must each validate and recheck lease control ${marker}.`);
  }
}
const publishJob = release.slice(publishStart, release.indexOf("\n  github-release-policy:\n"));
for (const marker of [
  "name: Generate and stage npm registry evidence without OIDC",
  "node scripts/prepare-verification-runtime.mjs",
  "node scripts/verify-published.mjs",
]) {
  if (!publishJob.includes(marker)) throw new Error(`tokenless registry-evidence job is missing ${marker}.`);
}
for (const forbidden of [
  "id-token: write", "attestations: write", "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "node scripts/prepare-publish-runtime.mjs",
]) {
  if (publishJob.includes(forbidden)) {
    throw new Error(`tokenless registry-evidence job must not contain ${forbidden}.`);
  }
}
for (const marker of [
  "needs: [promote, verify, trusted-npm-cli, authorize-release, github-draft]",
  "environment: npm",
  "Download attempt-bound pre-publication policy lease",
  "Validate exact pre-publication policy lease before publication setup",
  "Verify exact npm CLI closure before extraction or execution",
  "closure=(\"$root\"/*)",
  "sha512sum --check --strict",
  "test \"$observed_integrity\" = \"$NPM_CLI_INTEGRITY\"",
  "tar --extract --gzip --file \"$archive\"",
  "archive_sha1=$(sha1sum \"$archive\"",
  ".sha256 == $sha256 and .sha512 == $sha512 and .integrity == $integrity",
  "\"$LATCHWAY_NPM_CLI\" publish \"$archive\"",
  "--registry=https://registry.npmjs.org/",
  "--@latchway:registry=https://registry.npmjs.org/",
  "package_names=('@latchway/client' '@latchway/openai' '@latchway/vercel-ai' '@latchway/langchain')",
  "publish_required=()",
  "publish_state=$(jq --compact-output",
]) {
  if (!npmPublishJob.includes(marker)) throw new Error(`npm-publish is missing ${marker}.`);
}
if (!publishJob.includes("environment: npm")) {
  throw new Error("tokenless registry-evidence generation must remain protected by the npm environment.");
}
const cliClosure = npmPublishJob.indexOf("Verify exact npm CLI closure before extraction or execution");
const cliExtraction = npmPublishJob.indexOf("tar --extract --gzip --file \"$archive\"");
const cliExecution = npmPublishJob.indexOf("test \"$(\"$cli\" --version)\"");
if (cliClosure < 0 || cliExtraction <= cliClosure || cliExecution <= cliExtraction) {
  throw new Error("The OIDC job must authenticate the npm CLI closure before extraction and execution.");
}
if (npmPublishJob.includes("npm install") || npmPublishJob.includes("npm exec")
  || /(?:^|\n)\s*npx\s/u.test(npmPublishJob)) {
  throw new Error("The OIDC npm publication job must never live-install executable tooling.");
}
const registryPreflight = npmPublishJob.indexOf("publish_required=()");
const preflightCompletion = npmPublishJob.indexOf("publish_state='{}'", registryPreflight);
const registryMutation = npmPublishJob.indexOf('"$LATCHWAY_NPM_CLI" publish "$archive"');
const registryPolicyRecheck = npmPublishJob.lastIndexOf(
  'policy_root="$RUNNER_TEMP/prepublication-policy"',
  registryMutation,
);
const npmAttestationPolicy = npmPublishJob.indexOf(
  "Recheck fresh pre-publication policy before npm provenance attestation",
);
const npmAttestation = npmPublishJob.indexOf(
  "Attest reviewed npm package set and reproducibility inputs without candidate checkout",
);
const npmPolicyNextStep = npmPublishJob.indexOf("\n      - ", npmAttestationPolicy + 1);
if (
  registryPreflight < 0
  || preflightCompletion <= registryPreflight
  || registryMutation <= preflightCompletion
  || registryPolicyRecheck <= preflightCompletion
  || registryPolicyRecheck >= registryMutation
  || npmAttestationPolicy < 0
  || npmAttestation <= npmAttestationPolicy
  || npmPolicyNextStep + "\n      - name: ".length !== npmAttestation
  || (npmPublishJob.slice(registryPreflight).match(
    /for index in "\$\{!package_names\[@\]\}"; do/gu,
  ) ?? []).length !== 2
) {
  throw new Error("The OIDC npm job must preflight the complete package set before its first registry mutation.");
}
for (const packageName of ["@latchway/client", "@latchway/openai", "@latchway/vercel-ai", "@latchway/langchain"]) {
  if (!npmPublishJob.includes(packageName)) {
    throw new Error(`The OIDC npm job does not bind ${packageName}.`);
  }
}
const releasePolicyStart = release.indexOf("\n  github-release-policy:\n");
const releaseStart = release.indexOf("\n  github-release:\n");
if (releasePolicyStart < 0 || releaseStart <= releasePolicyStart) {
  throw new Error("release.yml must isolate the final immutable-release policy check.");
}
const releasePolicyJob = release.slice(releasePolicyStart, releaseStart);
if (!releasePolicyJob.includes("environment: release-administration")
  || !releasePolicyJob.includes("permissions: {}")
  || !releasePolicyJob.includes("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN")
  || releasePolicyJob.includes("id-token: write")
  || releasePolicyJob.includes("attestations: write")
  || releasePolicyJob.includes("actions/checkout")
  || releasePolicyJob.includes("scripts/")) {
  throw new Error("The immutable-release administration credential must remain in a fixed no-checkout, no-OIDC job.");
}
for (const marker of [
  '.enforced_by_owner == true',
  'test "$GITHUB_RELEASE_POLICY_TTL_SECONDS" = 600',
  'schema_version: 2',
  'run_id: $run_id',
  'run_attempt: $run_attempt',
  'issued_at: $issued_at',
  'expires_at: $expires_at',
]) {
  if (!releasePolicyJob.includes(marker)) {
    throw new Error(`The immutable-release policy handoff is missing ${marker}.`);
  }
}
const releaseJob = release.slice(releaseStart);
if (!releaseJob.includes("environment: github-release")
  || releaseJob.includes("environment: npm")
  || releaseJob.includes("environment: release-administration")) {
  throw new Error("The final GitHub release must use only the github-release environment.");
}
const closureValidation = releaseJob.indexOf("Validate exact JavaScript asset closure before OIDC attestation");
const finalPolicyValidation = releaseJob.indexOf("Validate fresh final policy before OIDC attestation");
const releaseAttestation = releaseJob.indexOf("Attest exact retained registry and release evidence without candidate checkout");
const finalPolicyNextStep = releaseJob.indexOf("\n      - ", finalPolicyValidation + 1);
if (closureValidation < 0 || finalPolicyValidation <= closureValidation
  || releaseAttestation <= finalPolicyValidation
  || finalPolicyNextStep + "\n      - name: ".length !== releaseAttestation) {
  throw new Error("The exact asset closure and fresh final policy must be validated immediately before attestation.");
}
for (const marker of [
  'test -z "$(find "$policy_root" -mindepth 1 ! -path "$policy" -print -quit)"',
  '(keys | sort) == ["expires_at", "issued_at", "kind", "repository",',
  '.kind == "latchway_github_immutable_release_policy"',
  '.repository == $repository and',
  '.run_id == $run_id and .run_attempt == $run_attempt',
  '(.expires_at - .issued_at) == 600',
  '.issued_at <= $now and $now < .expires_at',
  '.settings.enabled == true and .settings.enforced_by_owner == true',
]) {
  if (!releaseJob.slice(finalPolicyValidation, releaseAttestation).includes(marker)) {
    throw new Error(`The pre-attestation final-policy check is missing ${marker}.`);
  }
}
for (const marker of [
  "test \"${#expected[@]}\" = 35",
  "test \"${#adoption_assets[@]}\" = 4",
  "package_ids=(client openai vercel-ai langchain)",
  'python3 "$reconciler"',
]) {
  if (!releaseJob.includes(marker)) throw new Error(`The final JavaScript release closure is missing ${marker}.`);
}
if ((release.match(/if: needs\.github-draft\.outputs\.release_state == 'draft'/gu) ?? []).length !== 2) {
  throw new Error("Artifact attestations must be skipped on immutable read-only release retries.");
}
if (/all\([^;\n]+\s+as\s+\$[A-Za-z_][A-Za-z0-9_]*\s*;/u.test(releaseJob)) {
  throw new Error("Release jq all(generator; condition) expressions use invalid generator bindings.");
}
for (const [producer, consumer, output] of [
  [release.slice(release.indexOf("\n  authorize-promotion:\n"), release.indexOf("\n  verify-promotion:\n")),
    release.slice(release.indexOf("\n  verify-promotion:\n"), release.indexOf("\n  promote:\n")),
    "report_artifact_name"],
  [trustedNpmJob, npmPublishJob, "artifact_name"],
  [publishJob, releaseJob, "artifact_name"],
]) {
  if (!producer.includes(`${output}: \${{ steps.`)
    || !consumer.includes(`outputs.${output} }}`)) {
    throw new Error(`Release handoff ${output} must be bound to its successful producer job output.`);
  }
}
for (const marker of [
  "adoption_run_id: ${{ steps.registry_evidence.outputs.adoption_run_id }}",
  "adoption_run_attempt: ${{ steps.registry_evidence.outputs.adoption_run_attempt }}",
  "PUBLISH_PRODUCER_RUN_ID: ${{ needs.npm-publish.outputs.producer_run_id }}",
  "PUBLISH_PRODUCER_RUN_ATTEMPT: ${{ needs.npm-publish.outputs.producer_run_attempt }}",
]) {
  if (!publishJob.includes(marker)) throw new Error(`publish must export retry-stable ${marker}.`);
}
for (const marker of [
  "ADOPTION_RUN_ID: ${{ needs.publish.outputs.adoption_run_id }}",
  "ADOPTION_RUN_ATTEMPT: ${{ needs.publish.outputs.adoption_run_attempt }}",
  "POLICY_EVIDENCE_SHA256: ${{ needs.github-release-policy.outputs.evidence_sha256 }}",
  '--verified-immutable-policy-run-id "$GITHUB_RUN_ID"',
  '--verified-immutable-policy-run-attempt "$GITHUB_RUN_ATTEMPT"',
]) {
  if (!releaseJob.includes(marker)) throw new Error(`github-release must consume producer binding ${marker}.`);
}
if (releaseJob.includes(
  "npm-release-adoption-$package_id-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.json",
)) {
  throw new Error("github-release must not reinterpret producer adoption evidence as the consumer retry attempt.");
}
if (/secrets\s*\[/u.test(release)) {
  throw new Error("release.yml must not use bracket syntax for secret references.");
}
const expectedSecretReferences = new Map([
  ["authorize-release", ["LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN"]],
  ["github-release-policy", ["LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN"]],
]);
const expectedSecretExpressions = new Map([
  ["authorize-release", ["${{ secrets.LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN }}"]],
  ["github-release-policy", ["${{ secrets.LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN }}"]],
]);
for (const [jobName, block] of releaseJobs) {
  const observed = [...block.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/gu)]
    .map((match) => match[1]);
  const expected = expectedSecretReferences.get(jobName) ?? [];
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(`${jobName} has an unexpected secret reference allowlist: ${observed.join(", ")}.`);
  }
  const observedExpressions = [...block.matchAll(/\$\{\{[^}\n]*secrets[^}\n]*\}\}/gu)]
    .map((match) => match[0]);
  const expectedExpressions = expectedSecretExpressions.get(jobName) ?? [];
  if (JSON.stringify(observedExpressions) !== JSON.stringify(expectedExpressions)) {
    throw new Error(`${jobName} has an unexpected secret expression or credential fallback.`);
  }
}
if (!releaseDocumentation.includes("repository_dispatch")
  || !releaseDocumentation.includes("exclusive writer")
  || !releaseDocumentation.includes("pre-publish draft gate can validate only")
  || !releaseDocumentation.includes("enforced_by_owner: true")
  || !releaseDocumentation.includes("`release-administration`")
  || !releaseDocumentation.includes("`github-release`")
  || !releaseDocumentation.includes("Do not duplicate")
  || !releaseDocumentation.includes("`prevent_self_review: true`")
  || !releaseDocumentation.includes("administrator bypass")
  || !releaseDocumentation.includes("Do not define that variable at repository or organization scope")
  || !releaseDocumentation.includes("latchway-release-controls-v1:latchway-js:release-administration")
  || !releaseDocumentation.includes("latchway-release-controls-v1:latchway-js:github-release")
  || !releaseDocumentation.includes("latchway-release-controls-v1:latchway-js:npm")
  || !releaseDocumentation.includes("exactly 600 seconds")
  || !releaseDocumentation.includes("Re-run all jobs")
  || !releaseDocumentation.toLowerCase().includes("tag manually")
  || /\n(?:git tag|git push)\s/u.test(releaseDocumentation)) {
  throw new Error("Release documentation must delegate tag creation to the verified promotion dispatch.");
}

function verifyWorkflowSchema(names) {
  const executable = process.env.ACTIONLINT ?? "actionlint";
  const options = {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1_048_576,
    shell: false,
  };
  const version = spawnSync(executable, ["-version"], options);
  if (version.error !== undefined || version.status !== 0 || version.signal !== null) {
    throw new Error("actionlint v1.7.12 is required; run this gate through the pinned mise toolchain.");
  }
  if (version.stdout.split(/\r?\n/u, 1)[0] !== "1.7.12") {
    throw new Error(`Workflow validation requires actionlint 1.7.12, received ${version.stdout.trim()}.`);
  }
  const validation = spawnSync(executable, [
    "-shellcheck=",
    "-pyflakes=",
    "-oneline",
    ...names.map((name) => `.github/workflows/${name}`),
  ], options);
  if (validation.error !== undefined || validation.status !== 0 || validation.signal !== null) {
    const diagnostics = `${validation.stdout ?? ""}${validation.stderr ?? ""}`.trim();
    throw new Error(`GitHub Actions schema validation failed${diagnostics.length === 0 ? "." : `:\n${diagnostics}`}`);
  }
}
