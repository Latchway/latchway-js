# `@latchway/openai`

Use the official OpenAI JavaScript SDK through a Latchway transport without
putting an upstream provider credential in application code.

```ts
import { createLatchwayOpenAI } from "@latchway/openai";

const openai = createLatchwayOpenAI({
  latchway,
  feature: "habit-assistant",
});

const response = await openai.responses.create({
  model: "latchway",
  input: "Summarize today",
});
```

`model: "latchway"` is a compatibility placeholder, not a physical model
selection. Routing remains server-owned. The adapter installs the exact
gateway base URL and a custom fetch tagged as `openai-js`. It does not buffer
streams or catch aborts. OpenAI SDK retries invoke the transport again, so each
attempt receives a fresh DPoP proof. Latchway correlation IDs are also exposed
through the OpenAI SDK's conventional request-ID header without buffering the
response body.
