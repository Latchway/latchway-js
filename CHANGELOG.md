# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog, and releases will follow Semantic
Versioning once package publication begins.

## [Unreleased]

### Changed

- Require exact-image JavaScript release evidence for both Firebase App Check
  and Cloudflare Turnstile, with separate protected tokens and a non-secret
  provider identity bound into each retained conformance report.

## [1.0.0] - 2026-08-29

### Changed

- Synchronized the SDK contract lock, compatibility constants, and canonical
  fixtures to released Latchway contract 0.5.1 at core commit
  `2f5e5e67c824e270431f1232cc6dc2824848e380` and deterministic bundle SHA-256
  `52ebacd1e38c522b89bb14a1f34782176be32cdf91d22b7ab962003dbca2d754`,
  preserving wire protocol 1 and declaring server 1.0.0/1.0.x compatibility.
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
