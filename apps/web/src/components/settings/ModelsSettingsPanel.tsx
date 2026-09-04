// FILE: ModelsSettingsPanel.tsx
// Purpose: Own model-setting discovery, selection, and custom-model editing workflows.
// Layer: Settings panel

import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  GIT_TEXT_GENERATION_PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
  type GitTextGenerationProvider,
  type ProviderKind,
} from "@synara/contracts";
import { getModelOptions, normalizeModelSlug } from "@synara/shared/model";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import {
  CUSTOM_MODEL_EDITOR_PROVIDER_SETTINGS,
  type AppSettingsBinding,
  MAX_CUSTOM_MODEL_LENGTH,
  getCustomModelsForProvider,
  getDefaultCustomModelsForProvider,
  getGitTextGenerationModelOptions,
  isGitTextGenerationSettingsDirty,
  patchCustomModels,
} from "~/appSettings";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { PlusIcon, XIcon } from "~/lib/icons";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import {
  SETTINGS_CARD_ROW_DIVIDER_CLASS_NAME,
  SETTINGS_INSET_LIST_CLASS_NAME,
} from "~/settingsPanelStyles";

import { Button } from "../ui/button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import {
  SettingResetButton,
  SettingsSelectControl,
  useSettingsRestoreSignal,
} from "./SettingControls";
import { SettingsRow, SettingsSection, SettingsSelectPopup } from "./SettingsPanelPrimitives";

type CustomModelValidationResult =
  | { readonly model: string; readonly error?: never }
  | { readonly model?: never; readonly error: string };

