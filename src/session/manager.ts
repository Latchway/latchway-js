import { createDPoPProof } from "../dpop/proof.js";
import { generateInstallationKey, jwkThumbprint, type InstallationKeyRecord, type P256PublicJWK } from "../dpop/key.js";
import { randomID } from "../encoding.js";
import { errorFromResponse, LatchwayError } from "../errors.js";
import { readBoundedJSON } from "../json.js";
import type { StateStore, StoredSession } from "../storage/state.js";
import type {
  AttestationProvider,
  FetchImplementation,
  IdentityTokenProvider,
  InstallationMetadata,
  Platform,
} from "../types.js";
import { PROTOCOL_VERSION, SDK_KIND, SDK_VERSION } from "../version.js";
import { isRecord, parseSessionChallenge, parseSessionGrant, type SessionGrant } from "./wire.js";

const refreshLeewayMilliseconds = 30_000;
const refreshLeaseMilliseconds = 10_000;

export interface SessionManagerOptions {
  baseURL: URL;
  applicationID: string;
  environment: string;
  identityProvider: string;
  identityTokenProvider: IdentityTokenProvider;
  attestationProviders: readonly AttestationProvider[];
  installation: InstallationMetadata;
  platform: Platform;
  runtimeCrypto: Crypto;
  fetch: FetchImplementation;
  store: StateStore;
}

export class SessionManager {
  private keyPromise: Promise<InstallationKeyRecord> | undefined;
  private sessionPromise: Promise<StoredSession> | undefined;
  private nonce: string | undefined;
  private clockOffsetMilliseconds = 0;

  constructor(private readonly options: SessionManagerOptions) {}

  get persistenceKind(): "indexeddb" | "memory" {
    return this.options.store.persistenceKind;
  }

  get clockOffset(): number {
    return this.clockOffsetMilliseconds;
  }

  async key(): Promise<InstallationKeyRecord> {
    this.keyPromise ??= this.loadOrCreateKey();
    return this.keyPromise;
  }

  async session(): Promise<StoredSession> {
    this.sessionPromise ??= this.loadOrCreateSession().finally(() => {
      this.sessionPromise = undefined;
    });
    return this.sessionPromise;
  }

  async refresh(): Promise<StoredSession> {
    const existing = await this.options.store.loadSession();
    if (existing === undefined || existing.refreshExpiresAt <= this.now()) {
      await this.options.store.clearSession();
      return this.session();
    }
    return this.refreshCoordinated(existing, true);
  }

  async proof(method: string, url: string | URL, accessToken?: string): Promise<string> {
    return createDPoPProof(this.options.runtimeCrypto, await this.key(), {
      method,
      url,
      issuedAt: Math.floor(this.now() / 1000),
      ...(accessToken === undefined ? {} : { accessToken }),
      ...(this.nonce === undefined ? {} : { nonce: this.nonce }),
    });
  }

  recordNonce(value: string | null): boolean {
    if (value === null || !/^[\u0021-\u002b\u002d-\u007e]{16,512}$/u.test(value)) return false;
    this.nonce = value;
    return true;
  }

  async clearSession(): Promise<void> {
    await this.options.store.clearSession();
  }

  async clearInstallation(): Promise<void> {
    await Promise.all([this.options.store.clearSession(), this.options.store.clearInstallation()]);
    this.keyPromise = undefined;
    this.nonce = undefined;
  }

  private async loadOrCreateKey(): Promise<InstallationKeyRecord> {
    const existing = await this.options.store.loadInstallation();
    if (existing !== undefined && await this.isValidStoredKey(existing)) return existing;
    if (existing !== undefined) {
      await Promise.all([this.options.store.clearInstallation(), this.options.store.clearSession()]);
    }
    const created = await generateInstallationKey(this.options.runtimeCrypto);
    await this.options.store.saveInstallation(created);
    return created;
  }

