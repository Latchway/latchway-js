import type { LatchwayClient } from "@latchway/client";
import { createLatchwayProvider } from "@latchway/vercel-ai";
import { streamText } from "ai";

export function streamHabitAssistant(latchway: LatchwayClient, prompt: string) {
  const provider = createLatchwayProvider({ client: latchway });
  return streamText({ model: provider("habit-assistant"), prompt });
}
