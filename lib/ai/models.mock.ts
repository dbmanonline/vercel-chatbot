// E2E test mock — excluded from biome lint.
// Exports a custom provider that uses OpenAI-compatible API with Hermes proxy.

import { customProvider } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

// Create the OpenAI-compatible provider pointing at Hermes proxy
const hermes = createOpenAI({
  baseURL: process.env.E2E_PROXY_URL ?? "http://localhost:20128",
  headers: {
    Authorization: `Bearer ${process.env.E2E_PROXY_KEY ?? ""}`,
  },
});

export const myProvider = customProvider({
  languageModels: {
    // Map agent-shop/claude-opus-5 → Hermes → AgentShop247
    "agent-shop:claude-opus-5": hermes.languageModel("claude-opus-5"),
    "agent-shop/claude-opus-5": hermes.languageModel("claude-opus-5"),
  },
});
