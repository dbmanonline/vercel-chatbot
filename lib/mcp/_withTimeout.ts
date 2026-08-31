/**
 * Standalone export of withTimeout so unit tests can import it without
 * pulling in the entire @modelcontextprotocol/client ESM module.
 *
 * This file MUST stay in sync with the implementation inside client.ts.
 * If the upstream signature changes, update here too.
 */

import { McpAbortError, McpTimeoutError, withTimeout } from "./client";

export { McpAbortError, McpTimeoutError, withTimeout };
