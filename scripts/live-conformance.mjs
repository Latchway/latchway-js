#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { LatchwayError, errorFromResponse } from "../dist/index.js";
import { createCustomAttestationProvider, createNodeLatchwayClient } from "../dist/node.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const RESOURCE = /^app_[0-9A-HJKMNP-TV-Z]{26}$/u;
const FEATURE = /^[a-z][a-z0-9_-]{0,62}$/u;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const ATTESTATION_TOKEN_ENVIRONMENT = new Map([
  ["firebase_app_check", "LATCHWAY_LIVE_SDK_FIREBASE_APP_CHECK_TOKEN"],
  ["turnstile", "LATCHWAY_LIVE_SDK_TURNSTILE_TOKEN"],
]);
const REPOSITORIES = ["core", "javascript", "ios", "android", "react_native"];
const REQUIRED_TESTS = [
  "dpop_authorized_request",
  "dpop_replay_rejected",
  "tampered_dpop_rejected",
  "canonical_error_mapping",
  "session_refresh_rotation",
  "protocol_version_rejection",
  "streamed_request",
  "quota",
  "installation_revocation",
];

export function parseCandidateManifest(value, gateway) {
  exact(value, ["schema_version", "kind", "candidate", "gateway_origin"], "candidate manifest");
  if (value.schema_version !== 1 || value.kind !== "latchway_live_sdk_candidate" ||
      value.gateway_origin !== gateway || !isHTTPSOrigin(gateway)) {
    throw new Error("candidate_manifest_identity_invalid");
  }
  const candidate = value.candidate;
  exact(candidate, [
    "core_commit", "core_release", "contract_version", "bundle_sha256",
    "oci_image_digest", "repositories",
  ], "candidate identity");
  if (!COMMIT.test(candidate.core_commit) || candidate.core_release !== `v${candidate.repositories?.core?.version ?? ""}` ||
      !SEMVER.test(candidate.contract_version) || !SHA256.test(candidate.bundle_sha256) ||
      !/^ghcr\.io\/latchway\/latchway@sha256:[0-9a-f]{64}$/u.test(candidate.oci_image_digest)) {
    throw new Error("candidate_manifest_identity_invalid");
  }
  exact(candidate.repositories, REPOSITORIES, "candidate repositories");
  for (const repository of REPOSITORIES) {
    const coordinate = candidate.repositories[repository];
    exact(coordinate, ["commit", "tag", "version"], `${repository} coordinate`);
    if (!COMMIT.test(coordinate.commit) || !SEMVER.test(coordinate.version) || coordinate.tag !== `v${coordinate.version}`) {
      throw new Error("candidate_manifest_identity_invalid");
    }
  }
  if (candidate.repositories.core.commit !== candidate.core_commit) {
    throw new Error("candidate_manifest_identity_invalid");
  }
  return candidate;
}

export function liveConfiguration(environment, attestationProvider) {
  const required = (name) => {
    const value = environment[name];
    if (typeof value !== "string" || value.length === 0 || value.length > 16_384 || value.includes("\0")) {
      throw new Error(`live_configuration_missing:${name}`);
    }
    return value;
  };
  const applicationID = required("LATCHWAY_LIVE_SDK_APPLICATION_ID");
  const feature = required("LATCHWAY_LIVE_SDK_FEATURE");
  const errorMappingFeature = required("LATCHWAY_LIVE_SDK_ERROR_MAPPING_FEATURE");
  const attestationTokenEnvironment = ATTESTATION_TOKEN_ENVIRONMENT.get(attestationProvider);
  if (!RESOURCE.test(applicationID) || !FEATURE.test(feature) || !FEATURE.test(errorMappingFeature) ||
      feature === errorMappingFeature || !FEATURE.test(required("LATCHWAY_LIVE_SDK_ENVIRONMENT")) ||
      !FEATURE.test(required("LATCHWAY_LIVE_SDK_IDENTITY_PROVIDER")) ||
      !MODEL.test(required("LATCHWAY_LIVE_SDK_MODEL")) ||
      attestationTokenEnvironment === undefined) {
    throw new Error("live_configuration_invalid");
  }
  return {
    applicationID,
    feature,
    errorMappingFeature,
    provider: attestationProvider,
    environment: required("LATCHWAY_LIVE_SDK_ENVIRONMENT"),
    identityProvider: required("LATCHWAY_LIVE_SDK_IDENTITY_PROVIDER"),
    model: required("LATCHWAY_LIVE_SDK_MODEL"),
    identityToken: required("LATCHWAY_LIVE_SDK_IDENTITY_TOKEN"),
    attestationToken: required(attestationTokenEnvironment),
  };
}

