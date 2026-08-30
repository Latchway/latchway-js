import type { LatchwayClient } from "@latchway/client";

export function createHabitAssistantFetch(latchway: LatchwayClient) {
  return latchway.fetchFor("habit-assistant");
}

export async function summarize(latchway: LatchwayClient, input: string): Promise<Response> {
  return createHabitAssistantFetch(latchway)("/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "latchway", input }),
  });
}
