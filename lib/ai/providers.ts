import { createOpenAI } from "@ai-sdk/openai";
import { customProvider, gateway } from "ai";
import { isTestEnvironment } from "../constants";
import { titleModel } from "./models";

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

// Production mode: use Vercel AI Gateway
function createProductionProvider() {
  return customProvider({
    languageModels: {
      [titleModel.id]: gateway.languageModel(titleModel.id),
    },
  });
}

export const myProvider = isTestEnvironment
  ? createE2EProvider()
  : createProductionProvider();

export function getLanguageModel(modelId: string) {
  return myProvider.languageModel(modelId);
}

export function getTitleModel() {
  return myProvider.languageModel("title-model");
}
