import { LatchwayError } from "../errors.js";
import type {
  AttestationContext,
  AttestationProvider,
  AttestationProviderID,
} from "../types.js";

export interface CustomAttestationProviderOptions {
  provider: AttestationProviderID;
  getEvidence(context: AttestationContext): Promise<Readonly<Record<string, unknown>>>;
}

export function createCustomAttestationProvider(options: CustomAttestationProviderOptions): AttestationProvider {
  if (options.provider === "app_attest" || options.provider === "play_integrity") {
    throw new LatchwayError(
      "client_configuration_invalid",
      "Native hardware attestation must be implemented by the native Latchway SDK.",
    );
  }
  if (!new Set(["firebase_app_check", "turnstile", "debug"]).has(options.provider) ||
      typeof options.getEvidence !== "function") {
    throw new LatchwayError("client_configuration_invalid", "The custom attestation provider configuration is invalid.");
  }
  return {
    provider: options.provider,
    getEvidence: (context) => options.getEvidence(context),
  };
}
