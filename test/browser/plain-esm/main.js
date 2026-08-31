import {
  createCustomAttestationProvider,
  createLatchwayClient,
  LatchwayError,
} from "/sdk/index.js";

const gatewayOrigin = "http://127.0.0.1:4174";

async function run(databaseName) {
  const client = createLatchwayClient({
    baseURL: gatewayOrigin,
    allowInsecureHTTP: true,
    applicationID: "app_01J00000000000000000000000",
    environment: "development",
    identityProvider: "custom_jwt",
    identityTokenProvider: {
      getIdentityToken: async () => "plain-esm-conformance-identity-token",
    },
    attestationProviders: [createCustomAttestationProvider({
      provider: "debug",
      getEvidence: async ({ challenge }) => ({
        challenge_token: `test-only-${challenge.challenge_id}`,
        client_data_hash: challenge.attestation.client_data_hash,
      }),
    })],
    persistence: { mode: "required", databaseName },
    installation: { appVersion: "1.0.0-plain-esm" },
  });
  const diagnostics = await client.diagnostics();
  const response = await client.fetch("/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "plain-esm", stream: true }),
    latchwayFeature: "habit-assistant",
  });
  return {
    requestID: response.headers.get("X-Latchway-Request-ID"),
    output: await response.text(),
    platform: diagnostics.client.platform,
    keyPersistence: diagnostics.client.keyPersistence,
    sessionPersistence: diagnostics.client.sessionPersistence,
  };
}

async function runSafely(databaseName) {
  try {
    return { ok: true, result: await run(databaseName) };
  } catch (error) {
    if (error instanceof LatchwayError) {
      return {
        ok: false,
        error: {
          code: error.code,
          requestID: error.requestID ?? null,
          retryable: error.retryable,
          documentationURL: error.documentationURL,
        },
      };
    }
    return {
      ok: false,
      error: { code: null, requestID: null, retryable: false, documentationURL: null },
    };
  }
}

window.__latchwayPlainESM = { run, runSafely };
