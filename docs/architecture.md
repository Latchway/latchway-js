# JavaScript SDK Architecture

## Status

This document fixes the ownership and runtime boundaries for the planned
TypeScript client. It does not describe an existing implementation. Package
manifests, production modules, generated models, and contract.lock will be
introduced only after the core repository publishes an authoritative contract
bundle.

## System boundary

The application supplies an identity token from its existing identity provider
and a Request intended for its configured Latchway gateway. The SDK proves
possession of an installation key, obtains a short-lived Latchway session, and
adds transport authorization. The gateway authenticates, authorizes, meters,
and injects the upstream provider credential.

The SDK never receives the upstream credential and never decides server-owned
facts such as user ID, plan, attestation level, organization, route, upstream,
price, or usage.

## Contract ownership

The Latchway core repository exclusively owns:

- Client session OpenAPI
- Error-code registry and retry guidance
- Protocol-version and compatibility manifest
- Canonical attestation-binding encoding
- DPoP and attestation test vectors
- Canonical request examples
- The checksummed contract release bundle

This repository consumes those artifacts. A contract update must verify the
bundle checksum, update contract.lock, regenerate internal wire DTOs
reproducibly, run shared vectors, and pass conformance against the exact core
image. Generated wire DTOs must not become the public TypeScript API.

## Planned export boundaries

~~~text
@latchway/client
    Shared public API, error mapping, session orchestration, feature selection
    |
    +-- @latchway/client/browser
    |     WebCrypto, IndexedDB, browser fetch, server-time hints
    |
    +-- @latchway/client/node
    |     Software P-256 key and bounded server/development behavior
    |
    +-- @latchway/client/firebase
    |     Optional Firebase identity and App Check adapters
    |
    +-- @latchway/client/turnstile
          Optional Turnstile token-provider adapter
~~~

Shared modules must not evaluate browser-only or Node.js-only imports. Optional
adapters depend inward on narrow provider interfaces. React Native may consume
shared TypeScript transport concepts, but platform keys and attestation stay in
the native SDKs.

## Key and state boundary

Browser mode creates a non-exportable WebCrypto P-256 key and persists its
CryptoKey in IndexedDB where supported. If persistence is unavailable, an
explicit in-memory installation may be used with appropriately weaker
diagnostics. Only a public JWK and its RFC thumbprint leave the runtime.

Rotating refresh state stays in IndexedDB. Coordination prevents simultaneous
refreshes from racing. Web possession is not hardware-backed attestation.
Firebase App Check and Turnstile are separate optional evidence providers.

Node.js mode may use a software key for custom identity and conformance, but
must never claim application or hardware attestation.

## Transport boundary

The public client authorizes Request values and exposes an explicit fetch
wrapper. It does not monkey-patch global fetch. It preserves streaming,
cancellation, and immutable request semantics, and supports libraries that
accept a custom fetch implementation.

Compatibility placeholder API keys are stripped and never forwarded. Errors
expose stable safe fields and request identifiers, never tokens, proofs, or raw
attestation evidence.

## Verification boundary

Unit tests own deterministic cryptographic, storage, runtime-separation,
cancellation, and refresh cases. Shared vectors prove wire-level agreement.
Browser tests cover IndexedDB, CSP, clock skew, and fetch semantics. Node.js
tests prove its deliberately weaker claims. Cross-repository conformance runs
the package against PostgreSQL and the exact core container.

## Non-goals

This repository does not own server policy, provider routing, quota
enforcement, user-authentication UI, upstream secrets, native hardware trust,
AI request modeling, global fetch mutation, or React Native bridge behavior.
