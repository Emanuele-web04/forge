import { Effect } from "effect";
import type * as Acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import {
  applyCursorAcpModelSelection,
  buildCursorCliModelListCommand,
  buildCursorAcpModelDescriptors,
  buildCursorAcpModelDescriptorsFromAvailableModels,
  buildCursorAcpSpawnInput,
  flattenCursorAcpModelChoices,
  parseCursorCliModelList,
  type CursorAcpAvailableModel,
} from "./CursorAcpSupport.ts";

const parameterizedGpt54ConfigOptions: ReadonlyArray<Acp.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gpt-5.4-medium-fast",
    options: [{ value: "gpt-5.4-medium-fast", name: "GPT-5.4" }],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "extra-high", name: "Extra High" },
    ],
  },
  {
    id: "context",
    name: "Context",
    category: "model_config",
    type: "select",
    currentValue: "272k",
    options: [
      { value: "272k", name: "272K" },
      { value: "1m", name: "1M" },
    ],
  },
  {
    id: "fast",
    name: "Fast",
    category: "model_config",
    type: "select",
    currentValue: "false",
    options: [
      { value: "false", name: "Off" },
      { value: "true", name: "Fast" },
    ],
  },
];

const parameterizedCursorVariantConfigOptions: ReadonlyArray<Acp.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gpt-5.3-codex[reasoning=medium,fast=false]",
    options: [
      { value: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "GPT-5.3 Codex" },
      {
        value: "claude-opus-4-6[thinking=true,context=200k,effort=high,fast=false]",
        name: "Claude Opus 4.6",
      },
    ],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "extra-high", name: "Extra High" },
    ],
  },
  {
    id: "context",
    name: "Context",
    category: "model_config",
    type: "select",
    currentValue: "200k",
    options: [
      { value: "200k", name: "200K" },
      { value: "1m", name: "1M" },
    ],
  },
  {
    id: "fast",
    name: "Fast",
    category: "model_config",
    type: "select",
    currentValue: "false",
    options: [
      { value: "false", name: "Off" },
      { value: "true", name: "Fast" },
    ],
  },
];

const noCursorAgentCommandOptions = {
  env: { PATH: "" },
  pathExists: () => false,
};

describe("buildCursorAcpSpawnInput", () => {
  it("builds the default Cursor ACP command", () => {
    expect(buildCursorAcpSpawnInput(undefined, "/tmp/project")).toMatchObject({
      command: "cursor-agent",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        NO_BROWSER: "true",
        BROWSER: "www-browser",
      },
    });
  });

  it("maps the old ambiguous agent default to cursor-agent", () => {
    expect(buildCursorAcpSpawnInput({ binaryPath: "agent" }, "/tmp/project")).toMatchObject({
      command: "cursor-agent",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        NO_BROWSER: "true",
        BROWSER: "www-browser",
      },
    });
  });

  it("uses configured Cursor editor launchers when no agent command is resolved", () => {
    expect(
      buildCursorAcpSpawnInput(
        { binaryPath: "/not-real/bin/cursor" },
        "/tmp/project",
        noCursorAgentCommandOptions,
      ),
    ).toMatchObject({
      command: "/not-real/bin/cursor",
      args: ["agent", "acp"],
      cwd: "/tmp/project",
      env: {
        NO_BROWSER: "true",
        BROWSER: "www-browser",
      },
    });
  });

  it("uses bundled sibling agent commands for Cursor editor ACP startup", () => {
    const cursorPath = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
    const agentPath = "/Applications/Cursor.app/Contents/Resources/app/bin/agent";
    expect(
      buildCursorAcpSpawnInput({ binaryPath: cursorPath }, "/tmp/project", {
        env: { PATH: "" },
        pathExists: (path) => path === agentPath,
      }),
    ).toMatchObject({
      command: agentPath,
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        NO_BROWSER: "true",
        BROWSER: "www-browser",
      },
    });
  });

  it("includes the configured api endpoint when present", () => {
    expect(
      buildCursorAcpSpawnInput(
        {
          binaryPath: "/usr/local/bin/agent",
          apiEndpoint: "http://localhost:3000",
        },
        "/tmp/project",
      ),
    ).toMatchObject({
      command: "/usr/local/bin/agent",
      args: ["-e", "http://localhost:3000", "acp"],
      cwd: "/tmp/project",
      env: {
        NO_BROWSER: "true",
        BROWSER: "www-browser",
      },
    });
  });

  it("passes api endpoint overrides through the Cursor launcher fallback", () => {
    expect(
      buildCursorAcpSpawnInput(
        {
          binaryPath: "/not-real/bin/cursor",
          apiEndpoint: "http://localhost:3000",
        },
        "/tmp/project",
        noCursorAgentCommandOptions,
      ),
    ).toMatchObject({
      command: "/not-real/bin/cursor",
      args: ["agent", "-e", "http://localhost:3000", "acp"],
      cwd: "/tmp/project",
      env: {
        NO_BROWSER: "true",
        BROWSER: "www-browser",
      },
    });
  });
});

