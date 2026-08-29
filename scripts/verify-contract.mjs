import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const expected = {
  contract: "0.5.1",
  commit: "2f5e5e67c824e270431f1232cc6dc2824848e380",
  bundle: "52ebacd1e38c522b89bb14a1f34782176be32cdf91d22b7ab962003dbca2d754",
  protocol: 1,
  minimumServer: "1.0.0",
  maximumTestedServer: "1.0.x",
};
const expectedLock = `contract_version: ${expected.contract}
core_release: v1.0.0
core_commit: ${expected.commit}
bundle_sha256: "${expected.bundle}"
minimum_server_version: ${expected.minimumServer}
maximum_tested_server_version: ${expected.maximumTestedServer}
wire_protocol_version: ${expected.protocol}
`;
const fixtureHashes = new Map([
  ["attestation-binding-v1.json", "e24ec75cc37b331060c67637fe3a4421c644e354fe73b9049b652d61a9e2896b"],
  ["dpop-v1.json", "d14702db02a4498e8d52b5b39d5bc25d141dcf87ea4f7c4aeb929fd191eb8101"],
  ["protocol-version.json", "c469ab7c23c78dc5de2430bdc1d524268afe400f7af7eb8efb36b1c5d739fd51"],
]);

const lock = await readFile(new URL("../contract.lock", import.meta.url), "utf8");
if (lock !== expectedLock) {
  throw new Error("contract.lock must byte-for-byte match the reviewed core contract pin.");
}

const verifiedFixtures = [];
for (const [name, expectedHash] of fixtureHashes) {
  const bytes = await readFile(new URL(`../test/fixtures/contract/${name}`, import.meta.url));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedHash) throw new Error(`${name} does not match the pinned core contract.`);
  verifiedFixtures.push({ name, sha256: actual });
}
const protocol = JSON.parse(await readFile(new URL("../test/fixtures/contract/protocol-version.json", import.meta.url), "utf8"));
if (protocol.contract_version !== expected.contract || protocol.wire_protocol.current !== expected.protocol) {
  throw new Error("The vendored protocol manifest is incompatible with contract.lock.");
}

const artifacts = new URL("../.artifacts/", import.meta.url);
await mkdir(artifacts, { recursive: true });
await writeFile(
  new URL("contract-evidence.json", artifacts),
  `${JSON.stringify({
    schema_version: 1,
    contract_version: expected.contract,
    core_commit: expected.commit,
    bundle_sha256: expected.bundle,
    wire_protocol_version: expected.protocol,
    contract_lock_sha256: createHash("sha256").update(lock).digest("hex"),
    fixtures: verifiedFixtures,
  }, null, 2)}\n`,
  { mode: 0o600 },
);
