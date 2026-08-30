import type { LatchwayClient } from "@latchway/client";
import { createLatchwayOpenAI } from "@latchway/openai";

export function createHabitAssistantOpenAI(latchway: LatchwayClient) {
  return createLatchwayOpenAI({ latchway, feature: "habit-assistant" });
}
