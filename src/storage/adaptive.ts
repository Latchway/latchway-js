import type { InstallationKeyRecord } from "../dpop/key.js";
import { LatchwayError } from "../errors.js";
import type { PersistenceMode } from "../types.js";
import { MemoryStateStore } from "./memory.js";
import type { StateStore, StoredSession } from "./state.js";

export class AdaptiveStateStore implements StateStore {
  private primary: StateStore | undefined;
  private readonly fallback = new MemoryStateStore();

  constructor(primary: StateStore | undefined, private readonly mode: PersistenceMode) {
    this.primary = mode === "memory" ? undefined : primary;
  }

  get persistenceKind(): "indexeddb" | "memory" {
    return this.primary?.persistenceKind ?? "memory";
  }

  get supportsSharedLease(): boolean {
    return this.primary?.supportsSharedLease ?? false;
  }

  loadInstallation(): Promise<unknown> {
    return this.run((store) => store.loadInstallation());
  }

  saveInstallation(value: InstallationKeyRecord): Promise<void> {
    return this.run((store) => store.saveInstallation(value));
  }

  clearInstallation(): Promise<void> {
    return this.run((store) => store.clearInstallation());
  }

  loadSession(): Promise<unknown> {
    return this.run((store) => store.loadSession());
  }

  saveSession(value: StoredSession): Promise<void> {
    return this.run((store) => store.saveSession(value));
  }

  clearSession(): Promise<void> {
    return this.run((store) => store.clearSession());
  }

  tryAcquireMutationLease(owner: string, expiresAt: number): Promise<boolean> {
    return this.run((store) => store.tryAcquireMutationLease(owner, expiresAt));
  }

  releaseMutationLease(owner: string): Promise<void> {
    return this.run((store) => store.releaseMutationLease(owner));
  }

  private async run<T>(operation: (store: StateStore) => Promise<T>): Promise<T> {
    if (this.primary === undefined) {
      if (this.mode === "required") {
        throw new LatchwayError(
          "storage_unavailable",
          "Persistent browser storage is required. Set persistence.mode to allow-memory only after accepting session-only storage.",
        );
      }
      return operation(this.fallback);
    }
    try {
      return await operation(this.primary);
    } catch (cause) {
      if (this.mode !== "allow-memory") throw cause;
      this.primary = undefined;
      return operation(this.fallback);
    }
  }
}