  private async loadOrCreateSession(): Promise<StoredSession> {
    const existing = await this.options.store.loadSession();
    const key = existing === undefined ? undefined : await this.key();
    if (existing !== undefined && key !== undefined && isValidStoredSession(existing, key.thumbprint, this.options.platform)) {
      this.clockOffsetMilliseconds = existing.clockOffsetMilliseconds;
      if (existing.accessExpiresAt > this.now() + refreshLeewayMilliseconds) return existing;
      if (existing.refreshExpiresAt > this.now()) return this.refreshCoordinated(existing, false);
      await this.options.store.clearSession();
    } else if (existing !== undefined) {
      await this.options.store.clearSession();
    }
    return this.establish();
  }

  private async isValidStoredKey(candidate: unknown): Promise<boolean> {
    if (!isRecord(candidate) || !isCryptoKey(candidate.privateKey) || !isCryptoKey(candidate.publicKey) ||
        !isRecord(candidate.publicJwk) || typeof candidate.thumbprint !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(candidate.thumbprint) ||
        candidate.privateKey.type !== "private" || candidate.privateKey.extractable ||
        candidate.publicKey.type !== "public" || !candidate.privateKey.usages.includes("sign") ||
        !candidate.publicKey.usages.includes("verify") || candidate.publicJwk.kty !== "EC" ||
        candidate.publicJwk.crv !== "P-256" || typeof candidate.publicJwk.x !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(candidate.publicJwk.x) || typeof candidate.publicJwk.y !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(candidate.publicJwk.y) ||
        Object.keys(candidate.publicJwk).some((key) => !new Set(["kty", "crv", "x", "y"]).has(key))) {
      return false;
    }
    const privateAlgorithm = candidate.privateKey.algorithm;
    const publicAlgorithm = candidate.publicKey.algorithm;
    if (!isRecord(privateAlgorithm) || !isRecord(publicAlgorithm) ||
        privateAlgorithm.name !== "ECDSA" || privateAlgorithm.namedCurve !== "P-256" ||
        publicAlgorithm.name !== "ECDSA" || publicAlgorithm.namedCurve !== "P-256") {
      return false;
    }
    return candidate.thumbprint === await jwkThumbprint(
      this.options.runtimeCrypto,
      candidate.publicJwk as unknown as P256PublicJWK,
    );
  }

  private async refreshCoordinated(initial: StoredSession, force: boolean): Promise<StoredSession> {
    const owner = randomID(this.options.runtimeCrypto);
    let deadline = Date.now() + refreshLeaseMilliseconds;
    for (;;) {
      const acquired = await this.options.store.tryAcquireRefreshLease(owner, deadline);
      if (acquired) break;
      await delay(75);
      const current = await this.options.store.loadSession();
      if (current !== undefined && current.generation > initial.generation &&
          current.accessExpiresAt > this.now() + (force ? 0 : refreshLeewayMilliseconds)) {
        this.clockOffsetMilliseconds = current.clockOffsetMilliseconds;
        return current;
      }
      if (Date.now() >= deadline) deadline = Date.now() + refreshLeaseMilliseconds;
    }

    try {
      const current = await this.options.store.loadSession();
      if (current === undefined || current.refreshExpiresAt <= this.now()) {
        return this.establish(initial.generation + 1);
      }
      if (current.generation > initial.generation && current.accessExpiresAt > this.now()) {
        this.clockOffsetMilliseconds = current.clockOffsetMilliseconds;
        return current;
      }
      try {
        return await this.performRefresh(current);
      } catch (error) {
        if (error instanceof LatchwayError && new Set([
          "identity_reauthentication_required", "attestation_required", "attestation_stale",
          "attestation_step_up_required",
        ]).has(error.code)) {
          return this.establish(current.generation + 1);
        }
        throw error;
      }
    } finally {
      await this.options.store.releaseRefreshLease(owner);
    }
  }

