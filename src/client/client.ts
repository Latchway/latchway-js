import { errorFromResponse, LatchwayError } from "../errors.js";
import { assertAllowedDataPlaneTarget, clientPaths } from "../contract.js";
import { readBoundedJSON } from "../json.js";
import { SessionManager } from "../session/manager.js";
import { isRecord } from "../session/wire.js";
import type {
  Diagnostics,
  FetchImplementation,
  FrameworkMetadata,
  LatchwayClient,
  LatchwayFetchInit,
  ProvisionComponentOptions,
  ProvisionedComponent,
  QuotaLimit,
  QuotaSnapshot,
  ServerDiagnostics,
} from "../types.js";
import { CONTRACT_VERSION, PROTOCOL_VERSION, SDK_KIND, SDK_VERSION } from "../version.js";
import type { RuntimeConfiguration } from "./config.js";

const forbiddenCredentialHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "api-key",
  "api_key",
  "apikey",
  "x-api-key",
  "openai-api-key",
  "openai_api_key",
  "x-openai-api-key",
  "anthropic-api-key",
  "anthropic_api_key",
  "x-goog-api-key",
  "x-goog_api_key",
  "access_token",
  "auth_token",
  "x-auth-token",
  "cookie",
  "key",
  "token",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-signature",
  "x-goog-credential",
  "x-goog-signature",
]);

