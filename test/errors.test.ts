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

  it("preserves the reconciliation ID for indeterminate operations", async () => {
    const operationID = "arq_0123456789ABCDEFGHJKMNPQRS";
    const error = await errorFromResponse(new Response(JSON.stringify({
      title: "Operation outcome indeterminate",
      status: 503,
      code: "operation_indeterminate",
      request_id: "req_12345678",
      retryable: true,
      operation_id: operationID,
    }), { status: 503, headers: { "Content-Type": "application/problem+json" } }));

    expect(error).toMatchObject({
      code: "operation_indeterminate",
      status: 503,
      requestID: "req_12345678",
      retryable: true,
      operationID,
    });
  });

  it("rejects missing, malformed, or forbidden operation IDs", async () => {
    for (const problem of [
      { code: "operation_indeterminate" },
      { code: "operation_indeterminate", operation_id: "arq_invalid" },
      { code: "internal_error", operation_id: "arq_0123456789ABCDEFGHJKMNPQRS" },
    ]) {
      const error = await errorFromResponse(new Response(JSON.stringify(problem), { status: 503 }));
      expect(error.code).toBe("protocol_response_invalid");
      expect(error.operationID).toBeUndefined();
    }
  });
});
