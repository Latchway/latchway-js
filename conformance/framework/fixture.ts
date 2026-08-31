import { createLatchwayClient, createCustomAttestationProvider } from "../../src/index.js";
import { base64urlDecode, decodeUTF8 } from "../../src/encoding.js";
import { jwkThumbprint, type P256PublicJWK } from "../../src/dpop/key.js";
import type { LatchwayClient, Platform } from "../../src/types.js";

export interface CapturedFrameworkRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export type FrameworkReply = (
  request: CapturedFrameworkRequest,
  dispatch: number,
) => Response | Promise<Response>;

const identityToken = "identity-token-conformance-only-0123456789";

/** A protocol-valid in-memory gateway used only by black-box framework tests. */
export class FrameworkGatewayFixture {
  readonly dataRequests: CapturedFrameworkRequest[] = [];
  challengeCalls = 0;
  exchangeCalls = 0;
  refreshCalls = 0;
  private jkt = "";
  private grantGeneration = 0;
  private readonly waiters: Array<{
    count: number;
    resolve: () => void;
  }> = [];

  constructor(private readonly reply: FrameworkReply = defaultFrameworkReply) {}

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/client/v1/session-challenges") return this.challenge(request);
    if (url.pathname === "/client/v1/sessions") {
      this.exchangeCalls += 1;
      return this.grant(201);
    }
    if (url.pathname === "/client/v1/sessions/refresh") {
      this.refreshCalls += 1;
      return this.grant(200);
    }

    const body = await readJSONRecord(request.clone());
    const captured: CapturedFrameworkRequest = {
      url,
      method: request.method,
      headers: new Headers(request.headers),
      body,
      signal: request.signal,
    };
    this.dataRequests.push(captured);
    this.resolveWaiters();
    return this.reply(captured, this.dataRequests.length);
  };

  waitForDataRequests(count: number): Promise<void> {
    if (this.dataRequests.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  private async challenge(request: Request): Promise<Response> {
    this.challengeCalls += 1;
    const proof = request.headers.get("DPoP");
    if (proof === null || request.headers.has("Authorization")) {
      throw new Error("The SDK sent an invalid session-challenge request.");
    }
    const header = decodeHeader(proof);
    this.jkt = await jwkThumbprint(globalThis.crypto, header.jwk);
    return jsonResponse({
      challenge_id: `chl_${"a".repeat(20)}`,
      challenge_nonce: "b".repeat(43),
      binding_version: 1,
      issued_at: Math.floor(Date.now() / 1_000),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      attestation: {
        provider: "debug",
        mode: "required",
        client_data_hash: "c".repeat(43),
      },
    }, { status: 201 });
  }

  private grant(status: number): Response {
    this.grantGeneration += 1;
    return jsonResponse({
      access_token: `access-${this.grantGeneration}-${"a".repeat(70)}`,
      token_type: "DPoP",
      expires_in: 60,
      refresh_token: `refresh-${this.grantGeneration}-${"r".repeat(40)}`,
      refresh_expires_in: 3_600,
      installation: {
        id: `ins_${"i".repeat(20)}`,
        platform: "web" satisfies Platform,
        dpop_jkt: this.jkt,
        status: "active",
      },
      trust: {
        provider: "debug",
        level: "debug",
        verified_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      },
    }, { status });
  }

  private resolveWaiters(): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (waiter !== undefined && this.dataRequests.length >= waiter.count) {
        this.waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}

export function createFrameworkClient(gateway: FrameworkGatewayFixture): LatchwayClient {
  return createLatchwayClient({
    baseURL: "http://gateway.example.test",
    applicationID: "app_01J00000000000000000000000",
    environment: "test",
    identityProvider: "custom_jwt",
    identityTokenProvider: { getIdentityToken: async () => identityToken },
    attestationProviders: [createCustomAttestationProvider({
      provider: "debug",
      getEvidence: async (context) => ({
        challenge_token: `test-only-${context.challenge.challenge_id}`,
        client_data_hash: context.challenge.attestation.client_data_hash,
      }),
    })],
    installation: { appVersion: "1.0.0-conformance" },
    persistence: { mode: "memory" },
    allowInsecureHTTP: true,
    fetch: gateway.fetch,
  });
}

export function defaultFrameworkReply(request: CapturedFrameworkRequest): Response {
  if (request.url.pathname === "/v1/embeddings") return embeddingResponse();
  if (request.body.stream === true) {
    return request.url.pathname === "/v1/responses" ? streamingResponsesResponse() : streamingChatResponse();
  }
  if (request.url.pathname === "/v1/responses") return responsesResponse(request.body);
  return chatResponse(request.body);
}

export function responsesResponse(body: Readonly<Record<string, unknown>> = {}): Response {
  const outputText = hasStructuredOutput(body) ? JSON.stringify({ summary: "hello from Latchway" })
    : "hello from Latchway";
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
      content: [{ type: "output_text", text: outputText, annotations: [], logprobs: [] }],
    }],
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 3,
    },
  });
}

