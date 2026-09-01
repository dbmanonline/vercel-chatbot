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

/** E2E local: routes model through the local proxy instead of Vercel AI Gateway. */
export function createE2ELanguageModel(modelId: string): LanguageModel {
  const baseUrl = process.env.E2E_PROXY_URL ?? "http://localhost:20128";
  const apiKey = process.env.E2E_PROXY_KEY ?? "";

  async function nonStreamFetch(messages: unknown, tools?: unknown) {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      body: JSON.stringify({ messages, model: modelId, stream: false, tools }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`E2E proxy error ${response.status}`);
    }
    const data = await response.json() as {
      choices: Array<{
        message: { content: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
        finish_reason: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const msg = data.choices[0]?.message;
    const toolCalls = msg?.tool_calls?.map((tc) => ({
      function: { arguments: tc.function.arguments, name: tc.function.name },
      id: tc.id,
      type: tc.type as "function",
    }));
    return {
      content: toolCalls
        ? [{ args: toolCalls[0].function.arguments, toolCallId: toolCalls[0].id, toolName: toolCalls[0].function.name, type: "tool-call" as const }]
        : [{ text: msg?.content ?? "", type: "text" as const }],
      finishReason: (data.choices[0]?.finish_reason ?? "stop") as "stop",
      modelId,
      provider: "e2e-proxy",
      request: { body: {}, headers: {} },
      usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: data.usage?.prompt_tokens ?? 0, total: data.usage?.prompt_tokens ?? 0 }, outputTokens: { reasoning: 0, text: data.usage?.completion_tokens ?? 0, total: data.usage?.completion_tokens ?? 0 } },
      warnings: [],
    };
  }

  async function* streamFetch(messages: unknown, tools?: unknown): AsyncGenerator<unknown> {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      body: JSON.stringify({ messages, model: modelId, stream: true, tools }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok) { throw new Error(`E2E proxy error ${response.status}`); }
    const reader = (response.body as ReadableStream).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) { break; }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) { continue; }
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          yield { finishReason: "stop" as const, type: "finish" as const, usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 0, total: 0 }, outputTokens: { reasoning: 0, text: 0, total: 0 } }
        }
        try {
          const chunk = JSON.parse(data) as {
            id: string; choices: Array<{
              delta: { role?: string; content?: string; tool_calls?: Array<{ index: number; id: string; type: string; function: { name: string; arguments: string } }> };
              finish_reason?: string;
            }>;
          };
          const delta = chunk.choices[0]?.delta;
          if (delta?.role) { yield { id: chunk.id, type: "start" as const }; }
          if (delta?.content) { yield { delta: delta.content, id: chunk.id, type: "text-delta" as const }; }
          if (delta?.tool_calls?.[0]) {
            const tc = delta.tool_calls[0];
            yield { args: tc.function.arguments, id: chunk.id, toolCallId: tc.id, toolName: tc.function.name, type: "tool-call" as const };
          }
          if (chunk.choices[0]?.finish_reason) {
            yield { finishReason: chunk.choices[0].finish_reason as "stop", type: "finish" as const, usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 0, total: 0 }, outputTokens: { reasoning: 0, text: 0, total: 0 } }
          }
        } catch (_) { /* skip */ }
      }
    }
  }

  return {
    defaultObjectGenerationMode: "tool",
    doGenerate: async ({ prompt, tools }: { prompt: unknown; tools?: unknown }) =>
      nonStreamFetch(prompt, tools),
    doStream: ({ prompt, tools }: { prompt: unknown; tools?: unknown }) => ({
      stream: new ReadableStream({ async start(controller) {
        try {
          for await (const event of streamFetch(prompt, tools)) {
            controller.enqueue(event);
          }
        } finally {
          controller.close();
        }
      } }),
    }),
    modelId,
    provider: "e2e-proxy",
    specificationVersion: "v3",
    supportedUrls: {},
  } as unknown as LanguageModel;
}
