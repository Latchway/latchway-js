import { createCustomAttestationProvider, createLatchwayClient } from "@latchway/client";

const marker = "latchway-vite-vanilla-fixture";
const feature = "habit-assistant";

export function configureBrowserClient() {
  const client = createLatchwayClient({
    baseURL: "https://ai.example.com",
    applicationID: "app_01J00000000000000000000000",
    environment: "production",
    identityTokenProvider: { getIdentityToken: async () => "fixture-identity-token" },
    attestationProviders: [createCustomAttestationProvider({
      provider: "turnstile",
      getEvidence: async () => ({ token: "provided-at-runtime" }),
    })],
  });
  return client.fetchFor(feature);
}

const target = document.querySelector("#app");
if (target !== null) target.textContent = `${marker}:${feature}`;
