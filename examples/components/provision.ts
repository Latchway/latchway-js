import type {
  LatchwayClient,
  ProvisionedComponent,
  PublicP256JWK,
} from "@latchway/client";

type ChildBootstrap = Pick<
  ProvisionedComponent,
  "componentID" | "refreshGrant" | "refreshGrantExpiresAt"
>;

/**
 * The child generates and retains its private key. The containing root sees
 * only the public JWK and delivers the one-time grant through an app-owned,
 * direct channel without logging it.
 */
export async function provisionSummaryWorker(
  latchway: LatchwayClient,
  childPublicJWK: PublicP256JWK,
  deliverToChild: (bootstrap: ChildBootstrap) => Promise<void>,
): Promise<string> {
  const component = await latchway.provisionComponent({
    componentDefinitionID: "summary_worker",
    publicJWK: childPublicJWK,
    requestedFeatures: ["weekly_summary"],
  });
  await deliverToChild({
    componentID: component.componentID,
    refreshGrant: component.refreshGrant,
    refreshGrantExpiresAt: component.refreshGrantExpiresAt,
  });
  return component.componentID;
}
