import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { ThreadId } from "@synara/contracts";
import { outboundHttp } from "@synara/shared/outboundHttp";
import { afterEach, expect, it, vi } from "vitest";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { ServerConfig } from "../../config.ts";
import { PiAdapter } from "../Services/PiAdapter.ts";
import { makePiAdapterLive, refreshPiOpenRouterModels } from "./PiAdapter.ts";

const captured = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...sdk,
    SessionManager: {
      ...sdk.SessionManager,
      create: (cwd: string) => sdk.SessionManager.create(cwd, path.join(cwd, "sessions")),
    },
    createAgentSessionFromServices: async (
      input: Parameters<typeof sdk.createAgentSessionFromServices>[0],
    ) => {
      captured.model = input.model;
      throw new Error("test stops at session construction before any inference");
    },
  };
});
const dirs: string[] = [];
function directory() {
  const dir = mkdtempSync(path.join(tmpdir(), "synara-openrouter-"));
  dirs.push(dir);
  return dir;
}
function catalog() {
  return vi.spyOn(outboundHttp, "request").mockResolvedValue({
    status: 200,
    url: "https://openrouter.ai/api/v1/models",
    headers: new Headers(),
    body: Buffer.from(
      JSON.stringify({
        data: [
          {
            id: "vendor/new-model",
            name: "Live model",
            context_length: 262144,
            architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
            supported_parameters: ["tools", "reasoning"],
            top_provider: { max_completion_tokens: 32768 },
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
        ],
      }),
    ),
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("passes a listed live model with its real capacities to a fresh session, including offline fallback", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-only");
  vi.stubEnv("PI_OFFLINE", undefined);
  const dir = directory();
  const request = catalog();
  const layer = makePiAdapterLive().pipe(
    Layer.provideMerge(ServerConfig.layerTest(dir, path.join(dir, "server"))),
    Layer.provideMerge(NodeServices.layer),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;
      const result = yield* adapter.listModels!({ provider: "pi", cwd: dir, agentDir: dir });
      const model = result.models.find((model) => model.slug === "openrouter/vendor/new-model");
      expect(model?.supportedReasoningEfforts?.length).toBeGreaterThan(0);
      // Session starts with a new SDK runtime; failed network must retain catalog metadata.
      request.mockRejectedValue(new Error("offline"));
      request.mockClear();
      yield* Effect.exit(
        adapter.startSession({
          threadId: ThreadId.makeUnsafe("openrouter-test"),
          cwd: dir,
          runtimeMode: "full-access",
          providerOptions: { pi: { agentDir: dir } },
          modelSelection: { provider: "pi", model: model!.slug },
        }),
      );
      expect(captured.model).toMatchObject({
        id: "vendor/new-model",
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 262144,
        maxTokens: 32768,
        cost: { input: 1, output: 2 },
      });
      expect(request).not.toHaveBeenCalled();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

it("does not fetch for absent auth, custom endpoints, or extension-owned catalogs", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("PI_OFFLINE", undefined);
  const request = catalog();
  const dir = directory();
  const runtime = await ModelRuntime.create({
    authPath: path.join(dir, "auth.json"),
    modelsPath: path.join(dir, "models.json"),
  });
  await refreshPiOpenRouterModels(runtime);
  expect(request).not.toHaveBeenCalled();
  await runtime.setRuntimeApiKey("openrouter", "test-only", { allowNetwork: false });
  runtime.registerProvider("openrouter", { baseUrl: "https://custom.example/v1", models: [] });
  await runtime.refresh({ allowNetwork: false });
  await refreshPiOpenRouterModels(runtime);
  expect(request).not.toHaveBeenCalled();
  expect(
    new ModelRegistry(runtime).getAll().filter((model) => model.provider === "openrouter"),
  ).toEqual([]);
});

it("preserves models.json overrides over live metadata", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-only");
  vi.stubEnv("PI_OFFLINE", undefined);
  catalog();
  const dir = directory();
  writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        openrouter: {
          modelOverrides: { "vendor/new-model": { contextWindow: 8192, maxTokens: 1024 } },
        },
      },
    }),
  );
  const runtime = await ModelRuntime.create({
    authPath: path.join(dir, "auth.json"),
    modelsPath: path.join(dir, "models.json"),
  });
  await refreshPiOpenRouterModels(runtime);
  expect(runtime.getModel("openrouter", "vendor/new-model")).toMatchObject({
    contextWindow: 8192,
    maxTokens: 1024,
  });
});
