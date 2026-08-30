import { generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";

import { createLatchwayChatOpenAI, createLatchwayEmbeddings } from "../packages/langchain/src/index.js";
import { createLatchwayOpenAI } from "../packages/openai/src/index.js";
import { createLatchwayProvider } from "../packages/vercel-ai/src/index.js";
import type { AuthenticatedTransport, FrameworkMetadata } from "../src/types.js";

describe("framework adapters", () => {
  it("configures the official OpenAI SDK through a feature-bound fetch", async () => {
    const transport = new FrameworkFixtureTransport();
    const openai = createLatchwayOpenAI({ latchway: transport, feature: "habit-assistant" });

    const response = await openai.responses.create({ model: "latchway", input: "hello" });

    expect(response.output_text).toBe("hello from Latchway");
    expect(transport.bindings).toEqual([{
      feature: "habit-assistant",
      framework: { id: "openai-js", version: "7.8.0" },
    }]);
    expect(transport.requests[0]?.url).toBe("https://gateway.example.test/v1/responses");
    expect(transport.requests[0]?.headers.get("Authorization")).toBe(
      "Bearer latchway-managed-not-a-provider-secret",
    );
  });

  it("preserves OpenAI streaming and cancellation signals", async () => {
    const transport = new FrameworkFixtureTransport();
    const openai = createLatchwayOpenAI({ latchway: transport, feature: "habit-assistant" });
    const controller = new AbortController();
    const stream = await openai.chat.completions.create({
      model: "latchway",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }, { signal: controller.signal });
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk.choices[0]?.delta.content ?? "");
    expect(chunks.join("")).toBe("hello from Latchway");
    const forwardedSignal = transport.requests.at(-1)?.signal;
    expect(forwardedSignal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(forwardedSignal?.aborted).toBe(true);
  });

  it("creates Vercel AI SDK response and chat models from feature IDs", async () => {
    const transport = new FrameworkFixtureTransport();
    const provider = createLatchwayProvider({ client: transport });
    const controller = new AbortController();

    const generated = await generateText({
      model: provider.chat("weekly-summary"),
      prompt: "hello",
    });
    expect(generated.text).toBe("hello from Latchway");

    const streamed = streamText({
      model: provider.chat("weekly-summary"),
      prompt: "hello",
      abortSignal: controller.signal,
    });
    await expect(streamed.text).resolves.toBe("hello from Latchway");
    const forwardedSignal = transport.requests.at(-1)?.signal;
    controller.abort();
    expect(forwardedSignal?.aborted).toBe(true);
    expect(transport.bindings.every((binding) =>
      binding.feature === "weekly-summary" &&
      binding.framework.id === "vercel-ai-sdk" &&
      binding.framework.version === "7.0.85")).toBe(true);
  });

  it("configures LangChain ChatOpenAI and embeddings without a physical model option", async () => {
    const transport = new FrameworkFixtureTransport();
    const chat = createLatchwayChatOpenAI({ latchway: transport, feature: "journal-analysis" });
    const embeddings = createLatchwayEmbeddings({ latchway: transport, feature: "semantic-search" });
    const controller = new AbortController();

    const message = await chat.invoke("hello", { signal: controller.signal });
    expect(message.content).toBe("hello from Latchway");
    const forwardedSignal = transport.requests.at(-1)?.signal;
    controller.abort();
    expect(forwardedSignal?.aborted).toBe(true);
    await expect(embeddings.embedQuery("hello")).resolves.toEqual([0.25, 0.75]);
    expect(transport.bindings.every((binding) =>
      binding.framework.id === "langchain-js" && binding.framework.version === "1.5.10")).toBe(true);
  });
});

class FrameworkFixtureTransport implements AuthenticatedTransport {
  readonly gatewayURL = "https://gateway.example.test";
  readonly bindings: Array<{ feature: string; framework: FrameworkMetadata }> = [];
  readonly requests: Request[] = [];

  fetchFor(feature: string, framework?: FrameworkMetadata) {
    if (framework === undefined) throw new Error("The adapter omitted framework metadata.");
    this.bindings.push({ feature, framework });
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
      this.requests.push(request);
      const body = await request.clone().json() as Record<string, unknown>;
      if (new URL(request.url).pathname === "/v1/embeddings") return embeddingResponse();
      if (body.stream === true) return streamingChatResponse();
      if (new URL(request.url).pathname === "/v1/responses") return responsesResponse();
      return chatResponse();
    };
  }
}

function responsesResponse(): Response {
  return jsonResponse({
    id: "resp_latchway",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: "latchway",
    output: [{
      id: "msg_latchway",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "hello from Latchway", annotations: [], logprobs: [] }],
    }],
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  });
}

function chatResponse(): Response {
  return jsonResponse({
    id: "chatcmpl_latchway",
    object: "chat.completion",
    created: 1,
    model: "latchway",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "hello from Latchway" },
      finish_reason: "stop",
      logprobs: null,
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function embeddingResponse(): Response {
  return jsonResponse({
    object: "list",
    data: [{ object: "embedding", embedding: [0.25, 0.75], index: 0 }],
    model: "latchway",
    usage: { prompt_tokens: 1, total_tokens: 1 },
  });
}

function streamingChatResponse(): Response {
  const encoder = new TextEncoder();
  const events = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "hello " }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "from Latchway" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
  ];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id: "chatcmpl_latchway",
          object: "chat.completion.chunk",
          created: 1,
          model: "latchway",
          ...event,
        })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}
