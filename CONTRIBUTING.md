# Contributing to Latchway JavaScript SDK

Thank you for helping build Latchway. This repository consumes the reviewed
core contract bundle recorded in `contract.lock`; wire changes begin in the
core repository and must update the lock and canonical fixtures together.

## Before making a change

1. Read AGENTS.md and docs/architecture.md.
2. Confirm which repository owns the behavior. Wire protocol changes begin in
   the Latchway core repository.
3. Keep the change to one reviewable concern and explain its security impact.
4. Never commit credentials, identity tokens, attestation tokens, browser
   storage exports, provider secrets, or local environment files.

## Design and implementation rules

- Public TypeScript APIs are handwritten and idiomatic; generated wire models,
  when introduced, remain internal.
- Keep root, browser, Node.js, Firebase, and Turnstile export boundaries
  dependency-safe.
- Browser keys should be non-exportable. Node.js mode must not claim native or
  application attestation.
- Do not monkey-patch global fetch by default.
- Never forward an OpenAI-compatible placeholder API key to an upstream.
- Do not edit wire behavior independently of the checksummed core contract.
- Do not leave production-path placeholders or hard-coded success behavior.

## Tests

Every functional change must include proportionate unit tests. Security or
protocol work also requires shared-vector, browser, Node.js, and conformance
coverage. Storage failure, clock skew, cancellation, streaming, redaction, and
strict Content Security Policy behavior must be tested where relevant.

Run `pnpm release:check` with the versions pinned in `mise.toml`. It includes
contract, lint, type, test, build, export, reproducibility, package allowlist,
and clean-consumer gates. A contribution is not ready while a documented check
fails.

## Pull requests

Use focused commits with conventional subjects such as feat(js), fix(session),
test(conformance), or docs(security). Describe compatibility impact, runtimes
tested, and tests run. Generated changes must be reproducible and reviewed with
their source contract.

By contributing, you agree that your contribution is licensed under the
Apache License, Version 2.0.
