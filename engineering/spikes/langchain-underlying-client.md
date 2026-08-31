# LangChain.js underlying-client spike

## Question

Can `@langchain/openai` use request-time Latchway authorization without static
headers or a fork?

## Evidence

- Exact package exercised: `@langchain/openai` 1.5.10.
- `ChatOpenAI` and `OpenAIEmbeddings` accept an underlying OpenAI client
  `configuration.fetch` and `baseURL`.
- Real `invoke` and `embedQuery` calls reach the expected Chat Completions and
  Embeddings paths through separate feature-bound transports; invoke forwards
  AbortSignal to the underlying fetch.
- Framework metadata carries `langchain-js` and the exact package version.
- Public adapter options exclude provider API key, physical model, and
  underlying OpenAI configuration.

## Decision

Underlying-client injection is viable for the chat and embedding surfaces. It
preserves LangChain messages and outputs and obtains authorization when the
underlying client dispatches each request.

## Follow-up conformance

The exact-version suite now covers streaming usage, in-flight and timeout
cancellation, bounded-concurrency batches, ordered results, per-item error
isolation, shared batch cancellation, tools, structured output, provider and
quota errors, retries after rotation, and minimum/latest profiles. Hosted
common conformance and exact release-image evidence remain required before a
stronger support claim.
