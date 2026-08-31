import {
  embed,
  generateText,
  jsonSchema,
  Output,
  streamText,
  type Telemetry,
  tool,
  wrapLanguageModel,
} from "ai";
import { zodTextFormat } from "openai/helpers/zod";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  assertFrameworkCaseCoverage,
  frameworkCaseTitle,
  type FrameworkCaseID,
  type JavaScriptFrameworkID,
} from "../conformance/framework/cases.js";
import {
  createFrameworkClient,
  chatResponse,
  defaultFrameworkReply,
  FrameworkGatewayFixture,
  latchwayProblem,
  pendingUntilAborted,
  providerError,
  serializedError,
  streamingChatResponse,
} from "../conformance/framework/fixture.js";
import {
  createLatchwayChatOpenAI,
  createLatchwayEmbeddings,
  LANGCHAIN_OPENAI_VERSION,
} from "../packages/langchain/src/index.js";
import { createLatchwayOpenAI, OPENAI_VERSION } from "../packages/openai/src/index.js";
import {
  createLatchwayProvider,
  VERCEL_AI_SDK_VERSION,
} from "../packages/vercel-ai/src/index.js";
import type { AuthenticatedTransport, FrameworkMetadata } from "../src/types.js";

const registered = new Map<JavaScriptFrameworkID, Set<FrameworkCaseID>>();
const secretFragments = [
  "identity-token-conformance-only",
  "latchway-managed-not-a-provider-secret",
  "access-1-",
  "refresh-1-",
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OpenAI JavaScript conformance", () => {
  const framework = "openai-js";

  frameworkTest(framework, "FW-AUTH-001", async () => {
    const gateway = new FrameworkGatewayFixture();
    const openai = createLatchwayOpenAI({ latchway: createFrameworkClient(gateway), feature: "assistant" });
    await openai.responses.create({ model: "latchway", input: "hello" });
    expectBinding(gateway, "assistant", framework, OPENAI_VERSION);
  });

  frameworkTest(framework, "FW-REQ-001", async () => {
    const gateway = new FrameworkGatewayFixture();
    const response = await createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    }).responses.create({ model: "latchway", input: "hello" });
    expect(response.output_text).toBe("hello from Latchway");
    expect(gateway.dataRequests[0]?.url.pathname).toBe("/v1/responses");
    expect(gateway.dataRequests[0]?.body.input).toBe("hello");
  });

  frameworkTest(framework, "FW-REQ-002", async () => {
    const gateway = new FrameworkGatewayFixture();
    const response = await createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    }).chat.completions.create({
      model: "latchway",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(response.choices[0]?.message.content).toBe("hello from Latchway");
    expect(gateway.dataRequests[0]?.url.pathname).toBe("/v1/chat/completions");
  });

  frameworkTest(framework, "FW-REQ-003", async () => {
    const gateway = new FrameworkGatewayFixture();
    const response = await createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway), feature: "semantic_search",
    }).embeddings.create({ model: "latchway", input: "hello", encoding_format: "float" });
    expect(response.data[0]?.embedding).toEqual([0.25, 0.75]);
    expect(gateway.dataRequests[0]?.url.pathname).toBe("/v1/embeddings");
  });

  frameworkTest(framework, "FW-REQ-004", async () => {
    const gateway = new FrameworkGatewayFixture();
    await createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    }).responses.create({
      model: "latchway",
      input: "hello",
      metadata: { case_id: "FW-REQ-004" },
    }, { headers: { "X-Conformance-Trace": "safe-trace" } });
    const request = requiredRequest(gateway);
    expect(request.headers.get("X-Conformance-Trace")).toBe("safe-trace");
    expect(request.body.metadata).toEqual({ case_id: "FW-REQ-004" });
  });

  frameworkTest(framework, "FW-REQ-005", async () => {
    const gateway = new FrameworkGatewayFixture();
    const openai = createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    });
    const responsesStream = await openai.responses.create({
      model: "latchway",
      input: "hello",
      stream: true,
    });
    let responsesText = "";
    let responsesTotalTokens: number | undefined;
    for await (const event of responsesStream) {
      if (event.type === "response.output_text.delta") responsesText += event.delta;
      if (event.type === "response.completed") responsesTotalTokens = event.response.usage?.total_tokens;
    }
    expect(responsesText).toBe("hello from Latchway");
    expect(responsesTotalTokens).toBe(3);

    const chatStream = await openai.chat.completions.create({
      model: "latchway",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = "";
    let totalTokens: number | undefined;
    for await (const chunk of chatStream) {
      text += chunk.choices[0]?.delta.content ?? "";
      totalTokens = chunk.usage?.total_tokens ?? totalTokens;
    }
    expect(text).toBe("hello from Latchway");
    expect(totalTokens).toBe(3);
  });

  frameworkTest(framework, "FW-REQ-006", async () => {
    const gateway = new FrameworkGatewayFixture(pendingUntilAborted);
    const controller = new AbortController();
    const pending = createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
      clientOptions: { maxRetries: 0 },
    }).responses.create({ model: "latchway", input: "hello" }, { signal: controller.signal });
    await gateway.waitForDataRequests(1);
    controller.abort(new DOMException("conformance cancellation", "AbortError"));
    await expect(pending).rejects.toBeDefined();
    expect(requiredRequest(gateway).signal.aborted).toBe(true);
  });

  frameworkTest(framework, "FW-REQ-007", async () => {
    const gateway = new FrameworkGatewayFixture(pendingUntilAborted);
    const errorPromise = captureError(() => createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway),
      feature: "assistant",
      clientOptions: { maxRetries: 0, timeout: 25 },
    }).responses.create({ model: "latchway", input: "hello" }));
    await gateway.waitForDataRequests(1);
    const error = await errorPromise;
    expect(requiredRequest(gateway).signal.aborted).toBe(true);
    expect(serializedError(error)).toMatch(/timed? ?out|timeout/iu);
  });

  frameworkTest(framework, "FW-BEH-001", async () => {
    const gateway = new FrameworkGatewayFixture();
    await createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    }).responses.create({
      model: "latchway",
      input: "hello",
      tools: [{
        type: "function",
        name: "lookup_habit",
        description: "Looks up a habit.",
        parameters: objectSchema("habit"),
        strict: true,
      }],
    });
    expect(findTool(requiredRequest(gateway).body, "lookup_habit")).toMatchObject({
      type: "function",
      name: "lookup_habit",
      strict: true,
    });
  });

  frameworkTest(framework, "FW-BEH-002", async () => {
    const gateway = new FrameworkGatewayFixture();
    const openai = createLatchwayOpenAI({ latchway: createFrameworkClient(gateway), feature: "assistant" });
    const response = await openai.responses.parse({
      model: "latchway",
      input: "hello",
      text: { format: zodTextFormat(z.object({ summary: z.string() }), "summary") },
    });
    expect(response.output_parsed).toEqual({ summary: "hello from Latchway" });
    expect(nestedValue(requiredRequest(gateway).body, "text", "format", "type")).toBe("json_schema");
  });

  frameworkTest(framework, "FW-BEH-003", async () => {
    const gateway = new FrameworkGatewayFixture(() => latchwayProblem("quota_exceeded"));
    const error = await captureError(() => createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant", clientOptions: { maxRetries: 0 },
    }).responses.create({ model: "latchway", input: "hello" }));
    expectFrameworkError(error, 429, "quota_exceeded");
  });

  frameworkTest(framework, "FW-BEH-004", async () => {
    const gateway = new FrameworkGatewayFixture(providerError);
    const error = await captureError(() => createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant", clientOptions: { maxRetries: 0 },
    }).responses.create({ model: "latchway", input: "hello" }));
    expectFrameworkError(error, 502, "upstream_unavailable");
  });

  frameworkTest(framework, "FW-BEH-005", async () => {
    const gateway = retryingProviderGateway();
    const response = await createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant", clientOptions: { maxRetries: 1 },
    }).responses.create({ model: "latchway", input: "hello" });
    expect(response.output_text).toBe("hello from Latchway");
    expectFreshProofs(gateway, 2);
  });

  frameworkTest(framework, "FW-BEH-006", async () => {
    const gateway = refreshingGateway();
    const response = await createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant", clientOptions: { maxRetries: 0 },
    }).responses.create({ model: "latchway", input: "hello" });
    expect(response.output_text).toBe("hello from Latchway");
    expect(gateway.refreshCalls).toBe(1);
    expectFreshProofs(gateway, 2);
  });

  frameworkTest(framework, "FW-SEC-001", async () => {
    const gateway = new FrameworkGatewayFixture();
    await createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    }).responses.create({ model: "latchway", input: "hello" }, {
      headers: { Authorization: "Bearer caller-override", "X-API-Key": "provider-secret" },
    });
    expectPlaceholderStripped(gateway);
  });

  frameworkTest(framework, "FW-SEC-002", async () => {
    const gateway = new FrameworkGatewayFixture();
    const client = createFrameworkClient(gateway);
    const originError = await captureError(() => createLatchwayOpenAI({
      latchway: mismatchedOrigin(client), feature: "assistant", clientOptions: { maxRetries: 0 },
    }).responses.create({ model: "latchway", input: "hello" }));
    const pathError = await captureError(() => createLatchwayOpenAI({
      latchway: mismatchedPath(client), feature: "assistant", clientOptions: { maxRetries: 0 },
    }).responses.create({ model: "latchway", input: "hello" }));
    expect(serializedError(originError)).toContain("transport_destination_not_allowed");
    expect(serializedError(pathError)).toContain("transport_destination_not_allowed");
    expect(gateway.challengeCalls).toBe(0);
  });

  frameworkTest(framework, "FW-SEC-003", async () => {
    const gateway = new FrameworkGatewayFixture(() => latchwayProblem("quota_exceeded"));
    const error = await captureError(() => createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant", clientOptions: { maxRetries: 0 },
    }).responses.create({ model: "latchway", input: "hello" }));
    expectRedacted(error);
  });

  frameworkTest(framework, "FW-SEC-004", async () => {
    const globalFetch = vi.fn(async () => { throw new Error("global fetch must not run"); });
    vi.stubGlobal("fetch", globalFetch);
    const gateway = new FrameworkGatewayFixture();
    await createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    }).responses.create({ model: "latchway", input: "hello" });
    expect(globalThis.fetch).toBe(globalFetch);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  frameworkTest(framework, "FW-OAI-001", async () => {
    const gateway = new FrameworkGatewayFixture();
    const response = await createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway),
      feature: "assistant",
    }).chat.completions.create({
      model: "latchway",
      messages: [{ role: "user", content: "hello" }],
      tools: [{
        type: "function",
        function: {
          name: "lookup_habit",
          description: "Looks up a habit.",
          parameters: objectSchema("habit"),
          strict: true,
        },
      }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "summary",
          schema: objectSchema("summary"),
          strict: true,
        },
      },
    });
    expect(response.choices[0]?.message.content).toBe('{"summary":"hello from Latchway"}');
    expect(findTool(requiredRequest(gateway).body, "lookup_habit")).toMatchObject({
      type: "function",
      function: { name: "lookup_habit", strict: true },
    });
    expect(nestedValue(requiredRequest(gateway).body, "response_format", "type")).toBe("json_schema");
  });

  frameworkTest(framework, "FW-OAI-002", async () => {
    const gateway = new FrameworkGatewayFixture();
    const result = await createLatchwayOpenAI({
      latchway: createFrameworkClient(gateway),
      feature: "assistant",
    }).responses.create({ model: "latchway", input: "hello" }).withResponse();
    expect(result.request_id).toBe("req_framework_case_123");
    expect(result.response.headers.get("X-Request-ID")).toBe("req_framework_case_123");
    expect(asRecord(result.data)._request_id).toBe("req_framework_case_123");
    expect(result.response.status).toBe(200);
  });

  afterAll(() => {
    assertFrameworkCaseCoverage(framework, requiredRegistration(framework));
  });
});

