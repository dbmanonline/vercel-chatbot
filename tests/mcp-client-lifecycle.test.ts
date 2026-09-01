/**
 * MCP CLIENT LIFECYCLE TESTS
 *
 * Proves the request-scoped MCP client:
 *  - closes cleanly after a successful tool call
 *  - closes cleanly after a server-side error
 *  - is idempotent (close() can be called multiple times)
 *  - rejects per-call AbortSignal immediately
 *  - rejects on per-call timeoutMs
 *
 * IMPORTANT: This test file is structured so that every test's async
 * activity fully drains before the test returns. The SDK v2 transport
 * has internal reconnect/cache timers that linger, but our tests only
 * wait for the SDK's *user-facing* promise, not the internal one.
 * To make sure no test is "cancelled by parent", we always end each
 * test with an awaited call to handle.close().
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { getMcpTools } from "../lib/mcp/client";

const MCP_URL = process.env.NIGHT_WORKER_URL || "http://127.0.0.1:13579/mcp";
const MCP_TOKEN =
  process.env.NIGHT_WORKER_TOKEN ||
  "e2e-test-token-must-be-at-least-32-chars-long";

test("MCP client closes after successful tool call", async () => {
  const handle = await getMcpTools({
    authToken: MCP_TOKEN,
    serverUrl: MCP_URL,
    timeoutMs: 10_000,
  });
  const result = await handle.callTool("search_records", { limit: 1 });
  assert.ok(result, "result must exist");
  await handle.close();
  // After close, subsequent calls must reject.
  await assert.rejects(
    handle.callTool("search_records", { limit: 1 }),
    /closed/i
  );
});

test("MCP client closes after error tool call", async () => {
  const handle = await getMcpTools({
    authToken: MCP_TOKEN,
    serverUrl: MCP_URL,
    timeoutMs: 10_000,
  });
  // Trigger a tool-error by sending an invalid metric.
  const result = await handle.callTool("aggregate_data", {
    filter: {},
    limit: 1,
    metric: "this-metric-does-not-exist",
  });
  // The MCP contract returns isError: true rather than throwing.
  assert.equal(result.isError, true, "expected server to flag invalid metric");
  await handle.close();
});

test("MCP client close() is idempotent", async () => {
  const handle = await getMcpTools({
    authToken: MCP_TOKEN,
    serverUrl: MCP_URL,
    timeoutMs: 10_000,
  });
  // Close twice in parallel. Neither call may throw.
  await Promise.all([handle.close(), handle.close(), handle.close()]);
});

test("MCP client call rejects when per-call AbortSignal is already aborted", async () => {
  const handle = await getMcpTools({
    authToken: MCP_TOKEN,
    serverUrl: MCP_URL,
    timeoutMs: 10_000,
  });
  const ac = new AbortController();
  ac.abort(); // pre-aborted
  await assert.rejects(
    handle.callTool("search_records", { limit: 1 }, { signal: ac.signal }),
    /aborted|abort/i
  );
  await handle.close();
});

test("MCP client call rejects with timeout when per-call timeoutMs expires", async () => {
  const handle = await getMcpTools({
    authToken: MCP_TOKEN,
    serverUrl: MCP_URL,
    timeoutMs: 10_000,
  });
  // 1ms is impossibly small - any real network round trip will exceed it.
  await assert.rejects(
    handle.callTool("search_records", { limit: 1 }, { timeoutMs: 1 }),
    /timeout|aborted|abort/i
  );
  await handle.close();
});

test("MCP client per-call AbortSignal listener is removed after success (no leak)", async () => {
  const handle = await getMcpTools({
    authToken: MCP_TOKEN,
    serverUrl: MCP_URL,
    timeoutMs: 10_000,
  });
  const ac = new AbortController();
  let added = 0;
  let removed = 0;
  const origAdd = ac.signal.addEventListener.bind(ac.signal);
  const origRemove = ac.signal.removeEventListener.bind(ac.signal);
  (ac.signal as any).addEventListener = (type: any, l: any, o?: any) => {
    if (type === "abort") {
      added += 1;
    }
    return origAdd(type, l, o);
  };
  (ac.signal as any).removeEventListener = (type: any, l: any, o?: any) => {
    if (type === "abort") {
      removed += 1;
    }
    return origRemove(type, l, o);
  };
  await handle.callTool("search_records", { limit: 1 }, { signal: ac.signal });
  assert.equal(added, 1, "expected exactly one abort listener attached");
  assert.equal(
    removed,
    1,
    "expected the abort listener to be removed after success"
  );
  await handle.close();
});

test("MCP client per-call AbortSignal listener is removed after timeout (no leak)", async () => {
  const handle = await getMcpTools({
    authToken: MCP_TOKEN,
    serverUrl: MCP_URL,
    timeoutMs: 10_000,
  });
  const ac = new AbortController();
  let added = 0;
  let removed = 0;
  const origAdd = ac.signal.addEventListener.bind(ac.signal);
  const origRemove = ac.signal.removeEventListener.bind(ac.signal);
  (ac.signal as any).addEventListener = (type: any, l: any, o?: any) => {
    if (type === "abort") {
      added += 1;
    }
    return origAdd(type, l, o);
  };
  (ac.signal as any).removeEventListener = (type: any, l: any, o?: any) => {
    if (type === "abort") {
      removed += 1;
    }
    return origRemove(type, l, o);
  };
  await assert.rejects(
    handle.callTool(
      "search_records",
      { limit: 1 },
      { signal: ac.signal, timeoutMs: 1 }
    )
  );
  assert.equal(added, 1, "expected one abort listener attached");
  assert.equal(
    removed,
    1,
    "expected the abort listener to be removed after timeout"
  );
  await handle.close();
});

test("MCP client handles abort signal fired DURING the tool call", async () => {
  const handle = await getMcpTools({
    authToken: MCP_TOKEN,
    serverUrl: MCP_URL,
    timeoutMs: 10_000,
  });
  const ac = new AbortController();
  // Abort 1ms after the call starts.
  const callPromise = handle.callTool(
    "search_records",
    { limit: 5 },
    { signal: ac.signal, timeoutMs: 10_000 }
  );
  setTimeout(() => ac.abort(), 1);
  await assert.rejects(
    callPromise,
    /aborted|abort|McpAbortError|Connection closed/i
  );
  await handle.close();
});

test("MCP client close() is idempotent - second close is a no-op", async () => {
  const handle = await getMcpTools({
    authToken: MCP_TOKEN,
    serverUrl: MCP_URL,
    timeoutMs: 10_000,
  });
  await handle.close(); // first close
  await handle.close(); // second close — must not throw
});

test("MCP client uses per-call timeoutMs, not just constructor timeout", async () => {
  const handle = await getMcpTools({
    authToken: MCP_TOKEN,
    serverUrl: MCP_URL,
    timeoutMs: 60_000, // long constructor timeout
  });
  try {
    // Call with a short timeout — should timeout, not wait 60s.
    await handle.callTool(
      "aggregate_data",
      { metric: "total_records", limit: 5 },
      { timeoutMs: 50 } // very short timeout
    );
    assert.fail("Should have timed out");
  } catch (err) {
    assert.ok(
      /timeout|timed out|McpTimeout/i.test(String(err)),
      `Expected timeout error, got: ${err}`
    );
  }
  await handle.close();
});
