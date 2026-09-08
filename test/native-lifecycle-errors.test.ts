import { describe, expect, it } from "vitest";
import { errorFromResponse, LatchwayError, type LatchwayNativeLifecycleErrorCode } from "../src/errors.js";

describe("portable native lifecycle error vocabulary", () => {
  it.each<LatchwayNativeLifecycleErrorCode>([
    "app_not_configured", "configuration_conflict", "identity_authority_required", "identity_unavailable",
    "identity_refresh_required", "account_changed", "client_logged_out", "cleanup_required", "client_disposed", "native_version_incompatible",
  ])("has a stable non-retryable local error for %s", (code) => {
    const error = new LatchwayError(code, "Native account lifecycle changed.");
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(false);
    expect(error.documentationURL).toBe(`https://docs.latchway.dev/errors/${code.replaceAll("_", "-")}`);
  });

  it("never accepts an HTTP response as authority to report native logout", async () => {
    const response = new Response(JSON.stringify({ code: "client_logged_out", status: 401 }), {
      status: 401, headers: { "content-type": "application/problem+json" },
    });
    const error = await errorFromResponse(response);
    expect(error.code).not.toBe("client_logged_out");
  });
});
