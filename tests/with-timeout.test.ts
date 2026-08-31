/**
 * withTimeout unit tests - SDK-independent.
 * Verifies Promise.race semantics: success, timeout, abort, listener cleanup.
 *
 * These tests run WITHOUT the MCP SDK and WITHOUT a real Night Worker, so
 * they will never be cancelled by lingering SDK transport activity.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  McpAbortError,
  McpTimeoutError,
  withTimeout,
} from "../lib/mcp/_withTimeout";

// Spy helper: count add/remove listeners on an AbortSignal.
type Spy = { added: number; removed: number };
function spyAbort(signal: AbortSignal): Spy {
  const spy: Spy = { added: 0, removed: 0 };
  const origAdd = signal.addEventListener.bind(signal);
  const origRemove = signal.removeEventListener.bind(signal);
  (signal as any).addEventListener = (type: any, l: any, o?: any) => {
    if (type === "abort") {
      spy.added++;
    }
    return origAdd(type, l, o);
  };
  (signal as any).removeEventListener = (type: any, l: any, o?: any) => {
    if (type === "abort") {
      spy.removed++;
    }
    return origRemove(type, l, o);
  };
  return spy;
}

test("withTimeout resolves with the MCP promise when it finishes before the timeout", async () => {
  const result = await withTimeout(Promise.resolve("ok"), 1000, undefined);
  assert.equal(result, "ok");
});

test("withTimeout rejects with McpTimeoutError when the promise is too slow", async () => {
  const slow = new Promise((res) => setTimeout(() => res("late"), 5000));
  const start = Date.now();
  await assert.rejects(withTimeout(slow, 50, undefined), (err: unknown) => {
    assert.ok(
      err instanceof McpTimeoutError,
      `expected McpTimeoutError, got ${err}`
    );
    return true;
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `should reject fast (${elapsed}ms)`);
});

test("withTimeout rejects with McpAbortError when the AbortSignal fires during the call", async () => {
  const ac = new AbortController();
  const slow = new Promise((res) => setTimeout(() => res("done"), 5000));
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(withTimeout(slow, 60_000, ac.signal), (err: unknown) => {
    assert.ok(
      err instanceof McpAbortError,
      `expected McpAbortError, got ${err}`
    );
    return true;
  });
});

test("withTimeout rejects immediately when the AbortSignal is already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  const slow = new Promise((res) => setTimeout(() => res("done"), 5000));
  await assert.rejects(withTimeout(slow, 60_000, ac.signal), (err: unknown) => {
    assert.ok(
      err instanceof McpAbortError,
      `expected McpAbortError, got ${err}`
    );
    return true;
  });
});

test("withTimeout attaches and removes one abort listener after success (no leak)", async () => {
  const ac = new AbortController();
  const spy = spyAbort(ac.signal);
  const fast = Promise.resolve("done");
  await withTimeout(fast, 60_000, ac.signal);
  assert.equal(spy.added, 1, "expected exactly one abort listener attached");
  assert.equal(
    spy.removed,
    1,
    "expected the abort listener to be removed after success"
  );
});

test("withTimeout attaches and removes one abort listener after timeout (no leak)", async () => {
  const ac = new AbortController();
  const spy = spyAbort(ac.signal);
  const slow = new Promise((res) => setTimeout(() => res("late"), 5000));
  await assert.rejects(withTimeout(slow, 30, ac.signal));
  assert.equal(spy.added, 1, "abort listener should have been attached once");
  assert.equal(spy.removed, 1, "abort listener must be removed after timeout");
});

test("withTimeout attaches and removes one abort listener after abort (no leak)", async () => {
  const ac = new AbortController();
  const spy = spyAbort(ac.signal);
  const slow = new Promise((res) => setTimeout(() => res("late"), 5000));
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(withTimeout(slow, 60_000, ac.signal));
  assert.equal(spy.added, 1, "abort listener should have been attached once");
  assert.equal(spy.removed, 1, "abort listener must be removed after abort");
});

test("withTimeout propagates MCP-side errors verbatim (no swallow)", async () => {
  const err = new Error("mcp-side failure");
  await assert.rejects(
    withTimeout(Promise.reject(err), 60_000, undefined),
    /mcp-side failure/
  );
});

test("withTimeout passes through unchanged when neither timeout nor abort is configured", async () => {
  const result = await withTimeout(Promise.resolve(42), undefined, undefined);
  assert.equal(result, 42);
});

test("withTimeout never emits unhandledRejection across 50 fast timeouts", async () => {
  const leaked: unknown[] = [];
  const handler = (reason: unknown) => {
    leaked.push(reason);
  };
  process.on("unhandledRejection", handler);
  try {
    const runs = Array.from({ length: 50 }, () => {
      const slow = new Promise((res) => setTimeout(() => res("late"), 5000));
      return assert.rejects(withTimeout(slow, 5, undefined));
    });
    await Promise.all(runs);
    await new Promise((r) => setImmediate(r));
    assert.equal(
      leaked.length,
      0,
      `withTimeout leaked: ${JSON.stringify(leaked)}`
    );
  } finally {
    process.off("unhandledRejection", handler);
  }
});
