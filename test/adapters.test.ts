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
    const getRefreshEvidence = provider.getRefreshEvidence;
    if (getRefreshEvidence === undefined) throw new Error("Firebase adapter must support refresh evidence.");
    await expect(getRefreshEvidence({
      applicationID: context.applicationID,
      environment: context.environment,
      dpopJkt: context.dpopJkt,
      platform: context.platform,
    })).resolves.toEqual({ token: "firebase-app-check-token" });
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenNthCalledWith(1, true);
    expect(getToken).toHaveBeenNthCalledWith(2, true);
  });

  it("passes the exact challenge context to a caller-managed Turnstile flow", async () => {
    const getToken = vi.fn(async (_context: AttestationContext) => "turnstile-token");
    const provider = createTurnstileProvider({ getToken, action: "latchway_session" });
    await expect(provider.getEvidence(context)).resolves.toEqual({
      token: "turnstile-token",
      action: "latchway_session",
    });
    expect(getToken).toHaveBeenCalledWith(context);
  });
});
