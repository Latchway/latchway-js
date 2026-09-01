import { writeFile } from "node:fs/promises";

import {
  createCustomAttestationProvider,
  createLatchwayClient,
} from "../dist/index.js";

const configuration = Object.freeze({
  baseURL: requiredURL("LATCHWAY_DEVELOP_BASE_URL"),
  applicationID: required("LATCHWAY_DEVELOP_APPLICATION_ID"),
  environment: required("LATCHWAY_DEVELOP_ENVIRONMENT"),
  feature: required("LATCHWAY_DEVELOP_FEATURE"),
  model: required("LATCHWAY_DEVELOP_MODEL"),
  identityTokenURL: requiredURL("LATCHWAY_DEVELOP_IDENTITY_TOKEN_URL"),
  attestationEvidenceURL: requiredURL("LATCHWAY_DEVELOP_ATTESTATION_EVIDENCE_URL"),
  output: required("LATCHWAY_SDK_CONFORMANCE_OUTPUT"),
});

const gatewayURL = new URL(configuration.baseURL);
if (gatewayURL.protocol !== "http:" || gatewayURL.hostname !== "127.0.0.1" ||
    gatewayURL.port === "" || gatewayURL.origin !== configuration.baseURL || gatewayURL.pathname !== "/" ||
    configuration.identityTokenURL !== `${configuration.baseURL}/development/v1/identity-token` ||
    configuration.attestationEvidenceURL !== `${configuration.baseURL}/development/v1/attestation-evidence`) {
  throw new Error("PR conformance accepts only the isolated loopback development deployment.");
}

let evidenceCalls = 0;
const gatewayFetch = async (input, init) => {
  const request = new globalThis.Request(input, init);
  const target = new URL(request.url);
  if (target.origin !== configuration.baseURL) {
    throw new Error("The PR conformance transport refused a non-gateway origin.");
  }
  const headers = new globalThis.Headers(request.headers);
  headers.set("Origin", "http://localhost:5173");
  return fetch(new globalThis.Request(request, { headers }));
};

const client = createLatchwayClient({
  baseURL: configuration.baseURL,
  allowInsecureHTTP: true,
  applicationID: configuration.applicationID,
  environment: configuration.environment,
  identityProvider: "mock_oidc",
  identityTokenProvider: {
    async getIdentityToken() {
      const document = await boundedJSON(await fetch(configuration.identityTokenURL, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      }));
      if (Object.keys(document).length !== 1 || typeof document.identity_token !== "string" ||
          document.identity_token.length < 64) {
        throw new Error("The development identity helper returned an invalid document.");
      }
      return document.identity_token;
    },
  },
  attestationProviders: [createCustomAttestationProvider({
    provider: "debug",
    async getEvidence(context) {
      evidenceCalls += 1;
      const document = await boundedJSON(await fetch(configuration.attestationEvidenceURL, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge_id: context.challenge.challenge_id,
          binding_hash: context.challenge.attestation.client_data_hash,
          application_id: context.applicationID,
          environment: context.environment,
          dpop_jkt: context.dpopJkt,
          platform: context.platform,
        }),
      }));
      if (document.binding_hash !== context.challenge.attestation.client_data_hash ||
          typeof document.key_id !== "string" || typeof document.expires_at !== "number" ||
          typeof document.signature !== "string") {
        throw new Error("The development attestation helper returned invalid evidence.");
      }
      return document;
    },
  })],
  persistence: { mode: "memory" },
  installation: { appVersion: "1.0.0-pr-conformance" },
  fetch: gatewayFetch,
});

const firstDiagnostics = await client.diagnostics();
if (firstDiagnostics.server.installation.platform !== "web" ||
    firstDiagnostics.server.installation.status !== "active" ||
    firstDiagnostics.server.trust.provider !== "debug" ||
    firstDiagnostics.server.trust.level !== "debug" ||
    firstDiagnostics.server.session.refresh_available !== true || evidenceCalls !== 1) {
  throw new Error("The JavaScript SDK did not establish the expected debug-attested DPoP session.");
}
const quotaBefore = await client.quota(configuration.feature);

const response = await client.fetch("/v1/responses", {
  method: "POST",
  latchwayFeature: configuration.feature,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: configuration.model,
    input: "One deterministic SDK PR conformance request.",
    max_output_tokens: 16,
  }),
});
const responseRequestID = response.headers.get("X-Latchway-Request-ID");
const responseDocument = await boundedJSON(response);
const outputText = responseDocument.output?.[0]?.content?.[0];
const usage = responseDocument.usage;
if (!response.ok || responseDocument.id !== "resp_mock_0001" ||
    responseDocument.model !== "latchway-mock-model" || responseDocument.status !== "completed" ||
    outputText?.type !== "output_text" || outputText?.text !== "Deterministic mock response." ||
    usage?.input_tokens !== 11 || usage?.output_tokens !== 7 || usage?.total_tokens !== 18 ||
    typeof responseRequestID !== "string" || responseRequestID.length < 8) {
  throw new Error("The JavaScript SDK did not complete the deterministic proxied mock request.");
}

const quota = await client.quota(configuration.feature);
const requestLimitBefore = quotaBefore.limits.find((limit) => limit.metric === "logical_requests");
const requestLimit = quota.limits.find((limit) => limit.metric === "logical_requests");
if (quota.feature !== configuration.feature || quota.limits.length === 0 ||
    !quota.limits.every((limit) => typeof limit.metric === "string" && limit.hard === true) ||
    requestLimitBefore === undefined || requestLimit === undefined ||
    typeof requestLimitBefore.used !== "number" || typeof requestLimit.used !== "number" ||
    requestLimit.used !== requestLimitBefore.used + 1 ||
    typeof requestLimitBefore.remaining !== "number" || typeof requestLimit.remaining !== "number" ||
    requestLimit.remaining !== requestLimitBefore.remaining - 1) {
  throw new Error("The JavaScript SDK returned an invalid live quota snapshot.");
}

await client.refresh();
const refreshedDiagnostics = await client.diagnostics();
if (refreshedDiagnostics.server.session.refresh_available !== true ||
    refreshedDiagnostics.server.installation.id !== firstDiagnostics.server.installation.id ||
    refreshedDiagnostics.server.request_id === firstDiagnostics.server.request_id) {
  throw new Error("The JavaScript SDK did not retain its installation across an explicit session refresh.");
}

const report = {
  schema_version: 1,
  kind: "latchway_sdk_live_debug_conformance",
  sdk_kind: "javascript",
  status: "passed",
  physical_attestation_claimed: false,
  checks: {
    debug_attestation: evidenceCalls === 1,
    dpop_session: true,
    proxied_mock_request: true,
    quota: true,
    session_refresh: true,
  },
  observations: {
    platform: firstDiagnostics.server.installation.platform,
    trust_provider: firstDiagnostics.server.trust.provider,
    contract_version: firstDiagnostics.server.contract_version,
    protocol_version: firstDiagnostics.server.protocol_version,
    response_request_id: responseRequestID,
    quota_limit_count: quota.limits.length,
    logical_requests_delta: 1,
  },
};
await writeFile(configuration.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

async function boundedJSON(response) {
  if (!response.ok) throw new Error(`Conformance request failed with HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 131_072) {
    throw new Error("Conformance response exceeded its bounded JSON envelope.");
  }
  const value = JSON.parse(new globalThis.TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Conformance response was not one JSON object.");
  }
  return value;
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requiredURL(name) {
  const value = required(name);
  const url = new URL(value);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(`${name} must not contain credentials, a query, or a fragment.`);
  }
  return value;
}
