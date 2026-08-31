import { describe, expect, it, vi } from "vitest";

import {
  createLoopbackDevelopmentBrowserClient,
  safeBrowserDiagnostics,
  type LoopbackDevelopmentDependencies,
} from "../examples/vanilla/development-client.js";
import {
  createHabitAssistantFetch,
  streamHabitAssistant,
} from "../examples/vanilla/streaming-fetch.js";
import type { AuthenticatedTransport, LatchwayClient } from "../src/index.js";

describe("vanilla Web golden journey", () => {
  it("constructs only an explicit loopback development client", () => {
    const dependencies: LoopbackDevelopmentDependencies = {
      getIdentityToken: vi.fn(async () => "identity-token"),
      getDevelopmentEvidence: vi.fn(async () => ({ token: "signed-by-helper" })),
    };
    const client = createLoopbackDevelopmentBrowserClient({
      baseURL: "http://127.0.0.1:8080",
      applicationID: "app_01J00000000000000000000000",
      appVersion: "1.0.0",
    }, dependencies);
    expect(client.gatewayURL).toBe("http://127.0.0.1:8080");
    expect(dependencies.getIdentityToken).not.toHaveBeenCalled();
    expect(dependencies.getDevelopmentEvidence).not.toHaveBeenCalled();
    expect(() => createLoopbackDevelopmentBrowserClient({
      baseURL: "https://ai.example.com",
      applicationID: "app_01J00000000000000000000000",
      appVersion: "1.0.0",
    }, dependencies)).toThrow("loopback HTTP gateway");
  });

  it("binds the feature and preserves the stream, request ID, and AbortSignal", async () => {
    const signal = new AbortController().signal;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(signal);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first "));
          controller.enqueue(new TextEncoder().encode("second"));
          controller.close();
        },
      }), { headers: { "X-Latchway-Request-ID": "req_12345678" } });
    });
    const fetchFor = vi.fn(() => fetch);
    const transport: AuthenticatedTransport = {
      gatewayURL: "https://ai.example.com",
      fetchFor,
    };

    const result = await streamHabitAssistant(transport, "Suggest one habit.", signal);

    expect(fetchFor).toHaveBeenCalledWith("habit-assistant");
    expect(fetch).toHaveBeenCalledWith("/v1/responses", expect.objectContaining({
      method: "POST",
      signal,
    }));
    expect(result).toEqual({ output: "first second", requestID: "req_12345678" });
  });

  it("maps a final canonical Problem response without hiding its safe code", async () => {
    const transport: AuthenticatedTransport = {
      gatewayURL: "https://ai.example.com",
      fetchFor: () => async () => new Response(JSON.stringify({
        type: "https://latchway.dev/problems/quota_exceeded",
        title: "Quota exceeded",
        status: 429,
        detail: "The request limit is exhausted.",
        code: "quota_exceeded",
        request_id: "req_12345678",
        retryable: true,
      }), {
        status: 429,
        headers: {
          "Content-Type": "application/problem+json",
          "X-Latchway-Request-ID": "req_12345678",
        },
      }),
    };

    try {
      await streamHabitAssistant(transport, "Suggest one habit.");
      throw new Error("Expected the canonical Problem response to reject.");
    } catch (error) {
      expect(error).toMatchObject({
        name: "LatchwayError",
        code: "quota_exceeded",
        requestID: "req_12345678",
        retryable: true,
      });
    }
  });

  it("exposes a reusable feature-bound fetch without making a request", () => {
    const featureFetch = vi.fn(async () => new Response("ok"));
    const fetchFor = vi.fn(() => featureFetch);
    const transport: AuthenticatedTransport = {
      gatewayURL: "https://ai.example.com",
      fetchFor,
    };

    expect(createHabitAssistantFetch(transport)).toBe(featureFetch);
    expect(fetchFor).toHaveBeenCalledWith("habit-assistant");
    expect(featureFetch).not.toHaveBeenCalled();
  });

  it("allowlists diagnostics without installation, session, trust, or credential details", async () => {
    const diagnostics = vi.fn(async () => ({
      server: {
        request_id: "req_12345678",
        server_version: "1.0.0",
        contract_version: "1.0.0" as const,
        protocol_version: 2 as const,
        installation: {
          installation_family_id: "fam_secret",
          installation_id: "ins_secret",
          component_id: "cmp_secret",
          component_kind: "browser",
          component_role: "root",
          platform: "web",
          public_key_jkt: "jkt-secret",
        },
        session: { expires_at: "2026-09-01T00:00:00Z", refresh_available: true },
        trust: { provider: "debug", assurance: "development" },
      },
      client: {
        sdkVersion: "1.0.0",
        contractVersion: "1.0.0",
        protocolVersion: 2,
        platform: "web" as const,
        keyPersistence: "indexeddb" as const,
        sessionPersistence: "indexeddb" as const,
        clockOffsetMilliseconds: 125,
      },
    }));
    const client = { diagnostics } as unknown as Pick<LatchwayClient, "diagnostics">;

    const safe = await safeBrowserDiagnostics(client);

    expect(safe).toEqual({
      requestID: "req_12345678",
      serverVersion: "1.0.0",
      contractVersion: "1.0.0",
      protocolVersion: 2,
      sdkVersion: "1.0.0",
      platform: "web",
      keyPersistence: "indexeddb",
      sessionPersistence: "indexeddb",
      clockOffsetMilliseconds: 125,
    });
    expect(JSON.stringify(safe)).not.toMatch(/fam_secret|ins_secret|cmp_secret|jkt-secret|expires_at|refresh_available|trust/);
  });
});
