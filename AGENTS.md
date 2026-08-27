# AGENTS.md

These instructions apply to the entire Latchway JavaScript SDK repository.

## Mission and current phase

Build the TypeScript client that lets browser and bounded Node.js applications
authenticate to Latchway, establish DPoP-bound sessions, and authorize ordinary
fetch requests without holding an upstream provider credential.

The active implementation phase is Phase 12. The SDK consumes contract 0.1.0,
wire protocol 1, from the reviewed core contract bundle recorded in
`contract.lock`. Production source, package metadata, tests, examples, and CI
are authorized. Never invent a temporary wire contract or fake production
behavior.

## Authority and dependency boundaries

- The Latchway core repository is the sole owner of the client OpenAPI,
  protocol manifest, error codes, canonical attestation binding, DPoP vectors,
  and compatibility policy.
- Consume checksummed contract releases. Generated DTOs may be internal; public
  TypeScript APIs must remain handwritten and idiomatic.
- Planned exports are @latchway/client, /browser, /node, /firebase, and
  /turnstile. Keep their dependency graphs explicit and environment-safe.
- React Native may consume shared transport concepts but must use its native
  SDK dependencies for hardware keys and attestation.

## Security invariants

- Browser keys use non-exportable WebCrypto P-256 CryptoKey objects and
  IndexedDB persistence when supported. In-memory fallback must be explicit.
- Follow RFC 9449 for DPoP and consume the core canonical binding.
- Web possession must never be described as equivalent to hardware-backed
  native trust. Node.js mode must not claim application attestation.
- Do not monkey-patch global fetch by default.
- Strip rather than forward any compatibility placeholder API key.
- Coordinate refresh, handle server-time hints, and preserve cancellation and
  streaming semantics.
- Never log identity tokens, session tokens, refresh tokens, DPoP proofs,
  attestation tokens, private key material, or provider credentials.
- The SDK must never accept an upstream AI-provider secret.

## TypeScript implementation rules

- Keep browser-only and Node.js-only imports out of shared module evaluation.
- Design for strict TypeScript, modern runtime APIs, strict Content Security
  Policy, and deterministic test injection.
- Keep public APIs transport-oriented; do not add an AI framework.
- Avoid ambient global mutation and hidden persistent state.
- Keep test doubles outside production paths.
- No production TODO, FIXME, empty handler, hard-coded success, or placeholder
  response is acceptable.

## Testing and validation

When the package exists, every change must keep typecheck, lint, build, unit
tests, and package export checks passing. Security/protocol work requires shared
vectors and core-container conformance in supported browser and Node.js
runtimes. Test IndexedDB failure, in-memory fallback, clock skew, cancellation,
streaming, redaction, refresh races, strict CSP, and protocol rejection.

## Repository hygiene

- Do not commit secrets, storage exports, local environments, build output, or
  machine-specific absolute paths.
- Preserve unrelated user changes and keep generated output reproducible.
- Update documentation with public behavior.
- Use focused conventional commits when explicitly asked to commit.
- Optional .agents, .claude/skills, and skills-lock.json installations are
  local developer tooling, never build or release inputs.
