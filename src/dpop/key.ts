import { base64urlEncode, utf8 } from "../encoding.js";
import { LatchwayError } from "../errors.js";

export interface P256PublicJWK {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface InstallationKeyRecord {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: P256PublicJWK;
  thumbprint: string;
}

export async function generateInstallationKey(runtimeCrypto: Crypto): Promise<InstallationKeyRecord> {
  let pair: CryptoKeyPair;
  try {
    pair = await runtimeCrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
  } catch (cause) {
    throw new LatchwayError("crypto_unavailable", "The runtime could not create a P-256 installation key.", { cause });
  }
  const publicJwk = toPublicJwk(await runtimeCrypto.subtle.exportKey("jwk", pair.publicKey));
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk,
    thumbprint: await jwkThumbprint(runtimeCrypto, publicJwk),
  };
}

export async function importP256TestKey(
  runtimeCrypto: Crypto,
  privateJwk: JsonWebKey,
): Promise<InstallationKeyRecord> {
  const publicJwk = toPublicJwk(privateJwk);
  const [privateKey, publicKey] = await Promise.all([
    runtimeCrypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    runtimeCrypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]),
  ]);
  return { privateKey, publicKey, publicJwk, thumbprint: await jwkThumbprint(runtimeCrypto, publicJwk) };
}

export async function jwkThumbprint(runtimeCrypto: Crypto, jwk: P256PublicJWK): Promise<string> {
  const canonical = `{"crv":"P-256","kty":"EC","x":${JSON.stringify(jwk.x)},"y":${JSON.stringify(jwk.y)}}`;
  return base64urlEncode(new Uint8Array(await runtimeCrypto.subtle.digest("SHA-256", utf8(canonical))));
}

export function toPublicJwk(value: JsonWebKey): P256PublicJWK {
  if (value.kty !== "EC" || value.crv !== "P-256" || typeof value.x !== "string" || typeof value.y !== "string") {
    throw new LatchwayError("crypto_unavailable", "The installation key did not produce a valid P-256 public JWK.");
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value.x) || !/^[A-Za-z0-9_-]{43}$/u.test(value.y)) {
    throw new LatchwayError("crypto_unavailable", "The installation key contains an invalid P-256 coordinate.");
  }
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y };
}
