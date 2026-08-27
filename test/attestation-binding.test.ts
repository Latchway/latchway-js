import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  attestationBindingHash,
  canonicalizeAttestationBinding,
  type AttestationBinding,
} from "../src/attestation/binding.js";

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

describe("canonical attestation binding", () => {
  it("matches every RFC 8785 contract vector", async () => {
    expect(fixture.canonicalization).toBe("RFC 8785 JCS");
    for (const vector of fixture.vectors) {
      expect(canonicalizeAttestationBinding(vector.input), vector.id).toBe(vector.canonical_json);
      await expect(attestationBindingHash(webcrypto as unknown as Crypto, vector.input), vector.id)
        .resolves.toBe(vector.sha256_base64url);
    }
  });
});
