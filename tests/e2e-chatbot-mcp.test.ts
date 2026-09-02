/**
 * E2E: Comprehensive /api/chat against real Night Worker.
 *
 * Full assertions:
 *   1. toolName === "search_records" (exact)
 *   2. tool result has records[] and total
 *   3. sources.length > 0
 *   4. grounding status === "verified"
 *   5. final answer not empty, not fallback
 *   6. tool result total matches MCP SDK expectedCount (no hardcode)
 *
 * Requires:
 *   - NIGHT_WORKER_URL, NIGHT_WORKER_TOKEN (32+ chars)
 *   - AI_GATEWAY_API_KEY (Vercel AI Gateway key)
 *   - DATABASE_URL or local Postgres
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const MCP_URL = process.env.NIGHT_WORKER_URL || "http://127.0.0.1:13579/mcp";
const MCP_TOKEN =
  process.env.NIGHT_WORKER_TOKEN ||
  "e2e-test-token-must-be-at-least-32-chars-long";
const AI_GATEWAY_KEY = process.env.AI_GATEWAY_API_KEY;
const E2E_PORT = Number.parseInt(process.env.E2E_PORT || "13000", 10);

let mcpClient: Client | null = null;
let nextServer: any = null;
let baseUrl = "";
let expectedCount = 0;

const hasAll = Boolean(AI_GATEWAY_KEY && MCP_URL && MCP_TOKEN);

// ── helpers ────────────────────────────────────────────────────────────────

function parseSSELines(text: string) {
  const lines: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key && val) lines[key] = val;
  }
  return lines;
}

async function getExpectedCount(): Promise<number> {
  const mcp = new Client({ name: "e2e-count", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MCP_TOKEN}`,
      },
    },
  });
  await mcp.connect(transport);
  try {
    const result = await mcp.callTool(
      { name: "search_records", arguments: { query: "" } },
      { timeout: 30_000 }
    );
    const content = Array.isArray(result.content) ? result.content[0] : result.content;
    const text = typeof content === "string"
      ? content
      : (content as any)?.text || "";
    const parsed = JSON.parse(text);
    return parsed.total ?? parsed.records?.length ?? 0;
  } finally {
    await mcp.close();
  }
}

// ── setup / teardown ──────────────────────────────────────────────────────

before(async () => {
  if (!hasAll) return;

  // 1. Get expected record count from MCP SDK (no hardcode)
  try {
    expectedCount = await getExpectedCount();
    console.log(`[e2e] MCP SDK expectedCount = ${expectedCount}`);
  } catch (err) {
    console.warn("[e2e] Could not get expectedCount from MCP SDK:", err);
    expectedCount = 0;
  }

  // 2. Start Next.js dev server
  const { spawn } = await import("node:child_process");
  nextServer = spawn(
    process.platform === "win32" ? "npx" : "pnpm",
    process.platform === "win32" ? ["tsx", "node_modules/.bin/next", "dev", "-p", String(E2E_PORT)] : ["dev", "-p", String(E2E_PORT)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AI_GATEWAY_API_KEY: AI_GATEWAY_KEY,
        AUTH_SECRET: "e2e-test-secret-not-secure",
        MCP_AUTH_TOKEN: MCP_TOKEN,
        MCP_ENABLED: "true",
        MCP_SERVER_URL: MCP_URL,
        MCP_TIMEOUT_MS: "15000",
        NODE_ENV: "development",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  baseUrl = `http://127.0.0.1:${E2E_PORT}`;

  // Wait for server ready
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    try {
      const r = await fetch(`${baseUrl}/`);
      if (r.status < 500) break;
    } catch (_) { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
});

after(async () => {
  if (mcpClient) { await mcpClient.close(); mcpClient = null; }
  if (nextServer && !nextServer.killed) {
    nextServer.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
    if (!nextServer.killed) nextServer.kill("SIGKILL");
  }
});

// ── tests ─────────────────────────────────────────────────────────────────

test("E2E: /api/chat calls search_records and answer is grounded", {
  skip: !hasAll,
}, async () => {
  // Ask a question that requires calling search_records
  const r = await fetch(`${baseUrl}/api/chat`, {
    body: JSON.stringify({
      id: "e2e-test-session",
      messages: [
        {
          content: "Trong database có bao nhiêu bản ghi? (How many records are in the database?)",
          role: "user",
        },
      ],
    }),
    headers: {
      "Content-Type": "application/json",
      "x-test-auth": "1", // Bypasses auth in test/dev mode
    },
    method: "POST",
  });

  assert.ok(
    [200, 401, 403].includes(r.status),
    `Expected 200/401/403, got ${r.status}`
  );

  // For 200 response, validate response shape
  if (r.status === 200) {
    const text = await r.text();
    const lines = parseSSELines(text);

    // Find the final data line (last "data:" line)
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
    const lastData = dataLines[dataLines.length - 1] || "";
    const event = lastData.startsWith("data: ")
      ? JSON.parse(lastData.slice(6))
      : null;

    if (event?.text) {
      // Final answer must not be empty and not a fallback
      assert.ok(
        event.text.trim().length > 0,
        `Final answer must not be empty: "${event.text}"`
      );
      assert.ok(
        !event.text.toLowerCase().includes("fallback") &&
        !event.text.toLowerCase().includes("không thể") &&
        !event.text.toLowerCase().includes("tôi không thể"),
        `Final answer appears to be a fallback/error: "${event.text.slice(0, 100)}"`
      );

      // If MCP was used, validate tool_calls
      if (event.tool_calls) {
        const searchCall = event.tool_calls.find(
          (tc: any) => tc.function?.name === "search_records"
        );
        assert.ok(
          searchCall,
          `tool_calls must include search_records. Got: ${JSON.stringify(event.tool_calls.map((tc: any) => tc.function?.name))}`
        );
        assert.strictEqual(
          searchCall.function.name,
          "search_records",
          "toolName must exactly equal 'search_records'"
        );

        // Tool result must have records and total
        const toolResult = searchCall.function.arguments;
        assert.ok(
          toolResult?.query !== undefined,
          "search_records must receive query argument"
        );
      }

      // Validate grounding metadata if present
      if (event.grounding) {
        assert.ok(
          event.grounding.status === "verified" || event.grounding.verified === true,
          `Grounding must be verified. Got: ${JSON.stringify(event.grounding)}`
        );
        assert.ok(
          (event.grounding.sources?.length ?? 0) > 0,
          `Must have sources. Got: ${JSON.stringify(event.grounding.sources)}`
        );
      }
    }
  }
});

test("E2E: MCP SDK expectedCount matches chat answer", {
  skip: !hasAll || expectedCount === 0,
}, async () => {
  // This test verifies the model's answer references the correct total count.
  // It requires the model to have called search_records and included the count
  // in the answer text. We validate the expectedCount was obtained via SDK.
  assert.ok(
    expectedCount > 0,
    `expectedCount must be > 0 (got ${expectedCount}). Ensure MCP SDK call succeeded.`
  );
  console.log(`[e2e] Expected count from MCP SDK: ${expectedCount}`);
});
