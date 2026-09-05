import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ModelRegistry,
  ModelRuntime,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { outboundHttp } from "@synara/shared/outboundHttp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshPiOpenCodeCatalog, parsePiOpenCodeCatalog } from "./piOpenCodeCatalog";
import {
  getPiDiscoverableModels,
  toPiProviderModelDescriptor,
  findModelInRegistry,
} from "./Layers/PiAdapter";

const fixtures = [
  "anthropic-messages",
  "google-generative-ai",
  "openai-responses",
  "openai-completions",
].map((api, index) => ({
  id: `new-${index}`,
  name: `New ${index}`,
  provider: "opencode",
  api,
  baseUrl: api === "anthropic-messages" ? "https://opencode.ai/zen" : "https://opencode.ai/zen/v1",
  reasoning: index !== 3,
  input: ["text", "image"],
  contextWindow: 200000,
  maxTokens: 16000,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
}));
const catalog = Object.fromEntries(fixtures.map((model) => [model.id, model]));
const inventory = { data: fixtures.map(({ id }) => ({ id })) };
const dirs: string[] = [];
function directory() {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-zen-test-"));
  dirs.push(dir);
  return dir;
}
async function runtime(dir = directory()) {
  if (!existsSync(path.join(dir, "auth.json")))
    writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ opencode: { type: "api_key", key: "synthetic-key" } }),
    );
  return ModelRuntime.create({
    authPath: path.join(dir, "auth.json"),
    modelsPath: path.join(dir, "models.json"),
  });
}
function publicFetch() {
  return vi.fn<typeof outboundHttp.request>(async (input) => {
    expect(new Headers(input.headers).has("Authorization")).toBe(false);
    expect(input.policy.maxResponseBytes).toBe(4 * 1024 * 1024);
    expect(input.policy.maxRedirects).toBe(0);
    return {
      status: 200,
      url: String(input.url),
      headers: new Headers(),
      body: Buffer.from(JSON.stringify(String(input.url).includes("pi.dev") ? catalog : inventory)),
    };
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Pi OpenCode catalog", () => {
  it("replaces retired models and preserves protocol and capabilities through discovery and selection", async () => {
    const dir = directory();
    writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ opencode: { type: "api_key", key: "synthetic-zen-key" } }),
    );
    const modelRuntime = await runtime(dir);
    const fetch = publicFetch();
    await refreshPiOpenCodeCatalog(modelRuntime, { request: fetch });
    const registry = new ModelRegistry(modelRuntime);
    const discovered = getPiDiscoverableModels(registry).filter(
      (model) => model.provider === "opencode",
    );
    expect(discovered).toEqual(fixtures);
    for (const model of discovered) {
      const descriptor = toPiProviderModelDescriptor(
        model,
        registry.getProviderDisplayName.bind(registry),
      );
      const selected = findModelInRegistry(registry, descriptor!.slug);
      expect(selected).toEqual(model);
    }
    expect(await modelRuntime.getAuth("opencode")).toMatchObject({
      auth: { apiKey: "synthetic-zen-key" },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("dispatches discovered models through all four native APIs with the selected account", async () => {
    const dir = directory();
    writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ opencode: { type: "api_key", key: "synthetic-dispatch-key" } }),
    );
    const modelRuntime = await runtime(dir);
    await refreshPiOpenCodeCatalog(modelRuntime, { request: publicFetch() });
    const requests: Array<{ url: string; headers: Headers; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        return Response.json(
          { error: { message: "synthetic stop", type: "invalid_request_error" } },
          { status: 400 },
        );
      }),
    );
    for (const model of modelRuntime.getModels("opencode")) {
      await modelRuntime
        .streamSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] })
        .result();
    }
    expect(requests).toHaveLength(4);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/zen/v1/messages",
      "/zen/v1/models/new-1:streamGenerateContent",
      "/zen/v1/responses",
      "/zen/v1/chat/completions",
    ]);
    for (const request of requests) {
      expect(
        [...request.headers.values()].some((value) => value.includes("synthetic-dispatch-key")),
      ).toBe(true);
    }
  });

  it("preserves configured endpoints and account identity without contaminating another runtime", async () => {
    const dir = directory();
    writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        providers: {
          opencode: {
            baseUrl: "https://custom.example/v1",
            api: "openai-completions",
            apiKey: "synthetic-custom-key",
            models: [
              {
                id: "custom-only",
                name: "Custom",
                reasoning: false,
                input: ["text"],
                contextWindow: 8000,
                maxTokens: 1000,
              },
            ],
          },
        },
      }),
    );
    const first = await runtime(dir);
    const second = await runtime();
    const baseline = second.getModels("opencode");
    await refreshPiOpenCodeCatalog(first, { request: publicFetch() });
    expect(first.getModel("opencode", "custom-only")).toMatchObject({
      baseUrl: "https://custom.example/v1",
      api: "openai-completions",
    });
    expect(await first.getAuth("opencode")).toMatchObject({
      auth: { apiKey: "synthetic-key" },
    });
    expect(second.getModels("opencode")).toEqual(baseline);
    expect(second.getModel("opencode", "new-0")).toBeUndefined();
  });

  it("settles async extension registrations on first service creation and lets them override Zen", async () => {
    const dir = directory();
    const extension = path.join(dir, "extensions");
    mkdirSync(extension);
    writeFileSync(
      path.join(extension, "zen.ts"),
      `export default async function(pi) {
      await Promise.resolve();
      pi.registerProvider("opencode", { api: "openai-completions", baseUrl: "https://extension.example/v1", apiKey: "extension-test-key", models: [{ id: "extension-model", name: "Extension", reasoning: false, input: ["text"], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:8192, maxTokens:1024 }] });
    }`,
    );
    const modelRuntime = await runtime(dir);
    await refreshPiOpenCodeCatalog(modelRuntime, { request: publicFetch() });
    const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, modelRuntime });
    expect(services.resourceLoader.getExtensions().runtime.pendingProviderRegistrations).toEqual(
      [],
    );
    const models = getPiDiscoverableModels(new ModelRegistry(services.modelRuntime));
    expect(models.filter((model) => model.provider === "opencode")).toEqual([
      expect.objectContaining({ id: "extension-model", baseUrl: "https://extension.example/v1" }),
    ]);
    expect(await modelRuntime.getAuth("opencode")).toMatchObject({
      auth: { apiKey: "synthetic-key" },
    });
  });

  it("rejects missing Zen metadata but retains custom endpoint fallbacks", async () => {
    const modelRuntime = await runtime();
    await refreshPiOpenCodeCatalog(modelRuntime, { request: publicFetch() });
    const registry = new ModelRegistry(modelRuntime);
    expect(findModelInRegistry(registry, "opencode/retired-or-unknown")).toBeUndefined();
    registry.registerProvider("opencode", {
      api: "openai-completions",
      baseUrl: "https://custom.example/v1",
      apiKey: "synthetic",
      models: [
        {
          id: "custom",
          name: "Custom",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 1024,
        },
      ],
    });
    expect(findModelInRegistry(registry, "opencode/custom-unlisted")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://custom.example/v1",
    });
  });

  it("does not read public catalogs without configured Zen auth", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "");
    const dir = directory();
    writeFileSync(path.join(dir, "auth.json"), "{}");
    const modelRuntime = await runtime(dir);
    const request = publicFetch();
    await refreshPiOpenCodeCatalog(modelRuntime, { request });
    expect(request).not.toHaveBeenCalled();
  });

  it("drops credential-like headers from public model metadata", () => {
    const models = parsePiOpenCodeCatalog(
      { x: { ...fixtures[0], headers: { Authorization: "untrusted" } } },
      inventory,
    );
    expect(models[0]).not.toHaveProperty("headers");
  });

  it("preserves discovered protocol metadata across fresh runtimes when catalog networking is unavailable", async () => {
    const dir = directory();
    const first = await runtime(dir);
    await refreshPiOpenCodeCatalog(first, { request: publicFetch() });
    const restarted = await runtime(dir);
    const request = vi.fn<typeof outboundHttp.request>().mockRejectedValue(new Error("offline"));
    await refreshPiOpenCodeCatalog(restarted, { request });
    for (const model of fixtures) expect(restarted.getModel("opencode", model.id)).toEqual(model);
  });

  it("does not confuse opencode-go with Zen", async () => {
    const modelRuntime = await runtime();
    const before = modelRuntime.getModels("opencode-go");
    await refreshPiOpenCodeCatalog(modelRuntime, { request: publicFetch() });
    expect(modelRuntime.getModels("opencode-go")).toEqual(before);
  });

  it("retains the SDK baseline on HTTP failure or malformed/empty inventory", async () => {
    const modelRuntime = await runtime();
    const before = modelRuntime.getModels("opencode");
    for (const response of [
      new Response(null, { status: 503 }),
      Response.json({ data: [] }),
      Response.json(null),
    ]) {
      await refreshPiOpenCodeCatalog(modelRuntime, {
        request: vi.fn(async () => ({
          status: response.status,
          url: "https://pi.dev",
          headers: response.headers,
          body: Buffer.from(await response.clone().arrayBuffer()),
        })),
      });
      expect(modelRuntime.getModels("opencode")).toEqual(before);
    }
  });

  it("cancels requests at the deadline and does not install results after cancellation", async () => {
    const modelRuntime = await runtime();
    const before = modelRuntime.getModels("opencode");
    const signals: AbortSignal[] = [];
    const fetch = vi.fn<typeof outboundHttp.request>(
      (input) =>
        new Promise((_resolve, reject) => {
          const signal = input.signal!;
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    await refreshPiOpenCodeCatalog(modelRuntime, { request: fetch, timeoutMs: 10 });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(modelRuntime.getModels("opencode")).toEqual(before);
    const controller = new AbortController();
    controller.abort();
    fetch.mockClear();
    await refreshPiOpenCodeCatalog(modelRuntime, { request: fetch, signal: controller.signal });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors PI_OFFLINE without starting requests", async () => {
    const modelRuntime = await runtime();
    vi.stubEnv("PI_OFFLINE", "1");
    const fetch = publicFetch();
    await refreshPiOpenCodeCatalog(modelRuntime, { request: fetch });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("omits unknown protocols and missing metadata rather than manufacturing defaults", () => {
    expect(
      parsePiOpenCodeCatalog(
        { ...catalog, unknown: { ...fixtures[0], id: "unknown", api: "unsupported" } },
        { data: [...inventory.data, { id: "unknown" }, { id: "no-metadata" }] },
      ),
    ).toEqual(fixtures);
  });
});
