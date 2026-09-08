import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const expected = {
  contract: "1.1.0",
  release: "v1.1.0",
  commit: "0a60cbef57d904664430e235e1e165fea14f610b",
  bundle: "deb25aaae5160a7342bfae0efa4a9ce0403d8c40ed8da74eb2c99be4d4ede293",
  protocol: 3,
  minimumServer: "1.1.0",
  maximumTestedServer: "1.1.0",
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
  ["component-attestation-binding-v2.json", "8411308998cdffccf286892b94a6c759cbcf63b92e4727144d3a755dcd7c13d4"],
  ["dpop-v1.json", "b639e22dcd1c1a18e1292a044d96ec043c3be1e0271aacd6904bca39253bc5d4"],
  ["installation-family-v2.json", "7ea657c5ca1de6d0ab1507b6187a1a6920fcf7486a6c6da178727df0efc5257d"],
  ["protocol-version.json", "c8f32d02af792dcec2e92ea1dc5816b85ccf8214f31c9c334cfafc38aa078932"],
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
const shared = JSON.parse(await readFile(new URL("../contract.shared-native.lock.json", import.meta.url), "utf8"));
if (shared.status !== "released" || shared.core_commit !== expected.commit || shared.core_release !== expected.release ||
    shared.bundle_sha256 !== expected.bundle || shared.contract_version !== expected.contract || shared.wire_protocol !== expected.protocol) {
  throw new Error("The shared-native contract pin differs from the released core contract.");
}
for (const [path, expectedHash] of Object.entries(shared.files)) {
  if (!path.startsWith("test/fixtures/contract/shared-native/") || path.includes("..")) throw new Error("Unsafe shared contract fixture path.");
  const bytes = await readFile(new URL(`../${path}`, import.meta.url));
  if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error(`Shared contract fixture drift: ${path}`);
}
if (protocol.component_attestation_binding?.version !== 2 ||
    protocol.component_attestation_binding?.purpose !== "component_attestation_step_up") {
  throw new Error("The vendored protocol manifest omits component-attestation binding v2.");
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
