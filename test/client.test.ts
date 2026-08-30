import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLatchwayClient, createCustomAttestationProvider, LatchwayError } from "../src/index.js";
import { createNodeLatchwayClient } from "../src/node.js";
import type { LatchwayClient, LatchwayFetchInit, LatchwayOptions, Platform } from "../src/types.js";
import { base64urlDecode, decodeUTF8 } from "../src/encoding.js";
import { jwkThumbprint, type P256PublicJWK } from "../src/dpop/key.js";

const identityToken = "identity-token-0123456789";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Latchway fetch client", () => {
  it("binds a reusable fetch to one feature and exact framework metadata", async () => {
    const gateway = new MockGateway();
    const client = makeBrowserClient(gateway, { mode: "memory" });
    const openAIFetch = client.fetchFor("assistant", { id: "openai-js", version: "7.8.0" });

    await openAIFetch("/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer framework-placeholder", "X-API-Key": "never-forward" },
      body: "{}",
    });

    expect(gateway.lastProtectedHeaders?.get("Authorization")).toMatch(/^DPoP /u);
    expect(gateway.lastProtectedHeaders?.get("X-API-Key")).toBeNull();
    expect(gateway.lastProtectedHeaders?.get("X-Latchway-Feature")).toBe("assistant");
    expect(gateway.lastProtectedHeaders?.get("X-Latchway-Protocol-Version")).toBe("2");
    expect(gateway.lastProtectedHeaders?.get("X-Latchway-Framework")).toBe("openai-js");
    expect(gateway.lastProtectedHeaders?.get("X-Latchway-Framework-Version")).toBe("7.8.0");
  });

  it("accepts only registry framework IDs and canonical SemVer metadata", async () => {
    const gateway = new MockGateway();
    const client = makeBrowserClient(gateway, { mode: "memory" });
    expect(() => client.fetchFor("assistant", {
      id: "openai-js",
      version: "7.8.0-beta.1+transport.2",
    })).not.toThrow();
    for (const framework of [
      { id: "caller-selected", version: "1.0.0" },
      { id: "swift-openai", version: "4.6.0" },
      { id: "openai-js", version: "01.0.0" },
      { id: "openai-js", version: "1.0.0-" },
    ]) {
      expect(() => client.fetchFor(
        "assistant",
        framework as Parameters<LatchwayClient["fetchFor"]>[1],
      )).toThrow(expect.objectContaining({ code: "client_configuration_invalid" }));
    }
    expect(gateway.challengeCalls).toBe(0);
  });

  it("strips caller-spoofed framework headers unless validated metadata replaces them", async () => {
    const gateway = new MockGateway();
    const client = makeBrowserClient(gateway, { mode: "memory" });
    await client.fetch("/v1/responses", {
      method: "POST",
      headers: {
        "X-Latchway-Framework": "openai-js",
        "X-Latchway-Framework-Version": "999.0.0",
      },
      body: "{}",
      latchwayFeature: "assistant",
    });
    expect(gateway.lastProtectedHeaders?.get("X-Latchway-Framework")).toBeNull();
    expect(gateway.lastProtectedHeaders?.get("X-Latchway-Framework-Version")).toBeNull();
  });

  it("rejects undeclared paths, method mismatches, and opaque-route feature confusion", async () => {
    const gateway = new MockGateway();
    const client = makeBrowserClient(gateway, { mode: "memory" });
    for (const [path, method] of [
      ["/v1/models", "GET"],
      ["/v1/responses", "GET"],
      ["/client/v1/diagnostics", "GET"],
      ["/proxy/other/files", "GET"],
      ["/proxy/assistant/files?destination=https://other.example", "GET"],
    ] as const) {
      await expect(client.fetch(path, { method, latchwayFeature: "assistant" })).rejects.toMatchObject({
        code: "transport_destination_not_allowed",
      });
    }
    expect(gateway.challengeCalls).toBe(0);
    await expect(client.fetch("/proxy/assistant/files", {
      method: "GET",
      latchwayFeature: "assistant",
    })).resolves.toMatchObject({ status: 200 });
  });

  it("authorizes every declared structured protocol and the feature-scoped opaque route", async () => {
    const gateway = new MockGateway();
    const client = makeBrowserClient(gateway, { mode: "memory" });
    for (const path of [
      "/v1/responses",
      "/v1/chat/completions",
      "/v1/embeddings",
      "/v1/messages",
    ]) {
      await expect(client.fetch(path, {
        method: "POST",
        body: "{}",
        latchwayFeature: "assistant",
      })).resolves.toMatchObject({ status: 200 });
    }
    await expect(client.fetch("/proxy/assistant/binary-object", {
      method: "GET",
      latchwayFeature: "assistant",
    })).resolves.toMatchObject({ status: 200 });
    expect(gateway.protectedCalls).toBe(5);
  });

  it("fails closed when a custom fetch reports a followed or cross-origin redirect", async () => {
    for (const destination of [
      { redirected: true, url: "http://gateway.example.test/v1/responses" },
      { redirected: false, url: "https://other.example/v1/responses" },
    ]) {
      const gateway = new MockGateway();
      gateway.protectedResponseDestination = destination;
      await expect(makeBrowserClient(gateway, { mode: "memory" }).fetch(
        "/v1/responses",
        { method: "POST", body: "{}", latchwayFeature: "assistant" },
      )).rejects.toMatchObject({ code: "transport_destination_not_allowed" });
      expect(gateway.protectedCalls).toBe(1);
    }
  });

  it("establishes a DPoP session, strips placeholder credentials, and preserves streaming", async () => {
    const gateway = new MockGateway();
    const before = globalThis.fetch;
    const client = makeBrowserClient(gateway, { mode: "memory" });
    const response = await client.fetch("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer latchway-managed",
        "X-API-Key": "must-not-leave-the-client",
        "Anthropic-Api-Key": "must-also-not-leave-the-client",
        "X-Amz-Security-Token": "must-also-not-leave-the-client",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ stream: true }),
      latchwayFeature: "assistant",
    });
    expect(response.body).not.toBeNull();
    await expect(response.text()).resolves.toBe("data: first\n\ndata: [DONE]\n\n");
    expect(gateway.challengeCalls).toBe(1);
    expect(gateway.exchangeCalls).toBe(1);
    expect(gateway.lastProtectedHeaders?.get("Authorization")).toMatch(/^DPoP /u);
    expect(gateway.lastProtectedHeaders?.get("DPoP")).toBeTruthy();
    expect(gateway.lastProtectedHeaders?.get("X-API-Key")).toBeNull();
    expect(gateway.lastProtectedHeaders?.get("Anthropic-Api-Key")).toBeNull();
    expect(gateway.lastProtectedHeaders?.get("X-Amz-Security-Token")).toBeNull();
    expect(gateway.lastProtectedHeaders?.get("X-Latchway-Feature")).toBe("assistant");
    expect(gateway.lastProtectedHeaders?.get("X-Latchway-SDK")).toBe("javascript");
    expect(globalThis.fetch).toBe(before);
  });

  it("rejects provider credentials in query names before session or network work", async () => {
    const gateway = new MockGateway();
    const client = makeBrowserClient(gateway, { mode: "memory" });
    const forbiddenNames = [
      "authorization", "proxy-authorization", "access_token", "api-key", "api_key", "apikey",
      "x-api-key", "openai-api-key", "openai_api_key", "x-openai-api-key", "anthropic-api-key",
      "anthropic_api_key", "x-goog-api-key", "x-goog_api_key", "auth_token", "x-auth-token",
      "cookie", "key", "token", "x-amz-credential", "x-amz-security-token", "x-amz-signature",
      "x-goog-credential", "x-goog-signature",
    ];
    for (const name of forbiddenNames) {
      await expect(client.fetch(`/v1/responses?${name.toUpperCase()}=provider-secret`, {
        method: "POST",
        body: "{}",
        latchwayFeature: "assistant",
      })).rejects.toMatchObject({ code: "request_invalid" });
    }
    await expect(client.fetch("/v1/responses?api%5Fkey=provider-secret", {
      method: "POST",
      body: "{}",
      latchwayFeature: "assistant",
    })).rejects.toMatchObject({ code: "request_invalid" });
    expect(gateway.challengeCalls).toBe(0);
    expect(gateway.protectedCalls).toBe(0);

    await expect(client.fetch("/v1/responses?model=gpt-5&stream=true", {
      method: "POST",
      body: "{}",
      latchwayFeature: "assistant",
    })).resolves.toMatchObject({ status: 200 });
  });

  it("uses a fresh proof for one DPoP nonce retry", async () => {
    const gateway = new MockGateway();
    gateway.requireNonceOnce = true;
    const client = makeBrowserClient(gateway, { mode: "memory" });
    const response = await client.fetch("/v1/responses", {
      method: "POST",
      body: "{}",
      latchwayFeature: "assistant",
    });
    expect(response.status).toBe(200);
    expect(gateway.protectedCalls).toBe(2);
    expect(gateway.protectedProofs[0]).not.toBe(gateway.protectedProofs[1]);
    expect(decodePayload(gateway.protectedProofs[1] ?? "").nonce).toBe(MockGateway.nonce);
  });

  it("fails closed instead of buffering or replaying a streaming request body", async () => {
    const gateway = new MockGateway();
    gateway.requireNonceOnce = true;
    const client = makeBrowserClient(gateway, { mode: "memory" });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    await expect(client.fetch("/v1/responses", {
      method: "POST",
      body,
      duplex: "half",
      latchwayFeature: "assistant",
    } as LatchwayFetchInitWithDuplex)).rejects.toMatchObject({
      code: "transport_request_not_replayable",
    });
    expect(gateway.protectedCalls).toBe(1);
  });

  it("accepts component-aware root grants and preserves them across rotation", async () => {
    const gateway = new MockGateway();
    gateway.componentAware = true;
    const client = makeBrowserClient(gateway, { mode: "memory" });
    await client.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" });
    await client.refresh();
    expect(gateway.exchangeCalls).toBe(1);
    expect(gateway.refreshCalls).toBe(1);
    expect(gateway.protectedCalls).toBe(1);
  });

  it("rejects unpaired family state and non-root sessions without explicit delegation provenance", async () => {
    const unpaired = new MockGateway();
    unpaired.componentAware = true;
    unpaired.omitComponentSummary = true;
    await expect(makeBrowserClient(unpaired, { mode: "memory" }).fetch(
      "/v1/responses",
      { method: "POST", body: "{}", latchwayFeature: "assistant" },
    )).rejects.toMatchObject({ code: "protocol_response_invalid" });

    const missingProvenance = new MockGateway();
    missingProvenance.componentAware = true;
    missingProvenance.componentIsRoot = false;
    await expect(makeBrowserClient(missingProvenance, { mode: "memory" }).fetch(
      "/v1/responses",
      { method: "POST", body: "{}", latchwayFeature: "assistant" },
    )).rejects.toMatchObject({ code: "protocol_response_invalid" });

    const delegatedRoot = new MockGateway();
    delegatedRoot.componentAware = true;
    delegatedRoot.trustSource = "delegated_from_attested_root";
    await expect(makeBrowserClient(delegatedRoot, { mode: "memory" }).fetch(
      "/v1/responses",
      { method: "POST", body: "{}", latchwayFeature: "assistant" },
    )).rejects.toMatchObject({ code: "protocol_response_invalid" });
  });

  it("provisions only a child public key and supports scoped component and family revocation", async () => {
    const gateway = new MockGateway();
    gateway.componentAware = true;
    const client = makeBrowserClient(gateway, { mode: "memory" });

    const provisioned = await client.provisionComponent({
      componentDefinitionID: "summary_worker",
      publicJWK: { kty: "EC", crv: "P-256", x: "x".repeat(43), y: "y".repeat(43) },
      requestedFeatures: ["weekly_summary"],
      appVersion: "2.0.0",
    });
    expect(provisioned).toMatchObject({
      componentID: `cmp_${"d".repeat(20)}`,
      installationFamilyID: `fam_${"f".repeat(20)}`,
      grantedFeatures: ["weekly_summary"],
      trust: { source: "delegated_from_attested_root" },
    });
    expect(gateway.provisionBodies).toEqual([{
      component_definition_id: "summary_worker",
      public_jwk: { kty: "EC", crv: "P-256", x: "x".repeat(43), y: "y".repeat(43) },
      requested_features: ["weekly_summary"],
      client_metadata: { app_version: "2.0.0", sdk_version: "1.0.0" },
    }]);

    await client.revokeComponent(provisioned.componentID);
    expect(gateway.revokedComponents).toEqual([provisioned.componentID]);
    await client.revokeCurrentInstallationFamily();
    expect(gateway.familyRevokeCalls).toBe(1);

    await client.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" });
    expect(gateway.challengeCalls).toBe(2);
  });

  it("rejects private or malformed child key material before session work", async () => {
    const gateway = new MockGateway();
    const client = makeBrowserClient(gateway, { mode: "memory" });
    await expect(client.provisionComponent({
      componentDefinitionID: "summary_worker",
      publicJWK: {
        kty: "EC", crv: "P-256", x: "x".repeat(43), y: "y".repeat(43),
        d: "private-material",
      } as never,
      requestedFeatures: ["weekly_summary"],
    })).rejects.toMatchObject({ code: "client_configuration_invalid" });
    expect(gateway.challengeCalls).toBe(0);
  });

  it("does not retry ambiguous nonces or nonce-bearing session expiry", async () => {
    const ambiguous = new MockGateway();
    ambiguous.requireNonceOnce = true;
    ambiguous.nonceResponse = `${MockGateway.nonce},${MockGateway.nonce}`;
    const ambiguousResponse = await makeBrowserClient(ambiguous, { mode: "memory" }).fetch(
      "/v1/responses",
      { method: "POST", body: "{}", latchwayFeature: "assistant" },
    );
    expect(ambiguousResponse.status).toBe(401);
    expect(ambiguous.protectedCalls).toBe(1);

    const expired = new MockGateway();
    expired.expireSessionOnce = true;
    const expiredResponse = await makeBrowserClient(expired, { mode: "memory" }).fetch(
      "/v1/responses",
      { method: "POST", body: "{}", latchwayFeature: "assistant" },
    );
    expect(expiredResponse.status).toBe(401);
    expect(expired.protectedCalls).toBe(1);
    expect(expired.refreshCalls).toBe(0);
  });

  it("single-flights refreshes within one client", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const gateway = new MockGateway(() => now);
    const client = makeBrowserClient(gateway, { mode: "memory" });
    await client.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" });
    now += 31_000;
    await Promise.all(Array.from({ length: 12 }, () =>
      client.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" })));
    expect(gateway.refreshCalls).toBe(1);
    expect(gateway.refreshBodies).toHaveLength(1);
    expect(Object.keys(gateway.refreshBodies[0] ?? {})).toEqual(["refresh_token"]);
  });

  it("exposes explicit rotation without returning either credential", async () => {
    const gateway = new MockGateway();
    const client = makeBrowserClient(gateway, { mode: "memory" });
    await client.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" });
    await expect(client.refresh()).resolves.toBeUndefined();
    expect(gateway.refreshCalls).toBe(1);
    expect(Object.keys(gateway.refreshBodies[0] ?? {})).toEqual(["refresh_token"]);
  });

  it("starts a fresh challenge when refresh requires renewed attestation", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const gateway = new MockGateway(() => now);
    gateway.staleRefreshOnce = true;
    const client = makeBrowserClient(gateway, { mode: "memory" });
    await client.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" });
    now += 31_000;
    await client.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" });
    expect(gateway.refreshCalls).toBe(1);
    expect(gateway.challengeCalls).toBe(2);
    expect(gateway.exchangeCalls).toBe(2);
  });

  it("starts a fresh challenge when refresh requires renewed identity", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const gateway = new MockGateway(() => now);
    gateway.identityRefreshOnce = true;
    const client = makeBrowserClient(gateway, { mode: "memory" });
    await client.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" });
    now += 31_000;
    await client.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" });
    expect(gateway.refreshCalls).toBe(1);
    expect(gateway.challengeCalls).toBe(2);
    expect(gateway.exchangeCalls).toBe(2);
  });

  it("rejects application slugs before identity or network work", () => {
    const gateway = new MockGateway();
    expect(() => createLatchwayClient({
      ...baseOptions(gateway),
      applicationID: "mobile-app",
      persistence: { mode: "memory" },
      attestationProviders: [debugProvider()],
    })).toThrowError(/generated Latchway application resource ID/u);
    expect(gateway.challengeCalls).toBe(0);
  });

  it("coordinates refresh-token rotation between IndexedDB-backed tabs", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("indexedDB", new IDBFactory());
    const gateway = new MockGateway(() => now);
    const databaseName = `latchway-test-${crypto.randomUUID()}`;
    const first = makeBrowserClient(gateway, { mode: "required", databaseName });
    await first.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" });
    const second = makeBrowserClient(gateway, { mode: "required", databaseName });
    now += 31_000;
    await Promise.all([
      first.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" }),
      second.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" }),
    ]);
    expect(gateway.refreshCalls).toBe(1);
  });

  it("requires explicit consent before falling back from IndexedDB to memory", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const required = makeBrowserClient(new MockGateway(), { mode: "required" });
    await expect(required.fetch("/v1/responses", {
      method: "POST",
      body: "{}",
      latchwayFeature: "assistant",
    })).rejects.toMatchObject({ code: "storage_unavailable" });

    const allowed = makeBrowserClient(new MockGateway(), { mode: "allow-memory" });
    await expect(allowed.fetch("/v1/responses", {
      method: "POST",
      body: "{}",
      latchwayFeature: "assistant",
    })).resolves.toBeInstanceOf(Response);
    await expect(allowed.diagnostics()).resolves.toMatchObject({
      client: { keyPersistence: "memory", sessionPersistence: "memory" },
    });

    vi.stubGlobal("indexedDB", {
      open() {
        throw new DOMException("storage blocked", "SecurityError");
      },
    } as unknown as IDBFactory);
    const failedButAllowed = makeBrowserClient(new MockGateway(), { mode: "allow-memory" });
    await expect(failedButAllowed.fetch("/v1/responses", {
      method: "POST",
      body: "{}",
      latchwayFeature: "assistant",
    })).resolves.toBeInstanceOf(Response);
  });

  it("preserves cancellation after authorization", async () => {
    const gateway = new MockGateway();
    const client = makeBrowserClient(gateway, { mode: "memory" });
    await client.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" });
    const controller = new AbortController();
    const pending = client.fetch("/v1/responses", {
      method: "POST",
      body: JSON.stringify({ input: "slow" }),
      signal: controller.signal,
      latchwayFeature: "assistant",
    });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("maps quota and diagnostics while keeping the Node trust claim bounded", async () => {
    const gateway = new MockGateway();
    const browser = makeBrowserClient(gateway, { mode: "memory" });
    await expect(browser.quota("assistant")).resolves.toMatchObject({
      feature: "assistant",
      limits: [{ metric: "requests", remaining: 9 }],
    });
    await expect(browser.diagnostics()).resolves.toMatchObject({
      server: { contract_version: "1.0.0", protocol_version: 2 },
      client: { platform: "web", clockOffsetMilliseconds: expect.any(Number) },
    });

    const nodeGateway = new MockGateway();
    const node = createNodeLatchwayClient({
      ...baseOptions(nodeGateway),
      attestationProviders: [debugProvider()],
    });
    await node.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" });
    expect(nodeGateway.platform).toBe("node");
  });

  it("revokes local installation state only after server confirmation", async () => {
    const gateway = new MockGateway();
    const client = makeBrowserClient(gateway, { mode: "memory" });
    await client.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" });
    await client.revokeCurrentInstallation();
    expect(gateway.revokeCalls).toBe(1);
    await client.fetch("/v1/responses", { method: "POST", body: "{}", latchwayFeature: "assistant" });
    expect(gateway.challengeCalls).toBe(2);
  });

  it("rejects malformed challenge and mismatched installation bindings", async () => {
    const malformed = new MockGateway();
    malformed.omitClientDataHash = true;
    await expect(makeBrowserClient(malformed, { mode: "memory" }).fetch("/v1/responses", {
      method: "POST",
      body: "{}",
      latchwayFeature: "assistant",
    })).rejects.toMatchObject({ code: "protocol_response_invalid" });
    expect(malformed.exchangeCalls).toBe(0);

    const mismatched = new MockGateway();
    mismatched.mismatchJkt = true;
    await expect(makeBrowserClient(mismatched, { mode: "memory" }).fetch("/v1/responses", {
      method: "POST",
      body: "{}",
      latchwayFeature: "assistant",
    })).rejects.toMatchObject({ code: "protocol_response_invalid" });
  });

  it("rejects cross-origin signing and consumed bodies", async () => {
    const client = makeBrowserClient(new MockGateway(), { mode: "memory" });
    await expect(client.authorize(new Request("https://other.example/v1/responses"), "assistant"))
      .rejects.toBeInstanceOf(LatchwayError);
    const request = new Request("http://gateway.example.test/v1/responses", { method: "POST", body: "{}" });
    await request.text();
    await expect(client.authorize(request, "assistant")).rejects.toMatchObject({
      code: "transport_request_not_replayable",
    });
  });
});

