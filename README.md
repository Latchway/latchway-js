# Latchway JavaScript SDK

`@latchway/client` authorizes browser and bounded Node.js fetch requests to a
self-hosted Latchway gateway. It establishes a short-lived, P-256 DPoP-bound
session without placing an AI-provider credential in the application.

The package is pre-release and has not been published to npm. Contract 0.1.0,
wire protocol 1, and the exact reviewed core bundle are pinned in
`contract.lock`. `pnpm pack:check` produces a locally installable prerelease
archive without publishing it.

## Browser client

```ts
import { createLatchwayClient } from "@latchway/client";
import { createTurnstileProvider } from "@latchway/client/turnstile";

const latchway = createLatchwayClient({
  baseURL: "https://ai.example.com",
  applicationID: "habitify_web",
  environment: "production",
  identityProvider: "firebase",
  identityTokenProvider: {
    getIdentityToken: () => user.getIdToken(),
  },
  attestationProviders: [
    createTurnstileProvider({
      getToken: ({ challenge }) =>
        runTurnstileForChallenge(challenge.attestation.client_data_hash),
      action: "latchway_session",
    }),
  ],
  installation: { appVersion: "4.2.0" },
});

const response = await latchway.fetch("https://ai.example.com/v1/responses", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ input: "Summarize today" }),
  latchwayFeature: "habit_assistant",
});
```

The SDK never patches global `fetch`. `authorize(request, feature)` returns a
new immutable Request, while `fetch` preserves the Request signal and returns
the original streaming Response. It signs only requests whose origin exactly
matches `baseURL`.

## Browser persistence

The default browser policy is `persistence: { mode: "required" }`. It stores a
non-exportable P-256 CryptoKey and rotating session state in IndexedDB. If the
browser cannot structured-clone CryptoKey objects, client use fails closed.

An application may explicitly accept session-only state:

```ts
persistence: { mode: "allow-memory" }
```

This fallback creates a new installation after navigation and is reported by
`diagnostics()`. It is not silently enabled. The SDK never uses localStorage.
An IndexedDB lease serializes refresh-token rotation across tabs; an in-process
single-flight handles concurrent requests in one tab.

Browser key possession and Firebase App Check or Turnstile signals are useful
web risk controls, not hardware-backed native application attestation. See
[`docs/web-security.md`](docs/web-security.md).

## OpenAI-compatible clients

```ts
const openai = new OpenAI({
  apiKey: "latchway-managed",
  baseURL: "https://ai.example.com/v1",
  fetch: (input, init) =>
    latchway.fetch(input, { ...init, latchwayFeature: "habit_assistant" }),
});
```

The wrapper deletes incoming `Authorization`, `Proxy-Authorization`, `api-key`,
`x-api-key`, `openai-api-key`, and Cookie headers before adding the DPoP-bound
Latchway authorization. The compatibility placeholder is never forwarded.
The SDK never accepts an upstream provider secret.

## Firebase and Turnstile adapters

The optional subpaths do not bundle provider SDKs. Applications pass the
official provider functions they already initialized:

```ts
import {
  createFirebaseAppCheckProvider,
  createFirebaseIdentityTokenProvider,
} from "@latchway/client/firebase";

const identityTokenProvider = createFirebaseIdentityTokenProvider(
  () => auth.currentUser!.getIdToken(),
);
const appCheckProvider = createFirebaseAppCheckProvider(
  (forceRefresh) => getToken(appCheck, forceRefresh),
);
```

Provider tokens are sent only to the configured Latchway origin. Real verdict
verification remains server-side. Firebase App Check supplies a fresh token on
refresh. A Turnstile integration may provide `getRefreshToken` when its server
policy accepts refresh evidence; otherwise an attestation-stale response starts
a new challenge flow.

## Node.js conformance mode

```ts
import {
  createCustomAttestationProvider,
  createNodeLatchwayClient,
} from "@latchway/client/node";

const latchway = createNodeLatchwayClient({
  baseURL: "http://127.0.0.1:8080",
  allowInsecureHTTP: true,
  applicationID: "conformance_client",
  environment: "test",
  identityProvider: "custom_jwt",
  identityTokenProvider: { getIdentityToken: issueFixtureJWT },
  attestationProviders: [
    createCustomAttestationProvider({
      provider: "debug",
      getEvidence: issueServerConfiguredDebugEvidence,
    }),
  ],
});
```

Node 24.19.0 mode uses a memory-only software P-256 key. It is intended for
development and conformance. It does not claim application, device, or hardware
attestation, and debug evidence works only when the server explicitly enables
its debug verifier.

## Errors and control methods

`quota(feature)`, `diagnostics()`, `revokeCurrentInstallation()`, and session
setup failures throw `LatchwayError` with a stable `code`, HTTP status, request
ID, retryability, and safe validation fields when supplied by the server.
Ordinary `fetch` semantics are retained: final non-2xx protected responses are
returned untouched for OpenAI-compatible libraries. Call
`errorFromResponse(response.clone())` to map one explicitly.

The client retries once with a fresh proof for a valid `DPoP-Nonce` challenge.
It also refreshes once after a server `session_expired` response, which the
protocol guarantees occurs before upstream dispatch. It never blindly replays
upstream timeout or protocol failures.

## Exports

- `@latchway/client`
- `@latchway/client/browser`
- `@latchway/client/node`
- `@latchway/client/firebase`
- `@latchway/client/turnstile`

## Development

Use the pinned Node 24.19.0 and pnpm 10.15.0 toolchain from `mise.toml`.

```bash
pnpm install --frozen-lockfile
pnpm verify:contracts
pnpm check
pnpm verify:reproducible
pnpm pack:check
```

The checks cover strict TypeScript, lint, canonical DPoP and attestation
vectors, storage failure, refresh races, multiple tabs, cancellation,
streaming, strict CSP, subpath exports, deterministic output, and package
contents.

See [examples](examples/README.md), [architecture](docs/architecture.md),
[security policy](SECURITY.md), and [contributing guide](CONTRIBUTING.md).
