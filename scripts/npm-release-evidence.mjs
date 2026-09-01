import { createHash } from "node:crypto";

export const PROVENANCE_TYPE = "https://slsa.dev/provenance/v1";
export const PUBLISH_TYPE = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
export const WORKFLOW_PATH = ".github/workflows/release.yml";
export const SOURCE_REF = "refs/heads/main";
const RELEASE_PACKAGE_ORDER = Object.freeze([
  Object.freeze({ id: "client", name: "@latchway/client" }),
  Object.freeze({ id: "openai", name: "@latchway/openai" }),
  Object.freeze({ id: "vercel-ai", name: "@latchway/vercel-ai" }),
  Object.freeze({ id: "langchain", name: "@latchway/langchain" }),
]);

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertSafeRetainedOutput(bytes, label, maximumBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} has an invalid retained-output size.`);
  }
  const text = bytes.toString("utf8");
  for (const pattern of [
    /(?:^|\n)\/\/registry\.npmjs\.org\/:_authToken\s*=/iu,
    /\b(?:npm_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})\b/u,
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/iu,
  ]) {
    if (pattern.test(text)) throw new Error(`${label} contains credential-like material and cannot be retained.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

export function parseProvenanceOrigin(invocationID, expectedRepositoryURL) {
  if (typeof invocationID !== "string") throw new Error("The npm provenance invocation identifier is missing.");
  const prefix = `${expectedRepositoryURL}/actions/runs/`;
  if (!invocationID.startsWith(prefix)) throw new Error("The npm provenance invocation repository is unexpected.");
  const match = /^([1-9]\d*)\/attempts\/([1-9]\d*)$/u.exec(invocationID.slice(prefix.length));
  if (match === null) throw new Error("The npm provenance invocation identifier is malformed.");
  return {
    invocation_id: invocationID,
    run_id: Number(match[1]),
    run_attempt: Number(match[2]),
  };
}

export function verifyProvenanceStatement(statement, {
  packageName,
  packageVersion,
  sha512,
  expectedRepositoryURL,
  expectedCommit,
  expectedEvent,
}) {
  verifySubject(statement, PROVENANCE_TYPE, "https://in-toto.io/Statement/v1", {
    packageName, packageVersion, sha512,
  });
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const resolved = statement.predicate?.buildDefinition?.resolvedDependencies;
  const github = statement.predicate?.buildDefinition?.internalParameters?.github;
  const runDetails = statement.predicate?.runDetails;
  const origin = parseProvenanceOrigin(runDetails?.metadata?.invocationId, expectedRepositoryURL);
  if (
    workflow?.repository !== expectedRepositoryURL
    || workflow?.path !== WORKFLOW_PATH
    || workflow?.ref !== SOURCE_REF
    || github?.event_name !== expectedEvent
    || !Array.isArray(resolved)
    || !resolved.some((dependency) => dependency?.uri === `git+${expectedRepositoryURL}@${expectedCommit}`
      || (dependency?.digest?.gitCommit === expectedCommit
        && (dependency?.uri === undefined || String(dependency.uri).includes(expectedRepositoryURL))))
    || runDetails?.builder?.id !== "https://github.com/actions/runner/github-hosted"
  ) {
    throw new Error("The npm provenance statement does not bind the promoted commit, workflow, event, and run.");
  }
  return origin;
}

export function requireCurrentPublicationOrigin(origin, { publishPerformed, currentRunID, currentRunAttempt }) {
  if (publishPerformed && (origin.run_id !== currentRunID || origin.run_attempt !== currentRunAttempt)) {
    throw new Error("A freshly published npm version must carry provenance from this exact workflow attempt.");
  }
}

export function verifyPublishStatement(statement, { packageName, packageVersion, sha512, registryURL }) {
  verifySubject(statement, PUBLISH_TYPE, "https://in-toto.io/Statement/v0.1", {
    packageName, packageVersion, sha512,
  });
  if (
    statement.predicate?.name !== packageName
    || statement.predicate?.version !== packageVersion
    || statement.predicate?.registry !== registryURL.replace(/\/$/u, "")
  ) {
    throw new Error("The npm publish attestation does not bind the exact package and registry.");
  }
}

