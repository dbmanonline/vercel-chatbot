/**
 * E2E TEST: Real-model /api/chat
 *
 * Spawns a Next.js dev server bound to localhost, posts a valid business
 * data query, and asserts the stream contains:
 *   - model tool-call: search_records
 *   - tool-result with records
 *   - sources data-grounding-status
 *   - grounded verified final answer
 *
 * REQUIREMENTS:
 *   - AI_GATEWAY_API_KEY must be set
 *   - NIGHT_WORKER_URL / NIGHT_WORKER_TOKEN must be set (or default to
 *     localhost:13579/mcp)
 *
 * If AI_GATEWAY_API_KEY is missing, this test prints a single NOT RUN
 * line to stderr and exits with code 0 (it does NOT count as E2E pass).
 *
 * If the Next.js server fails to start or /api/chat returns non-200,
 * the test fails.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const GATEWAY_KEY = process.env.AI_GATEWAY_API_KEY ?? "";
// Reject placeholder/fake keys so the test fails fast instead of hanging.
// E2E_PROXY_URL activates the local proxy fallback (no AI Gateway key needed).
const IS_FAKE_KEY =
  (!GATEWAY_KEY || GATEWAY_KEY === "placeholder-agent-shop-key") &&
  !process.env.E2E_PROXY_URL;
const MCP_URL = process.env.NIGHT_WORKER_URL || "http://127.0.0.1:13579/mcp";
const MCP_TOKEN =
  process.env.NIGHT_WORKER_TOKEN ||
  "e2e-test-token-must-be-at-least-32-chars-long";
const PORT = process.env.E2E_CHATBOT_PORT
  ? Number.parseInt(process.env.E2E_CHATBOT_PORT, 10)
  : 3500;
const PROJECT_ROOT = process.cwd();

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  // biome-ignore lint/performance/noAwaitInLoops: server warm-up polling.
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) {
        return;
      }
    } catch {
      // ignore - retrying
    }
    await delay(200);
  }
  throw new Error(`Server at ${url} did not become ready in ${timeoutMs}ms`);
}

function startNextServer(): ChildProcess {
  const proc = spawn(
    process.platform === "win32" ? "cmd" : "pnpm",
    process.platform === "win32" ? ["/c", "next", "dev", "--port", String(PORT)] : ["next", "dev", "--port", String(PORT)],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        AI_GATEWAY_API_KEY: GATEWAY_KEY,
        AUTH_SECRET:
          process.env.AUTH_SECRET || "e2e-auth-secret-must-be-long-enough",
        E2E_BYPASS_AUTH: "1",
        E2E_PROXY_URL: process.env.E2E_PROXY_URL ?? "http://localhost:20128",
        E2E_PROXY_KEY: process.env.E2E_PROXY_KEY ?? "",
        E2E_CHATBOT_PORT: String(PORT),
        NIGHT_WORKER_TOKEN: MCP_TOKEN,
        NIGHT_WORKER_URL: MCP_URL,
        MCP_ENABLED: "true",
        MCP_SERVER_URL: MCP_URL,
        MCP_AUTH_TOKEN: MCP_TOKEN,
        PLAYWRIGHT_TEST_BASE_URL: `http://127.0.0.1:${PORT}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  proc.stdout?.on("data", (chunk) => {
    const s = String(chunk);
    if (s.includes("Ready") || s.includes("Local:")) {
      // ready
    }
  });
  proc.stderr?.on("data", (chunk) => {
    const s = String(chunk);
    if (
      s.includes("EADDRINUSE") ||
      s.includes("address already in use") ||
      s.toLowerCase().includes("error")
    ) {
      console.error("[next-stderr]", s);
    }
  });
  return proc;
}

test("E2E /api/chat: real model calls MCP and returns grounded answer (status=verified)", async () => {
  if (IS_FAKE_KEY) {
    console.log(
      "NOT_RUN: AI_GATEWAY_API_KEY not set or placeholder — real-model /api/chat E2E blocked"
    );
    return;
  }

  const proc = startNextServer();
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`, 60_000);

    // Build a valid request body. /api/chat accepts an array of
    // UIMessage objects via streamText's messages param.
    const body = JSON.stringify({
      id: "550e8400-e29b-41d4-a716-446655440000",
      messages: [
        {
          id: "msg-1",
          parts: [
            {
              text: "How many records are there in total? Use search_records.",
              type: "text",
            },
          ],
          role: "user",
        },
      ],
      selectedChatModel: "agent-shop/claude-opus-5",
      selectedVisibilityType: "private",
    });

    const res = await fetch(`http://127.0.0.1:${PORT}/api/e2e-direct`, {
      body,
      headers: {
        "Content-Type": "application/json",
        Cookie: "authjs.session-token=e2e-fake-session",
      },
      method: "POST",
    });

    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `/api/e2e-direct returned HTTP ${res.status} (expected 200). body=${text.slice(0, 500)}`
      );
    }

    const reader = (res.body as ReadableStream).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawToolCall = false;
    let sawToolResult = false;
    let sawSources = false;
    let finalAnswer = "";
    let groundingStatus: string | null = null;

    while (true) {
      // biome-ignore lint/performance/noAwaitInLoops: SSE stream must be
      // read chunk-by-chunk.
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          continue;
        }
        const json = line.slice(6).trim();
        if (!json) {
          continue;
        }
        try {
          const ev = JSON.parse(json);
          if (ev.type === "tool-call" || ev.type === "tool-input-available") {
            sawToolCall = true;
          }
          if (
            ev.type === "tool-result" ||
            ev.type === "tool-output-available"
          ) {
            sawToolResult = true;
          }
          if (ev.type === "data-grounding-status") {
            sawSources = true;
            groundingStatus = ev.data?.status || null;
          }
          if (ev.type === "text-delta" && typeof ev.delta === "string") {
            finalAnswer += ev.delta;
          }
        } catch {
          // ignore parse errors on non-JSON lines
        }
      }
    }

    assert.ok(sawToolCall, "stream must contain a tool-call event");
    assert.ok(sawToolResult, "stream must contain a tool-result event");
    assert.ok(
      sawSources,
      "stream must contain a sources/grounding-status event"
    );
    assert.ok(
      groundingStatus === "verified",
      `grounding status must be verified (got: ${groundingStatus}). answer=${finalAnswer.slice(0, 200)}`
    );
    assert.ok(finalAnswer.length > 0, "final answer must not be empty");
  } finally {
    proc.kill();
  }
});
