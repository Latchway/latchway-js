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

The core protected release-evidence workflow uses `scripts/live-conformance.mjs`
for the Node live path after building this exact checkout. It accepts only the
core-produced canonical candidate manifest and HTTPS gateway origin, verifies
that this clean checkout equals the manifest's JavaScript commit, and requires
the runtime/server version, contract, protocol, core commit, and release image
identity to agree. Protected environment values provide the application,
environment, identity provider, model, real feature, guaranteed-absent error
mapping feature, and either `firebase_app_check` or `turnstile`. The identity
and attestation tokens are read only from
`LATCHWAY_LIVE_SDK_IDENTITY_TOKEN` and
`LATCHWAY_LIVE_SDK_ATTESTATION_TOKEN`; they never enter arguments or retained
output. The retained report contains concrete canonical response metadata,
bounded stream/quota facts, and SHA-256-only session-rotation observations.

npm publication remains an explicit external release action. The repository
validates a byte-identical double pack, an exact archive allowlist, a credential
scan, and clean ESM and TypeScript consumers. A stable annotated version tag can
then invoke the separately permissioned OIDC workflow described in
[`releasing.md`](releasing.md). The `1.0.0` source coordinate passes the stable
version check, but has not been published by these source-only checks.
