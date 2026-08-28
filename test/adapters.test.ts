import { describe, expect, it, vi } from "vitest";

import {
  createFirebaseAppCheckProvider,
  createFirebaseIdentityTokenProvider,
} from "../src/firebase.js";
import { createTurnstileProvider } from "../src/turnstile.js";
import type { AttestationContext } from "../src/types.js";

const context: AttestationContext = {
  applicationID: "app_web",
  environment: "production",
  dpopJkt: "j".repeat(43),
  platform: "web",
  challenge: {
    challenge_id: `chl_${"c".repeat(20)}`,
    challenge_nonce: "n".repeat(43),
    binding_version: 1,
    issued_at: 1_787_820_002,
    expires_at: "2026-08-27T12:05:00Z",
    attestation: {
      provider: "turnstile",
      mode: "required",
      client_data_hash: "h".repeat(43),
    },
  },
};

describe("provider adapters", () => {
  it("delegates Firebase identity without importing or mutating Firebase", async () => {
    const getToken = vi.fn(async () => "firebase-identity-token");
    await expect(createFirebaseIdentityTokenProvider(getToken).getIdentityToken())
      .resolves.toBe("firebase-identity-token");
    expect(getToken).toHaveBeenCalledOnce();
  });

  it("requests a fresh Firebase App Check token", async () => {
    const getToken = vi.fn(async (_forceRefresh: boolean) => ({ token: "firebase-app-check-token" }));
    const provider = createFirebaseAppCheckProvider(getToken);
    await expect(provider.getEvidence(context)).resolves.toEqual({ token: "firebase-app-check-token" });
    expect(getToken).toHaveBeenCalledOnce();
    expect(getToken).toHaveBeenCalledWith(true);
  });

  it("passes the exact challenge context to a caller-managed Turnstile flow", async () => {
    const getToken = vi.fn(async (_context: AttestationContext) => "turnstile-token");
    const provider = createTurnstileProvider({ getToken, action: "latchway_session" });
    await expect(provider.getEvidence(context)).resolves.toEqual({ token: "turnstile-token" });
    expect(getToken).toHaveBeenCalledWith(context);
  });

  it("fails closed on invalid actions, challenge mismatch, and malformed tokens", async () => {
    expect(() => createTurnstileProvider({
      getToken: async () => "turnstile-token",
      action: "action with spaces",
    })).toThrowError(/Turnstile token callback and valid action/u);

    const mismatched = createTurnstileProvider({
      getToken: async () => "turnstile-token",
      action: "latchway_session",
    });
    await expect(mismatched.getEvidence({
      ...context,
      challenge: {
        ...context.challenge,
        attestation: {
          ...context.challenge.attestation,
          provider_options: { action: "different_action" },
        },
      },
    })).rejects.toThrowError(/does not match/u);

    for (const token of [" token", "token\n", "t".repeat(2_049)]) {
      const provider = createTurnstileProvider({
        getToken: async () => token,
        action: "latchway_session",
      });
      await expect(provider.getEvidence(context)).rejects.toThrowError(/did not return a token/u);
    }
  });
});
