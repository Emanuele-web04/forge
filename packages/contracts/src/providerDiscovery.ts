// FILE: providerDiscovery.ts
// Purpose: Defines provider discovery request/response contracts shared across web and server.
// Layer: Shared contracts
// Exports: provider discovery schemas and inferred types used by the WS/native API.

import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderOptionDescriptor } from "./model";

const ProviderDiscoveryKind = Schema.Literals([
  "codex",
  "claudeAgent",
  "cursor",
  "antigravity",
  "grok",
  "deepseek",
  "droid",
  "kilo",
  "opencode",
  "pi",
]);

export const ProviderSkillInterface = Schema.Struct({
  displayName: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSkillInterface = typeof ProviderSkillInterface.Type;

export const ProviderSkillDescriptor = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  scope: Schema.optional(TrimmedNonEmptyString),
  interface: Schema.optional(ProviderSkillInterface),
  dependencies: Schema.optional(Schema.Unknown),
});
export type ProviderSkillDescriptor = typeof ProviderSkillDescriptor.Type;

export const ProviderSkillReference = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type ProviderSkillReference = typeof ProviderSkillReference.Type;

export const ProviderMentionReference = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type ProviderMentionReference = typeof ProviderMentionReference.Type;

export const ProviderComposerCapabilities = Schema.Struct({
  provider: ProviderDiscoveryKind,
  supportsSkillMentions: Schema.Boolean,
  supportsSkillDiscovery: Schema.Boolean,
  supportsNativeSlashCommandDiscovery: Schema.Boolean,
  supportsPluginMentions: Schema.Boolean,
  supportsPluginDiscovery: Schema.Boolean,
  supportsRuntimeModelList: Schema.Boolean,
  supportsThreadCompaction: Schema.optional(Schema.Boolean),
  supportsThreadImport: Schema.optional(Schema.Boolean),
});
export type ProviderComposerCapabilities = typeof ProviderComposerCapabilities.Type;

export const ProviderGetComposerCapabilitiesInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
});
export type ProviderGetComposerCapabilitiesInput = typeof ProviderGetComposerCapabilitiesInput.Type;

export const ProviderListSkillsInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  cwd: TrimmedNonEmptyString,
  threadId: Schema.optional(TrimmedNonEmptyString),
  agentDir: Schema.optional(TrimmedNonEmptyString),
  forceReload: Schema.optional(Schema.Boolean),
});
export type ProviderListSkillsInput = typeof ProviderListSkillsInput.Type;

export const ProviderListSkillsResult = Schema.Struct({
  skills: Schema.Array(ProviderSkillDescriptor),
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
});
export type ProviderListSkillsResult = typeof ProviderListSkillsResult.Type;

// Unified cross-provider skills catalog (Synara portable skills). Descriptors use
// `scope` to carry the origin label ("synara", "codex", "claude", "cursor", ...).
export const ProviderSkillsCatalogInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSkillsCatalogInput = typeof ProviderSkillsCatalogInput.Type;

export const ProviderSkillsCatalogResult = Schema.Struct({
  skills: Schema.Array(ProviderSkillDescriptor),
  synaraSkillsDir: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSkillsCatalogResult = typeof ProviderSkillsCatalogResult.Type;

export const ProviderNativeCommandDescriptor = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderNativeCommandDescriptor = typeof ProviderNativeCommandDescriptor.Type;

export const ProviderListCommandsInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  cwd: TrimmedNonEmptyString,
  threadId: Schema.optional(TrimmedNonEmptyString),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
  experimentalWebSockets: Schema.optional(Schema.Boolean),
  agentDir: Schema.optional(TrimmedNonEmptyString),
  forceReload: Schema.optional(Schema.Boolean),
});
export type ProviderListCommandsInput = typeof ProviderListCommandsInput.Type;

export const ProviderListCommandsResult = Schema.Struct({
  commands: Schema.Array(ProviderNativeCommandDescriptor),
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
});
export type ProviderListCommandsResult = typeof ProviderListCommandsResult.Type;

// Plugin discovery mirrors Codex app-server's marketplace + plugin summary surface.
export const ProviderPluginMarketplaceInterface = Schema.Struct({
  displayName: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderPluginMarketplaceInterface = typeof ProviderPluginMarketplaceInterface.Type;

export const ProviderPluginInstallPolicy = Schema.Literals([
  "NOT_AVAILABLE",
  "AVAILABLE",
  "INSTALLED_BY_DEFAULT",
]);
export type ProviderPluginInstallPolicy = typeof ProviderPluginInstallPolicy.Type;

export const ProviderPluginAuthPolicy = Schema.Literals(["ON_INSTALL", "ON_USE"]);
export type ProviderPluginAuthPolicy = typeof ProviderPluginAuthPolicy.Type;

export const ProviderPluginSource = Schema.Struct({
  type: Schema.Literal("local"),
  path: TrimmedNonEmptyString,
});
export type ProviderPluginSource = typeof ProviderPluginSource.Type;

export const ProviderPluginInterface = Schema.Struct({
  displayName: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
  longDescription: Schema.optional(TrimmedNonEmptyString),
  developerName: Schema.optional(TrimmedNonEmptyString),
  category: Schema.optional(TrimmedNonEmptyString),
  capabilities: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  websiteUrl: Schema.optional(TrimmedNonEmptyString),
  privacyPolicyUrl: Schema.optional(TrimmedNonEmptyString),
  termsOfServiceUrl: Schema.optional(TrimmedNonEmptyString),
  defaultPrompt: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  brandColor: Schema.optional(TrimmedNonEmptyString),
  composerIcon: Schema.optional(TrimmedNonEmptyString),
  logo: Schema.optional(TrimmedNonEmptyString),
  screenshots: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type ProviderPluginInterface = typeof ProviderPluginInterface.Type;

export const ProviderPluginDescriptor = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  source: ProviderPluginSource,
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  installPolicy: ProviderPluginInstallPolicy,
  authPolicy: ProviderPluginAuthPolicy,
  interface: Schema.optional(ProviderPluginInterface),
});
export type ProviderPluginDescriptor = typeof ProviderPluginDescriptor.Type;

export const ProviderPluginMarketplaceLoadError = Schema.Struct({
  marketplacePath: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type ProviderPluginMarketplaceLoadError = typeof ProviderPluginMarketplaceLoadError.Type;

export const ProviderPluginMarketplaceDescriptor = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  interface: Schema.optional(ProviderPluginMarketplaceInterface),
  plugins: Schema.Array(ProviderPluginDescriptor),
});
export type ProviderPluginMarketplaceDescriptor = typeof ProviderPluginMarketplaceDescriptor.Type;

export const ProviderPluginAppSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  installUrl: Schema.optional(TrimmedNonEmptyString),
  needsAuth: Schema.Boolean,
});
export type ProviderPluginAppSummary = typeof ProviderPluginAppSummary.Type;

