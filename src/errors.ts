import { readBoundedJSON } from "./json.js";

export type LatchwayServerErrorCode =
  | "request_invalid"
  | "identity_token_missing"
  | "identity_token_invalid"
  | "identity_token_expired"
  | "identity_reauthentication_required"
  | "attestation_required"
  | "attestation_unsupported"
  | "attestation_invalid"
  | "attestation_stale"
  | "attestation_step_up_required"
  | "dpop_missing"
  | "dpop_invalid"
  | "dpop_replayed"
  | "dpop_nonce_required"
  | "session_expired"
  | "session_revoked"
  | "refresh_token_reused"
  | "installation_revoked"
  | "installation_family_revoked"
  | "installation_family_not_found"
  | "component_definition_not_found"
  | "component_not_configured"
  | "component_not_provisioned"
  | "component_revoked"
  | "component_key_invalid"
  | "component_key_replaced"
  | "component_delegation_expired"
  | "component_feature_not_granted"
  | "component_parent_trust_expired"
  | "component_direct_attestation_required"
  | "containing_app_setup_required"
  | "framework_integration_unsupported"
  | "framework_version_unsupported"
  | "transport_destination_not_allowed"
  | "transport_request_not_replayable"
  | "feature_not_found"
  | "feature_not_allowed"
  | "model_not_allowed"
  | "quota_exceeded"
  | "concurrency_exceeded"
  | "output_limit_exceeded"
  | "pricing_unavailable"
  | "route_not_found"
  | "upstream_unavailable"
  | "upstream_timeout"
  | "upstream_protocol_error"
  | "configuration_invalid"
  | "server_not_ready"
  | "protocol_version_unsupported"
  | "authentication_required"
  | "permission_denied"
  | "resource_not_found"
  | "conflict"
  | "etag_required"
  | "etag_mismatch"
  | "bootstrap_disabled"
  | "rate_limited"
  | "operation_indeterminate"
  | "internal_error";

export type LatchwayClientErrorCode =
  | "client_configuration_invalid"
  | "storage_unavailable"
  | "crypto_unavailable"
  | "attestation_provider_missing"
  | "protocol_response_invalid"
  | "request_not_replayable"
  | "network_error";

export type LatchwayErrorCode = LatchwayServerErrorCode | LatchwayClientErrorCode;

export type LatchwayErrorDocumentationURL =
  `https://docs.latchway.dev/errors/${LatchwayErrorCode}`;

/** Stable public troubleshooting page for a typed SDK or gateway error. */
export function latchwayErrorDocumentationURL(
  code: LatchwayErrorCode,
): LatchwayErrorDocumentationURL {
  return `https://docs.latchway.dev/errors/${code}`;
}

export interface LatchwayErrorOptions {
  status?: number | undefined;
  requestID?: string | undefined;
  retryable?: boolean | undefined;
  retryAfter?: string | undefined;
  operationID?: string | undefined;
  feature?: string | undefined;
  validationErrors?: readonly Readonly<{ path: string; message: string }>[] | undefined;
  cause?: unknown;
}

export class LatchwayError extends Error {
  readonly code: LatchwayErrorCode;
  readonly documentationURL: LatchwayErrorDocumentationURL;
  readonly status: number | undefined;
  readonly requestID: string | undefined;
  readonly retryable: boolean;
  readonly retryAfter: string | undefined;
  readonly operationID: string | undefined;
  readonly feature: string | undefined;
  readonly validationErrors: readonly Readonly<{ path: string; message: string }>[] | undefined;

  constructor(code: LatchwayErrorCode, message: string, options: LatchwayErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LatchwayError";
    this.code = code;
    this.documentationURL = latchwayErrorDocumentationURL(code);
    Object.defineProperty(this, "documentationURL", {
      configurable: false,
      enumerable: false,
      value: this.documentationURL,
      writable: false,
    });
    this.status = options.status;
    this.requestID = options.requestID;
    this.retryable = options.retryable ?? false;
    this.retryAfter = options.retryAfter;
    this.operationID = options.operationID;
    this.feature = options.feature;
    this.validationErrors = options.validationErrors;
  }
}

interface ServerCodePolicy {
  readonly status: number;
  readonly title: string;
  readonly retryable: boolean;
}

