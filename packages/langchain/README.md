# `@latchway/langchain`

The LangChain.js adapter configures `ChatOpenAI` and `OpenAIEmbeddings` through
their underlying OpenAI client options. It does not introduce chains, agents,
graphs, memory, retrieval, or tool execution.

```ts
import { createLatchwayChatOpenAI } from "@latchway/langchain";

const model = createLatchwayChatOpenAI({
  latchway,
  feature: "habit-assistant",
});

const message = await model.invoke("Summarize today");
```

The generated OpenAI-compatible model value is `latchway`; it is not a
physical model selection. Streaming, batching, tools, structured output,
cancellation, callbacks, and framework retries remain LangChain behavior over
the authenticated transport.
