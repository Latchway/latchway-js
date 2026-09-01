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
  loadInstallation(): Promise<unknown>;
  saveInstallation(value: InstallationKeyRecord): Promise<void>;
  clearInstallation(): Promise<void>;
  loadSession(): Promise<unknown>;
  saveSession(value: StoredSession): Promise<void>;
  clearSession(): Promise<void>;
  tryAcquireMutationLease(owner: string, expiresAt: number): Promise<boolean>;
  releaseMutationLease(owner: string): Promise<void>;
}
