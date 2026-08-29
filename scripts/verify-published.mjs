import { X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  PROVENANCE_TYPE,
  PUBLISH_TYPE,
  SOURCE_REF,
  WORKFLOW_PATH,
  assertSafeRetainedOutput,
  buildAdoptionRecord,
  buildRegistryManifest,
  requireCurrentPublicationOrigin,
  sha256,
  verifyProvenanceStatement,
  verifyPublishStatement,
} from "./npm-release-evidence.mjs";
import {
  ARTIFACTS_PATH,
  REGISTRY_URL,
  ROOT_PATH,
  fetchBytes,
  inspectTarball,
  packageVersionURL,
  readRootManifest,
  runConsumerSmoke,
  sleep,
} from "./release-utils.mjs";

const manifest = await readRootManifest();
const packageEvidence = JSON.parse(await readFile(join(ARTIFACTS_PATH, "package-evidence.json"), "utf8"));
const localArchive = join(ARTIFACTS_PATH, packageEvidence.tarball);
const localBytes = await readFile(localArchive);
const expectedCommit = requiredEnvironment("EXPECTED_SOURCE_COMMIT", /^[0-9a-f]{40}$/u);
const workflowCommit = requiredEnvironment("GITHUB_SHA", /^[0-9a-f]{40}$/u);
const expectedReleaseTag = requiredEnvironment(
  "EXPECTED_RELEASE_TAG",
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u,
);
const expectedRepository = requiredEnvironment("GITHUB_REPOSITORY", /^Latchway\/latchway-js$/u);
const expectedRef = requiredEnvironment("GITHUB_REF", /^refs\/heads\/main$/u);
const expectedEvent = requiredEnvironment("GITHUB_EVENT_NAME", /^repository_dispatch$/u);
const currentRunID = Number(requiredEnvironment("GITHUB_RUN_ID", /^[1-9]\d*$/u));
const currentRunAttempt = Number(requiredEnvironment("GITHUB_RUN_ATTEMPT", /^[1-9]\d*$/u));
const publishPerformed = requiredEnvironment("PUBLISH_PERFORMED", /^(?:true|false)$/u) === "true";
if (workflowCommit !== expectedCommit || expectedRef !== SOURCE_REF) {
  throw new Error("The publication workflow commit does not match the promoted source commit.");
}

const expectedRepositoryURL = `https://github.com/${expectedRepository}`;
const published = await waitForPublishedMetadata();
const metadata = published.value;
assertPublishedMetadata(metadata);

const npmViewBytes = runNpmCaptured([
  "view",
  `${manifest.name}@${manifest.version}`,
  "--json",
  "--include-attestations",
  `--registry=${REGISTRY_URL}`,
], ROOT_PATH, 2 * 1024 * 1024, "npm view");
const npmView = assertSafeRetainedOutput(npmViewBytes, "npm view output", 2 * 1024 * 1024);
assertNpmView(npmView);

const tarballResult = await fetchBytes(metadata.dist.tarball, {
  maximumBytes: 10 * 1024 * 1024,
  accept: "application/octet-stream",
});
if (tarballResult.response.status !== 200 || !localBytes.equals(tarballResult.bytes)) {
  throw new Error("The npm registry tarball is not byte-identical to the verified release archive.");
}

const attestationResult = await fetchBytes(metadata.dist.attestations.url, { maximumBytes: 5 * 1024 * 1024 });
if (attestationResult.response.status !== 200) {
  throw new Error(`npm attestation retrieval failed with HTTP ${attestationResult.response.status}.`);
}
const attestationDocument = assertSafeRetainedOutput(
  attestationResult.bytes,
  "npm Sigstore attestation output",
  5 * 1024 * 1024,
);
const attestations = attestationDocument.attestations;
if (!Array.isArray(attestations)) throw new Error("The npm attestation response is malformed.");
const provenance = exactlyOne(attestations, PROVENANCE_TYPE);
const publish = exactlyOne(attestations, PUBLISH_TYPE);
const provenanceStatement = decodeStatement(provenance);
const publishStatement = decodeStatement(publish);
const provenanceOrigin = verifyProvenanceStatement(provenanceStatement, {
  packageName: manifest.name,
  packageVersion: manifest.version,
  sha512: packageEvidence.sha512,
  expectedRepositoryURL,
  expectedCommit,
  expectedEvent,
});
verifyWorkflowCertificate(provenance, expectedRepositoryURL);
requireCurrentPublicationOrigin(provenanceOrigin, { publishPerformed, currentRunID, currentRunAttempt });
verifyPublishStatement(publishStatement, {
  packageName: manifest.name,
  packageVersion: manifest.version,
  sha512: packageEvidence.sha512,
  registryURL: REGISTRY_URL,
});