export function verifyCheckout(expectedCommit, runner = spawnSync) {
  const safeEnvironment = Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "TMPDIR"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]),
  );
  const head = runner("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: ROOT, encoding: "utf8", env: safeEnvironment, shell: false,
  });
  const status = runner("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: ROOT, encoding: "utf8", env: safeEnvironment, shell: false,
  });
  if (head.status !== 0 || status.status !== 0 || head.stdout.trim() !== expectedCommit || status.stdout !== "") {
    throw new Error("javascript_checkout_identity_invalid");
  }
}

export function validateReport(report, candidate, gateway, expectedAttestationProvider) {
  exact(report, [
    "schema_version", "kind", "platform", "attestation_provider", "candidate", "gateway", "tests", "redaction",
  ], "report");
  if (report.schema_version !== 1 || report.kind !== "latchway_live_javascript_observation" ||
      report.platform !== "javascript" || report.attestation_provider !== expectedAttestationProvider ||
      !ATTESTATION_TOKEN_ENVIRONMENT.has(report.attestation_provider) ||
      JSON.stringify(report.candidate) !== JSON.stringify(candidate)) {
    throw new Error("live_report_identity_invalid");
  }
  exact(report.gateway, ["origin", "status", "build"], "gateway result");
  exact(report.gateway.build, ["version", "commit", "build_date", "contract_version", "protocol_version"], "gateway build");
  if (report.gateway.origin !== gateway || report.gateway.status !== "ok" ||
      report.gateway.build.commit !== candidate.core_commit ||
      report.gateway.build.version !== candidate.repositories.core.version ||
      report.gateway.build.contract_version !== candidate.contract_version ||
      report.gateway.build.protocol_version !== "1") {
    throw new Error("live_report_gateway_identity_invalid");
  }
  if (!Array.isArray(report.tests) || report.tests.length !== REQUIRED_TESTS.length ||
      JSON.stringify(report.tests.map((test) => test.id)) !== JSON.stringify(REQUIRED_TESTS) ||
      report.tests.some((test) => test.status !== "passed")) {
    throw new Error("live_report_test_set_invalid");
  }
  validateConcreteTests(report.tests);
  const redactionKeys = [
    "identity_token_recorded", "attestation_token_recorded", "access_token_recorded",
    "refresh_token_recorded", "dpop_proof_recorded", "private_key_recorded",
  ];
  exact(report.redaction, redactionKeys, "redaction");
  if (redactionKeys.some((name) => report.redaction[name] !== false) || secretShaped(JSON.stringify(report))) {
    throw new Error("live_report_secret_or_redaction_invalid");
  }
  return report;
}

function validateConcreteTests(tests) {
  const byID = Object.fromEntries(tests.map((test) => [test.id, test]));
  for (const [id, status, code] of [
    ["dpop_replay_rejected", 401, "dpop_replayed"],
    ["tampered_dpop_rejected", 401, "dpop_invalid"],
    ["canonical_error_mapping", 404, "feature_not_found"],
    ["installation_revocation", 403, "installation_revoked"],
    ["protocol_version_rejection", 426, "protocol_version_unsupported"],
  ]) {
    const test = byID[id];
    if (test.http_status !== status || test.error_code !== code || !REQUEST_ID.test(test.request_id ?? "")) {
      throw new Error(`live_report_${id}_invalid`);
    }
  }
  if (byID.canonical_error_mapping.mapped_error_type !== "javascript_latchway_error" ||
      byID.protocol_version_rejection.protocol_version_sent !== 0) {
    throw new Error("live_report_typed_semantics_invalid");
  }
  const rotation = byID.session_refresh_rotation;
  const hashes = [
    rotation.credential_before_sha256, rotation.credential_after_sha256,
    rotation.installation_before_sha256, rotation.installation_after_sha256,
  ];
  if (hashes.some((value) => !SHA256.test(value ?? "")) || hashes[0] === hashes[1] || hashes[2] !== hashes[3]) {
    throw new Error("live_report_rotation_invalid");
  }
  if (!(byID.dpop_authorized_request.http_status >= 200 && byID.dpop_authorized_request.http_status < 300) ||
      !REQUEST_ID.test(byID.dpop_authorized_request.request_id ?? "") ||
      !(byID.streamed_request.byte_count > 0 && byID.streamed_request.byte_count <= 1_048_576) ||
      !REQUEST_ID.test(byID.streamed_request.request_id ?? "") ||
      byID.quota.limit_count < 1 || !Array.isArray(byID.quota.metrics) || byID.quota.metrics.length < 1) {
    throw new Error("live_report_positive_semantics_invalid");
  }
}

