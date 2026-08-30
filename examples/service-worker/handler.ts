import type { LatchwayClient } from "@latchway/client";
import { createLatchwayServiceWorkerHandler } from "@latchway/client/service-worker";

export function createGatewayHandler(latchway: LatchwayClient) {
  return createLatchwayServiceWorkerHandler({
    client: latchway,
    featureFor(request) {
      const path = new URL(request.url).pathname;
      return path === "/v1/responses" ? "habit-assistant" : undefined;
    },
  });
}
