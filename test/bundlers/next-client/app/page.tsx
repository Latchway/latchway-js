"use client";

import { createCustomAttestationProvider, createLatchwayClient } from "@latchway/client";
import { useState } from "react";

const marker = "latchway-next-client-fixture";
const feature = "habit-assistant";

export default function Page() {
  const [gateway, setGateway] = useState("not-configured");
  const configure = () => createLatchwayClient({
    baseURL: "https://ai.example.com",
    applicationID: "app_01J00000000000000000000000",
    environment: "production",
    identityTokenProvider: { getIdentityToken: async () => "fixture-identity-token" },
    attestationProviders: [createCustomAttestationProvider({
      provider: "turnstile",
      getEvidence: async () => ({ token: "provided-at-runtime" }),
    })],
  });
  return (
    <main>
      <p>{marker}:{feature}:{gateway}</p>
      <button type="button" onClick={() => { setGateway(configure().gatewayURL); }}>Configure</button>
    </main>
  );
}
