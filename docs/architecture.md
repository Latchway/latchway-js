# JavaScript SDK Architecture

## Contract boundary

The SDK consumes released Latchway contract 1.0.0 and emits current wire protocol
2. The core commit and contract-bundle SHA-256 are immutable inputs in
`contract.lock`; vendored test vectors are hash-checked in CI. Legacy
wire-1-shaped installation grants without family/component summaries remain
parseable, while all family/component control operations require wire 2.
Public TypeScript APIs are handwritten.
Wire parsing stays internal and rejects oversized, deeply nested, invalid UTF-8,
duplicate-member, and otherwise malformed security-critical responses.

The server owns identity verification, attestation verdicts, principals,
Installation Family membership, component definitions, policy, routes,
physical models, trusted input-token preflight, quotas, prices, usage, and
upstream credentials. The SDK owns only local component-key possession,
session transport, provider-token callbacks, and request authorization.

## Dependency direction

~~~text
framework adapters / service-worker / React Native bridge
                            |
             feature-bound AuthenticatedTransport
                            |
       index / browser / node / firebase / turnstile
                            |
                     handwritten client
                            |
              session -> DPoP -> WebCrypto
                 |
          StateStore -> IndexedDB or explicit memory
~~~

Shared modules do not import Node-only or provider packages. The Node subpath is
the only module that imports `node:crypto`. Firebase and Turnstile subpaths
depend on narrow callback interfaces, so applications retain ownership of the
official provider SDK lifecycle. No module performs ambient global mutation.

## Key and state lifecycle

Browser mode generates ECDSA P-256 with a non-exportable private CryptoKey. It
persists the CryptoKey object, public JWK, RFC 7638 thumbprint, short-lived
access token, and rotating refresh token in origin-scoped IndexedDB. The SDK
does not export private key material or use localStorage.

Persistent mode fails closed if IndexedDB or CryptoKey structured cloning is
unavailable. `allow-memory` is an explicit application decision and is visible
in diagnostics. Node conformance mode always uses a memory-only software key.

Session work is single-flight in one client. A renewable IndexedDB mutation
lease serializes first key creation, session establishment, refresh, and local
revocation cleanup across tabs. A losing tab re-reads the committed key and
session under the lease, so it neither overwrites first-use state nor submits a
stale refresh token. Every persisted mutation revalidates lease ownership.
Leases expire after a bounded period so a crashed or closed tab cannot
permanently block the namespace. The refresh body contains only the rotating
refresh token and is DPoP-bound to its endpoint. Identity reauthentication and
attestation expiry or step-up clear the old session and start a fresh challenge;
unbound identity and attestation material is never sent to the refresh endpoint.

## Installation Family and session flow

The runtime hierarchy is application user → Installation Family → client
component. A root web or Node session grant may carry paired
`installation_family` and `component` summaries. The parser rejects an
unpaired summary, inactive state, platform mismatch, component key mismatch,
duplicate or malformed feature grants, and inconsistent delegated provenance.
State storage keeps component/family metadata with the rotating session so a
restored session cannot silently lose its attribution boundary.

Root code may provision a configured delegated component by submitting only
the child's public P-256 JWK and requested feature subset. The resulting
one-time refresh grant belongs to that child key. This package deliberately
does not accept or copy the child private key; native and React Native child
session creation remains owned by their platform SDK. Component and family
revocation use centralized client-contract paths so a wire adjustment is
localized.

## Session and request flow

1. Resolve or create the installation key.
2. Obtain an application identity token through the configured callback.
3. Create a challenge with a DPoP proof that omits `ath`.
4. Select the adapter requested by the challenge and pass it the exact
   `client_data_hash` and challenge context.
5. Exchange provider evidence for tokens bound to the installation JWK
   thumbprint.
6. For each protected request, reject credential-like query names, strip
   credential placeholders, compute `ath`, create a unique proof for the exact
method and URI, and add protocol, SDK, feature, and optional framework
headers.

Every `LatchwayError` derives its public `documentationURL` from the closed
error-code union (`https://docs.latchway.dev/errors/<hyphenated-code>`); a
server cannot substitute the link. Problem responses must provide that exact
URL in both `type` and `documentation_url`. Safe support output is limited to
code, correlated request ID, retryability, and that documentation URL.

Server Date headers adjust DPoP issued-at time within a bounded 24-hour local
clock discrepancy. A DPoP nonce is accepted only from a canonical, correlated
Problem response from the configured gateway; whitespace, control characters,
joined values, and oversized values are rejected before signing a new proof.

## Fetch semantics

The wrapper constructs new Request values and leaves caller objects unchanged.
Only the configured gateway origin and contract-declared data-plane
method/path pairs may be signed. Opaque paths must remain under the bound
feature's prefix and cannot contain a query. Request signals and response
bodies pass through, so cancellation and incremental SSE remain native Fetch
API behavior. Authenticated requests disable redirects; returned redirected or
cross-origin responses also fail closed. Final protected HTTP errors remain
Response objects; internal session and control operations map RFC 9457
documents to stable `LatchwayError` instances.

No request is retried for upstream timeouts or ambiguous dispatch failures.
The only automatic protected-request retries are a single DPoP nonce response
and a single `session_expired` response, both rejected before upstream dispatch
by the protocol. The retry path creates a fresh proof and reauthorizes the
final request. It proceeds only for a body represented by a replay-safe Fetch
value; streams and caller-supplied `Request` bodies fail with
`transport_request_not_replayable` rather than being buffered.

## Framework boundary

`@latchway/openai`, `@latchway/vercel-ai`, and `@latchway/langchain` inject a
feature-bound custom fetch into the framework's supported extension point.
They attach exact package-version metadata and leave prompts, messages, tools,
structured output, streams, errors, and cancellation in the framework's own
types. Provider and model selection remain server-owned. See
[`framework-integrations.md`](framework-integrations.md).

## Trust limits

WebCrypto possession is vulnerable to malicious same-origin script. IndexedDB
protects against accidental serialization and makes the private key
non-exportable; it cannot make an XSS-compromised origin trustworthy. App Check
and Turnstile are server-verified web risk signals, not native hardware trust.

Node mode supports custom JWT identity, a software key, custom fetch, and
server-configured debug conformance. It never claims application attestation.
React Native consumes the structural `AuthenticatedTransport` surface while
delegating component keys, attestation, session storage, refresh, and DPoP to
the native iOS and Android SDKs. A JavaScript-only implementation must not
claim native key isolation or physical-device proof.