describe("Vercel AI SDK conformance", () => {
  const framework = "vercel-ai-sdk";

  frameworkTest(framework, "FW-AUTH-001", async () => {
    const gateway = new FrameworkGatewayFixture();
    await generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "hello",
      maxRetries: 0,
    });
    expectBinding(gateway, "assistant", framework, VERCEL_AI_SDK_VERSION);
  });

  frameworkTest(framework, "FW-REQ-001", async () => {
    const gateway = new FrameworkGatewayFixture();
    const result = await generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "hello",
      maxRetries: 0,
    });
    expect(result.text).toBe("hello from Latchway");
    expect(requiredRequest(gateway).url.pathname).toBe("/v1/responses");
  });

  frameworkTest(framework, "FW-REQ-002", async () => {
    const gateway = new FrameworkGatewayFixture();
    const result = await generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).chat("assistant"),
      prompt: "hello",
      maxRetries: 0,
    });
    expect(result.text).toBe("hello from Latchway");
    expect(requiredRequest(gateway).url.pathname).toBe("/v1/chat/completions");
  });

  frameworkTest(framework, "FW-REQ-003", async () => {
    const gateway = new FrameworkGatewayFixture();
    const result = await embed({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).embedding("semantic_search"),
      value: "hello",
      maxRetries: 0,
    });
    expect(result.embedding).toEqual([0.25, 0.75]);
    expect(requiredRequest(gateway).url.pathname).toBe("/v1/embeddings");
  });

  frameworkTest(framework, "FW-REQ-004", async () => {
    const gateway = new FrameworkGatewayFixture();
    await generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "hello",
      headers: { "X-Conformance-Trace": "safe-trace" },
      providerOptions: { openai: { metadata: { case_id: "FW-REQ-004" } } },
      maxRetries: 0,
    });
    const request = requiredRequest(gateway);
    expect(request.headers.get("X-Conformance-Trace")).toBe("safe-trace");
    expect(request.body.metadata).toEqual({ case_id: "FW-REQ-004" });
  });

  frameworkTest(framework, "FW-REQ-005", async () => {
    const gateway = new FrameworkGatewayFixture();
    const provider = createLatchwayProvider({ client: createFrameworkClient(gateway) });
    const responsesResult = streamText({
      model: provider.responses("assistant"),
      prompt: "hello",
      maxRetries: 0,
    });
    await expect(responsesResult.text).resolves.toBe("hello from Latchway");
    await expect(responsesResult.usage).resolves.toMatchObject({
      inputTokens: 1, outputTokens: 2, totalTokens: 3,
    });

    const chatResult = streamText({ model: provider.chat("assistant"), prompt: "hello", maxRetries: 0 });
    await expect(chatResult.text).resolves.toBe("hello from Latchway");
    await expect(chatResult.usage).resolves.toMatchObject({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  frameworkTest(framework, "FW-REQ-006", async () => {
    const gateway = new FrameworkGatewayFixture(pendingUntilAborted);
    const controller = new AbortController();
    const pending = generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "hello",
      abortSignal: controller.signal,
      maxRetries: 0,
    });
    await gateway.waitForDataRequests(1);
    controller.abort(new DOMException("conformance cancellation", "AbortError"));
    await expect(pending).rejects.toBeDefined();
    expect(requiredRequest(gateway).signal.aborted).toBe(true);
  });

  frameworkTest(framework, "FW-REQ-007", async () => {
    const gateway = new FrameworkGatewayFixture(pendingUntilAborted);
    const errorPromise = captureError(() => generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "hello",
      timeout: 25,
      maxRetries: 0,
    }));
    await gateway.waitForDataRequests(1);
    const error = await errorPromise;
    expect(requiredRequest(gateway).signal.aborted).toBe(true);
    expect(serializedError(error)).toMatch(/timed? ?out|timeout/iu);
  });

  frameworkTest(framework, "FW-BEH-001", async () => {
    const gateway = new FrameworkGatewayFixture();
    await generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "hello",
      tools: {
        lookup_habit: tool({
          description: "Looks up a habit.",
          inputSchema: jsonSchema(objectSchema("habit")),
        }),
      },
      maxRetries: 0,
    });
    expect(findTool(requiredRequest(gateway).body, "lookup_habit")).toBeDefined();
  });

  frameworkTest(framework, "FW-BEH-002", async () => {
    const gateway = new FrameworkGatewayFixture();
    const result = await generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "hello",
      output: Output.object<{ summary: string }>({
        name: "summary",
        schema: jsonSchema(objectSchema("summary")),
      }),
      maxRetries: 0,
    });
    expect(result.output).toEqual({ summary: "hello from Latchway" });
    expect(nestedValue(requiredRequest(gateway).body, "text", "format", "type")).toBe("json_schema");
  });

  frameworkTest(framework, "FW-BEH-003", async () => {
    const gateway = new FrameworkGatewayFixture(() => latchwayProblem("quota_exceeded"));
    const error = await captureError(() => generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "hello", maxRetries: 0,
    }));
    expectFrameworkError(error, 429, "quota_exceeded");
  });

  frameworkTest(framework, "FW-BEH-004", async () => {
    const gateway = new FrameworkGatewayFixture(providerError);
    const error = await captureError(() => generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "hello", maxRetries: 0,
    }));
    expectFrameworkError(error, 502, "upstream_unavailable");
  });

  frameworkTest(framework, "FW-BEH-005", async () => {
    const gateway = retryingProviderGateway();
    const result = await generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "hello", maxRetries: 1,
    });
    expect(result.text).toBe("hello from Latchway");
    expectFreshProofs(gateway, 2);
  });

  frameworkTest(framework, "FW-BEH-006", async () => {
    const gateway = refreshingGateway();
    const result = await generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "hello", maxRetries: 0,
    });
    expect(result.text).toBe("hello from Latchway");
    expect(gateway.refreshCalls).toBe(1);
    expectFreshProofs(gateway, 2);
  });

  frameworkTest(framework, "FW-SEC-001", async () => {
    const gateway = new FrameworkGatewayFixture();
    await generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "hello",
      headers: { Authorization: "Bearer caller-override", "X-API-Key": "provider-secret" },
      maxRetries: 0,
    });
    expectPlaceholderStripped(gateway);
  });

  frameworkTest(framework, "FW-SEC-002", async () => {
    const gateway = new FrameworkGatewayFixture();
    const client = createFrameworkClient(gateway);
    const originError = await captureError(() => generateText({
      model: createLatchwayProvider({ client: mismatchedOrigin(client) })
        .responses("assistant"),
      prompt: "hello", maxRetries: 0,
    }));
    const pathError = await captureError(() => generateText({
      model: createLatchwayProvider({ client: mismatchedPath(client) }).responses("assistant"),
      prompt: "hello", maxRetries: 0,
    }));
    expect(serializedError(originError)).toContain("transport_destination_not_allowed");
    expect(serializedError(pathError)).toContain("transport_destination_not_allowed");
    expect(gateway.challengeCalls).toBe(0);
  });

  frameworkTest(framework, "FW-SEC-003", async () => {
    const gateway = new FrameworkGatewayFixture(() => latchwayProblem("quota_exceeded"));
    const error = await captureError(() => generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "hello", maxRetries: 0,
    }));
    expectRedacted(error);
  });

  frameworkTest(framework, "FW-SEC-004", async () => {
    const globalFetch = vi.fn(async () => { throw new Error("global fetch must not run"); });
    vi.stubGlobal("fetch", globalFetch);
    const gateway = new FrameworkGatewayFixture();
    await generateText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "hello", maxRetries: 0,
    });
    expect(globalThis.fetch).toBe(globalFetch);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  frameworkTest(framework, "FW-VAI-001", async () => {
    const gateway = new FrameworkGatewayFixture();
    const phases: string[] = [];
    const model = wrapLanguageModel({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      middleware: {
        specificationVersion: "v4",
        async transformParams({ params, type }) {
          phases.push(`transform-${type}`);
          return {
            ...params,
            headers: { ...params.headers, "X-Conformance-Middleware": type },
          };
        },
        async wrapGenerate({ doGenerate }) {
          phases.push("wrap-generate");
          return doGenerate();
        },
        async wrapStream({ doStream }) {
          phases.push("wrap-stream");
          return doStream();
        },
      },
    });
    await generateText({ model, prompt: "hello", maxRetries: 0 });
    const streamed = streamText({ model, prompt: "hello", maxRetries: 0 });
    await expect(streamed.text).resolves.toBe("hello from Latchway");
    expect(phases).toEqual([
      "transform-generate",
      "wrap-generate",
      "transform-stream",
      "wrap-stream",
    ]);
    expect(requiredRequest(gateway, 0).headers.get("X-Conformance-Middleware")).toBe("generate");
    expect(requiredRequest(gateway, 1).headers.get("X-Conformance-Middleware")).toBe("stream");
    expectFreshProofs(gateway, 2);
  });

  frameworkTest(framework, "FW-VAI-002", async () => {
    let releaseSecondChunk: (() => void) | undefined;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const gateway = new FrameworkGatewayFixture(() => streamingChatResponse(secondChunkGate));
    const callbackChunks: string[] = [];
    let finishedText: string | undefined;
    const result = streamText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).chat("assistant"),
      prompt: "hello",
      maxRetries: 0,
      onChunk({ chunk }) {
        if (chunk.type === "text-delta") callbackChunks.push(chunk.text);
      },
      onFinish(event) {
        finishedText = event.text;
      },
    });
    const iterator = result.fullStream[Symbol.asyncIterator]();
    let firstChunk;
    try {
      firstChunk = await beforeDeadline(nextTextDelta(iterator));
    } finally {
      releaseSecondChunk?.();
    }
    expect(firstChunk.text).toBe("hello ");
    expect(callbackChunks).toEqual(["hello "]);
    await drain(iterator);
    await expect(result.text).resolves.toBe("hello from Latchway");
    expect(callbackChunks).toEqual(["hello ", "from Latchway"]);
    expect(finishedText).toBe("hello from Latchway");
  });

  frameworkTest(framework, "FW-VAI-003", async () => {
    const gateway = new FrameworkGatewayFixture((request) =>
      streamingChatResponse(rejectWhenAborted(request.signal)));
    const controller = new AbortController();
    let abortCalls = 0;
    const result = streamText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).chat("assistant"),
      prompt: "hello",
      abortSignal: controller.signal,
      maxRetries: 0,
      onAbort() {
        abortCalls += 1;
      },
    });
    const iterator = result.fullStream[Symbol.asyncIterator]();
    const firstChunk = await beforeDeadline(nextTextDelta(iterator));
    expect(firstChunk.text).toBe("hello ");
    controller.abort(new DOMException("stream cancelled", "AbortError"));
    const terminalParts = await collect(iterator);
    expect(requiredRequest(gateway).signal.aborted).toBe(true);
    expect(terminalParts.some((part) => part.type === "abort" || part.type === "error")).toBe(true);
    expect(abortCalls).toBe(1);
  });

  frameworkTest(framework, "FW-VAI-004", async () => {
    const gateway = new FrameworkGatewayFixture();
    const lifecycle: string[] = [];
    const privacyFlags: Array<Readonly<Record<string, unknown>>> = [];
    const observe = (phase: string, event: object): void => {
      lifecycle.push(phase);
      privacyFlags.push(asRecord(event));
    };
    const integration: Telemetry = {
      onStart: (event) => {
        observe("start", event);
      },
      onLanguageModelCallStart: (event) => {
        observe("model-start", event);
      },
      onLanguageModelCallEnd: (event) => {
        observe("model-end", event);
      },
      onEnd: (event) => {
        observe("end", event);
      },
    };
    const result = streamText({
      model: createLatchwayProvider({ client: createFrameworkClient(gateway) }).responses("assistant"),
      prompt: "telemetry-private-prompt",
      maxRetries: 0,
      telemetry: {
        isEnabled: true,
        recordInputs: false,
        recordOutputs: false,
        functionId: "latchway-framework-conformance",
        integrations: [integration],
      },
    });
    await expect(result.text).resolves.toBe("hello from Latchway");
    expect(lifecycle).toEqual(["start", "model-start", "model-end", "end"]);
    for (const event of privacyFlags) {
      expect(event).toMatchObject({
        functionId: "latchway-framework-conformance",
        recordInputs: false,
        recordOutputs: false,
      });
    }
    expectBinding(gateway, "assistant", framework, VERCEL_AI_SDK_VERSION);
  });

  afterAll(() => {
    assertFrameworkCaseCoverage(framework, requiredRegistration(framework));
  });
});

