import { X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  buildRegistrySetManifest,
  decodeBase64Strict,
  normalizePublishStateForConsumerAttempt,
  parseStrictJSONBytes,
  readBoundedFileSync,
  readBoundedStrictJSONFileSync,
  requireCurrentPublicationOrigin,
  sha256,
  verifyProvenanceStatement,
  verifyPublishStatement,
} from "./npm-release-evidence.mjs";
import {
  ARTIFACTS_PATH,
  REGISTRY_URL,
  ROOT_PATH,
  SCOPE_REGISTRY_ARGUMENT,
  SCOPE_REGISTRY_CONFIG,
  artifactNameForPackage,
  expectedPublishedManifest,
  fetchBytes,
  inspectTarball,
  packageVersionURL,
  readReleasePackages,
  sleep,
} from "./release-utils.mjs";

const MAXIMUM_PACKAGE_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_PACKAGE_LOCK_BYTES = 2 * 1024 * 1024;
const MAXIMUM_PUBLISH_STATE_BYTES = 4 * 1024;
const MAXIMUM_STATEMENT_BYTES = 256 * 1024;
const MAXIMUM_CERTIFICATE_BYTES = 64 * 1024;
const MAXIMUM_NPM_COMMAND_MILLISECONDS = 5 * 60 * 1000;
const MAXIMUM_RUNTIME_COMMAND_MILLISECONDS = 60 * 1000;

const packages = await readReleasePackages();
const packageSetEvidence = readBoundedStrictJSONFileSync(
  join(ARTIFACTS_PATH, "package-evidence.json"),
  "Package-set evidence",
  MAXIMUM_PACKAGE_EVIDENCE_BYTES,
);
if (
  packageSetEvidence.schema_version !== 2
  || packageSetEvidence.package_count !== packages.length
  || JSON.stringify(packageSetEvidence.publish_order) !== JSON.stringify(packages.map(({ name }) => name))
  || !Array.isArray(packageSetEvidence.packages)
  || packageSetEvidence.packages.length !== packages.length
) {
  throw new Error("Package-set evidence is incomplete or has an unexpected publication order.");
}

const expectedCommit = requiredEnvironment("EXPECTED_SOURCE_COMMIT", /^[0-9a-f]{40}$/u);
const workflowCommit = requiredEnvironment("GITHUB_SHA", /^[0-9a-f]{40}$/u);
const expectedReleaseTag = requiredEnvironment(
  "EXPECTED_RELEASE_TAG",
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u,
);
const expectedRepository = requiredEnvironment("GITHUB_REPOSITORY", /^Latchway\/latchway-js$/u);
const expectedRef = requiredEnvironment("GITHUB_REF", /^refs\/heads\/main$/u);
const expectedEvent = process.env.EXPECTED_PROVENANCE_EVENT === undefined
  ? requiredEnvironment("GITHUB_EVENT_NAME", /^repository_dispatch$/u)
  : requiredEnvironment("EXPECTED_PROVENANCE_EVENT", /^(?:repository_dispatch|workflow_dispatch)$/u);
const expectedWorkflowPath = process.env.EXPECTED_PROVENANCE_WORKFLOW_PATH === undefined
  ? WORKFLOW_PATH
  : requiredEnvironment(
    "EXPECTED_PROVENANCE_WORKFLOW_PATH",
    /^\.github\/workflows\/(?:release|single-maintainer-release)\.yml$/u,
  );
if (requiredEnvironment("GITHUB_EVENT_NAME", /^(?:repository_dispatch|workflow_dispatch)$/u) !== expectedEvent) {
  throw new Error("The publication event does not match the expected npm provenance event.");
}
const currentRunID = Number(requiredEnvironment("GITHUB_RUN_ID", /^[1-9]\d*$/u));
const currentRunAttempt = Number(requiredEnvironment("GITHUB_RUN_ATTEMPT", /^[1-9]\d*$/u));
const producerRunID = Number(requiredEnvironment("PUBLISH_PRODUCER_RUN_ID", /^[1-9]\d*$/u));
const producerRunAttempt = Number(requiredEnvironment("PUBLISH_PRODUCER_RUN_ATTEMPT", /^[1-9]\d*$/u));
const publishState = normalizePublishStateForConsumerAttempt(
  parsePublishState(requiredEnvironment("PUBLISH_STATE_JSON", /^\{[^\r\n]+\}$/u)),
  { producerRunID, producerRunAttempt, currentRunID, currentRunAttempt },
);
if (workflowCommit !== expectedCommit || expectedRef !== SOURCE_REF) {
  throw new Error("The publication workflow commit does not match the promoted source commit.");
}

