export const AI_PROVIDER = process.env.AI_PROVIDER ?? "deepseek";

const defaultModelByProvider: Record<string, string> = {
  deepseek: "deepseek-v4-flash",
  openai: "gpt-4.1-mini",
  mock: "chat-model",
};

export const DEFAULT_CHAT_MODEL =
  process.env.DEFAULT_CHAT_MODEL ??
  defaultModelByProvider[AI_PROVIDER] ??
  "deepseek-v4-flash";

export const titleModel = {
  id: process.env.TITLE_MODEL ?? DEFAULT_CHAT_MODEL,
  name: "Default title model",
  provider: AI_PROVIDER,
  description: "Fast model for title generation",
};

export type ModelCapabilities = {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
};

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
  capabilities: ModelCapabilities;
};

export const chatModels: ChatModel[] = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    provider: "deepseek",
    description: "Default DeepSeek V4 model for cost-effective production chat",
    capabilities: { tools: false, vision: false, reasoning: false },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    description: "Stronger DeepSeek V4 model for coding and reasoning tasks",
    capabilities: { tools: false, vision: false, reasoning: true },
  },
  {
    id: "gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    provider: "openai",
    description: "Optional OpenAI model when AI_PROVIDER=openai",
    capabilities: { tools: true, vision: false, reasoning: false },
  },
  {
    id: "chat-model",
    name: "Mock Chat",
    provider: "mock",
    description: "Local mock model for development and tests",
    capabilities: { tools: false, vision: false, reasoning: false },
  },
];

export async function getCapabilities(): Promise<
  Record<string, ModelCapabilities>
> {
  return Object.fromEntries(
    getActiveModels().map((model) => [model.id, model.capabilities])
  );
}

export const isDemo = process.env.IS_DEMO === "1";

export function getActiveModels(): ChatModel[] {
  return chatModels.filter((model) => model.provider === AI_PROVIDER);
}

export const allowedModelIds = new Set(getActiveModels().map((m) => m.id));

export const modelsByProvider = chatModels.reduce(
  (acc, model) => {
    if (!acc[model.provider]) {
      acc[model.provider] = [];
    }
    acc[model.provider].push(model);
    return acc;
  },
  {} as Record<string, ChatModel[]>
);