  private async establish(generation = 1): Promise<StoredSession> {
    const key = await this.key();
    const identityToken = await this.identityToken();
    const challengeURL = this.endpoint("/client/v1/session-challenges");
    const challengeResponse = await this.sendDPoPJSON(challengeURL, "POST", {
      application_id: this.options.applicationID,
      environment: this.options.environment,
      identity_provider: this.options.identityProvider,
      identity_token: identityToken,
      platform: this.options.platform,
      sdk_version: SDK_VERSION,
    });
    const challenge = parseSessionChallenge(await parseJSON(challengeResponse));
    const expiresAt = Date.parse(challenge.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      throw new LatchwayError("protocol_response_invalid", "Latchway returned an expired session challenge.");
    }
    const provider = this.options.attestationProviders.find((candidate) => candidate.provider === challenge.attestation.provider);
    if (provider === undefined) {
      throw new LatchwayError(
        "attestation_provider_missing",
        `The server requested ${challenge.attestation.provider}, but no matching attestation adapter is configured.`,
      );
    }
    let evidence: Readonly<Record<string, unknown>>;
    try {
      evidence = await provider.getEvidence({
        challenge,
        applicationID: this.options.applicationID,
        environment: this.options.environment,
        dpopJkt: key.thumbprint,
        platform: this.options.platform,
      });
    } catch (cause) {
      if (cause instanceof LatchwayError) throw cause;
      throw new LatchwayError("attestation_provider_missing", "The attestation adapter could not produce evidence.", { cause });
    }
    if (!isPlainObject(evidence)) {
      throw new LatchwayError("protocol_response_invalid", "The attestation adapter returned invalid evidence.");
    }
    const exchangeURL = this.endpoint("/client/v1/sessions");
    const exchangeResponse = await this.sendDPoPJSON(exchangeURL, "POST", {
      challenge_id: challenge.challenge_id,
      attestation: { provider: provider.provider, evidence },
      installation: {
        app_version: this.options.installation.appVersion,
        ...(this.options.installation.osVersion === undefined ? {} : { os_version: this.options.installation.osVersion }),
        ...(this.options.installation.deviceModel === undefined ? {} : { device_model: this.options.installation.deviceModel }),
      },
    });
    return this.persistGrant(parseSessionGrant(await parseJSON(exchangeResponse)), generation);
  }

  private async performRefresh(existing: StoredSession): Promise<StoredSession> {
    const refreshURL = this.endpoint("/client/v1/sessions/refresh");
    try {
      const response = await this.sendDPoPJSON(refreshURL, "POST", {
        refresh_token: existing.refreshToken,
      });
      return this.persistGrant(parseSessionGrant(await parseJSON(response)), existing.generation + 1);
    } catch (error) {
      if (error instanceof LatchwayError && new Set([
        "identity_reauthentication_required", "attestation_required", "attestation_stale",
        "attestation_step_up_required", "refresh_token_reused", "session_revoked", "installation_revoked",
      ]).has(error.code)) {
        await this.options.store.clearSession();
      }
      throw error;
    }
  }

  private async persistGrant(grant: SessionGrant, generation: number): Promise<StoredSession> {
    const key = await this.key();
    if (grant.installation.dpop_jkt !== key.thumbprint || grant.installation.platform !== this.options.platform ||
        grant.installation.status !== "active") {
      throw new LatchwayError("protocol_response_invalid", "The session grant is not bound to this installation key and platform.");
    }
    const issuedAt = this.now();
    const stored: StoredSession = {
      accessToken: grant.access_token,
      refreshToken: grant.refresh_token,
      accessExpiresAt: issuedAt + grant.expires_in * 1_000,
      refreshExpiresAt: issuedAt + grant.refresh_expires_in * 1_000,
      installation: grant.installation,
      trust: grant.trust,
      generation,
      clockOffsetMilliseconds: this.clockOffsetMilliseconds,
    };
    await this.options.store.saveSession(stored);
    return stored;
  }

