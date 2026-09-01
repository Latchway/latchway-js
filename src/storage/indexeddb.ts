import type { InstallationKeyRecord } from "../dpop/key.js";
import { LatchwayError } from "../errors.js";
import type { StateStore, StoredSession } from "./state.js";

const installations = "installations";
const sessions = "sessions";
const leases = "leases";

interface LeaseRecord {
  owner: string;
  expiresAt: number;
}

export class IndexedDBStateStore implements StateStore {
  readonly persistenceKind = "indexeddb" as const;
  readonly supportsSharedLease = true;
  private databasePromise: Promise<IDBDatabase> | undefined;

  constructor(
    private readonly factory: IDBFactory,
    private readonly databaseName: string,
    private readonly scope: string,
  ) {}

  async loadInstallation(): Promise<InstallationKeyRecord | undefined> {
    return this.get<InstallationKeyRecord>(installations);
  }

  async saveInstallation(value: InstallationKeyRecord): Promise<void> {
    await this.put(installations, value);
  }

  async clearInstallation(): Promise<void> {
    await this.delete(installations);
  }

  async loadSession(): Promise<StoredSession | undefined> {
    return this.get<StoredSession>(sessions);
  }

  async saveSession(value: StoredSession): Promise<void> {
    await this.put(sessions, value);
  }

  async clearSession(): Promise<void> {
    await this.delete(sessions);
  }

  async tryAcquireMutationLease(owner: string, expiresAt: number): Promise<boolean> {
    const database = await this.database();
    return new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(leases, "readwrite");
      let acquired = false;
      const store = transaction.objectStore(leases);
      const request = store.get(this.scope);
      request.onsuccess = () => {
        const current = request.result as LeaseRecord | undefined;
        if (current === undefined || current.expiresAt <= Date.now() || current.owner === owner) {
          store.put({ owner, expiresAt } satisfies LeaseRecord, this.scope);
          acquired = true;
        }
      };
      request.onerror = () => { transaction.abort(); };
      transaction.oncomplete = () => { resolve(acquired); };
      transaction.onerror = () => { reject(storageError(transaction.error)); };
      transaction.onabort = () => { reject(storageError(transaction.error)); };
    });
  }

  async releaseMutationLease(owner: string): Promise<void> {
    const database = await this.database();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(leases, "readwrite");
      const store = transaction.objectStore(leases);
      const request = store.get(this.scope);
      request.onsuccess = () => {
        const current = request.result as LeaseRecord | undefined;
        if (current?.owner === owner) store.delete(this.scope);
      };
      request.onerror = () => { transaction.abort(); };
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(storageError(transaction.error)); };
      transaction.onabort = () => { reject(storageError(transaction.error)); };
    });
  }

  private async get<T>(storeName: string): Promise<T | undefined> {
    const database = await this.database();
    return new Promise<T | undefined>((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(this.scope);
      request.onsuccess = () => { resolve(request.result as T | undefined); };
      request.onerror = () => { reject(storageError(request.error)); };
    });
  }

  private async put(storeName: string, value: unknown): Promise<void> {
    const database = await this.database();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(value, this.scope);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(storageError(transaction.error)); };
      transaction.onabort = () => { reject(storageError(transaction.error)); };
    });
  }

  private async delete(storeName: string): Promise<void> {
    const database = await this.database();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).delete(this.scope);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(storageError(transaction.error)); };
      transaction.onabort = () => { reject(storageError(transaction.error)); };
    });
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.factory.open(this.databaseName, 1);
      } catch (cause) {
        reject(storageError(cause));
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const name of [installations, sessions, leases]) {
          if (!database.objectStoreNames.contains(name)) database.createObjectStore(name);
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); };
        resolve(request.result);
      };
      request.onerror = () => { reject(storageError(request.error)); };
      request.onblocked = () => { reject(storageError(new Error("IndexedDB upgrade was blocked."))); };
    });
    return this.databasePromise;
  }
}

function storageError(cause: unknown): LatchwayError {
  return cause instanceof LatchwayError
    ? cause
    : new LatchwayError("storage_unavailable", "IndexedDB persistence is unavailable.", { cause });
}
