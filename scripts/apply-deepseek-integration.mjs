import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const write = (path, text) => fs.writeFileSync(path, text);

function replaceOne(path, before, after) {
  const text = read(path);
  if (!text.includes(before)) {
    throw new Error(`Missing expected text in ${path}: ${before.slice(0, 160)}`);
  }
  const next = text.replace(before, after);
  write(path, next);
}

function replaceRegex(path, regex, replacement) {
  const text = read(path);
  if (!regex.test(text)) {
    throw new Error(`Missing expected regex in ${path}: ${regex}`);
  }
  write(path, text.replace(regex, replacement));
}

// --- DeepSeek ACP adapter type/correctness fixes ---
{
  const path = "apps/server/src/provider/Layers/DeepSeekAdapter.ts";
  replaceOne(
    path,
    'import {\n  makeDeepSeekAcpRuntime,\n  type DeepSeekAcpRuntimeSettings,\n} from "../acp/DeepSeekAcpSupport.ts";',
    'import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";\nimport {\n  makeDeepSeekAcpRuntime,\n  type DeepSeekAcpRuntimeSettings,\n} from "../acp/DeepSeekAcpSupport.ts";',
  );
  replaceOne(
    path,
    '  readonly acp: Awaited<ReturnType<typeof makeDeepSeekAcpRuntime>>;',
    '  readonly acp: AcpSessionRuntimeShape;',
  );
  replaceRegex(path, /cwd: ctx\.session\.cwd([,}])/g, 'cwd: ctx.session.cwd ?? null$1');
}

// DeepSeek Harness ACP itself owns the permission-mode vocabulary. Synara keeps
// policy enforcement at the ACP permission-request boundary instead of sending
// an unverified process-level mode string.
{
  const path = "apps/server/src/provider/acp/DeepSeekAcpSupport.ts";
  let text = read(path);
  text = text.replace('  readonly runtimeMode: "approval-required" | "auto" | "full-access";\n', "");
  text = text.replace(
    '  runtimeMode: DeepSeekAcpRuntimeInput["runtimeMode"],\n',
    "",
  );
  text = text.replace(
    /,\n\s*env: buildProviderChildEnvironment\(\{[\s\S]*?\n\s*\}\),\n\s*\};/,
    ',\n    env: buildProviderChildEnvironment({ provider: "deepseek" }),\n  };',
  );
  text = text.replace(
    '          input.deepSeekSettings,\n          input.cwd,\n          input.runtimeMode,\n',
    '          input.deepSeekSettings,\n          input.cwd,\n',
  );
  write(path, text);
}

// Call site no longer passes an invented DeepSeek process permission mode.
replaceOne(
  "apps/server/src/provider/Layers/DeepSeekAdapter.ts",
  '            runtimeMode: input.runtimeMode,\n            deepSeekSettings: effectiveSettings,',
  '            deepSeekSettings: effectiveSettings,',
);

// Undo an unrelated formatting artifact introduced during the contract edit.
replaceOne(
  "packages/contracts/src/model.ts",
  '  return { value, label, description, apiEffortValue, controlSource: "provider-setting", ...{} };',
  '  return { value, label, description, apiEffortValue, controlSource: "provider-setting" };',
);

// --- Shared/server exhaustive provider maps ---
replaceOne(
  "packages/shared/src/model.ts",
  '  grok: new Set(MODEL_OPTIONS_BY_PROVIDER.grok.map((option) => option.slug)),\n  droid:',
  '  grok: new Set(MODEL_OPTIONS_BY_PROVIDER.grok.map((option) => option.slug)),\n  deepseek: new Set(MODEL_OPTIONS_BY_PROVIDER.deepseek.map((option) => option.slug)),\n  droid:',
);

replaceOne(
  "apps/server/src/agentGateway/targetResolver.ts",
  '  grok: defineProviderOptionConfig<"grok">({\n    primaryOptionKey: "reasoningEffort",\n    options: {\n      reasoningEffort: providerOptionRule("string", GROK_REASONING_EFFORT_OPTIONS),\n    },\n  }),\n  droid:',
  '  grok: defineProviderOptionConfig<"grok">({\n    primaryOptionKey: "reasoningEffort",\n    options: {\n      reasoningEffort: providerOptionRule("string", GROK_REASONING_EFFORT_OPTIONS),\n    },\n  }),\n  deepseek: defineProviderOptionConfig<"deepseek">({\n    options: {},\n  }),\n  droid:',
);