describe("buildCursorCliModelListCommand", () => {
  it("builds the default Cursor model list command", () => {
    expect(buildCursorCliModelListCommand(undefined)).toEqual({
      command: "cursor-agent",
      args: ["models"],
    });
  });

  it("uses the Cursor launcher fallback for model discovery", () => {
    expect(
      buildCursorCliModelListCommand(
        {
          binaryPath: "/not-real/bin/cursor",
          apiEndpoint: "http://localhost:3000",
        },
        noCursorAgentCommandOptions,
      ),
    ).toEqual({
      command: "/not-real/bin/cursor",
      args: ["agent", "-e", "http://localhost:3000", "models"],
    });
  });
});

describe("flattenCursorAcpModelChoices", () => {
  it("reads Cursor ACP model picker options including grouped choices", () => {
    expect(
      flattenCursorAcpModelChoices([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "auto",
          options: [
            { value: "auto", name: "Auto" },
            {
              group: "anthropic",
              name: "Anthropic",
              options: [
                { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
                { value: "claude-opus-4-6", name: "Claude Opus 4.6" },
              ],
            },
            { value: "claude-opus-4-6", name: "Duplicate" },
          ] as never,
        },
      ]),
    ).toEqual([
      { slug: "auto", name: "Auto", upstreamProviderId: "cursor", upstreamProviderName: "Cursor" },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
      },
      {
        slug: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
      },
    ]);
  });
});

describe("parseCursorCliModelList", () => {
  it("parses Cursor CLI model output with provider grouping metadata", () => {
    expect(
      parseCursorCliModelList(`Available models

auto - Auto
composer-2-fast - Composer 2 Fast (default)
gpt-5.3-codex-high-fast - Codex 5.3 High Fast
claude-4.6-opus-max-thinking-fast - Opus 4.6 1M Max Thinking Fast
claude-fable-5-max - Fable 5 1M Max
claude-opus-4-8-xhigh-fast - Opus 4.8 1M Extra High Fast

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
`),
    ).toEqual([
      {
        slug: "auto",
        name: "Auto",
        upstreamProviderId: "cursor",
        upstreamProviderName: "Cursor",
      },
      {
        slug: "composer-2-fast",
        name: "Composer 2 Fast",
        upstreamProviderId: "cursor",
        upstreamProviderName: "Cursor",
        supportsFastMode: true,
      },
      {
        slug: "gpt-5.3-codex-high-fast",
        name: "Codex 5.3 High Fast",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
        supportedReasoningEfforts: [{ value: "high", label: "High" }],
        defaultReasoningEffort: "high",
        supportsFastMode: true,
      },
      {
        slug: "claude-4.6-opus-max-thinking-fast",
        name: "Opus 4.6 1M Max Thinking Fast",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
        supportsFastMode: true,
        supportsThinkingToggle: true,
        supportedReasoningEfforts: [{ value: "max", label: "Max" }],
        defaultReasoningEffort: "max",
        contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
        defaultContextWindow: "1m",
      },
      {
        slug: "claude-fable-5-max",
        name: "Fable 5 1M Max",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
        supportedReasoningEfforts: [{ value: "max", label: "Max" }],
        defaultReasoningEffort: "max",
        contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
        defaultContextWindow: "1m",
      },
      {
        slug: "claude-opus-4-8-xhigh-fast",
        name: "Opus 4.8 1M Extra High Fast",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
        supportsFastMode: true,
        supportedReasoningEfforts: [{ value: "xhigh", label: "Extra High" }],
        defaultReasoningEffort: "xhigh",
        contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
        defaultContextWindow: "1m",
      },
    ]);
  });

  it("does not infer 1M context for Opus 4.7 Cursor aliases", () => {
    expect(
      parseCursorCliModelList(`
claude-opus-4-7 - Claude Opus 4.7
`),
    ).toEqual([
      {
        slug: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
      },
    ]);
  });
});

