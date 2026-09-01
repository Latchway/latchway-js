import type { InstallationKeyRecord } from "../dpop/key.js";
import type { StateStore, StoredSession } from "./state.js";

export interface MemoryState {
  installation?: InstallationKeyRecord;
  session?: StoredSession;
  lease?: { owner: string; expiresAt: number };
}

export class MemoryStateStore implements StateStore {
  readonly persistenceKind = "memory" as const;
  readonly supportsSharedLease = false;

  constructor(private readonly state: MemoryState = {}) {}

  async loadInstallation(): Promise<InstallationKeyRecord | undefined> {
    return this.state.installation;
  }

  async saveInstallation(value: InstallationKeyRecord): Promise<void> {
    this.state.installation = value;
  }

  async clearInstallation(): Promise<void> {
    delete this.state.installation;
  }

  async loadSession(): Promise<StoredSession | undefined> {
    return this.state.session;
  }

  async saveSession(value: StoredSession): Promise<void> {
    this.state.session = value;
  }

  async clearSession(): Promise<void> {
    delete this.state.session;
  }

  async tryAcquireMutationLease(owner: string, expiresAt: number): Promise<boolean> {
    const lease = this.state.lease;
    if (lease !== undefined && lease.expiresAt > Date.now() && lease.owner !== owner) return false;
    this.state.lease = { owner, expiresAt };
    return true;
  }

  async releaseMutationLease(owner: string): Promise<void> {
    if (this.state.lease?.owner === owner) delete this.state.lease;
  }
}