export function validateCustomModelInput(input: {
  readonly provider: ProviderKind;
  readonly value: string;
  readonly savedModels: readonly string[];
}): CustomModelValidationResult {
  const normalized = normalizeModelSlug(input.value, input.provider);
  if (!normalized) {
    return { error: "Enter a model slug." };
  }
  if (getModelOptions(input.provider).some((option) => option.slug === normalized)) {
    return { error: "That model is already built in." };
  }
  if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
    return { error: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.` };
  }
  if (input.savedModels.includes(normalized)) {
    return { error: "That custom model is already saved." };
  }
  return { model: normalized };
}

function isCustomModelEditorProvider(value: string | null): value is ProviderKind {
  return CUSTOM_MODEL_EDITOR_PROVIDER_SETTINGS.some((config) => config.provider === value);
}

export function ModelsSettingsPanel({
  settings,
  defaults,
  updateSettings,
  resetEpoch,
  active,
}: AppSettingsBinding & { readonly resetEpoch: number; readonly active: boolean }) {
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const [selectedCustomModelProvider, setSelectedCustomModelProvider] =
    useState<ProviderKind>("codex");
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Partial<Record<ProviderKind, string>>
  >({});
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [showAllCustomModels, setShowAllCustomModels] = useState(false);

  useSettingsRestoreSignal(resetEpoch, () => {
    setSelectedCustomModelProvider("codex");
    setCustomModelInputByProvider({});
    setCustomModelErrorByProvider({});
    setShowAllCustomModels(false);
  });

  const { textGenerationModel, textGenerationProvider } = settings;
  const currentGitTextGenerationProvider = textGenerationProvider ?? "codex";
  const currentGitTextGenerationModel = textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL;
  const gitWritingModelHintByProvider = useMemo<Partial<Record<ProviderKind, string | null>>>(
    () => ({ [currentGitTextGenerationProvider]: currentGitTextGenerationModel }),
    [currentGitTextGenerationModel, currentGitTextGenerationProvider],
  );
  const providerModelDiscoveryCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: null,
    activeProjectCwd: null,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });
  const { modelOptionsByProvider: gitWritingCatalogOptionsByProvider } = useProviderModelCatalog({
    selectedProvider: currentGitTextGenerationProvider,
    discoveryEnabled: active,
    cwd: providerModelDiscoveryCwd,
    modelHintByProvider: gitWritingModelHintByProvider,
    prefetchProviders: GIT_TEXT_GENERATION_PROVIDERS,
  });
  const gitTextGenerationModelOptions = useMemo(() => {
    const discoveredOptionsByProvider = {} as Record<
      GitTextGenerationProvider,
      (typeof gitWritingCatalogOptionsByProvider)[GitTextGenerationProvider]
    >;
    for (const provider of GIT_TEXT_GENERATION_PROVIDERS) {
      discoveredOptionsByProvider[provider] = gitWritingCatalogOptionsByProvider[provider];
    }
    return getGitTextGenerationModelOptions(settings, discoveredOptionsByProvider);
  }, [gitWritingCatalogOptionsByProvider, settings]);
  const currentGitTextGenerationValue = `${currentGitTextGenerationProvider}:${currentGitTextGenerationModel}`;
  const isGitTextGenerationModelDirty = isGitTextGenerationSettingsDirty(settings, defaults);
  const selectedGitTextGenerationModelLabel =
    gitTextGenerationModelOptions.find(
      (option) =>
        option.provider === currentGitTextGenerationProvider &&
        option.slug === currentGitTextGenerationModel,
    )?.name ?? currentGitTextGenerationModel;
  const selectedCustomModelProviderSettings = CUSTOM_MODEL_EDITOR_PROVIDER_SETTINGS.find(
    (config) => config.provider === selectedCustomModelProvider,
  )!;
  const selectedCustomModelInput = customModelInputByProvider[selectedCustomModelProvider] ?? "";
  const selectedCustomModelError = customModelErrorByProvider[selectedCustomModelProvider] ?? null;
  const savedCustomModelRows = useMemo(
    () =>
      CUSTOM_MODEL_EDITOR_PROVIDER_SETTINGS.flatMap((config) =>
        getCustomModelsForProvider(settings, config.provider).map((slug) => ({
          key: `${config.provider}:${slug}`,
          provider: config.provider,
          providerTitle: config.title,
          slug,
        })),
      ),
    [settings],
  );
  const visibleCustomModelRows = savedCustomModelRows.slice(0, 5);
  const overflowCustomModelRows = savedCustomModelRows.slice(5);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      const result = validateCustomModelInput({
        provider,
        value: customModelInputByProvider[provider] ?? "",
        savedModels: customModels,
      });
      if ("error" in result) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: result.error,
        }));
        return;
      }

      updateSettings(patchCustomModels(provider, [...customModels, result.model]));
      setCustomModelInputByProvider((existing) => ({ ...existing, [provider]: "" }));
      setCustomModelErrorByProvider((existing) => ({ ...existing, [provider]: null }));
    },
    [customModelInputByProvider, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(
        patchCustomModels(
          provider,
          customModels.filter((model) => model !== slug),
        ),
      );
      setCustomModelErrorByProvider((existing) => ({ ...existing, [provider]: null }));
    },
    [settings, updateSettings],
  );

  const resetCustomModels = useCallback(() => {
    const patch = Object.assign(
      {},
      ...CUSTOM_MODEL_EDITOR_PROVIDER_SETTINGS.map((config) =>
        patchCustomModels(config.provider, [
          ...getDefaultCustomModelsForProvider(defaults, config.provider),
        ]),
      ),
    );
    updateSettings(patch);
    setCustomModelErrorByProvider({});
    setShowAllCustomModels(false);
  }, [defaults, updateSettings]);

  const renderCustomModelRow = (
    row: (typeof savedCustomModelRows)[number],
    removeFirstBorder: boolean,
  ) => (
    <div
      key={row.key}
      className={cn(
        "group grid grid-cols-[minmax(5rem,6rem)_minmax(0,1fr)_auto] items-center gap-3 border-t border-[color:var(--color-border)] px-4 py-2",
        removeFirstBorder && "first:border-t-0",
      )}
    >
      <span className="truncate text-xs text-muted-foreground">{row.providerTitle}</span>
      <code className="min-w-0 truncate text-sm text-foreground">{row.slug}</code>
      <button
        type="button"
        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100"
        aria-label={`Remove ${row.slug}`}
        onClick={() => removeCustomModel(row.provider, row.slug)}
      >
        <XIcon className="size-3.5 text-muted-foreground hover:text-foreground" />
      </button>
    </div>
  );

  if (!active) return null;

  return (
    <div className="space-y-6">
      <SettingsSection title="Generation defaults">
        <SettingsRow
          title="Git writing model"
          description="Used for generated commit messages, PR titles, and branch names."
          resetAction={
            isGitTextGenerationModelDirty ? (
              <SettingResetButton
                label="git writing model"
                onClick={() =>
                  updateSettings({
                    textGenerationProvider: defaults.textGenerationProvider,
                    textGenerationModel: defaults.textGenerationModel,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={currentGitTextGenerationValue}
              onValueChange={(value) => {
                if (!value) return;
                const separatorIndex = value.indexOf(":");
                const provider = value.slice(0, separatorIndex) as ProviderKind;
                const model = value.slice(separatorIndex + 1);
                if (!provider || !model) return;
                updateSettings({
                  textGenerationProvider: provider,
                  textGenerationModel: model,
                });
              }}
              ariaLabel="Git text generation model"
              triggerClassName="w-full sm:w-52"
              valueContent={selectedGitTextGenerationModelLabel}
            >
              {gitTextGenerationModelOptions.map((option) => (
                <SelectItem
                  hideIndicator
                  key={`${option.provider}:${option.slug}`}
                  value={`${option.provider}:${option.slug}`}
                >
                  {PROVIDER_DISPLAY_NAMES[option.provider]} / {option.name}
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />
      </SettingsSection>

      <SettingsSection title="Custom models">
        <SettingsRow
          title="Saved model slugs"
          description="Add custom model slugs for supported providers."
          resetAction={
            savedCustomModelRows.length > 0 ? (
              <SettingResetButton label="custom models" onClick={resetCustomModels} />
            ) : null
          }
        >
          <div className={cn("mt-4 pt-4", SETTINGS_CARD_ROW_DIVIDER_CLASS_NAME)}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={selectedCustomModelProvider}
                onValueChange={(value) => {
                  if (isCustomModelEditorProvider(value)) {
                    setSelectedCustomModelProvider(value);
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="Custom model provider"
                >
                  <SelectValue>{selectedCustomModelProviderSettings.title}</SelectValue>
                </SelectTrigger>
                <SettingsSelectPopup align="start">
                  {CUSTOM_MODEL_EDITOR_PROVIDER_SETTINGS.map((config) => (
                    <SelectItem hideIndicator key={config.provider} value={config.provider}>
                      {config.title}
                    </SelectItem>
                  ))}
                </SettingsSelectPopup>
              </Select>
              <Input
                id="custom-model-slug"
                size="sm"
                variant="soft"
                value={selectedCustomModelInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setCustomModelInputByProvider((existing) => ({
                    ...existing,
                    [selectedCustomModelProvider]: value,
                  }));
                  if (selectedCustomModelError) {
                    setCustomModelErrorByProvider((existing) => ({
                      ...existing,
                      [selectedCustomModelProvider]: null,
                    }));
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addCustomModel(selectedCustomModelProvider);
                }}
                placeholder={selectedCustomModelProviderSettings.example}
                spellCheck={false}
              />
              <Button
                className="shrink-0"
                variant="outline"
                onClick={() => addCustomModel(selectedCustomModelProvider)}
              >
                <PlusIcon className="size-3.5" />
                Add
              </Button>
            </div>

            {selectedCustomModelError ? (
              <p className="mt-2 text-xs text-destructive">{selectedCustomModelError}</p>
            ) : null}

            {savedCustomModelRows.length > 0 ? (
              <div className={cn("mt-3", SETTINGS_INSET_LIST_CLASS_NAME)}>
                {visibleCustomModelRows.map((row) => renderCustomModelRow(row, true))}
                {overflowCustomModelRows.length > 0 ? (
                  <>
                    <DisclosureRegion open={showAllCustomModels}>
                      <div>
                        {overflowCustomModelRows.map((row) => renderCustomModelRow(row, false))}
                      </div>
                    </DisclosureRegion>
                    <button
                      type="button"
                      className="mt-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                      aria-expanded={showAllCustomModels}
                      onClick={() => setShowAllCustomModels((value) => !value)}
                    >
                      {showAllCustomModels
                        ? "Show less"
                        : `Show more (${overflowCustomModelRows.length})`}
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
