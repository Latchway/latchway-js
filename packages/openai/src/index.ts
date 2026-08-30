import OpenAI, { type ClientOptions } from "openai";
import { VERSION as OPENAI_VERSION } from "openai/version";

const placeholder = "latchway-managed-not-a-provider-secret";

export interface AuthenticatedTransport {
  readonly gatewayURL: string;
  fetchFor(
    feature: string,
    framework: Readonly<{ id: "openai-js"; version: string }>,
  ): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export type LatchwayOpenAIClientOptions = Pick<
  ClientOptions,
  "fetchOptions" | "logLevel" | "logger" | "maxRetries" | "timeout"
>;

export interface LatchwayOpenAIOptions {
  latchway: AuthenticatedTransport;
  feature: string;
  clientOptions?: LatchwayOpenAIClientOptions;
}

/**
 * Creates the official OpenAI client with a feature-bound Latchway fetch.
 * The placeholder satisfies the framework constructor and is removed by the
 * authenticated transport before any network dispatch.
 */
export function createLatchwayOpenAI(options: LatchwayOpenAIOptions): OpenAI {
  return new OpenAI({
    ...options.clientOptions,
    apiKey: placeholder,
    baseURL: `${options.latchway.gatewayURL}/v1`,
    dangerouslyAllowBrowser: true,
    fetch: options.latchway.fetchFor(options.feature, {
      id: "openai-js",
      version: OPENAI_VERSION,
    }),
  });
}

export { OPENAI_VERSION };