describe("LangChain JavaScript conformance", () => {
  const framework = "langchain-js";

  frameworkTest(framework, "FW-AUTH-001", async () => {
    const gateway = new FrameworkGatewayFixture();
    await createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    }).invoke("hello");
    expectBinding(gateway, "assistant", framework, LANGCHAIN_OPENAI_VERSION);
  });

  frameworkTest(framework, "FW-REQ-002", async () => {
    const gateway = new FrameworkGatewayFixture();
    const message = await createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    }).invoke("hello");
    expect(message.content).toBe("hello from Latchway");
    expect(requiredRequest(gateway).url.pathname).toBe("/v1/chat/completions");
  });

  frameworkTest(framework, "FW-REQ-003", async () => {
    const gateway = new FrameworkGatewayFixture();
    const vector = await createLatchwayEmbeddings({
      latchway: createFrameworkClient(gateway), feature: "semantic_search",
    }).embedQuery("hello");
    expect(vector).toEqual([0.25, 0.75]);
    expect(requiredRequest(gateway).url.pathname).toBe("/v1/embeddings");
  });

  frameworkTest(framework, "FW-REQ-004", async () => {
    const gateway = new FrameworkGatewayFixture();
    await createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    }).invoke("hello", { options: { headers: { "X-Conformance-Trace": "safe-trace" } } });
    expect(requiredRequest(gateway).headers.get("X-Conformance-Trace")).toBe("safe-trace");
  });

  frameworkTest(framework, "FW-REQ-005", async () => {
    const gateway = new FrameworkGatewayFixture();
    const stream = await createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    }).stream("hello");
    let text = "";
    let totalTokens: number | undefined;
    for await (const chunk of stream) {
      if (typeof chunk.content === "string") text += chunk.content;
      const observedTotal = asRecord(chunk.usage_metadata).total_tokens;
      totalTokens = typeof observedTotal === "number" ? observedTotal : totalTokens;
    }
    expect(text).toBe("hello from Latchway");
    expect(totalTokens).toBe(3);
  });

  frameworkTest(framework, "FW-REQ-006", async () => {
    const gateway = new FrameworkGatewayFixture(pendingUntilAborted);
    const controller = new AbortController();
    const pending = createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant", chatOptions: { maxRetries: 0 },
    }).invoke("hello", { signal: controller.signal });
    await gateway.waitForDataRequests(1);
    controller.abort(new DOMException("conformance cancellation", "AbortError"));
    await expect(pending).rejects.toBeDefined();
    expect(requiredRequest(gateway).signal.aborted).toBe(true);
  });

  frameworkTest(framework, "FW-REQ-007", async () => {
    const gateway = new FrameworkGatewayFixture(pendingUntilAborted);
    const errorPromise = captureError(() => createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway),
      feature: "assistant",
      chatOptions: { maxRetries: 0, timeout: 25 },
    }).invoke("hello"));
    await gateway.waitForDataRequests(1);
    const error = await errorPromise;
    expect(requiredRequest(gateway).signal.aborted).toBe(true);
    expect(serializedError(error)).toMatch(/timed? ?out|timeout/iu);
  });

  frameworkTest(framework, "FW-BEH-001", async () => {
    const gateway = new FrameworkGatewayFixture();
    const chat = createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    });
    await chat.bindTools([{
      type: "function",
      function: {
        name: "lookup_habit",
        description: "Looks up a habit.",
        parameters: objectSchema("habit"),
      },
    }]).invoke("hello");
    expect(findTool(requiredRequest(gateway).body, "lookup_habit")).toBeDefined();
  });

  frameworkTest(framework, "FW-BEH-002", async () => {
    const gateway = new FrameworkGatewayFixture();
    const structured = createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    }).withStructuredOutput<{ summary: string }>(objectSchema("summary"), {
      name: "summary",
      method: "jsonSchema",
    });
    await expect(structured.invoke("hello")).resolves.toEqual({ summary: "hello from Latchway" });
    expect(nestedValue(requiredRequest(gateway).body, "response_format", "type")).toBe("json_schema");
  });

  frameworkTest(framework, "FW-BEH-003", async () => {
    const gateway = new FrameworkGatewayFixture(() => latchwayProblem("quota_exceeded"));
    const error = await captureError(() => createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant", chatOptions: { maxRetries: 0 },
    }).invoke("hello"));
    expectFrameworkError(error, 429, "quota_exceeded");
  });

  frameworkTest(framework, "FW-BEH-004", async () => {
    const gateway = new FrameworkGatewayFixture(providerError);
    const error = await captureError(() => createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant", chatOptions: { maxRetries: 0 },
    }).invoke("hello"));
    expectFrameworkError(error, 502, "upstream_unavailable");
  });

  frameworkTest(framework, "FW-BEH-005", async () => {
    const gateway = retryingProviderGateway();
    const message = await createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant", chatOptions: { maxRetries: 1 },
    }).invoke("hello");
    expect(message.content).toBe("hello from Latchway");
    expectFreshProofs(gateway, 2);
  });

  frameworkTest(framework, "FW-BEH-006", async () => {
    const gateway = refreshingGateway();
    const message = await createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant", chatOptions: { maxRetries: 0 },
    }).invoke("hello");
    expect(message.content).toBe("hello from Latchway");
    expect(gateway.refreshCalls).toBe(1);
    expectFreshProofs(gateway, 2);
  });

  frameworkTest(framework, "FW-SEC-001", async () => {
    const gateway = new FrameworkGatewayFixture();
    await createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    }).invoke("hello", {
      options: { headers: { Authorization: "Bearer caller-override", "X-API-Key": "provider-secret" } },
    });
    expectPlaceholderStripped(gateway);
  });

  frameworkTest(framework, "FW-SEC-002", async () => {
    const gateway = new FrameworkGatewayFixture();
    const client = createFrameworkClient(gateway);
    const originError = await captureError(() => createLatchwayChatOpenAI({
      latchway: mismatchedOrigin(client),
      feature: "assistant",
      chatOptions: { maxRetries: 0 },
    }).invoke("hello"));
    const pathError = await captureError(() => createLatchwayChatOpenAI({
      latchway: mismatchedPath(client),
      feature: "assistant",
      chatOptions: { maxRetries: 0 },
    }).invoke("hello"));
    expect(serializedError(originError)).toContain("transport_destination_not_allowed");
    expect(serializedError(pathError)).toContain("transport_destination_not_allowed");
    expect(gateway.challengeCalls).toBe(0);
  });

  frameworkTest(framework, "FW-SEC-003", async () => {
    const gateway = new FrameworkGatewayFixture(() => latchwayProblem("quota_exceeded"));
    const error = await captureError(() => createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant", chatOptions: { maxRetries: 0 },
    }).invoke("hello"));
    expectRedacted(error);
  });

  frameworkTest(framework, "FW-SEC-004", async () => {
    const globalFetch = vi.fn(async () => { throw new Error("global fetch must not run"); });
    vi.stubGlobal("fetch", globalFetch);
    const gateway = new FrameworkGatewayFixture();
    await createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway), feature: "assistant",
    }).invoke("hello");
    expect(globalThis.fetch).toBe(globalFetch);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  frameworkTest(framework, "FW-LC-001", async () => {
    let active = 0;
    let maximumActive = 0;
    const gateway = new FrameworkGatewayFixture(async (request) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await delay(15);
        const prompt = chatPrompt(request.body);
        return chatResponse(request.body, `result:${prompt}`);
      } finally {
        active -= 1;
      }
    });
    const chat = createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway),
      feature: "assistant",
      chatOptions: { maxRetries: 0 },
    });
    const results = await chat.batch(
      ["first", "second", "third", "fourth"],
      { maxConcurrency: 2 },
    );
    expect(results.map((result) => result.content)).toEqual([
      "result:first",
      "result:second",
      "result:third",
      "result:fourth",
    ]);
    expect(maximumActive).toBe(2);
    expectFreshProofs(gateway, 4);
  });

  frameworkTest(framework, "FW-LC-002", async () => {
    const gateway = new FrameworkGatewayFixture((request) => {
      const prompt = chatPrompt(request.body);
      return prompt === "quota" ? latchwayProblem("quota_exceeded")
        : chatResponse(request.body, `result:${prompt}`);
    });
    const results = await createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway),
      feature: "assistant",
      chatOptions: { maxRetries: 0 },
    }).batch(
      ["first", "quota", "last"],
      { maxConcurrency: 2 },
      { returnExceptions: true },
    );
    expect(asRecord(results[0]).content).toBe("result:first");
    expectFrameworkError(results[1], 429, "quota_exceeded");
    expect(asRecord(results[2]).content).toBe("result:last");
    expect(gateway.dataRequests).toHaveLength(3);
  });

  frameworkTest(framework, "FW-LC-003", async () => {
    const gateway = new FrameworkGatewayFixture(pendingUntilAborted);
    const controller = new AbortController();
    const errorPromise = captureError(() => createLatchwayChatOpenAI({
      latchway: createFrameworkClient(gateway),
      feature: "assistant",
      chatOptions: { maxRetries: 0 },
    }).batch(
      ["first", "second", "third", "fourth"],
      { maxConcurrency: 2, signal: controller.signal },
    ));
    await gateway.waitForDataRequests(2);
    controller.abort(new DOMException("batch cancelled", "AbortError"));
    const error = await errorPromise;
    expect(serializedError(error)).toMatch(/abort|cancel/iu);
    expect(gateway.dataRequests).toHaveLength(2);
    expect(gateway.dataRequests.every(({ signal }) => signal.aborted)).toBe(true);
  });

  afterAll(() => {
    assertFrameworkCaseCoverage(framework, requiredRegistration(framework));
  });
});