export function buildRegistrySetManifest({ version, publishOrder, packages }) {
  const expectedOrder = RELEASE_PACKAGE_ORDER.map(({ name }) => name);
  if (
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)
    || !Array.isArray(publishOrder)
    || JSON.stringify(publishOrder) !== JSON.stringify(expectedOrder)
    || !Array.isArray(packages)
    || packages.length !== publishOrder.length
  ) {
    throw new Error("The npm registry package-set manifest has invalid coordinates.");
  }
  const normalized = packages.map((entry, index) => {
    const expectedPackage = RELEASE_PACKAGE_ORDER[index];
    const expectedEvidenceNames = [
      `npm-${expectedPackage.id}-registry-version.json`,
      `npm-${expectedPackage.id}-registry-view.json`,
      `npm-${expectedPackage.id}-attestations.json`,
      `npm-${expectedPackage.id}-audit-signatures.json`,
    ].sort();
    if (
      entry?.package !== publishOrder[index]
      || entry.package !== expectedPackage.name
      || entry.version !== version
      || entry.id !== expectedPackage.id
      || entry.tarball?.name !== `latchway-${expectedPackage.id}-${version}.tgz`
      || !/^[0-9a-f]{64}$/u.test(entry.tarball?.sha256 ?? "")
      || !/^[0-9a-f]{128}$/u.test(entry.tarball?.sha512 ?? "")
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.tarball?.integrity ?? "")
      || !Array.isArray(entry.evidence)
      || entry.evidence.length !== 4
    ) {
      throw new Error(`The npm registry evidence for ${String(entry?.package)} is incomplete.`);
    }
    const evidence = entry.evidence.map(({ name, bytes }) => ({
      name,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    })).sort((left, right) => left.name.localeCompare(right.name));
    if (new Set(evidence.map(({ name }) => name)).size !== evidence.length) {
      throw new Error(`The npm registry evidence for ${entry.package} contains duplicate files.`);
    }
    if (JSON.stringify(evidence.map(({ name }) => name)) !== JSON.stringify(expectedEvidenceNames)) {
      throw new Error(`The npm registry evidence closure for ${entry.package} is unexpected.`);
    }
    return {
      id: entry.id,
      package: entry.package,
      version: entry.version,
      tarball: entry.tarball,
      evidence,
    };
  });
  return {
    schema_version: 2,
    kind: "latchway_npm_registry_package_set_evidence_manifest",
    version,
    package_count: normalized.length,
    publish_order: publishOrder,
    packages: normalized,
  };
}

export function buildAdoptionRecord({
  packageName,
  packageVersion,
  releaseTag,
  repositoryURL,
  sourceCommit,
  provenanceOrigin,
  tarball,
  manifestSHA256,
  currentRunID,
  currentRunAttempt,
  publishPerformed,
  manifestName = "npm-registry-evidence-manifest.json",
}) {
  const binding = {
    repository: repositoryURL,
    commit: sourceCommit,
    workflow: WORKFLOW_PATH,
    ref: SOURCE_REF,
  };
  return {
    schema_version: 1,
    kind: "latchway_npm_release_adoption",
    package: packageName,
    version: packageVersion,
    release_tag: releaseTag,
    tarball,
    source: binding,
    provenance: {
      ...binding,
      predicate_type: PROVENANCE_TYPE,
      ...provenanceOrigin,
    },
    adoption: {
      ...binding,
      run_id: currentRunID,
      run_attempt: currentRunAttempt,
      mode: publishPerformed ? "published" : "adopted_existing",
    },
    registry_evidence_manifest: {
      file: manifestName,
      sha256: manifestSHA256,
    },
  };
}

function verifySubject(statement, predicateType, statementType, { packageName, packageVersion, sha512 }) {
  const [scope, unscopedName] = packageName.split("/");
  const expectedPURL = `pkg:npm/${encodeURIComponent(scope)}/${unscopedName}@${packageVersion}`;
  if (
    statement?._type !== statementType
    || statement.predicateType !== predicateType
    || !Array.isArray(statement.subject)
    || statement.subject.length !== 1
    || statement.subject[0]?.name !== expectedPURL
    || statement.subject[0]?.digest?.sha512 !== sha512
  ) {
    throw new Error(`The ${predicateType} attestation subject does not match the verified npm archive.`);
  }
}