const expectedRepositoryURL = `https://github.com/${expectedRepository}`;
const registryEntries = [];
const postPublishPackages = [];
const adoptionInputs = [];
for (const [index, package_] of packages.entries()) {
  const packageEvidence = packageSetEvidence.packages[index];
  assertPackageEvidence(package_, packageEvidence);
  const localArchive = join(ARTIFACTS_PATH, package_.archiveName);
  const localBytes = readBoundedFileSync(
    localArchive,
    `${package_.name} reviewed archive`,
    10 * 1024 * 1024,
  );

  const published = await waitForPublishedMetadata(package_, packageEvidence);
  const metadata = published.value;
  assertPublishedMetadata(package_, packageEvidence, metadata);

  const npmViewBytes = runNpmCaptured([
    "view",
    `${package_.name}@${package_.manifest.version}`,
    "--json",
    "--include-attestations",
    `--registry=${REGISTRY_URL}`,
    SCOPE_REGISTRY_ARGUMENT,
  ], ROOT_PATH, 2 * 1024 * 1024, `${package_.name} npm view`);
  const npmView = assertSafeRetainedOutput(npmViewBytes, `${package_.name} npm view output`, 2 * 1024 * 1024);
  assertNpmView(package_, packageEvidence, npmView);

  const tarballResult = await fetchBytes(metadata.dist.tarball, {
    maximumBytes: 10 * 1024 * 1024,
    accept: "application/octet-stream",
  });
  if (tarballResult.response.status !== 200 || !localBytes.equals(tarballResult.bytes)) {
    throw new Error(`${package_.name} registry bytes are not identical to the reviewed archive.`);
  }

  const attestationResult = await fetchBytes(metadata.dist.attestations.url, { maximumBytes: 5 * 1024 * 1024 });
  if (attestationResult.response.status !== 200) {
    throw new Error(`${package_.name} npm attestation retrieval failed with HTTP ${attestationResult.response.status}.`);
  }
  const attestationDocument = assertSafeRetainedOutput(
    attestationResult.bytes,
    `${package_.name} npm Sigstore attestation output`,
    5 * 1024 * 1024,
  );
  const attestations = attestationDocument.attestations;
  if (!Array.isArray(attestations)) throw new Error(`${package_.name} npm attestation response is malformed.`);
  const provenance = exactlyOne(attestations, PROVENANCE_TYPE);
  const publish = exactlyOne(attestations, PUBLISH_TYPE);
  const provenanceOrigin = verifyProvenanceStatement(decodeStatement(provenance), {
    packageName: package_.name,
    packageVersion: package_.manifest.version,
    sha512: packageEvidence.sha512,
    expectedRepositoryURL,
    expectedCommit,
    expectedEvent,
    expectedWorkflowPath,
  });
  verifyWorkflowCertificate(provenance, expectedRepositoryURL, expectedWorkflowPath);
  requireCurrentPublicationOrigin(provenanceOrigin, {
    publishPerformed: publishState[package_.name],
    currentRunID,
    currentRunAttempt,
  });
  verifyPublishStatement(decodeStatement(publish), {
    packageName: package_.name,
    packageVersion: package_.manifest.version,
    sha512: packageEvidence.sha512,
    registryURL: REGISTRY_URL,
  });

  const downloaded = await mkdtemp(join(tmpdir(), `latchway-published-${package_.id}-`));
  try {
    const downloadedArchive = join(downloaded, package_.archiveName);
    await writeFile(downloadedArchive, tarballResult.bytes, { mode: 0o600 });
    const inspection = await inspectTarball(downloadedArchive, package_);
    if (JSON.stringify(inspection.entries) !== JSON.stringify(packageEvidence.entries)) {
      throw new Error(`${package_.name} registry archive entries differ from package-set evidence.`);
    }
  } finally {
    await rm(downloaded, { recursive: true, force: true });
  }

  const cleanConsumer = await verifyCleanRegistryConsumer(package_, packageEvidence);
  const audit = assertSafeRetainedOutput(
    cleanConsumer.auditBytes,
    `${package_.name} npm audit signatures output`,
    2 * 1024 * 1024,
  );
  if (audit === null || typeof audit !== "object" || Object.hasOwn(audit, "error")) {
    throw new Error(`${package_.name} npm audit signatures returned an invalid verification result.`);
  }

  const retained = [
    { name: artifactNameForPackage(package_.id, "registry-version"), bytes: published.bytes },
    { name: artifactNameForPackage(package_.id, "registry-view"), bytes: npmViewBytes },
    { name: artifactNameForPackage(package_.id, "attestations"), bytes: attestationResult.bytes },
    { name: artifactNameForPackage(package_.id, "audit-signatures"), bytes: cleanConsumer.auditBytes },
  ];
  for (const asset of retained) {
    assertSafeRetainedOutput(
      asset.bytes,
      asset.name,
      asset.name.endsWith("-attestations.json") ? 5 * 1024 * 1024 : 2 * 1024 * 1024,
    );
    await writeFile(join(ARTIFACTS_PATH, asset.name), asset.bytes, { mode: 0o600 });
  }
  const tarball = {
    name: package_.archiveName,
    bytes: localBytes.byteLength,
    sha256: packageEvidence.sha256,
    sha512: packageEvidence.sha512,
    integrity: packageEvidence.integrity,
  };
  registryEntries.push({
    id: package_.id,
    package: package_.name,
    version: package_.manifest.version,
    tarball,
    evidence: retained,
  });
  const evidenceReferences = Object.fromEntries(retained.map((asset) => [asset.name, {
    bytes: asset.bytes.byteLength,
    sha256: sha256(asset.bytes),
  }]));
  postPublishPackages.push({
    id: package_.id,
    package: package_.name,
    version: package_.manifest.version,
    // This fixed release asset describes the immutable registry fact. Whether
    // the current workflow run performed or adopted that publication belongs
    // only in the package-suffixed, retry-specific adoption record below.
    publication_mode: "published",
    tarball: { ...tarball, registry_bytes_sha256: sha256(tarballResult.bytes) },
    trusted_publisher: {
      provider: "github",
      provenance_predicate_type: PROVENANCE_TYPE,
      provenance_origin: provenanceOrigin,
      sigstore_bundle: {
        file: artifactNameForPackage(package_.id, "attestations"),
        ...evidenceReferences[artifactNameForPackage(package_.id, "attestations")],
      },
    },
    registry_signature_verification: {
      command: `npm audit signatures --json --registry=${REGISTRY_URL} ${SCOPE_REGISTRY_ARGUMENT}`,
      output: {
        file: artifactNameForPackage(package_.id, "audit-signatures"),
        ...evidenceReferences[artifactNameForPackage(package_.id, "audit-signatures")],
      },
    },
    clean_consumer: cleanConsumer.evidence,
    retained_outputs: evidenceReferences,
  });
  adoptionInputs.push({ package_, packageEvidence, provenanceOrigin, tarball });
}