const downloaded = await mkdtemp(join(tmpdir(), "latchway-published-package-"));
try {
  const downloadedArchive = join(downloaded, packageEvidence.tarball);
  await writeFile(downloadedArchive, tarballResult.bytes, { mode: 0o600 });
  const inspection = await inspectTarball(downloadedArchive, manifest);
  if (JSON.stringify(inspection.entries) !== JSON.stringify(packageEvidence.entries)) {
    throw new Error("The registry archive entry list differs from verified package evidence.");
  }
  await runConsumerSmoke(downloadedArchive, { typescript: false });
} finally {
  await rm(downloaded, { recursive: true, force: true });
}

const auditBytes = await auditRegistrySignatures();
const audit = assertSafeRetainedOutput(auditBytes, "npm audit signatures output", 2 * 1024 * 1024);
if (audit === null || typeof audit !== "object" || Object.hasOwn(audit, "error")) {
  throw new Error("npm audit signatures returned an invalid verification result.");
}

const retained = [
  { name: "npm-registry-version.json", bytes: published.bytes },
  { name: "npm-registry-view.json", bytes: npmViewBytes },
  { name: "npm-attestations.json", bytes: attestationResult.bytes },
  { name: "npm-audit-signatures.json", bytes: auditBytes },
];
for (const asset of retained) {
  assertSafeRetainedOutput(asset.bytes, asset.name, asset.name === "npm-attestations.json" ? 5 * 1024 * 1024 : 2 * 1024 * 1024);
  await writeFile(join(ARTIFACTS_PATH, asset.name), asset.bytes, { mode: 0o600 });
}

const registryManifest = buildRegistryManifest({
  packageName: manifest.name,
  packageVersion: manifest.version,
  tarball: {
    name: packageEvidence.tarball,
    bytes: localBytes.byteLength,
    sha256: packageEvidence.sha256,
    sha512: packageEvidence.sha512,
    integrity: packageEvidence.integrity,
  },
  evidence: retained,
});
const registryManifestBytes = jsonBytes(registryManifest);
await writeFile(join(ARTIFACTS_PATH, "npm-registry-evidence-manifest.json"), registryManifestBytes, { mode: 0o600 });

const evidenceReferences = Object.fromEntries(retained.map((asset) => [asset.name, {
  bytes: asset.bytes.byteLength,
  sha256: sha256(asset.bytes),
}]));
const postPublishEvidence = {
  schema_version: 2,
  kind: "latchway_npm_publication_evidence",
  package: manifest.name,
  version: manifest.version,
  source: {
    repository: expectedRepositoryURL,
    commit: expectedCommit,
    workflow: WORKFLOW_PATH,
    ref: SOURCE_REF,
  },
  release_tag: expectedReleaseTag,
  registry: REGISTRY_URL,
  tarball: {
    name: packageEvidence.tarball,
    bytes: localBytes.byteLength,
    sha256: packageEvidence.sha256,
    sha512: packageEvidence.sha512,
    integrity: packageEvidence.integrity,
    registry_bytes_sha256: sha256(tarballResult.bytes),
  },
  trusted_publisher: {
    provider: "github",
    provenance_predicate_type: PROVENANCE_TYPE,
    provenance_origin: provenanceOrigin,
    sigstore_bundle: {
      file: "npm-attestations.json",
      ...evidenceReferences["npm-attestations.json"],
    },
  },
  registry_signature_verification: {
    command: `npm audit signatures --json --registry=${REGISTRY_URL}`,
    output: {
      file: "npm-audit-signatures.json",
      ...evidenceReferences["npm-audit-signatures.json"],
    },
  },
  retained_outputs: evidenceReferences,
  evidence_manifest: {
    file: "npm-registry-evidence-manifest.json",
    bytes: registryManifestBytes.byteLength,
    sha256: sha256(registryManifestBytes),
  },
};
const postPublishBytes = jsonBytes(postPublishEvidence);
await writeFile(join(ARTIFACTS_PATH, "post-publish-evidence.json"), postPublishBytes, { mode: 0o600 });

