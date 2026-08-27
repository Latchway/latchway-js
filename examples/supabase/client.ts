import { createLatchwayClient } from "@latchway/client";
import { createTurnstileProvider } from "@latchway/client/turnstile";

export interface SupabaseDependencies {
  getAccessToken(): Promise<string>;
  getTurnstileToken(clientDataHash: string): Promise<string>;
}

export function createSupabaseClient(dependencies: SupabaseDependencies) {
  return createLatchwayClient({
    baseURL: "https://ai.example.com",
    applicationID: "example_supabase_web",
    environment: "production",
    identityProvider: "supabase",
    identityTokenProvider: { getIdentityToken: dependencies.getAccessToken },
    attestationProviders: [createTurnstileProvider({
      getToken: ({ challenge }) => dependencies.getTurnstileToken(
        challenge.attestation.client_data_hash,
      ),
    })],
    installation: { appVersion: "1.0.0" },
  });
}