const registryManifest = buildRegistrySetManifest({
  version: packages[0].manifest.version,
  publishOrder: packages.map(({ name }) => name),
  packages: registryEntries,
});
const registryManifestBytes = jsonBytes(registryManifest);
await writeFile(join(ARTIFACTS_PATH, "npm-registry-evidence-manifest.json"), registryManifestBytes, { mode: 0o600 });

const postPublishEvidence = {
  schema_version: 3,
  kind: "latchway_npm_package_set_publication_evidence",
  version: packages[0].manifest.version,
  package_count: packages.length,
  publish_order: packages.map(({ name }) => name),
  source: {
    repository: expectedRepositoryURL,
    commit: expectedCommit,
    workflow: expectedWorkflowPath,
    ref: SOURCE_REF,
  },
  release_tag: expectedReleaseTag,
  registry: REGISTRY_URL,
  packages: postPublishPackages,
  evidence_manifest: {
    file: "npm-registry-evidence-manifest.json",
    bytes: registryManifestBytes.byteLength,
    sha256: sha256(registryManifestBytes),
  },
};
await writeFile(join(ARTIFACTS_PATH, "post-publish-evidence.json"), jsonBytes(postPublishEvidence), { mode: 0o600 });

const adoptionNames = [];
for (const { package_, provenanceOrigin, tarball } of adoptionInputs) {
  const adoption = buildAdoptionRecord({
    packageName: package_.name,
    packageVersion: package_.manifest.version,
    releaseTag: expectedReleaseTag,
    repositoryURL: expectedRepositoryURL,
    sourceCommit: expectedCommit,
    provenanceOrigin,
    tarball,
    manifestSHA256: sha256(registryManifestBytes),
    currentRunID,
    currentRunAttempt,
    publishPerformed: publishState[package_.name],
    workflowPath: expectedWorkflowPath,
  });
  const adoptionName = `npm-release-adoption-${package_.id}-${currentRunID}-${currentRunAttempt}.json`;
  await writeFile(join(ARTIFACTS_PATH, adoptionName), jsonBytes(adoption), { mode: 0o600 });
  adoptionNames.push(adoptionName);
}
if (typeof process.env.GITHUB_OUTPUT === "string") {
  await appendFile(process.env.GITHUB_OUTPUT, [
    `adoption_asset_count=${adoptionNames.length}`,
    `adoption_run_id=${currentRunID}`,
    `adoption_run_attempt=${currentRunAttempt}`,
    "",
  ].join("\n"), { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({
  ...postPublishEvidence,
  adoption_assets: adoptionNames,
}, null, 2)}\n`);

function parsePublishState(source) {
  let value;
  try {
    value = parseStrictJSONBytes(
      Buffer.from(source, "utf8"),
      "PUBLISH_STATE_JSON",
      MAXIMUM_PUBLISH_STATE_BYTES,
    );
  } catch (error) {
    throw new Error("PUBLISH_STATE_JSON must be strict bounded JSON.", { cause: error });
  }
  const names = packages.map(({ name }) => name);
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...names].sort())
    || names.some((name) => typeof value[name] !== "boolean")
  ) {
    throw new Error("PUBLISH_STATE_JSON must contain one Boolean for every release package.");
  }
  return value;
}

function assertPackageEvidence(package_, evidence) {
  if (
    evidence?.id !== package_.id
    || evidence.package !== package_.name
    || evidence.version !== package_.manifest.version
    || evidence.tarball !== package_.archiveName
    || !/^[0-9a-f]{40}$/u.test(evidence.sha1 ?? "")
    || !/^[0-9a-f]{64}$/u.test(evidence.sha256 ?? "")
    || !/^[0-9a-f]{128}$/u.test(evidence.sha512 ?? "")
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(evidence.integrity ?? "")
    || !Number.isSafeInteger(evidence.bytes)
    || evidence.bytes < 1
    || evidence.bytes > 10 * 1024 * 1024
    || !Array.isArray(evidence.entries)
  ) {
    throw new Error(`Package-set evidence does not bind ${package_.name}.`);
  }
}

async function waitForPublishedMetadata(package_, evidence) {
  const url = packageVersionURL(package_.name, package_.manifest.version);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const result = await fetchBytes(url, { maximumBytes: 2 * 1024 * 1024 });
    if (result.response.status === 200) {
      const value = assertSafeRetainedOutput(
        result.bytes,
        `${package_.name} npm registry version output`,
        2 * 1024 * 1024,
      );
      if (
        value.name !== package_.name
        || value.version !== package_.manifest.version
        || value.dist?.integrity !== evidence.integrity
        || value.dist?.shasum !== evidence.sha1
      ) {
        throw new Error(`${package_.name} registry metadata differs from the reviewed archive.`);
      }
      if (value.dist?.attestations?.provenance?.predicateType === PROVENANCE_TYPE) {
        return { value, bytes: result.bytes };
      }
    } else if (result.response.status !== 404) {
      throw new Error(`${package_.name} publication verification failed with HTTP ${result.response.status}.`);
    }
    await sleep(5_000);
  }
  throw new Error(`${package_.name} and its provenance did not become visible within two minutes.`);
}

function assertPublishedMetadata(package_, evidence, value) {
  const manifest = expectedPublishedManifest(package_);
  if (
    value.name !== package_.name
    || value.version !== package_.manifest.version
    || !isDeepStrictEqual(value.exports, manifest.exports)
    || !isDeepStrictEqual(value.repository, manifest.repository)
    || !isDeepStrictEqual(value.peerDependencies ?? {}, manifest.peerDependencies ?? {})
    || value._nodeVersion !== "24.19.0"
    || value.dist?.integrity !== evidence.integrity
    || value.dist?.shasum !== evidence.sha1
    || !Array.isArray(value.dist?.signatures)
    || value.dist.signatures.length === 0
    || value.dist?.attestations?.provenance?.predicateType !== PROVENANCE_TYPE
    || value._npmUser?.trustedPublisher?.id !== "github"
  ) {
    throw new Error(`${package_.name} metadata is missing exact exports, peers, signature, or trusted-publisher state.`);
  }
}

function assertNpmView(package_, evidence, value) {
  const repository = typeof value.repository === "object" ? value.repository?.url : value.repository;
  if (
    value.name !== package_.name
    || value.version !== package_.manifest.version
    || value.dist?.integrity !== evidence.integrity
    || value.dist?.shasum !== evidence.sha1
    || !Array.isArray(value.dist?.signatures)
    || value.dist.signatures.length === 0
    || value.dist?.attestations?.provenance?.predicateType !== PROVENANCE_TYPE
    || normalizeRepository(repository) !== normalizeRepository(package_.manifest.repository.url)
  ) {
    throw new Error(`npm view did not return exact signed ${package_.name} coordinates.`);
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
  const bytes = decodeBase64Strict(
    envelope.payload,
    "The npm attestation statement",
    MAXIMUM_STATEMENT_BYTES,
  );
  return parseStrictJSONBytes(bytes, "The npm attestation statement", MAXIMUM_STATEMENT_BYTES);
}

function verifyWorkflowCertificate(attestation, repositoryURL, workflowPath) {
  const certificateBytes = attestation?.bundle?.verificationMaterial?.certificate?.rawBytes;
  if (typeof certificateBytes !== "string") throw new Error("The provenance bundle is missing its signing certificate.");
  const certificate = new X509Certificate(decodeBase64Strict(
    certificateBytes,
    "The provenance signing certificate",
    MAXIMUM_CERTIFICATE_BYTES,
  ));
  const expectedIdentity = `URI:${repositoryURL}/${workflowPath}@${SOURCE_REF}`;
  if (certificate.subjectAltName !== expectedIdentity) {
    throw new Error("The provenance signing certificate has an unexpected workflow identity.");
  }
}

async function verifyCleanRegistryConsumer(package_, evidence) {
  const consumer = await mkdtemp(join(tmpdir(), `latchway-registry-consumer-${package_.id}-`));
  try {
    const npmrc = join(consumer, ".npmrc");
    await writeFile(npmrc, `registry=${REGISTRY_URL}\n${SCOPE_REGISTRY_CONFIG}\naudit=false\nfund=false\nupdate-notifier=false\n`, { mode: 0o600 });
    const publishedManifest = expectedPublishedManifest(package_);
    const dependencies = { [package_.name]: package_.manifest.version };
    if (package_.id !== "client") dependencies["@latchway/client"] = package_.manifest.version;
    for (const [name, version] of Object.entries(publishedManifest.peerDependencies ?? {})) {
      if (!name.startsWith("@latchway/")) dependencies[name] = version;
    }
    await writeFile(join(consumer, "package.json"), `${JSON.stringify({
      name: `latchway-${package_.id}-registry-consumer`,
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies,
    }, null, 2)}\n`);
    runNpm([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      "--engine-strict=false",
      `--registry=${REGISTRY_URL}`,
      SCOPE_REGISTRY_ARGUMENT,
    ], consumer, `${package_.name} clean registry install`, npmrc);
    const lock = readBoundedStrictJSONFileSync(
      join(consumer, "package-lock.json"),
      `${package_.name} clean registry package lock`,
      MAXIMUM_PACKAGE_LOCK_BYTES,
    );
    const installed = lock.packages?.[`node_modules/${package_.name}`];
    if (installed?.version !== package_.manifest.version || installed.integrity !== evidence.integrity) {
      throw new Error(`${package_.name} clean registry consumer did not lock exact published integrity.`);
    }
    if (package_.id !== "client") {
      const client = lock.packages?.["node_modules/@latchway/client"];
      if (client?.version !== package_.manifest.version) {
        throw new Error(`${package_.name} clean registry consumer did not pin the matching client version.`);
      }
    }
    await writeFile(join(consumer, "consumer.mjs"), `import assert from "node:assert/strict";\n${package_.runtimeExports.map(
      ([specifier, exported], index) => `import { ${exported} as exported${index} } from ${JSON.stringify(specifier)};`,
    ).join("\n")}\nfor (const exported of [${package_.runtimeExports.map((_, index) => `exported${index}`).join(", ")}]) assert.equal(typeof exported, "function");\n`);
    const runtime = spawnSync(process.execPath, [join(consumer, "consumer.mjs")], {
      cwd: consumer,
      env: sanitizedEnvironment(npmrc, join(consumer, ".npm-cache")),
      encoding: "buffer",
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: MAXIMUM_RUNTIME_COMMAND_MILLISECONDS,
    });
    if (runtime.error !== undefined || runtime.status !== 0) {
      throw new Error(`${package_.name} clean registry ESM consumer failed.`);
    }
    const auditBytes = runNpmCaptured(
      [
        "audit",
        "signatures",
        "--json",
        `--registry=${REGISTRY_URL}`,
        SCOPE_REGISTRY_ARGUMENT,
      ],
      consumer,
      2 * 1024 * 1024,
      `${package_.name} npm audit signatures`,
      npmrc,
    );
    return {
      auditBytes,
      evidence: {
        isolated_directory: true,
        install_scripts: "disabled",
        exact_package_version: package_.manifest.version,
        matching_client_version: package_.id === "client" ? null : package_.manifest.version,
        external_peer_dependencies: Object.fromEntries(
          Object.entries(dependencies).filter(([name]) => name !== package_.name && name !== "@latchway/client"),
        ),
        node_esm: true,
        registry_signatures: true,
      },
    };
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

function runNpm(arguments_, cwd, operation, userconfig) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, arguments_, {
    cwd,
    env: sanitizedEnvironment(
      userconfig,
      userconfig === undefined
        ? process.env.NPM_CONFIG_CACHE ?? join(tmpdir(), `latchway-npm-read-cache-${process.pid}`)
        : join(cwd, ".npm-cache"),
    ),
    encoding: "buffer",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: MAXIMUM_NPM_COMMAND_MILLISECONDS,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${operation} failed during published-package verification.`);
  }
}

