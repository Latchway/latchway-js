import type { LatchwayClient } from "@latchway/client";
import { createLatchwayChatOpenAI } from "@latchway/langchain";

export function createHabitAssistantModel(latchway: LatchwayClient) {
  return createLatchwayChatOpenAI({ latchway, feature: "habit-assistant" });
}