describe("buildCursorAcpModelDescriptors", () => {
  it("returns Cursor runtime models without exposing separate trait pickers", () => {
    expect(buildCursorAcpModelDescriptors(parameterizedGpt54ConfigOptions)).toEqual([
      {
        slug: "gpt-5.4-medium-fast",
        name: "GPT-5.4",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
      },
    ]);
  });

  it("expands Cursor parameterized model choices into reasoning, context, and fast variants", () => {
    const models = buildCursorAcpModelDescriptors(parameterizedCursorVariantConfigOptions);
    expect(models).toHaveLength(24);
    expect(models).toContainEqual(
      expect.objectContaining({
        slug: "gpt-5.3-codex[reasoning=medium,fast=false]",
        name: "GPT-5.3 Codex",
      }),
    );
    expect(models).toContainEqual(
      expect.objectContaining({
        slug: "gpt-5.3-codex[reasoning=high,fast=true]",
        name: "GPT-5.3 Codex High Fast",
      }),
    );
    expect(models).toContainEqual(
      expect.objectContaining({
        slug: "gpt-5.3-codex[reasoning=extra-high,fast=true]",
        name: "GPT-5.3 Codex Extra High Fast",
      }),
    );
    expect(models).toContainEqual(
      expect.objectContaining({
        slug: "claude-opus-4-6[thinking=true,context=1m,effort=high,fast=false]",
        name: "Claude Opus 4.6 1M",
      }),
    );
    expect(models).toContainEqual(
      expect.objectContaining({
        slug: "claude-opus-4-6[thinking=true,context=200k,effort=extra-high,fast=true]",
        name: "Claude Opus 4.6 Extra High Fast",
      }),
    );
    expect(models).toContainEqual(
      expect.objectContaining({
        slug: "claude-opus-4-6[thinking=true,context=1m,effort=extra-high,fast=true]",
        name: "Claude Opus 4.6 Extra High 1M Fast",
      }),
    );
    expect(models.every((model) => model.supportsFastMode !== true)).toBe(true);
    expect(models.every((model) => model.supportedReasoningEfforts === undefined)).toBe(true);
    expect(models.every((model) => model.contextWindowOptions === undefined)).toBe(true);
  });
});

