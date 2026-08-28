import { createBrowserLatchwayClient } from "./browser.js";

export const createLatchwayClient = createBrowserLatchwayClient;

export { LatchwayError, errorFromResponse } from "./errors.js";
export { createCustomAttestationProvider } from "./attestation/custom.js";
export { CONTRACT_VERSION, PROTOCOL_VERSION, SDK_VERSION } from "./version.js";
export type {
  AttestationContext,
  AttestationProvider,
  AttestationProviderID,
  Diagnostics,
  FetchImplementation,
  IdentityTokenProvider,
  InstallationMetadata,
  LatchwayClient,
  LatchwayFetchInit,
  LatchwayOptions,
  PersistenceMode,
  PersistenceOptions,
  QuotaLimit,
  QuotaSnapshot,
  ServerDiagnostics,
} from "./types.js";
export type { LatchwayErrorCode, LatchwayServerErrorCode } from "./errors.js";
