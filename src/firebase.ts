import { LatchwayError } from "./errors.js";
import type { AttestationProvider, IdentityTokenProvider } from "./types.js";

export function createFirebaseIdentityTokenProvider(
  getIDToken: () => Promise<string>,
): IdentityTokenProvider {
  if (typeof getIDToken !== "function") {
    throw new LatchwayError("client_configuration_invalid", "A Firebase identity-token callback is required.");
  }
  return { getIdentityToken: getIDToken };
}

export interface FirebaseAppCheckToken {
  token: string;
}

export function createFirebaseAppCheckProvider(
  getToken: (forceRefresh: boolean) => Promise<FirebaseAppCheckToken>,
): AttestationProvider {
  if (typeof getToken !== "function") {
    throw new LatchwayError("client_configuration_invalid", "A Firebase App Check callback is required.");
  }
  return {
    provider: "firebase_app_check",
    async getEvidence() {
      return appCheckEvidence(await getToken(true));
    },
    async getRefreshEvidence() {
      return appCheckEvidence(await getToken(true));
    },
  };
}

function appCheckEvidence(result: FirebaseAppCheckToken): Readonly<Record<string, unknown>> {
  if (typeof result.token !== "string" || result.token.length === 0) {
    throw new LatchwayError("attestation_provider_missing", "Firebase App Check did not return a token.");
  }
  return { token: result.token };
}
