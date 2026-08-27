import { createLatchwayClient } from "@latchway/client";
import {
  createFirebaseAppCheckProvider,
  createFirebaseIdentityTokenProvider,
  type FirebaseAppCheckToken,
} from "@latchway/client/firebase";

export interface FirebaseDependencies {
  getIDToken(): Promise<string>;
  getAppCheckToken(forceRefresh: boolean): Promise<FirebaseAppCheckToken>;
}

export function createFirebaseClient(dependencies: FirebaseDependencies) {
  return createLatchwayClient({
    baseURL: "https://ai.example.com",
    applicationID: "example_firebase_web",
    environment: "production",
    identityProvider: "firebase",
    identityTokenProvider: createFirebaseIdentityTokenProvider(dependencies.getIDToken),
    attestationProviders: [createFirebaseAppCheckProvider(dependencies.getAppCheckToken)],
    installation: { appVersion: "1.0.0" },
  });
}
