export type Platform = "web" | "node";

export type PersistenceMode = "required" | "allow-memory" | "memory";

export interface PersistenceOptions {
  /**
   * `required` rejects use when IndexedDB is unavailable. `allow-memory`
   * explicitly permits a session-only fallback. `memory` skips persistence.
   */
  mode?: PersistenceMode;
  databaseName?: string;
}

export interface IdentityTokenProvider {
  getIdentityToken(): Promise<string>;
}

export interface SessionChallenge {
  challenge_id: string;
  challenge_nonce: string;
  binding_version: 1;
  issued_at: number;
  expires_at: string;
  attestation: {
    provider: AttestationProviderID;
    mode: "required" | "preferred";
    client_data_hash: string;
    provider_options?: Readonly<Record<string, unknown>>;
  };
}

export type AttestationProviderID =
  | "app_attest"
  | "play_integrity"
  | "firebase_app_check"
  | "turnstile"
  | "debug";

export interface AttestationContext {
  challenge: Readonly<SessionChallenge>;
  applicationID: string;
  environment: string;
  dpopJkt: string;
  platform: Platform;
}

export interface AttestationProvider {
  readonly provider: AttestationProviderID;
  getEvidence(context: AttestationContext): Promise<Readonly<Record<string, unknown>>>;
}

export type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type FrameworkID =
  | "android-okhttp"
  | "foundation-models"
  | "langchain-js"
  | "macpaw-openai"
  | "openai-js"
  | "react-native-fetch"
  | "swift-openai"
  | "vercel-ai-sdk";

export interface FrameworkMetadata {
  /** Stable framework registry identifier, for example `openai-js`. */
  id: FrameworkID;
  /** Exact canonical SemVer observed by the first-party adapter. */
  version: string;
}

export interface InstallationMetadata {
  appVersion: string;
  osVersion?: string;
  deviceModel?: string;
}

export interface LatchwayOptions {
  baseURL: string;
  applicationID: string;
  environment: string;
  identityTokenProvider: IdentityTokenProvider;
  identityProvider?: string;
  attestationProviders?: readonly AttestationProvider[];
  installation?: Partial<InstallationMetadata>;
  persistence?: PersistenceOptions;
  fetch?: FetchImplementation;
  /** Allows HTTP only on localhost, 127.0.0.1, or [::1] for local conformance. */
  allowInsecureHTTP?: boolean;
}

export interface LatchwayFetchInit extends RequestInit {
  latchwayFeature?: string;
  latchwayFramework?: FrameworkMetadata;
}

export interface QuotaLimit {
  metric: string;
  maximum?: number;
  used?: number;
  reserved?: number;
  remaining?: number;
  resets_at?: string;
  hard: boolean;
}

export interface QuotaSnapshot {
  feature: string;
  observed_at: string;
  limits: QuotaLimit[];
}

export interface InstallationSummary {
  id: string;
  platform: Platform | "ios" | "android" | "react_native_ios" | "react_native_android";
  dpop_jkt: string;
  status: "active" | "revoked";
}

export interface InstallationFamilySummary {
  id: string;
  status: "active" | "revoked";
}

export type ClientComponentKind =
  | "main_app"
  | "widget"
  | "share_extension"
  | "app_intent_extension"
  | "notification_service_extension"
  | "action_extension"
  | "sso_extension"
  | "watch_extension"
  | "android_app"
  | "wear_app"
  | "browser"
  | "node_process";

export interface ClientComponentSummary {
  id: string;
  definition_id: string;
  kind: ClientComponentKind;
  platform: InstallationSummary["platform"];
  is_root: boolean;
  status: "active" | "revoked";
  dpop_jkt: string;
  granted_features: string[];
}

export interface PublicP256JWK {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface ProvisionComponentOptions {
  componentDefinitionID: string;
  publicJWK: PublicP256JWK;
  requestedFeatures: readonly string[];
  /** Defaults to the containing client's configured application version. */
  appVersion?: string;
}

/**
 * One-time child bootstrap material. Deliver it directly to the component
 * that owns `publicJWK`; never log it or persist it with the root session.
 */
export interface ProvisionedComponent {
  componentID: string;
  installationFamilyID: string;
  trust: {
    source: "delegated_from_attested_root" | "delegated_identity_only";
    expiresAt: string;
  };
  grantedFeatures: string[];
  refreshGrant: string;
  refreshGrantExpiresAt: string;
}

export interface TrustSummary {
  provider: string;
  level:
    | "none"
    | "identity_only"
    | "web_risk_verified"
    | "app_verified"
    | "device_verified"
    | "strong_device_verified"
    | "debug";
  verified_at: string;
  expires_at: string;
  source?:
    | "direct_attested"
    | "delegated_from_attested_root"
    | "delegated_identity_only"
    | "delegated_direct_attested"
    | "identity_only"
    | "web_risk_verified"
    | "debug";
  parent_component_id?: string;
  parent_attestation_provider?: string;
  delegation_id?: string;
}

export interface ServerDiagnostics {
  request_id: string;
  server_version: string;
  contract_version: "1.0.0";
  protocol_version: 2;
  installation: InstallationSummary;
  session: {
    expires_at: string;
    refresh_available: boolean;
  };
  trust: TrustSummary;
}

export interface Diagnostics {
  server: ServerDiagnostics;
  client: {
    sdkVersion: string;
    contractVersion: string;
    protocolVersion: number;
    platform: Platform;
    keyPersistence: "indexeddb" | "memory";
    sessionPersistence: "indexeddb" | "memory";
    clockOffsetMilliseconds: number;
  };
}

/** Minimal surface consumed by web, service-worker, Node, and native-owned React Native adapters. */
export interface AuthenticatedTransport {
  /** Canonical gateway origin without a trailing slash. Contains no credential material. */
  readonly gatewayURL: string;
  /** Returns a WHATWG-fetch-compatible transport permanently bound to one feature. */
  fetchFor(feature: string, framework?: FrameworkMetadata): FetchImplementation;
}

export interface LatchwayClient extends AuthenticatedTransport {
  fetch(input: RequestInfo | URL, init?: LatchwayFetchInit): Promise<Response>;
  authorize(request: Request, feature: string, framework?: FrameworkMetadata): Promise<Request>;
  quota(feature: string): Promise<QuotaSnapshot>;
  /** Explicitly rotates session credentials without exposing either token. */
  refresh(): Promise<void>;
  /** Root-component operation. Registers only a child-owned public key. */
  provisionComponent(options: ProvisionComponentOptions): Promise<ProvisionedComponent>;
  /** Root-component operation. Revokes one delegated component and its sessions. */
  revokeComponent(componentID: string): Promise<void>;
  /** Revokes every component and session in the current Installation Family. */
  revokeCurrentInstallationFamily(): Promise<void>;
  revokeCurrentInstallation(): Promise<void>;
  diagnostics(): Promise<Diagnostics>;
}
