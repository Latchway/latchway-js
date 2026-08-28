# Conformance

Unit conformance consumes the DPoP and attestation-binding vectors from core
contract 0.3.0. `pnpm verify:contracts` checks their byte hashes and the pinned
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
and a running server verifier. npm publication also remains a release action;
this repository only builds and validates the prerelease archive.
