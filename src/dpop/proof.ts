import { base64urlEncode, randomID, utf8 } from "../encoding.js";
import { LatchwayError } from "../errors.js";
import type { InstallationKeyRecord } from "./key.js";

export interface DPoPProofInput {
  method: string;
  url: string | URL;
  accessToken?: string;
  nonce?: string;
  issuedAt?: number;
  proofID?: string;
}

export async function createDPoPProof(
  runtimeCrypto: Crypto,
  key: InstallationKeyRecord,
  input: DPoPProofInput,
): Promise<string> {
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: key.publicJwk,
  } as const;
  const payload: Record<string, string | number> = {
    htm: normalizeMethod(input.method),
    htu: normalizeHTU(input.url),
    iat: input.issuedAt ?? Math.floor(Date.now() / 1000),
    jti: input.proofID ?? randomID(runtimeCrypto),
  };
  if (input.accessToken !== undefined) {
    payload.ath = await accessTokenHash(runtimeCrypto, input.accessToken);
  }
  if (input.nonce !== undefined) payload.nonce = input.nonce;

  const protectedHeader = base64urlEncode(utf8(JSON.stringify(header)));
  const protectedPayload = base64urlEncode(utf8(JSON.stringify(payload)));
  const signingInput = `${protectedHeader}.${protectedPayload}`;
  let signature: ArrayBuffer;
  try {
    signature = await runtimeCrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      utf8(signingInput),
    );
  } catch (cause) {
    throw new LatchwayError("crypto_unavailable", "The installation key could not sign a DPoP proof.", { cause });
  }
  const bytes = new Uint8Array(signature);
  if (bytes.byteLength !== 64) {
    throw new LatchwayError("crypto_unavailable", "The runtime returned a non-standard ES256 signature.");
  }
  return `${signingInput}.${base64urlEncode(bytes)}`;
}

export async function accessTokenHash(runtimeCrypto: Crypto, accessToken: string): Promise<string> {
  return base64urlEncode(new Uint8Array(await runtimeCrypto.subtle.digest("SHA-256", utf8(accessToken))));
}

export function normalizeHTU(input: string | URL): string {
  const url = input instanceof URL ? new URL(input.href) : new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LatchwayError("client_configuration_invalid", "DPoP only supports HTTP and HTTPS request URIs.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new LatchwayError("client_configuration_invalid", "Request URIs must not contain user information.");
  }
  url.hash = "";
  url.search = "";
  return `${url.origin}${url.pathname}`;
}

function normalizeMethod(method: string): string {
  const normalized = method.toUpperCase();
  if (!/^[A-Z]+$/u.test(normalized)) {
    throw new LatchwayError("client_configuration_invalid", "The HTTP method is invalid.");
  }
  return normalized;
}
