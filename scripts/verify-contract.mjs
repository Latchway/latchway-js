import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const expected = {
  contract: "0.4.0",
  commit: "c9347421fac4c729f20ea87f9205c66c15fa983f",
  bundle: "39d32a2c9e4b0381ff815a40d87d75b51e4f37d6de55121b7bb0beef690c5c59",
  protocol: 1,
  minimumServer: "0.4.0",
  maximumTestedServer: "0.4.x",
};
const expectedLock = `contract_version: ${expected.contract}
core_release: unreleased
core_commit: ${expected.commit}
bundle_sha256: "${expected.bundle}"
minimum_server_version: ${expected.minimumServer}
maximum_tested_server_version: ${expected.maximumTestedServer}
wire_protocol_version: ${expected.protocol}
`;
const fixtureHashes = new Map([
  ["attestation-binding-v1.json", "03e54217ba0da1cac9d882abd26f8cd21642f62dc1fbfaf61c32fc5261d6754e"],
  ["dpop-v1.json", "bd897803b910c58926b3f46c1102a1d33c1df89f0266774e6f12cf144d71e587"],
  ["protocol-version.json", "3e2cc1b7f6812f8e6319c7f17c8228171af477f77af63be4fb1f04df56f8ffd8"],
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
