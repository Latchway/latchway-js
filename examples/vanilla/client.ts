import { createLatchwayClient } from "@latchway/client";
import { createTurnstileProvider } from "@latchway/client/turnstile";

export interface VanillaClientDependencies {
  getIdentityToken(): Promise<string>;
  getTurnstileToken(clientDataHash: string): Promise<string>;
}

export function createVanillaClient(dependencies: VanillaClientDependencies) {
  return createLatchwayClient({
    baseURL: "https://ai.example.com",
    applicationID: "example_web",
    environment: "production",
    identityProvider: "custom_jwt",
    identityTokenProvider: { getIdentityToken: dependencies.getIdentityToken },
    attestationProviders: [createTurnstileProvider({
      getToken: ({ challenge }) => dependencies.getTurnstileToken(
        challenge.attestation.client_data_hash,
      ),
      action: "latchway_session",
    })],
    installation: { appVersion: "1.0.0" },
  });
}
