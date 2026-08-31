# `@latchway/vercel-ai`

The provider binds each Vercel AI SDK model instance to a Latchway feature.
The feature is the only routing selector exposed to application code.

```ts
import { generateText, streamText } from "ai";
import { createLatchwayProvider } from "@latchway/vercel-ai";

const provider = createLatchwayProvider({ client: latchway });
const result = await generateText({
  model: provider("habit-assistant"),
  prompt: "Summarize today",
});

const stream = streamText({
  model: provider.chat("habit-assistant"),
  prompt: "Summarize today",
});
```

The adapter delegates streaming, tools, structured output, cancellation,
middleware, and telemetry to the AI SDK. Every framework retry calls the
feature-bound transport and therefore receives a fresh DPoP proof. Latchway
correlation IDs are mirrored to the provider-compatible request-ID response
header without buffering streams.
