import { execFileSync } from "node:child_process";

const STABLE_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const MAXIMUM_GIT_COMMAND_MILLISECONDS = 20 * 1000;

export function assertReleaseCoordinates(tag, version) {
  if (typeof version !== "string" || version.length > 64 || !STABLE_SEMVER.test(version)) {
    throw new Error("A release package version must be stable X.Y.Z SemVer without a prerelease or build suffix.");
  }
  if (tag !== `v${version}`) {
    throw new Error("The release tag must exactly equal v followed by package.json version.");
  }
  return { tag, version };
}

export function verifyAnnotatedReleaseTag({ cwd, tag, version, expectedCommit, mainRef }) {
  assertReleaseCoordinates(tag, version);
  const tagRef = `refs/tags/${tag}`;
  if (git(cwd, ["cat-file", "-t", tagRef]) !== "tag") {
    throw new Error(`${tagRef} must be an annotated tag object; lightweight tags cannot publish.`);
  }

  const tagCommit = git(cwd, ["rev-parse", `${tagRef}^{commit}`]);
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit) || tagCommit !== expectedCommit) {
    throw new Error("The annotated tag target does not equal the GitHub event commit.");
  }
  const tagMessage = git(cwd, ["for-each-ref", "--format=%(contents)", tagRef]);
  if (tagMessage.length === 0) throw new Error("The annotated release tag must have a message.");

  if (mainRef !== undefined) {
    const mainCommit = git(cwd, ["rev-parse", "--verify", `${mainRef}^{commit}`]);
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", tagCommit, mainCommit], {
        cwd,
        stdio: "ignore",
        timeout: MAXIMUM_GIT_COMMAND_MILLISECONDS,
      });
    } catch {
      throw new Error(`The release commit must be reachable from ${mainRef}.`);
    }
  }

  return { tag, version, commit: tagCommit, annotated: true };
}

function git(cwd, arguments_) {
  try {
    return execFileSync("git", arguments_, {
      cwd,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: MAXIMUM_GIT_COMMAND_MILLISECONDS,
    }).trim();
  } catch {
    throw new Error(`Git release-policy check failed: git ${arguments_.join(" ")}.`);
  }
}
