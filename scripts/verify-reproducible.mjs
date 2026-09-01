import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { ROOT_PATH, readReleasePackages } from "./release-utils.mjs";

runPackageScript("build");
const packages = await readReleasePackages();
const first = await digestTrees(packages);
runPackageScript("build");
const second = await digestTrees(packages);
if (JSON.stringify(first) !== JSON.stringify(second)) {
  throw new Error("Two clean builds produced different dist trees.");
}

const artifacts = new URL("../.artifacts/", import.meta.url);
await mkdir(artifacts, { recursive: true });
await writeFile(
  new URL("build-reproducibility.json", artifacts),
  `${JSON.stringify({
    schema_version: 1,
    identical: true,
    package_count: first.package_count,
    sha256: first.sha256,
    files: first.files,
  }, null, 2)}\n`,
  { mode: 0o600 },
);

function runPackageScript(name) {
  const packageManager = process.env.npm_execpath;
  if (packageManager === undefined) throw new Error("Run reproducibility verification through pnpm.");
  if (/\.[cm]?js$/u.test(packageManager)) {
    execFileSync(process.execPath, [packageManager, name], { cwd: new URL("..", import.meta.url), stdio: "inherit" });
  } else {
    execFileSync(packageManager, [name], { cwd: new URL("..", import.meta.url), stdio: "inherit" });
  }
}

async function digestTrees(releasePackages) {
  const hash = createHash("sha256");
  const files = [];
  for (const package_ of releasePackages) {
    const root = join(package_.directory, "dist");
    const entries = (await readdir(root, { recursive: true })).sort();
    for (const entry of entries) {
      const path = join(root, entry);
      try {
        const bytes = await readFile(path);
        const repositoryPath = relative(ROOT_PATH, path).split(sep).join("/");
        hash.update(repositoryPath).update("\0").update(bytes).update("\0");
        files.push({
          package: package_.name,
          path: repositoryPath,
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } catch (error) {
        if (error?.code !== "EISDIR") throw error;
      }
    }
  }
  return { files, package_count: releasePackages.length, sha256: hash.digest("hex") };
}
