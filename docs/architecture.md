# JavaScript SDK Architecture

## Contract boundary

The SDK consumes Latchway contract 0.4.0 and wire protocol 1. The core commit
and contract-bundle SHA-256 are immutable inputs in `contract.lock`; vendored
test vectors are hash-checked in CI. Public TypeScript APIs are handwritten.
Wire parsing stays internal and rejects malformed security-critical responses.

The server owns identity verification, attestation verdicts, principals,
policy, routes, quotas, prices, usage, and upstream credentials. The SDK owns
only installation-key possession, session transport, provider-token callbacks,
and request authorization.

## Dependency direction

~~~text
index / browser / node / firebase / turnstile
                    |
              handwritten client
                    |
       session  -> DPoP -> WebCrypto
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

Refresh is single-flight in one client. IndexedDB read/write transactions hold
a short refresh lease across tabs. A losing tab polls the newly rotated session
record and never submits the stale refresh token. Leases expire after a bounded
period so crashed tabs cannot permanently block refresh.

## Session and request flow

1. Resolve or create the installation key.
2. Obtain an application identity token through the configured callback.
3. Create a challenge with a DPoP proof that omits `ath`.
4. Select the adapter requested by the challenge and pass it the exact
   `client_data_hash` and challenge context.
5. Exchange provider evidence for tokens bound to the installation JWK
   thumbprint.
6. For each protected request, strip credential placeholders, compute `ath`,
   create a unique proof for the exact method and URI, and add protocol headers.

Server Date headers adjust DPoP issued-at time within a bounded 24-hour local
clock discrepancy. A DPoP nonce is accepted only from the configured gateway
and used once per retry with a newly signed proof.

## Fetch semantics

The wrapper constructs new Request values and leaves caller objects unchanged.
Only the configured gateway origin may be signed. Request signals and response
bodies pass through, so cancellation and incremental SSE remain native Fetch
API behavior. Final protected HTTP errors remain Response objects; internal
session and control operations map RFC 9457 documents to stable
`LatchwayError` instances.

No request is retried for upstream timeouts or ambiguous dispatch failures.
The only automatic protected-request retries are a single DPoP nonce response
and a single `session_expired` response, both rejected before upstream dispatch
by the protocol.

## Trust limits

WebCrypto possession is vulnerable to malicious same-origin script. IndexedDB
protects against accidental serialization and makes the private key
non-exportable; it cannot make an XSS-compromised origin trustworthy. App Check
and Turnstile are server-verified web risk signals, not native hardware trust.

Node mode supports custom JWT identity, a software key, custom fetch, and
server-configured debug conformance. It never claims application attestation.
React Native delegates installation keys and attestation to the native iOS and
Android SDKs and is outside this package.