type LatchwayFetchInitWithDuplex = LatchwayFetchInit & { duplex: "half" };

function makeBrowserClient(gateway: MockGateway, persistence: NonNullable<LatchwayOptions["persistence"]>): LatchwayClient {
  return createLatchwayClient({
    ...baseOptions(gateway),
    persistence,
    attestationProviders: [debugProvider()],
  });
}

function baseOptions(gateway: MockGateway): Omit<LatchwayOptions, "attestationProviders"> {
  return {
    baseURL: "http://gateway.example.test",
    applicationID: "app_01J00000000000000000000000",
    environment: "test",
    identityProvider: "custom_jwt",
    identityTokenProvider: { getIdentityToken: async () => identityToken },
    installation: { appVersion: "1.2.3" },
    allowInsecureHTTP: true,
    fetch: gateway.fetch,
  };
}

function debugProvider() {
  return createCustomAttestationProvider({
    provider: "debug",
    getEvidence: async (context) => ({
      challenge_token: `test-only-${context.challenge.challenge_id}`,
      client_data_hash: context.challenge.attestation.client_data_hash,
    }),
  });
}

class MockGateway {
  static readonly nonce = "nonce-required-0123456789abcdef";
  challengeCalls = 0;
  exchangeCalls = 0;
  refreshCalls = 0;
  protectedCalls = 0;
  revokeCalls = 0;
  familyRevokeCalls = 0;
  requireNonceOnce = false;
  nonceResponse = MockGateway.nonce;
  expireSessionOnce = false;
  omitClientDataHash = false;
  mismatchJkt = false;
  staleRefreshOnce = false;
  identityRefreshOnce = false;
  componentAware = false;
  componentIsRoot = true;
  omitComponentSummary = false;
  trustSource: "debug" | "delegated_from_attested_root" = "debug";
  refreshBodies: Array<Record<string, unknown>> = [];
  provisionBodies: Array<Record<string, unknown>> = [];
  revokedComponents: string[] = [];
  lastProtectedHeaders: Headers | undefined;
  protectedProofs: string[] = [];
  protectedResponseDestination: { redirected: boolean; url: string } | undefined;
  platform: Platform = "web";
  private jkt = "";
  private nonceIssued = false;
  private sessionExpirationIssued = false;
  private generation = 0;

