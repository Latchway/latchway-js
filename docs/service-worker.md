# Service-worker transport

`@latchway/client/service-worker` turns an existing `LatchwayClient` into an
explicit fetch-event handler. It does not register listeners or patch global
fetch.

```ts
import { createLatchwayServiceWorkerHandler } from "@latchway/client/service-worker";

const handler = createLatchwayServiceWorkerHandler({
  client: latchway,
  featureFor(request) {
    const url = new URL(request.url);
    return url.pathname === "/v1/responses" ? "habit_assistant" : undefined;
  },
});

self.addEventListener("fetch", (event) => {
  handler.handle(event);
});
```

`handle` returns `true` only when it synchronously calls `respondWith`. `route`
is available for routers that own that lifecycle already and resolves to
`undefined` for an unclaimed request.

The handler first requires the exact configured gateway origin, then asks the
application for a feature. The base client independently revalidates the final
origin, method, structured or opaque path, credential-like query names, and
redirect result. `featureFor` should be deterministic and should not copy an
untrusted header into a feature identifier.

The response body is returned without buffering and the incoming Request
signal remains connected. A streaming request body is not replayed if a nonce
or session rotation is required; it fails with
`transport_request_not_replayable`.

In a browser worker, IndexedDB storage is origin-scoped and can participate in
the same refresh lease as pages using the same client scope. This is web key
possession, not a claim of native app or device attestation. An independently
configured Installation Family component needs its own key and one-time
component bootstrap flow; do not copy a root private key or rotating refresh
token into a worker.
