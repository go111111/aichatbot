import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { customProvider } from "ai";
import { isTestEnvironment } from "../constants";
import { titleModel } from "./models";

export const myProvider =
  isTestEnvironment || process.env.AI_PROVIDER === "mock"
  ? (() => {
      const { chatModel, titleModel } = require("./models.mock");
      return customProvider({
        languageModels: {
          "chat-model": chatModel,
          "title-model": titleModel,
        },
      });
    })()
  : null;

export function getLanguageModel(modelId: string) {
  const provider = process.env.AI_PROVIDER ?? "deepseek";

  if ((provider === "mock" || isTestEnvironment) && myProvider) {
    return myProvider.languageModel("chat-model");
  }

  if (provider === "openai") {
    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    return openai.languageModel(modelId);
  }

  const deepseek = createOpenAICompatible({
    name: "deepseek",
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  });
  return deepseek.languageModel(modelId);
}

export function getTitleModel() {
  const provider = process.env.AI_PROVIDER ?? "deepseek";

  if ((provider === "mock" || isTestEnvironment) && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return getLanguageModel(titleModel.id);
}
