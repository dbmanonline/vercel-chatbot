import type { LanguageModel } from "ai";

const mockResponses: Record<string, string> = {
  default: "This is a mock response for testing.",
  greeting: "Hello! How can I help you today?",
  weather: "The weather in San Francisco is sunny and 72°F.",
};

const mockUsage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
  outputTokens: { reasoning: 0, text: 20, total: 20 },
};

function getResponseForPrompt(prompt: unknown): string {
  const promptStr = JSON.stringify(prompt).toLowerCase();

  if (promptStr.includes("weather") || promptStr.includes("temperature")) {
    return mockResponses.weather;
  }
  if (
    promptStr.includes("hello") ||
    promptStr.includes("hi") ||
    promptStr.includes("hey")
  ) {
    return mockResponses.greeting;
  }

  return mockResponses.default;
}

const createMockModel = (): LanguageModel =>
  ({
    defaultObjectGenerationMode: "tool",
    doGenerate: async ({ prompt }: { prompt: unknown }) => ({
      content: [{ text: getResponseForPrompt(prompt), type: "text" }],
      finishReason: "stop",
      usage: mockUsage,
      warnings: [],
    }),
    doStream: ({ prompt }: { prompt: unknown }) => {
      const response = getResponseForPrompt(prompt);
      const words = response.split(" ");

      return {
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ id: "t1", type: "text-start" });
            await words.reduce<Promise<void>>(async (previous, word) => {
              await previous;
              controller.enqueue({
                delta: `${word} `,
                id: "t1",
                type: "text-delta",
              });
              await new Promise((resolve) => {
                setTimeout(resolve, 10);
              });
            }, Promise.resolve());
            controller.enqueue({ id: "t1", type: "text-end" });
            controller.enqueue({
              finishReason: "stop",
              type: "finish",
              usage: mockUsage,
            });
            controller.close();
          },
        }),
      };
    },
    modelId: "mock-model",
    provider: "mock",
    specificationVersion: "v3",
    supportedUrls: {},
  }) as unknown as LanguageModel;

const createMockTitleModel = (): LanguageModel =>
  ({
    defaultObjectGenerationMode: "tool",
    doGenerate: async () => ({
      content: [{ text: "Test Conversation", type: "text" }],
      finishReason: "stop",
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 5, total: 5 },
        outputTokens: { reasoning: 0, text: 5, total: 5 },
      },
      warnings: [],
    }),
    doStream: () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ id: "t1", type: "text-start" });
          controller.enqueue({
            delta: "Test Conversation",
            id: "t1",
            type: "text-delta",
          });
          controller.enqueue({ id: "t1", type: "text-end" });
          controller.enqueue({
            finishReason: "stop",
            type: "finish",
            usage: {
              inputTokens: {
                cacheRead: 0,
                cacheWrite: 0,
                noCache: 5,
                total: 5,
              },
              outputTokens: { reasoning: 0, text: 5, total: 5 },
            },
          });
          controller.close();
        },
      }),
    }),
    modelId: "mock-title-model",
    provider: "mock",
    specificationVersion: "v3",
    supportedUrls: {},
  }) as unknown as LanguageModel;

export const chatModel = createMockModel();
export const titleModel = createMockTitleModel();

/**
 * E2E local: routes model through the local proxy (localhost:20128)
 * instead of Vercel AI Gateway. Uses streaming SSE to match real behavior.
 *
 * Set E2E_PROXY_URL and E2E_PROXY_KEY env vars before importing this.
 */
export function createE2ELanguageModel(modelId: string): LanguageModel {
  const baseUrl = process.env.E2E_PROXY_URL ?? "http://localhost:20128";
  void process.env.E2E_PROXY_KEY;

  const finishChunk = {
    finishReason: "stop" as const,
    type: "finish" as const,
    usage: {
      inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 0, total: 0 },
      outputTokens: { reasoning: 0, text: 0, total: 0 },
    },
  };

  async function* streamEvents(
    messages: unknown,
    tools?: unknown,
  ): AsyncGenerator<unknown> {
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      body: JSON.stringify({ messages, model: modelId, stream: true, tools }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (!resp.ok) throw new Error(`E2E proxy error ${resp.status}`);

    const reader = (resp.body as ReadableStream).getReader();
    const dec = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;

        buf += dec.decode(result.value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const rawLine of lines) {
          if (!rawLine.startsWith("data: ")) continue;
          const txt = rawLine.slice(6).trim();
          if (txt === "[DONE]") {
            yield finishChunk;
            continue;
          }

          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(txt) as Record<string, unknown>;
          } catch (_) {
            continue;
          }

          const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
          const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;

          if (delta?.role) yield { id: parsed.id, type: "start" as const };
          if (typeof delta?.content === "string") {
            yield { delta: delta.content, id: parsed.id, type: "text-delta" as const };
          }
          const calls = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
          if (calls?.length) {
            const fc = calls[0].function as Record<string, string>;
            yield {
              args: fc.arguments,
              id: parsed.id,
              toolCallId: calls[0].id,
              toolName: fc.name,
              type: "tool-call" as const,
            };
          }
          if (choices?.[0]?.finish_reason) yield finishChunk;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function nonStreamFetch(messages: unknown, tools?: unknown) {
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      body: JSON.stringify({ messages, model: modelId, stream: false, tools }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (!resp.ok) throw new Error(`E2E proxy error ${resp.status}`);
    const data = await resp.json() as {
      choices: Array<{
        message: {
          content: string;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const msg = data.choices[0]?.message;
    const calls = msg?.tool_calls?.map((tc) => ({
      function: { arguments: tc.function.arguments, name: tc.function.name },
      id: tc.id,
      type: tc.type as "function",
    }));

    return {
      content: calls
        ? [
            {
              args: calls[0].function.arguments,
              toolCallId: calls[0].id,
              toolName: calls[0].function.name,
              type: "tool-call" as const,
            },
          ]
        : [{ text: msg?.content ?? "", type: "text" as const }],
      finishReason: (data.choices[0]?.finish_reason ?? "stop") as "stop",
      modelId,
      provider: "e2e-proxy",
      request: { body: {}, headers: {} },
      usage: {
        inputTokens: {
          cacheRead: 0,
          cacheWrite: 0,
          noCache: data.usage?.prompt_tokens ?? 0,
          total: data.usage?.prompt_tokens ?? 0,
        },
        outputTokens: {
          reasoning: 0,
          text: data.usage?.completion_tokens ?? 0,
          total: data.usage?.completion_tokens ?? 0,
        },
      },
      warnings: [],
    };
  }

  return {
    defaultObjectGenerationMode: "tool",
    doGenerate: async ({ prompt, tools }: { prompt: unknown; tools?: unknown }) =>
      nonStreamFetch(prompt, tools),
    doStream: ({ prompt, tools }: { prompt: unknown; tools?: unknown }) => ({
      stream: new ReadableStream({
        async start(controller) {
          try {
            for await (const ev of streamEvents(prompt, tools)) {
              controller.enqueue(ev);
            }
          } finally {
            controller.close();
          }
        },
      }),
    }),
    modelId,
    provider: "e2e-proxy",
    specificationVersion: "v3",
    supportedUrls: {},
  } as unknown as LanguageModel;
}
