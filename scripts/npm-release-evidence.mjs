import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { TextDecoder } from "node:util";

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
const MAXIMUM_JSON_DEPTH = 64;
const JSON_WHITESPACE = new Set([" ", "\t", "\r", "\n"]);
const JSON_STRING_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const CREDENTIAL_PATTERNS = Object.freeze([
  /(?:^|\n)\/\/registry\.npmjs\.org\/:_authToken\s*=/iu,
  /\b(?:npm_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/iu,
]);

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseStrictJSONBytes(bytes, label, maximumBytes) {
  if (
    !Buffer.isBuffer(bytes)
    || typeof label !== "string"
    || label.length === 0
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1
    || bytes.byteLength === 0
    || bytes.byteLength > maximumBytes
  ) {
    throw new Error(`${label} has an invalid JSON byte length.`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
  scanStrictJSON(text, label);
  return JSON.parse(text, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite JSON number.`);
    }
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`${label} contains an unsafe JSON integer.`);
    }
    return value;
  });
}

export function readBoundedStrictJSONFileSync(path, label, maximumBytes) {
  return parseStrictJSONBytes(
    readBoundedFileSync(path, label, maximumBytes),
    label,
    maximumBytes,
  );
}

export function readBoundedFileSync(path, label, maximumBytes) {
  if (
    typeof label !== "string"
    || label.length === 0
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1
  ) {
    throw new Error("Bounded file reader received an invalid limit.");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile()
      || !Number.isSafeInteger(metadata.size)
      || metadata.size < 1
      || metadata.size > maximumBytes
    ) {
      throw new Error(`${label} has an invalid file byte length.`);
    }
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) throw new Error(`${label} changed while it was read.`);
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) {
      throw new Error(`${label} changed while it was read.`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function decodeBase64Strict(encoded, label, maximumBytes) {
  if (
    typeof encoded !== "string"
    || typeof label !== "string"
    || label.length === 0
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1
    || encoded.length === 0
    || encoded.length > 4 * Math.ceil(maximumBytes / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  ) {
    throw new Error(`${label} has malformed or oversized base64 encoding.`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.byteLength === 0
    || bytes.byteLength > maximumBytes
    || bytes.toString("base64") !== encoded
  ) {
    throw new Error(`${label} has malformed or oversized base64 encoding.`);
  }
  return bytes;
}

export function npmReleaseArtifactName(version, runID, runAttempt) {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw new Error("The npm release artifact version is invalid.");
  }
  for (const [name, value] of [["run ID", runID], ["run attempt", runAttempt]]) {
    if (
      typeof value !== "string"
      || !/^[1-9]\d*$/u.test(value)
      || !Number.isSafeInteger(Number(value))
    ) {
      throw new Error(`The npm release artifact ${name} is invalid or unbounded.`);
    }
  }
  return `npm-release-set-${version}-${runID}-${runAttempt}`;
}

export function assertSafeRetainedOutput(bytes, label, maximumBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} has an invalid retained-output size.`);
  }
  const value = parseStrictJSONBytes(bytes, label, maximumBytes);
  const text = bytes.toString("utf8");
  if (containsCredentialLikeMaterial(text) || containsCredentialLikeJSONValue(value)) {
    throw new Error(`${label} contains credential-like material and cannot be retained.`);
  }
  return value;
}

export function parseProvenanceOrigin(invocationID, expectedRepositoryURL) {
  if (typeof invocationID !== "string") throw new Error("The npm provenance invocation identifier is missing.");
  const prefix = `${expectedRepositoryURL}/actions/runs/`;
  if (!invocationID.startsWith(prefix)) throw new Error("The npm provenance invocation repository is unexpected.");
  const match = /^([1-9]\d*)\/attempts\/([1-9]\d*)$/u.exec(invocationID.slice(prefix.length));
  if (match === null) throw new Error("The npm provenance invocation identifier is malformed.");
  const runID = Number(match[1]);
  const runAttempt = Number(match[2]);
  if (!Number.isSafeInteger(runID) || !Number.isSafeInteger(runAttempt)) {
    throw new Error("The npm provenance invocation identifier is unbounded.");
  }
  return {
    invocation_id: invocationID,
    run_id: runID,
    run_attempt: runAttempt,
  };
}

export function verifyProvenanceStatement(statement, {
  packageName,
  packageVersion,
  sha512,
  expectedRepositoryURL,
  expectedCommit,
  expectedEvent,
  expectedWorkflowPath = WORKFLOW_PATH,
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
    || workflow?.path !== expectedWorkflowPath
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

export function normalizePublishStateForConsumerAttempt(
  publishState,
  { producerRunID, producerRunAttempt, currentRunID, currentRunAttempt },
) {
  const coordinates = [producerRunID, producerRunAttempt, currentRunID, currentRunAttempt];
  if (
    publishState === null
    || typeof publishState !== "object"
    || Array.isArray(publishState)
    || Object.values(publishState).some((value) => typeof value !== "boolean")
    || coordinates.some((value) => !Number.isSafeInteger(value) || value < 1)
    || producerRunID !== currentRunID
    || producerRunAttempt > currentRunAttempt
  ) {
    throw new Error("The npm publication state is not bound to a valid producer workflow attempt.");
  }
  const sameAttempt = producerRunAttempt === currentRunAttempt;
  return Object.fromEntries(Object.entries(publishState).map(
    ([name, performed]) => [name, sameAttempt && performed],
  ));
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
  workflowPath = WORKFLOW_PATH,
}) {
  const binding = {
    repository: repositoryURL,
    commit: sourceCommit,
    workflow: workflowPath,
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

function scanStrictJSON(text, label) {
  let index = 0;

  function fail() {
    throw new Error(`${label} is not strict JSON.`);
  }

  function skipWhitespace() {
    while (JSON_WHITESPACE.has(text[index])) index += 1;
  }

  function parseString() {
    if (text[index] !== '"') fail();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (character.charCodeAt(0) < 0x20) fail();
      if (character === "\\") {
        index += 1;
        const escape = text[index];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(index + 1, index + 5))) fail();
          index += 5;
          continue;
        }
        if (!JSON_STRING_ESCAPES.has(escape)) fail();
      }
      index += 1;
    }
    fail();
  }

  function parseNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(index));
    if (match === null) fail();
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite JSON number.`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`${label} contains an unsafe JSON integer.`);
    }
    index += match[0].length;
  }

  function parseObject(depth) {
    if (depth >= MAXIMUM_JSON_DEPTH) {
      throw new Error(`${label} exceeds the JSON nesting limit.`);
    }
    index += 1;
    skipWhitespace();
    const keys = new Set();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    while (index < text.length) {
      const key = parseString();
      if (keys.has(key)) throw new Error(`${label} contains a duplicate JSON key.`);
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") fail();
      index += 1;
      parseValue(depth + 1);
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      if (text[index] !== ",") fail();
      index += 1;
      skipWhitespace();
    }
    fail();
  }

  function parseArray(depth) {
    if (depth >= MAXIMUM_JSON_DEPTH) {
      throw new Error(`${label} exceeds the JSON nesting limit.`);
    }
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (index < text.length) {
      parseValue(depth + 1);
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      if (text[index] !== ",") fail();
      index += 1;
      skipWhitespace();
    }
    fail();
  }

  function parseValue(depth) {
    skipWhitespace();
    const character = text[index];
    if (character === "{") parseObject(depth);
    else if (character === "[") parseArray(depth);
    else if (character === '"') parseString();
    else if (text.startsWith("true", index)) index += 4;
    else if (text.startsWith("false", index)) index += 5;
    else if (text.startsWith("null", index)) index += 4;
    else parseNumber();
  }

  parseValue(0);
  skipWhitespace();
  if (index !== text.length) fail();
}

function containsCredentialLikeMaterial(value) {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

function containsCredentialLikeJSONValue(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (containsCredentialLikeMaterial(current)) return true;
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      pending.push(key, item);
    }
  }
  return false;
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
