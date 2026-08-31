import { describe, expect, it } from "vitest";

import {
  errorFromResponse,
  latchwayErrorDocumentationURL,
  LatchwayError,
} from "../src/errors.js";

describe("stable error mapping", () => {
  it("maps safe RFC 9457 fields", async () => {
    const response = new Response(JSON.stringify({
      type: "https://latchway.dev/problems/quota_exceeded",
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
      headers: {
        "Content-Type": "application/problem+json",
        "X-Latchway-Request-ID": "req_12345678",
      },
    });
    const error = await errorFromResponse(response);
    expect(error).toBeInstanceOf(LatchwayError);
    expect(error).toMatchObject({
      code: "quota_exceeded",
      documentationURL: "https://docs.latchway.dev/errors/quota_exceeded",
      status: 429,
      requestID: "req_12345678",
      retryable: true,
      feature: "assistant",
    });
  });

  it("provides a stable documentation URL for server and client error codes", async () => {
    const clientError = new LatchwayError("network_error", "The request failed.");
    expect(clientError.documentationURL).toBe("https://docs.latchway.dev/errors/network_error");
    expect(Object.keys(clientError)).not.toContain("documentationURL");
    expect(() => {
      Object.assign(clientError, { documentationURL: "https://malicious.invalid" });
    }).toThrow(TypeError);
    expect(latchwayErrorDocumentationURL("component_revoked"))
      .toBe("https://docs.latchway.dev/errors/component_revoked");

    const malformed = await errorFromResponse(new Response("not-json", {
      status: 502,
      headers: { "X-Latchway-Request-ID": "req_12345678" },
    }));
    expect(malformed).toMatchObject({
      code: "protocol_response_invalid",
      documentationURL: "https://docs.latchway.dev/errors/protocol_response_invalid",
      requestID: "req_12345678",
    });
  });

  it("rejects unknown codes and oversized problem bodies", async () => {
    const unknown = await errorFromResponse(new Response(JSON.stringify({ code: "invented" }), { status: 400 }));
    expect(unknown.code).toBe("protocol_response_invalid");
    const oversized = await errorFromResponse(new Response("x".repeat(65_537), { status: 500 }));
    expect(oversized.code).toBe("protocol_response_invalid");
    expect(oversized.message).not.toContain("x".repeat(64));
  });

  it("rejects duplicate problem fields, including Unicode-escaped aliases", async () => {
    for (const body of [
      "{\"type\":\"https://latchway.dev/problems/quota_exceeded\",\"title\":\"Quota exceeded\",\"status\":429,\"detail\":\"first\",\"detail\":\"second\",\"code\":\"quota_exceeded\",\"request_id\":\"req_12345678\",\"retryable\":true}",
      "{\"type\":\"https://latchway.dev/problems/quota_exceeded\",\"title\":\"Quota exceeded\",\"status\":429,\"detail\":\"first\",\"\\u0064etail\":\"second\",\"code\":\"quota_exceeded\",\"request_id\":\"req_12345678\",\"retryable\":true}",
    ]) {
      const error = await errorFromResponse(new Response(body, {
        status: 429,
        headers: problemHeaders(),
      }));
      expect(error.code).toBe("protocol_response_invalid");
    }
  });

  it("requires exact canonical problem metadata and header correlation", async () => {
    const valid = {
      type: "https://latchway.dev/problems/internal_error",
      title: "Internal server error",
      status: 500,
      detail: "A safe internal error occurred.",
      code: "internal_error",
      request_id: "req_12345678",
      retryable: false,
    };
    const withoutDetail = {
      type: valid.type,
      title: valid.title,
      status: valid.status,
      code: valid.code,
      request_id: valid.request_id,
      retryable: valid.retryable,
    };
    const cases = [
      { body: { ...valid, type: "https://gateway.example/problems/internal_error" } },
      { body: { ...valid, title: "Almost right" } },
      { body: { ...valid, status: 503 } },
      { body: { ...valid, retryable: true } },
      { body: { ...valid, unexpected: "field" } },
      { body: withoutDetail },
      { body: { ...valid, detail: "" } },
      { body: { ...valid, request_id: "req_different" } },
      { body: valid, headers: { ...problemHeaders(), "X-Latchway-Request-ID": "req_different" } },
      { body: valid, headers: { ...problemHeaders(), "Content-Type": "application/json" } },
    ];
    for (const candidate of cases) {
      const error = await errorFromResponse(new Response(JSON.stringify(candidate.body), {
        status: 500,
        headers: candidate.headers ?? problemHeaders(),
      }));
      expect(error.code).toBe("protocol_response_invalid");
      expect(error.message).not.toContain("safe internal");
    }
  });

  it("preserves the reconciliation ID for indeterminate operations", async () => {
    const operationID = "arq_0123456789ABCDEFGHJKMNPQRS";
    const error = await errorFromResponse(new Response(JSON.stringify({
      title: "Operation outcome indeterminate",
      status: 503,
      type: "https://latchway.dev/problems/operation_indeterminate",
      detail: "The operation must be reconciled before retrying.",
      code: "operation_indeterminate",
      request_id: "req_12345678",
      retryable: true,
      operation_id: operationID,
    }), {
      status: 503,
      headers: {
        "Content-Type": "application/problem+json",
        "X-Latchway-Request-ID": "req_12345678",
      },
    }));

    expect(error).toMatchObject({
      code: "operation_indeterminate",
      status: 503,
      requestID: "req_12345678",
      retryable: true,
      operationID,
    });
  });

  it("rejects missing, malformed, or forbidden operation IDs", async () => {
    const indeterminate = {
      type: "https://latchway.dev/problems/operation_indeterminate",
      title: "Operation outcome indeterminate",
      status: 503,
      detail: "Reconcile the operation before retrying.",
      code: "operation_indeterminate",
      request_id: "req_12345678",
      retryable: true,
    };
    for (const problem of [indeterminate, { ...indeterminate, operation_id: "arq_invalid" }]) {
      const error = await errorFromResponse(new Response(JSON.stringify(problem), {
        status: 503,
        headers: problemHeaders(),
      }));
      expect(error.code).toBe("protocol_response_invalid");
      expect(error.operationID).toBeUndefined();
    }

    const error = await errorFromResponse(new Response(JSON.stringify({
      type: "https://latchway.dev/problems/internal_error",
      title: "Internal server error",
      status: 500,
      detail: "A safe internal error occurred.",
      code: "internal_error",
      request_id: "req_12345678",
      retryable: false,
      operation_id: "arq_0123456789ABCDEFGHJKMNPQRS",
    }), { status: 500, headers: problemHeaders() }));
    expect(error.code).toBe("protocol_response_invalid");
    expect(error.operationID).toBeUndefined();
  });
});

function problemHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/problem+json",
    "X-Latchway-Request-ID": "req_12345678",
  };
}
