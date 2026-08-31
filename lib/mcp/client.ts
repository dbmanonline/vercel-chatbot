/**
 * MCP Client wrapper - REQUEST-SCOPED.
 * Each call creates a fresh client and connects/closes per request.
 * No global singleton.
 *
 * Uses @modelcontextprotocol/client v2 (the official current SDK).
 * v2 client is ESM-only, so we use a top-level dynamic import cached
 * after first use.
 *
 * Lifecycle:
 *   - connect(): opens streamable HTTP transport
 *   - listTools(): returns the discovered MCP tool list
 *   - callTool(name, args, opts): invokes a tool with per-call timeout/signal
 *   - close(): closes transport + client
 *
 * All consumers MUST call close() in onAbort/onError/onFinish/finally.
 */

let _sdkModule: typeof import("@modelcontextprotocol/client") | null = null;

async function loadSdk(): Promise<
  typeof import("@modelcontextprotocol/client")
> {
  if (_sdkModule) {
    return _sdkModule;
  }
  _sdkModule = await import("@modelcontextprotocol/client");
  return _sdkModule;
}

export type McpHandle = {
  client: import("@modelcontextprotocol/client").Client;
  transport: import("@modelcontextprotocol/client").StreamableHTTPClientTransport;
  callTool: (
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number }
  ) => Promise<import("@modelcontextprotocol/client").CallToolResult>;
  listTools: () => Promise<
    { name: string; description?: string; inputSchema: unknown }[]
  >;
  close: () => Promise<void>;
};

export type GetMcpToolsOptions = {
  serverUrl: string;
  authToken: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  let timeoutListener: (() => void) | null = null;
  try {
    if (timeoutMs && timeoutMs > 0) {
      await new Promise<void>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`MCP call timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        if (signal) {
          timeoutListener = () => reject(new Error("MCP call aborted"));
          signal.addEventListener("abort", timeoutListener);
        }
      });
    } else if (signal) {
      await new Promise<void>((_resolve, reject) => {
        timeoutListener = () => reject(new Error("MCP call aborted"));
        signal.addEventListener("abort", timeoutListener);
      });
    }
    return await promise;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && timeoutListener) {
      // Remove the listener we attached so we don't leak.
      signal.removeEventListener("abort", timeoutListener);
    }
  }
}

/**
 * Open a fresh MCP client and connect it. Returns a handle with typed
 * tool-call/list helpers. Caller MUST invoke handle.close() on stream
 * lifecycle events (onAbort/onError/onFinish/finally).
 */
export async function getMcpTools(
  opts: GetMcpToolsOptions
): Promise<McpHandle> {
  const sdk = await loadSdk();
  const transportOpts: any = {
    requestInit: {
      headers: {
        Authorization: `Bearer ${opts.authToken}`,
      },
    },
  };
  if (opts.signal) {
    // v2 SDK accepts a top-level `signal` on the transport
    transportOpts.signal = opts.signal;
  }
  const transport = new sdk.StreamableHTTPClientTransport(
    new URL(opts.serverUrl),
    transportOpts
  );
  const client = new sdk.Client(
    { name: "vercel-chatbot", version: "2.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);

  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await client.close();
    } catch (err) {
      // Closing the client should never throw — but if it does, log
      // so a hung MCP connection doesn't mask real bugs upstream.
      console.warn("[mcp-client] client.close failed:", err);
    }
    try {
      await transport.close();
    } catch (err) {
      console.warn("[mcp-client] transport.close failed:", err);
    }
  };

  // biome-ignore lint/suspicious/useAwait: client.callTool returns a Promise; withTimeout wraps it.
  const callTool: McpHandle["callTool"] = async (name, args, callOpts) => {
    if (closed) {
      throw new Error("MCP client already closed");
    }
    const inner = client.callTool({ arguments: args, name } as any);
    return withTimeout(inner, callOpts?.timeoutMs, callOpts?.signal);
  };

  const listTools: McpHandle["listTools"] = async () => {
    if (closed) {
      throw new Error("MCP client already closed");
    }
    const r = await client.listTools();
    return r.tools as any;
  };

  return { callTool, client, close, listTools, transport };
}
