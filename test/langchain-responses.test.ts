import { AIMessage, type AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  bindLatchwayTools, createLatchwayChatOpenAI, createLatchwayResponsesModel,
  toLatchwayReplayMessage,
} from "../packages/langchain/src/index.js";
import {
  createFrameworkClient, FrameworkGatewayFixture, pendingUntilAborted, providerError,
} from "../conformance/framework/fixture.js";

const weatherTool = { type: "function" as const, function: {
  name: "weather_check", description: "Weather for a city", parameters: {
    type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false,
  },
} };

function setup(reply?: ConstructorParameters<typeof FrameworkGatewayFixture>[0]) {
  const gateway = new FrameworkGatewayFixture(reply);
  const options = { latchway: createFrameworkClient(gateway), feature: "assistant" };
  return { gateway, options };
}

describe("LangChain 1.1 stateless Responses helpers", () => {
  it("uses the gateway Responses route without guessing reasoning capability", async () => {
    const { gateway, options } = setup();
    const answer = await createLatchwayResponsesModel(options).invoke("hello");
    expect(toLatchwayReplayMessage(answer).content).toBe("hello from Latchway");
    expect(gateway.dataRequests[0]?.url.pathname).toBe("/v1/responses");
    const body = gateway.dataRequests[0]?.body;
    expect(body).toMatchObject({ store: false, model: "latchway" });
    for (const key of ["reasoning", "include", "previous_response_id", "conversation"]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("keeps explicit reasoning, strict tools and correlated multi-turn local history", async () => {
    const { gateway, options } = setup();
    const model = bindLatchwayTools(createLatchwayResponsesModel({ ...options,
      reasoning: { effort: "none" }, chatOptions: { maxTokens: 1024 },
    }), [weatherTool]);
    const call = { id: "call_weather", type: "tool_call" as const, name: "weather_check", args: { city: "Singapore" } };
    const original = new AIMessage({ id: "msg_provider_stored", content: "", tool_calls: [call],
      response_metadata: { id: "resp_provider_stored" } });
    await model.invoke([new HumanMessage("Singapore?"), toLatchwayReplayMessage(original),
      new ToolMessage({ tool_call_id: call.id, content: "Fixture weather result" })]);
    const body = gateway.dataRequests[0]?.body;
    expect(body).toMatchObject({ reasoning: { effort: "none" }, max_output_tokens: 1024, parallel_tool_calls: false,
      tools: [expect.objectContaining({ name: "weather_check", strict: true })] });
    expect(body?.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: call.id }),
      expect.objectContaining({ type: "function_call_output", call_id: call.id }),
    ]));
    expect(JSON.stringify(body)).not.toContain("provider_stored");
    expect(original.id).toBe("msg_provider_stored");
  });

  it("streams text and retains the original usage metadata", async () => {
    const { options } = setup();
    let complete: AIMessageChunk | undefined;
    for await (const chunk of await createLatchwayResponsesModel(options).stream("hello")) {
      complete = complete ? complete.concat(chunk) : chunk;
    }
    if (!complete) throw new Error("Expected streamed response");
    expect(complete.usage_metadata).toMatchObject({ total_tokens: 3 });
    expect(toLatchwayReplayMessage(complete).content).toBe("hello from Latchway");
  });

  it("uses ordinary LangChain structured output on the stateless route", async () => {
    const { gateway, options } = setup();
    const model = createLatchwayResponsesModel(options).withStructuredOutput<{ summary: string }>({
      type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false,
    }, { method: "jsonSchema", name: "summary", strict: true });
    await expect(model.invoke("hello")).resolves.toEqual({ summary: "hello from Latchway" });
    expect(gateway.dataRequests[0]?.body.text).toMatchObject({ format: { type: "json_schema", strict: true } });
  });

  it("does not retry failed dispatches unless the caller explicitly opts in", async () => {
    const { gateway, options } = setup(providerError);
    await expect(createLatchwayResponsesModel(options).invoke("hello")).rejects.toBeDefined();
    expect(gateway.dataRequests).toHaveLength(1);
    await expect(createLatchwayChatOpenAI(options).invoke("hello")).rejects.toBeDefined();
    expect(gateway.dataRequests).toHaveLength(2);
  });

  it("propagates cancellation to the authenticated transport", async () => {
    const { gateway, options } = setup(pendingUntilAborted);
    const controller = new AbortController();
    const pending = createLatchwayResponsesModel(options).invoke("hello", { signal: controller.signal });
    const failure = expect(pending).rejects.toBeDefined();
    await gateway.waitForDataRequests(1);
    controller.abort();
    await failure;
    expect(gateway.dataRequests[0]?.signal.aborted).toBe(true);
    expect(gateway.dataRequests).toHaveLength(1);
  });

  it("rejects incompatible stored-state kwargs before dispatch", () => {
    const { gateway, options } = setup();
    for (const modelKwargs of [{ include: [] }, { previous_response_id: "resp_x" }, { conversation: "conv_x" },
      { store: true }, { reasoning: { effort: "none" } }]) {
      expect(() => createLatchwayResponsesModel({ ...options, chatOptions: { modelKwargs } })).toThrow(/stateless/);
    }
    expect(gateway.dataRequests).toHaveLength(0);
  });

  it("does not silently erase unsupported content or invalid tool calls", () => {
    for (const message of [
      new AIMessage({ content: [{ type: "reasoning", reasoning: "opaque" }] }),
      new AIMessage({ content: "", additional_kwargs: { reasoning: { encrypted_content: "opaque" } } }),
      new AIMessage({ content: "", additional_kwargs: { refusal: "Cannot comply" } }),
      new AIMessage({ content: "", invalid_tool_calls: [{ name: "broken", args: "{", error: "invalid" }] }),
      new AIMessage({ content: "", tool_calls: [{ name: "weather_check", args: {} }] }),
    ]) expect(() => toLatchwayReplayMessage(message)).toThrow();
  });

  it("rejects duplicate call IDs and canonicalizes supported text blocks", () => {
    const call = { id: "same", name: "weather_check", args: {} };
    expect(() => toLatchwayReplayMessage(new AIMessage({ content: "", tool_calls: [call, call] }))).toThrow(/unique/);
    expect(toLatchwayReplayMessage(new AIMessage({ content: [{ type: "text", text: "Hello " },
      { type: "text", text: "world" }], id: "msg_source" })).content).toBe("Hello world");
  });
});