// Portable Synara skills can still be injected in prompts, but the public
// DeepSeek ACP bridge has no native skill-discovery surface.
replaceRegex(
  "apps/server/src/provider/skillsCatalog.ts",
  /(\s+grok:\s*\[[^\n]*\],\n)/,
  '$1  deepseek: [],\n',
);

// --- Web app settings and provider persistence ---
{
  const path = "apps/web/src/appSettings.ts";
  replaceOne(
    path,
    '  | "customGrokModels"\n  | "customDroidModels"',
    '  | "customGrokModels"\n  | "customDeepSeekModels"\n  | "customDroidModels"',
  );
  replaceOne(
    path,
    '  grok: new Set(getModelOptions("grok").map((option) => option.slug)),\n  droid:',
    '  grok: new Set(getModelOptions("grok").map((option) => option.slug)),\n  deepseek: new Set(getModelOptions("deepseek").map((option) => option.slug)),\n  droid:',
  );
  replaceOne(
    path,
    '  "gemini",\n  "grok",\n  "droid",',
    '  "gemini",\n  "grok",\n  "deepseek",\n  "droid",',
  );
  replaceOne(
    path,
    '  grokBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),\n  droidBinaryPath:',
    '  grokBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),\n  deepSeekBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),\n  deepSeekConfigPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),\n  droidBinaryPath:',
  );
  replaceOne(
    path,
    '  customGrokModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),\n  customDroidModels:',
    '  customGrokModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),\n  customDeepSeekModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),\n  customDroidModels:',
  );
  replaceOne(
    path,
    '  grok: {\n    provider: "grok",\n    settingsKey: "customGrokModels",\n    defaultSettingsKey: "customGrokModels",\n    title: "Grok",\n    description: "Save additional Grok model slugs for the picker and `/model` command.",\n    placeholder: "your-grok-model-slug",\n    example: "grok-build-0.1",\n  },\n  droid:',
    '  grok: {\n    provider: "grok",\n    settingsKey: "customGrokModels",\n    defaultSettingsKey: "customGrokModels",\n    title: "Grok",\n    description: "Save additional Grok model slugs for the picker and `/model` command.",\n    placeholder: "your-grok-model-slug",\n    example: "grok-build-0.1",\n  },\n  deepseek: {\n    provider: "deepseek",\n    settingsKey: "customDeepSeekModels",\n    defaultSettingsKey: "customDeepSeekModels",\n    title: "DeepSeek Harness",\n    description: "DeepSeek Harness selects its active model from the Cordis configuration.",\n    placeholder: "configured",\n    example: "configured",\n  },\n  droid:',
  );
  replaceOne(
    path,
    '    grokBinaryPath: normalizeProviderBinaryPathOverride("grok", settings.grokBinaryPath),\n    droidBinaryPath:',
    '    grokBinaryPath: normalizeProviderBinaryPathOverride("grok", settings.grokBinaryPath),\n    deepSeekBinaryPath: normalizeProviderBinaryPathOverride("deepseek", settings.deepSeekBinaryPath),\n    droidBinaryPath:',
  );
  replaceOne(
    path,
    '    customGrokModels: normalizeCustomModelSlugs(settings.customGrokModels, "grok"),\n    customDroidModels:',
    '    customGrokModels: normalizeCustomModelSlugs(settings.customGrokModels, "grok"),\n    customDeepSeekModels: normalizeCustomModelSlugs(settings.customDeepSeekModels, "deepseek"),\n    customDroidModels:',
  );
  replaceOne(
    path,
    '    grokBinaryPath: settings.providers.grok.binaryPath,\n    droidBinaryPath:',
    '    grokBinaryPath: settings.providers.grok.binaryPath,\n    deepSeekBinaryPath: settings.providers.deepseek.binaryPath,\n    deepSeekConfigPath: settings.providers.deepseek.configPath,\n    droidBinaryPath:',
  );
  replaceOne(
    path,
    '    customGrokModels: settings.providers.grok.customModels,\n    customDroidModels:',
    '    customGrokModels: settings.providers.grok.customModels,\n    customDeepSeekModels: settings.providers.deepseek.customModels,\n    customDroidModels:',
  );
  replaceOne(
    path,
    '    "customGrokModels",\n    "customDroidModels",',
    '    "customGrokModels",\n    "customDeepSeekModels",\n    "customDroidModels",',
  );
  replaceOne(
    path,
    '    grok: getCustomModelsForProvider(settings, "grok"),\n    droid:',
    '    grok: getCustomModelsForProvider(settings, "grok"),\n    deepseek: getCustomModelsForProvider(settings, "deepseek"),\n    droid:',
  );
  replaceOne(
    path,
    '    grok: getAppModelOptions("grok", customModelsByProvider.grok),\n    droid:',
    '    grok: getAppModelOptions("grok", customModelsByProvider.grok),\n    deepseek: getAppModelOptions("deepseek", customModelsByProvider.deepseek),\n    droid:',
  );
  replaceOne(
    path,
    '    | "grokBinaryPath"\n    | "droidBinaryPath"',
    '    | "grokBinaryPath"\n    | "deepSeekBinaryPath"\n    | "deepSeekConfigPath"\n    | "droidBinaryPath"',
  );
  replaceOne(
    path,
    '  const grokBinaryPath = normalizeProviderBinaryPathOverride("grok", settings.grokBinaryPath);\n  const droidBinaryPath',
    '  const grokBinaryPath = normalizeProviderBinaryPathOverride("grok", settings.grokBinaryPath);\n  const deepSeekBinaryPath = normalizeProviderBinaryPathOverride("deepseek", settings.deepSeekBinaryPath);\n  const droidBinaryPath',
  );
  replaceOne(
    path,
    '    ...(droidBinaryPath\n      ? {',
    '    ...(deepSeekBinaryPath || settings.deepSeekConfigPath\n      ? {\n          deepseek: {\n            ...(deepSeekBinaryPath ? { binaryPath: deepSeekBinaryPath } : {}),\n            ...(settings.deepSeekConfigPath ? { configPath: settings.deepSeekConfigPath } : {}),\n          },\n        }\n      : {}),\n    ...(droidBinaryPath\n      ? {',
  );
  replaceOne(
    path,
    '    | "grokBinaryPath"\n    | "droidBinaryPath"',
    '    | "grokBinaryPath"\n    | "deepSeekBinaryPath"\n    | "droidBinaryPath"',
  );
  replaceOne(
    path,
    '    case "grok":\n      return normalizeProviderBinaryPathOverride(provider, settings.grokBinaryPath);\n    case "droid":',
    '    case "grok":\n      return normalizeProviderBinaryPathOverride(provider, settings.grokBinaryPath);\n    case "deepseek":\n      return normalizeProviderBinaryPathOverride(provider, settings.deepSeekBinaryPath);\n    case "droid":',
  );

  // Patch server-settings projection when DeepSeek app settings change.
  replaceOne(
    path,
    '  if (hasOwn(patch, "droidBinaryPath") || hasOwn(patch, "customDroidModels")) {',
    '  if (\n    hasOwn(patch, "deepSeekBinaryPath") ||\n    hasOwn(patch, "deepSeekConfigPath") ||\n    hasOwn(patch, "customDeepSeekModels")\n  ) {\n    providers.deepseek = {\n      ...(hasOwn(patch, "deepSeekBinaryPath")\n        ? { binaryPath: patch.deepSeekBinaryPath ?? "" }\n        : {}),\n      ...(hasOwn(patch, "deepSeekConfigPath")\n        ? { configPath: patch.deepSeekConfigPath ?? "" }\n        : {}),\n      ...(hasOwn(patch, "customDeepSeekModels")\n        ? { customModels: patch.customDeepSeekModels ?? [] }\n        : {}),\n    };\n  }\n  if (hasOwn(patch, "droidBinaryPath") || hasOwn(patch, "customDroidModels")) {',
  );
}

// Brand-neutral fallback until Synara carries a dedicated DeepSeek SVG.
replaceOne(
  "apps/web/src/components/ProviderIcon.tsx",
  '  grok: GrokIcon,\n  droid: DroidIcon,',
  '  grok: GrokIcon,\n  deepseek: GrokIcon,\n  droid: DroidIcon,',
);

// No native plugins/skills advertised by DeepSeek's public ACP bridge.
replaceRegex(
  "apps/web/src/components/PluginLibrary.tsx",
  /(\s+grok:\s*\{\s*plugins:\s*false,\s*skills:\s*false\s*\},\n)/,
  '$1        deepseek: { plugins: false, skills: false },\n',
);

console.log("DeepSeek integration codemod applied.");
