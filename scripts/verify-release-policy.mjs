import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertReleaseCoordinates, verifyAnnotatedReleaseTag } from "./release-policy.mjs";

for (const [tag, version] of [
  ["v0.0.0", "0.0.0"],
  ["v1.2.3", "1.2.3"],
  ["v12.345.6789", "12.345.6789"],
]) {
  assertReleaseCoordinates(tag, version);
}

for (const [tag, version] of [
  ["1.2.3", "1.2.3"],
  ["v1.2.4", "1.2.3"],
  ["v1.2.3-dev.0", "1.2.3-dev.0"],
  ["v1.2.3-alpha", "1.2.3-alpha"],
  ["v1.2.3+build", "1.2.3+build"],
  ["v01.2.3", "01.2.3"],
  ["v1.02.3", "1.02.3"],
  ["v1.2.03", "1.2.03"],
]) {
  expectFailure(() => assertReleaseCoordinates(tag, version));
}

const repository = await mkdtemp(join(tmpdir(), "latchway-release-policy-"));
try {
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Latchway release test"]);
  git(repository, ["config", "user.email", "release-test@latchway.invalid"]);
  git(repository, ["commit", "--allow-empty", "-m", "test: release policy"]);
  const commit = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["update-ref", "refs/remotes/origin/main", commit]);
  git(repository, ["tag", "-a", "v1.2.3", "-m", "Latchway 1.2.3"]);
  git(repository, ["tag", "v1.2.4"]);

  verifyAnnotatedReleaseTag({
    cwd: repository,
    tag: "v1.2.3",
    version: "1.2.3",
    expectedCommit: commit,
    mainRef: "refs/remotes/origin/main",
  });
  expectFailure(() => verifyAnnotatedReleaseTag({
    cwd: repository,
    tag: "v1.2.4",
    version: "1.2.4",
    expectedCommit: commit,
    mainRef: "refs/remotes/origin/main",
  }));
  expectFailure(() => verifyAnnotatedReleaseTag({
    cwd: repository,
    tag: "v1.2.3",
    version: "1.2.3",
    expectedCommit: "0".repeat(40),
    mainRef: "refs/remotes/origin/main",
  }));
} finally {
  await rm(repository, { recursive: true, force: true });
}

function expectFailure(operation) {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error("Expected the release policy to reject invalid input.");
}

function git(cwd, arguments_) {
  return execFileSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
