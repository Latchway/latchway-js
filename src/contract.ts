import { LatchwayError } from "./errors.js";

export const clientPaths = {
  createSessionChallenge: "/client/v1/session-challenges",
  exchangeSession: "/client/v1/sessions",
  refreshSession: "/client/v1/sessions/refresh",
  provisionComponent: "/client/v1/installation-families/current/components",
  createComponentSession: "/client/v1/component-sessions",
  revokeCurrentInstallationFamily: "/client/v1/installation-families/current",
  revokeCurrentInstallation: "/client/v1/installations/current",
  diagnostics: "/client/v1/diagnostics",
  component(componentID: string): string {
    return `/client/v1/installation-families/current/components/${encodeURIComponent(componentID)}`;
  },
  featureQuota(feature: string): string {
    return `/client/v1/features/${encodeURIComponent(feature)}/quota`;
  },
} as const;

const structuredDataPlaneMethods: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["/v1/responses", new Set(["POST"])],
  ["/v1/chat/completions", new Set(["POST"])],
  ["/v1/embeddings", new Set(["POST"])],
  ["/v1/messages", new Set(["POST"])],
]);

const opaqueMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Enforces the public data-plane routes owned by the current contract. Keep
 * contract churn here so framework adapters never grow their own URL policy.
 */
export function assertAllowedDataPlaneTarget(target: URL, method: string, feature: string): void {
  const normalizedMethod = method.toUpperCase();
  const structuredMethods = structuredDataPlaneMethods.get(target.pathname);
  if (structuredMethods?.has(normalizedMethod) === true) return;

  const opaquePrefix = `/proxy/${encodeURIComponent(feature)}/`;
  if (target.pathname.startsWith(opaquePrefix) && target.pathname.length > opaquePrefix.length &&
      opaqueMethods.has(normalizedMethod) && target.search === "") {
    return;
  }
  throw new LatchwayError(
    "transport_destination_not_allowed",
    "Latchway only authorizes methods and paths declared by the client contract.",
  );
}
