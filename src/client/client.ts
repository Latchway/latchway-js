import { errorFromResponse, LatchwayError } from "../errors.js";
import { readBoundedJSON } from "../json.js";
import { SessionManager } from "../session/manager.js";
import { isRecord } from "../session/wire.js";
import type {
  Diagnostics,
  LatchwayClient,
  LatchwayFetchInit,
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

export class DefaultLatchwayClient implements LatchwayClient {
  private readonly sessions: SessionManager;

  constructor(private readonly config: RuntimeConfiguration) {
    this.sessions = new SessionManager(config);
  }

  async fetch(input: RequestInfo | URL, init: LatchwayFetchInit = {}): Promise<Response> {
    const { latchwayFeature, ...requestInit } = init;
    const request = this.createRequest(input, requestInit);
    const feature = latchwayFeature ?? request.headers.get("X-Latchway-Feature") ?? undefined;
    assertFeature(feature);
    this.assertGatewayTarget(request.url);
    if (request.bodyUsed) {
      throw new LatchwayError("request_not_replayable", "The request body has already been consumed.");
    }
    const template = this.sanitize(request);
    let nonceRetried = false;
    let sessionRetried = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outbound = await this.authorize(template.clone(), feature);
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
      if (response.ok) {
        this.sessions.recordNonce(response.headers.get("DPoP-Nonce"));
        return response;
      }
      if (!isLatchwayProblem(response)) return response;
      const error = await errorFromResponse(response.clone());
      if (!nonceRetried && error.code === "dpop_nonce_required" &&
          this.sessions.recordNonce(response.headers.get("DPoP-Nonce"))) {
        await response.body?.cancel();
        nonceRetried = true;
        continue;
      }
      if (!sessionRetried && error.code === "session_expired" &&
          response.headers.get("DPoP-Nonce") === null) {
        await response.body?.cancel();
        await abortable(this.sessions.refresh(), template.signal);
        sessionRetried = true;
        continue;
      }
      return response;
    }
    throw new LatchwayError("protocol_response_invalid", "Latchway exhausted the safe request retry path.");
  }

  async authorize(request: Request, feature: string): Promise<Request> {
    assertFeature(feature);
    this.assertGatewayTarget(request.url);
    if (request.bodyUsed) {
      throw new LatchwayError("request_not_replayable", "The request body has already been consumed.");
    }
    const session = await abortable(this.sessions.session(), request.signal);
    const headers = this.sanitizeHeaders(request.headers);
    headers.set("Authorization", `DPoP ${session.accessToken}`);
    headers.set("DPoP", await this.sessions.proof(request.method, request.url, session.accessToken));
    headers.set("X-Latchway-Feature", feature);
    this.addProtocolHeaders(headers);
    return new Request(request, { headers, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
  }

  async quota(feature: string): Promise<QuotaSnapshot> {
    assertFeature(feature);
    const response = await this.sendControl("GET", `/client/v1/features/${encodeURIComponent(feature)}/quota`, feature);
    return parseQuota(await safeJSON(response));
  }

  async refresh(): Promise<void> {
    await this.sessions.refresh();
  }

  async revokeCurrentInstallation(): Promise<void> {
    const response = await this.sendControl("DELETE", "/client/v1/installations/current");
    if (response.status !== 204) {
      throw new LatchwayError("protocol_response_invalid", "Latchway did not confirm installation revocation.", {
        status: response.status,
      });
    }
    await this.sessions.clearInstallation();
  }

  async diagnostics(): Promise<Diagnostics> {
    const response = await this.sendControl("GET", "/client/v1/diagnostics");
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

  private async sendControl(method: string, path: string, feature?: string): Promise<Response> {
    const url = new URL(path, this.config.baseURL);
    let nonceRetried = false;
    let sessionRetried = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = await this.sessions.session();
      const headers = new Headers();
      headers.set("Authorization", `DPoP ${session.accessToken}`);
      headers.set("DPoP", await this.sessions.proof(method, url, session.accessToken));
      if (feature !== undefined) headers.set("X-Latchway-Feature", feature);
      this.addProtocolHeaders(headers);
      let response: Response;
      try {
        response = await this.config.fetch(url, { method, headers, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
      } catch (cause) {
        throw new LatchwayError("network_error", "The Latchway control request failed.", { retryable: true, cause });
      }
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
    return headers;
  }

  private addProtocolHeaders(headers: Headers): void {
    headers.set("X-Latchway-Protocol-Version", String(PROTOCOL_VERSION));
    headers.set("X-Latchway-SDK", SDK_KIND);
    headers.set("X-Latchway-SDK-Version", SDK_VERSION);
  }

  private assertGatewayTarget(input: string): void {
    const target = new URL(input);
    if (target.origin !== this.config.baseURL.origin) {
      throw new LatchwayError("client_configuration_invalid", "Latchway only authorizes requests to the configured gateway origin.");
    }
    for (const name of target.searchParams.keys()) {
      if (forbiddenCredentialQueryNames.has(name.toLowerCase())) {
        throw new LatchwayError(
          "request_invalid",
          "Upstream provider credentials must not be supplied in the request URL.",
        );
      }
    }
  }
}

function assertFeature(value: string | undefined): asserts value is string {
  if (value === undefined || !/^[a-z][a-z0-9_-]{0,62}$/u.test(value)) {
    throw new LatchwayError("client_configuration_invalid", "A valid latchwayFeature is required.");
  }
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
