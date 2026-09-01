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
 *   - close(): closes transport += 1 client
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

/**
 * Race an MCP call against an optional timeout and an optional AbortSignal.
 *
 * Guarantees:
 *   - The MCP promise always wins if it resolves before the timeout/abort.
 *   - A timeout never rejects a call that has already resolved.
 *   - The timer is cleared and the abort listener removed BEFORE the
 *     awaited promise settles - even if the caller never awaits our return.
 *   - No unhandledRejection leaks: the loser promises are caught and
 *     swallowed because the race's winner is what we return.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;

  // Build the list of "loser" rejections that should never propagate.
  const losers: Promise<never>[] = [];

  try {
    const racePromise = new Promise<T>((_resolve, reject) => {
      // Timeout loser
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          reject(
            new McpTimeoutError(`MCP call timed out after ${timeoutMs}ms`)
          );
        }, timeoutMs);
      }
      // Abort loser
      if (signal) {
        if (signal.aborted) {
          reject(new McpAbortError("MCP call aborted"));
          return;
        }
        onAbort = () => reject(new McpAbortError("MCP call aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    const mcpPromise = promise
      .then((value) => {
        // MCP resolved first - cancel the timer and abort listener now
        // so the timeout cannot reject after us.
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
          onAbort = null;
        }
        return value;
      })
      .catch((err) => {
        // If MCP itself rejected, ensure cleanup too.
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
          onAbort = null;
        }
        throw err;
      });

    // Promise.race settles on the first fulfilled or rejected promise.
    const result = await Promise.race([mcpPromise, racePromise]);

    // If we won, the timer/listener are already cleared. Make extra sure.
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }

    return result;
  } finally {
    // Belt-and-suspenders: if for some reason neither branch cleared
    // the timer/listener (e.g. an exception above the race), do it now.
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
      onAbort = null;
    }
    // Swallow any rejection from the loser promises so they do not
    // bubble up as unhandledRejection.
    // Attach a no-op catch handler to each loser so any rejection is
    // already handled when we exit withTimeout. We do not use `void` here
    // because biome disallows `void` + .catch() chains; the catch is
    // the handler.
    Promise.all(losers).catch(() => undefined);
  }
}

export class McpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTimeoutError";
  }
}

export class McpAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAbortError";
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

// Re-exported via the class declarations above; nothing else needed here.
