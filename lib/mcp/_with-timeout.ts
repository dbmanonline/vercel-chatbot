/**
 * Re-export of withTimeout primitives for unit tests.
 *
 * The implementation lives in `client.ts`. This thin re-export avoids
 * pulling the SDK import side-effects of `client.ts` into test
 * modules that only need the timeout primitives.
 */

export { McpAbortError, McpTimeoutError, withTimeout } from "./client";
