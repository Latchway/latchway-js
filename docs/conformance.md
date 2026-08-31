# Conformance

Unit conformance consumes the DPoP, attestation-binding, and Installation
Family vectors from draft core contract 1.0.0. `pnpm verify:contracts` checks
their byte hashes and the pinned manifest. Tests cover proof signatures and
claims, non-exportable keys,
IndexedDB cloning and failure, one-tab and multi-tab refresh races, nonce retry,
streaming, cancellation, origin rejection, provider adapters, stable errors,
strict CSP, contract route/method enforcement, redirect failure, non-replayable
bodies, component/family grant validation, public-key-only child provisioning,
and scoped component/family revocation.

The framework suite executes the real `openai`, `ai`, `@ai-sdk/openai`, and
`@langchain/openai` packages through their documented
fetch/provider/underlying-client seams. The reusable catalog in
`conformance/framework/cases.ts` requires every applicable case ID to be
registered. Sixty-two framework/case combinations currently cover feature and
version binding, Responses, Chat, embeddings, safe headers, SSE plus final
usage, cancellation, timeouts, tools, structured output, quota/provider errors,
fresh proofs across framework retries, safe session refresh, placeholder
stripping, origin rejection, error redaction, OpenAI response correlation,
Vercel middleware and telemetry recording options, LangChain bounded batch execution
and error isolation, and no global-fetch mutation.

The minimum/latest workflow runs the exact experimental versions recorded in
`conformance/framework-versions.json`; the two profiles are currently equal.
A weekly observation installs the newest release within explicitly bounded
candidate majors, runs the same cases, and opens at most one active issue on
failure. Candidate success does not alter the manifest or widen a support
range. The fixture performs real client session bootstrap and DPoP
authorization, but it is still local debug-attestation evidence rather than a
hosted core or exact-image observation, so the canonical registry remains
experimental.

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
environment, identity provider, model, real feature, and guaranteed-absent
error mapping feature. The core producer runs a fixed two-provider matrix:
`firebase_app_check` and `turnstile`. The selected provider is a non-secret
command argument and is bound into the report as `attestation_provider`. The
identity token and separate provider tokens are read only from
`LATCHWAY_LIVE_SDK_IDENTITY_TOKEN`,
`LATCHWAY_LIVE_SDK_FIREBASE_APP_CHECK_TOKEN`, and
`LATCHWAY_LIVE_SDK_TURNSTILE_TOKEN`; they never enter retained output. Each
retained report contains concrete canonical response metadata, bounded
stream/quota facts, and SHA-256-only session-rotation observations.

npm publication remains an explicit external release action. The repository
validates a byte-identical double pack, an exact archive allowlist, a credential
scan, and clean ESM and TypeScript consumers. A stable annotated version tag can
then invoke the separately permissioned OIDC workflow described in
[`releasing.md`](releasing.md). The `1.0.0` source coordinate passes the stable
version check, but has not been published by these source-only checks.
