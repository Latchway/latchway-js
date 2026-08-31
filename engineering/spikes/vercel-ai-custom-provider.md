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

## Follow-up conformance

The exact-version suite now covers Responses and Chat modes, embeddings, tools,
structured output, incremental stream callbacks, middleware wrapping,
telemetry lifecycle/recording options, in-flight cancellation, framework timeouts,
error translation, session-rotation retries, and minimum/latest profiles. The
shared hosted core suite and exact release-image evidence remain required.