  private async sendDPoPJSON(url: URL, method: string, body: Readonly<Record<string, unknown>>): Promise<Response> {
    let serialized: string;
    try {
      serialized = JSON.stringify(body);
    } catch (cause) {
      throw new LatchwayError("client_configuration_invalid", "A session adapter returned non-JSON data.", { cause });
    }
    if (serialized.length > 131_072) {
      throw new LatchwayError("client_configuration_invalid", "The session request exceeds the SDK safety limit.");
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const startedAt = Date.now();
      const headers = this.standardHeaders();
      headers.set("Content-Type", "application/json");
      headers.set("DPoP", await this.proof(method, url));
      let response: Response;
      try {
        response = await this.options.fetch(url, {
          method,
          headers,
          body: serialized,
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
      } catch (cause) {
        throw new LatchwayError("network_error", "The Latchway session request failed.", { retryable: true, cause });
      }
      const clockChanged = this.observeServerDate(response, startedAt, Date.now());
      if (response.ok) {
        this.recordNonce(response.headers.get("DPoP-Nonce"));
        return response;
      }
      const nonce = response.headers.get("DPoP-Nonce");
      const error = await errorFromResponse(response);
      if (attempt === 0 && error.code === "dpop_nonce_required" && this.recordNonce(nonce)) continue;
      if (attempt === 0 && error.code === "dpop_invalid" && nonce === null && clockChanged) continue;
      throw error;
    }
    throw new LatchwayError("dpop_invalid", "Latchway rejected the DPoP proof.");
  }

  private standardHeaders(): Headers {
    return new Headers({
      "X-Latchway-Protocol-Version": String(PROTOCOL_VERSION),
      "X-Latchway-SDK": SDK_KIND,
      "X-Latchway-SDK-Version": SDK_VERSION,
    });
  }

  private async identityToken(): Promise<string> {
    let token: string;
    try {
      token = await this.options.identityTokenProvider.getIdentityToken();
    } catch (cause) {
      throw new LatchwayError("identity_token_missing", "The identity token provider failed.", { cause });
    }
    if (typeof token !== "string" || token.length < 16 || token.length > 65_536) {
      throw new LatchwayError("identity_token_missing", "The identity token provider did not return a valid token.");
    }
    return token;
  }

  private observeServerDate(response: Response, startedAt: number, endedAt: number): boolean {
    const header = response.headers.get("Date");
    if (header === null) return false;
    const serverTime = Date.parse(header);
    if (!Number.isFinite(serverTime)) return false;
    const offset = serverTime - Math.floor((startedAt + endedAt) / 2);
    if (Math.abs(offset) > 86_400_000) return false;
    const changed = Math.abs(offset - this.clockOffsetMilliseconds) > 1_000;
    this.clockOffsetMilliseconds = offset;
    return changed;
  }

  private endpoint(path: string): URL {
    return new URL(path, this.options.baseURL);
  }

  private now(): number {
    return Date.now() + this.clockOffsetMilliseconds;
  }
}

async function parseJSON(response: Response): Promise<unknown> {
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

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isCryptoKey(value: unknown): value is CryptoKey {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CryptoKey>;
  return (candidate.type === "private" || candidate.type === "public" || candidate.type === "secret") &&
    typeof candidate.extractable === "boolean" && Array.isArray(candidate.usages) &&
    typeof candidate.algorithm === "object";
}

function isValidStoredSession(value: unknown, thumbprint: string, platform: Platform): value is StoredSession {
  if (!isRecord(value) || typeof value.accessToken !== "string" || value.accessToken.length < 64 ||
      typeof value.refreshToken !== "string" || value.refreshToken.length < 32 ||
      !Number.isSafeInteger(value.accessExpiresAt) || !Number.isSafeInteger(value.refreshExpiresAt) ||
      !Number.isSafeInteger(value.generation) || (value.generation as number) < 1 ||
      typeof value.clockOffsetMilliseconds !== "number" || !Number.isFinite(value.clockOffsetMilliseconds) ||
      Math.abs(value.clockOffsetMilliseconds) > 86_400_000 || !isRecord(value.installation) ||
      value.installation.dpop_jkt !== thumbprint || value.installation.platform !== platform ||
      value.installation.status !== "active" || !isRecord(value.trust) || typeof value.trust.provider !== "string") {
    return false;
  }
  return true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