function frameworkTest(
  framework: JavaScriptFrameworkID,
  id: FrameworkCaseID,
  run: () => void | Promise<void>,
): void {
  const cases = registered.get(framework) ?? new Set<FrameworkCaseID>();
  if (cases.has(id)) throw new Error(`${framework} registered ${id} more than once.`);
  cases.add(id);
  registered.set(framework, cases);
  it(frameworkCaseTitle(id), run);
}

function requiredRegistration(framework: JavaScriptFrameworkID): ReadonlySet<FrameworkCaseID> {
  const cases = registered.get(framework);
  if (cases === undefined) throw new Error(`${framework} did not register conformance cases.`);
  return cases;
}

function expectBinding(
  gateway: FrameworkGatewayFixture,
  feature: string,
  framework: JavaScriptFrameworkID,
  version: string,
): void {
  const headers = requiredRequest(gateway).headers;
  expect(headers.get("X-Latchway-Feature")).toBe(feature);
  expect(headers.get("X-Latchway-Framework")).toBe(framework);
  expect(headers.get("X-Latchway-Framework-Version")).toBe(version);
  expect(headers.get("X-Latchway-Protocol-Version")).toBe("2");
}

function requiredRequest(gateway: FrameworkGatewayFixture, index = 0) {
  const request = gateway.dataRequests[index];
  if (request === undefined) throw new Error(`Missing framework request at index ${index}.`);
  return request;
}

