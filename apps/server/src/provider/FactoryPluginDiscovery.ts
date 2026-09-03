// FILE: FactoryPluginDiscovery.ts
// Purpose: Reads Factory's local plugin marketplaces into Synara's provider discovery contracts.
// Layer: Provider filesystem discovery
// Exports: listFactoryPlugins and readFactoryPlugin.

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type {
  ProviderListPluginsResult,
  ProviderPluginDescriptor,
  ProviderPluginMarketplaceDescriptor,
  ProviderPluginMarketplaceLoadError,
  ProviderReadPluginResult,
} from "@synara/contracts";

import { collectSkillsFromRoots } from "./skillsCatalog.ts";

interface FactoryMarketplaceRegistration {
  readonly installLocation?: unknown;
}

interface FactoryMarketplacePlugin {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly source?: unknown;
  readonly category?: unknown;
}

interface FactoryMarketplaceManifest {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly owner?: { readonly name?: unknown };
  readonly plugins?: ReadonlyArray<FactoryMarketplacePlugin>;
}

interface FactoryPluginManifest {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly author?: { readonly name?: unknown };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function factoryEnabledPlugins(
  factoryDir: string,
  cwd?: string,
): Promise<ReadonlyMap<string, boolean>> {
  const enabled = new Map<string, boolean>();
  const featureFlags = await readJsonRecord(
    nodePath.join(factoryDir, "cache", "feature-flags.json"),
  );
  const featureConfigs = recordValue(featureFlags?.configs);
  const cliDefaults = recordValue(featureConfigs?.cli_default_settings);
  const sources = [
    cliDefaults?.enabledPlugins,
    (await readJsonRecord(nodePath.join(factoryDir, "settings.json")))?.enabledPlugins,
    (await readJsonRecord(nodePath.join(factoryDir, "settings.local.json")))?.enabledPlugins,
    ...(cwd
      ? [
          (await readJsonRecord(nodePath.join(cwd, ".factory", "settings.json")))?.enabledPlugins,
          (await readJsonRecord(nodePath.join(cwd, ".factory", "settings.local.json")))
            ?.enabledPlugins,
        ]
      : []),
  ];
  for (const source of sources) {
    if (source === null || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [id, value] of Object.entries(source)) {
      if (typeof value === "boolean") enabled.set(id, value);
    }
  }
  return enabled;
}

async function marketplaceRegistrations(
  factoryDir: string,
): Promise<ReadonlyArray<{ readonly name: string; readonly path: string }>> {
  const known = await readJsonRecord(
    nodePath.join(factoryDir, "plugins", "known_marketplaces.json"),
  );
  if (!known) return [];
  return Object.entries(known).flatMap(([name, raw]) => {
    const path = stringValue((raw as FactoryMarketplaceRegistration | null)?.installLocation);
    return path ? [{ name, path: nodePath.resolve(factoryDir, path) }] : [];
  });
}

async function readMarketplace(path: string): Promise<FactoryMarketplaceManifest | null> {
  return (await readJsonRecord(
    nodePath.join(path, ".factory-plugin", "marketplace.json"),
  )) as FactoryMarketplaceManifest | null;
}

async function readPluginManifest(path: string): Promise<FactoryPluginManifest | null> {
  return (await readJsonRecord(
    nodePath.join(path, ".factory-plugin", "plugin.json"),
  )) as FactoryPluginManifest | null;
}

function resolvePluginPath(marketplacePath: string, source: string): string | null {
  const resolvedMarketplace = nodePath.resolve(marketplacePath);
  const resolvedPlugin = nodePath.resolve(resolvedMarketplace, source);
  const relative = nodePath.relative(resolvedMarketplace, resolvedPlugin);
  return relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${nodePath.sep}`) ||
    nodePath.isAbsolute(relative)
    ? null
    : resolvedPlugin;
}

async function pluginDescriptor(input: {
  readonly marketplaceName: string;
  readonly marketplacePath: string;
  readonly entry: FactoryMarketplacePlugin;
  readonly enabledPlugins: ReadonlyMap<string, boolean>;
}): Promise<ProviderPluginDescriptor | null> {
  const name = stringValue(input.entry.name);
  const source = stringValue(input.entry.source);
  if (!name || !source) return null;
  const path = resolvePluginPath(input.marketplacePath, source);
  if (!path) return null;
  const manifest = await readPluginManifest(path);
  const id = `${name}@${input.marketplaceName}`;
  const installed = input.enabledPlugins.has(id);
  const description = stringValue(manifest?.description ?? input.entry.description);
  const developerName = stringValue(manifest?.author?.name);
  const category = stringValue(input.entry.category);
  return {
    id,
    name,
    source: { type: "local", path },
    installed,
    enabled: input.enabledPlugins.get(id) === true,
    installPolicy: installed ? "INSTALLED_BY_DEFAULT" : "AVAILABLE",
    authPolicy: "ON_USE",
    interface: {
      displayName: stringValue(manifest?.name) ?? name,
      ...(description ? { shortDescription: description } : {}),
      ...(developerName ? { developerName } : {}),
      ...(category ? { category } : {}),
    },
  };
}

// Lists locally registered Factory marketplaces without mutating or refreshing them.
export async function listFactoryPlugins(
  homeDir: string,
  cwd?: string,
): Promise<ProviderListPluginsResult> {
  const factoryDir = nodePath.join(homeDir, ".factory");
  const registrations = await marketplaceRegistrations(factoryDir);
  const enabledPlugins = await factoryEnabledPlugins(factoryDir, cwd);
  const marketplaceLoadErrors: ProviderPluginMarketplaceLoadError[] = [];
  const marketplaces: ProviderPluginMarketplaceDescriptor[] = [];
  for (const registration of registrations) {
    const manifest = await readMarketplace(registration.path);
    if (!manifest) {
      marketplaceLoadErrors.push({
        marketplacePath: registration.path,
        message: "Factory marketplace manifest is missing or invalid.",
      });
      continue;
    }
    const plugins = (
      await Promise.all(
        (manifest.plugins ?? []).map((entry) =>
          pluginDescriptor({
            marketplaceName: registration.name,
            marketplacePath: registration.path,
            entry,
            enabledPlugins,
          }),
        ),
      )
    ).filter((plugin): plugin is ProviderPluginDescriptor => plugin !== null);
    marketplaces.push({
      name: registration.name,
      path: registration.path,
      interface: {
        displayName: stringValue(manifest.name) ?? registration.name,
      },
      plugins,
    });
  }
  return {
    marketplaces,
    marketplaceLoadErrors,
    remoteSyncError: null,
    featuredPluginIds: [],
    source: "factory-local-marketplaces",
    cached: false,
  };
}

// Reads one marketplace plugin plus its bundled skills for the plugin detail panel.
export async function readFactoryPlugin(input: {
  readonly homeDir: string;
  readonly marketplacePath: string;
  readonly pluginName: string;
  readonly cwd?: string;
}): Promise<ProviderReadPluginResult | null> {
  const factoryDir = nodePath.join(input.homeDir, ".factory");
  const registration = (await marketplaceRegistrations(factoryDir)).find(
    (candidate) => candidate.path === nodePath.resolve(input.marketplacePath),
  );
  if (!registration) return null;
  const marketplace = await readMarketplace(registration.path);
  const entry = marketplace?.plugins?.find(
    (plugin) => stringValue(plugin.name) === input.pluginName,
  );
  const marketplaceName = registration.name;
  const source = stringValue(entry?.source);
  if (!entry || !source) return null;
  const path = resolvePluginPath(registration.path, source);
  if (!path) return null;
  const enabledPlugins = await factoryEnabledPlugins(factoryDir, input.cwd);
  const summary = await pluginDescriptor({
    marketplaceName: registration.name,
    marketplacePath: registration.path,
    entry,
    enabledPlugins,
  });
  if (!summary) return null;
  const manifest = await readPluginManifest(path);
  const skills = await collectSkillsFromRoots([
    { path: nodePath.join(path, "skills"), scope: `factory-plugin:${input.pluginName}` },
  ]);
  const description = stringValue(manifest?.description ?? entry.description);
  return {
    plugin: {
      marketplaceName,
      marketplacePath: registration.path,
      summary,
      ...(description ? { description } : {}),
      skills,
      apps: [],
      mcpServers: [],
    },
    source: "factory-local-marketplace",
    cached: false,
  };
}
