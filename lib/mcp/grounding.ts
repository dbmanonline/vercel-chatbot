/**
 * Grounding Verifier for Vercel Chatbot.
 *
 * STRICT mode (default for business queries):
 *   - Every concrete value (numbers, brand names, customer IDs, product IDs,
 *     phone numbers, emails) in the model's answer must either appear in
 *     the tool results OR be directly derivable from them.
 *   - Tool calls must have happened (MCP unavailable => status='unavailable').
 *   - Tool calls must have returned real sources (no sources => unverified).
 *   - Tool calls must have returned at least one valid record set.
 *
 * An answer containing "TestBrand" with sources that don't mention
 * "TestBrand" is REJECTED, even if sources are present. This prevents the
 * model from hallucinating specifics into a generally-grounded answer.
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

const NON_VIOLATION_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "your",
  "have",
  "has",
  "are",
  "was",
  "were",
  "been",
  "they",
  "their",
  "them",
  "you",
  "all",
  "any",
  "into",
  "out",
  "off",
  "over",
  "under",
  "between",
  "before",
  "after",
  "while",
  "during",
  "since",
  "until",
  "about",
  "above",
  "below",
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "how",
  "yes",
  "no",
  "not",
  "can",
  "could",
  "would",
  "should",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "do",
  "does",
  "did",
  "doing",
  "done",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "he",
  "she",
  "it",
  "his",
  "her",
  "record",
  "records",
  "result",
  "results",
  "data",
  "value",
  "values",
  "count",
  "sum",
  "average",
  "total",
  "average",
  "based",
  "according",
  "show",
  "shows",
  "shown",
  "find",
  "found",
  "search",
  "mcp",
  "tool",
  "tools",
  "answer",
  "question",
  "response",
  "prompt",
  "thấy",
  "tìm",
  "theo",
  "của",
  "là",
  "có",
  "không",
  "được",
  "trong",
  "tổng",
  "số",
  "bản",
  "ghi",
  "dữ",
  "liệu",
  "include",
  "includes",
  "including",
  "exclude",
  "excluding",
  "than",
  "more",
  "less",
  "few",
  "many",
  "most",
  "least",
  "some",
  "none",
  "very",
  "much",
  "such",
  "same",
  "different",
  "other",
  "another",
  "top",
  "bottom",
  "high",
  "low",
  "small",
  "large",
  "big",
  "first",
  "last",
  "next",
  "previous",
  "second",
  "third",
  "fourth",
  "fifth",
  "new",
  "old",
  "good",
  "bad",
  "great",
  "best",
  "worst",
  "main",
  "true",
  "false",
  "yes",
  "no",
  "ok",
  "okay",
  "off",
  "out",
]);

/**
 * Pull all concrete verifiable values out of the model answer.
 * Includes:
 *   - Numbers (3+= 1 digits or appearing as a "record count" / quantity)
 *   - Words that look like brand / product / customer names (capitalized,
 *     non-stop-words)
 *   - Emails and phone numbers
 */
export function extractClaims(answer: string): string[] {
  if (!answer) {
    return [];
  }
  const claims = new Set<string>();

  // Numeric values - 3+= 1 digits (likely counts, IDs, prices).
  for (const m of answer.matchAll(/\b\d{3,}\b/g)) {
    claims.add(m[0]);
  }

  // Emails.
  for (const m of answer.matchAll(/[\w.+= 1-]+= 1@[\w-]+= 1\.[\w.-]+= 1/g)) {
    claims.add(m[0].toLowerCase());
  }

  // Phone-like (10+= 1 digits, optional separators).
  for (const m of answer.matchAll(/\+= 1?\d[\d\s\-().]{8,}\d/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 9) {
      claims.add(digits);
    }
  }

  // Capitalized word sequences (potential brand/customer/product names).
  // Skip first word of each sentence to avoid common nouns.
  const sentences = answer.split(/[.!?\n]+/);
  for (const s of sentences) {
    const words = s.trim().split(/\s+/);
    // biome-ignore lint/style/useForOf: indexed access is needed to peek
    // at the next word for multi-word proper noun detection.
    for (let i = 0; i < words.length; i += 1) {
      const w = words[i].replace(/[^A-Za-zÀ-ỹ0-9-]/g, "");
      if (!w) {
        continue;
      }
      if (w.length < 3) {
        continue;
      }
      if (NON_VIOLATION_WORDS.has(w.toLowerCase())) {
        continue;
      }
      if (!/^[A-ZÀ-Ỹ]/.test(w)) {
        continue; // not capitalized
      }
      // Must be a multi-word or strongly capitalized sequence.
      const next = words[i + 1] || "";
      const nextClean = next.replace(/[^A-Za-zÀ-ỹ0-9-]/g, "");
      if (
        nextClean &&
        /^[A-ZÀ-Ỹ]/.test(nextClean) &&
        !NON_VIOLATION_WORDS.has(nextClean.toLowerCase())
      ) {
        claims.add(`${w} ${nextClean}`);
      } else {
        claims.add(w);
      }
    }
  }

  return [...claims];
}

