import type { InstallationKeyRecord } from "../dpop/key.js";
import type {
  ClientComponentSummary,
  InstallationFamilySummary,
  InstallationSummary,
  TrustSummary,
} from "../types.js";

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  installation: InstallationSummary;
  installationFamily?: InstallationFamilySummary;
  component?: ClientComponentSummary;
  trust: TrustSummary;
  generation: number;
  clockOffsetMilliseconds: number;
}

export interface StateStore {
  readonly persistenceKind: "indexeddb" | "memory";
  readonly supportsSharedLease: boolean;
  loadInstallation(): Promise<InstallationKeyRecord | undefined>;
  saveInstallation(value: InstallationKeyRecord): Promise<void>;
  clearInstallation(): Promise<void>;
  loadSession(): Promise<StoredSession | undefined>;
  saveSession(value: StoredSession): Promise<void>;
  clearSession(): Promise<void>;
  tryAcquireRefreshLease(owner: string, expiresAt: number): Promise<boolean>;
  releaseRefreshLease(owner: string): Promise<void>;
}
