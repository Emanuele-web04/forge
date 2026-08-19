from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, text: str) -> None:
    Path(path).write_text(text)


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    if text.count(old) != 1:
        raise SystemExit(f"{path}: expected one occurrence, got {text.count(old)}: {old[:80]!r}")
    write(path, text.replace(old, new, 1))


# --- ACP runtime: authentication may be optional for BYOK agents. ---
p = "apps/server/src/provider/acp/AcpSessionRuntime.ts"
replace_once(
    p,
    '  readonly resolveAuthMethodId?: (\n    initializeResult: Acp.InitializeResponse,\n  ) => Effect.Effect<string, AcpErrors.AcpError>;\n',
    '  readonly resolveAuthMethodId?: (\n    initializeResult: Acp.InitializeResponse,\n  ) => Effect.Effect<string | undefined, AcpErrors.AcpError>;\n  /** Existing concrete providers require auth; BYOK ACP agents may not advertise it. */\n  readonly authentication?: "required" | "when-advertised";\n',
)
replace_once(
    p,
    '''      if (!authMethodId) {\n        return yield* new AcpErrors.AcpRequestError({\n          code: -32602,\n          errorMessage: "ACP agent did not provide an authentication method.",\n          data: { authMethods: initializeResult.authMethods ?? [] },\n        });\n      }\n\n      const authenticatePayload = {\n        methodId: authMethodId,\n        ...(options.authenticateMeta ? { _meta: options.authenticateMeta } : {}),\n      } satisfies Acp.AuthenticateRequest;\n\n      yield* withStartupTimeout(\n        "authenticate",\n        startupTimeouts.authenticateMs,\n        runLoggedRequest(\n          "authenticate",\n          authenticatePayload,\n          acp.agent.authenticate(authenticatePayload),\n        ),\n      );\n''',
    '''      if (!authMethodId && options.authentication !== "when-advertised") {\n        return yield* new AcpErrors.AcpRequestError({\n          code: -32602,\n          errorMessage: "ACP agent did not provide an authentication method.",\n          data: { authMethods: initializeResult.authMethods ?? [] },\n        });\n      }\n\n      if (authMethodId) {\n        const authenticatePayload = {\n          methodId: authMethodId,\n          ...(options.authenticateMeta ? { _meta: options.authenticateMeta } : {}),\n        } satisfies Acp.AuthenticateRequest;\n\n        yield* withStartupTimeout(\n          "authenticate",\n          startupTimeouts.authenticateMs,\n          runLoggedRequest(\n            "authenticate",\n            authenticatePayload,\n            acp.agent.authenticate(authenticatePayload),\n          ),\n        );\n      }\n''',
)

# --- Copilot transport uses auth only when advertised. ---
p = "apps/server/src/provider/acp/CopilotAcpSupport.ts"
replace_once(
    p,
    '  "authMethodId" | "resolveAuthMethodId" | "spawn"\n',
    '  "authMethodId" | "resolveAuthMethodId" | "authentication" | "spawn"\n',
)
text = read(p)
start = text.index("export const resolveCopilotAcpAuthMethodId")
end = text.index("\n\nexport const makeCopilotAcpRuntime", start)
text = (
    text[:start]
    + '''export const resolveCopilotAcpAuthMethodId = (\n  initializeResult: Acp.InitializeResponse,\n): Effect.Effect<string | undefined> =>\n  Effect.succeed(\n    (initializeResult.authMethods ?? []).map((method) => method.id.trim()).find(Boolean),\n  );'''
    + text[end:]
)
text = text.replace(
    "        resolveAuthMethodId: resolveCopilotAcpAuthMethodId,\n",
    "        resolveAuthMethodId: resolveCopilotAcpAuthMethodId,\n        authentication: \"when-advertised\",\n",
    1,
)
write(p, text)