  constructor(private readonly now: () => number = Date.now) {}

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/client/v1/session-challenges") {
      this.challengeCalls += 1;
      const challengeProof = request.headers.get("DPoP");
      expect(challengeProof).toBeTruthy();
      expect(request.headers.get("Authorization")).toBeNull();
      const header = decodeHeader(challengeProof ?? "");
      this.jkt = await jwkThumbprint(globalThis.crypto, header.jwk);
      const body = await request.json() as { platform: Platform };
      this.platform = body.platform;
      return this.json({
        challenge_id: `chl_${"a".repeat(20)}`,
        challenge_nonce: "b".repeat(43),
        binding_version: 1,
        issued_at: Math.floor(this.now() / 1_000),
        expires_at: new Date(this.now() + 300_000).toISOString(),
        attestation: {
          provider: "debug",
          mode: "required",
          ...(this.omitClientDataHash ? {} : { client_data_hash: "c".repeat(43) }),
        },
      }, 201);
    }
    if (url.pathname === "/client/v1/sessions") {
      this.exchangeCalls += 1;
      return this.grant(201);
    }
    if (url.pathname === "/client/v1/sessions/refresh") {
      this.refreshCalls += 1;
      const body = await request.json() as Record<string, unknown>;
      this.refreshBodies.push(body);
      if (this.staleRefreshOnce) {
        this.staleRefreshOnce = false;
        return this.problem("attestation_stale", 401);
      }
      if (this.identityRefreshOnce) {
        this.identityRefreshOnce = false;
        return this.problem("identity_reauthentication_required", 401);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 15);
      });
      return this.grant(200);
    }
    if (url.pathname === "/client/v1/features/assistant/quota") {
      return this.json({
        feature: "assistant",
        observed_at: new Date(this.now()).toISOString(),
        limits: [{ metric: "requests", maximum: 10, used: 1, reserved: 0, remaining: 9, hard: true }],
      });
    }
    if (url.pathname === "/client/v1/diagnostics") {
      return this.json({
        request_id: "req_12345678",
        server_version: "0.1.0",
        contract_version: "1.0.0",
        protocol_version: 2,
        installation: this.installation(),
        session: { expires_at: new Date(this.now() + 60_000).toISOString(), refresh_available: true },
        trust: this.trust(),
      });
    }
    if (url.pathname === "/client/v1/installation-families/current/components" && request.method === "POST") {
      this.provisionBodies.push(await request.json() as Record<string, unknown>);
      const expiresAt = new Date(this.now() + 300_000).toISOString();
      return this.json({
        component_id: `cmp_${"d".repeat(20)}`,
        installation_family_id: `fam_${"f".repeat(20)}`,
        trust: { source: "delegated_from_attested_root", expires_at: expiresAt },
        granted_features: ["weekly_summary"],
        refresh_grant: `crf_${"g".repeat(40)}`,
        refresh_grant_expires_at: expiresAt,
      }, 201);
    }
    if (url.pathname.startsWith("/client/v1/installation-families/current/components/") &&
        request.method === "DELETE") {
      this.revokedComponents.push(decodeURIComponent(url.pathname.split("/").at(-1) ?? ""));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/client/v1/installation-families/current" && request.method === "DELETE") {
      this.familyRevokeCalls += 1;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/client/v1/installations/current") {
      this.revokeCalls += 1;
      return new Response(null, { status: 204 });
    }
    this.protectedCalls += 1;
    this.lastProtectedHeaders = new Headers(request.headers);
    const proof = request.headers.get("DPoP") ?? "";
    this.protectedProofs.push(proof);
    if (this.expireSessionOnce && !this.sessionExpirationIssued) {
      this.sessionExpirationIssued = true;
      return this.problem("session_expired", 401, { "DPoP-Nonce": MockGateway.nonce });
    }
    if (this.requireNonceOnce && !this.nonceIssued) {
      this.nonceIssued = true;
      return this.problem("dpop_nonce_required", 401, { "DPoP-Nonce": this.nonceResponse });
    }
    if (this.nonceIssued && decodePayload(proof).nonce !== MockGateway.nonce) {
      return this.problem("dpop_invalid", 401);
    }
    if (this.protectedResponseDestination !== undefined) {
      const response = this.json({ ok: true });
      Object.defineProperties(response, {
        redirected: { value: this.protectedResponseDestination.redirected },
        url: { value: this.protectedResponseDestination.url },
      });
      return response;
    }
    if (url.pathname === "/slow") {
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          reject(request.signal.reason);
        }, { once: true });
      });
    }
    if (url.pathname === "/v1/chat/completions") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return this.json({ ok: true });
  };

  private grant(status: number): Response {
    this.generation += 1;
    return this.json({
      access_token: `access-${this.generation}-${"a".repeat(70)}`,
      token_type: "DPoP",
      expires_in: 60,
      refresh_token: `refresh-${this.generation}-${"r".repeat(40)}`,
      refresh_expires_in: 3_600,
      installation: this.installation(),
      ...(this.componentAware ? {
        installation_family: { id: `fam_${"f".repeat(20)}`, status: "active" },
        ...(this.omitComponentSummary ? {} : { component: {
          id: `cmp_${"c".repeat(20)}`,
          definition_id: "web_root",
          kind: "browser",
          platform: this.platform,
          is_root: this.componentIsRoot,
          status: "active",
          dpop_jkt: this.jkt,
          granted_features: ["assistant"],
        } }),
      } : {}),
      trust: this.trust(),
    }, status);
  }

  private installation() {
    return {
      id: `ins_${"i".repeat(20)}`,
      platform: this.platform,
      dpop_jkt: this.mismatchJkt ? "z".repeat(43) : this.jkt,
      status: "active",
    };
  }

  private trust() {
    return {
      provider: "debug",
      level: "debug",
      verified_at: new Date(this.now()).toISOString(),
      expires_at: new Date(this.now() + 300_000).toISOString(),
      ...(this.componentAware ? { source: this.trustSource } : {}),
    };
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        Date: new Date(this.now() + 10_000).toUTCString(),
        "X-Latchway-Request-ID": "req_12345678",
      },
    });
  }

  private problem(code: string, status: number, extraHeaders: HeadersInit = {}): Response {
    const policy = {
      attestation_stale: { title: "Attestation stale", retryable: false },
      identity_reauthentication_required: { title: "Identity reauthentication required", retryable: false },
      dpop_invalid: { title: "DPoP proof invalid", retryable: false },
      dpop_nonce_required: { title: "DPoP nonce required", retryable: true },
      session_expired: { title: "Session expired", retryable: true },
    }[code];
    if (policy === undefined) throw new Error(`Missing test problem policy for ${code}.`);
    return new Response(JSON.stringify({
      type: `https://latchway.dev/problems/${code}`,
      title: policy.title,
      status,
      detail: "The request was rejected before upstream dispatch.",
      code,
      request_id: "req_12345678",
      retryable: policy.retryable,
    }), {
      status,
      headers: {
        "Content-Type": "application/problem+json",
        "X-Latchway-Request-ID": "req_12345678",
        ...Object.fromEntries(new Headers(extraHeaders)),
      },
    });
  }
}

function decodePayload(proof: string): Record<string, unknown> {
  const payload = proof.split(".")[1];
  if (payload === undefined) throw new Error("Missing DPoP payload.");
  return JSON.parse(decodeUTF8(base64urlDecode(payload))) as Record<string, unknown>;
}

function decodeHeader(proof: string): { jwk: P256PublicJWK } {
  const header = proof.split(".")[0];
  if (header === undefined) throw new Error("Missing DPoP header.");
  return JSON.parse(decodeUTF8(base64urlDecode(header))) as { jwk: P256PublicJWK };
}
