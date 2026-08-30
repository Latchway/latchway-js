import { LatchwayError } from "../errors.js";
import { base64urlDecode } from "../encoding.js";
import type {
  AttestationProviderID,
  ClientComponentKind,
  ClientComponentSummary,
  InstallationFamilySummary,
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
  installation_family?: InstallationFamilySummary;
  component?: ClientComponentSummary;
  trust: TrustSummary;
}

/** Strict wire shape for the App Attest-only component step-up contract. */
export interface ComponentAttestationChallenge {
  challenge_id: string;
  challenge_nonce: string;
  binding_version: 2;
  issued_at: number;
  expires_at: string;
  attestation: {
    provider: "app_attest";
    mode: "required";
    client_data_hash: string;
    provider_options?: Readonly<Record<string, unknown>>;
  };
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
const componentKinds = new Set<ClientComponentKind>([
  "main_app", "widget", "share_extension", "app_intent_extension",
  "notification_service_extension", "action_extension", "sso_extension",
  "watch_extension", "android_app", "wear_app", "browser", "node_process",
]);
const trustSources = new Set<NonNullable<TrustSummary["source"]>>([
  "direct_attested", "delegated_from_attested_root", "delegated_identity_only",
  "delegated_direct_attested", "identity_only", "web_risk_verified", "debug",
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

export function parseComponentAttestationChallenge(value: unknown): ComponentAttestationChallenge {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, [
        "challenge_id", "challenge_nonce", "binding_version", "issued_at", "expires_at", "attestation",
      ]) ||
      typeof value.challenge_id !== "string" || !/^chl_[A-Za-z0-9_-]{16,128}$/u.test(value.challenge_id) ||
      typeof value.challenge_nonce !== "string" ||
      !isBase64urlWithDecodedLength(value.challenge_nonce, 32, 64) ||
      value.binding_version !== 2 || !isInteger(value.issued_at) ||
      value.issued_at < 0 || value.issued_at > 253_402_300_799 ||
      typeof value.expires_at !== "string" || !isISODate(value.expires_at) ||
      Date.parse(value.expires_at) <= value.issued_at * 1_000 ||
      !isRecord(value.attestation) ||
      !hasOnlyKeys(value.attestation, ["provider", "mode", "client_data_hash", "provider_options"]) ||
      value.attestation.provider !== "app_attest" || value.attestation.mode !== "required" ||
      typeof value.attestation.client_data_hash !== "string" ||
      !isBase64urlWithDecodedLength(value.attestation.client_data_hash, 32, 32)) {
    throw invalidResponse("component attestation challenge");
  }
  const providerOptions = value.attestation.provider_options;
  if (providerOptions !== undefined && !isRecord(providerOptions)) {
    throw invalidResponse("component attestation challenge");
  }
  return {
    challenge_id: value.challenge_id,
    challenge_nonce: value.challenge_nonce,
    binding_version: 2,
    issued_at: value.issued_at,
    expires_at: value.expires_at,
    attestation: {
      provider: "app_attest",
      mode: "required",
      client_data_hash: value.attestation.client_data_hash,
      ...(providerOptions === undefined ? {} : { provider_options: providerOptions }),
    },
  };
}

export function parseSessionGrant(value: unknown): SessionGrant {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "access_token", "token_type", "expires_in", "refresh_token", "refresh_expires_in",
    "installation", "installation_family", "component", "trust",
  ]) ||
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
  const installation = parseInstallation(value.installation);
  const family = value.installation_family === undefined
    ? undefined
    : parseInstallationFamily(value.installation_family);
  const component = value.component === undefined
    ? undefined
    : parseComponent(value.component, installation);
  if ((family === undefined) !== (component === undefined)) throw invalidResponse("session grant");
  const trust = parseTrust(value.trust);
  validateTrustProvenance(component, trust);
  return {
    access_token: value.access_token,
    token_type: "DPoP",
    expires_in: value.expires_in,
    refresh_token: value.refresh_token,
    refresh_expires_in: value.refresh_expires_in,
    installation,
    ...(family === undefined ? {} : { installation_family: family }),
    ...(component === undefined ? {} : { component }),
    trust,
  };
}

function parseInstallationFamily(value: unknown): InstallationFamilySummary {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "status"]) ||
      typeof value.id !== "string" || !/^fam_[A-Za-z0-9_-]{16,128}$/u.test(value.id) ||
      (value.status !== "active" && value.status !== "revoked")) {
    throw invalidResponse("installation family summary");
  }
  return { id: value.id, status: value.status };
}