const serverCodePolicies: Readonly<Record<LatchwayServerErrorCode, ServerCodePolicy>> = {
  request_invalid: { status: 400, title: "Invalid request", retryable: false },
  identity_token_missing: { status: 401, title: "Identity token required", retryable: false },
  identity_token_invalid: { status: 401, title: "Identity token invalid", retryable: false },
  identity_token_expired: { status: 401, title: "Identity token expired", retryable: false },
  identity_reauthentication_required: { status: 401, title: "Identity reauthentication required", retryable: false },
  attestation_required: { status: 401, title: "Attestation required", retryable: false },
  attestation_unsupported: { status: 400, title: "Attestation unsupported", retryable: false },
  attestation_invalid: { status: 401, title: "Attestation invalid", retryable: false },
  attestation_stale: { status: 401, title: "Attestation stale", retryable: false },
  attestation_step_up_required: { status: 401, title: "Stronger attestation required", retryable: false },
  dpop_missing: { status: 401, title: "DPoP proof required", retryable: false },
  dpop_invalid: { status: 401, title: "DPoP proof invalid", retryable: false },
  dpop_replayed: { status: 401, title: "DPoP proof replayed", retryable: false },
  dpop_nonce_required: { status: 401, title: "DPoP nonce required", retryable: true },
  session_expired: { status: 401, title: "Session expired", retryable: true },
  session_revoked: { status: 401, title: "Session revoked", retryable: false },
  refresh_token_reused: { status: 401, title: "Refresh token reuse detected", retryable: false },
  installation_revoked: { status: 403, title: "Installation revoked", retryable: false },
  installation_family_revoked: { status: 403, title: "Installation family revoked", retryable: false },
  installation_family_not_found: { status: 404, title: "Installation family not found", retryable: false },
  component_definition_not_found: { status: 404, title: "Component definition not found", retryable: false },
  component_not_configured: { status: 422, title: "Component not configured", retryable: false },
  component_not_provisioned: { status: 403, title: "Component not provisioned", retryable: false },
  component_revoked: { status: 403, title: "Component revoked", retryable: false },
  component_key_invalid: { status: 401, title: "Component key invalid", retryable: false },
  component_key_replaced: { status: 401, title: "Component key replaced", retryable: false },
  component_delegation_expired: { status: 401, title: "Component delegation expired", retryable: false },
  component_feature_not_granted: { status: 403, title: "Component feature not granted", retryable: false },
  component_parent_trust_expired: { status: 401, title: "Parent component trust expired", retryable: false },
  component_direct_attestation_required: { status: 401, title: "Direct component attestation required", retryable: false },
  containing_app_setup_required: { status: 409, title: "Containing app setup required", retryable: false },
  framework_integration_unsupported: { status: 400, title: "Framework integration unsupported", retryable: false },
  framework_version_unsupported: { status: 400, title: "Framework version unsupported", retryable: false },
  transport_destination_not_allowed: { status: 403, title: "Transport destination not allowed", retryable: false },
  transport_request_not_replayable: { status: 409, title: "Transport request not replayable", retryable: false },
  feature_not_found: { status: 404, title: "Feature not found", retryable: false },
  feature_not_allowed: { status: 403, title: "Feature not allowed", retryable: false },
  model_not_allowed: { status: 403, title: "Model not allowed", retryable: false },
  quota_exceeded: { status: 429, title: "Quota exceeded", retryable: true },
  concurrency_exceeded: { status: 429, title: "Concurrency limit exceeded", retryable: true },
  output_limit_exceeded: { status: 400, title: "Output limit exceeded", retryable: false },
  pricing_unavailable: { status: 503, title: "Pricing unavailable", retryable: true },
  route_not_found: { status: 503, title: "No route available", retryable: true },
  upstream_unavailable: { status: 503, title: "Upstream unavailable", retryable: true },
  upstream_timeout: { status: 504, title: "Upstream timeout", retryable: false },
  upstream_protocol_error: { status: 502, title: "Upstream protocol error", retryable: false },
  configuration_invalid: { status: 422, title: "Configuration invalid", retryable: false },
  server_not_ready: { status: 503, title: "Server not ready", retryable: true },
  protocol_version_unsupported: { status: 426, title: "Protocol version unsupported", retryable: false },
  authentication_required: { status: 401, title: "Administrator authentication required", retryable: false },
  permission_denied: { status: 403, title: "Permission denied", retryable: false },
  resource_not_found: { status: 404, title: "Resource not found", retryable: false },
  conflict: { status: 409, title: "Resource conflict", retryable: false },
  etag_required: { status: 428, title: "ETag required", retryable: false },
  etag_mismatch: { status: 412, title: "ETag mismatch", retryable: false },
  bootstrap_disabled: { status: 409, title: "Bootstrap disabled", retryable: false },
  rate_limited: { status: 429, title: "Rate limited", retryable: true },
  operation_indeterminate: { status: 503, title: "Operation outcome indeterminate", retryable: true },
  internal_error: { status: 500, title: "Internal server error", retryable: false },
};

