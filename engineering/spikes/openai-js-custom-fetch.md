# OpenAI JavaScript custom-fetch spike

## Question

Can the official `openai` package preserve its native API while every request
is authorized at dispatch by a feature-bound Latchway transport?

## Evidence

- Exact package exercised: `openai` 7.8.0.
- `createLatchwayOpenAI` supplies the documented custom `fetch` and `baseURL`
  constructor options.
- A real `responses.create` call reaches `/v1/responses` through the injected
  fetch with `openai-js` and the exact package version bound to the feature.
- A real streaming Chat Completions call consumes incremental SSE and forwards
  the caller AbortSignal.
- Base transport tests prove the SDK placeholder Authorization value and common
  provider credentials are removed before authenticated dispatch.
- Base transport tests prove a safe nonce retry creates a new proof and a
  non-replayable body is never buffered.

## Decision

The custom-fetch seam is viable for a first-party adapter. The official client
remains the application API. Its required model and API-key values are
non-secret compatibility placeholders, while physical model selection and
provider credentials remain server-owned.

## Follow-up conformance

The exact-version suite now covers minimum/latest profiles, Responses and Chat
tools/schema preservation, embeddings, provider and quota errors, request-ID
correlation, SDK timeouts and AbortSignal cancellation, retries with fresh
proofs, and scheduled bounded newest-compatible observation. Hosted common
conformance, live-provider behavior, and exact release-image evidence remain
required before the core registry can move beyond `experimental`.
