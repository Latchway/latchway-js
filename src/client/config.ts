import { LatchwayError } from "../errors.js";
import { AdaptiveStateStore } from "../storage/adaptive.js";
import { IndexedDBStateStore } from "../storage/indexeddb.js";
import type { StateStore } from "../storage/state.js";
import type {
  AttestationProvider,
  FetchImplementation,
  InstallationMetadata,
  LatchwayOptions,
  PersistenceMode,
  Platform,
} from "../types.js";
import { SDK_VERSION } from "../version.js";

export interface RuntimeConfiguration {
  baseURL: URL;
  applicationID: string;
  environment: string;
  identityProvider: string;
  identityTokenProvider: LatchwayOptions["identityTokenProvider"];
  attestationProviders: readonly AttestationProvider[];
  installation: InstallationMetadata;
  fetch: FetchImplementation;
  runtimeCrypto: Crypto;
  platform: Platform;
  store: StateStore;
}

export function configure(
  options: LatchwayOptions,
  platform: Platform,
  runtimeCrypto: Crypto | undefined,
): RuntimeConfiguration {
  if (runtimeCrypto?.subtle === undefined) {
    throw new LatchwayError("crypto_unavailable", "This runtime does not provide WebCrypto SubtleCrypto.");
  }
  const baseURL = parseBaseURL(options.baseURL, options.allowInsecureHTTP === true);
  const applicationID = applicationResourceID(options.applicationID);
  const environment = identifier(options.environment, "environment");
  const identityProvider = identifier(options.identityProvider ?? "custom_jwt", "identityProvider");
  const identityTokenProvider = options.identityTokenProvider as unknown;
  if (typeof identityTokenProvider !== "object" || identityTokenProvider === null ||
      typeof Reflect.get(identityTokenProvider, "getIdentityToken") !== "function") {
    throw new LatchwayError("client_configuration_invalid", "identityTokenProvider is required.");
  }
  const globalFetch = Reflect.get(globalThis, "fetch") as FetchImplementation | undefined;
  const fetchImplementation = options.fetch ?? globalFetch?.bind(globalThis);
  if (typeof fetchImplementation !== "function") {
    throw new LatchwayError("client_configuration_invalid", "A Fetch API implementation is required.");
  }
  const candidates = options.attestationProviders ?? [];
  if (!Array.isArray(candidates)) {
    throw new LatchwayError("client_configuration_invalid", "attestationProviders must be an array.");
  }
  const attestationProviders = candidates as readonly AttestationProvider[];
  const seen = new Set<string>();
  for (const provider of attestationProviders) {
    if (!new Set(["app_attest", "play_integrity", "firebase_app_check", "turnstile", "debug"]).has(provider.provider) ||
        typeof provider.getEvidence !== "function") {
      throw new LatchwayError("client_configuration_invalid", "An attestation provider is invalid.");
    }
    if (seen.has(provider.provider)) {
      throw new LatchwayError("client_configuration_invalid", `Attestation provider ${provider.provider} is configured more than once.`);
    }
    seen.add(provider.provider);
  }
  const installation: InstallationMetadata = {
    appVersion: boundedString(options.installation?.appVersion ?? SDK_VERSION, "installation.appVersion", 128),
    ...(options.installation?.osVersion === undefined
      ? {}
      : { osVersion: boundedString(options.installation.osVersion, "installation.osVersion", 128) }),
    ...(options.installation?.deviceModel === undefined
      ? {}
      : { deviceModel: boundedString(options.installation.deviceModel, "installation.deviceModel", 128) }),
  };
  const mode = options.persistence?.mode ?? (platform === "node" ? "memory" : "required");
  if (!new Set<PersistenceMode>(["required", "allow-memory", "memory"]).has(mode)) {
    throw new LatchwayError("client_configuration_invalid", "persistence.mode is invalid.");
  }
  const databaseName = options.persistence?.databaseName ?? "latchway-client-v1";
  if (databaseName.length === 0 || databaseName.length > 128) {
    throw new LatchwayError("client_configuration_invalid", "persistence.databaseName must contain 1 to 128 characters.");
  }
  const idb = platform === "web" ? globalThis.indexedDB : undefined;
  const scope = `${baseURL.origin}|${applicationID}|${environment}|${platform}`;
  const primary = idb === undefined ? undefined : new IndexedDBStateStore(
    idb,
    databaseName,
    scope,
  );
  return {
    baseURL,
    applicationID,
    environment,
    identityProvider,
    identityTokenProvider: options.identityTokenProvider,
    attestationProviders,
    installation,
    fetch: fetchImplementation,
    runtimeCrypto,
    platform,
    store: new AdaptiveStateStore(primary, mode),
  };
}

function parseBaseURL(value: string, allowInsecureHTTP: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new LatchwayError("client_configuration_invalid", "baseURL must be an absolute URL.", { cause });
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new LatchwayError("client_configuration_invalid", "baseURL must not contain credentials, a query, or a fragment.");
  }
  if (url.pathname !== "/") {
    throw new LatchwayError("client_configuration_invalid", "baseURL must identify the gateway origin without a path prefix.");
  }
  if (url.protocol !== "https:" && !(allowInsecureHTTP && url.protocol === "http:")) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "baseURL must use HTTPS. Local conformance may opt into HTTP with allowInsecureHTTP.",
    );
  }
  return new URL(url.origin);
}

function identifier(value: string, field: string): string {
  if (!/^[a-z][a-z0-9_-]{0,62}$/u.test(value)) {
    throw new LatchwayError("client_configuration_invalid", `${field} must be a lowercase Latchway identifier.`);
  }
  return value;
}

function applicationResourceID(value: string): string {
  if (!/^app_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value)) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "applicationID must be the generated Latchway application resource ID.",
    );
  }
  return value;
}

function boundedString(value: string, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new LatchwayError("client_configuration_invalid", `${field} must contain between 1 and ${maximum} characters.`);
  }
  return value;
}
