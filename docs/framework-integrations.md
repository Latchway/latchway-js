# Framework integrations

Latchway framework packages are thin adapters over the public
`AuthenticatedTransport` interface. Applications continue to use framework
messages, tools, output schemas, streams, callbacks, and errors. Every adapter
binds one Latchway feature and injects a request-time fetch; it does not cache
an Authorization or DPoP header.

The versions below are the exact packages exercised by this repository. They
are prerelease evidence for this SDK workspace, not a minimum/latest support
range. The canonical core `compatibility/frameworks.yaml` registry records
these JavaScript integrations as `experimental`; hosted common conformance and
broader version-range evidence remain required before stronger support claims.

| Package | Framework package tested | Injection seam | Local evidence |
| --- | --- | --- | --- |
| `@latchway/openai` | `openai` 7.8.0 | official custom `fetch` and `baseURL` | Responses, Chat SSE, AbortSignal forwarding |
| `@latchway/vercel-ai` | `ai` 7.0.85 and `@ai-sdk/openai` 4.0.52 | custom provider backed by a custom `fetch` | `generateText`, `streamText`, AbortSignal, feature/version binding |
| `@latchway/langchain` | `@langchain/openai` 1.5.10 | underlying OpenAI client `configuration.fetch` | `ChatOpenAI.invoke`, OpenAI embeddings, AbortSignal, feature/version binding |

## OpenAI JavaScript SDK

```ts
import { createLatchwayOpenAI } from "@latchway/openai";

const openai = createLatchwayOpenAI({
  latchway,
  feature: "habit_assistant",
  clientOptions: { timeout: 30_000, maxRetries: 0 },
});

const response = await openai.responses.create({
  model: "latchway",
  input: "Summarize today",
});
```

The official SDK currently requires a model field and API-key constructor
value. The adapter supplies non-secret compatibility placeholders; Latchway's
transport removes the placeholder Authorization header before dispatch. The
server selects and rewrites the physical model. `clientOptions` deliberately
excludes `apiKey`, `baseURL`, and arbitrary default headers so application code
cannot replace the authenticated boundary.

OpenAI's SDK-level retries return through the custom fetch and therefore obtain
a current session and fresh proof. Latchway itself performs only the one safe
nonce retry and one pre-dispatch session-expiry retry. Set `maxRetries: 0` when
the application requires a single framework attempt.

## Vercel AI SDK

```ts
import { generateText, streamText } from "ai";
import { createLatchwayProvider } from "@latchway/vercel-ai";

const latchwayAI = createLatchwayProvider({ client: latchway });

const result = await generateText({
  model: latchwayAI("habit_assistant"),
  prompt: "Summarize today",
});

const stream = streamText({
  model: latchwayAI.chat("habit_assistant"),
  prompt: "Summarize today",
});
```

The provider exposes feature selectors, not physical provider/model selectors.
`responses`, `chat`, and `embedding` choose the corresponding OpenAI-compatible
wire surface while preserving AI SDK request/response objects.

## LangChain.js

```ts
import {
  createLatchwayChatOpenAI,
  createLatchwayEmbeddings,
} from "@latchway/langchain";

const chat = createLatchwayChatOpenAI({
  latchway,
  feature: "journal_analysis",
});

const embeddings = createLatchwayEmbeddings({
  latchway,
  feature: "semantic_search",
});

const message = await chat.invoke("Find this week's themes");
const vector = await embeddings.embedQuery("sleep quality");
```

The adapter removes API-key, model, and underlying client configuration from
its public option types. Embeddings request float encoding because Latchway's
OpenAI-compatible response returns numeric vectors.

## Security and accounting boundary

- Never pass a provider API key to an adapter or add one through framework
  headers or query parameters.
- The adapter records its exact framework identifier and package version in
  `X-Latchway-Framework` and `X-Latchway-Framework-Version`.
- The base transport enforces the gateway origin, declared route/method,
  feature namespace, redirect policy, placeholder stripping, replay rules,
  cancellation, and streaming.
- Trusted input-token preflight is performed by the server after physical
  model selection and request rewriting. Client token counters and model
  placeholders are never authoritative quota inputs.
- Provider-compatible final HTTP failures remain framework-visible. Session
  and protocol setup failures surface as `LatchwayError` before framework
  dispatch.

## Current limitations

This workspace does not yet claim a supported minimum/latest range. Common
conformance still needs live core tests for tools, structured output, provider
error mapping, quota denial, framework-owned retries after session rotation,
and every capability marked planned in the core registry. Audio, image, and
remote-file surfaces also require server route/protocol evidence before a
support claim.
