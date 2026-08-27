import {
  createCustomAttestationProvider,
  createNodeLatchwayClient,
} from "@latchway/client/node";

export interface ConformanceDependencies {
  baseURL: string;
  getIdentityToken(): Promise<string>;
  getDebugEvidence(): Promise<Readonly<Record<string, unknown>>>;
}

export function createConformanceClient(dependencies: ConformanceDependencies) {
  return createNodeLatchwayClient({
    baseURL: dependencies.baseURL,
    allowInsecureHTTP: dependencies.baseURL.startsWith("http://"),
    applicationID: "conformance_client",
    environment: "test",
    identityProvider: "custom_jwt",
    identityTokenProvider: { getIdentityToken: dependencies.getIdentityToken },
    attestationProviders: [createCustomAttestationProvider({
      provider: "debug",
      getEvidence: dependencies.getDebugEvidence,
    })],
    installation: { appVersion: "0.1.0" },
  });
}