p = "apps/server/src/provider/acp/CopilotAcpSupport.test.ts"
text = read(p)
text = re.sub(
    r'''  it\("fails with an actionable error when the ACP server advertises no auth method", async \(\) => \{[\s\S]*?\n  \}\);''',
    '''  it("allows BYOK sessions when Copilot advertises no client-driven auth method", async () => {\n    const methodId = await Effect.runPromise(\n      resolveCopilotAcpAuthMethodId(initializeWithAuthMethods([])),\n    );\n    expect(methodId).toBeUndefined();\n  });''',
    text,
    count=1,
)
write(p, text)

# --- Contracts: first-class provider identity and selection. ---
p = "packages/contracts/src/orchestration.ts"
replace_once(p, '  "pi",\n]);\n', '  "pi",\n  "copilot",\n]);\n')
replace_once(
    p,
    '''export type PiModelSelection = typeof PiModelSelection.Type;\n\nexport const ModelSelection = Schema.Union([\n''',
    '''export type PiModelSelection = typeof PiModelSelection.Type;\n\nexport const CopilotModelSelection = Schema.Struct({\n  provider: Schema.Literal("copilot"),\n  model: TrimmedNonEmptyString,\n});\nexport type CopilotModelSelection = typeof CopilotModelSelection.Type;\n\nexport const ModelSelection = Schema.Union([\n''',
)
replace_once(p, '  PiModelSelection,\n]);\n', '  PiModelSelection,\n  CopilotModelSelection,\n]);\n')
replace_once(
    p,
    '''export const PiProviderStartOptions = Schema.Struct({\n  binaryPath: Schema.optional(TrimmedNonEmptyString),\n  agentDir: Schema.optional(TrimmedNonEmptyString),\n});\n\nexport const ProviderStartOptions = Schema.Struct({\n''',
    '''export const PiProviderStartOptions = Schema.Struct({\n  binaryPath: Schema.optional(TrimmedNonEmptyString),\n  agentDir: Schema.optional(TrimmedNonEmptyString),\n});\n\nexport const CopilotProviderStartOptions = Schema.Struct({\n  binaryPath: Schema.optional(TrimmedNonEmptyString),\n});\n\nexport const ProviderStartOptions = Schema.Struct({\n''',
)
replace_once(p, '  pi: Schema.optional(PiProviderStartOptions),\n});\n', '  pi: Schema.optional(PiProviderStartOptions),\n  copilot: Schema.optional(CopilotProviderStartOptions),\n});\n')

p = "packages/contracts/src/model.ts"
replace_once(
    p,
    '''  // Pi discovery owns the live catalog, including auth-gated Anthropic models.\n  pi: [],\n  cursor: [\n''',
    '''  // Pi discovery owns the live catalog, including auth-gated Anthropic models.\n  pi: [],\n  // Copilot discovery owns the account-specific live ACP catalog.\n  copilot: [\n    {\n      slug: "default",\n      name: "Copilot default",\n      capabilities: {\n        reasoningEffortLevels: [],\n        supportsFastMode: false,\n        supportsThinkingToggle: false,\n        promptInjectedEffortLevels: [],\n        contextWindowOptions: [],\n      },\n    },\n  ],\n  cursor: [\n''',
)
replace_once(p, '  opencode: "openai/gpt-5",\n};\n', '  opencode: "openai/gpt-5",\n  copilot: "default",\n};\n')
replace_once(p, '  pi: {},\n};\n', '  pi: {},\n  copilot: {},\n};\n')
replace_once(p, '  pi: "Pi",\n};\n', '  pi: "Pi",\n  copilot: "GitHub Copilot",\n};\n')

