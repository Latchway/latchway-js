import { LatchwayError } from "./errors.js";
import type { AttestationContext, AttestationProvider } from "./types.js";

const TURNSTILE_ACTION = /^[A-Za-z0-9_-]{1,32}$/u;
const MAX_TURNSTILE_TOKEN_BYTES = 2_048;

export interface TurnstileProviderOptions {
  getToken(context: AttestationContext): Promise<string>;
  /** Must exactly match the server-side Turnstile verifier configuration. */
  action: string;
}

export function createTurnstileProvider(options: TurnstileProviderOptions): AttestationProvider {
  if (typeof options.getToken !== "function" || !TURNSTILE_ACTION.test(options.action)) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "A Turnstile token callback and valid action are required.",
    );
  }
  return {
    provider: "turnstile",
    async getEvidence(context) {
      const advertisedAction = context.challenge.attestation.provider_options?.action;
      if (advertisedAction !== undefined && advertisedAction !== options.action) {
        throw new LatchwayError(
          "client_configuration_invalid",
          "The Turnstile action does not match the Latchway challenge.",
        );
      }
      return turnstileEvidence(await options.getToken(context));
    },
  };
}

function turnstileEvidence(token: string): Readonly<Record<string, unknown>> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TURNSTILE_TOKEN_BYTES ||
      token.trim() !== token || !isPrintableASCII(token)) {
    throw new LatchwayError("attestation_provider_missing", "Turnstile did not return a token.");
  }
  return { token };
}

function isPrintableASCII(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    if (character <= 0x20 || character > 0x7e) return false;
  }
  return true;
}
