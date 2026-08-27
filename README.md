# Latchway JavaScript SDK

Latchway lets browser and Node.js applications call AI infrastructure through a
self-hosted gateway without embedding an upstream provider key. This repository
will provide the TypeScript client and explicit fetch integration.

> **Project status:** Governance foundation only. No npm package or supported
> release exists yet. Do not add this repository as a dependency.

## Planned scope

The package **@latchway/client** will expose root, browser, Node.js, Firebase,
and Turnstile entry points. It will:

- Use a non-exportable WebCrypto P-256 installation key in browsers
- Persist browser state in IndexedDB where available, with an explicit
  in-memory fallback
- Produce RFC 9449 DPoP proofs and manage short-lived Latchway sessions
- Wrap fetch without globally monkey-patching it
- Authorize arbitrary Request values
- Expose quota, installation-revocation, and redacted diagnostic APIs
- Support optional Firebase App Check and Turnstile providers
- Provide a clearly bounded Node.js mode for custom identity and conformance

Node.js mode does not provide application attestation. Browser WebCrypto
possession is useful but is not equivalent to Secure Enclave or Android
hardware-backed key storage.

## Protocol ownership

The Latchway core repository owns the client OpenAPI description, error
registry, protocol manifest, canonical attestation binding, DPoP vectors, and
compatibility rules. This SDK consumes a signed and checksummed contract bundle;
it does not define an independent wire protocol.

A contract lock is intentionally absent until the core repository publishes the
first bundle. See [Architecture](docs/architecture.md) for the dependency and
trust boundaries.

## Security model

The SDK holds a non-exportable browser key when the runtime supports it and
short-lived Latchway session state. It never receives an upstream AI-provider
credential and does not replace the application's identity provider. An
OpenAI-compatible placeholder API key must never be forwarded upstream.

Review [Security Policy](SECURITY.md) before reporting a vulnerability.

## Development

Build and test commands will be added with the package manifest and CI. Until
then, changes in this repository are limited to reviewed governance,
architecture, and contract-consumption foundations.

See [Contributing](CONTRIBUTING.md) and [Agent Instructions](AGENTS.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
