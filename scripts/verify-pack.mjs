import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const artifacts = new URL("../.artifacts/", import.meta.url);
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
const packageManager = process.env.npm_execpath;
if (packageManager === undefined) throw new Error("Run package verification through pnpm.");
const argumentsForPack = ["pack", "--pack-destination", ".artifacts"];
if (/\.[cm]?js$/u.test(packageManager)) {
  execFileSync(process.execPath, [packageManager, ...argumentsForPack], { cwd: root, stdio: "inherit" });
} else {
  execFileSync(packageManager, argumentsForPack, { cwd: root, stdio: "inherit" });
}
const archives = (await readdir(artifacts)).filter((name) => name.endsWith(".tgz"));
if (archives.length !== 1) throw new Error("Expected exactly one npm package archive.");
const listing = execFileSync("tar", ["-tzf", new URL(archives[0], artifacts).pathname], { encoding: "utf8" });
for (const required of [
  "package/package.json",
  "package/contract.lock",
  "package/dist/index.js",
  "package/dist/browser.js",
  "package/dist/node.js",
  "package/docs/web-security.md",
  "package/LICENSE",
]) {
  if (!listing.split("\n").includes(required)) throw new Error(`Package archive is missing ${required}.`);
}
if (listing.split("\n").some((entry) => entry.startsWith("package/src/") || entry.startsWith("package/test/"))) {
  throw new Error("Package archive contains development source or tests.");
}
