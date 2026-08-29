import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { assertReleaseCoordinates, verifyAnnotatedReleaseTag } from "./release-policy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const tag = process.env.EXPECTED_RELEASE_TAG;
const commit = process.env.EXPECTED_SOURCE_COMMIT;

if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "repository_dispatch") {
  throw new Error("Release tags are accepted only from the core promotion dispatch.");
}
if (process.env.GITHUB_REPOSITORY !== "Latchway/latchway-js") {
  throw new Error("Publishing is restricted to the canonical Latchway/latchway-js repository.");
}
if (typeof tag !== "string" || typeof commit !== "string") {
  throw new Error("The promoted release tag and commit are required.");
}
if (process.env.GITHUB_REF_TYPE !== "branch" || process.env.GITHUB_REF_NAME !== "main" ||
    process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_SHA !== commit) {
  throw new Error("The promotion dispatch must run from the exact canonical main commit.");
}

assertReleaseCoordinates(tag, manifest.version);
const result = verifyAnnotatedReleaseTag({
  cwd: root,
  tag,
  version: manifest.version,
  expectedCommit: commit,
  mainRef: "refs/remotes/origin/main",
});

const output = `${JSON.stringify({ schema_version: 1, ...result }, null, 2)}\n`;
if (typeof process.env.RELEASE_TAG_EVIDENCE_PATH === "string") {
  await mkdir(dirname(process.env.RELEASE_TAG_EVIDENCE_PATH), { recursive: true });
  await writeFile(process.env.RELEASE_TAG_EVIDENCE_PATH, output, { mode: 0o600 });
}
process.stdout.write(output);