p = "packages/contracts/src/settings.ts"
replace_once(
    p,
    '''export type PiServerProviderSettings = typeof PiServerProviderSettings.Type;\n\nconst DisabledSkillNames''',
    '''export type PiServerProviderSettings = typeof PiServerProviderSettings.Type;\n\nexport const CopilotServerProviderSettings = Schema.Struct({\n  ...ProviderSettingsBase,\n  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "copilot")),\n});\nexport type CopilotServerProviderSettings = typeof CopilotServerProviderSettings.Type;\n\nconst DisabledSkillNames''',
)
replace_once(
    p,
    '    pi: PiServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),\n',
    '    pi: PiServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),\n    copilot: CopilotServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),\n',
)
replace_once(
    p,
    '''      pi: Schema.optionalKey(\n        Schema.Struct({\n          ...ProviderSettingsBasePatch,\n          binaryPath: Schema.optionalKey(StringSetting),\n          agentDir: Schema.optionalKey(StringSetting),\n        }),\n      ),\n''',
    '''      pi: Schema.optionalKey(\n        Schema.Struct({\n          ...ProviderSettingsBasePatch,\n          binaryPath: Schema.optionalKey(StringSetting),\n          agentDir: Schema.optionalKey(StringSetting),\n        }),\n      ),\n      copilot: Schema.optionalKey(\n        Schema.Struct({\n          ...ProviderSettingsBasePatch,\n          binaryPath: Schema.optionalKey(StringSetting),\n        }),\n      ),\n''',
)

p = "packages/contracts/src/providerDiscovery.ts"
replace_once(p, '  "pi",\n]);\n', '  "pi",\n  "copilot",\n]);\n')

p = "packages/contracts/src/agentMentions.ts"
replace_once(p, '  pi: {},\n} as const satisfies', '  pi: {},\n  copilot: {},\n} as const satisfies')
replace_once(p, '  pi: [],\n};\n', '  pi: [],\n  copilot: [],\n};\n')

p = "packages/shared/src/providerMetadata.ts"
replace_once(
    p,
    '''  {\n    kind: "pi",\n    displayName: PROVIDER_DISPLAY_NAMES.pi,\n    available: true,\n    supportsNativeTurnSteering: true,\n    usage: null,\n  },\n] as const satisfies readonly ProviderDescriptor[];\n''',
    '''  {\n    kind: "pi",\n    displayName: PROVIDER_DISPLAY_NAMES.pi,\n    available: true,\n    supportsNativeTurnSteering: true,\n    usage: null,\n  },\n  {\n    kind: "copilot",\n    displayName: PROVIDER_DISPLAY_NAMES.copilot,\n    available: true,\n    supportsNativeTurnSteering: false,\n    usage: null,\n  },\n] as const satisfies readonly ProviderDescriptor[];\n''',
)

p = "packages/shared/src/serverSettings.ts"
replace_once(
    p,
    '''    pi: {\n      ...(providers.pi.binaryPath ? { binaryPath: providers.pi.binaryPath } : {}),\n      ...(providers.pi.agentDir ? { agentDir: providers.pi.agentDir } : {}),\n    },\n''',
    '''    pi: {\n      ...(providers.pi.binaryPath ? { binaryPath: providers.pi.binaryPath } : {}),\n      ...(providers.pi.agentDir ? { agentDir: providers.pi.agentDir } : {}),\n    },\n    copilot: {\n      ...(providers.copilot.binaryPath ? { binaryPath: providers.copilot.binaryPath } : {}),\n    },\n''',
)

