# Security Policy

## Release status

Latchway JavaScript SDK is pre-release and does not yet have a supported
production version. Do not use this repository as a security boundary until a
release is published and its compatibility entry is recorded.

Security fixes will target supported releases once the support matrix is
established. The unreleased branch may change without compatibility guarantees.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository. If that feature
is unavailable, contact the Latchway organization maintainers privately before
sharing details. Do not open a public issue for a suspected vulnerability.

Do not include live identity tokens, refresh tokens, DPoP proofs, App Check or
Turnstile tokens, private keys, provider credentials, or user data in a report.
Revoke exposed credentials before continuing.

A useful report includes:

- The affected revision or released version
- The browser or Node.js runtime and storage conditions
- Reproduction steps using synthetic or redacted data
- The expected and observed security behavior
- Impact, prerequisites, and any known mitigations

## Security-sensitive scope

Treat changes to non-exportable WebCrypto keys, IndexedDB persistence, P-256
signing, JWK thumbprints, DPoP proofs, refresh coordination, origin/path/method
and redirect enforcement, component provisioning, framework fetch wrapping,
token redaction, and browser-versus-Node trust claims as security-sensitive.
They require focused tests and cross-repository conformance.

WebCrypto possession is not equivalent to hardware-backed native attestation.
The SDK must never accept or forward an upstream AI-provider secret. Latchway
server vulnerabilities should be reported against the core repository, with a
cross-reference here when client behavior is involved.

## Disclosure

Allow maintainers a reasonable opportunity to investigate and coordinate a fix
before public disclosure. Good-faith research that avoids privacy violations,
service disruption, and access beyond what is necessary is welcome.
