import { readdir, readFile } from "node:fs/promises";

const expected = new Map([
  ["../dist/index.js", "createLatchwayClient"],
  ["../dist/browser.js", "createBrowserLatchwayClient"],
  ["../dist/node.js", "createNodeLatchwayClient"],
  ["../dist/firebase.js", "createFirebaseAppCheckProvider"],
  ["../dist/turnstile.js", "createTurnstileProvider"],
]);
for (const [relative, symbol] of expected) {
  const module = await import(new URL(relative, import.meta.url));
  if (typeof module[symbol] !== "function") throw new Error(`${relative} does not export ${symbol}.`);
}
for (const entry of await readdir(new URL("../dist", import.meta.url), { recursive: true })) {
  if (!entry.endsWith(".js")) continue;
  const source = await readFile(new URL(`../dist/${entry}`, import.meta.url), "utf8");
  if (/\beval\s*\(|\bnew\s+Function\s*\(/u.test(source)) {
    throw new Error(`${entry} violates strict CSP by evaluating source text.`);
  }
}
