import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

runPackageScript("build");
const first = await digestTree();
runPackageScript("build");
const second = await digestTree();
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

async function digestTree() {
  const root = new URL("../dist/", import.meta.url);
  const entries = (await readdir(root, { recursive: true })).sort();
  const hash = createHash("sha256");
  const files = [];
  for (const entry of entries) {
    const url = new URL(entry, root);
    try {
      const bytes = await readFile(url);
      hash.update(entry).update("\0").update(bytes).update("\0");
      files.push({
        path: entry,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      if (error?.code !== "EISDIR") throw error;
    }
  }
  return { files, sha256: hash.digest("hex") };
}
