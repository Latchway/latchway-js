# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog, and releases will follow Semantic
Versioning once package publication begins.

## [Unreleased]

### Changed

- Synchronize the SDK, runtime headers, release evidence, and all four canonical
  fixtures to draft Latchway contract 1.0.0 at core commit
  `a62b0f6aa2328604101c1073c56f5ecb3bed3618` and deterministic bundle SHA-256
  `36aa3c4786e60f2cdbbc3d0cd2f65bffe894a099479517b2e1faa01361c74b00`,
  emitting current wire protocol 2 while retaining legacy grant parsing.
- Require exact-image JavaScript release evidence for both Firebase App Check
  and Cloudflare Turnstile, with separate protected tokens and a non-secret
  provider identity bound into each retained conformance report.
- Restrict authenticated transports to contract-declared method/path pairs,
  reject redirected or cross-origin responses, attach exact framework
  metadata, and fail closed rather than replaying streaming request bodies.
- Parse and persist Installation Family, component grant, feature scope, and
  trust provenance fields without weakening legacy wire compatibility.

### Added

- Feature-bound `fetchFor`, root-managed component provisioning/revocation,
  Installation Family revocation, and an explicit service-worker handler.
- Workspace adapter packages for OpenAI JavaScript 7.8.0, Vercel AI SDK 7.0.85
  with `@ai-sdk/openai` 4.0.52, and LangChain OpenAI 1.5.10.
- Real-framework tests, examples, integration guides, and capability-spike
  records. Compatibility remains experimental until broader-version and live
  common conformance evidence exists.

## [1.0.0] - 2026-08-30

### Changed

- Established the original reviewed client-contract lock, compatibility
  constants, canonical fixtures, and server 1.0.0/1.0.x compatibility policy.
- Hardened control and RFC 9457 response parsing with bounded fatal UTF-8,
  duplicate-member and nesting rejection, exact error-registry metadata,
  request-ID correlation, and canonical operation reconciliation identifiers.
- Expanded provider-credential stripping and reject credential-like query
  names before identity acquisition or network dispatch.
- Restricted automatic proof/session retries to unambiguous nonce and exact
  pre-dispatch Problem responses.
- Bound Turnstile Siteverify verdicts to the session challenge through widget
  `cData`, send token-only evidence, and require a fresh challenge instead of
  attempting to reuse single-use Turnstile evidence during refresh.

### Added

- Initial governance, contribution, security, and architecture documentation.
- Contract 0.1.0 lock and canonical DPoP and attestation-binding fixtures.
- Handwritten browser and Node.js clients with DPoP session orchestration.
- Non-exportable WebCrypto P-256 keys, IndexedDB state, explicit memory fallback,
  and cross-tab refresh leases.
- Streaming and cancellation-preserving fetch integration with credential
  stripping, nonce retry, stable errors, quota, diagnostics, and revocation.
- Firebase identity/App Check and Turnstile adapter entry points.
- Strict TypeScript, lint, unit, CSP, export, package, and reproducibility gates.
- SHA-pinned CI and a fail-closed annotated-tag release path with deterministic
  archive evidence, clean-package consumers, npm OIDC trusted publishing,
  provenance/signature verification, and checksummed GitHub release assets.
