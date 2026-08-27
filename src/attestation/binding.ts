import { base64urlEncode, utf8 } from "../encoding.js";
import { LatchwayError } from "../errors.js";

export interface AttestationBinding {
  version: 1;
  challenge_id: string;
  challenge_nonce: string;
  application_id: string;
  environment: string;
  principal_id: string;
  dpop_jkt: string;
  platform: "ios" | "android" | "web" | "react_native_ios" | "react_native_android" | "node";
  issued_at: number;
}

export function canonicalizeAttestationBinding(binding: AttestationBinding): string {
  if (!Number.isSafeInteger(binding.issued_at) || binding.issued_at < 0) {
    throw new LatchwayError("client_configuration_invalid", "The attestation binding is invalid.");
  }
  for (const value of [
    binding.application_id,
    binding.challenge_id,
    binding.challenge_nonce,
    binding.dpop_jkt,
    binding.environment,
    binding.platform,
    binding.principal_id,
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new LatchwayError("client_configuration_invalid", "The attestation binding contains an empty field.");
    }
  }
  // The schema is flat and restricted to strings plus safe integers. Sorting
  // these fixed property names is the RFC 8785 JCS representation.
  return JSON.stringify({
    application_id: binding.application_id,
    challenge_id: binding.challenge_id,
    challenge_nonce: binding.challenge_nonce,
    dpop_jkt: binding.dpop_jkt,
    environment: binding.environment,
    issued_at: binding.issued_at,
    platform: binding.platform,
    principal_id: binding.principal_id,
    version: binding.version,
  });
}

export async function attestationBindingHash(runtimeCrypto: Crypto, binding: AttestationBinding): Promise<string> {
  const canonical = canonicalizeAttestationBinding(binding);
  return base64urlEncode(new Uint8Array(await runtimeCrypto.subtle.digest("SHA-256", utf8(canonical))));
}