# --- Specialize the generic ACP lifecycle against current helper APIs. ---
p = "apps/server/src/provider/Layers/CopilotAdapter.ts"
text = read(p)
text = text.replace("AcpAdapterLive - configurable stdio Agent Client Protocol provider.", "CopilotAdapterLive - GitHub Copilot CLI via ACP.")
text = text.replace("  type AcpServerProviderSettings,\n", "")
text = text.replace("  type ProviderComposerCapabilities,\n", "  type ProviderComposerCapabilities,\n  type ProviderInteractionMode,\n")
text = text.replace("  resolveAcpToolCallTurnId,\n", "")
text = text.replace(
    'import { makeGenericAcpRuntime, type GenericAcpRuntimeSettings } from "../acp/GenericAcpSupport.ts";',
    'import {\n  discoverCopilotAcpModels,\n  makeCopilotAcpRuntime,\n  type CopilotAcpRuntimeSettings,\n} from "../acp/CopilotAcpSupport.ts";',
)
text = text.replace(
    'import { AcpAdapter, type AcpAdapterShape } from "../Services/AcpAdapter.ts";',
    'import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";',
)
text = text.replace('const PROVIDER = "acp" as const;', 'const PROVIDER = "copilot" as const;')
text = text.replace('activeInteractionMode: "default" | "plan" | undefined;', 'activeInteractionMode: ProviderInteractionMode | undefined;')
text = text.replace("AcpAdapterShape", "CopilotAdapterShape")
text = text.replace("resolveAcpToolCallTurnId(activeTurnId, mappedToolTurnId)", "mappedToolTurnId ?? activeTurnId")
text = re.sub(
    r'''export function modelDescriptorsFromConfigOptions\([\s\S]*?\n}\n\nexport function makeAcpAdapter\(settings: GenericAcpRuntimeSettings\) \{''',
    'export function makeCopilotAdapter(settings: CopilotAcpRuntimeSettings = {}) {',
    text,
    count=1,
)
old = '''          const configured = input.providerOptions?.acp;\n          const resumeSessionId = parseResumeCursor(input.resumeCursor);\n          const effectiveSettings: GenericAcpRuntimeSettings = {\n            binaryPath: configured?.binaryPath ?? settings.binaryPath,\n            args: configured?.args ?? settings.args,\n          };\n          const acp = yield* makeGenericAcpRuntime({\n            settings: effectiveSettings,\n            childProcessSpawner,\n            cwd,\n            options: {\n              clientInfo: { name: "Synara", version: "0.0.0" },\n              ...(resumeSessionId ? { resumeSessionId } : {}),\n            },\n          }).pipe('''
new = '''          const configured = input.providerOptions?.copilot;\n          const resumeSessionId = parseResumeCursor(input.resumeCursor);\n          const effectiveSettings: CopilotAcpRuntimeSettings = {\n            binaryPath: configured?.binaryPath ?? settings.binaryPath,\n          };\n          const acp = yield* makeCopilotAcpRuntime({\n            copilotSettings: effectiveSettings,\n            childProcessSpawner,\n            cwd,\n            clientInfo: { name: "Synara", version: "0.0.0" },\n            ...(resumeSessionId ? { resumeSessionId } : {}),\n          }).pipe('''
if old not in text:
    raise SystemExit("CopilotAdapter startSession template missing")
text = text.replace(old, new, 1)
old = '''          const runtime = yield* makeGenericAcpRuntime({\n            settings: {\n              binaryPath: input.binaryPath ?? settings.binaryPath,\n              args: input.args ?? settings.args,\n            },\n            childProcessSpawner,\n            cwd,\n            options: { clientInfo: { name: "Synara model discovery", version: "0.0.0" } },\n          }).pipe(Effect.provideService(Scope.Scope, scope));\n          const started = yield* runtime.start();\n          const models = modelDescriptorsFromConfigOptions(\n            started.sessionSetupResult.configOptions ?? [],\n          );\n          return { models, source: "acp", cached: false } satisfies ProviderListModelsResult;'''
new = '''          const runtime = yield* makeCopilotAcpRuntime({\n            copilotSettings: { binaryPath: input.binaryPath ?? settings.binaryPath },\n            childProcessSpawner,\n            cwd,\n            clientInfo: { name: "Synara model discovery", version: "0.0.0" },\n          }).pipe(Effect.provideService(Scope.Scope, scope));\n          yield* runtime.start();\n          return yield* discoverCopilotAcpModels(runtime);'''
if old not in text:
    raise SystemExit("CopilotAdapter listModels template missing")
text = text.replace(old, new, 1)
old = '''export const AcpAdapterLive = Layer.effect(\n  AcpAdapter,\n  makeAcpAdapter({ binaryPath: "cline", args: ["--acp"] }),\n);\n\nexport function makeAcpAdapterLive(\n  settings: Pick<AcpServerProviderSettings, "binaryPath" | "args"> = {\n    binaryPath: "cline",\n    args: ["--acp"],\n  },\n) {\n  return Layer.effect(AcpAdapter, makeAcpAdapter(settings));\n}'''
new = '''export const CopilotAdapterLive = Layer.effect(CopilotAdapter, makeCopilotAdapter());\n\nexport function makeCopilotAdapterLive(settings: CopilotAcpRuntimeSettings = {}) {\n  return Layer.effect(CopilotAdapter, makeCopilotAdapter(settings));\n}'''
if old not in text:
    raise SystemExit("CopilotAdapter export template missing")
