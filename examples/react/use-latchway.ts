import { useMemo } from "react";

import { createLatchwayClient, type LatchwayOptions } from "@latchway/client";

export function useLatchway(options: LatchwayOptions) {
  return useMemo(
    () => createLatchwayClient(options),
    [
      options.baseURL,
      options.applicationID,
      options.environment,
      options.identityProvider,
      options.identityTokenProvider,
      options.attestationProviders,
      options.installation,
      options.persistence,
      options.fetch,
      options.allowInsecureHTTP,
    ],
  );
}
