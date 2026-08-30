import type { AuthenticatedTransport } from "./types.js";

export interface LatchwayServiceWorkerOptions {
  client: AuthenticatedTransport;
  /** Return a feature only for application requests the worker should own. */
  featureFor(request: Request): string | undefined;
}

export interface ServiceWorkerFetchEventLike {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}

export interface LatchwayServiceWorkerHandler {
  /** Routes a request without installing or mutating a global event listener. */
  route(request: Request): Promise<Response | undefined>;
  /** Returns true only when the event was synchronously claimed. */
  handle(event: ServiceWorkerFetchEventLike): boolean;
}

export function createLatchwayServiceWorkerHandler(
  options: LatchwayServiceWorkerOptions,
): LatchwayServiceWorkerHandler {
  const gatewayOrigin = new URL(options.client.gatewayURL).origin;

  const select = (request: Request): string | undefined => {
    if (new URL(request.url).origin !== gatewayOrigin) return undefined;
    return options.featureFor(request);
  };

  const dispatch = (request: Request, feature: string): Promise<Response> =>
    options.client.fetchFor(feature)(request);

  return {
    async route(request) {
      const feature = select(request);
      return feature === undefined ? undefined : dispatch(request, feature);
    },
    handle(event) {
      const feature = select(event.request);
      if (feature === undefined) return false;
      event.respondWith(dispatch(event.request, feature));
      return true;
    },
  };
}