describe("applyCursorAcpModelSelection", () => {
  it("selects Cursor auto explicitly when the ACP model picker exposes it", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "composer-2[fast=true]",
          options: [
            { value: "auto", name: "Auto" },
            { value: "composer-2[fast=true]", name: "Composer 2" },
          ],
        },
      ] satisfies ReadonlyArray<Acp.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "auto",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([{ type: "model", value: "auto" }]);
  });

  it("maps Cursor auto to legacy ACP default model values named Auto", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "composer-2[fast=true]",
          options: [
            { value: "default[]", name: "Auto" },
            { value: "composer-2[fast=true]", name: "Composer 2" },
          ],
        },
      ] satisfies ReadonlyArray<Acp.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "auto",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([{ type: "model", value: "default[]" }]);
  });

  it("maps legacy Cursor base slugs with fast mode defaulted off", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default[]",
          options: [
            { value: "default[]", name: "Auto" },
            { value: "composer-2[fast=true]", name: "Composer 2" },
          ],
        },
      ] satisfies ReadonlyArray<Acp.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "composer-2",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([{ type: "model", value: "composer-2[fast=false]" }]);
  });

  it("maps unsupported false boolean parameters to an available Cursor ACP model value", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "grok-4-20[thinking=true]",
          options: [
            { value: "default[]", name: "Auto" },
            { value: "grok-4-20[thinking=true]", name: "Grok 4.20" },
          ],
        },
      ] satisfies ReadonlyArray<Acp.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "grok-4-20[thinking=false]",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([{ type: "model", value: "grok-4-20[thinking=true]" }]);
  });

  it("sets the base model before applying separate config options", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed(parameterizedGpt54ConfigOptions),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "gpt-5.4-medium-fast[reasoning=medium,context=272k]",
        options: {
          reasoningEffort: "xhigh",
          contextWindow: "1m",
          fastMode: true,
        },
        mapError: ({ step, configId, cause }) =>
          new Error(
            step === "set-config-option"
              ? `failed to set config option ${configId}: ${cause.message}`
              : `failed to set model: ${cause.message}`,
          ),
      }),
    );

    expect(calls).toEqual([
      { type: "model", value: "gpt-5.4-medium-fast" },
      { type: "config", configId: "reasoning", value: "extra-high" },
      { type: "config", configId: "context", value: "1m" },
      { type: "config", configId: "fast", value: "true" },
    ]);
  });

  it("maps synthetic Cursor model variants back to ACP model plus config options", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed(parameterizedCursorVariantConfigOptions),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "claude-opus-4-6[thinking=true,context=1m,effort=extra-high,fast=true]",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      {
        type: "model",
        value: "claude-opus-4-6[thinking=true,context=1m,effort=extra-high,fast=true]",
      },
      { type: "config", configId: "reasoning", value: "extra-high" },
      { type: "config", configId: "context", value: "1m" },
      { type: "config", configId: "fast", value: "true" },
    ]);
  });

  it("maps Cursor CLI model ids to parameterized ACP values without silently dropping variants", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "composer-2[fast=true]",
          options: [
            { value: "composer-2[fast=true]", name: "composer-2" },
            {
              value: "claude-opus-4-6[thinking=true,context=200k,effort=high,fast=false]",
              name: "claude-opus-4-6",
            },
            { value: "gpt-5.3-codex-spark[reasoning=medium]", name: "gpt-5.3-codex-spark" },
          ],
        },
        {
          id: "reasoning",
          name: "Reasoning",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
            { value: "extra-high", name: "Extra High" },
          ],
        },
        {
          id: "context",
          name: "Context",
          category: "model_config",
          type: "select",
          currentValue: "200k",
          options: [
            { value: "200k", name: "200K" },
            { value: "1m", name: "1M" },
          ],
        },
        {
          id: "fast",
          name: "Fast",
          category: "model_config",
          type: "select",
          currentValue: "false",
          options: [
            { value: "false", name: "Off" },
            { value: "true", name: "Fast" },
          ],
        },
        {
          id: "thinking",
          name: "Thinking",
          category: "model_config",
          type: "boolean",
          currentValue: false,
        },
      ] satisfies ReadonlyArray<Acp.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "claude-4.6-opus-max-thinking-fast",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );
    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "gpt-5.3-codex-spark-preview-low",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      {
        type: "model",
        value: "claude-opus-4-6[thinking=true,context=1m,effort=max,fast=true]",
      },
      { type: "config", configId: "context", value: "1m" },
      { type: "config", configId: "fast", value: "true" },
      { type: "config", configId: "thinking", value: true },
      { type: "model", value: "gpt-5.3-codex-spark[reasoning=low]" },
      { type: "config", configId: "reasoning", value: "low" },
      { type: "config", configId: "fast", value: "false" },
    ]);
  });

  it("maps Cursor's namespaced Grok CLI id to the unprefixed ACP model value", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default[]",
          options: [
            { value: "default[]", name: "Auto" },
            {
              value: "grok-4.5[effort=high,fast=true]",
              name: "Cursor Grok 4.5",
            },
          ],
        },
      ] satisfies ReadonlyArray<Acp.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "cursor-grok-4.5",
        options: { reasoningEffort: "high", fastMode: false },
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      {
        type: "model",
        value: "grok-4.5[effort=high,fast=false]",
      },
    ]);
  });

  it("keeps Cursor Grok fast mode off even when ACP advertises fast=true", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default[]",
          options: [
            { value: "default[]", name: "Auto" },
            {
              value: "grok-4.6[effort=high,fast=true]",
              name: "Cursor Grok 4.6",
            },
          ],
        },
      ] satisfies ReadonlyArray<Acp.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "grok-4.6",
        options: { reasoningEffort: "high", fastMode: false },
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      {
        type: "model",
        value: "grok-4.6[effort=high,fast=false]",
      },
    ]);
  });

  it("lets an explicit fastMode=false override a persisted parameterized fast model", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "grok-4.6[effort=high,fast=true]",
          options: [
            {
              value: "grok-4.6[effort=high,fast=true]",
              name: "Grok 4.6",
            },
          ],
        },
      ] satisfies ReadonlyArray<Acp.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "grok-4.6[effort=high,fast=true]",
        options: { fastMode: false },
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      {
        type: "model",
        value: "grok-4.6[effort=high,fast=false]",
      },
    ]);
  });

  it("defaults Cursor fast mode off through the dedicated ACP config option", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "grok-4.6[effort=high,fast=true]",
          options: [
            {
              value: "grok-4.6[effort=high,fast=true]",
              name: "Grok 4.6",
            },
          ],
        },
        {
          id: "fast",
          name: "Fast",
          category: "model_config",
          type: "select",
          currentValue: "true",
          options: [
            { value: "false", name: "Off" },
            { value: "true", name: "Fast" },
          ],
        },
      ] satisfies ReadonlyArray<Acp.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "grok-4.6",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      {
        type: "model",
        value: "grok-4.6[effort=high,fast=false]",
      },
      { type: "config", configId: "fast", value: "false" },
    ]);
  });

  it("keeps OpenAI CLI 1M context in the ACP model value so unsupported variants fail instead of falling back", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-5.5[context=272k,reasoning=medium,fast=false]",
          options: [
            {
              value: "gpt-5.5[context=272k,reasoning=medium,fast=false]",
              name: "gpt-5.5",
            },
          ],
        },
      ] satisfies ReadonlyArray<Acp.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "gpt-5.5-medium",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      { type: "model", value: "gpt-5.5[context=1m,reasoning=medium,fast=false]" },
    ]);
  });

  it("uses the accepted ACP model value when Cursor exposes fast as a separate option", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-5.1-codex-max[reasoning=medium,fast=false]",
          options: [
            {
              value: "gpt-5.1-codex-max[reasoning=medium,fast=false]",
              name: "Codex 5.1 Max",
            },
          ],
        },
        {
          id: "fast",
          name: "Fast",
          category: "model_config",
          type: "select",
          currentValue: "false",
          options: [
            { value: "false", name: "Off" },
            { value: "true", name: "Fast" },
          ],
        },
      ] satisfies ReadonlyArray<Acp.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "gpt-5.1-codex-max-medium-fast",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      { type: "model", value: "gpt-5.1-codex-max[reasoning=medium,fast=false]" },
      { type: "config", configId: "fast", value: "true" },
    ]);
  });

  it("maps collapsed Cursor model selections plus trait options to the ACP model value", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed(parameterizedCursorVariantConfigOptions),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "claude-opus-4-6",
        options: {
          reasoningEffort: "xhigh",
          contextWindow: "1m",
          thinking: true,
          fastMode: true,
        },
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      {
        type: "model",
        value: "claude-opus-4-6[thinking=true,context=1m,effort=extra-high,fast=true]",
      },
      { type: "config", configId: "reasoning", value: "extra-high" },
      { type: "config", configId: "context", value: "1m" },
      { type: "config", configId: "fast", value: "true" },
    ]);
  });

  it("drops stale Cursor context traits that are no longer exposed by ACP", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "claude-opus-4-7[thinking=true,context=300k,effort=high]",
          options: [
            {
              value: "claude-opus-4-7[thinking=true,context=300k,effort=high]",
              name: "Claude Opus 4.7",
            },
            {
              value: "claude-opus-4-7[thinking=true,context=300k,effort=xhigh]",
              name: "Claude Opus 4.7 Extra High",
            },
          ],
        },
      ] satisfies ReadonlyArray<Acp.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "claude-opus-4-7",
        options: {
          reasoningEffort: "xhigh",
          contextWindow: "1m",
          thinking: true,
        },
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      {
        type: "model",
        value: "claude-opus-4-7[thinking=true,context=300k,effort=xhigh]",
      },
    ]);
  });

  it("repairs stale parameterized Cursor model strings against ACP choices", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "claude-opus-4-7[thinking=true,context=300k,effort=high]",
          options: [
            {
              value: "claude-opus-4-7[thinking=true,context=300k,effort=high]",
              name: "Claude Opus 4.7",
            },
            {
              value: "claude-opus-4-7[thinking=true,context=300k,effort=xhigh]",
              name: "Claude Opus 4.7 Extra High",
            },
          ],
        },
      ] satisfies ReadonlyArray<Acp.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "claude-opus-4-7[thinking=true,context=1m,effort=xhigh]",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      {
        type: "model",
        value: "claude-opus-4-7[thinking=true,context=300k,effort=xhigh]",
      },
    ]);
  });
});

