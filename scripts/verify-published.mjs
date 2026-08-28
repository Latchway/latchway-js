import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ARTIFACTS_PATH,
  REGISTRY_URL,
  fetchBytes,
  fetchJSON,
  inspectTarball,
  packageVersionURL,
  readRootManifest,
  runConsumerSmoke,
  sleep,
} from "./release-utils.mjs";

const PROVENANCE_TYPE = "https://slsa.dev/provenance/v1";
const PUBLISH_TYPE = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
const manifest = await readRootManifest();
const packageEvidence = JSON.parse(await readFile(join(ARTIFACTS_PATH, "package-evidence.json"), "utf8"));
const localArchive = join(ARTIFACTS_PATH, packageEvidence.tarball);
const localBytes = await readFile(localArchive);
const expectedCommit = requiredEnvironment("GITHUB_SHA", /^[0-9a-f]{40}$/u);
const expectedRepository = requiredEnvironment("GITHUB_REPOSITORY", /^Latchway\/latchway-js$/u);
const expectedRef = requiredEnvironment("GITHUB_REF", /^refs\/tags\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
const runID = requiredEnvironment("GITHUB_RUN_ID", /^\d+$/u);
const runAttempt = requiredEnvironment("GITHUB_RUN_ATTEMPT", /^\d+$/u);

const metadata = await waitForPublishedMetadata();
assertPublishedMetadata(metadata);

const tarballResult = await fetchBytes(metadata.dist.tarball, {
  maximumBytes: 10 * 1024 * 1024,
  accept: "application/octet-stream",
});
if (tarballResult.response.status !== 200 || !localBytes.equals(tarballResult.bytes)) {
  throw new Error("The npm registry tarball is not byte-identical to the verified release archive.");
}

const attestationResult = await fetchJSON(metadata.dist.attestations.url, { maximumBytes: 5 * 1024 * 1024 });
if (attestationResult.response.status !== 200) {
  throw new Error(`npm attestation retrieval failed with HTTP ${attestationResult.response.status}.`);
}
const attestations = attestationResult.value.attestations;
if (!Array.isArray(attestations)) throw new Error("The npm attestation response is malformed.");
const provenance = exactlyOne(attestations, PROVENANCE_TYPE);
const publish = exactlyOne(attestations, PUBLISH_TYPE);
const provenanceStatement = decodeStatement(provenance);
const publishStatement = decodeStatement(publish);
verifyProvenance(provenance, provenanceStatement);
verifyPublishAttestation(publishStatement);

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

await auditRegistrySignatures();
const evidence = {
  schema_version: 1,
  package: manifest.name,
  version: manifest.version,
  source_commit: expectedCommit,
  workflow: ".github/workflows/release.yml",
  workflow_ref: expectedRef,
  tarball: packageEvidence.tarball,
  sha256: packageEvidence.sha256,
  integrity: packageEvidence.integrity,
  registry_tarball_byte_identical: true,
  registry_signature_present: true,
  trusted_publisher: "github",
  provenance_predicate_type: PROVENANCE_TYPE,
  provenance_subject_verified: true,
  provenance_source_verified: true,
  npm_audit_signatures: "passed",
  export_smoke: "passed",
};
await writeFile(
  join(ARTIFACTS_PATH, "post-publish-evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

async function waitForPublishedMetadata() {
  const url = packageVersionURL(manifest.name, manifest.version);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const result = await fetchJSON(url, { maximumBytes: 2 * 1024 * 1024 });
    if (result.response.status === 200) {
      if (result.value.name !== manifest.name || result.value.version !== manifest.version ||
          result.value.dist?.integrity !== packageEvidence.integrity ||
          result.value.dist?.shasum !== packageEvidence.sha1) {
        throw new Error("The published npm version does not match the verified release archive.");
      }
      if (result.value.dist?.attestations?.provenance?.predicateType === PROVENANCE_TYPE) {
        return result.value;
      }
    } else if (result.response.status !== 404) {
      throw new Error(`npm publication verification failed with HTTP ${result.response.status}.`);
    }
    await sleep(5_000);
  }
  throw new Error("The exact npm version and provenance did not become visible within two minutes.");
}

function assertPublishedMetadata(value) {
  if (value.name !== manifest.name || value.version !== manifest.version ||
      !isDeepStrictEqual(value.exports, manifest.exports) ||
      !isDeepStrictEqual(value.repository, manifest.repository) || value._nodeVersion !== "24.19.0" ||
      value.dist?.integrity !== packageEvidence.integrity || value.dist?.shasum !== packageEvidence.sha1 ||
      !Array.isArray(value.dist?.signatures) || value.dist.signatures.length === 0 ||
      value.dist?.attestations?.provenance?.predicateType !== PROVENANCE_TYPE ||
      value._npmUser?.trustedPublisher?.id !== "github") {
    throw new Error("The npm version metadata is missing exact exports, integrity, signature, or trusted-publisher state.");
  }
}

function exactlyOne(attestations, predicateType) {
  const matches = attestations.filter((entry) => entry?.predicateType === predicateType);
  if (matches.length !== 1) throw new Error(`Expected exactly one npm attestation for ${predicateType}.`);
  return matches[0];
}

function decodeStatement(attestation) {
  const envelope = attestation?.bundle?.dsseEnvelope;
  if (envelope?.payloadType !== "application/vnd.in-toto+json" ||
      !Array.isArray(envelope.signatures) || envelope.signatures.length === 0 ||
      typeof envelope.payload !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(envelope.payload)) {
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

function verifyProvenance(attestation, statement) {
  verifySubject(statement, PROVENANCE_TYPE, "https://in-toto.io/Statement/v1");
  const expectedRepositoryURL = `https://github.com/${expectedRepository}`;
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const resolved = statement.predicate?.buildDefinition?.resolvedDependencies;
  const github = statement.predicate?.buildDefinition?.internalParameters?.github;
  const runDetails = statement.predicate?.runDetails;
  const invocationPrefix = `${expectedRepositoryURL}/actions/runs/${runID}/attempts/`;
  const invocationID = runDetails?.metadata?.invocationId;
  const provenanceAttempt = typeof invocationID === "string" && invocationID.startsWith(invocationPrefix)
    ? Number(invocationID.slice(invocationPrefix.length))
    : Number.NaN;
  if (workflow?.repository !== expectedRepositoryURL || workflow?.path !== ".github/workflows/release.yml" ||
      workflow?.ref !== expectedRef || github?.event_name !== "push" ||
      !Array.isArray(resolved) || !resolved.some((dependency) => dependency?.digest?.gitCommit === expectedCommit) ||
      runDetails?.builder?.id !== "https://github.com/actions/runner/github-hosted" ||
      !Number.isInteger(provenanceAttempt) || provenanceAttempt < 1 || provenanceAttempt > Number(runAttempt)) {
    throw new Error("The npm provenance statement does not bind the canonical tag, commit, workflow, and run.");
  }

  const certificateBytes = attestation?.bundle?.verificationMaterial?.certificate?.rawBytes;
  if (typeof certificateBytes !== "string") throw new Error("The provenance bundle is missing its signing certificate.");
  const certificate = new X509Certificate(Buffer.from(certificateBytes, "base64"));
  const expectedIdentity = `URI:${expectedRepositoryURL}/.github/workflows/release.yml@${expectedRef}`;
  if (certificate.subjectAltName !== expectedIdentity) {
    throw new Error("The provenance signing certificate has an unexpected workflow identity.");
  }
}

function verifyPublishAttestation(statement) {
  verifySubject(statement, PUBLISH_TYPE, "https://in-toto.io/Statement/v0.1");
  if (statement.predicate?.name !== manifest.name || statement.predicate?.version !== manifest.version ||
      statement.predicate?.registry !== REGISTRY_URL.slice(0, -1)) {
    throw new Error("The npm publish attestation does not bind the exact package and registry.");
  }
}

function verifySubject(statement, predicateType, statementType) {
  const [scope, packageName] = manifest.name.split("/");
  const expectedPURL = `pkg:npm/${encodeURIComponent(scope)}/${packageName}@${manifest.version}`;
  if (statement?._type !== statementType || statement.predicateType !== predicateType ||
      !Array.isArray(statement.subject) || statement.subject.length !== 1 ||
      statement.subject[0]?.name !== expectedPURL ||
      statement.subject[0]?.digest?.sha512 !== packageEvidence.sha512) {
    throw new Error(`The ${predicateType} attestation subject does not match the verified npm archive.`);
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
    runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact"], consumer, npmrc);
    const lock = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8"));
    if (lock.packages?.[`node_modules/${manifest.name}`]?.integrity !== packageEvidence.integrity) {
      throw new Error("The registry consumer lock does not contain the exact published integrity.");
    }
    runNpm(["audit", "signatures", `--registry=${REGISTRY_URL}`], consumer, npmrc);
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

function runNpm(arguments_, cwd, userconfig) {
  const environment = { ...process.env };
  delete environment.NODE_AUTH_TOKEN;
  delete environment.NPM_TOKEN;
  environment.NPM_CONFIG_USERCONFIG = userconfig;
  environment.NPM_CONFIG_CACHE = join(cwd, ".npm-cache");
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    execFileSync(command, arguments_, {
      cwd,
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`npm ${arguments_[0]} failed during published-package verification.`);
  }
}

function requiredEnvironment(name, pattern) {
  const value = process.env[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Missing or invalid ${name}.`);
  return value;
}
