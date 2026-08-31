/**
 * Grounding Verifier for Vercel Chatbot.
 * Checks that AI responses are based on actual MCP tool results and sources.
 *
 * If MCP failed or returned no sources, the chatbot must return an
 * "unavailable" or "unverified" status - NOT speculate.
 */

export interface ToolCallResult {
  args: Record<string, unknown>;
  result: any;
  sources?: string[];
  toolName: string;
}

export interface GroundingCheck {
  citations: string[];
  confidence: number;
  hasSources: boolean;
  issues: string[];
  status: "verified" | "unverified" | "unavailable";
  verified: boolean;
}

/**
 * Check whether a generated answer is grounded in tool results.
 */
export function verifyGrounding(
  answer: string,
  toolResults: ToolCallResult[]
): GroundingCheck {
  const issues: string[] = [];
  const citations: string[] = [];

  // If there are no tool results at all, return unavailable
  if (!toolResults || toolResults.length === 0) {
    return {
      citations: [],
      confidence: 0,
      hasSources: false,
      issues: [
        "No tool calls were made. Cannot ground response in business data.",
      ],
      status: "unavailable",
      verified: false,
    };
  }

  // Collect sources
  let totalSources = 0;
  let hasError = false;
  for (const tr of toolResults) {
    if (tr.result?.error) {
      hasError = true;
      issues.push(`Tool ${tr.toolName} returned error: ${tr.result.error}`);
    }
    const sources = tr.sources || extractSourcesFromResult(tr.result);
    if (sources && sources.length > 0) {
      totalSources += sources.length;
      citations.push(...sources);
    }
  }

  // Check if MCP was unavailable (all calls errored)
  const onlyErrors = toolResults.every((tr) => tr.result?.error);
  if (onlyErrors) {
    return {
      citations: [],
      confidence: 0,
      hasSources: false,
      issues,
      status: "unavailable",
      verified: false,
    };
  }

  // Has tool results but no sources -> unverified
  if (totalSources === 0) {
    return {
      citations: [],
      confidence: 0.3,
      hasSources: false,
      issues: ["Tool returned no sources. Response cannot be verified."],
      status: "unverified",
      verified: false,
    };
  }

  // Verify answer references at least one source or known data
  const hasGroundingMarkers = hasGroundingIndicators(answer);
  const confidence = hasGroundingMarkers ? 0.9 : 0.7;

  return {
    citations: Array.from(new Set(citations)),
    confidence,
    hasSources: true,
    issues: hasError ? issues : [],
    status: "verified",
    verified: true,
  };
}

function extractSourcesFromResult(result: any): string[] {
  if (!result) {
    return [];
  }
  // MCP v2 may put sources in `_meta.sources`, `sources`, or inside content
  if (Array.isArray(result.sources)) {
    return result.sources.map((s: any) =>
      typeof s === "string"
        ? s
        : s.recordId || s.path || s.id || JSON.stringify(s)
    );
  }
  if (result._meta?.sources && Array.isArray(result._meta.sources)) {
    return result._meta.sources.map((s: any) =>
      typeof s === "string"
        ? s
        : s.recordId || s.path || s.id || JSON.stringify(s)
    );
  }
  // Look for record IDs in data
  if (Array.isArray(result.records)) {
    return result.records.map((r: any) => r.id || r.recordId).filter(Boolean);
  }
  return [];
}

function hasGroundingIndicators(answer: string): boolean {
  if (!answer || typeof answer !== "string") {
    return false;
  }
  // Phrases that indicate the answer is based on actual data
  const indicators = [
    /\b(theo|dựa trên|theo dữ liệu)\b/i,
    /\b(records?|records? show)\b/i,
    /\b(found|tìm thấy)\b/i,
    /\b\d+\s*(record|bản ghi)/i,
    /\bUCP\s*\d+/i,
  ];
  return indicators.some((re) => re.test(answer));
}

/**
 * Wrap a stream result to inject grounding status into the data stream.
 * Returns a message to append to the response.
 */
export function formatGroundingMessage(check: GroundingCheck): string | null {
  if (check.status === "verified" && check.citations.length > 0) {
    return null; // No extra message needed
  }
  if (check.status === "unverified") {
    return "\n\n*[Grounding unverified]* Tool results were returned but sources were not provided or could not be matched.";
  }
  if (check.status === "unavailable") {
    return "\n\n*[Data unavailable]* Business data source is currently unavailable. The answer above was not generated from authoritative records. Please try again later.";
  }
  return null;
}
