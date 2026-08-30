# Vercel AI SDK custom-provider spike

## Question

Can Latchway expose feature-selected Vercel AI models without defining a new
prompt, message, tool, or stream abstraction?

## Evidence

- Exact packages exercised: `ai` 7.0.85 and `@ai-sdk/openai` 4.0.52.
- `createLatchwayProvider` builds official OpenAI-compatible Responses, Chat,
  and Embedding models with a feature-bound custom fetch.
- Real `generateText` and `streamText` calls preserve AI SDK results and
  incremental text behavior and forward AbortSignal while attaching
  `vercel-ai-sdk` version metadata.
- The public factory accepts a Latchway transport and feature only; provider
  API key, base URL, and physical model are not caller configuration.

## Decision

The official provider's custom-fetch seam is sufficient for the current thin
adapter. The adapter remains a provider factory, not an AI framework.

## Remaining conformance

Responses-mode fixtures, embeddings, tools, structured output, live in-flight
cancellation, error translation, session-rotation retries, minimum/latest versions, and the
shared live core suite remain required. The canonical registry currently names
`@latchway/ai-sdk`; this implementation uses the requested
`@latchway/vercel-ai`, so the core registry needs an owner-reviewed correction
before publication.
