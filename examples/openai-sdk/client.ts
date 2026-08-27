import type { LatchwayClient } from "@latchway/client";

export function openAITransportOptions(latchway: LatchwayClient) {
  return {
    apiKey: "latchway-managed",
    baseURL: "https://ai.example.com/v1",
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      latchway.fetch(input, { ...init, latchwayFeature: "assistant" }),
  };
}
