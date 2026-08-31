/**
 * MCP tools for AI SDK v7.
 * Each tool definition wires to a real MCP call via the request-scoped handle.
 *
 * The tool execution is captured in a shared "executions" array
 * (one entry per call) so the route's onFinish can verify grounding
 * against the actual tool results and sources.
 */

import { tool } from "ai";
import { z } from "zod";
import type { McpHandle } from "./client";

export type McpToolSet = ReturnType<typeof buildMcpTools>;

export interface McpCallRecord {
  args: Record<string, unknown>;
  endedAt: number;
  error?: string;
  result: any;
  sources: string[];
  startedAt: number;
  toolName: string;
}

/**
 * Track all MCP tool executions during a single stream.
 * The route accesses this in onFinish to verify grounding.
 */
export function createMcpExecutions() {
  const executions: McpCallRecord[] = [];
  return {
    executions,
    push(rec: McpCallRecord) {
      executions.push(rec);
    },
  };
}

export interface BuildMcpToolsOptions {
  handle: McpHandle;
  signal?: AbortSignal;
  timeoutMs?: number;
  tracker: ReturnType<typeof createMcpExecutions>;
}

/**
 * Call MCP and record the execution.
 */
async function callMcp(
  opts: BuildMcpToolsOptions,
  name: string,
  args: Record<string, unknown>
) {
  const startedAt = Date.now();
  try {
    const result = await opts.handle.callTool(name, args, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });

    // SDK v2 returns { content: [{ type: 'text', text: '...' }, ...], isError?: bool }
    let parsed: any = result;
    let sources: string[] = [];
    const textContent = (result?.content as any[])?.find(
      (c: any) => c.type === "text"
    );
    if (textContent?.text) {
      try {
        parsed = JSON.parse(textContent.text);
        sources = extractSources(parsed);
      } catch {
        parsed = { text: textContent.text };
        sources = [];
      }
    } else {
      sources = extractSources(parsed);
    }

    // isError is part of the MCP result envelope (not a thrown exception).
    if ((result as any)?.isError) {
      opts.tracker.push({
        args,
        endedAt: Date.now(),
        error: "Tool returned isError",
        result: parsed,
        sources: [],
        startedAt,
        toolName: name,
      });
      // Surface as a tool result that the grounding checker can see.
      return { data: parsed, error: "Tool returned isError" };
    }

    opts.tracker.push({
      args,
      endedAt: Date.now(),
      result: parsed,
      sources,
      startedAt,
      toolName: name,
    });
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "MCP call failed";
    opts.tracker.push({
      args,
      endedAt: Date.now(),
      error: msg,
      result: null,
      sources: [],
      startedAt,
      toolName: name,
    });
    return { args, error: msg, tool: name };
  }
}

function extractSources(result: any): string[] {
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
    const ids = result.records
      .map((r: any) => r.id || r.recordId)
      .filter(Boolean);
    if (ids.length) {
      return ids.map(String);
    }
  }
  // Synthetic id from data path so we have something to cite.
  if (Array.isArray(result.data) && result.data.length) {
    return [`data:${result.data.length}`];
  }
  return [];
}

/**
 * Build AI SDK tools from a connected MCP handle.
 * Each tool's execute closure captures the handle + tracker.
 */
export function buildMcpTools(opts: BuildMcpToolsOptions) {
  return {
    aggregate_data: tool({
      description:
        "Aggregate records: counts, sums, breakdowns by various dimensions. Use metric count|sum|count_by_* and optional groupBy.",
      execute: async (args: any) => callMcp(opts, "aggregate_data", args),
      inputSchema: z.object({
        filter: z.record(z.string(), z.any()).optional(),
        groupBy: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(10),
        metric: z.enum([
          "count",
          "sum",
          "count_by_customer",
          "count_by_brand",
          "count_by_month",
          "count_by_year",
        ]),
        sortOrder: z.enum(["asc", "desc"]).default("desc"),
      }),
    }),
    group_records: tool({
      description:
        "Group records by field (brand, customer, month, year, newBrand, oldBrand, code) with count/quantity metric.",
      execute: async (args: any) => callMcp(opts, "group_records", args),
      inputSchema: z.object({
        customer: z.string().optional(),
        groupBy: z.enum([
          "brand",
          "customer",
          "code",
          "year",
          "month",
          "newBrand",
          "oldBrand",
        ]),
        limit: z.number().int().min(1).max(100).default(10),
        metric: z.enum(["count", "quantity"]).default("count"),
        sort: z.enum(["asc", "desc"]).default("desc"),
        year: z.number().int().optional(),
      }),
    }),
    search_records: tool({
      description:
        "Search business records (orders, conversions, transactions). Returns matching records with sources. REQUIRED for any business-data question.",
      execute: async (args: any) => callMcp(opts, "search_records", args),
      inputSchema: z.object({
        code: z.string().optional().describe("UCP product code"),
        customer: z.string().optional().describe("Customer name"),
        limit: z.number().int().min(1).max(100).default(10),
        month: z.number().int().min(1).max(12).optional(),
        year: z.number().int().optional(),
      }),
    }),
    sum_quantity: tool({
      description: "Sum quantities of records matching filters.",
      execute: async (args: any) => callMcp(opts, "sum_quantity", args),
      inputSchema: z.object({
        code: z.string().optional(),
        customer: z.string().optional(),
        month: z.number().int().min(1).max(12).optional(),
        year: z.number().int().optional(),
      }),
    }),
    top_customers: tool({
      description: "Get top customers by record count or quantity.",
      execute: async (args: any) => callMcp(opts, "top_customers", args),
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(10),
        sort: z.enum(["count", "quantity"]).default("count"),
        year: z.number().int().optional(),
      }),
    }),
  };
}

/**
 * Detect whether a user message is a "business data" question that
 * requires grounded MCP tool use. If true, the chatbot MUST call MCP
 * and MUST NOT stream an LLM-only answer.
 */
export function isBusinessDataQuery(text: string): boolean {
  if (!text || typeof text !== "string") {
    return false;
  }
  const t = text.toLowerCase();
  // Vietnamese + English triggers
  const triggers = [
    "doanh thu",
    "doanh số",
    "sản phẩm",
    "khách hàng",
    "đơn hàng",
    "tháng",
    "năm",
    "thương hiệu",
    "brand",
    "số lượng",
    "tăng trưởng",
    "do|doanh",
    "doanh_thu",
    "revenue",
    "sales",
    "orders",
    "customers",
    "products",
    "records",
    "transactions",
    "how many",
    "show me",
    "top ",
    "ucp",
    "conversion",
    "aggregate",
    "group",
    "breakdown",
  ];
  return triggers.some((kw) => t.includes(kw));
}
