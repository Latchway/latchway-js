import { webcrypto } from "node:crypto";

import { createClientForRuntime } from "./client/create.js";
import type { AttestationProvider, LatchwayClient, LatchwayOptions } from "./types.js";

export interface NodeLatchwayOptions extends Omit<LatchwayOptions, "persistence"> {
  /** Node mode is memory-only and provides software-key possession, not app attestation. */
  attestationProviders: readonly AttestationProvider[];
}

export function createNodeLatchwayClient(options: NodeLatchwayOptions): LatchwayClient {
  return createClientForRuntime(
    { ...options, persistence: { mode: "memory" } },
    "node",
    webcrypto as unknown as Crypto,
  );
}

export { createCustomAttestationProvider } from "./attestation/custom.js";
export type { CustomAttestationProviderOptions } from "./attestation/custom.js";
export type { AttestationProvider, IdentityTokenProvider, LatchwayClient } from "./types.js";
