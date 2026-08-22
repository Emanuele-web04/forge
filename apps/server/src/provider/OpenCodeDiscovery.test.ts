import type { Agent, Model, Provider } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vitest";

import { OpenCodeRuntimeError } from "./opencodeRuntime.ts";
import {
  buildOpenCodeModelContextLimitMap,
  flattenOpenCodeAgents,
  flattenOpenCodeCliModels,
  flattenOpenCodeCommands,
  flattenOpenCodeModels,
  isUnsupportedOpenCodeCommandListError,
  mergeOpenCodeCliModelDescriptors,
  resolvePreferredOpenCodeModelProviders,
} from "./OpenCodeDiscovery.ts";

type OpenCodeCommandInput = Parameters<typeof flattenOpenCodeCommands>[0][number];

type TestModelInput = Omit<Partial<Model>, "capabilities"> &
  Pick<Model, "id" | "name"> & {
    readonly capabilities?: Partial<Model["capabilities"]>;
  };

function makeProvider(input: {
  id: string;
  name: string;
  source?: Provider["source"];
  env?: ReadonlyArray<string>;
  options?: Record<string, unknown>;
  models?: Record<string, TestModelInput>;
}): Provider {
  return {
    id: input.id,
    name: input.name,
    source: input.source ?? "api",
    env: input.env ? [...input.env] : [],
    options: input.options ?? {},
    models: Object.fromEntries(
      Object.entries(input.models ?? {}).map(([modelId, model]) => [
        modelId,
        makeModel({
          providerID: input.id,
          ...model,
        }),
      ]),
    ),
  };
}