const adoption = buildAdoptionRecord({
  packageName: manifest.name,
  packageVersion: manifest.version,
  releaseTag: expectedReleaseTag,
  repositoryURL: expectedRepositoryURL,
  sourceCommit: expectedCommit,
  provenanceOrigin,
  tarball: registryManifest.tarball,
  manifestSHA256: sha256(registryManifestBytes),
  currentRunID,
  currentRunAttempt,
  publishPerformed,
});
const adoptionName = `npm-release-adoption-${currentRunID}-${currentRunAttempt}.json`;
const adoptionBytes = jsonBytes(adoption);
await writeFile(join(ARTIFACTS_PATH, adoptionName), adoptionBytes, { mode: 0o600 });
if (typeof process.env.GITHUB_OUTPUT === "string") {
  await appendFile(process.env.GITHUB_OUTPUT, `adoption_asset=${adoptionName}\n`, { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({
  ...postPublishEvidence,
  adoption: { file: adoptionName, bytes: adoptionBytes.byteLength, sha256: sha256(adoptionBytes) },
}, null, 2)}\n`);

async function waitForPublishedMetadata() {
  const url = packageVersionURL(manifest.name, manifest.version);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const result = await fetchBytes(url, { maximumBytes: 2 * 1024 * 1024 });
    if (result.response.status === 200) {
      const value = assertSafeRetainedOutput(result.bytes, "npm registry version output", 2 * 1024 * 1024);
      if (
        value.name !== manifest.name
        || value.version !== manifest.version
        || value.dist?.integrity !== packageEvidence.integrity
        || value.dist?.shasum !== packageEvidence.sha1
      ) {
        throw new Error("The published npm version does not match the verified release archive.");
      }
      if (value.dist?.attestations?.provenance?.predicateType === PROVENANCE_TYPE) {
        return { value, bytes: result.bytes };
      }
    } else if (result.response.status !== 404) {
      throw new Error(`npm publication verification failed with HTTP ${result.response.status}.`);
    }
    await sleep(5_000);
  }
  throw new Error("The exact npm version and provenance did not become visible within two minutes.");
}

function assertPublishedMetadata(value) {
  if (
    value.name !== manifest.name
    || value.version !== manifest.version
    || !isDeepStrictEqual(value.exports, manifest.exports)
    || !isDeepStrictEqual(value.repository, manifest.repository)
    || value._nodeVersion !== "24.19.0"
    || value.dist?.integrity !== packageEvidence.integrity
    || value.dist?.shasum !== packageEvidence.sha1
    || !Array.isArray(value.dist?.signatures)
    || value.dist.signatures.length === 0
    || value.dist?.attestations?.provenance?.predicateType !== PROVENANCE_TYPE
    || value._npmUser?.trustedPublisher?.id !== "github"
  ) {
    throw new Error("The npm version metadata is missing exact exports, integrity, signature, or trusted-publisher state.");
  }
}

function assertNpmView(value) {
  const repository = typeof value.repository === "object" ? value.repository?.url : value.repository;
  if (
    value.name !== manifest.name
    || value.version !== manifest.version
    || value.dist?.integrity !== packageEvidence.integrity
    || value.dist?.shasum !== packageEvidence.sha1
    || !Array.isArray(value.dist?.signatures)
    || value.dist.signatures.length === 0
    || value.dist?.attestations?.provenance?.predicateType !== PROVENANCE_TYPE
    || normalizeRepository(repository) !== normalizeRepository(manifest.repository.url)
  ) {
    throw new Error("npm view did not return the exact signed, attested package coordinate.");
  }
}

function exactlyOne(attestations, predicateType) {
  const matches = attestations.filter((entry) => entry?.predicateType === predicateType);
  if (matches.length !== 1) throw new Error(`Expected exactly one npm attestation for ${predicateType}.`);
  return matches[0];
}

function decodeStatement(attestation) {
  const envelope = attestation?.bundle?.dsseEnvelope;
  if (
    envelope?.payloadType !== "application/vnd.in-toto+json"
    || !Array.isArray(envelope.signatures)
    || envelope.signatures.length === 0
    || typeof envelope.payload !== "string"
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(envelope.payload)
  ) {
    throw new Error("The npm Sigstore DSSE envelope is malformed.");
  }
  const bytes = Buffer.from(envelope.payload, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024) {
    throw new Error("The npm attestation statement has an invalid size.");
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("The npm attestation statement is not valid JSON.");
  }
}

function verifyWorkflowCertificate(attestation, repositoryURL) {
  const certificateBytes = attestation?.bundle?.verificationMaterial?.certificate?.rawBytes;
  if (typeof certificateBytes !== "string") throw new Error("The provenance bundle is missing its signing certificate.");
  const certificate = new X509Certificate(Buffer.from(certificateBytes, "base64"));
  const expectedIdentity = `URI:${repositoryURL}/${WORKFLOW_PATH}@${SOURCE_REF}`;
  if (certificate.subjectAltName !== expectedIdentity) {
    throw new Error("The provenance signing certificate has an unexpected workflow identity.");
  }
}

async function auditRegistrySignatures() {
  const consumer = await mkdtemp(join(tmpdir(), "latchway-signature-audit-"));
  try {
    const npmrc = join(consumer, ".npmrc");
    await writeFile(npmrc, `registry=${REGISTRY_URL}\nfund=false\n`, { mode: 0o600 });
    await writeFile(join(consumer, "package.json"), `${JSON.stringify({
      name: "latchway-signature-audit",
      version: "0.0.0",
      private: true,
      dependencies: { [manifest.name]: manifest.version },
    }, null, 2)}\n`);
    runNpmCaptured(
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact"],
      consumer,
      4 * 1024 * 1024,
      "npm install",
      npmrc,
    );
    const lock = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8"));
    if (lock.packages?.[`node_modules/${manifest.name}`]?.integrity !== packageEvidence.integrity) {
      throw new Error("The registry consumer lock does not contain the exact published integrity.");
    }
    return runNpmCaptured(
      ["audit", "signatures", "--json", `--registry=${REGISTRY_URL}`],
      consumer,
      2 * 1024 * 1024,
      "npm audit signatures",
      npmrc,
    );
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

function runNpmCaptured(arguments_, cwd, maximumBytes, operation, userconfig) {
  const excluded = new Set([
    "NODE_AUTH_TOKEN", "NPM_TOKEN", "npm_config__auth", "npm_config_auth",
    "npm_config__authToken", "NPM_CONFIG__AUTH", "NPM_CONFIG_AUTH",
  ]);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !excluded.has(name)),
  );
  environment.NPM_CONFIG_USERCONFIG = userconfig ?? join(tmpdir(), "latchway-empty-release.npmrc");
  environment.NPM_CONFIG_CACHE = join(tmpdir(), `latchway-npm-read-cache-${process.pid}`);
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, arguments_, {
    cwd,
    env: environment,
    encoding: "buffer",
    maxBuffer: maximumBytes,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(`${operation} failed during published-package verification.`);
  }
  if (result.stdout.byteLength === 0 || result.stdout.byteLength > maximumBytes) {
    throw new Error(`${operation} returned an invalid amount of retained output.`);
  }
  return result.stdout;
}

function normalizeRepository(repository) {
  return String(repository ?? "").replace(/^git\+/u, "").replace(/\.git$/u, "").toLowerCase();
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requiredEnvironment(name, pattern) {
  const value = process.env[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Missing or invalid ${name}.`);
  return value;
}
