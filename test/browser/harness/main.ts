import type { LatchwayClient } from "@latchway/client";

import { createFirebaseClient } from "../../../examples/firebase/client.js";
import { createVanillaClient } from "../../../examples/vanilla/client.js";
import {
  createLoopbackDevelopmentBrowserClient,
  safeBrowserDiagnostics,
} from "../../../examples/vanilla/development-client.js";
import {
  safeHabitAssistantFailure,
  streamHabitAssistant,
} from "../../../examples/vanilla/streaming-fetch.js";

const gatewayOrigin = "http://127.0.0.1:4174";
const applicationID = "app_01J00000000000000000000000";
const persistenceStores = ["installations", "sessions", "leases"] as const;
const clients = new Map<string, LatchwayClient>();
const cancellations = new Map<string, {
  controller: AbortController;
  completion: Promise<ReturnType<typeof cancelledResult> | ReturnType<typeof safeErrorResult>>;
}>();
const cspViolations: string[] = [];

document.addEventListener("securitypolicyviolation", (event) => {
  cspViolations.push(`${event.effectiveDirective}:${event.blockedURI}`);
});

function client(databaseName: string): LatchwayClient {
  const existing = clients.get(databaseName);
  if (existing !== undefined) return existing;
  const created = createLoopbackDevelopmentBrowserClient({
    baseURL: gatewayOrigin,
    applicationID,
    appVersion: "1.0.0-browser-conformance",
    databaseName,
  }, {
    getIdentityToken: async () => "browser-conformance-identity-token",
    getDevelopmentEvidence: async ({ challenge }) => ({
      challenge_token: `test-only-${challenge.challenge_id}`,
      client_data_hash: challenge.attestation.client_data_hash,
    }),
  });
  clients.set(databaseName, created);
  return created;
}

async function diagnostics(databaseName: string) {
  return safeBrowserDiagnostics(client(databaseName));
}

async function stream(databaseName: string, input = "stream") {
  return streamHabitAssistant(client(databaseName), input);
}

async function refresh(databaseName: string): Promise<void> {
  await client(databaseName).refresh();
}

async function revokeInstallation(databaseName: string): Promise<void> {
  await client(databaseName).revokeCurrentInstallation();
}

function beginCancellation(databaseName: string): void {
  if (cancellations.has(databaseName)) {
    throw new Error(`A cancellation operation is already active for ${databaseName}.`);
  }
  const controller = new AbortController();
  const completion = streamHabitAssistant(client(databaseName), "cancel", controller.signal).then(
    cancelledResult,
    safeErrorResult,
  );
  cancellations.set(databaseName, { controller, completion });
}

async function finishCancellation(databaseName: string) {
  const cancellation = cancellations.get(databaseName);
  if (cancellation === undefined) {
    throw new Error(`No cancellation operation is active for ${databaseName}.`);
  }
  cancellations.delete(databaseName);
  cancellation.controller.abort(new DOMException("cancelled by conformance", "AbortError"));
  return cancellation.completion;
}

function cancelledResult() {
  return {
    rejected: false,
    name: null,
    code: null,
    requestID: null,
    retryable: false,
    documentationURL: null,
  };
}

function safeErrorResult(error: unknown) {
  return { rejected: true, ...safeError(error) };
}

async function diagnosticsError(databaseName: string) {
  try {
    await diagnostics(databaseName);
    return {
      rejected: false,
      name: null,
      code: null,
      requestID: null,
      retryable: false,
      documentationURL: null,
    };
  } catch (error) {
    return { rejected: true, ...safeError(error) };
  }
}

async function streamError(databaseName: string) {
  try {
    await stream(databaseName);
    return {
      rejected: false,
      name: null,
      code: null,
      requestID: null,
      retryable: false,
      documentationURL: null,
    };
  } catch (error) {
    return { rejected: true, ...safeError(error) };
  }
}

