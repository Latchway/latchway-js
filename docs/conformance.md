# Conformance

Unit conformance consumes the DPoP and attestation-binding vectors from core
contract 0.4.0. `pnpm verify:contracts` checks their byte hashes and the pinned
manifest. Tests cover proof signatures and claims, non-exportable keys,
IndexedDB cloning and failure, one-tab and multi-tab refresh races, nonce retry,
streaming, cancellation, origin rejection, provider adapters, stable errors,
and strict CSP.

The Node entry point is suitable for the core `latchway verify local` flow when
the gateway supplies a mock OIDC issuer and explicitly enabled debug
attestation. It does not embed a mock verifier or hard-code a successful
verdict.

Live browser provider conformance remains environment-owned because it needs a
real Firebase App Check project or Turnstile site key, an allowed HTTPS origin,
and a running server verifier.

npm publication remains an explicit external release action. The repository
validates a byte-identical double pack, an exact archive allowlist, a credential
scan, and clean ESM and TypeScript consumers. A stable annotated version tag can
then invoke the separately permissioned OIDC workflow described in
[`releasing.md`](releasing.md). The current `0.1.0-dev.0` version intentionally
fails the stable-tag gate and has not been published by these checks.