describe("buildCursorAcpModelDescriptorsFromAvailableModels", () => {
  const availableModels: ReadonlyArray<CursorAcpAvailableModel> = [
    { value: "default", name: "Auto" },
    {
      value: "composer-2.5",
      name: "Composer 2.5",
      configOptions: [
        {
          id: "fast",
          name: "Fast",
          category: "model_config",
          type: "select",
          currentValue: "true",
          options: [
            { value: "false", name: "Off" },
            { value: "true", name: "Fast" },
          ],
        },
      ],
    },
    {
      value: "claude-fable-5",
      name: "Fable 5",
      configOptions: [
        {
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "true",
          options: [
            { value: "false", name: "Off" },
            { value: "true", name: "On" },
          ],
        },
        {
          id: "context",
          name: "Context",
          category: "model_config",
          type: "select",
          currentValue: "300k",
          options: [
            { value: "300k", name: "300K" },
            { value: "1m", name: "1M" },
          ],
        },
        {
          id: "effort",
          name: "Effort",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
            { value: "xhigh", name: "Extra High" },
            { value: "max", name: "Max" },
          ],
        },
      ],
    },
    {
      value: "gpt-5.5",
      name: "GPT-5.5",
      configOptions: [
        {
          id: "context",
          name: "Context",
          category: "model_config",
          type: "select",
          currentValue: "272k",
          options: [
            { value: "272k", name: "272K" },
            { value: "1m", name: "1M" },
          ],
        },
        {
          id: "reasoning",
          name: "Reasoning",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
            { value: "extra-high", name: "Extra High" },
          ],
        },
        {
          id: "fast",
          name: "Fast",
          category: "model_config",
          type: "select",
          currentValue: "false",
          options: [
            { value: "false", name: "Off" },
            { value: "true", name: "Fast" },
          ],
        },
      ],
    },
  ];

  it("projects per-model context, effort, thinking, and fast options into descriptors", () => {
    const descriptors = buildCursorAcpModelDescriptorsFromAvailableModels(availableModels);
    const bySlug = new Map(descriptors.map((descriptor) => [descriptor.slug, descriptor]));

    const fable = bySlug.get("claude-fable-5");
    expect(fable).toMatchObject({
      slug: "claude-fable-5",
      name: "Fable 5",
      upstreamProviderId: "anthropic",
      supportsThinkingToggle: true,
      defaultContextWindow: "300k",
      defaultReasoningEffort: "high",
    });
    expect(fable?.supportsFastMode).toBeUndefined();
    expect(fable?.contextWindowOptions).toEqual([
      { value: "300k", label: "300K", isDefault: true },
      { value: "1m", label: "1M" },
    ]);
    expect(fable?.supportedReasoningEfforts?.map((effort) => effort.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    const gpt = bySlug.get("gpt-5.5");
    expect(gpt).toMatchObject({
      supportsFastMode: true,
      defaultContextWindow: "272k",
      defaultReasoningEffort: "medium",
    });
    expect(gpt?.supportsThinkingToggle).toBeUndefined();
    // Cursor's "extra-high" reasoning value normalizes to Synara's "xhigh".
    expect(gpt?.supportedReasoningEfforts?.map((effort) => effort.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("maps the ACP 'default' model id to Synara's 'auto' slug and skips empty option sets", () => {
    const descriptors = buildCursorAcpModelDescriptorsFromAvailableModels(availableModels);
    const auto = descriptors.find((descriptor) => descriptor.slug === "auto");
    expect(auto?.name).toBe("Auto");
    expect(auto?.contextWindowOptions).toBeUndefined();
    expect(auto?.supportedReasoningEfforts).toBeUndefined();

    const composer = descriptors.find((descriptor) => descriptor.slug === "composer-2.5");
    expect(composer?.supportsFastMode).toBe(true);
    expect(composer?.contextWindowOptions).toBeUndefined();
  });
});