async function inspectPersistence(databaseName: string) {
  const database = await openDatabase(databaseName);
  try {
    const [installation, session] = await Promise.all([
      readStore(database, "installations"),
      readStore(database, "sessions"),
    ]);
    if (!isRecord(installation) || !(installation.privateKey instanceof CryptoKey)) {
      throw new Error("The persisted installation key is unavailable.");
    }
    let exportRejected = false;
    try {
      await crypto.subtle.exportKey("jwk", installation.privateKey);
    } catch {
      exportRejected = true;
    }
    return {
      privateKeyExtractable: installation.privateKey.extractable,
      privateKeyUsages: [...installation.privateKey.usages],
      exportRejected,
      sessionPresent: session !== undefined,
      thumbprint: typeof installation.thumbprint === "string" ? installation.thumbprint : null,
      sessionGeneration: isRecord(session) && typeof session.generation === "number" ? session.generation : null,
      sessionJkt: isRecord(session) && isRecord(session.installation) &&
          typeof session.installation.dpop_jkt === "string"
        ? session.installation.dpop_jkt
        : null,
    };
  } finally {
    database.close();
  }
}

async function abandonMutationLease(databaseName: string, lifetimeMilliseconds: number) {
  if (!Number.isSafeInteger(lifetimeMilliseconds) || lifetimeMilliseconds < 100 || lifetimeMilliseconds > 5_000) {
    throw new Error("The abandoned lease lifetime is outside the test bound.");
  }
  const database = await openDatabase(databaseName);
  const expiresAt = Date.now() + lifetimeMilliseconds;
  try {
    await writeStore(database, "leases", { owner: "abandoned-browser-page", expiresAt });
    return { expiresAt };
  } finally {
    database.close();
  }
}

async function mutationLeasePresent(databaseName: string): Promise<boolean> {
  const database = await openDatabase(databaseName);
  try {
    return await readStore(database, "leases") !== undefined;
  } finally {
    database.close();
  }
}

async function deletePersistence(databaseName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => { resolve(); };
    request.onerror = () => { reject(request.error ?? new Error("IndexedDB deletion failed.")); };
    request.onblocked = () => { reject(new Error("IndexedDB deletion was blocked.")); };
  });
}

function quickstartFactories() {
  let identityCalls = 0;
  let providerCalls = 0;
  const dependencies = {
    getIdentityToken: async () => {
      identityCalls += 1;
      return "quickstart-identity-token";
    },
    getTurnstileToken: async () => {
      providerCalls += 1;
      return "quickstart-turnstile-token";
    },
  };
  const vanilla = createVanillaClient(dependencies);
  const firebase = createFirebaseClient({
    getIDToken: dependencies.getIdentityToken,
    getAppCheckToken: async () => {
      providerCalls += 1;
      return { token: "quickstart-app-check-token" };
    },
  });
  return {
    vanillaGateway: vanilla.gatewayURL,
    firebaseGateway: firebase.gatewayURL,
    identityCalls,
    providerCalls,
  };
}

function safeError(error: unknown) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    ...safeHabitAssistantFailure(error),
  };
}

async function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      for (const name of persistenceStores) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error("IndexedDB open failed.")); };
  });
}

async function readStore(database: IDBDatabase, name: string): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const request = database.transaction(name, "readonly").objectStore(name).get(persistenceScope());
    request.onsuccess = () => { resolve(request.result as unknown); };
    request.onerror = () => { reject(request.error ?? new Error("IndexedDB read failed.")); };
  });
}

async function writeStore(database: IDBDatabase, name: string, value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(name, "readwrite");
    transaction.objectStore(name).put(value, persistenceScope());
    transaction.oncomplete = () => { resolve(); };
    transaction.onerror = () => { reject(transaction.error ?? new Error("IndexedDB write failed.")); };
    transaction.onabort = () => { reject(transaction.error ?? new Error("IndexedDB write aborted.")); };
  });
}

function persistenceScope(): string {
  return `${gatewayOrigin}|${applicationID}|development|web`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const harness = {
  abandonMutationLease,
  beginCancellation,
  cspViolations: () => [...cspViolations],
  deletePersistence,
  diagnostics,
  diagnosticsError,
  finishCancellation,
  inspectPersistence,
  mutationLeasePresent,
  prepare: (databaseName: string) => { void client(databaseName); },
  quickstartFactories,
  refresh,
  revokeInstallation,
  stream,
  streamError,
};

declare global {
  interface Window {
    __latchwayHarness: typeof harness;
  }
}

window.__latchwayHarness = harness;
