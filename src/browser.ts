import { createClientForRuntime } from "./client/create.js";
import type { LatchwayClient, LatchwayOptions } from "./types.js";

export function createBrowserLatchwayClient(options: LatchwayOptions): LatchwayClient {
  return createClientForRuntime(options, "web", globalThis.crypto);
}

export type {
  AttestationContext,
  AttestationProvider,
  FrameworkID,
  FrameworkMetadata,
  IdentityTokenProvider,
  LatchwayClient,
  LatchwayFetchInit,
  LatchwayOptions,
  ProvisionComponentOptions,
  ProvisionedComponent,
  PublicP256JWK,
} from "./types.js";
