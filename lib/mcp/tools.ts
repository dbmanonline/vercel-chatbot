/**
 * MCP tools for AI SDK v7.
 * Each tool definition wires to a real MCP call via the request-scoped client.
 * The execute function is called by the AI during stream, so we wrap
 * the call to use the pre-connected client passed in.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type McpToolSet = Record<string, Tool>;

export interface McpToolContext {
  client: Client;
  transport: StreamableHTTPClientTransport;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Call MCP tool via the request-scoped client.
 * Returns parsed content text or error object.
 */
async function callMcp(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>
) {
  try {
    const result = await ctx.client.callTool({ name, arguments: args });

    // Parse the text content (SDK v2 returns content array)
    const textContent = (result.content as any[])?.find((c: any) => c.type === 'text');
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return { text: textContent.text };
      }
    }
    return result;
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'MCP call failed',
      tool: name,
      args,
    };
  }
}

/**
 * Build AI SDK tools from MCP server tools.
 * The "execute" closure captures the request-scoped client.
 */
export function buildMcpTools(ctx: McpToolContext): McpToolSet {
  return {
    search_records: tool({
      description:
        'Search business records (orders, conversions, transactions). Returns matching records with sources.',
      inputSchema: z.object({
        code: z.string().optional().describe('UCP product code'),
        customer: z.string().optional().describe('Customer name'),
        year: z.number().int().optional(),
        month: z.number().int().min(1).max(12).optional(),
        limit: z.number().int().min(1).max(100).default(10),
      }),
      execute: async (args) => callMcp(ctx, 'search_records', args),
    }),

    group_records: tool({
      description:
        'Group records by field (brand, customer, month, etc.) with counts.',
      inputSchema: z.object({
        groupBy: z.enum(['brand', 'customer', 'code', 'year', 'month', 'newBrand', 'oldBrand']),
        metric: z.enum(['count', 'quantity']).default('count'),
        sort: z.enum(['asc', 'desc']).default('desc'),
        limit: z.number().int().min(1).max(100).default(10),
        customer: z.string().optional(),
        year: z.number().int().optional(),
      }),
      execute: async (args) => callMcp(ctx, 'group_records', args),
    }),

    aggregate_data: tool({
      description:
        'Aggregate records: counts, sums, and breakdowns by various dimensions.',
      inputSchema: z.object({
        metric: z.enum([
          'count',
          'sum',
          'count_by_customer',
          'count_by_brand',
          'count_by_month',
          'count_by_year',
        ]),
        filter: z.record(z.string(), z.any()).optional(),
        groupBy: z.string().optional(),
        sortOrder: z.enum(['asc', 'desc']).default('desc'),
        limit: z.number().int().min(1).max(100).default(10),
      }),
      execute: async (args) => callMcp(ctx, 'aggregate_data', args),
    }),

    sum_quantity: tool({
      description: 'Sum quantities of records matching filters.',
      inputSchema: z.object({
        code: z.string().optional(),
        customer: z.string().optional(),
        year: z.number().int().optional(),
        month: z.number().int().min(1).max(12).optional(),
      }),
      execute: async (args) => callMcp(ctx, 'sum_quantity', args),
    }),

    top_customers: tool({
      description: 'Get top customers by record count or quantity.',
      inputSchema: z.object({
        sort: z.enum(['count', 'quantity']).default('count'),
        limit: z.number().int().min(1).max(100).default(10),
        year: z.number().int().optional(),
      }),
      execute: async (args) => callMcp(ctx, 'top_customers', args),
    }),
  };
}
