import {
  ChatOpenAI,
  type ChatOpenAIFields,
  OpenAIEmbeddings,
  type OpenAIEmbeddingsParams,
} from "@langchain/openai";

const frameworkVersion = "1.5.10";
const placeholder = "latchway-managed-not-a-provider-secret";

export interface AuthenticatedTransport {
  readonly gatewayURL: string;
  fetchFor(
    feature: string,
    framework: Readonly<{ id: "langchain-js"; version: string }>,
  ): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export type LatchwayChatOpenAIOptions = Omit<
  ChatOpenAIFields,
  "apiKey" | "configuration" | "model" | "modelName" | "openAIApiKey"
>;

export interface CreateLatchwayChatOpenAIOptions {
  latchway: AuthenticatedTransport;
  feature: string;
  chatOptions?: LatchwayChatOpenAIOptions;
}

export type LatchwayEmbeddingsOptions = Omit<
  Partial<OpenAIEmbeddingsParams>,
  "model" | "modelName"
>;

export interface CreateLatchwayEmbeddingsOptions {
  latchway: AuthenticatedTransport;
  feature: string;
  embeddingsOptions?: LatchwayEmbeddingsOptions;
}

export function createLatchwayChatOpenAI(options: CreateLatchwayChatOpenAIOptions): ChatOpenAI {
  return new ChatOpenAI({
    ...options.chatOptions,
    apiKey: placeholder,
    model: "latchway",
    configuration: {
      baseURL: `${options.latchway.gatewayURL}/v1`,
      fetch: options.latchway.fetchFor(options.feature, {
        id: "langchain-js",
        version: frameworkVersion,
      }),
    },
  });
}

export function createLatchwayEmbeddings(options: CreateLatchwayEmbeddingsOptions): OpenAIEmbeddings {
  return new OpenAIEmbeddings({
    ...options.embeddingsOptions,
    apiKey: placeholder,
    encodingFormat: "float",
    model: "latchway",
    configuration: {
      baseURL: `${options.latchway.gatewayURL}/v1`,
      fetch: options.latchway.fetchFor(options.feature, {
        id: "langchain-js",
        version: frameworkVersion,
      }),
    },
  });
}

export const LANGCHAIN_OPENAI_VERSION = frameworkVersion;