const problemKeys = new Set([
  "type", "title", "status", "detail", "code", "request_id", "retryable", "instance",
  "retry_after", "operation_id", "feature", "supported_protocol_versions", "errors",
]);

interface ProblemDocument extends Record<string, unknown> {
  type: string;
  title: string;
  detail: string;
  status: number;
  code: LatchwayServerErrorCode;
  request_id: string;
  retryable: boolean;
  retry_after?: string;
  operation_id?: string;
  feature?: string;
  errors?: readonly { path: string; message: string }[];
}

export async function errorFromResponse(response: Response): Promise<LatchwayError> {
  const rawRequestID = response.headers.get("X-Latchway-Request-ID");
  const requestID = rawRequestID !== null && isRequestID(rawRequestID) ? rawRequestID : undefined;
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  const problem = await readProblem(response);
  if (contentType !== "application/problem+json" || requestID === undefined || problem === undefined ||
      !isProblemDocument(problem, response.status, requestID)) {
    return new LatchwayError("protocol_response_invalid", `Latchway returned HTTP ${response.status}.`, {
      status: response.status,
      requestID,
    });
  }

  return new LatchwayError(problem.code, problem.detail, {
    status: problem.status,
    requestID: problem.request_id,
    retryable: problem.retryable,
    retryAfter: problem.retry_after,
    operationID: problem.operation_id,
    feature: problem.feature,
    validationErrors: problem.errors,
  });
}

async function readProblem(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = await readBoundedJSON(response);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isProblemDocument(
  value: Record<string, unknown>,
  responseStatus: number,
  responseRequestID: string,
): value is ProblemDocument {
  if (Object.keys(value).some((key) => !problemKeys.has(key)) || !isServerCode(value.code)) return false;
  const policy = serverCodePolicies[value.code];
  if (value.type !== `https://latchway.dev/problems/${value.code}` || value.title !== policy.title ||
      value.status !== responseStatus || value.status !== policy.status || value.retryable !== policy.retryable ||
      typeof value.detail !== "string" || value.detail.length < 1 || value.detail.length > 2_048 ||
      value.request_id !== responseRequestID || !isRequestID(value.request_id)) {
    return false;
  }
  if (Object.hasOwn(value, "instance") && !isURIReference(value.instance)) return false;
  if (Object.hasOwn(value, "retry_after") && !isISODate(value.retry_after)) return false;
  if (Object.hasOwn(value, "feature") &&
      (typeof value.feature !== "string" || !/^[a-z][a-z0-9_-]{0,62}$/u.test(value.feature))) return false;
  if (Object.hasOwn(value, "supported_protocol_versions") &&
      !isProtocolVersions(value.supported_protocol_versions)) return false;
  if (Object.hasOwn(value, "errors") && !isValidationErrors(value.errors)) return false;

  const operationID = typeof value.operation_id === "string" ? value.operation_id : undefined;
  return value.code === "operation_indeterminate"
    ? isOperationID(operationID)
    : !Object.hasOwn(value, "operation_id");
}

function isOperationID(value: string | undefined): value is string {
  return value !== undefined && /^arq_[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$/.test(value);
}

function isServerCode(value: unknown): value is LatchwayServerErrorCode {
  return typeof value === "string" && Object.hasOwn(serverCodePolicies, value);
}

function isRequestID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value);
}

function isISODate(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function isURIReference(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2_048 &&
    Array.from(value).every((character) => character.charCodeAt(0) > 0x20 && character.charCodeAt(0) !== 0x7f);
}

function isProtocolVersions(value: unknown): value is readonly number[] {
  if (!Array.isArray(value)) return false;
  const versions = new Set<number>();
  for (const version of value) {
    if (!Number.isSafeInteger(version) || version < 1 || versions.has(version as number)) return false;
    versions.add(version as number);
  }
  return true;
}

function isValidationErrors(value: unknown): value is readonly { path: string; message: string }[] {
  return Array.isArray(value) && value.length <= 100 && value.every((entry) =>
    isObject(entry) && Object.keys(entry).length === 2 && Object.hasOwn(entry, "path") &&
    Object.hasOwn(entry, "message") && typeof entry.path === "string" && entry.path.length <= 512 &&
    typeof entry.message === "string" && entry.message.length <= 1_024);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
