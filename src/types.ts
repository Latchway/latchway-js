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

export interface RefreshAttestationContext {
  applicationID: string;
  environment: string;
  dpopJkt: string;
  platform: Platform;
}

export interface AttestationProvider {
  readonly provider: AttestationProviderID;
  getEvidence(context: AttestationContext): Promise<Readonly<Record<string, unknown>>>;
  getRefreshEvidence?(context: RefreshAttestationContext): Promise<Readonly<Record<string, unknown>>>;
}

export type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
  allowInsecureHTTP?: boolean;
}

export interface LatchwayFetchInit extends RequestInit {
  latchwayFeature?: string;
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
}

export interface ServerDiagnostics {
  request_id: string;
  server_version: string;
  contract_version: "0.1.0";
  protocol_version: 1;
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

export interface LatchwayClient {
  fetch(input: RequestInfo | URL, init?: LatchwayFetchInit): Promise<Response>;
  authorize(request: Request, feature: string): Promise<Request>;
  quota(feature: string): Promise<QuotaSnapshot>;
  revokeCurrentInstallation(): Promise<void>;
  diagnostics(): Promise<Diagnostics>;
}