const forbiddenCredentialQueryNames = forbiddenCredentialHeaders;
const frameworkIDs = new Set<FrameworkMetadata["id"]>([
  "langchain-js", "openai-js", "vercel-ai-sdk",
]);
const canonicalSemver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export class DefaultLatchwayClient implements LatchwayClient {
  private readonly sessions: SessionManager;
  readonly gatewayURL: string;

  constructor(private readonly config: RuntimeConfiguration) {
    this.sessions = new SessionManager(config);
    this.gatewayURL = config.baseURL.origin;
  }

  async fetch(input: RequestInfo | URL, init: LatchwayFetchInit = {}): Promise<Response> {
    const { latchwayFeature, latchwayFramework, ...requestInit } = init;
    const request = this.createRequest(input, requestInit);
    const feature = latchwayFeature ?? request.headers.get("X-Latchway-Feature") ?? undefined;
    assertFeature(feature);
    const framework = validateFrameworkMetadata(latchwayFramework);
    this.assertDataPlaneTarget(request.url, request.method, feature);
    if (request.bodyUsed) {
      throw new LatchwayError("transport_request_not_replayable", "The request body has already been consumed.");
    }
    const replayable = isReplayableInput(input, requestInit, request);
    const template = this.sanitize(request);
    let nonceRetried = false;
    let sessionRetried = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outbound = await this.authorize(template.clone(), feature, framework);
      let response: Response;
      try {
        response = await this.config.fetch(outbound);
      } catch (cause) {
        if (outbound.signal.aborted) throw abortReason(outbound.signal);
        throw new LatchwayError("network_error", "The authorized Latchway request failed.", {
          retryable: true,
          cause,
        });
      }
      this.assertResponseDestination(response);
      if (response.ok) {
        this.sessions.recordNonce(response.headers.get("DPoP-Nonce"));
        return response;
      }
      if (!isLatchwayProblem(response)) return response;
      const error = await errorFromResponse(response.clone());
      if (!nonceRetried && error.code === "dpop_nonce_required" &&
          this.sessions.recordNonce(response.headers.get("DPoP-Nonce"))) {
        if (!replayable) {
          await response.body?.cancel();
          throw new LatchwayError(
            "transport_request_not_replayable",
            "Latchway rejected the request before dispatch, but its body cannot be replayed safely.",
            { status: response.status, requestID: error.requestID },
          );
        }
        await response.body?.cancel();
        nonceRetried = true;
        continue;
      }
      if (!sessionRetried && error.code === "session_expired" &&
          response.headers.get("DPoP-Nonce") === null) {
        if (!replayable) {
          await response.body?.cancel();
          throw new LatchwayError(
            "transport_request_not_replayable",
            "The expired session was rejected before dispatch, but the request body cannot be replayed safely.",
            { status: response.status, requestID: error.requestID },
          );
        }
        await response.body?.cancel();
        await abortable(this.sessions.refresh(), template.signal);
        sessionRetried = true;
        continue;
      }
      return response;
    }
    throw new LatchwayError("protocol_response_invalid", "Latchway exhausted the safe request retry path.");
  }

  fetchFor(feature: string, framework?: FrameworkMetadata): FetchImplementation {
    assertFeature(feature);
    const metadata = validateFrameworkMetadata(framework);
    return (input, init) => this.fetch(input, {
      ...init,
      latchwayFeature: feature,
      ...(metadata === undefined ? {} : { latchwayFramework: metadata }),
    });
  }

  async authorize(request: Request, feature: string, framework?: FrameworkMetadata): Promise<Request> {
    assertFeature(feature);
    const metadata = validateFrameworkMetadata(framework);
    this.assertDataPlaneTarget(request.url, request.method, feature);
    if (request.bodyUsed) {
      throw new LatchwayError("transport_request_not_replayable", "The request body has already been consumed.");
    }
    const session = await abortable(this.sessions.session(), request.signal);
    const headers = this.sanitizeHeaders(request.headers);
    headers.set("Authorization", `DPoP ${session.accessToken}`);
    headers.set("DPoP", await this.sessions.proof(request.method, request.url, session.accessToken));
    headers.set("X-Latchway-Feature", feature);
    this.addProtocolHeaders(headers, metadata);
    return new Request(request, { headers, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
  }

  async quota(feature: string): Promise<QuotaSnapshot> {
    assertFeature(feature);
    const response = await this.sendControl("GET", clientPaths.featureQuota(feature), feature);
    return parseQuota(await safeJSON(response));
  }

  async refresh(): Promise<void> {
    await this.sessions.refresh();
  }

  async provisionComponent(options: ProvisionComponentOptions): Promise<ProvisionedComponent> {
    const request = validateProvisionComponentOptions(options, this.config.installation.appVersion);
    const response = await this.sendControl("POST", clientPaths.provisionComponent, undefined, request);
    return parseProvisionedComponent(await safeJSON(response));
  }

  async revokeComponent(componentID: string): Promise<void> {
    assertComponentID(componentID);
    await this.expectNoContent(
      await this.sendControl("DELETE", clientPaths.component(componentID)),
      "component revocation",
    );
  }

  async revokeCurrentInstallationFamily(): Promise<void> {
    await this.expectNoContent(
      await this.sendControl("DELETE", clientPaths.revokeCurrentInstallationFamily),
      "Installation Family revocation",
    );
    await this.sessions.clearInstallation();
  }

  async revokeCurrentInstallation(): Promise<void> {
    await this.expectNoContent(
      await this.sendControl("DELETE", clientPaths.revokeCurrentInstallation),
      "installation revocation",
    );
    await this.sessions.clearInstallation();
  }

  async diagnostics(): Promise<Diagnostics> {
    const response = await this.sendControl("GET", clientPaths.diagnostics);
    return {
      server: parseDiagnostics(await safeJSON(response)),
      client: {
        sdkVersion: SDK_VERSION,
        contractVersion: CONTRACT_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        platform: this.config.platform,
        keyPersistence: this.sessions.persistenceKind,
        sessionPersistence: this.sessions.persistenceKind,
        clockOffsetMilliseconds: this.sessions.clockOffset,
      },
    };
  }

  private async sendControl(
    method: string,
    path: string,
    feature?: string,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<Response> {
    const url = new URL(path, this.config.baseURL);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && serialized.length > 131_072) {
      throw new LatchwayError("client_configuration_invalid", "The component request exceeds the SDK safety limit.");
    }
    let nonceRetried = false;
    let sessionRetried = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = await this.sessions.session();
      const headers = new Headers();
      headers.set("Authorization", `DPoP ${session.accessToken}`);
      headers.set("DPoP", await this.sessions.proof(method, url, session.accessToken));
      if (feature !== undefined) headers.set("X-Latchway-Feature", feature);
      if (serialized !== undefined) headers.set("Content-Type", "application/json");
      this.addProtocolHeaders(headers);
      let response: Response;
      try {
        response = await this.config.fetch(url, {
          method,
          headers,
          ...(serialized === undefined ? {} : { body: serialized }),
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
      } catch (cause) {
        throw new LatchwayError("network_error", "The Latchway control request failed.", { retryable: true, cause });
      }
      this.assertResponseDestination(response);
      if (response.ok) {
        this.sessions.recordNonce(response.headers.get("DPoP-Nonce"));
        return response;
      }
      const error = await errorFromResponse(response);
      if (!nonceRetried && error.code === "dpop_nonce_required" &&
          this.sessions.recordNonce(response.headers.get("DPoP-Nonce"))) {
        nonceRetried = true;
        continue;
      }
      if (!sessionRetried && error.code === "session_expired" &&
          response.headers.get("DPoP-Nonce") === null) {
        await this.sessions.refresh();
        sessionRetried = true;
        continue;
      }
      throw error;
    }
    throw new LatchwayError("protocol_response_invalid", "Latchway exhausted the safe control-request retry path.");
  }

  private async expectNoContent(response: Response, operation: string): Promise<void> {
    if (response.status !== 204 || response.body !== null) {
      await response.body?.cancel();
      throw new LatchwayError(
        "protocol_response_invalid",
        `Latchway did not confirm ${operation}.`,
        { status: response.status },
      );
    }
  }

  private createRequest(input: RequestInfo | URL, init: RequestInit): Request {
    if (input instanceof Request) return new Request(input, init);
    const resolved = input instanceof URL ? input : new URL(input, this.config.baseURL);
    return new Request(resolved, init);
  }

  private sanitize(request: Request): Request {
    return new Request(request, { headers: this.sanitizeHeaders(request.headers) });
  }

  private sanitizeHeaders(source: Headers): Headers {
    const headers = new Headers(source);
    for (const name of forbiddenCredentialHeaders) headers.delete(name);
    // Framework identity is runtime-owned metadata. Never preserve a caller's
    // raw pair when no validated adapter binding was supplied.
    headers.delete("X-Latchway-Framework");
    headers.delete("X-Latchway-Framework-Version");
    return headers;
  }

  private addProtocolHeaders(headers: Headers, framework?: FrameworkMetadata): void {
    headers.set("X-Latchway-Protocol-Version", String(PROTOCOL_VERSION));
    headers.set("X-Latchway-SDK", SDK_KIND);
    headers.set("X-Latchway-SDK-Version", SDK_VERSION);
    if (framework !== undefined) {
      headers.set("X-Latchway-Framework", framework.id);
      headers.set("X-Latchway-Framework-Version", framework.version);
    }
  }

  private assertGatewayTarget(input: string): URL {
    const target = new URL(input);
    if (target.origin !== this.config.baseURL.origin) {
      throw new LatchwayError(
        "transport_destination_not_allowed",
        "Latchway only authorizes requests to the configured gateway origin.",
      );
    }
    for (const name of target.searchParams.keys()) {
      if (forbiddenCredentialQueryNames.has(name.toLowerCase())) {
        throw new LatchwayError(
          "request_invalid",
          "Upstream provider credentials must not be supplied in the request URL.",
        );
      }
    }
    return target;
  }

  private assertDataPlaneTarget(input: string, method: string, feature: string): void {
    assertAllowedDataPlaneTarget(this.assertGatewayTarget(input), method, feature);
  }

  private assertResponseDestination(response: Response): void {
    if (response.redirected) {
      void response.body?.cancel().catch(() => undefined);
      throw new LatchwayError(
        "transport_destination_not_allowed",
        "The Fetch implementation followed a redirect for an authenticated Latchway request.",
      );
    }
    if (response.url !== "" && new URL(response.url).origin !== this.config.baseURL.origin) {
      void response.body?.cancel().catch(() => undefined);
      throw new LatchwayError(
        "transport_destination_not_allowed",
        "The authenticated response came from a different origin.",
      );
    }
  }
}

function assertFeature(value: string | undefined): asserts value is string {
  if (value === undefined || !/^[a-z][a-z0-9_-]{0,62}$/u.test(value)) {
    throw new LatchwayError("client_configuration_invalid", "A valid latchwayFeature is required.");
  }
}

function assertComponentID(value: string): void {
  if (typeof value !== "string" || !/^cmp_[A-Za-z0-9_-]{16,128}$/u.test(value)) {
    throw new LatchwayError("client_configuration_invalid", "A valid component ID is required.");
  }
}

function validateProvisionComponentOptions(
  value: unknown,
  defaultAppVersion: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value) ||
      typeof value.componentDefinitionID !== "string" ||
      !/^[a-z][a-z0-9_-]{0,62}$/u.test(value.componentDefinitionID) ||
      !Array.isArray(value.requestedFeatures) || value.requestedFeatures.length < 1 ||
      value.requestedFeatures.length > 256 ||
      value.requestedFeatures.some((feature) => typeof feature !== "string" ||
        !/^[a-z][a-z0-9_-]{0,62}$/u.test(feature)) ||
      new Set(value.requestedFeatures).size !== value.requestedFeatures.length) {
    throw new LatchwayError("client_configuration_invalid", "Component provisioning options are invalid.");
  }
  const publicJWK = value.publicJWK;
  if (!isRecord(publicJWK) || publicJWK.kty !== "EC" || publicJWK.crv !== "P-256" ||
      typeof publicJWK.x !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(publicJWK.x) ||
      typeof publicJWK.y !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(publicJWK.y) ||
      Object.keys(publicJWK).some((key) => !new Set(["kty", "crv", "x", "y"]).has(key))) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "Component provisioning requires an exact public P-256 JWK without private key material.",
    );
  }
  const appVersion = value.appVersion ?? defaultAppVersion;
  if (!isBoundedVersion(appVersion)) {
    throw new LatchwayError("client_configuration_invalid", "The component app version is invalid.");
  }
  return {
    component_definition_id: value.componentDefinitionID,
    public_jwk: { kty: "EC", crv: "P-256", x: publicJWK.x, y: publicJWK.y },
    requested_features: [...value.requestedFeatures],
    client_metadata: { app_version: appVersion, sdk_version: SDK_VERSION },
  };
}

