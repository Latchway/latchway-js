import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const expected = {
  contract: "1.0.0",
  release: "unreleased",
  commit: "9756a08fe41e6c8a7eba0cf27a5f31379713d733",
  bundle: "8e916d8b4ae4d002eabb39b867fe6185c7d5f3c97a258b08427a4a96461c938b",
  protocol: 2,
  minimumServer: "1.0.0",
  maximumTestedServer: "1.0.x",
};
const expectedLock = `contract_version: ${expected.contract}
wire_protocol: ${expected.protocol}
core_release: ${expected.release}
core_commit: ${expected.commit}
bundle_sha256: "${expected.bundle}"
minimum_server_version: ${expected.minimumServer}
maximum_tested_server_version: ${expected.maximumTestedServer}
`;
const fixtureHashes = new Map([
  ["attestation-binding-v1.json", "aaadef1172dffc3e600029e03259ff636a969cd4f925544fdccfb2c704b03659"],
  ["dpop-v1.json", "b639e22dcd1c1a18e1292a044d96ec043c3be1e0271aacd6904bca39253bc5d4"],
  ["installation-family-v2.json", "87ea67542983a406ef7257476429b8d23e36a90c1b448142a5728632e63395f3"],
  ["protocol-version.json", "7e63b0820b459606c0f0478770a6b1f4fa17d800578b7522c2e9e1210f79f784"],
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
    core_release: expected.release,
    core_commit: expected.commit,
    bundle_sha256: expected.bundle,
    wire_protocol_version: expected.protocol,
    contract_lock_sha256: createHash("sha256").update(lock).digest("hex"),
    fixtures: verifiedFixtures,
  }, null, 2)}\n`,
  { mode: 0o600 },
);