function makeModel(input: Omit<TestModelInput, "providerID"> & Pick<Model, "providerID">): Model {
  const capabilities: Model["capabilities"] = {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: true,
      video: false,
      pdf: true,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
    ...input.capabilities,
  };

  return {
    id: input.id,
    providerID: input.providerID,
    api: input.api ?? { id: "openai", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
    name: input.name,
    capabilities,
    cost: input.cost ?? {
      input: 1,
      output: 1,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: input.limit ?? {
      context: 128_000,
      output: 8_192,
    },
    status: input.status ?? "active",
    options: input.options ?? {},
    headers: input.headers ?? {},
    release_date: input.release_date ?? "2026-01-01",
    ...(input.family ? { family: input.family } : {}),
    ...(input.variants ? { variants: input.variants } : {}),
  };
}

describe("resolvePreferredOpenCodeModelProviders", () => {
  it("keeps explicit credential providers and OpenCode-managed providers together", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "openai", "opencode"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
            }),
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
            }),
          ],
        },
        consoleState: {
          consoleManagedProviders: [],
        },
      },
      credentialProviderIDs: ["openai"],
    });

    expect(providers.map((provider) => provider.id)).toEqual(["openai", "opencode"]);
  });

  it("adds console-managed connected providers to the preferred set", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "openai", "opencode", "openrouter"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
            }),
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
            }),
            makeProvider({
              id: "openrouter",
              name: "OpenRouter",
              source: "api",
            }),
          ],
        },
        consoleState: {
          consoleManagedProviders: ["openrouter"],
        },
      },
      credentialProviderIDs: ["openai"],
    });

    expect(providers.map((provider) => provider.id)).toEqual(["openai", "opencode", "openrouter"]);
  });

  it("prefers OpenCode-managed providers before generic non-environment providers", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "openai", "opencode"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
            }),
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(providers.map((provider) => provider.id)).toEqual(["opencode"]);
  });

  it("keeps connected config providers with inline apiKey even without auth.json credentials", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["fastapicloud", "opencode"],
          all: [
            makeProvider({
              id: "fastapicloud",
              name: "FastAPI Cloud AI",
              source: "config",
              options: { baseURL: "https://example.invalid/v1", apiKey: "test-key" },
            }),
            makeProvider({
              id: "opencode",
              name: "OpenCode Zen",
              source: "custom",
              env: ["OPENCODE_API_KEY"],
            }),
          ],
        },
        consoleState: null,
      },
      credentialProviderIDs: ["unrelated"],
    });

    expect(providers.map((provider) => provider.id)).toEqual(["fastapicloud", "opencode"]);
  });

  it("falls back to non-environment connected providers when no stronger OpenCode signals exist", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "openai", "openrouter"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
            }),
            makeProvider({
              id: "openrouter",
              name: "OpenRouter",
              source: "api",
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(providers.map((provider) => provider.id)).toEqual(["openai", "openrouter"]);
  });

  it("falls back to every connected provider when only environment providers are connected", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "cloudflare-workers-ai"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "cloudflare-workers-ai",
              name: "Cloudflare Workers AI",
              source: "env",
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(providers.map((provider) => provider.id)).toEqual([
      "cloudflare-ai-gateway",
      "cloudflare-workers-ai",
    ]);
  });
});
describe("flattenOpenCodeModels", () => {
  it("converts OpenCode CLI model output into grouped model descriptors", () => {
    const models = flattenOpenCodeCliModels({
      models: [
        {
          slug: "openai/gpt-5.4",
          providerID: "openai",
          modelID: "gpt-5.4",
          name: "GPT-5.4",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "opencode/minimax-m2.5-free",
          providerID: "opencode",
          modelID: "minimax-m2.5-free",
          name: "MiniMax M2.5 Free",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "opencode-go/kimi-k2.6",
          providerID: "opencode-go",
          modelID: "kimi-k2.6",
          name: "Kimi K2.6",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "kimi-for-coding/k2p6",
          providerID: "kimi-for-coding",
          modelID: "k2p6",
          name: "K2P6",
          variants: [],
          supportedReasoningEfforts: [
            {
              value: "high",
            },
          ],
          defaultReasoningEffort: "high",
        },
        {
          slug: "github-copilot/claude-sonnet-4.6",
          providerID: "github-copilot",
          modelID: "claude-sonnet-4.6",
          name: "Claude Sonnet 4.6",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "anthropic/claude-sonnet-4-5",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "google-vertex/gemini-3-pro",
          providerID: "google-vertex",
          modelID: "gemini-3-pro",
          name: "Gemini 3 Pro",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "openrouter/qwen/qwen3-coder",
          providerID: "openrouter",
          modelID: "qwen/qwen3-coder",
          name: "Qwen3 Coder",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "ollama/qwen3-coder:30b",
          providerID: "ollama",
          modelID: "qwen3-coder:30b",
          name: "Qwen3 Coder 30B",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "amazon-bedrock/anthropic-claude-sonnet-4.5",
          providerID: "amazon-bedrock",
          modelID: "anthropic-claude-sonnet-4.5",
          name: "Claude Sonnet 4.5",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "vercel-ai-gateway/xai/grok-code-fast",
          providerID: "vercel-ai-gateway",
          modelID: "xai/grok-code-fast",
          name: "Grok Code Fast",
          variants: [],
          supportedReasoningEfforts: [],
        },
      ],
    });

    expect(models).toEqual([
      {
        slug: "amazon-bedrock/anthropic-claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        upstreamProviderId: "amazon-bedrock",
        upstreamProviderName: "Amazon Bedrock",
      },
      {
        slug: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
      },
      {
        slug: "github-copilot/claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        upstreamProviderId: "github-copilot",
        upstreamProviderName: "GitHub Copilot",
      },
      {
        slug: "google-vertex/gemini-3-pro",
        name: "Gemini 3 Pro",
        upstreamProviderId: "google-vertex",
        upstreamProviderName: "Google Vertex AI",
      },
      {
        slug: "kimi-for-coding/k2p6",
        name: "K2P6",
        upstreamProviderId: "kimi-for-coding",
        upstreamProviderName: "Kimi For Coding",
        supportedReasoningEfforts: [
          {
            value: "high",
          },
        ],
        defaultReasoningEffort: "high",
      },
      {
        slug: "ollama/qwen3-coder:30b",
        name: "Qwen3 Coder 30B",
        upstreamProviderId: "ollama",
        upstreamProviderName: "Ollama",
      },
      {
        slug: "openai/gpt-5.4",
        name: "GPT-5.4",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
      },
      {
        slug: "opencode/minimax-m2.5-free",
        name: "MiniMax M2.5 Free",
        upstreamProviderId: "opencode",
        upstreamProviderName: "OpenCode",
      },
      {
        slug: "opencode-go/kimi-k2.6",
        name: "Kimi K2.6",
        upstreamProviderId: "opencode-go",
        upstreamProviderName: "OpenCode Go",
      },
      {
        slug: "openrouter/qwen/qwen3-coder",
        name: "Qwen3 Coder",
        upstreamProviderId: "openrouter",
        upstreamProviderName: "OpenRouter",
      },
      {
        slug: "vercel-ai-gateway/xai/grok-code-fast",
        name: "Grok Code Fast",
        upstreamProviderId: "vercel-ai-gateway",
        upstreamProviderName: "Vercel AI Gateway",
      },
    ]);
  });

  it("includes upstream provider metadata for grouped OpenCode model menus", () => {
    const models = flattenOpenCodeModels({
      inventory: {
        providerList: {
          connected: ["opencode", "openai"],
          all: [
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
              models: {
                "nemotron-3-super-free": {
                  id: "nemotron-3-super-free",
                  name: "Nemotron 3 Super Free",
                },
              },
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
              models: {
                "gpt-5": {
                  id: "gpt-5",
                  name: "GPT-5",
                },
              },
            }),
          ],
        },
        consoleState: {
          consoleManagedProviders: ["openai"],
        },
      },
    });

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "GPT-5",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
        contextWindowOptions: [{ value: "128k", label: "128K", isDefault: true }],
        defaultContextWindow: "128k",
      },
      {
        slug: "opencode/nemotron-3-super-free",
        name: "Nemotron 3 Super Free",
        upstreamProviderId: "opencode",
        upstreamProviderName: "OpenCode",
        contextWindowOptions: [{ value: "128k", label: "128K", isDefault: true }],
        defaultContextWindow: "128k",
      },
    ]);
  });

  it("surfaces reasoning variants as supported thinking levels for OpenCode models", () => {
    const models = flattenOpenCodeModels({
      inventory: {
        providerList: {
          connected: ["openai"],
          all: [
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  capabilities: {
                    reasoning: true,
                  },
                  variants: {
                    none: {
                      reasoningEffort: "none",
                    },
                    low: {
                      reasoningEffort: "low",
                    },
                    minimal: {
                      reasoning: {
                        effort: "minimal",
                      },
                    },
                    medium: {
                      reasoningEffort: "medium",
                    },
                    high: {
                      reasoningEffort: "high",
                    },
                    xhigh: {
                      reasoningEffort: "xhigh",
                    },
                    custom: {
                      label: "Do not treat as thinking",
                    },
                  },
                },
              },
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        name: "GPT-5.4",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
        contextWindowOptions: [{ value: "128k", label: "128K", isDefault: true }],
        defaultContextWindow: "128k",
        supportedReasoningEfforts: [
          {
            value: "none",
          },
          {
            value: "low",
          },
          {
            value: "minimal",
          },
          {
            value: "medium",
          },
          {
            value: "high",
          },
          {
            value: "xhigh",
          },
        ],
        defaultReasoningEffort: "medium",
      },
    ]);
  });

  it("trims upstream provider and model names before exposing runtime models", () => {
    const models = flattenOpenCodeModels({
      inventory: {
        providerList: {
          connected: ["openai"],
          all: [
            makeProvider({
              id: "openai",
              name: " OpenAI ",
              source: "api",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: " GPT-5.4 ",
                },
              },
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        name: "GPT-5.4",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
        contextWindowOptions: [{ value: "128k", label: "128K", isDefault: true }],
        defaultContextWindow: "128k",
      },
    ]);
  });

  it("prefers OpenCode-managed connected providers when no stronger auth metadata exists", () => {
    const models = flattenOpenCodeModels({
      inventory: {
        providerList: {
          connected: ["opencode", "github-copilot"],
          all: [
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
              models: {
                "glm-4.6": {
                  id: "glm-4.6",
                  name: "GLM 4.6",
                },
              },
            }),
            makeProvider({
              id: "github-copilot",
              name: "GitHub Copilot",
              source: "api",
              models: {
                "claude-opus-4.6": {
                  id: "claude-opus-4.6",
                  name: "Claude Opus 4.6",
                },
              },
            }),
            makeProvider({
              id: "openrouter",
              name: "OpenRouter",
              source: "api",
              models: {
                "qwen/qwen3-coder": {
                  id: "qwen/qwen3-coder",
                  name: "Qwen3 Coder",
                },
              },
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(models.map((model) => model.slug)).toEqual(["opencode/glm-4.6"]);
  });
});

describe("OpenCode discovery helpers", () => {
  it("maps only positive integer model context limits by canonical slug", () => {
    const inventory = {
      providerList: {
        connected: ["openai"],
        all: [
          makeProvider({
            id: "openai",
            name: "OpenAI",
            models: {
              valid: {
                id: "valid",
                name: "Valid",
                limit: { context: 200_000, output: 8_192 },
              },
              zero: {
                id: "zero",
                name: "Zero",
                limit: { context: 0, output: 8_192 },
              },
              fractional: {
                id: "fractional",
                name: "Fractional",
                limit: { context: 1.5, output: 8_192 },
              },
            },
          }),
        ],
      },
      consoleState: null,
    };

    expect([...buildOpenCodeModelContextLimitMap(inventory)]).toEqual([["openai/valid", 200_000]]);
  });

  it("normalizes visible primary agents and commands without leaking hidden entries", () => {
    const agents = flattenOpenCodeAgents([
      {
        name: "project-review",
        mode: "primary",
        hidden: false,
        description: " Review the project ",
        model: { providerID: "anthropic", modelID: "claude-opus" },
      } as Agent,
      {
        name: "hidden-agent",
        mode: "primary",
        hidden: true,
      } as Agent,
      {
        name: "subagent-only",
        mode: "subagent",
        hidden: false,
      } as Agent,
    ]);
    const commands = flattenOpenCodeCommands([
      { name: " review ", description: " Review code " } as OpenCodeCommandInput,
      { name: "build", description: "   " } as OpenCodeCommandInput,
      { name: "   " } as OpenCodeCommandInput,
    ]);

    expect(agents).toEqual([
      {
        name: "project-review",
        displayName: "Project Review",
        description: " Review the project ",
        model: "anthropic/claude-opus",
      },
    ]);
    expect(commands).toEqual([{ name: "build" }, { name: "review", description: "Review code" }]);
  });

  it("classifies only command-discovery compatibility failures as unsupported", () => {
    const error = (detail: string) =>
      new OpenCodeRuntimeError({ operation: "command.list", detail });

    expect(isUnsupportedOpenCodeCommandListError(error("status=404 body={}"))).toBe(true);
    expect(isUnsupportedOpenCodeCommandListError(error("unknown method command.list"))).toBe(true);
    expect(isUnsupportedOpenCodeCommandListError(error("connection refused"))).toBe(false);
  });

  it("preserves generic provider title-casing when merged CLI models are absent from inventory", () => {
    const models = mergeOpenCodeCliModelDescriptors({
      inventory: {
        providerList: { connected: [], all: [] },
        consoleState: null,
      },
      models: [],
      cliModels: [
        {
          slug: "xai/grok-code-fast",
          providerID: "xai",
          modelID: "grok-code-fast",
          name: "Grok Code Fast",
          variants: [],
          supportedReasoningEfforts: [],
        },
      ],
    });

    expect(models).toEqual([
      {
        slug: "xai/grok-code-fast",
        name: "Grok Code Fast",
        upstreamProviderId: "xai",
        upstreamProviderName: "Xai",
      },
    ]);
  });
});
