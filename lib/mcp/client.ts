/**
 * MCP Client wrapper - REQUEST-SCOPED.
 * Each call creates a fresh client and closes it before returning.
 * No global singleton.
 * 
 * Used in Vercel Chatbot's /api/chat route to connect to Night Worker MCP.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface McpClientOptions {
  serverUrl: string;
  authToken: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Create a request-scoped MCP client and return available tools.
 * Client and transport are closed before this function returns.
 */
export async function getMcpTools(options: McpClientOptions) {
  const {
    serverUrl,
    authToken,
    signal,
    timeoutMs = 30000,
  } = options;

  if (!serverUrl) {
    throw new Error('MCP_SERVER_URL is required');
  }
  if (!authToken || authToken.length < 32) {
    throw new Error('MCP_AUTH_TOKEN must be at least 32 characters');
  }

  const url = new URL(serverUrl);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
    },
  } as any);

  const client = new Client(
    { name: 'vercel-chatbot', version: '1.0.0' },
    { capabilities: {} }
  );

  // Connect with optional abort signal
  try {
    if (signal) {
      // Use AbortController-aware connect via racing
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(new Error('MCP connection aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } else {
      await client.connect(transport);
    }

    const { tools } = await client.listTools();
    return { client, transport, tools };
  } catch (error) {
    // Always close on failure
    try {
      await client.close();
    } catch {}
    try {
      await transport.close();
    } catch {}
    throw error;
  }
}

/**
 * Close MCP client and transport. Safe to call multiple times.
 */
export async function closeMcp(client: Client, transport: StreamableHTTPClientTransport) {
  try {
    await client.close();
  } catch {}
  try {
    await transport.close();
  } catch {}
}
