import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import { base64urlDecode, decodeUTF8, utf8 } from "../src/encoding.js";
import { generateInstallationKey, importP256TestKey, jwkThumbprint, type P256PublicJWK } from "../src/dpop/key.js";
import { accessTokenHash, createDPoPProof, normalizeHTU } from "../src/dpop/proof.js";

interface DPoPFixture {
  fixture_access_token: string;
  fixture_access_token_hash: string;
  public_jwk: P256PublicJWK;
  private_jwk_for_tests_only: JsonWebKey;
  jwk_thumbprint_sha256_base64url: string;
  vectors: Array<{
    id: string;
    proof: string;
    request: { method: string; uri: string; use_fixture_access_token?: boolean; required_nonce?: string };
    expected: { valid: boolean; error_code?: string };
  }>;
}

const crypto = webcrypto as unknown as Crypto;
const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/contract/dpop-v1.json", import.meta.url),
  "utf8",
)) as DPoPFixture;

describe("DPoP contract vectors", () => {
  it("matches the RFC 7638 thumbprint and access-token hash", async () => {
    await expect(jwkThumbprint(crypto, fixture.public_jwk)).resolves.toBe(fixture.jwk_thumbprint_sha256_base64url);
    await expect(accessTokenHash(crypto, fixture.fixture_access_token)).resolves.toBe(fixture.fixture_access_token_hash);
  });

  it("verifies every canonical fixture signature and expected claims", async () => {
    for (const vector of fixture.vectors) {
      const [encodedHeader, encodedPayload, encodedSignature] = splitProof(vector.proof);
      const header = JSON.parse(decodeUTF8(base64urlDecode(encodedHeader))) as { jwk: JsonWebKey; typ: string; alg: string };
      const payload = JSON.parse(decodeUTF8(base64urlDecode(encodedPayload))) as Record<string, unknown>;
      const publicJwk = { kty: header.jwk.kty, crv: header.jwk.crv, x: header.jwk.x, y: header.jwk.y };
      const key = await crypto.subtle.importKey(
        "jwk",
        publicJwk as JsonWebKey,
        { name: "ECDSA", namedCurve: "P-256" } as EcKeyImportParams,
        true,
        ["verify"],
      );
      await expect(crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        base64urlDecode(encodedSignature),
        utf8(`${encodedHeader}.${encodedPayload}`),
      )).resolves.toBe(true);
      expect(header.typ).toBe("dpop+jwt");
      expect(header.alg).toBe("ES256");
      if (vector.expected.valid) {
        expect(payload.htm).toBe(vector.request.method);
        expect(payload.htu).toBe(normalizeHTU(vector.request.uri));
        if (vector.request.use_fixture_access_token === true) expect(payload.ath).toBe(fixture.fixture_access_token_hash);
        if (vector.request.required_nonce !== undefined) expect(payload.nonce).toBe(vector.request.required_nonce);
      }
    }
    const privateHeader = decodeHeader(fixture.vectors.find((vector) => vector.id === "private_jwk_member")?.proof);
    expect(privateHeader.jwk).toHaveProperty("d");
  });

  it("creates a verifiable proof with exact method, URI, ath, nonce, iat, and jti", async () => {
    const key = await importP256TestKey(crypto, fixture.private_jwk_for_tests_only);
    const proof = await createDPoPProof(crypto, key, {
      method: "post",
      url: "https://gateway.example.test:443/v1/responses?ignored=yes#fragment",
      accessToken: fixture.fixture_access_token,
      nonce: "nonce-fixture-0123456789abcdef",
      issuedAt: 1_700_000_000,
      proofID: "proof-unique-id",
    });
    const [header, payload, signature] = splitProof(proof);
    expect(JSON.parse(decodeUTF8(base64urlDecode(payload)))).toEqual({
      htm: "POST",
      htu: "https://gateway.example.test/v1/responses",
      iat: 1_700_000_000,
      jti: "proof-unique-id",
      ath: fixture.fixture_access_token_hash,
      nonce: "nonce-fixture-0123456789abcdef",
    });
    await expect(crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key.publicKey,
      base64urlDecode(signature),
      utf8(`${header}.${payload}`),
    )).resolves.toBe(true);
  });

  it("keeps generated private keys non-exportable", async () => {
    const key = await generateInstallationKey(crypto);
    expect(key.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("jwk", key.privateKey)).rejects.toBeInstanceOf(Error);
    expect(key.publicJwk).toMatchObject({ kty: "EC", crv: "P-256" });
  });
});

function splitProof(proof: string): [string, string, string] {
  const parts = proof.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new Error("Invalid fixture proof.");
  return parts as [string, string, string];
}

function decodeHeader(proof: string | undefined): { jwk: JsonWebKey } {
  if (proof === undefined) throw new Error("Fixture is missing private_jwk_member.");
  return JSON.parse(decodeUTF8(base64urlDecode(splitProof(proof)[0]))) as { jwk: JsonWebKey };
}
