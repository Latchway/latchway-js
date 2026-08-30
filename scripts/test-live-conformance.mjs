import assert from "node:assert/strict";
import test from "node:test";

import {
  liveConfiguration,
  parseCandidateManifest,
  validateReport,
  verifyCheckout,
} from "./live-conformance.mjs";

function candidate() {
  const repositories = {};
  for (const [index, name] of ["core", "javascript", "ios", "android", "react_native"].entries()) {
    repositories[name] = { commit: String(index + 1).repeat(40), tag: "v1.0.0", version: "1.0.0" };
  }
  return {
    core_commit: "1".repeat(40),
    core_release: "v1.0.0",
    contract_version: "0.5.1",
    bundle_sha256: "a".repeat(64),
    oci_image_digest: `ghcr.io/latchway/latchway@sha256:${"b".repeat(64)}`,
    repositories,
  };
}

function report() {
  const identity = candidate();
  return {
    schema_version: 1,
    kind: "latchway_live_javascript_observation",
    platform: "javascript",
    attestation_provider: "firebase_app_check",
    candidate: identity,
    gateway: {
      origin: "https://gateway.example.com",
      status: "ok",
      build: {
        version: "1.0.0",
        commit: "1".repeat(40),
        build_date: "2026-08-29T10:00:00Z",
        contract_version: "0.5.1",
        protocol_version: "1",
      },
    },
    tests: [
      { id: "dpop_authorized_request", status: "passed", http_status: 200, request_id: "request-authorized-1234" },
      { id: "dpop_replay_rejected", status: "passed", http_status: 401, error_code: "dpop_replayed", request_id: "request-replay-1234" },
      { id: "tampered_dpop_rejected", status: "passed", http_status: 401, error_code: "dpop_invalid", request_id: "request-tamper-1234" },
      { id: "canonical_error_mapping", status: "passed", http_status: 404, error_code: "feature_not_found", request_id: "request-mapping-1234", mapped_error_type: "javascript_latchway_error" },
      { id: "session_refresh_rotation", status: "passed", credential_before_sha256: "c".repeat(64), credential_after_sha256: "d".repeat(64), installation_before_sha256: "e".repeat(64), installation_after_sha256: "e".repeat(64) },
      { id: "protocol_version_rejection", status: "passed", http_status: 426, error_code: "protocol_version_unsupported", request_id: "request-protocol-1234", protocol_version_sent: 0 },
      { id: "streamed_request", status: "passed", http_status: 200, byte_count: 42, request_id: "request-streamed-1234" },
      { id: "quota", status: "passed", feature: "assistant", limit_count: 1, metrics: ["requests"] },
      { id: "installation_revocation", status: "passed", http_status: 403, error_code: "installation_revoked", request_id: "request-revoked-1234" },
    ],
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

test("candidate manifest binds every repository, release, image, and gateway", () => {
  const identity = candidate();
  assert.deepEqual(parseCandidateManifest({
    schema_version: 1,
    kind: "latchway_live_sdk_candidate",
    candidate: identity,
    gateway_origin: "https://gateway.example.com",
  }, "https://gateway.example.com"), identity);
  const substituted = globalThis.structuredClone(identity);
  substituted.repositories.javascript.commit = "f".repeat(40);
  assert.throws(() => parseCandidateManifest({
    schema_version: 1,
    kind: "latchway_live_sdk_candidate",
    candidate: substituted,
    gateway_origin: "https://other.example.com",
  }, "https://gateway.example.com"), /candidate_manifest_identity_invalid/u);
});

test("checkout verifier runs only fixed commands and rejects substitution or dirt", () => {
  const calls = [];
  const clean = (command, argumentsValue, options) => {
    calls.push({ command, argumentsValue, options });
    return { status: 0, stdout: argumentsValue[0] === "rev-parse" ? `${"2".repeat(40)}\n` : "" };
  };
  verifyCheckout("2".repeat(40), clean);
  assert.deepEqual(calls.map((call) => [call.command, call.argumentsValue]), [
    ["git", ["rev-parse", "--verify", "HEAD"]],
    ["git", ["status", "--porcelain=v1", "--untracked-files=all"]],
  ]);
  assert.equal(calls.every((call) => call.options.shell === false), true);
  assert.throws(() => verifyCheckout("3".repeat(40), clean), /javascript_checkout_identity_invalid/u);
  assert.throws(() => verifyCheckout("2".repeat(40), (_command, argumentsValue) => ({
    status: 0,
    stdout: argumentsValue[0] === "rev-parse" ? `${"2".repeat(40)}\n` : "?? injected.js\n",
  })), /javascript_checkout_identity_invalid/u);
});

test("configuration selects only the fixed provider-specific protected token", () => {
  const environment = {
    LATCHWAY_LIVE_SDK_APPLICATION_ID: "app_01J00000000000000000000000",
    LATCHWAY_LIVE_SDK_FEATURE: "assistant",
    LATCHWAY_LIVE_SDK_ERROR_MAPPING_FEATURE: "conformance_missing",
    LATCHWAY_LIVE_SDK_ENVIRONMENT: "production",
    LATCHWAY_LIVE_SDK_IDENTITY_PROVIDER: "firebase",
    LATCHWAY_LIVE_SDK_MODEL: "openai/gpt-5-mini",
    LATCHWAY_LIVE_SDK_IDENTITY_TOKEN: "identity-secret",
    LATCHWAY_LIVE_SDK_FIREBASE_APP_CHECK_TOKEN: "firebase-app-check-secret",
    LATCHWAY_LIVE_SDK_TURNSTILE_TOKEN: "turnstile-secret",
  };
  assert.equal(liveConfiguration(environment, "firebase_app_check").attestationToken, "firebase-app-check-secret");
  assert.equal(liveConfiguration(environment, "turnstile").attestationToken, "turnstile-secret");
  assert.throws(() => liveConfiguration(environment, "debug"), /live_configuration_invalid/u);
  assert.throws(() => liveConfiguration({ ...environment, LATCHWAY_LIVE_SDK_IDENTITY_TOKEN: "" }, "firebase_app_check"), /live_configuration_missing/u);
  assert.throws(() => liveConfiguration({ ...environment, LATCHWAY_LIVE_SDK_FIREBASE_APP_CHECK_TOKEN: "" }, "firebase_app_check"), /live_configuration_missing/u);
});

test("report validator rejects every semantic substitution and secret-shaped output", () => {
  const valid = report();
  assert.equal(validateReport(valid, valid.candidate, valid.gateway.origin, "firebase_app_check"), valid);
  const mutations = [
    (value) => { value.candidate.repositories.ios.commit = "f".repeat(40); },
    (value) => { value.gateway.build.commit = "f".repeat(40); },
    (value) => { value.tests[1].error_code = "dpop_invalid"; },
    (value) => { value.tests[3].mapped_error_type = "generic"; },
    (value) => { value.tests[4].credential_after_sha256 = value.tests[4].credential_before_sha256; },
    (value) => { value.tests[5].protocol_version_sent = 1; },
    (value) => { value.tests[6].byte_count = 0; },
    (value) => { value.tests.pop(); },
    (value) => { value.redaction.access_token_recorded = true; },
    (value) => { value.gateway.build.build_date = "Bearer abcdefghijklmnopqrstuvwxyz"; },
  ];
  for (const mutate of mutations) {
    const current = globalThis.structuredClone(valid);
    mutate(current);
    assert.throws(() => validateReport(current, valid.candidate, valid.gateway.origin, "firebase_app_check"));
  }
  assert.throws(() => validateReport(valid, valid.candidate, valid.gateway.origin, "turnstile"), /live_report_identity_invalid/u);
});