export async function runLive({ candidate, gateway, config, fetchImplementation = fetch }) {
  const provider = createCustomAttestationProvider({
    provider: config.provider,
    getEvidence: async () => ({ token: config.attestationToken }),
  });
  const client = createNodeLatchwayClient({
    baseURL: gateway,
    applicationID: config.applicationID,
    environment: config.environment,
    identityProvider: config.identityProvider,
    identityTokenProvider: { getIdentityToken: async () => config.identityToken },
    attestationProviders: [provider],
    installation: { appVersion: candidate.repositories.javascript.version },
    fetch: fetchImplementation,
  });
  const healthResponse = await fetchImplementation(new URL("/healthz", gateway), {
    method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
  });
  const health = await boundedJSON(healthResponse, 65_536);
  exact(health, ["status", "build"], "gateway health");
  const quotaURL = new URL(`/client/v1/features/${encodeURIComponent(config.feature)}/quota`, gateway);
  const probe = new globalThis.Request(quotaURL, { method: "GET", headers: { Accept: "application/json" } });
  const tests = [];

  const authorized = await client.authorize(probe, config.feature);
  const first = await safeHTTP(await fetchImplementation(authorized), 65_536);
  tests.push(httpTest("dpop_authorized_request", first, first.status >= 200 && first.status < 300));
  const replay = await safeHTTP(await fetchImplementation(authorized), 65_536);
  tests.push(httpTest("dpop_replay_rejected", replay, replay.status === 401 && replay.errorCode === "dpop_replayed"));
  const tampered = await client.authorize(probe, config.feature);
  const tamperedHeaders = new globalThis.Headers(tampered.headers);
  tamperedHeaders.set("DPoP", tamperedDPoP(tamperedHeaders.get("DPoP")));
  const tamper = await safeHTTP(await fetchImplementation(new globalThis.Request(tampered, { headers: tamperedHeaders })), 65_536);
  tests.push(httpTest("tampered_dpop_rejected", tamper, tamper.status === 401 && tamper.errorCode === "dpop_invalid"));

  try {
    await client.quota(config.errorMappingFeature);
    tests.push({ id: "canonical_error_mapping", status: "failed" });
  } catch (error) {
    tests.push({
      id: "canonical_error_mapping",
      status: error instanceof LatchwayError && error.code === "feature_not_found" && error.status === 404 &&
        REQUEST_ID.test(error.requestID ?? "") ? "passed" : "failed",
      ...(error instanceof LatchwayError ? {
        http_status: error.status,
        error_code: error.code,
        request_id: error.requestID,
        mapped_error_type: "javascript_latchway_error",
      } : {}),
    });
  }

  const before = await client.authorize(probe, config.feature);
  const beforeDiagnostics = await client.diagnostics();
  await client.refresh();
  const after = await client.authorize(probe, config.feature);
  const afterDiagnostics = await client.diagnostics();
  for (const diagnostics of [beforeDiagnostics, afterDiagnostics]) {
    if (diagnostics.client.sdkVersion !== candidate.repositories.javascript.version ||
        diagnostics.client.contractVersion !== candidate.contract_version ||
        diagnostics.client.protocolVersion !== 1 || diagnostics.client.platform !== "node" ||
        diagnostics.server.contract_version !== candidate.contract_version ||
        diagnostics.server.protocol_version !== 1) {
      throw new Error("live_javascript_runtime_identity_invalid");
    }
  }
  tests.push({
    id: "session_refresh_rotation",
    status: hashHeader(before) !== hashHeader(after) &&
      hash(beforeDiagnostics.server.installation.id) === hash(afterDiagnostics.server.installation.id) ? "passed" : "failed",
    credential_before_sha256: hashHeader(before),
    credential_after_sha256: hashHeader(after),
    installation_before_sha256: hash(beforeDiagnostics.server.installation.id),
    installation_after_sha256: hash(afterDiagnostics.server.installation.id),
  });

  const unsupported = await client.authorize(probe, config.feature);
  const unsupportedHeaders = new globalThis.Headers(unsupported.headers);
  unsupportedHeaders.set("X-Latchway-Protocol-Version", "0");
  const protocol = await safeHTTP(await fetchImplementation(new globalThis.Request(unsupported, { headers: unsupportedHeaders })), 65_536);
  tests.push({
    ...httpTest("protocol_version_rejection", protocol, protocol.status === 426 && protocol.errorCode === "protocol_version_unsupported"),
    protocol_version_sent: 0,
  });

  const streamResponse = await client.fetch("/v1/chat/completions", {
    method: "POST",
    latchwayFeature: config.feature,
    headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: "Return only the word conformance." }],
      stream: true,
    }),
  });
  const streamedBytes = await readBounded(streamResponse, 1_048_576);
  tests.push({
    id: "streamed_request",
    status: streamResponse.ok && streamedBytes > 0 && REQUEST_ID.test(streamResponse.headers.get("X-Latchway-Request-ID") ?? "")
      ? "passed" : "failed",
    http_status: streamResponse.status,
    byte_count: streamedBytes,
    request_id: streamResponse.headers.get("X-Latchway-Request-ID"),
  });
  const quota = await client.quota(config.feature);
  tests.push({
    id: "quota",
    status: quota.feature === config.feature && quota.limits.length > 0 ? "passed" : "failed",
    feature: quota.feature,
    limit_count: quota.limits.length,
    metrics: [...new Set(quota.limits.map((limit) => limit.metric))].sort(),
  });

  const pending = await client.authorize(probe, config.feature);
  await client.revokeCurrentInstallation();
  const revoked = await safeHTTP(await fetchImplementation(pending), 65_536);
  tests.push(httpTest("installation_revocation", revoked, revoked.status === 403 && revoked.errorCode === "installation_revoked"));

  return {
    schema_version: 1,
    kind: "latchway_live_javascript_observation",
    platform: "javascript",
    attestation_provider: config.provider,
    candidate,
    gateway: { origin: gateway, status: health.status, build: health.build },
    tests,
    redaction: {
      identity_token_recorded: false,
      attestation_token_recorded: false,
      access_token_recorded: false,
      refresh_token_recorded: false,
      dpop_proof_recorded: false,
      private_key_recorded: false,
    },
  };
}

