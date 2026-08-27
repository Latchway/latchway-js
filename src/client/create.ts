import type { LatchwayClient, LatchwayOptions, Platform } from "../types.js";
import { DefaultLatchwayClient } from "./client.js";
import { configure } from "./config.js";

export function createClientForRuntime(
  options: LatchwayOptions,
  platform: Platform,
  runtimeCrypto: Crypto | undefined,
): LatchwayClient {
  return new DefaultLatchwayClient(configure(options, platform, runtimeCrypto));
}