function parseProvisionedComponent(value: unknown): ProvisionedComponent {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "component_id", "installation_family_id", "trust", "granted_features",
    "refresh_grant", "refresh_grant_expires_at",
  ]) || typeof value.component_id !== "string" ||
      !/^cmp_[A-Za-z0-9_-]{16,128}$/u.test(value.component_id) ||
      typeof value.installation_family_id !== "string" ||
      !/^fam_[A-Za-z0-9_-]{16,128}$/u.test(value.installation_family_id) ||
      !isRecord(value.trust) || !hasOnlyKeys(value.trust, ["source", "expires_at"]) ||
      (value.trust.source !== "delegated_from_attested_root" &&
        value.trust.source !== "delegated_identity_only") ||
      typeof value.trust.expires_at !== "string" || !isISODateTime(value.trust.expires_at) ||
      !Array.isArray(value.granted_features) || value.granted_features.length < 1 ||
      value.granted_features.length > 256 ||
      value.granted_features.some((feature) => typeof feature !== "string" ||
        !/^[a-z][a-z0-9_-]{0,62}$/u.test(feature)) ||
      new Set(value.granted_features).size !== value.granted_features.length ||
      typeof value.refresh_grant !== "string" || value.refresh_grant.length < 32 ||
      value.refresh_grant.length > 2_048 || hasWhitespaceOrControl(value.refresh_grant) ||
      typeof value.refresh_grant_expires_at !== "string" ||
      !isISODateTime(value.refresh_grant_expires_at)) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned invalid component provisioning data.");
  }
  return {
    componentID: value.component_id,
    installationFamilyID: value.installation_family_id,
    trust: { source: value.trust.source, expiresAt: value.trust.expires_at },
    grantedFeatures: [...value.granted_features] as string[],
    refreshGrant: value.refresh_grant,
    refreshGrantExpiresAt: value.refresh_grant_expires_at,
  };
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function isBoundedVersion(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 &&
    value.trim() === value && !value.includes("\r") && !value.includes("\n") && !value.includes("\u0000");
}

function hasWhitespaceOrControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return /\s/u.test(character) || codePoint <= 31 || codePoint === 127;
  });
}

function isISODateTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && /(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value);
}

function validateFrameworkMetadata(value: unknown): FrameworkMetadata | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null ||
      !("id" in value) || typeof value.id !== "string" ||
      !("version" in value) || typeof value.version !== "string" ||
      !frameworkIDs.has(value.id as FrameworkMetadata["id"]) ||
      !canonicalSemver.test(value.version) ||
      value.version.length > 128) {
    throw new LatchwayError("client_configuration_invalid", "Framework metadata is invalid.");
  }
  return { id: value.id as FrameworkMetadata["id"], version: value.version };
}

function isReplayableInput(
  input: RequestInfo | URL,
  init: RequestInit,
  request: Request,
): boolean {
  if (request.body === null) return true;
  if (input instanceof Request && init.body === undefined) return false;
  const body = init.body;
  if (body === undefined || body === null || body instanceof ReadableStream) return false;
  return typeof body === "string" || body instanceof Blob || body instanceof FormData ||
    body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

function isLatchwayProblem(response: Response): boolean {
  return response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/problem+json";
}

async function safeJSON(response: Response): Promise<unknown> {
  try {
    return await readBoundedJSON(response);
  } catch (cause) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned malformed JSON.", {
      status: response.status,
      requestID: response.headers.get("X-Latchway-Request-ID") ?? undefined,
      cause,
    });
  }
}

