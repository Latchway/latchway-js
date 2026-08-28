import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ARTIFACTS_PATH, fetchJSON, packageVersionURL, readRootManifest } from "./release-utils.mjs";

const manifest = await readRootManifest();
const evidence = JSON.parse(await readFile(join(ARTIFACTS_PATH, "package-evidence.json"), "utf8"));
const { response, value } = await fetchJSON(packageVersionURL(manifest.name, manifest.version), {
  maximumBytes: 2 * 1024 * 1024,
});

let publishRequired;
if (response.status === 404) {
  publishRequired = true;
} else if (response.status === 200) {
  if (value.name !== manifest.name || value.version !== manifest.version ||
      value.dist?.integrity !== evidence.integrity || value.dist?.shasum !== evidence.sha1) {
    throw new Error("This npm version already exists but does not match the verified release archive.");
  }
  publishRequired = false;
} else {
  throw new Error(`npm registry availability check failed with HTTP ${response.status}.`);
}

const output = `publish_required=${String(publishRequired)}\n`;
if (typeof process.env.GITHUB_OUTPUT === "string") {
  await appendFile(process.env.GITHUB_OUTPUT, output, { mode: 0o600 });
} else {
  process.stdout.write(output);
}