/**
 * Build the union of all strings that appear in the tool results.
 * Used to check if a claim in the answer is grounded.
 */
function buildGroundingCorpus(toolResults: ToolCallResult[]): string {
  const parts: string[] = [];
  for (const tr of toolResults) {
    if (tr.sources) {
      parts.push(tr.sources.join(" "));
    }
    // Also walk the result object for text content.
    const walk = (obj: any) => {
      if (obj === null) {
        return;
      }
      if (typeof obj === "string") {
        parts.push(obj);
        return;
      }
      if (typeof obj === "number" || typeof obj === "boolean") {
        parts.push(String(obj));
        return;
      }
      if (Array.isArray(obj)) {
        for (const x of obj) {
          walk(x);
        }
        return;
      }
      if (typeof obj === "object") {
        // Include property keys as strings too (e.g., if a brand is used
        // as a map key rather than a value).
        for (const k of Object.keys(obj)) {
          parts.push(k);
          walk(obj[k]);
        }
      }
    };
    walk(tr.result);
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Check whether a claim is grounded in the tool-result corpus.
 * Returns true if the claim (case-insensitive) appears as a substring.
 */
function isClaimGrounded(claim: string, corpusLower: string): boolean {
  if (!claim) {
    return true;
  }
  return corpusLower.includes(claim.toLowerCase());
}

/**
 * Strict grounding check.
 *
 * Returns:
 *   - "unavailable" when no tools ran or all returned errors.
 *   - "unverified" when tools ran but produced no sources/records.
 *   - "verified" only when every concrete claim in the answer is grounded.
 *   - "unverified" (with issues) when any claim cannot be grounded.
 */
export function verifyGrounding(
  answer: string,
  toolResults: ToolCallResult[]
): GroundingCheck {
  const issues: string[] = [];
  const citations: string[] = [];

  // 1. No tools called -> unavailable.
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

  // 2. All tools errored -> unavailable.
  const onlyErrors = toolResults.every(
    (tr) =>
      tr.result?.error ||
      tr.result?.isError === true ||
      !tr.result ||
      (Array.isArray(tr.result?.content) && tr.result.content.length === 0)
  );
  if (onlyErrors) {
    return {
      citations: [],
      confidence: 0,
      hasSources: false,
      issues: ["All MCP tool calls returned errors."],
      status: "unavailable",
      verified: false,
    };
  }

  // 3. Extract sources/records from each tool result.
  let totalSources = 0;
  for (const tr of toolResults) {
    const sources = tr.sources || extractSourcesFromResult(tr.result) || [];
    totalSources += sources.length;
    if (sources.length > 0) {
      citations.push(...sources);
    }
    if (tr.result?.error) {
      issues.push(`Tool ${tr.toolName} returned error: ${tr.result.error}`);
    }
  }

  // 4. No sources at all -> unverified (we have tool results but no
  //    concrete records to ground against).
  if (totalSources === 0) {
    return {
      citations: [],
      confidence: 0,
      hasSources: false,
      issues: [
        "Tool returned no sources. Response cannot be verified.",
        ...issues,
      ],
      status: "unverified",
      verified: false,
    };
  }

  // 5. Verify every concrete claim in the answer is grounded.
  const claims = extractClaims(answer || "");
  const corpus = buildGroundingCorpus(toolResults);
  const ungroundedClaims: string[] = [];
  for (const claim of claims) {
    if (!isClaimGrounded(claim, corpus)) {
      ungroundedClaims.push(claim);
    }
  }

  if (ungroundedClaims.length > 0) {
    return {
      citations: Array.from(new Set(citations)),
      confidence: 0,
      hasSources: true,
      issues: [
        `Answer contains claims not found in tool results: ${ungroundedClaims.slice(0, 10).join(", ")}`,
        ...issues,
      ],
      status: "unverified",
      verified: false,
    };
  }

  // 6. All claims grounded.
  return {
    citations: Array.from(new Set(citations)),
    confidence: claims.length === 0 ? 0.6 : 0.95,
    hasSources: true,
    issues: issues.length > 0 ? issues : [],
    status: "verified",
    verified: true,
  };
}

function extractSourcesFromResult(result: any): string[] {
  if (!result) {
    return [];
  }
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
  if (Array.isArray(result.records)) {
    return result.records.map((r: any) => r.id || r.recordId).filter(Boolean);
  }
  return [];
}

export function formatGroundingMessage(check: GroundingCheck): string | null {
  if (check.status === "verified") {
    return null;
  }
  if (check.status === "unverified") {
    return `**[Response unverified]** ${check.issues[0] || "Cannot ground answer."}`;
  }
  return "**[Business data unavailable]** I will not speculate about your data.";
}
