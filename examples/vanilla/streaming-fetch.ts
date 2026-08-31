import {
  errorFromResponse,
  type AuthenticatedTransport,
  type FetchImplementation,
} from "@latchway/client";

export interface HabitAssistantResult {
  output: string;
  requestID: string | null;
}

export function createHabitAssistantFetch(
  latchway: AuthenticatedTransport,
): FetchImplementation {
  return latchway.fetchFor("habit-assistant");
}

export async function streamHabitAssistant(
  latchway: AuthenticatedTransport,
  input: string,
  signal?: AbortSignal,
): Promise<HabitAssistantResult> {
  const response = await createHabitAssistantFetch(latchway)("/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, stream: true }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw await errorFromResponse(response.clone());
  if (response.body === null) throw new Error("The protected response has no body.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return {
    output,
    requestID: response.headers.get("X-Latchway-Request-ID"),
  };
}

