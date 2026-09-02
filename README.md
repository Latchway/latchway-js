# Latchway JavaScript SDK

`@latchway/client` authorizes browser and bounded Node.js fetch requests to a
self-hosted Latchway gateway. It establishes a short-lived, P-256 DPoP-bound
session without placing an AI-provider credential in the application.

This repository is a pnpm workspace. The audited base transport remains the
root `@latchway/client` package, while first-party framework adapters live in
`packages/`:

- `@latchway/openai` for the official OpenAI JavaScript SDK
- `@latchway/vercel-ai` for the Vercel AI SDK
- `@latchway/langchain` for LangChain.js through `@langchain/openai`

The adapters are thin transport integrations. They preserve the framework's
native messages, tools, structured output, streaming, and cancellation APIs;
Latchway does not introduce a second AI framework.

Version `1.0.0` is the intended stable source candidate and has not yet been
published to npm. Released contract 1.0.0, current wire protocol 2, and the exact
reviewed core bundle are pinned in `contract.lock`. Wire-1-shaped session
grants without Installation Family metadata remain parseable for legacy
server compatibility; new family/component operations require wire 2.
`pnpm pack:check` produces a locally installable prerelease archive without
publishing it.

The promotion-dispatched release workflow remains fail-closed until promotion
evidence authorizes the exact commit. See [`docs/releasing.md`](docs/releasing.md) for
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
the original streaming Response. `fetchFor(feature, framework?)` creates a
reusable feature-bound fetch for raw HTTP, framework, React Native, and service
worker integrations.

Before identity lookup or session creation, the transport requires the exact
gateway origin and a contract-owned data-plane method/path: structured
Responses, Chat Completions, Embeddings, Anthropic Messages, or that feature's
opaque `/proxy/{feature}/<safe-relative-path>` route. Opaque paths reject empty
segments, dot aliases, encoded separators or percent escapes that could hide
them, backslashes, query strings, and absolute-URL-shaped suffixes.
Authenticated fetches use
`redirect: "error"`; a custom fetch that nevertheless returns a redirected or
cross-origin response fails closed.

Every `LatchwayError` has a closed `code`, optional safe `requestID`, and a
stable `documentationURL` at
`https://docs.latchway.dev/errors/<hyphenated-code>`. The URL is derived locally
from the typed code, while server Problems are accepted only when both `type`
and `documentation_url` match it exactly. Error reports should include
only `code`, `requestID`, `retryable`, and `documentationURL`; do not attach
response bodies, tokens, browser storage, or the error cause.

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
A renewable, crash-expiring IndexedDB lease serializes first key creation,
session establishment, rotation, and local revocation cleanup across tabs. An
in-process single-flight handles concurrent requests in one client instance.

Browser key possession and Firebase App Check or Turnstile signals are useful
web risk controls, not hardware-backed native application attestation. See
[`docs/web-security.md`](docs/web-security.md).

## Installation Families and components

Component-aware session grants include the current Installation Family, root
or delegated component, granted features, and explicit trust provenance. The
SDK validates that family and component state are paired, active, on the same
platform, and bound to the installation key before persisting a session.

A root component can register a child-owned public key without receiving its
private key:

```ts
const child = await latchway.provisionComponent({
  componentDefinitionID: "summary_worker",
  publicJWK: childGeneratedPublicJWK,
  requestedFeatures: ["weekly_summary"],
});

await deliverDirectlyToChild({
  componentID: child.componentID,
  refreshGrant: child.refreshGrant,
});
```

The refresh grant is a one-time bootstrap credential for the child key. Never
log it or persist it with the root session. `revokeComponent(id)` revokes one
delegated component, while `revokeCurrentInstallationFamily()` revokes every
component and clears local root state. Native and React Native integrations
must generate and retain child private keys in their native platform SDK.

## Framework integrations

```ts
import { createLatchwayOpenAI } from "@latchway/openai";

const openai = createLatchwayOpenAI({
  latchway,
  feature: "habit_assistant",
});

const stream = await openai.responses.create({
  // Compatibility placeholder only. The server selects the physical model.
  model: "latchway",
  input: "Summarize today",
  stream: true,
});
```

Vercel AI SDK and LangChain.js applications use `createLatchwayProvider`,
`createLatchwayChatOpenAI`, and `createLatchwayEmbeddings`. Each model/client is
bound to an application feature; the physical provider, route, and model remain
server configuration. Exact tested dependency versions and limitations are in
[`docs/framework-integrations.md`](docs/framework-integrations.md).

The transport deletes incoming authorization, proxy, cookie, common
AI-provider, Google, and signed-cloud credential headers before adding the
DPoP-bound Latchway authorization. It rejects their case-insensitive or
percent-encoded query-name forms before identity, session, or network work.
Framework compatibility placeholders are therefore never sent to Latchway or
upstream, and no adapter accepts an upstream provider secret.

Trusted input-token preflight is intentionally server-owned. It runs after
route selection, physical-model resolution, and server rewriting; these
adapters do not estimate tokens from client bytes or caller-supplied model
names.

## Service workers and React Native

`@latchway/client/service-worker` provides an explicit handler with `route`
and `handle` methods. The application supplies a synchronous `featureFor`
selector, and the handler claims only selected requests for the exact gateway
origin. It never installs a global listener. See
[`docs/service-worker.md`](docs/service-worker.md).

The exported `AuthenticatedTransport` interface is the shared JavaScript
surface for native-backed React Native clients. A React Native bridge implements
`gatewayURL` and `fetchFor`; it must delegate keys, attestation, refresh state,
and proof creation to the iOS or Android SDK rather than JavaScript storage.

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
timeout or protocol failures. Streaming or already-consumed request bodies are
never buffered for retry: if Latchway rejects one before dispatch and a fresh
proof or session would require replay, the client throws
`transport_request_not_replayable`.

## Exports

- `@latchway/client`
- `@latchway/client/browser`
- `@latchway/client/node`
- `@latchway/client/firebase`
- `@latchway/client/turnstile`
- `@latchway/client/service-worker`
- `@latchway/openai`
- `@latchway/vercel-ai`
- `@latchway/langchain`

## Development

Use the pinned Node 24.19.0 and pnpm 10.15.0 toolchain from `mise.toml`.

```bash
pnpm install --frozen-lockfile
pnpm browser:install
pnpm verify:contracts
pnpm check
pnpm verify:reproducible
pnpm pack:check
pnpm release:check
```

The checks cover strict TypeScript, lint, canonical DPoP and attestation
vectors, storage failure, refresh races, cancellation, streaming, strict CSP,
subpath exports, deterministic output, and package contents. The source-side
Web gate runs Chromium, Firefox, and WebKit against a loopback conformance
server and compiles pinned Vite, React, Next.js client-component, and plain-ESM
consumers. Framework tests execute the pinned real OpenAI, Vercel AI, and
LangChain packages through their documented injection seams.

See [examples](examples/README.md), [architecture](docs/architecture.md),
[release procedure](docs/releasing.md), [security policy](SECURITY.md), and
[contributing guide](CONTRIBUTING.md).