function parseQuota(value: unknown): QuotaSnapshot {
  if (!isRecord(value) || typeof value.feature !== "string" || typeof value.observed_at !== "string" ||
      !Array.isArray(value.limits)) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned an invalid quota snapshot.");
  }
  const limits: QuotaLimit[] = value.limits.map((item) => {
    if (!isRecord(item) || typeof item.metric !== "string" || typeof item.hard !== "boolean") {
      throw new LatchwayError("protocol_response_invalid", "Latchway returned an invalid quota limit.");
    }
    const numeric = ["maximum", "used", "reserved", "remaining"] as const;
    for (const field of numeric) {
      if (item[field] !== undefined && (!Number.isSafeInteger(item[field]) || (item[field] as number) < 0)) {
        throw new LatchwayError("protocol_response_invalid", "Latchway returned an invalid quota counter.");
      }
    }
    if (item.resets_at !== undefined && typeof item.resets_at !== "string") {
      throw new LatchwayError("protocol_response_invalid", "Latchway returned an invalid quota reset time.");
    }
    return item as unknown as QuotaLimit;
  });
  return { feature: value.feature, observed_at: value.observed_at, limits };
}

function parseDiagnostics(value: unknown): ServerDiagnostics {
  if (!isRecord(value) || typeof value.request_id !== "string" || typeof value.server_version !== "string" ||
      value.contract_version !== CONTRACT_VERSION || value.protocol_version !== PROTOCOL_VERSION ||
      !isRecord(value.installation) || !isRecord(value.session) || !isRecord(value.trust) ||
      typeof value.installation.id !== "string" || typeof value.installation.platform !== "string" ||
      typeof value.installation.dpop_jkt !== "string" ||
      (value.installation.status !== "active" && value.installation.status !== "revoked") ||
      typeof value.session.expires_at !== "string" || typeof value.session.refresh_available !== "boolean" ||
      typeof value.trust.provider !== "string" || typeof value.trust.level !== "string" ||
      typeof value.trust.verified_at !== "string" || typeof value.trust.expires_at !== "string") {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned invalid diagnostics.");
  }
  return value as unknown as ServerDiagnostics;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => { reject(abortReason(signal)); };
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (listener !== undefined) signal.removeEventListener("abort", listener);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
