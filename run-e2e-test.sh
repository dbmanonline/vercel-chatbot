#!/bin/bash
# Run the /api/chat E2E test locally using local proxy + Night Worker MCP

set -e

PROXY_KEY=$(python -c "
path = r'C:\Users\farmer\AppData\Local\h ermes\.env'
for line in open(path):
    if 'LOCAL_API_KEY' in line and '=' in line:
        print(line.strip().split('=',1)[1])
        break
")

echo "Starting Next.js on port 3515..."
cd /d/vercel-chatbot

E2E_BYPASS_AUTH=1 \
E2E_PROXY_URL=http://localhost:20128 \
E2E_PROXY_KEY="$PROXY_KEY" \
NIGHT_WORKER_URL=http://127.0.0.1:13579/mcp \
NIGHT_WORKER_TOKEN=e2e-test-token-must-be-at-least-32-chars-long \
AUTH_SECRET=e2e-auth-secret-must-be-long-enough \
PORT=3515 \
npx next dev --turbo --port 3515 &
SERVER_PID=$!

cleanup() {
  echo "Stopping Next.js (PID $SERVER_PID)..."
  kill $SERVER_PID 2>/dev/null || true
}
trap cleanup EXIT

# Wait for server
echo "Waiting for server to start..."
for i in $(seq 1 30); do
  if curl -s --max-time 2 http://127.0.0.1:3515/api/chat -X POST -H "Content-Type: application/json" -d '{"id":"550e8400-e29b-41d4-a716-446655440000","messages":[],"selectedChatModel":"agent-shop/claude-opus-5","selectedVisibilityType":"private"}' 2>/dev/null | grep -qv "redirect\|api/auth"; then
    echo "Server ready!"
    break
  fi
  sleep 1
done

echo "Running E2E test..."
PLAYWRIGHT=True E2E_CHATBOT_PORT=3515 E2E_PROXY_KEY="$PROXY_KEY" NIGHT_WORKER_URL=http://127.0.0.1:13579/mcp NIGHT_WORKER_TOKEN=e2e-test-token-must-be-at-least-32-chars-long npx tsx --test tests/e2e-real-model-chat.test.ts
