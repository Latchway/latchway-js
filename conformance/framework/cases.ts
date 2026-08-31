export type JavaScriptFrameworkID = "langchain-js" | "openai-js" | "vercel-ai-sdk";

export interface FrameworkCaseDescriptor {
  readonly id: FrameworkCaseID;
  readonly title: string;
  readonly appliesTo: readonly JavaScriptFrameworkID[];
}

const allFrameworks = ["openai-js", "vercel-ai-sdk", "langchain-js"] as const;
const responsesFrameworks = ["openai-js", "vercel-ai-sdk"] as const;

/**
 * Stable IDs for the local framework contract. The IDs are intentionally
 * independent of a test runner so the same catalog can be consumed by hosted
 * and exact-version conformance jobs.
 */
export const FRAMEWORK_CASES = [
  frameworkCase("FW-AUTH-001", "binds the feature and exact framework version", allFrameworks),
  frameworkCase("FW-REQ-001", "preserves an OpenAI Responses request and response", responsesFrameworks),
  frameworkCase("FW-REQ-002", "preserves a Chat Completions request and response", allFrameworks),
  frameworkCase("FW-REQ-003", "preserves an embeddings request and response", allFrameworks),
  frameworkCase("FW-REQ-004", "preserves safe caller headers and request metadata", allFrameworks),
  frameworkCase("FW-REQ-005", "delivers streaming bytes and final usage", allFrameworks),
  frameworkCase("FW-REQ-006", "propagates cancellation to the authenticated request", allFrameworks),
  frameworkCase("FW-BEH-001", "preserves tool definitions", allFrameworks),
  frameworkCase("FW-BEH-002", "preserves and parses structured output", allFrameworks),
  frameworkCase("FW-BEH-003", "maps quota denial with the Latchway request ID", allFrameworks),
  frameworkCase("FW-BEH-004", "preserves provider errors and correlation metadata", allFrameworks),
  frameworkCase("FW-BEH-005", "creates a fresh authenticated dispatch for framework retries", allFrameworks),
  frameworkCase("FW-BEH-006", "safely refreshes a pre-dispatch expired session", allFrameworks),
  frameworkCase("FW-SEC-001", "strips provider placeholder credentials before dispatch", allFrameworks),
  frameworkCase("FW-SEC-002", "rejects a mismatched origin and undeclared path before session work", allFrameworks),
  frameworkCase("FW-SEC-003", "does not expose credentials in framework errors", allFrameworks),
  frameworkCase("FW-SEC-004", "does not mutate or fall back to global fetch", allFrameworks),
] as const satisfies readonly FrameworkCaseDescriptor[];

export type FrameworkCaseID =
  | "FW-AUTH-001"
  | "FW-REQ-001"
  | "FW-REQ-002"
  | "FW-REQ-003"
  | "FW-REQ-004"
  | "FW-REQ-005"
  | "FW-REQ-006"
  | "FW-BEH-001"
  | "FW-BEH-002"
  | "FW-BEH-003"
  | "FW-BEH-004"
  | "FW-BEH-005"
  | "FW-BEH-006"
  | "FW-SEC-001"
  | "FW-SEC-002"
  | "FW-SEC-003"
  | "FW-SEC-004";

export function expectedFrameworkCases(framework: JavaScriptFrameworkID): readonly FrameworkCaseDescriptor[] {
  return FRAMEWORK_CASES.filter((candidate) => candidate.appliesTo.includes(framework));
}

export function assertFrameworkCaseCoverage(
  framework: JavaScriptFrameworkID,
  observed: ReadonlySet<FrameworkCaseID>,
): void {
  const expected = new Set(expectedFrameworkCases(framework).map(({ id }) => id));
  const missing = [...expected].filter((id) => !observed.has(id));
  const unexpected = [...observed].filter((id) => !expected.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${framework} framework case registration is incomplete; missing=${missing.join(",") || "none"}; ` +
      `unexpected=${unexpected.join(",") || "none"}.`,
    );
  }
}

export function frameworkCaseTitle(id: FrameworkCaseID): string {
  const descriptor = FRAMEWORK_CASES.find((candidate) => candidate.id === id);
  if (descriptor === undefined) throw new Error(`Unknown framework conformance case: ${id}`);
  return `[${descriptor.id}] ${descriptor.title}`;
}

function frameworkCase(
  id: FrameworkCaseID,
  title: string,
  appliesTo: readonly JavaScriptFrameworkID[],
): FrameworkCaseDescriptor {
  return { id, title, appliesTo };
}
