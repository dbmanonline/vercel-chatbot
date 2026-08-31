/**
 * MCP client integration tests using real Night Worker.
 * Verifies v2 SDK Client can connect, list tools, and call tools.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { getMcpTools } from "../lib/mcp/client";

const MCP_URL = process.env.NIGHT_WORKER_URL || "http://127.0.0.1:13579/mcp";
const MCP_TOKEN =
  process.env.NIGHT_WORKER_TOKEN ||
  "e2e-test-token-must-be-at-least-32-chars-long";

test("MCP client v2 connects to real Night Worker and lists tools", async () => {
  const handle = await getMcpTools({
    authToken: MCP_TOKEN,
    serverUrl: MCP_URL,
    timeoutMs: 10_000,
  });
  try {
    const tools = await handle.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(
      names.includes("search_records"),
      "search_records must be listed"
    );
    assert.ok(names.includes("group_records"), "group_records must be listed");
    assert.ok(
      names.includes("aggregate_data"),
      "aggregate_data must be listed"
    );
  } finally {
    await handle.close();
  }
});

test("MCP client v2 calls search_records and parses text content", async () => {
  const handle = await getMcpTools({
    authToken: MCP_TOKEN,
    serverUrl: MCP_URL,
    timeoutMs: 10_000,
  });
  try {
    const result = await handle.callTool("search_records", {
      limit: 5,
      query: "e2e",
    });
    assert.ok(result, "result must exist");
    const content = result.content as Array<{ type: string; text: string }>;
    const textBlock = content.find((c) => c.type === "text");
    assert.ok(textBlock, "text content must exist");
    const { text } = textBlock;
    const body = JSON.parse(text);
    assert.ok("sources" in body, "response must include sources");
  } finally {
    await handle.close();
  }
});

test("MCP client v2 group_records returns real brand keys", async () => {
  const handle = await getMcpTools({
    authToken: MCP_TOKEN,
    serverUrl: MCP_URL,
    timeoutMs: 10_000,
  });
  try {
    const result = await handle.callTool("group_records", { groupBy: "brand" });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((c) => c.type === "text")?.text || "";
    const body = JSON.parse(text);
    const groups = body.groups || [];
    assert.ok(groups.length > 0, "must have at least one group");
    for (const g of groups) {
      assert.ok(
        typeof g.key === "string" && g.key.length > 0,
        "group key non-empty"
      );
    }
  } finally {
    await handle.close();
  }
});

test("MCP client v2 aggregate_data rejects invalid metric", async () => {
  const handle = await getMcpTools({
    authToken: MCP_TOKEN,
    serverUrl: MCP_URL,
    timeoutMs: 10_000,
  });
  try {
    const result = await handle.callTool("aggregate_data", {
      metric: "bogus_metric",
    });
    assert.equal(result.isError, true, "invalid metric must set isError");
  } finally {
    await handle.close();
  }
});

test("MCP client v2 rejects connection with invalid auth token", async () => {
  await assert.rejects(
    getMcpTools({
      authToken: "WRONG-TOKEN-NOT-AT-LEAST-32-CHARS-LONG-X",
      serverUrl: MCP_URL,
    }),
    /Invalid token|Authorization|401|Unauthorized/i,
    "auth token must be enforced"
  );
});
