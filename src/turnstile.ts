import { LatchwayError } from "./errors.js";
import type { AttestationContext, AttestationProvider, RefreshAttestationContext } from "./types.js";

export interface TurnstileProviderOptions {
  getToken(context: AttestationContext): Promise<string>;
  getRefreshToken?(context: RefreshAttestationContext): Promise<string>;
  action?: string;
}

export function createTurnstileProvider(options: TurnstileProviderOptions): AttestationProvider {
  if (typeof options.getToken !== "function" ||
      (options.getRefreshToken !== undefined && typeof options.getRefreshToken !== "function")) {
    throw new LatchwayError("client_configuration_invalid", "A Turnstile token callback is required.");
  }
  const provider: AttestationProvider = {
    provider: "turnstile",
    async getEvidence(context) {
      return turnstileEvidence(await options.getToken(context), options.action);
    },
  };
  const getRefreshToken = options.getRefreshToken;
  if (getRefreshToken !== undefined) {
    provider.getRefreshEvidence = async (context) =>
      turnstileEvidence(await getRefreshToken(context), options.action);
  }
  return provider;
}

function turnstileEvidence(token: string, action: string | undefined): Readonly<Record<string, unknown>> {
  if (typeof token !== "string" || token.length === 0) {
    throw new LatchwayError("attestation_provider_missing", "Turnstile did not return a token.");
  }
  return { token, ...(action === undefined ? {} : { action }) };
}
