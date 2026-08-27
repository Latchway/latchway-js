import { LatchwayError } from "../errors.js";
import type {
  AttestationProviderID,
  InstallationSummary,
  SessionChallenge,
  TrustSummary,
} from "../types.js";

export interface SessionGrant {
  access_token: string;
  token_type: "DPoP";
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  installation: InstallationSummary;
  trust: TrustSummary;
}

const attestationProviders = new Set<AttestationProviderID>([
  "app_attest", "play_integrity", "firebase_app_check", "turnstile", "debug",
]);
const platforms = new Set<InstallationSummary["platform"]>([
  "ios", "android", "web", "react_native_ios", "react_native_android", "node",
]);
const trustLevels = new Set<TrustSummary["level"]>([
  "none", "identity_only", "web_risk_verified", "app_verified", "device_verified",
  "strong_device_verified", "debug",
]);

export function parseSessionChallenge(value: unknown): SessionChallenge {
  if (!isRecord(value) || !hasOnlyKeys(value, ["challenge_id", "challenge_nonce", "binding_version", "issued_at", "expires_at", "attestation"]) ||
      typeof value.challenge_id !== "string" || !/^chl_[A-Za-z0-9_-]{16,128}$/u.test(value.challenge_id) ||
      typeof value.challenge_nonce !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value.challenge_nonce) ||
      value.binding_version !== 1 || !isInteger(value.issued_at) || typeof value.expires_at !== "string" ||
      !isISODate(value.expires_at) || !isRecord(value.attestation) ||
      !hasOnlyKeys(value.attestation, ["provider", "mode", "client_data_hash", "provider_options"]) ||
      typeof value.attestation.provider !== "string" ||
      !attestationProviders.has(value.attestation.provider as AttestationProviderID) ||
      (value.attestation.mode !== "required" && value.attestation.mode !== "preferred") ||
      typeof value.attestation.client_data_hash !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.attestation.client_data_hash)) {
    throw invalidResponse("session challenge");
  }
  const providerOptions = value.attestation.provider_options;
  if (providerOptions !== undefined && !isRecord(providerOptions)) throw invalidResponse("session challenge");
  return {
    challenge_id: value.challenge_id,
    challenge_nonce: value.challenge_nonce,
    binding_version: 1,
    issued_at: value.issued_at,
    expires_at: value.expires_at,
    attestation: {
      provider: value.attestation.provider as AttestationProviderID,
      mode: value.attestation.mode,
      client_data_hash: value.attestation.client_data_hash,
      ...(providerOptions === undefined ? {} : { provider_options: providerOptions }),
    },
  };
}

export function parseSessionGrant(value: unknown): SessionGrant {
  if (!isRecord(value) || !hasOnlyKeys(value, ["access_token", "token_type", "expires_in", "refresh_token", "refresh_expires_in", "installation", "trust"]) ||
      typeof value.access_token !== "string" || value.token_type !== "DPoP" ||
      !isInteger(value.expires_in) || typeof value.refresh_token !== "string" ||
      !isInteger(value.refresh_expires_in)) {
    throw invalidResponse("session grant");
  }
  if (value.access_token.length < 64 || value.access_token.length > 16_384 ||
      value.refresh_token.length < 32 || value.refresh_token.length > 2_048 ||
      value.expires_in < 60 || value.expires_in > 3_600 ||
      value.refresh_expires_in < 300 || value.refresh_expires_in > 31_536_000) {
    throw invalidResponse("session grant");
  }
  return {
    access_token: value.access_token,
    token_type: "DPoP",
    expires_in: value.expires_in,
    refresh_token: value.refresh_token,
    refresh_expires_in: value.refresh_expires_in,
    installation: parseInstallation(value.installation),
    trust: parseTrust(value.trust),
  };
}

function parseInstallation(value: unknown): InstallationSummary {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "platform", "dpop_jkt", "status"]) ||
      typeof value.id !== "string" || !/^ins_[A-Za-z0-9_-]{16,128}$/u.test(value.id) || typeof value.platform !== "string" ||
      !platforms.has(value.platform as InstallationSummary["platform"]) || typeof value.dpop_jkt !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.dpop_jkt) ||
      (value.status !== "active" && value.status !== "revoked")) {
    throw invalidResponse("installation summary");
  }
  return {
    id: value.id,
    platform: value.platform as InstallationSummary["platform"],
    dpop_jkt: value.dpop_jkt,
    status: value.status,
  };
}

function parseTrust(value: unknown): TrustSummary {
  if (!isRecord(value) || !hasOnlyKeys(value, ["provider", "level", "verified_at", "expires_at"]) ||
      typeof value.provider !== "string" || typeof value.level !== "string" ||
      !trustLevels.has(value.level as TrustSummary["level"]) || typeof value.verified_at !== "string" ||
      !isISODate(value.verified_at) || typeof value.expires_at !== "string" || !isISODate(value.expires_at)) {
    throw invalidResponse("trust summary");
  }
  return {
    provider: value.provider,
    level: value.level as TrustSummary["level"],
    verified_at: value.verified_at,
    expires_at: value.expires_at,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function isISODate(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && value.includes("T");
}

function invalidResponse(kind: string): LatchwayError {
  return new LatchwayError("protocol_response_invalid", `Latchway returned an invalid ${kind}.`);
}
