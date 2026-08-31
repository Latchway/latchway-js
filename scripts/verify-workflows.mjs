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
const continuousIntegration = await readFile(new URL("ci.yml", workflows), "utf8");
const frameworkCompatibility = await readFile(new URL("framework-compatibility.yml", workflows), "utf8");
const releaseDocumentation = await readFile(new URL("../docs/releasing.md", import.meta.url), "utf8");
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
  "Preflight immutable release and create draft with fixed API calls",
  "Reconcile, publish, and verify immutable release with fixed API calls",
  "npm-release-adoption-",
  "npm-registry-view.json",
  "npm-attestations.json",
  "npm-audit-signatures.json",
  "npm-registry-evidence-manifest.json",
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
const oidcJobs = [];
for (const [index, header] of jobHeaders.entries()) {
  const end = jobHeaders[index + 1]?.index ?? release.length;
  const block = release.slice(header.index, end);
  if (block.includes("id-token: write") || block.includes("attestations: write")) {
    oidcJobs.push([header[1], block]);
  }
}
if (oidcJobs.length === 0) throw new Error("release.yml must retain fixed OIDC publication jobs.");
for (const [name, block] of oidcJobs) {
  for (const forbidden of [
    "actions/checkout", "scripts/", "working-directory:", "python3 ", "node ",
    "./gradlew", "npm install", "npm exec",
  ]) {
    if (block.includes(forbidden)) throw new Error(`${name} must not execute candidate source with OIDC permissions.`);
  }
  if (block.includes("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN")) {
    throw new Error(`${name} must not receive the protected immutable-release administration credential.`);
  }
}
const trustedNpmStart = release.indexOf("\n  trusted-npm-cli:\n");
const draftStart = release.indexOf("\n  github-draft:\n");
const npmPublishStart = release.indexOf("\n  npm-publish:\n");
const publishStart = release.indexOf("\n  publish:\n");
if (trustedNpmStart < 0 || draftStart <= trustedNpmStart || npmPublishStart <= draftStart
  || publishStart <= npmPublishStart) {
  throw new Error("release.yml must prepare the trusted npm CLI before the OIDC publication job.");
}
const trustedNpmJob = release.slice(trustedNpmStart, draftStart);
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
  "needs: [promote, verify, trusted-npm-cli, github-draft]",
  "Verify exact npm CLI closure before extraction or execution",
  "closure=(\"$root\"/*)",
  "sha512sum --check --strict",
  "test \"$observed_integrity\" = \"$NPM_CLI_INTEGRITY\"",
  "tar --extract --gzip --file \"$archive\"",
  "\"$LATCHWAY_NPM_CLI\" publish \"$archive\"",
]) {
  if (!npmPublishJob.includes(marker)) throw new Error(`npm-publish is missing ${marker}.`);
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
const releasePolicyStart = release.indexOf("\n  github-release-policy:\n");
const releaseStart = release.indexOf("\n  github-release:\n");
if (releasePolicyStart < 0 || releaseStart <= releasePolicyStart) {
  throw new Error("release.yml must isolate the final immutable-release policy check.");
}
const releasePolicyJob = release.slice(releasePolicyStart, releaseStart);
if (!releasePolicyJob.includes("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN")
  || releasePolicyJob.includes("id-token: write")
  || releasePolicyJob.includes("attestations: write")
  || releasePolicyJob.includes("actions/checkout")
  || releasePolicyJob.includes("scripts/")) {
  throw new Error("The immutable-release administration credential must remain in a fixed no-checkout, no-OIDC job.");
}
const releaseJob = release.slice(releaseStart);
const closureValidation = releaseJob.indexOf("Validate exact JavaScript asset closure before OIDC attestation");
const releaseAttestation = releaseJob.indexOf("Attest exact retained registry and release evidence without candidate checkout");
if (closureValidation < 0 || releaseAttestation <= closureValidation) {
  throw new Error("The exact JavaScript release asset closure must be validated before attestation.");
}
const secretReferences = [...release.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/gu)]
  .map((match) => match[1]);
if (secretReferences.length !== 2 || secretReferences.some((name) =>
  name !== "LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN")) {
  throw new Error("release.yml may use only the protected immutable-release settings credential.");
}
if (!releaseDocumentation.includes("repository_dispatch")
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