function runNpmCaptured(arguments_, cwd, maximumBytes, operation, userconfig) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, arguments_, {
    cwd,
    env: sanitizedEnvironment(
      userconfig,
      userconfig === undefined
        ? process.env.NPM_CONFIG_CACHE ?? join(tmpdir(), `latchway-npm-read-cache-${process.pid}`)
        : join(cwd, ".npm-cache"),
    ),
    encoding: "buffer",
    maxBuffer: maximumBytes,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: MAXIMUM_NPM_COMMAND_MILLISECONDS,
  });
  if (result.error !== undefined || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(`${operation} failed during published-package verification.`);
  }
  if (result.stdout.byteLength === 0 || result.stdout.byteLength > maximumBytes) {
    throw new Error(`${operation} returned an invalid amount of retained output.`);
  }
  return result.stdout;
}

function sanitizedEnvironment(userconfig, cache) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => {
    const normalized = name.toLowerCase();
    return normalized !== "node_auth_token"
      && normalized !== "npm_token"
      && normalized !== "npm_config_registry"
      && normalized !== "npm_config_@latchway:registry"
      && !(normalized.startsWith("npm_config_") && normalized.includes("auth"));
  }));
  const isolatedConfig = userconfig ?? join(tmpdir(), "latchway-empty-release.npmrc");
  environment.NPM_CONFIG_USERCONFIG = isolatedConfig;
  environment.NPM_CONFIG_GLOBALCONFIG = `${isolatedConfig}.global`;
  environment.NPM_CONFIG_CACHE = cache;
  return environment;
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
