# Latchway JavaScript SDK

`@latchway/client` authorizes browser and bounded Node.js fetch requests to a
self-hosted Latchway gateway. It establishes a short-lived, P-256 DPoP-bound
session without placing an AI-provider credential in the application.

Version `1.0.0` is the intended stable source candidate and has not yet been
published to npm. Contract 0.4.0,
wire protocol 1, and the exact reviewed core bundle are pinned in
`contract.lock`. `pnpm pack:check` produces a locally installable prerelease
archive without publishing it.

The tag-triggered release workflow remains fail-closed until promotion evidence
authorizes the exact commit. See [`docs/releasing.md`](docs/releasing.md) for
the external npm trusted-publisher setup, stable-version procedure, and
artifact/provenance checks. No repository command publishes implicitly.

## Browser client

```ts
import { createLatchwayClient } from "@latchway/client";
import { createTurnstileProvider } from "@latchway/client/turnstile";

const latchway = createLatchwayClient({
  baseURL: "https://ai.example.com",
  // The generated application resource ID returned by the Admin API.
  applicationID: "app_01J00000000000000000000000",
  environment: "production",
  identityProvider: "firebase",
  identityTokenProvider: {
    getIdentityToken: () => user.getIdToken(),
  },
  attestationProviders: [
    createTurnstileProvider({
      getToken: ({ challenge }) => runTurnstileForChallenge({
        action: "latchway_session",
        cData: challenge.attestation.client_data_hash,
      }),
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

The wrapper deletes incoming authorization, proxy, cookie, common AI-provider,
Google, and signed-cloud credential headers before adding the DPoP-bound
Latchway authorization. It rejects their case-insensitive or percent-encoded
query-name forms before acquiring identity, establishing a session, or making
a network request. Compatibility placeholders are never forwarded, and the SDK
never accepts an upstream provider secret.

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
verification remains server-side. Firebase App Check and Turnstile evidence is
created only for a server challenge. Turnstile must be executed once per session challenge with widget
`action` equal to the server-configured action and widget `cData` equal to
`challenge.attestation.client_data_hash`. Evidence contains only the opaque
token; Latchway verifies the returned action and binding through Siteverify.
Refresh sends only the rotating refresh token and a fresh DPoP proof. Identity
reauthentication or any attestation step-up starts a new challenge flow; no
unbound identity or attestation token is attached to refresh.

## Node.js conformance mode

```ts
import {
  createCustomAttestationProvider,
  createNodeLatchwayClient,
} from "@latchway/client/node";

const latchway = createNodeLatchwayClient({
  baseURL: "http://127.0.0.1:8080",
  allowInsecureHTTP: true,
  applicationID: "app_01J00000000000000000000000",
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

`quota(feature)`, `diagnostics()`, `refresh()`, `revokeCurrentInstallation()`, and session
setup failures throw `LatchwayError` with a stable `code`, HTTP status, request
ID, retryability, and safe validation fields when supplied by the server.
Ordinary `fetch` semantics are retained: final non-2xx protected responses are
returned untouched for OpenAI-compatible libraries. Call
`errorFromResponse(response.clone())` to map one explicitly.

Control and Problem JSON is limited to 64 KiB, decoded as fatal UTF-8, bounded
to 64 nesting levels, and rejected when any object contains duplicate member
names, including Unicode-escaped aliases. Problem metadata must exactly match
the contract's media type, status, title, retryability, request-ID header, and
operation-ID rules before it can influence retry behavior.

The client retries once with a fresh proof for a canonical, unambiguous
`DPoP-Nonce` challenge. It also refreshes once after a canonical
`session_expired` response with no nonce, which the protocol guarantees occurs
before upstream dispatch. A refresh body contains only the rotating token; a
server request for renewed identity or attestation clears the old session and
performs a fresh challenge and exchange. It never blindly replays upstream
timeout or protocol failures.

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
pnpm release:check
```

The checks cover strict TypeScript, lint, canonical DPoP and attestation
vectors, storage failure, refresh races, multiple tabs, cancellation,
streaming, strict CSP, subpath exports, deterministic output, and package
contents.

See [examples](examples/README.md), [architecture](docs/architecture.md),
[release procedure](docs/releasing.md), [security policy](SECURITY.md), and
[contributing guide](CONTRIBUTING.md).
