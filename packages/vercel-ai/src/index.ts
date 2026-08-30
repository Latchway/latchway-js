import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";

const frameworkVersion = "7.0.85";
const placeholder = "latchway-managed-not-a-provider-secret";

export interface AuthenticatedTransport {
  readonly gatewayURL: string;
  fetchFor(
    feature: string,
    framework: Readonly<{ id: "vercel-ai-sdk"; version: string }>,
  ): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface LatchwayVercelAIOptions {
  client: AuthenticatedTransport;
}

export interface LatchwayVercelAIProvider {
  (feature: string): ReturnType<OpenAIProvider["responses"]>;
  languageModel(feature: string): ReturnType<OpenAIProvider["responses"]>;
  responses(feature: string): ReturnType<OpenAIProvider["responses"]>;
  chat(feature: string): ReturnType<OpenAIProvider["chat"]>;
  embedding(feature: string): ReturnType<OpenAIProvider["embedding"]>;
  embeddingModel(feature: string): ReturnType<OpenAIProvider["embedding"]>;
}

/** Creates feature-only AI SDK models; callers never select a physical model. */
export function createLatchwayProvider(options: LatchwayVercelAIOptions): LatchwayVercelAIProvider {
  const providerFor = (feature: string): OpenAIProvider => createOpenAI({
    name: "latchway",
    baseURL: `${options.client.gatewayURL}/v1`,
    apiKey: placeholder,
    fetch: options.client.fetchFor(feature, {
      id: "vercel-ai-sdk",
      version: frameworkVersion,
    }),
  });
  const responses = (feature: string) => providerFor(feature).responses("latchway");
  const provider = Object.assign(responses, {
    languageModel: responses,
    responses,
    chat: (feature: string) => providerFor(feature).chat("latchway"),
    embedding: (feature: string) => providerFor(feature).embedding("latchway"),
    embeddingModel: (feature: string) => providerFor(feature).embedding("latchway"),
  });
  return provider;
}

export const VERCEL_AI_SDK_VERSION = frameworkVersion;
