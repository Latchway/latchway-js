import { createCustomAttestationProvider, createLatchwayClient } from "@latchway/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const marker = "latchway-vite-react-fixture";
const feature = "habit-assistant";

function App() {
  const configure = () => createLatchwayClient({
    baseURL: "https://ai.example.com",
    applicationID: "app_01J00000000000000000000000",
    environment: "production",
    identityTokenProvider: { getIdentityToken: async () => "fixture-identity-token" },
    attestationProviders: [createCustomAttestationProvider({
      provider: "firebase_app_check",
      getEvidence: async () => ({ token: "provided-at-runtime" }),
    })],
  }).fetchFor(feature);
  return <button type="button" onClick={() => { void configure(); }}>{marker}:{feature}</button>;
}

const root = document.querySelector("#root");
if (root === null) throw new Error("React fixture root is missing.");
createRoot(root).render(<StrictMode><App /></StrictMode>);