function expectPlaceholderStripped(gateway: FrameworkGatewayFixture): void {
  const headers = requiredRequest(gateway).headers;
  expect(headers.get("Authorization")).toMatch(/^DPoP /u);
  expect(headers.get("Authorization")).not.toContain("latchway-managed-not-a-provider-secret");
  expect(headers.get("X-API-Key")).toBeNull();
  expect(headers.get("DPoP")).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
}

function expectFreshProofs(gateway: FrameworkGatewayFixture, count: number): void {
  expect(gateway.dataRequests).toHaveLength(count);
  const proofs = gateway.dataRequests.map(({ headers }) => headers.get("DPoP"));
  expect(proofs.every((proof) => proof !== null)).toBe(true);
  expect(new Set(proofs).size).toBe(count);
}

function expectFrameworkError(error: unknown, status: number, code: string): void {
  const record = asRecord(error);
  expect(record.status ?? record.statusCode).toBe(status);
  const serialized = serializedError(error);
  expect(serialized).toContain(code);
  expect(serialized).toContain("req_framework_case_123");
}

function expectRedacted(error: unknown): void {
  const serialized = serializedError(error);
  for (const fragment of secretFragments) expect(serialized).not.toContain(fragment);
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("The conformance operation unexpectedly succeeded.");
}

