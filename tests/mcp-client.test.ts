/**
 * Integration test: Vercel Chatbot MCP client.
 * 
 * Verifies:
 * - Client connects to real Night Worker MCP
 * - Tools list is non-empty
 * - search_records returns data
 * - Request-scoped client (no shared state)
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { getMcpTools, closeMcp } from '../lib/mcp/client';

const NIGHT_WORKER_URL = process.env.NIGHT_WORKER_URL || 'http://127.0.0.1:13579/mcp';
const NIGHT_WORKER_TOKEN = process.env.NIGHT_WORKER_TOKEN || 'integration-test-token-must-be-at-least-32-chars-long';

test('MCP client connects to Night Worker and lists tools', async () => {
  const { client, transport, tools } = await getMcpTools({
    serverUrl: NIGHT_WORKER_URL,
    authToken: NIGHT_WORKER_TOKEN,
    timeoutMs: 15000,
  });

  assert.ok(client, 'client should be returned');
  assert.ok(transport, 'transport should be returned');
  assert.ok(Array.isArray(tools), 'tools should be an array');
  assert.ok(tools.length > 0, 'should have at least one tool');

  // Clean up - this MUST be called
  await closeMcp(client, transport);
});

test('MCP client is request-scoped (separate connections)', async () => {
  const conn1 = await getMcpTools({
    serverUrl: NIGHT_WORKER_URL,
    authToken: NIGHT_WORKER_TOKEN,
    timeoutMs: 15000,
  });
  const conn2 = await getMcpTools({
    serverUrl: NIGHT_WORKER_URL,
    authToken: NIGHT_WORKER_TOKEN,
    timeoutMs: 15000,
  });

  // Two different client instances
  assert.notStrictEqual(conn1.client, conn2.client, 'Should be different client instances');
  assert.notStrictEqual(conn1.transport, conn2.transport, 'Should be different transports');

  await closeMcp(conn1.client, conn1.transport);
  await closeMcp(conn2.client, conn2.transport);
});

test('MCP client handles missing token', async () => {
  await assert.rejects(
    async () => getMcpTools({
      serverUrl: NIGHT_WORKER_URL,
      authToken: 'short',  // Too short
      timeoutMs: 5000,
    }),
    (err: Error) => {
      assert.ok(err.message.includes('32 characters'), `Should validate token length: ${err.message}`);
      return true;
    }
  );
});

test('MCP client handles missing URL', async () => {
  await assert.rejects(
    async () => getMcpTools({
      serverUrl: '',
      authToken: NIGHT_WORKER_TOKEN,
      timeoutMs: 5000,
    }),
    (err: Error) => {
      assert.ok(err.message.includes('MCP_SERVER_URL'), `Should require URL: ${err.message}`);
      return true;
    }
  );
});

// Real MCP server test (uses Node's test runner)
test('MCP client connects to real Night Worker MCP', async () => {
  const { client, transport, tools } = await getMcpTools({
    serverUrl: process.env.NIGHT_WORKER_URL || 'http://127.0.0.1:13579/mcp',
    authToken: process.env.NIGHT_WORKER_TOKEN || 'integration-test-token-must-be-at-least-32-chars-long',
    timeoutMs: 15000,
  });

  assert.ok(client, 'client returned');
  assert.ok(transport, 'transport returned');
  assert.ok(Array.isArray(tools) && tools.length > 0, `tools non-empty: ${tools.length}`);

  // Verify tool names
  const names = tools.map((t: any) => t.name);
  assert.ok(names.includes('search_records'), 'search_records tool listed');

  // Call a tool
  const r = await client.callTool({ name: 'search_records', arguments: { limit: 3 } });
  const text = (r.content as any[])?.find((c: any) => c.type === 'text');
  assert.ok(text?.text, 'Tool returned text content');

  await closeMcp(client, transport);
});
