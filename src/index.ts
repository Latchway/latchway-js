import { createBrowserLatchwayClient } from "./browser.js";

export const createLatchwayClient = createBrowserLatchwayClient;

export {
  LatchwayError,
  errorFromResponse,
  latchwayErrorDocumentationURL,
} from "./errors.js";
export { createCustomAttestationProvider } from "./attestation/custom.js";
export {
  CONTRACT_VERSION,
  PROTOCOL_VERSION,
  SDK_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./version.js";
export type {
  AttestationContext,
  AttestationProvider,
  AttestationProviderID,
  AuthenticatedTransport,
  ClientComponentKind,
  ClientComponentSummary,
  Diagnostics,
  FetchImplementation,
  FrameworkID,
  FrameworkMetadata,
  IdentityTokenProvider,
  InstallationFamilySummary,
  InstallationMetadata,
  LatchwayClient,
  LatchwayFetchInit,
  LatchwayOptions,
  PersistenceMode,
  PersistenceOptions,
  ProvisionComponentOptions,
  ProvisionedComponent,
  PublicP256JWK,
  QuotaLimit,
  QuotaSnapshot,
  ServerDiagnostics,
} from "./types.js";
export type {
  LatchwayErrorCode,
  LatchwayErrorDocumentationURL,
  LatchwayServerErrorCode,
} from "./errors.js";