export function chatResponse(body: Readonly<Record<string, unknown>> = {}): Response {
  const content = hasStructuredOutput(body) ? JSON.stringify({ summary: "hello from Latchway" })
    : "hello from Latchway";
  return jsonResponse({
    id: "chatcmpl_latchway",
    object: "chat.completion",
    created: 1,
    model: "latchway",
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
      logprobs: null,
    }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
}

export function embeddingResponse(): Response {
  return jsonResponse({
    object: "list",
    data: [{ object: "embedding", embedding: [0.25, 0.75], index: 0 }],
    model: "latchway",
    usage: { prompt_tokens: 1, total_tokens: 1 },
  });
}

export function streamingChatResponse(): Response {
  const encoder = new TextEncoder();
  const events = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "hello " }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "from Latchway" }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
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

export function streamingResponsesResponse(): Response {
  const events = [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp_latchway", created_at: 1, model: "latchway" },
    },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { type: "message", id: "msg_latchway", phase: "final_answer" },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 2,
      item_id: "msg_latchway",
      output_index: 0,
      content_index: 0,
      delta: "hello ",
      logprobs: [],
    },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      item_id: "msg_latchway",
      output_index: 0,
      content_index: 0,
      delta: "from Latchway",
      logprobs: [],
    },
    {
      type: "response.output_item.done",
      sequence_number: 4,
      output_index: 0,
      item: { type: "message", id: "msg_latchway", phase: "final_answer" },
    },
    {
      type: "response.completed",
      sequence_number: 5,
      response: {
        id: "resp_latchway",
        object: "response",
        created_at: 1,
        status: "completed",
        error: null,
        incomplete_details: null,
        model: "latchway",
        output: [],
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 3,
        },
      },
    },
  ];
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

export function latchwayProblem(
  code: "quota_exceeded" | "session_expired" | "upstream_unavailable",
): Response {
  const policy = {
    quota_exceeded: { status: 429, title: "Quota exceeded", retryable: true },
    session_expired: { status: 401, title: "Session expired", retryable: true },
    upstream_unavailable: { status: 503, title: "Upstream unavailable", retryable: true },
  }[code];
  return jsonResponse({
    type: `https://latchway.dev/problems/${code}`,
    title: policy.title,
    status: policy.status,
    detail: `Conformance ${code.replaceAll("_", " ")}.`,
    code,
    request_id: "req_framework_case_123",
    retryable: policy.retryable,
  }, {
    status: policy.status,
    contentType: "application/problem+json",
    headers: { "Retry-After": "0" },
  });
}

export function providerError(): Response {
  return jsonResponse({
    error: {
      message: "The selected upstream is temporarily unavailable.",
      type: "upstream_error",
      code: "upstream_unavailable",
    },
  }, { status: 502 });
}

export function pendingUntilAborted(request: CapturedFrameworkRequest): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (request.signal.aborted) {
      reject(request.signal.reason);
      return;
    }
    request.signal.addEventListener("abort", () => {
      reject(request.signal.reason);
    }, { once: true });
  });
}

export function serializedError(error: unknown): string {
  const seen = new WeakSet<object>();
  return `${String(error)} ${JSON.stringify(error, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    return value;
  })}`;
}

function jsonResponse(
  body: unknown,
  options: {
    status?: number;
    contentType?: string;
    headers?: HeadersInit;
  } = {},
): Response {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", options.contentType ?? "application/json");
  headers.set("X-Latchway-Request-ID", "req_framework_case_123");
  return new Response(JSON.stringify(body), { status: options.status ?? 200, headers });
}

async function readJSONRecord(request: Request): Promise<Readonly<Record<string, unknown>>> {
  if (request.body === null) return {};
  const body = await request.json() as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("A framework request did not contain a JSON object.");
  }
  return body as Readonly<Record<string, unknown>>;
}

function decodeHeader(proof: string): { jwk: P256PublicJWK } {
  const encoded = proof.split(".")[0];
  if (encoded === undefined) throw new Error("The DPoP proof omitted its header.");
  return JSON.parse(decodeUTF8(base64urlDecode(encoded))) as { jwk: P256PublicJWK };
}

function hasStructuredOutput(body: Readonly<Record<string, unknown>>): boolean {
  return Object.hasOwn(body, "response_format") || Object.hasOwn(body, "text");
}
