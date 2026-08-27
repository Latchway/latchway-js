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

export interface LatchwayErrorOptions {
  status?: number | undefined;
  requestID?: string | undefined;
  retryable?: boolean | undefined;
  retryAfter?: string | undefined;
  feature?: string | undefined;
  validationErrors?: readonly Readonly<{ path: string; message: string }>[] | undefined;
  cause?: unknown;
}

export class LatchwayError extends Error {
  readonly code: LatchwayErrorCode;
  readonly status: number | undefined;
  readonly requestID: string | undefined;
  readonly retryable: boolean;
  readonly retryAfter: string | undefined;
  readonly feature: string | undefined;
  readonly validationErrors: readonly Readonly<{ path: string; message: string }>[] | undefined;

  constructor(code: LatchwayErrorCode, message: string, options: LatchwayErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LatchwayError";
    this.code = code;
    this.status = options.status;
    this.requestID = options.requestID;
    this.retryable = options.retryable ?? false;
    this.retryAfter = options.retryAfter;
    this.feature = options.feature;
    this.validationErrors = options.validationErrors;
  }
}

const serverCodes = new Set<LatchwayServerErrorCode>([
  "request_invalid", "identity_token_missing", "identity_token_invalid", "identity_token_expired",
  "identity_reauthentication_required", "attestation_required", "attestation_unsupported",
  "attestation_invalid", "attestation_stale", "attestation_step_up_required", "dpop_missing",
  "dpop_invalid", "dpop_replayed", "dpop_nonce_required", "session_expired", "session_revoked",
  "refresh_token_reused", "installation_revoked", "feature_not_found", "feature_not_allowed",
  "model_not_allowed", "quota_exceeded", "concurrency_exceeded", "output_limit_exceeded",
  "pricing_unavailable", "route_not_found", "upstream_unavailable", "upstream_timeout",
  "upstream_protocol_error", "configuration_invalid", "server_not_ready",
  "protocol_version_unsupported", "authentication_required", "permission_denied", "resource_not_found",
  "conflict", "etag_required", "etag_mismatch", "bootstrap_disabled", "rate_limited", "internal_error",
]);

interface ProblemDocument {
  title?: unknown;
  detail?: unknown;
  status?: unknown;
  code?: unknown;
  request_id?: unknown;
  retryable?: unknown;
  retry_after?: unknown;
  feature?: unknown;
  errors?: unknown;
}

export async function errorFromResponse(response: Response): Promise<LatchwayError> {
  const requestID = response.headers.get("X-Latchway-Request-ID") ?? undefined;
  const problem = await readProblem(response);
  if (problem === undefined || typeof problem.code !== "string" || !serverCodes.has(problem.code as LatchwayServerErrorCode)) {
    return new LatchwayError("protocol_response_invalid", `Latchway returned HTTP ${response.status}.`, {
      status: response.status,
      requestID,
    });
  }

  const detail = typeof problem.detail === "string" ? problem.detail :
    typeof problem.title === "string" ? problem.title : `Latchway returned HTTP ${response.status}.`;
  const validationErrors = Array.isArray(problem.errors)
    ? problem.errors.flatMap((entry) => isValidationError(entry) ? [{ path: entry.path, message: entry.message }] : [])
    : undefined;
  return new LatchwayError(problem.code as LatchwayServerErrorCode, detail, {
    status: typeof problem.status === "number" ? problem.status : response.status,
    requestID: typeof problem.request_id === "string" ? problem.request_id : requestID,
    retryable: problem.retryable === true,
    retryAfter: typeof problem.retry_after === "string" ? problem.retry_after : undefined,
    feature: typeof problem.feature === "string" ? problem.feature : undefined,
    validationErrors,
  });
}

async function readProblem(response: Response): Promise<ProblemDocument | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isValidationError(value: unknown): value is { path: string; message: string } {
  return isObject(value) && typeof value.path === "string" && typeof value.message === "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
