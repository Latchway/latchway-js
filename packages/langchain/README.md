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
cancellation and callbacks remain LangChain behavior over the authenticated
transport. As of 1.1.0, chat and embeddings default to zero framework retries;
explicitly opt in with `maxRetries` only when your dispatch/billing policy permits.
Latchway correlation IDs are mirrored to the underlying OpenAI client's
conventional request-ID header without buffering the response.

## Stateless Responses (1.1.0)

```ts
import {
  createLatchwayResponsesModel, bindLatchwayTools, toLatchwayReplayMessage,
} from '@latchway/langchain';

const model = createLatchwayResponsesModel({
  latchway,
  feature: 'assistant', // gateway 1.0.2+, configured openai_responses feature
  reasoning: {effort: 'none'}, // only if the server-selected model supports it
  chatOptions: {maxTokens: 1024},
});
const modelWithTools = bindLatchwayTools(model, [weatherTool]);
const answer = await modelWithTools.invoke(messages, {signal});
messages.push(toLatchwayReplayMessage(answer));
```

Omit `reasoning` for routes that do not accept it. The adapter cannot infer
capabilities from the server-owned model alias. This opt-in factory selects the
Responses API with `store:false` and local history, disables stored-response
reuse, and rejects `include`, `previous_response_id`, `conversation` and
conflicting storage/reasoning kwargs. It does not promise provider-wide zero
retention. Existing `createLatchwayChatOpenAI` still defaults to Chat Completions.

`bindLatchwayTools` wraps ordinary LangChain `bindTools` with `strict:true` and
`parallel_tool_calls:false`. These are overridable boolean defaults, not a tool
executor. Tools need strict-compatible schemas; callers own validation,
allowlists, timeouts, loop limits, cancellation and correlated ToolMessages.

`toLatchwayReplayMessage` accepts a completed AIMessage or fully aggregated
AIMessageChunk. It copies local text/function calls, preserves tool-call IDs,
and removes provider item IDs and observational metadata. Keep the original
for usage/callback information. Unsupported non-text/opaque reasoning/refusal,
invalid calls and duplicate/missing call IDs throw rather than silently losing
context. Partial/failed stream chunks must not enter conversation history.

Use ordinary `model.stream(messages, {signal})` and
`model.withStructuredOutput(schema, {method:'jsonSchema', strict:true})` when the
configured gateway route/model supports the schema. No chains, memory, tools,
agents or persistence are created by the adapter.

## React Native

Install npm packages, not repository links:

```sh
npm install --save-exact @latchway/react-native@1.1.0 @latchway/langchain@1.1.0 \
  @latchway/client@1.0.0 @langchain/core@1.2.9 @langchain/openai@1.5.10 openai@7.8.0
```

For React Native 0.82 / New Architecture, put this **first** in `index.js`:

```js
import '@latchway/react-native/polyfills';
```

In `babel.config.js`:

```js
const {withLatchwayBabel} = require('@latchway/react-native/babel');
module.exports = withLatchwayBabel({
  presets: ['module:@react-native/babel-preset'],
});
```

Use standard Metro and pass the React Native `LatchwayClient` directly as
`latchway`. Rebuild native hosts after installation. Authentication, signing,
attestation and credentials remain native; the adapter never accepts a provider
key. Native framework attribution remains `react-native-fetch`.

See the [complete React Native guide](https://github.com/Latchway/latchway-react-native-sdk/blob/main/docs/langchain.md)
and [npm-only LatchwayChat example](https://github.com/Latchway/latchway-react-native-sdk/tree/main/Examples/LatchwayChat)
for Firebase authentication, weather tools, streaming and device-evidence limits.
The supported dependency versions are intentionally exact; other versions are
not implied by these tests. [LangChain reference](https://docs.langchain.com/oss/javascript/integrations/chat/openai).