export const ProviderListPluginsInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  cwd: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(TrimmedNonEmptyString),
  forceRemoteSync: Schema.optional(Schema.Boolean),
  forceReload: Schema.optional(Schema.Boolean),
});
export type ProviderListPluginsInput = typeof ProviderListPluginsInput.Type;

export const ProviderListPluginsResult = Schema.Struct({
  marketplaces: Schema.Array(ProviderPluginMarketplaceDescriptor),
  marketplaceLoadErrors: Schema.Array(ProviderPluginMarketplaceLoadError),
  remoteSyncError: Schema.NullOr(TrimmedNonEmptyString),
  featuredPluginIds: Schema.Array(TrimmedNonEmptyString),
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
});
export type ProviderListPluginsResult = typeof ProviderListPluginsResult.Type;

export const ProviderReadPluginInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  marketplacePath: TrimmedNonEmptyString,
  pluginName: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderReadPluginInput = typeof ProviderReadPluginInput.Type;

export const ProviderPluginDetail = Schema.Struct({
  marketplaceName: TrimmedNonEmptyString,
  marketplacePath: TrimmedNonEmptyString,
  summary: ProviderPluginDescriptor,
  description: Schema.optional(TrimmedNonEmptyString),
  skills: Schema.Array(ProviderSkillDescriptor),
  apps: Schema.Array(ProviderPluginAppSummary),
  mcpServers: Schema.Array(TrimmedNonEmptyString),
});
export type ProviderPluginDetail = typeof ProviderPluginDetail.Type;

export const ProviderReadPluginResult = Schema.Struct({
  plugin: ProviderPluginDetail,
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
});
export type ProviderReadPluginResult = typeof ProviderReadPluginResult.Type;

export const ProviderListModelsInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  apiEndpoint: Schema.optional(TrimmedNonEmptyString),
  agentDir: Schema.optional(TrimmedNonEmptyString),
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderListModelsInput = typeof ProviderListModelsInput.Type;

export const ProviderReasoningEffortDescriptor = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderReasoningEffortDescriptor = typeof ProviderReasoningEffortDescriptor.Type;

export const ProviderContextWindowDescriptor = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Literal(true)),
});
export type ProviderContextWindowDescriptor = typeof ProviderContextWindowDescriptor.Type;

export const ProviderModelDescriptor = Schema.Struct({
  slug: TrimmedNonEmptyString,
  resolvedModel: Schema.optional(TrimmedNonEmptyString),
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  upstreamProviderId: Schema.optional(TrimmedNonEmptyString),
  upstreamProviderName: Schema.optional(TrimmedNonEmptyString),
  optionDescriptors: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
  // Codex model/list results are normalized here so the web app can consume both
  // the legacy string array and Remodex-style reasoning objects uniformly.
  supportedReasoningEfforts: Schema.optional(Schema.Array(ProviderReasoningEffortDescriptor)),
  defaultReasoningEffort: Schema.optional(TrimmedNonEmptyString),
  supportsFastMode: Schema.optional(Schema.Boolean),
  supportsThinkingToggle: Schema.optional(Schema.Boolean),
  supportsAutoMode: Schema.optional(Schema.Boolean),
  contextWindowOptions: Schema.optional(Schema.Array(ProviderContextWindowDescriptor)),
  defaultContextWindow: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderModelDescriptor = typeof ProviderModelDescriptor.Type;

export const ProviderListModelsResult = Schema.Struct({
  models: Schema.Array(ProviderModelDescriptor),
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
});
export type ProviderListModelsResult = typeof ProviderListModelsResult.Type;

export const ProviderListAgentsInput = Schema.Struct({
  provider: ProviderDiscoveryKind,
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderListAgentsInput = typeof ProviderListAgentsInput.Type;

export const ProviderAgentDescriptor = Schema.Struct({
  name: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAgentDescriptor = typeof ProviderAgentDescriptor.Type;

export const ProviderListAgentsResult = Schema.Struct({
  agents: Schema.Array(ProviderAgentDescriptor),
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
});
export type ProviderListAgentsResult = typeof ProviderListAgentsResult.Type;
