import { customProvider, gateway } from "ai";
import { isTestEnvironment } from "../constants";
import { titleModel } from "./models";

export const myProvider = (() => {
  const { chatModel, titleModel: mockTitleModel } = require("./models.mock");
  const { createE2ELanguageModel } = require("./models.mock");
  return customProvider({
    languageModels: {
      "agent-shop/claude-opus-5": createE2ELanguageModel(
        "agent-shop/claude-opus-5"
      ),
      "chat-model": chatModel,
      "title-model": mockTitleModel,
    },
  });
})();

export function getLanguageModel(modelId: string) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel(modelId);
  }

  return gateway.languageModel(modelId);
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return gateway.languageModel(titleModel.id);
}