function parseComponent(value: unknown, installation: InstallationSummary): ClientComponentSummary {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "id", "definition_id", "kind", "platform", "is_root", "status", "dpop_jkt", "granted_features",
  ]) || typeof value.id !== "string" || !/^cmp_[A-Za-z0-9_-]{16,128}$/u.test(value.id) ||
      typeof value.definition_id !== "string" || !/^[a-z][a-z0-9_-]{0,62}$/u.test(value.definition_id) ||
      typeof value.kind !== "string" || !componentKinds.has(value.kind as ClientComponentKind) ||
      value.platform !== installation.platform || typeof value.is_root !== "boolean" ||
      (value.status !== "active" && value.status !== "revoked") ||
      value.dpop_jkt !== installation.dpop_jkt || !Array.isArray(value.granted_features) ||
      value.granted_features.length < 1 || value.granted_features.length > 256) {
    throw invalidResponse("client component summary");
  }
  const grantedFeatures = value.granted_features as unknown[];
  if (grantedFeatures.some((feature) => typeof feature !== "string" ||
      !/^[a-z][a-z0-9_-]{0,62}$/u.test(feature)) ||
      new Set(grantedFeatures).size !== grantedFeatures.length) {
    throw invalidResponse("client component summary");
  }
  return {
    id: value.id,
    definition_id: value.definition_id,
    kind: value.kind as ClientComponentKind,
    platform: installation.platform,
    is_root: value.is_root,
    status: value.status,
    dpop_jkt: value.dpop_jkt,
    granted_features: [...grantedFeatures] as string[],
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
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "provider", "level", "source", "parent_component_id", "parent_attestation_provider",
    "delegation_id", "verified_at", "expires_at",
  ]) ||
      typeof value.provider !== "string" || typeof value.level !== "string" ||
      !trustLevels.has(value.level as TrustSummary["level"]) || typeof value.verified_at !== "string" ||
      !isISODate(value.verified_at) || typeof value.expires_at !== "string" || !isISODate(value.expires_at) ||
      (value.source !== undefined && (typeof value.source !== "string" ||
        !trustSources.has(value.source as NonNullable<TrustSummary["source"]>))) ||
      (value.parent_component_id !== undefined && (typeof value.parent_component_id !== "string" ||
        !/^cmp_[A-Za-z0-9_-]{16,128}$/u.test(value.parent_component_id))) ||
      (value.parent_attestation_provider !== undefined &&
        (typeof value.parent_attestation_provider !== "string" ||
          !/^[a-z][a-z0-9_-]{0,62}$/u.test(value.parent_attestation_provider))) ||
      (value.delegation_id !== undefined && (typeof value.delegation_id !== "string" ||
        !/^dlg_[A-Za-z0-9_-]{16,128}$/u.test(value.delegation_id))) ||
      Date.parse(value.expires_at) <= Date.parse(value.verified_at)) {
    throw invalidResponse("trust summary");
  }
  return {
    provider: value.provider,
    level: value.level as TrustSummary["level"],
    verified_at: value.verified_at,
    expires_at: value.expires_at,
    ...(value.source === undefined ? {} : { source: value.source as NonNullable<TrustSummary["source"]> }),
    ...(value.parent_component_id === undefined ? {} : { parent_component_id: value.parent_component_id as string }),
    ...(value.parent_attestation_provider === undefined
      ? {}
      : { parent_attestation_provider: value.parent_attestation_provider as string }),
    ...(value.delegation_id === undefined ? {} : { delegation_id: value.delegation_id as string }),
  };
}

function validateTrustProvenance(
  component: ClientComponentSummary | undefined,
  trust: TrustSummary,
): void {
  if (component === undefined) return;
  if (trust.source === undefined) throw invalidResponse("component trust provenance");
  const delegatedSource = trust.source === "delegated_from_attested_root" ||
    trust.source === "delegated_identity_only" || trust.source === "delegated_direct_attested";
  const hasDelegation = trust.parent_component_id !== undefined ||
    trust.parent_attestation_provider !== undefined || trust.delegation_id !== undefined;
  if (component.is_root) {
    if (delegatedSource || hasDelegation) {
      throw invalidResponse("component trust provenance");
    }
    return;
  }
  if (!delegatedSource || trust.parent_component_id === undefined ||
      trust.parent_attestation_provider === undefined || trust.delegation_id === undefined) {
    throw invalidResponse("component trust provenance");
  }
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

function isBase64urlWithDecodedLength(value: string, minimum: number, maximum: number): boolean {
  try {
    const length = base64urlDecode(value).length;
    return length >= minimum && length <= maximum;
  } catch {
    return false;
  }
}

function invalidResponse(kind: string): LatchwayError {
  return new LatchwayError("protocol_response_invalid", `Latchway returned an invalid ${kind}.`);
}
