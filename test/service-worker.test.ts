import { describe, expect, it, vi } from "vitest";

import { createLatchwayServiceWorkerHandler } from "../src/service-worker.js";
import type { AuthenticatedTransport } from "../src/types.js";

describe("service-worker routing", () => {
  it("claims only selected requests for the exact gateway origin", async () => {
    const dispatch = vi.fn(async () => new Response("streamed"));
    const fetchFor = vi.fn(() => dispatch);
    const client = { gatewayURL: "https://gateway.example.test", fetchFor } as AuthenticatedTransport;
    const handler = createLatchwayServiceWorkerHandler({
      client,
      featureFor: (request) => new URL(request.url).pathname === "/v1/responses" ? "assistant" : undefined,
    });

    await expect(handler.route(new Request("https://cdn.example.test/v1/responses"))).resolves.toBeUndefined();
    await expect(handler.route(new Request("https://gateway.example.test/telemetry"))).resolves.toBeUndefined();
    const response = await handler.route(new Request("https://gateway.example.test/v1/responses"));
    await expect(response?.text()).resolves.toBe("streamed");
    expect(fetchFor).toHaveBeenCalledWith("assistant");

    let responsePromise: Promise<Response> | undefined;
    const claimed = handler.handle({
      request: new Request("https://gateway.example.test/v1/responses"),
      respondWith(value) { responsePromise = value; },
    });
    expect(claimed).toBe(true);
    await expect(responsePromise).resolves.toBeInstanceOf(Response);
  });
});