function retryingProviderGateway(): FrameworkGatewayFixture {
  return new FrameworkGatewayFixture((request, dispatch) =>
    dispatch === 1 ? providerError() : defaultFrameworkReply(request));
}

function refreshingGateway(): FrameworkGatewayFixture {
  return new FrameworkGatewayFixture((request, dispatch) =>
    dispatch === 1 ? latchwayProblem("session_expired") : defaultFrameworkReply(request));
}

function mismatchedOrigin(client: AuthenticatedTransport): AuthenticatedTransport {
  return {
    gatewayURL: "http://untrusted.example.test",
    fetchFor(feature: string, framework?: FrameworkMetadata) {
      return client.fetchFor(feature, framework);
    },
  };
}

function mismatchedPath(client: AuthenticatedTransport): AuthenticatedTransport {
  return {
    gatewayURL: "http://gateway.example.test/undeclared",
    fetchFor(feature: string, framework?: FrameworkMetadata) {
      return client.fetchFor(feature, framework);
    },
  };
}

function objectSchema(property: string) {
  return {
    type: "object" as const,
    properties: { [property]: { type: "string" as const } },
    required: [property],
    additionalProperties: false,
  };
}

function findTool(body: Readonly<Record<string, unknown>>, name: string): Readonly<Record<string, unknown>> | undefined {
  if (!Array.isArray(body.tools)) return undefined;
  return body.tools.map(asRecord).find((candidate) =>
    candidate.name === name || asRecord(candidate.function).name === name);
}

