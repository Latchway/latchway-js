import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  attestationBindingHash,
  canonicalizeAttestationBinding,
  type AttestationBinding,
} from "../src/attestation/binding.js";
import { parseComponentAttestationChallenge } from "../src/session/wire.js";

interface Fixture {
  canonicalization: string;
  vectors: Array<{
    id: string;
    input: AttestationBinding;
    canonical_json: string;
    sha256_base64url: string;
  }>;
}

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/contract/attestation-binding-v1.json", import.meta.url),
  "utf8",
)) as Fixture;

interface ComponentFixture {
  binding_version: number;
  canonicalization: string;
  hash: string;
  vectors: Array<{
    id: string;
    input: Record<string, unknown> & {
      challenge_id: string;
      challenge_nonce: string;
      issued_at: number;
    };
    canonical_json: string;
    utf8_hex: string;
    sha256_hex: string;
    sha256_base64url: string;
  }>;
}

const componentFixture = JSON.parse(readFileSync(
  new URL("./fixtures/contract/component-attestation-binding-v2.json", import.meta.url),
  "utf8",
)) as ComponentFixture;

describe("canonical attestation binding", () => {
  it("matches every RFC 8785 contract vector", async () => {
    expect(fixture.canonicalization).toBe("RFC 8785 JCS");
    for (const vector of fixture.vectors) {
      expect(canonicalizeAttestationBinding(vector.input), vector.id).toBe(vector.canonical_json);
      await expect(attestationBindingHash(webcrypto as unknown as Crypto, vector.input), vector.id)
        .resolves.toBe(vector.sha256_base64url);
    }
  });

  it("validates the component-attestation v2 fixture without reconstructing its server-owned binding", () => {
    expect(componentFixture.binding_version).toBe(2);
    expect(componentFixture.canonicalization).toBe("RFC 8785 JCS");
    expect(componentFixture.hash).toBe("SHA-256");

    for (const vector of componentFixture.vectors) {
      const canonicalBytes = new TextEncoder().encode(vector.canonical_json);
      expect(JSON.parse(vector.canonical_json), vector.id).toEqual(vector.input);
      expect(Buffer.from(canonicalBytes).toString("hex"), vector.id).toBe(vector.utf8_hex);
      expect(createHash("sha256").update(canonicalBytes).digest("hex"), vector.id)
        .toBe(vector.sha256_hex);
      expect(createHash("sha256").update(canonicalBytes).digest("base64url"), vector.id)
        .toBe(vector.sha256_base64url);

      const challenge = parseComponentAttestationChallenge({
        challenge_id: vector.input.challenge_id,
        challenge_nonce: vector.input.challenge_nonce,
        binding_version: 2,
        issued_at: vector.input.issued_at,
        expires_at: new Date((vector.input.issued_at + 300) * 1_000).toISOString(),
        attestation: {
          provider: "app_attest",
          mode: "required",
          client_data_hash: vector.sha256_base64url,
          provider_options: { environment: "production" },
        },
      });
      expect(challenge.binding_version, vector.id).toBe(2);
      expect(challenge.attestation.client_data_hash, vector.id).toBe(vector.sha256_base64url);
    }
  });

  it("rejects component challenges outside the App Attest binding-v2 contract", () => {
    const vector = componentFixture.vectors[0];
    expect(vector).toBeDefined();
    const valid = {
      challenge_id: vector?.input.challenge_id,
      challenge_nonce: vector?.input.challenge_nonce,
      binding_version: 2,
      issued_at: vector?.input.issued_at,
      expires_at: new Date(((vector?.input.issued_at ?? 0) + 300) * 1_000).toISOString(),
      attestation: {
        provider: "app_attest",
        mode: "required",
        client_data_hash: vector?.sha256_base64url,
      },
    };
    for (const candidate of [
      { ...valid, binding_version: 1 },
      { ...valid, challenge_nonce: "A".repeat(42) },
      { ...valid, attestation: { ...valid.attestation, provider: "play_integrity" } },
      { ...valid, attestation: { ...valid.attestation, mode: "preferred" } },
      { ...valid, unexpected: true },
    ]) {
      expect(() => parseComponentAttestationChallenge(candidate)).toThrow(expect.objectContaining({
        code: "protocol_response_invalid",
      }));
    }
  });
});
