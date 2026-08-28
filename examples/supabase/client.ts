import { createLatchwayClient } from "@latchway/client";
import { createTurnstileProvider } from "@latchway/client/turnstile";

export interface SupabaseDependencies {
  getAccessToken(): Promise<string>;
  getTurnstileToken(options: Readonly<{ action: string; cData: string }>): Promise<string>;
}

export function createSupabaseClient(dependencies: SupabaseDependencies) {
  return createLatchwayClient({
    baseURL: "https://ai.example.com",
    applicationID: "example_supabase_web",
    environment: "production",
    identityProvider: "supabase",
    identityTokenProvider: { getIdentityToken: dependencies.getAccessToken },
    attestationProviders: [createTurnstileProvider({
      getToken: ({ challenge }) => dependencies.getTurnstileToken({
        action: "latchway_session",
        cData: challenge.attestation.client_data_hash,
      }),
      action: "latchway_session",
    })],
    installation: { appVersion: "1.0.0" },
  });
}
