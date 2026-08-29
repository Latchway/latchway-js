import { readdir, readFile } from "node:fs/promises";

const workflows = new URL("../.github/workflows/", import.meta.url);
const entries = (await readdir(workflows)).filter((name) => /\.ya?ml$/u.test(name)).sort();
if (entries.length === 0) throw new Error("At least one GitHub Actions workflow is required.");

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
  "npm publish \"$RELEASE_TARBALL\" --provenance --access public",
  "node scripts/verify-release-tag.mjs",
  "node scripts/verify-published.mjs",
  "python3 scripts/reconcile-github-release.py",
  "--prepare-draft",
  "--npm-adoption-history",
  "npm-registry-view.json",
  "npm-attestations.json",
  "npm-audit-signatures.json",
  "npm-registry-evidence-manifest.json",
  "actions/attest-build-provenance@",
  "release_state == 'immutable'",
]) {
  if (!release.includes(required)) throw new Error(`release.yml is missing the fail-closed control: ${required}`);
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
  "--draft=false\n      - name:",
]) {
  if (release.includes(forbidden)) throw new Error(`release.yml must not contain ${forbidden}.`);
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