function nestedValue(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) current = asRecord(current)[key];
  return current;
}

async function beforeDeadline<T>(promise: Promise<T>, timeoutMilliseconds = 1_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("Framework stream did not produce incrementally."));
    }, timeoutMilliseconds);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function nextTextDelta(
  iterator: AsyncIterator<Readonly<{ type: string; text?: string }>>,
): Promise<Readonly<{ type: "text-delta"; text: string }>> {
  for (;;) {
    const part = await iterator.next();
    if (part.done === true) throw new Error("Framework stream ended before a text delta.");
    if (part.value.type === "text-delta" && typeof part.value.text === "string") {
      return { type: "text-delta", text: part.value.text };
    }
  }
}

async function drain<T>(iterator: AsyncIterator<T>): Promise<void> {
  for (;;) {
    if ((await iterator.next()).done === true) return;
  }
}

async function collect<T>(iterator: AsyncIterator<T>): Promise<T[]> {
  const values: T[] = [];
  for (;;) {
    const part = await iterator.next();
    if (part.done === true) return values;
    values.push(part.value);
  }
}

function rejectWhenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => {
      reject(signal.reason);
    }, { once: true });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function chatPrompt(body: Readonly<Record<string, unknown>>): string {
  if (!Array.isArray(body.messages)) throw new Error("Chat request omitted messages.");
  const content = asRecord(body.messages.at(-1)).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.map(asRecord).find((part) => part.type === "text")?.text;
    if (typeof text === "string") return text;
  }
  throw new Error("Chat request omitted a text prompt.");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
