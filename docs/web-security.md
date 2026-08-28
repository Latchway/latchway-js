# Web Security Model

## What the SDK protects

- AI-provider credentials remain on the Latchway server.
- The P-256 private key is non-exportable and stored as a CryptoKey.
- Session and key state never use localStorage, cookies, URLs, logs, or error
  messages.
- DPoP binds each access token to the installation key and exact request method
  and URI. Every proof uses a fresh identifier.
- The SDK signs only the configured gateway origin and strips common provider
  credential headers before authorization. Credential-like query names are
  rejected before identity acquisition or network dispatch.
- Security-sensitive JSON is byte- and depth-bounded, uses fatal UTF-8, rejects
  duplicate object members, and cannot trigger a retry until canonical Problem
  metadata correlates with the response request-ID header.
- Strict CSP is supported: the package does not use `eval`, `new Function`,
  inline-script injection, or a provider script loader.

## What the SDK cannot protect

Malicious same-origin JavaScript can call non-exportable keys and read
IndexedDB tokens through the browser APIs. Preventing XSS, isolating untrusted
content, setting CSP, reviewing third-party scripts, and enforcing allowed web
origins remain application and server responsibilities. Non-exportable
WebCrypto keys are not Secure Enclave, StrongBox, or Android Keystore keys.

IndexedDB tokens are not encrypted with a same-origin JavaScript-accessible key:
such encryption would not stop an XSS attacker that can invoke the decryption
code. Applications needing hardware-backed trust should use the native iOS,
Android, or React Native integrations.

## Deployment requirements

- Serve the application and gateway over HTTPS. HTTP requires an explicit SDK
  option and is intended only for local conformance.
- Configure the gateway allowed-origin list narrowly.
- Use a strict CSP and minimize third-party JavaScript.
- Obtain Turnstile or Firebase App Check tokens through their official SDK and
  let Latchway verify them server-side. Execute Turnstile once for each session
  challenge with the configured `action` and with `cData` set exactly to the
  challenge's `client_data_hash`; never attach provider evidence or identity
  tokens to refresh. Step-up always uses a new server challenge.
- Treat diagnostics as operational data and never attach browser storage
  exports or live tokens to bug reports.
- Revoke the current installation after suspected origin compromise.

## Persistence choices

`required` is the browser default. `allow-memory` must be selected explicitly
and trades continuity for compatibility when IndexedDB is blocked. `memory`
intentionally skips persistent storage and is primarily useful for controlled
tests. Diagnostics report the active mode.
