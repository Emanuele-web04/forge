import { type ModelSlug, type ProviderKind, type ServerProviderStatus } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";

import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ProviderModelOption } from "../../providerModelOptions";
import type { ProviderModelDiscoveryState } from "../../hooks/useProviderModelCatalog";
import { FAVORITE_MODEL_STORAGE_KEYS } from "../../lib/modelFavorites";
import { providerDiscoveryQueryKeys } from "../../lib/providerDiscoveryReactQuery";

const MODEL_OPTIONS_BY_PROVIDER = {
  claudeAgent: [
    { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
  codex: [
    { slug: "gpt-5-codex", name: "GPT-5 Codex" },
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  ],
  cursor: [
    { slug: "auto", name: "Auto" },
    { slug: "composer-2", name: "Composer 2" },
  ],
  grok: [
    { slug: "grok-build-0.1", name: "Grok Build 0.1" },
    { slug: "grok-build", name: "Grok 4.3" },
  ],
  droid: [
    {
      slug: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      description: "0.4x Factory token rate",
    },
    { slug: "custom:GPT-5.6-Luna-0", name: "Custom GPT-5.6 Luna", isCustom: true },
  ],
  opencode: [
    {
      slug: "opencode/nemotron-3-super-free",
      name: "Nemotron 3 Super Free",
      upstreamProviderId: "opencode",
      upstreamProviderName: "OpenCode",
    },
    {
      slug: "openai/gpt-5",
      name: "GPT-5",
      upstreamProviderId: "openai",
      upstreamProviderName: "OpenAI",
    },
  ],
  devin: [
    {
      slug: "devin/swe-1.7",
      name: "SWE 1.7",
      upstreamProviderId: "devin",
      upstreamProviderName: "Devin",
    },
  ],
  pi: [
    {
      slug: "anthropic/claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    },
  ],
  antigravity: [
    {
      slug: "Gemini 3.5 Flash",
      name: "Gemini 3.5 Flash",
    },
  ],
} as const satisfies Record<
  ProviderKind,
  ReadonlyArray<ProviderModelOption & { slug: ModelSlug; isCustom?: boolean }>
>;

const MANY_OPENCODE_MODELS = Array.from({ length: 16 }, (_, index) => ({
  slug: `${index % 2 === 0 ? "openai" : "anthropic"}/model-${index + 1}` as ModelSlug,
  name: `${index % 2 === 0 ? "GPT" : "Claude"} ${index + 1}`,
  upstreamProviderId: index % 2 === 0 ? "openai" : "anthropic",
  upstreamProviderName: index % 2 === 0 ? "OpenAI" : "Anthropic",
})) satisfies ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>;

const OPENCODE_FAVORITE_SORT_MODELS = [
  {
    slug: "anthropic/claude-favorite-sort" as ModelSlug,
    name: "Claude Favorite Sort",
    upstreamProviderId: "anthropic",
    upstreamProviderName: "Anthropic",
  },
  {
    slug: "openai/gpt-favorite-sort" as ModelSlug,
    name: "GPT Favorite Sort",
    upstreamProviderId: "openai",
    upstreamProviderName: "OpenAI",
  },
] satisfies ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>;

const OPENCODE_DUPLICATE_NAME_MODELS = [
  {
    slug: "deepseek/deepseek-v4-flash" as ModelSlug,
    name: "DeepSeek V4 Flash",
    upstreamProviderId: "deepseek",
    upstreamProviderName: "DeepSeek",
  },
  {
    slug: "opencode-go/deepseek-v4-flash" as ModelSlug,
    name: "DeepSeek V4 Flash",
    upstreamProviderId: "opencode-go",
    upstreamProviderName: "OpenCode Go",
  },
] satisfies ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>;

const MANY_CURSOR_MODELS = Array.from({ length: 16 }, (_, index) => ({
  slug: `cursor-model-${index + 1}` as ModelSlug,
  name: `${index % 2 === 0 ? "GPT" : "Claude"} Cursor ${index + 1}`,
  upstreamProviderId: index % 2 === 0 ? "openai" : "anthropic",
  upstreamProviderName: index % 2 === 0 ? "OpenAI" : "Anthropic",
})) satisfies ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>;

const CURSOR_FAVORITE_SORT_MODELS = [
  {
    slug: "cursor-claude-favorite-sort" as ModelSlug,
    name: "Claude Cursor Favorite Sort",
    upstreamProviderId: "anthropic",
    upstreamProviderName: "Anthropic",
  },
  {
    slug: "cursor-gpt-favorite-sort" as ModelSlug,
    name: "GPT Cursor Favorite Sort",
    upstreamProviderId: "openai",
    upstreamProviderName: "OpenAI",
  },
] satisfies ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>;

const PI_FAVORITE_SORT_MODELS = [
  {
    slug: "anthropic/claude-pi-favorite-sort" as ModelSlug,
    name: "Claude Pi Favorite Sort",
    upstreamProviderId: "anthropic",
    upstreamProviderName: "Anthropic",
  },
  {
    slug: "openai/gpt-pi-favorite-sort" as ModelSlug,
    name: "GPT Pi Favorite Sort",
    upstreamProviderId: "openai",
    upstreamProviderName: "OpenAI",
  },
] satisfies ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>;

const DEFAULT_MODEL_DISCOVERY: ProviderModelDiscoveryState = {
  status: "never-loaded",
  hasDynamicList: false,
  refreshing: false,
};

const DEFAULT_MODEL_DISCOVERY_BY_PROVIDER: Record<ProviderKind, ProviderModelDiscoveryState> = {
  antigravity: DEFAULT_MODEL_DISCOVERY,
  claudeAgent: { status: "success", hasDynamicList: false, refreshing: false },
  codex: { status: "success", hasDynamicList: false, refreshing: false },
  cursor: DEFAULT_MODEL_DISCOVERY,
  devin: DEFAULT_MODEL_DISCOVERY,
  droid: DEFAULT_MODEL_DISCOVERY,
  grok: DEFAULT_MODEL_DISCOVERY,
  opencode: DEFAULT_MODEL_DISCOVERY,
  pi: DEFAULT_MODEL_DISCOVERY,
};

async function mountPicker(props: {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  modelDiscoveryByProvider?: Partial<Record<ProviderKind, ProviderModelDiscoveryState>>;
  onSelectionCommitted?: () => void;
  modelOptionsByProvider?: Record<
    ProviderKind,
    ReadonlyArray<ProviderModelOption & { slug: ModelSlug; isCustom?: boolean }>
  >;
  queryClient?: QueryClient;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onProviderModelChange = vi.fn();
  const queryClient = props.queryClient ?? new QueryClient();
  const modelDiscoveryByProvider: Record<ProviderKind, ProviderModelDiscoveryState> = {
    ...DEFAULT_MODEL_DISCOVERY_BY_PROVIDER,
    ...props.modelDiscoveryByProvider,
  };
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <ProviderModelPicker
        provider={props.provider}
        model={props.model}
        lockedProvider={props.lockedProvider}
        modelOptionsByProvider={props.modelOptionsByProvider ?? MODEL_OPTIONS_BY_PROVIDER}
        modelDiscoveryByProvider={modelDiscoveryByProvider}
        {...(props.providers ? { providers: props.providers } : {})}
        {...(props.onSelectionCommitted
          ? { onSelectionCommitted: props.onSelectionCommitted }
          : {})}
        onProviderModelChange={onProviderModelChange}
      />
    </QueryClientProvider>,
    { container: host },
  );

  return {
    onProviderModelChange,
    queryClient,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ProviderModelPicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("shows provider submenus when provider switching is allowed", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers: [
        {
          provider: "codex",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-10T10:00:00.000Z",
        },
        {
          provider: "claudeAgent",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-10T10:00:00.000Z",
        },
      ],
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Codex");
        expect(text).toContain("Claude");
        expect(text).not.toContain("Claude Sonnet 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows models directly when the provider is locked mid-thread", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Sonnet 4.6");
        expect(text).toContain("Claude Haiku 4.5");
        expect(text).not.toContain("Codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("dispatches the canonical slug when a model is selected", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "Claude Sonnet 4.6" }).click();

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "claudeAgent",
        "claude-sonnet-4-6",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows live Droid cost multipliers without adding one to BYOK models", async () => {
    const mounted = await mountPicker({
      provider: "droid",
      model: "gpt-5.6-luna",
      lockedProvider: "droid",
    });

    try {
      await page.getByRole("button").click();

      const rows = Array.from(document.querySelectorAll('[role="menuitemradio"]'));
      const pricedRow = rows.find((row) => row.textContent?.includes("GPT-5.6 Luna"));
      const byokRow = rows.find((row) => row.textContent?.includes("Custom GPT-5.6 Luna"));

      expect(pricedRow?.textContent).toContain("0.4×");
      expect(pricedRow?.querySelector('[title="0.4x Factory token rate"]')).not.toBeNull();
      expect(byokRow?.textContent).not.toContain("×");
      await expect
        .element(
          page.getByRole("menuitemradio", {
            name: "GPT-5.6 Luna 0.4x Factory token rate",
          }),
        )
        .toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("notifies after a model selection commits so the composer can refocus", async () => {
    const onSelectionCommitted = vi.fn();
    const mounted = await mountPicker({
      provider: "grok",
      model: "grok-build",
      lockedProvider: "grok",
      onSelectionCommitted,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "Grok 4.3" }).click();

      await vi.waitFor(() => {
        expect(onSelectionCommitted).toHaveBeenCalledTimes(1);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("groups upstream OpenCode models by provider label", async () => {
    const mounted = await mountPicker({
      provider: "opencode",
      model: "openai/gpt-5",
      lockedProvider: "opencode",
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("OpenCode");
        expect(text).toContain("Nemotron 3 Super Free");
        expect(text).toContain("OpenAI");
        expect(text).toContain("GPT-5");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows OpenCode search when the provider has at least fifteen models", async () => {
    const mounted = await mountPicker({
      provider: "opencode",
      model: MANY_OPENCODE_MODELS[0]!.slug,
      lockedProvider: "opencode",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        opencode: MANY_OPENCODE_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();

      await expect.element(page.getByPlaceholder("Search models or providers")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters OpenCode models by upstream provider name", async () => {
    const mounted = await mountPicker({
      provider: "opencode",
      model: MANY_OPENCODE_MODELS[0]!.slug,
      lockedProvider: "opencode",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        opencode: MANY_OPENCODE_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();
      await page.getByPlaceholder("Search models or providers").fill("Anthropic");

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Claude 2");
      });

      await expect
        .element(page.getByRole("menuitemradio", { name: "Claude 2" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "GPT 1" }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows favourited OpenCode models in their own top category", async () => {
    const mounted = await mountPicker({
      provider: "opencode",
      model: "anthropic/claude-favorite-sort",
      lockedProvider: "opencode",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        opencode: OPENCODE_FAVORITE_SORT_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.indexOf("Anthropic")).toBeLessThan(text.indexOf("OpenAI"));
      });

      await page.getByRole("button", { name: "Add GPT Favorite Sort to favourites" }).click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.indexOf("Favourites")).toBeLessThan(text.indexOf("Anthropic"));
        expect(text.indexOf("GPT Favorite Sort")).toBeGreaterThan(text.indexOf("Favourites"));
        expect(text.indexOf("GPT Favorite Sort")).toBeLessThan(text.indexOf("Anthropic"));
      });
      await expect
        .element(page.getByRole("menuitemradio", { name: "GPT Favorite Sort — OpenAI" }))
        .toBeInTheDocument();
      expect(
        Array.from(document.querySelectorAll('[role="menuitemradio"]')).filter((element) =>
          element.textContent?.includes("GPT Favorite Sort"),
        ),
      ).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("distinguishes same-name favourite models by their upstream provider", async () => {
    localStorage.setItem(
      FAVORITE_MODEL_STORAGE_KEYS.opencode,
      JSON.stringify(OPENCODE_DUPLICATE_NAME_MODELS.map((model) => model.slug)),
    );
    const mounted = await mountPicker({
      provider: "opencode",
      model: OPENCODE_DUPLICATE_NAME_MODELS[0]!.slug,
      lockedProvider: "opencode",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        opencode: OPENCODE_DUPLICATE_NAME_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();

      await expect
        .element(page.getByRole("menuitemradio", { name: "DeepSeek V4 Flash — DeepSeek" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "DeepSeek V4 Flash — OpenCode Go" }))
        .toBeInTheDocument();
      await expect
        .element(
          page.getByRole("button", {
            name: "Remove DeepSeek V4 Flash — DeepSeek from favourites",
          }),
        )
        .toBeInTheDocument();
      await expect
        .element(
          page.getByRole("button", {
            name: "Remove DeepSeek V4 Flash — OpenCode Go from favourites",
          }),
        )
        .toBeInTheDocument();
      expect(
        Array.from(document.querySelectorAll('[role="menuitemradio"]')).map(
          (element) => element.textContent,
        ),
      ).toEqual(["DeepSeek V4 FlashDeepSeek", "DeepSeek V4 FlashOpenCode Go"]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters Cursor models by upstream provider name", async () => {
    const mounted = await mountPicker({
      provider: "cursor",
      model: MANY_CURSOR_MODELS[0]!.slug,
      lockedProvider: "cursor",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        cursor: MANY_CURSOR_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();
      await page.getByPlaceholder("Search models or providers").fill("Anthropic");

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Claude Cursor 2");
      });

      await expect
        .element(page.getByRole("menuitemradio", { name: "Claude Cursor 2" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "GPT Cursor 1" }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows favourited Cursor models in their own top category", async () => {
    const mounted = await mountPicker({
      provider: "cursor",
      model: "cursor-claude-favorite-sort",
      lockedProvider: "cursor",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        cursor: CURSOR_FAVORITE_SORT_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.indexOf("Anthropic")).toBeLessThan(text.indexOf("OpenAI"));
      });

      await page
        .getByRole("button", { name: "Add GPT Cursor Favorite Sort to favourites" })
        .click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.indexOf("Favourites")).toBeLessThan(text.indexOf("Anthropic"));
        expect(text.indexOf("GPT Cursor Favorite Sort")).toBeGreaterThan(
          text.indexOf("Favourites"),
        );
        expect(text.indexOf("GPT Cursor Favorite Sort")).toBeLessThan(text.indexOf("Anthropic"));
      });
      await expect
        .element(page.getByRole("menuitemradio", { name: "GPT Cursor Favorite Sort — OpenAI" }))
        .toBeInTheDocument();
      expect(
        Array.from(document.querySelectorAll('[role="menuitemradio"]')).filter((element) =>
          element.textContent?.includes("GPT Cursor Favorite Sort"),
        ),
      ).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows favourited Pi models in their own top category", async () => {
    const mounted = await mountPicker({
      provider: "pi",
      model: "anthropic/claude-pi-favorite-sort",
      lockedProvider: "pi",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        pi: PI_FAVORITE_SORT_MODELS,
      },
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.indexOf("Anthropic")).toBeLessThan(text.indexOf("OpenAI"));
      });

      await page.getByRole("button", { name: "Add GPT Pi Favorite Sort to favourites" }).click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text.indexOf("Favourites")).toBeLessThan(text.indexOf("Anthropic"));
        expect(text.indexOf("GPT Pi Favorite Sort")).toBeGreaterThan(text.indexOf("Favourites"));
        expect(text.indexOf("GPT Pi Favorite Sort")).toBeLessThan(text.indexOf("Anthropic"));
      });
      await expect
        .element(page.getByRole("menuitemradio", { name: "GPT Pi Favorite Sort — OpenAI" }))
        .toBeInTheDocument();
      expect(
        Array.from(document.querySelectorAll('[role="menuitemradio"]')).filter((element) =>
          element.textContent?.includes("GPT Pi Favorite Sort"),
        ),
      ).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a loading skeleton instead of fallback models for loading providers", async () => {
    const mounted = await mountPicker({
      provider: "cursor",
      model: "auto",
      lockedProvider: "cursor",
      modelDiscoveryByProvider: {
        cursor: {
          status: "loading",
          hasDynamicList: false,
          refreshing: false,
        } satisfies ProviderModelDiscoveryState,
      },
    });

    try {
      await page.getByRole("button").click();

      await expect.element(page.getByLabelText("Loading models")).toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "Auto" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "Composer 2" }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides unavailable providers and offers provider settings", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: [
        {
          provider: "codex",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-10T10:00:00.000Z",
        },
        {
          provider: "claudeAgent",
          status: "error",
          available: false,
          authStatus: "unauthenticated",
          checkedAt: "2026-04-10T10:00:00.000Z",
        },
      ],
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Codex");
        expect(text).not.toContain("Claude");
        expect(text).not.toContain("Sign in");
      });
      await expect.element(page.getByRole("menuitem", { name: "Add Providers" })).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides providers before live status is known", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: [
        {
          provider: "codex",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-10T10:00:00.000Z",
        },
      ],
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).not.toContain("Claude");
        expect(text).not.toContain("Checking");
      });
      await expect.element(page.getByRole("menuitem", { name: "Add Providers" })).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps warning providers selectable when they are still available", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: [
        {
          provider: "codex",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-10T10:00:00.000Z",
        },
        {
          provider: "claudeAgent",
          status: "warning",
          available: true,
          authStatus: "unknown",
          checkedAt: "2026-04-10T10:00:00.000Z",
          message: "Could not verify auth status.",
        },
      ],
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Claude");
      });

      await expect.element(page.getByText("Sign in")).not.toBeInTheDocument();
      await expect.element(page.getByText("Unavailable")).not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the selected model with a failure row when OpenCode discovery failed without a cache", async () => {
    const mounted = await mountPicker({
      provider: "opencode",
      model: "openai/gpt-5",
      lockedProvider: "opencode",
      modelDiscoveryByProvider: {
        opencode: {
          status: "failed",
          hasDynamicList: false,
          refreshing: false,
        } satisfies ProviderModelDiscoveryState,
      },
    });

    try {
      await page.getByRole("button").click();

      await expect.element(page.getByRole("menuitemradio", { name: "GPT-5" })).toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "Nemotron 3 Super Free" }))
        .not.toBeInTheDocument();
      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Couldn\u2019t load models");
        expect(text).toContain("Retry");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("applies the same restricted failure row to every discovery-owned provider", async () => {
    const mounted = await mountPicker({
      provider: "droid",
      model: "gpt-5.6-luna",
      lockedProvider: "droid",
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        droid: [
          {
            slug: "gpt-5.6-luna",
            name: "GPT-5.6 Luna",
            description: "0.4x Factory token rate",
          },
          { slug: "custom:GPT-5.6-Luna-0", name: "Custom GPT-5.6 Luna", isCustom: true },
          { slug: "gpt-5.6-flash", name: "GPT-5.6 Flash" },
        ],
      },
      modelDiscoveryByProvider: {
        droid: {
          status: "failed",
          hasDynamicList: false,
          refreshing: false,
        } satisfies ProviderModelDiscoveryState,
      },
    });

    try {
      await page.getByRole("button").click();

      // The droid cost description ("0.4x Factory token rate") lands in the
      // row's accessible name via an sr-only span, so an exact name match
      // can never hit. Match by substring plus checked state instead: only
      // the selected row is checked, which also disambiguates it from the
      // "Custom GPT-5.6 Luna" row below.
      await expect
        .element(page.getByRole("menuitemradio", { name: "GPT-5.6 Luna", checked: true }))
        .toBeInTheDocument();
      // The user's own custom model stays selectable offline; the static
      // built-in that discovery owns stays hidden.
      await expect
        .element(page.getByRole("menuitemradio", { name: "Custom GPT-5.6 Luna", exact: true }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "GPT-5.6 Flash", exact: true }))
        .not.toBeInTheDocument();
      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Couldn\u2019t load models");
        expect(text).toContain("Retry");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the cached list and a 'Couldn\u2019t refresh \u2014 Retry' footer when discovery failed with a cache", async () => {
    const mounted = await mountPicker({
      provider: "opencode",
      model: "openai/gpt-5",
      lockedProvider: "opencode",
      modelDiscoveryByProvider: {
        opencode: {
          status: "failed",
          hasDynamicList: true,
          refreshing: false,
          fetchedAt: Date.now(),
        } satisfies ProviderModelDiscoveryState,
      },
    });

    try {
      await page.getByRole("button").click();

      await expect.element(page.getByRole("menuitemradio", { name: "GPT-5" })).toBeInTheDocument();
      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Couldn\u2019t refresh");
        expect(text).toContain("Retry");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the selected model with an empty OpenCode row without fallback models", async () => {
    const mounted = await mountPicker({
      provider: "opencode",
      model: "openai/gpt-5",
      lockedProvider: "opencode",
      modelDiscoveryByProvider: {
        opencode: {
          status: "empty",
          hasDynamicList: false,
          refreshing: false,
          fetchedAt: Date.now(),
        } satisfies ProviderModelDiscoveryState,
      },
    });

    try {
      await page.getByRole("button").click();

      await expect.element(page.getByRole("menuitemradio", { name: "GPT-5" })).toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "Nemotron 3 Super Free" }))
        .not.toBeInTheDocument();
      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("No models available from OpenCode");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the OpenCode list and a 'Refreshing\u2026' footer while a refresh is in flight", async () => {
    const mounted = await mountPicker({
      provider: "opencode",
      model: "openai/gpt-5",
      lockedProvider: "opencode",
      modelDiscoveryByProvider: {
        opencode: {
          status: "success",
          hasDynamicList: true,
          refreshing: true,
          fetchedAt: Date.now(),
        } satisfies ProviderModelDiscoveryState,
      },
    });

    try {
      await page.getByRole("button").click();

      await expect.element(page.getByRole("menuitemradio", { name: "GPT-5" })).toBeInTheDocument();
      await expect.element(page.getByText("Refreshing\u2026")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("fires a single model query refetch when the refresh footer is clicked", async () => {
    const queryClient = new QueryClient();
    const modelsQueryKey = providerDiscoveryQueryKeys.models("opencode", null, null, null, null);
    // refetchQueries only refetches active queries, so the observer must be enabled.
    const modelsObserver = new QueryObserver(queryClient, {
      queryKey: modelsQueryKey,
      queryFn: () =>
        Promise.resolve({ models: [], source: "opencode" as const, cached: false as const }),
    });
    const unsubscribeObserver = modelsObserver.subscribe(() => undefined);
    const modelsQuery = queryClient.getQueryCache().find({ queryKey: modelsQueryKey })!;
    const fetchSpy = vi.spyOn(modelsQuery, "fetch").mockImplementation(() => Promise.resolve());
    const mounted = await mountPicker({
      queryClient,
      provider: "opencode",
      model: "openai/gpt-5",
      lockedProvider: "opencode",
      modelDiscoveryByProvider: {
        opencode: {
          status: "success",
          hasDynamicList: true,
          refreshing: false,
          fetchedAt: Date.now(),
        } satisfies ProviderModelDiscoveryState,
      },
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Refresh models" }).click();

      await vi.waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });
    } finally {
      unsubscribeObserver();
      await mounted.cleanup();
    }
  });

  it("disables the refresh action while a refetch is already in flight", async () => {
    const queryClient = new QueryClient();
    const mounted = await mountPicker({
      queryClient,
      provider: "opencode",
      model: "openai/gpt-5",
      lockedProvider: "opencode",
      modelDiscoveryByProvider: {
        opencode: {
          status: "success",
          hasDynamicList: true,
          refreshing: true,
          fetchedAt: Date.now(),
        } satisfies ProviderModelDiscoveryState,
      },
    });

    try {
      await page.getByRole("button").click();

      const footer = page.getByRole("button", { name: /Refresh models/ });
      await expect.element(footer).toBeInTheDocument();
      await expect.element(footer).toBeDisabled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows an 'Unavailable?' badge on a selection hint in a successful list", async () => {
    const mounted = await mountPicker({
      provider: "opencode",
      model: "opencode/unknown-model",
      lockedProvider: "opencode",
      modelDiscoveryByProvider: {
        opencode: {
          status: "success",
          hasDynamicList: true,
          refreshing: false,
          fetchedAt: Date.now(),
        } satisfies ProviderModelDiscoveryState,
      },
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        opencode: [
          ...MODEL_OPTIONS_BY_PROVIDER.opencode,
          {
            slug: "opencode/unknown-model" as ModelSlug,
            name: "Unknown Model",
            isSelectionHint: true,
          },
        ],
      },
    });

    try {
      await page.getByRole("button").click();

      await expect.element(page.getByText("Unavailable?")).toBeInTheDocument();
      await page.getByRole("menuitemradio", { name: /Unknown Model/ }).click();
      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "opencode",
        "opencode/unknown-model",
      );
    } finally {
      await mounted.cleanup();
    }
  });
  it("marks a stale Devin GLM selection instead of presenting it as discovered", async () => {
    const mounted = await mountPicker({
      provider: "devin",
      model: "glm-5.3",
      lockedProvider: "devin",
      modelDiscoveryByProvider: {
        devin: {
          status: "success",
          hasDynamicList: true,
          refreshing: false,
          fetchedAt: Date.now(),
        },
      },
      modelOptionsByProvider: {
        ...MODEL_OPTIONS_BY_PROVIDER,
        devin: [
          { slug: "adaptive" as ModelSlug, name: "Adaptive" },
          { slug: "swe-1-7" as ModelSlug, name: "SWE 1.7" },
          { slug: "glm-5.3" as ModelSlug, name: "GLM 5.3", isSelectionHint: true },
        ],
      },
    });

    try {
      await page.getByRole("button").click();
      await expect
        .element(page.getByRole("menuitemradio", { name: "GLM 5.3 — Unavailable?" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "Adaptive" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: "SWE 1.7" }))
        .toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });
});