function httpTest(id, response, passed) {
  return {
    id,
    status: passed ? "passed" : "failed",
    http_status: response.status,
    ...(response.errorCode === undefined ? {} : { error_code: response.errorCode }),
    ...(response.requestID === undefined ? {} : { request_id: response.requestID }),
  };
}

async function safeHTTP(response, maximumBytes) {
  const error = response.ok ? undefined : await errorFromResponse(response.clone());
  await readBounded(response, maximumBytes);
  const requestID = REQUEST_ID.test(response.headers.get("X-Latchway-Request-ID") ?? "")
    ? response.headers.get("X-Latchway-Request-ID") : undefined;
  return {
    status: response.status,
    ...(error === undefined || error.code === "protocol_response_invalid" ? {} : { errorCode: error.code }),
    ...(requestID === null || requestID === undefined ? {} : { requestID }),
  };
}

async function boundedJSON(response, maximumBytes) {
  if (!response.ok || response.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new Error("gateway_health_invalid");
  }
  const bytes = await readBoundedBytes(response, maximumBytes);
  return JSON.parse(new globalThis.TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function readBounded(response, maximumBytes) {
  return (await readBoundedBytes(response, maximumBytes)).byteLength;
}

async function readBoundedBytes(response, maximumBytes) {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("live conformance response bound exceeded");
        throw new Error("live_response_too_large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function hashHeader(request) {
  const authorization = request.headers.get("Authorization");
  if (authorization === null || !authorization.startsWith("DPoP ") || authorization.length < 37) {
    throw new Error("live_authorization_invalid");
  }
  return hash(authorization);
}

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tamperedDPoP(value) {
  const segments = value?.split(".");
  if (segments?.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new Error("live_dpop_invalid");
  }
  const signature = segments[2];
  return `${segments[0]}.${segments[1]}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
}

function exact(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label.replaceAll(" ", "_")}_fields_invalid`);
  }
}

function isHTTPSOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function secretShaped(value) {
  return /(?:Bearer|DPoP)\s+[A-Za-z0-9._~-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.|(?:lwa_|lws_)[A-Za-z0-9_-]{16,}/iu.test(value);
}

function parseArguments(argv) {
  if (argv.length !== 6 || argv[0] !== "--candidate-manifest" || argv[2] !== "--gateway" ||
      argv[4] !== "--attestation-provider" || !ATTESTATION_TOKEN_ENVIRONMENT.has(argv[5])) {
    throw new Error("live_arguments_invalid");
  }
  return { manifest: resolve(argv[1]), gateway: argv[3], attestationProvider: argv[5] };
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const argumentsValue = parseArguments(argv);
  const manifest = JSON.parse(readFileSync(argumentsValue.manifest, "utf8"));
  const candidate = parseCandidateManifest(manifest, argumentsValue.gateway);
  verifyCheckout(candidate.repositories.javascript.commit);
  const config = liveConfiguration(environment, argumentsValue.attestationProvider);
  const report = await runLive({ candidate, gateway: argumentsValue.gateway, config });
  validateReport(report, candidate, argumentsValue.gateway, argumentsValue.attestationProvider);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof Error && /^[a-z0-9_:.-]{1,160}$/u.test(error.message)
      ? error.message : "live_conformance_failed";
    process.stderr.write(`live JavaScript conformance rejected: ${code}\n`);
    process.exitCode = 1;
  });
}
