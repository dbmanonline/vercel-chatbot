import { createOpenAI } from "@ai-sdk/openai";
import { customProvider, gateway } from "ai";
import { isTestEnvironment } from "../constants";
import { chatModels, titleModel } from "./models";

// E2E mode: create provider that routes through Hermes proxy to AgentShop247
function createE2EProvider() {
  const hermes = createOpenAI({
    apiKey: process.env.E2E_PROXY_KEY ?? "dummy",
    baseURL: process.env.E2E_PROXY_URL ?? "http://localhost:20128",
  });

  return customProvider({
    languageModels: {
      "agent-shop:claude-opus-5": hermes.languageModel("claude-opus-5"),
      "agent-shop/claude-opus-5": hermes.languageModel("claude-opus-5"),
      "chat-model": hermes.languageModel("claude-opus-5"),
      "title-model": hermes.languageModel("claude-opus-5"),
    },
  });
}

// Production mode: all models route through Vercel AI Gateway.
// gateway.languageModel(id) forwards to the AI Gateway configured in
// Vercel project settings, which handles model selection, fallbacks,
// and API key management.
function createProductionProvider() {
  const languageModels: Record<
    string,
    ReturnType<typeof gateway.languageModel>
  > = {};

  // Register all chat models via AI Gateway
  for (const model of chatModels) {
    languageModels[model.id] = gateway.languageModel(model.id);
  }

  // Also register the agent-shop variants that route via gateway
  languageModels["title-model"] = gateway.languageModel(titleModel.id);

  return customProvider({ languageModels });
}

export const myProvider = isTestEnvironment
  ? createE2EProvider()
  : createProductionProvider();

export function getLanguageModel(modelId: string) {
  return myProvider.languageModel(modelId);
}

export function getTitleModel() {
  return myProvider.languageModel(titleModel.id);
}
