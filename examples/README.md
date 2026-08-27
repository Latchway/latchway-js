# Examples

These source examples share the same public SDK surface and do not embed
identity, attestation, or provider credentials. Supply real provider callbacks
from the host application and run them against a Latchway environment whose
identity provider, web verifier, and allowed origins are configured.

- `vanilla/client.ts`: framework-free browser client
- `react/use-latchway.ts`: stable React client hook
- `firebase/client.ts`: Firebase Auth and App Check callback adapters
- `supabase/client.ts`: Supabase access-token identity
- `openai-sdk/client.ts`: custom-fetch configuration for OpenAI-compatible SDKs
- `node-conformance/client.ts`: bounded Node.js/debug conformance client

The examples intentionally do not inject Turnstile scripts, initialize Firebase
or Supabase, or mint debug evidence. Those operations belong to the application
or the core conformance harness. Real provider verification occurs on the
Latchway server.