text = text.replace(old, new, 1)
text = text.replace('"acp.turn_completed_without_content"', '"copilot.turn_completed_without_content"')
write(p, text)

p = "apps/server/src/provider/Services/CopilotAdapter.ts"
text = read(p)
text = text.replace("AcpAdapter", "CopilotAdapter")
text = text.replace('readonly provider: "acp";', 'readonly provider: "copilot";')
write(p, text)

# --- Register the adapter in the live server. ---
p = "apps/server/src/provider/Layers/ProviderAdapterRegistry.ts"
replace_once(p, 'import { AntigravityAdapter } from "../Services/AntigravityAdapter.ts";\n', 'import { AntigravityAdapter } from "../Services/AntigravityAdapter.ts";\nimport { CopilotAdapter } from "../Services/CopilotAdapter.ts";\n')
replace_once(p, '            yield* PiAdapter,\n          ];\n', '            yield* PiAdapter,\n            yield* CopilotAdapter,\n          ];\n')

p = "apps/server/src/provider/runtimeLayer.ts"
replace_once(p, 'import { makePiAdapterLive } from "./Layers/PiAdapter";\n', 'import { makePiAdapterLive } from "./Layers/PiAdapter";\nimport { makeCopilotAdapterLive } from "./Layers/CopilotAdapter";\n')
replace_once(
    p,
    '''    const piAdapterLayer = makePiAdapterLive(\n      nativeEventLogger ? { nativeEventLogger } : undefined,\n    ).pipe(Layer.provide(agentGatewayCredentialsLayer));\n''',
    '''    const piAdapterLayer = makePiAdapterLive(\n      nativeEventLogger ? { nativeEventLogger } : undefined,\n    ).pipe(Layer.provide(agentGatewayCredentialsLayer));\n    const copilotAdapterLayer = makeCopilotAdapterLive();\n''',
)
replace_once(p, '      Layer.provide(piAdapterLayer),\n', '      Layer.provide(piAdapterLayer),\n      Layer.provide(copilotAdapterLayer),\n')

# Basic empty mention/target semantics for a runtime-discovered model provider.
p = "apps/server/src/agentGateway/targetResolver.ts"
replace_once(
    p,
    '''  pi: {\n    primaryOptionKey: "model",\n    options: {},\n  },\n} as const satisfies Record<ProviderKind, ProviderTargetOptionConfig>;\n''',
    '''  pi: {\n    primaryOptionKey: "model",\n    options: {},\n  },\n  copilot: {\n    primaryOptionKey: "model",\n    options: {},\n  },\n} as const satisfies Record<ProviderKind, ProviderTargetOptionConfig>;\n''',
)

# Health registry: Copilot uses the shared ACP environment and a simple version probe.
p = "apps/server/src/provider/Layers/ProviderHealth.ts"
replace_once(p, 'const PI_PROVIDER = "pi" as const;\n', 'const PI_PROVIDER = "pi" as const;\nconst COPILOT_PROVIDER = "copilot" as const;\n')
replace_once(p, '  PI_PROVIDER,\n] as const satisfies', '  PI_PROVIDER,\n  COPILOT_PROVIDER,\n] as const satisfies')
replace_once(
    p,
    'const providerChildKind = (provider: ProviderKind): ProviderChildKind =>\n  provider === CLAUDE_AGENT_PROVIDER ? "claude" : provider;\n',
    'const providerChildKind = (provider: ProviderKind): ProviderChildKind =>\n  provider === CLAUDE_AGENT_PROVIDER ? "claude" : provider === COPILOT_PROVIDER ? "acp" : provider;\n',
)
