import { describe, expect, it } from "vitest";

import { errorFromResponse, LatchwayError } from "../src/errors.js";

describe("stable error mapping", () => {
  it("maps safe RFC 9457 fields", async () => {
    const response = new Response(JSON.stringify({
      type: "https://example.test/problems/quota-exceeded",
      title: "Quota exceeded",
      status: 429,
      detail: "The request limit is exhausted.",
      code: "quota_exceeded",
      request_id: "req_12345678",
      retryable: true,
      retry_after: "2026-08-28T00:00:00Z",
      feature: "assistant",
    }), {
      status: 429,
      headers: { "Content-Type": "application/problem+json" },
    });
    const error = await errorFromResponse(response);
    expect(error).toBeInstanceOf(LatchwayError);
    expect(error).toMatchObject({
      code: "quota_exceeded",
      status: 429,
      requestID: "req_12345678",
      retryable: true,
      feature: "assistant",
    });
  });

  it("rejects unknown codes and oversized problem bodies", async () => {
    const unknown = await errorFromResponse(new Response(JSON.stringify({ code: "invented" }), { status: 400 }));
    expect(unknown.code).toBe("protocol_response_invalid");
    const oversized = await errorFromResponse(new Response("x".repeat(65_537), { status: 500 }));
    expect(oversized.code).toBe("protocol_response_invalid");
    expect(oversized.message).not.toContain("x".repeat(64));
  });
});
