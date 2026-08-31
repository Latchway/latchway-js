# Examples

These source examples share the same public SDK surface and do not embed
identity, attestation, or provider credentials. Supply real provider callbacks
from the host application and run them against a Latchway environment whose
identity provider, web verifier, and allowed origins are configured.

- `raw-fetch/client.ts`: feature-bound framework-free fetch
- `vanilla/client.ts`: framework-free browser client construction
- `vanilla/development-client.ts`: loopback-only debug client whose signing
  callback remains operator-owned and outside browser code
- `vanilla/streaming-fetch.ts`: feature-bound Responses request, typed Problem
  mapping, `ReadableStream` consumption, request-ID correlation, and cancellation
- `react/use-latchway.ts`: stable React client hook
- `firebase/client.ts`: Firebase Auth and App Check callback adapters
- `supabase/client.ts`: Supabase access-token identity
- `openai/client.ts`: official OpenAI SDK adapter
- `vercel-ai/client.ts`: Vercel AI SDK provider adapter
- `langchain/client.ts`: LangChain.js `ChatOpenAI` adapter
- `service-worker/handler.ts`: explicit, same-origin service-worker routing
- `components/provision.ts`: root-to-child public-key provisioning and direct grant delivery
- `openai-sdk/client.ts`: low-level custom-fetch configuration reference
- `node-conformance/client.ts`: bounded Node.js/debug conformance client

The examples intentionally do not inject Turnstile scripts, initialize Firebase
or Supabase, or mint debug evidence. The loopback example accepts only the
result of an operator-owned challenge signer; it never accepts or stores that
signer's key. Those operations belong to the application or core conformance
harness. Real provider verification occurs on the Latchway server.
