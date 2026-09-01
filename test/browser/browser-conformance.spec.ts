import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const gatewayOrigin = "http://127.0.0.1:4174";

interface SafeDiagnostics {
  requestID: string;
  serverVersion: string;
  contractVersion: string;
  protocolVersion: number;
  sdkVersion: string;
  platform: string;
  keyPersistence: "indexeddb" | "memory";
  sessionPersistence: "indexeddb" | "memory";
  clockOffsetMilliseconds: number;
}

interface ServerState {
  counters: {
    challenges: number;
    exchanges: number;
    refreshes: number;
    protected: number;
    revocations: number;
    preflights: number;
    redirectTargets: number;
    streamChunks: number;
    streamCancellations: number;
    providerCredentialHeaderViolations: number;
  };
  challengeJkts: string[];
  preflightHeaders: string[][];
  proofIDs: number;
  maximumConcurrentRefreshes: number;
}

interface SafeErrorResult {
  rejected: boolean;
  name: string | null;
  code: string | null;
  requestID: string | null;
  retryable: boolean;
  documentationURL: string | null;
}

interface PersistenceInspection {
  privateKeyExtractable: boolean;
  privateKeyUsages: string[];
  exportRejected: boolean;
  sessionPresent: boolean;
  thumbprint: string | null;
  sessionGeneration: number | null;
  sessionJkt: string | null;
}

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${gatewayOrigin}/__control/reset`);
  expect(response.ok()).toBe(true);
});

test("SDK-owned Firebase and Turnstile quickstart factories execute without acquiring credentials", async ({ page }) => {
  await openHarness(page);
  const result = await invoke<{
    vanillaGateway: string;
    firebaseGateway: string;
    identityCalls: number;
    providerCalls: number;
  }>(page, "quickstartFactories");
  expect(result).toEqual({
    vanillaGateway: "https://ai.example.com",
    firebaseGateway: "https://ai.example.com",
    identityCalls: 0,
    providerCalls: 0,
  });
});

test("bootstraps once, persists a non-exportable WebCrypto key, restores IndexedDB, and returns only safe diagnostics", async ({
  context,
  page,
}, testInfo) => {
  const databaseName = testDatabase(testInfo.project.name, "bootstrap");
  await openHarness(page);
  const diagnostics = await invoke<SafeDiagnostics>(page, "diagnostics", [databaseName]);
  expect(Object.keys(diagnostics).sort()).toEqual([
    "clockOffsetMilliseconds",
    "contractVersion",
    "keyPersistence",
    "platform",
    "protocolVersion",
    "requestID",
    "sdkVersion",
    "serverVersion",
    "sessionPersistence",
  ]);
  expect(diagnostics).toMatchObject({
    requestID: "req_browser_conformance_0001",
    contractVersion: "1.0.0",
    protocolVersion: 2,
    platform: "web",
    keyPersistence: "indexeddb",
    sessionPersistence: "indexeddb",
  });
  const persisted = await invoke<PersistenceInspection>(page, "inspectPersistence", [databaseName]);
  expect(persisted).toMatchObject({
    privateKeyExtractable: false,
    privateKeyUsages: ["sign"],
    exportRejected: true,
    sessionPresent: true,
  });
  expect(persisted.thumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/u);

  await page.close();
  const restoredPage = await context.newPage();
  await openHarness(restoredPage);
  await invoke<SafeDiagnostics>(restoredPage, "diagnostics", [databaseName]);
  const server = await serverState(context.request);
  expect(server.counters.challenges).toBe(1);
  expect(server.counters.exchanges).toBe(1);
  expect(server.challengeJkts).toEqual([persisted.thumbprint]);
});

test("coordinates simultaneous first use onto one persisted key and session", async ({
  context,
  page,
  request,
}, testInfo) => {
  const databaseName = testDatabase(testInfo.project.name, "simultaneous-bootstrap");
  await setMode(request, { challengeDelayMilliseconds: 125 });
  await openHarness(page);
  const secondPage = await context.newPage();
  await openHarness(secondPage);

  await Promise.all([
    invoke<SafeDiagnostics>(page, "diagnostics", [databaseName]),
    invoke<SafeDiagnostics>(secondPage, "diagnostics", [databaseName]),
  ]);

  const firstPersistence = await invoke<PersistenceInspection>(page, "inspectPersistence", [databaseName]);
  const secondPersistence = await invoke<PersistenceInspection>(secondPage, "inspectPersistence", [databaseName]);
  expect(firstPersistence).toEqual(secondPersistence);
  expect(firstPersistence).toMatchObject({
    sessionPresent: true,
    sessionGeneration: 1,
    sessionJkt: firstPersistence.thumbprint,
  });
  const server = await serverState(request);
  expect(server.counters.challenges).toBe(1);
  expect(server.counters.exchanges).toBe(1);
  expect(server.challengeJkts).toEqual([firstPersistence.thumbprint]);

  await page.close();
  await secondPage.close();
  const restoredPage = await context.newPage();
  await openHarness(restoredPage);
  await invoke<SafeDiagnostics>(restoredPage, "diagnostics", [databaseName]);
  expect(await invoke<PersistenceInspection>(restoredPage, "inspectPersistence", [databaseName]))
    .toEqual(firstPersistence);
  const restoredServer = await serverState(request);
  expect(restoredServer.counters.challenges).toBe(1);
  expect(restoredServer.counters.exchanges).toBe(1);
});

test("recovers after the browser page holding a mutation lease disappears", async ({
  context,
  page,
  request,
}, testInfo) => {
  const databaseName = testDatabase(testInfo.project.name, "abandoned-lease");
  await openHarness(page);
  const abandoned = await invoke<{ expiresAt: number }>(page, "abandonMutationLease", [databaseName, 300]);
  await page.close();

  const recoveredPage = await context.newPage();
  await openHarness(recoveredPage);
  await invoke<SafeDiagnostics>(recoveredPage, "diagnostics", [databaseName]);
  expect(Date.now()).toBeGreaterThanOrEqual(abandoned.expiresAt);
  expect(await invoke<boolean>(recoveredPage, "mutationLeasePresent", [databaseName])).toBe(false);
  const server = await serverState(request);
  expect(server.counters.challenges).toBe(1);
  expect(server.counters.exchanges).toBe(1);
});

test("performs an exact CORS preflight and preserves streamed response chunks", async ({ page, request }, testInfo) => {
  const databaseName = testDatabase(testInfo.project.name, "streaming");
  await openHarness(page);
  const result = await invoke<{ output: string; requestID: string | null }>(page, "stream", [databaseName]);
  expect(result).toEqual({
    output: "data: first\n\ndata: second\n\n",
    requestID: "req_browser_conformance_0001",
  });
  const server = await serverState(request);
  expect(server.counters.streamChunks).toBe(2);
  expect(server.counters.providerCredentialHeaderViolations).toBe(0);
  expect(server.counters.preflights).toBeGreaterThanOrEqual(3);
  expect(server.preflightHeaders.flat()).toEqual(expect.arrayContaining([
    "authorization",
    "content-type",
    "dpop",
    "x-latchway-feature",
    "x-latchway-protocol-version",
  ]));
});

test("propagates AbortSignal cancellation through a live response stream", async ({ page, request }, testInfo) => {
  const databaseName = testDatabase(testInfo.project.name, "cancellation");
  await openHarness(page);
  const result = await invoke<SafeErrorResult>(page, "cancel", [databaseName]);
  expect(result).toMatchObject({ rejected: true, name: "AbortError" });
  await expect.poll(async () => (await serverState(request)).counters.streamCancellations).toBe(1);
});

test("rotates a session explicitly without re-attesting", async ({ page, request }, testInfo) => {
  const databaseName = testDatabase(testInfo.project.name, "refresh");
  await openHarness(page);
  await invoke<SafeDiagnostics>(page, "diagnostics", [databaseName]);
  await invoke<unknown>(page, "refresh", [databaseName]);
  const server = await serverState(request);
  expect(server.counters.refreshes).toBe(1);
  expect(server.counters.challenges).toBe(1);
  expect(server.counters.exchanges).toBe(1);
});

test("coordinates a forced refresh across two tabs with one IndexedDB lease", async ({ context, page, request }, testInfo) => {
  const databaseName = testDatabase(testInfo.project.name, "multitab");
  await openHarness(page);
  await invoke<SafeDiagnostics>(page, "diagnostics", [databaseName]);
  const secondPage = await context.newPage();
  await openHarness(secondPage);
  await invoke<unknown>(secondPage, "prepare", [databaseName]);
  await Promise.all([
    invoke<unknown>(page, "refresh", [databaseName]),
    invoke<unknown>(secondPage, "refresh", [databaseName]),
  ]);
  const server = await serverState(request);
  expect(server.counters.refreshes).toBe(1);
  expect(server.maximumConcurrentRefreshes).toBe(1);
});

test("fails closed when the gateway rejects the application origin", async ({ page, request }, testInfo) => {
  await setMode(request, { denyOrigin: true });
  await openHarness(page);
  const result = await invoke<SafeErrorResult>(page, "diagnosticsError", [
    testDatabase(testInfo.project.name, "origin-rejection"),
  ]);
  expect(result).toMatchObject({ rejected: true, code: "network_error" });
  const server = await serverState(request);
  expect(server.counters.preflights).toBeGreaterThan(0);
  expect(server.counters.challenges).toBe(0);
});

test("rejects an HTTP redirect before the authenticated request reaches its target", async ({ page, request }, testInfo) => {
  await setMode(request, { redirectChallenge: true });
  await openHarness(page);
  const result = await invoke<SafeErrorResult>(page, "diagnosticsError", [
    testDatabase(testInfo.project.name, "redirect"),
  ]);
  expect(result).toMatchObject({ rejected: true, code: "network_error" });
  expect((await serverState(request)).counters.redirectTargets).toBe(0);
});

test("recovers from cleared browser storage with a fresh key and session", async ({ context, page, request }, testInfo) => {
  const databaseName = testDatabase(testInfo.project.name, "storage-reset");
  await openHarness(page);
  await invoke<SafeDiagnostics>(page, "diagnostics", [databaseName]);
  const firstState = await serverState(request);
  await page.close();
  const freshPage = await context.newPage();
  await openHarness(freshPage);
  await invoke<unknown>(freshPage, "deletePersistence", [databaseName]);
  await invoke<SafeDiagnostics>(freshPage, "diagnostics", [databaseName]);
  const recovered = await serverState(request);
  expect(recovered.counters.challenges).toBe(2);
  expect(recovered.challengeJkts[1]).not.toBe(firstState.challengeJkts[0]);
});

test("runs the complete browser journey under a strict CSP without violations", async ({ page }, testInfo) => {
  const response = await openHarness(page);
  const policy = response?.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain(`connect-src 'self' ${gatewayOrigin}`);
  expect(policy).not.toContain("unsafe-inline");
  expect(policy).not.toContain("unsafe-eval");
  await invoke<SafeDiagnostics>(page, "diagnostics", [testDatabase(testInfo.project.name, "csp")]);
  expect(await invoke<string[]>(page, "cspViolations")).toEqual([]);
});

test("surfaces a canonical revoked-browser-component rejection", async ({ page, request }, testInfo) => {
  const databaseName = testDatabase(testInfo.project.name, "component-revoked");
  await openHarness(page);
  await invoke<SafeDiagnostics>(page, "diagnostics", [databaseName]);
  await setMode(request, { componentRevokedOnce: true });
  const result = await invoke<SafeErrorResult>(page, "streamError", [databaseName]);
  expect(result).toEqual({
    rejected: true,
    name: "LatchwayError",
    code: "component_revoked",
    requestID: "req_browser_conformance_0001",
    retryable: false,
    documentationURL: "https://docs.latchway.dev/errors/component-revoked",
  });
});

test("uses an expired-trust signal to perform a new challenge and exchange", async ({ page, request }, testInfo) => {
  const databaseName = testDatabase(testInfo.project.name, "expired-trust");
  await openHarness(page);
  await invoke<SafeDiagnostics>(page, "diagnostics", [databaseName]);
  await setMode(request, { refreshProblemOnce: "attestation_stale" });
  await invoke<unknown>(page, "refresh", [databaseName]);
  const server = await serverState(request);
  expect(server.counters.refreshes).toBe(1);
  expect(server.counters.challenges).toBe(2);
  expect(server.counters.exchanges).toBe(2);
});

test("safely refreshes and replays after a pre-dispatch session-expired response", async ({ page, request }, testInfo) => {
  const databaseName = testDatabase(testInfo.project.name, "session-expired");
  await openHarness(page);
  await invoke<SafeDiagnostics>(page, "diagnostics", [databaseName]);
  await setMode(request, { sessionExpiredOnce: true });
  const result = await invoke<{ output: string; requestID: string | null }>(page, "stream", [databaseName]);
  expect(result.output).toBe("data: first\n\ndata: second\n\n");
  const server = await serverState(request);
  expect(server.counters.refreshes).toBe(1);
  expect(server.counters.streamChunks).toBe(2);
});

test("rotates the installation key after explicit revocation", async ({ page, request }, testInfo) => {
  const databaseName = testDatabase(testInfo.project.name, "revocation");
  await openHarness(page);
  await invoke<SafeDiagnostics>(page, "diagnostics", [databaseName]);
  const first = await serverState(request);
  await invoke<unknown>(page, "revokeInstallation", [databaseName]);
  await invoke<SafeDiagnostics>(page, "diagnostics", [databaseName]);
  const second = await serverState(request);
  expect(second.counters.revocations).toBe(1);
  expect(second.counters.challenges).toBe(2);
  expect(second.challengeJkts[1]).not.toBe(first.challengeJkts[0]);
});

test("loads plain browser ESM with request IDs, safe diagnostics, and safe failure fields", async ({
  page, request,
}, testInfo) => {
  await openPlainESM(page);
  const result = await page.evaluate(async (databaseName) => {
    const root = window as unknown as {
      __latchwayPlainESM: { run(name: string): Promise<Record<string, unknown>> };
    };
    return root.__latchwayPlainESM.run(databaseName);
  }, testDatabase(testInfo.project.name, "plain-esm"));
  expect(result).toEqual({
    requestID: "req_browser_conformance_0001",
    output: "data: first\n\ndata: second\n\n",
    platform: "web",
    keyPersistence: "indexeddb",
    sessionPersistence: "indexeddb",
  });
  await setMode(request, { componentRevokedOnce: true });
  const failure = await page.evaluate(async (databaseName) => {
    const root = window as unknown as {
      __latchwayPlainESM: { runSafely(name: string): Promise<Record<string, unknown>> };
    };
    return root.__latchwayPlainESM.runSafely(databaseName);
  }, testDatabase(testInfo.project.name, "plain-esm"));
  expect(failure).toEqual({
    ok: false,
    error: {
      code: "component_revoked",
      requestID: "req_browser_conformance_0001",
      retryable: false,
      documentationURL: "https://docs.latchway.dev/errors/component-revoked",
    },
  });
});

async function invoke<T>(page: Page, method: string, args: unknown[] = []): Promise<T> {
  return page.evaluate(async ({ method: methodName, args: values }) => {
    const root = window as unknown as {
      __latchwayHarness: Record<string, (...input: unknown[]) => unknown>;
    };
    const operation = root.__latchwayHarness[methodName];
    if (operation === undefined) throw new Error(`Unknown harness operation: ${methodName}`);
    return operation(...values) as T | Promise<T>;
  }, { method, args });
}

async function openHarness(page: Page) {
  const response = await page.goto("/", { waitUntil: "commit" });
  await page.waitForFunction(() => Reflect.has(window, "__latchwayHarness"));
  return response;
}

async function openPlainESM(page: Page): Promise<void> {
  await page.goto("/plain-esm/", { waitUntil: "commit" });
  await page.waitForFunction(() => Reflect.has(window, "__latchwayPlainESM"));
}

async function setMode(request: APIRequestContext, mode: Readonly<Record<string, unknown>>): Promise<void> {
  const response = await request.post(`${gatewayOrigin}/__control/mode`, { data: mode });
  expect(response.ok()).toBe(true);
}

async function serverState(request: APIRequestContext): Promise<ServerState> {
  const response = await request.get(`${gatewayOrigin}/__control/state`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<ServerState>;
}

function testDatabase(browser: string, scenario: string): string {
  return `latchway-web-${browser}-${scenario}`.replace(/[^a-z0-9-]/giu, "-");
}
