// FILE: claudePluginSkills.ts
// Purpose: Resolve active Claude Code plugin skill roots from Claude's installed
//          plugin registry without scanning orphaned cache versions.
// Layer: Server provider discovery helper
// Exports: discoverClaudePluginSkillRoots

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

export interface ClaudePluginSkillRoot {
  readonly path: string;
  readonly scope: "claude";
  readonly namespace: string;
  readonly followSymlinks: false;
}

interface ClaudePluginInstall {
  readonly installPath: string;
  readonly scope: "user" | "project" | "local" | "managed";
  readonly projectPath?: string;
}

interface ClaudeInstalledPlugin {
  readonly pluginId: string;
  readonly install: ClaudePluginInstall;
}

const CLAUDE_SCOPE_PRECEDENCE = {
  managed: 0,
  local: 1,
  project: 2,
  user: 3,
} as const satisfies Record<ClaudePluginInstall["scope"], number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInstall(value: unknown): ClaudePluginInstall | null {
  if (!isRecord(value)) {
    return null;
  }
  const installPath = value.installPath;
  const scope = value.scope;
  if (
    typeof installPath !== "string" ||
    installPath.trim().length === 0 ||
    !nodePath.isAbsolute(installPath) ||
    (scope !== "user" && scope !== "project" && scope !== "local" && scope !== "managed")
  ) {
    return null;
  }
  const projectPath = value.projectPath;
  return {
    installPath,
    scope,
    ...(typeof projectPath === "string" && projectPath.trim().length > 0 ? { projectPath } : {}),
  };
}

function parseInstalledPlugins(value: unknown): ClaudeInstalledPlugin[] {
  if (!isRecord(value) || !isRecord(value.plugins)) {
    return [];
  }
  return Object.entries(value.plugins)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([rawPluginId, rawInstalls]) => {
      const pluginId = rawPluginId.trim();
      if (pluginId.length === 0 || !pluginId.includes("@") || !Array.isArray(rawInstalls)) {
        return [];
      }
      return rawInstalls
        .map(parseInstall)
        .filter((install): install is ClaudePluginInstall => install !== null)
        .toSorted(
          (left, right) =>
            CLAUDE_SCOPE_PRECEDENCE[left.scope] - CLAUDE_SCOPE_PRECEDENCE[right.scope] ||
            [left.projectPath ?? "", left.installPath]
              .join("\u0000")
              .localeCompare([right.projectPath ?? "", right.installPath].join("\u0000")),
        )
        .map((install) => ({ pluginId, install }));
    });
}

function namespaceForPlugin(pluginId: string): string | null {
  const separatorIndex = pluginId.indexOf("@");
  if (separatorIndex <= 0) {
    return null;
  }
  const namespace = pluginId.slice(0, separatorIndex).trim();
  return namespace.length > 0 ? namespace : null;
}

type PathContainmentApi = Pick<typeof nodePath, "isAbsolute" | "relative" | "sep">;

export function pathIsWithin(
  parentPath: string,
  childPath: string,
  pathApi: PathContainmentApi = nodePath,
): boolean {
  const relative = pathApi.relative(parentPath, childPath);
  return (
    relative === "" ||
    (!pathApi.isAbsolute(relative) && !relative.startsWith(`..${pathApi.sep}`) && relative !== "..")
  );
}

async function canonicalPath(path: string): Promise<string | null> {
  try {
    return await fs.realpath(path);
  } catch {
    return null;
  }
}

async function installAppliesToCwd(
  install: ClaudePluginInstall,
  cwd: string | null,
): Promise<boolean> {
  if (install.scope === "user" || install.scope === "managed") {
    return true;
  }
  if (!cwd || !install.projectPath || !nodePath.isAbsolute(install.projectPath)) {
    return false;
  }
  const [canonicalProjectPath, canonicalCwd] = await Promise.all([
    canonicalPath(install.projectPath),
    canonicalPath(cwd),
  ]);
  if (!canonicalProjectPath || !canonicalCwd) {
    return false;
  }
  return pathIsWithin(canonicalProjectPath, canonicalCwd);
}

/**
 * Claude keeps old plugin versions in its cache temporarily. The installed
 * registry is therefore the source of truth; only its current install paths are
 * considered, and those paths must resolve inside Claude's plugin cache.
 */
export async function discoverClaudePluginSkillRoots(input: {
  readonly homeDir: string;
  readonly cwd?: string | null;
}): Promise<ClaudePluginSkillRoot[]> {
  const claudePluginsDir = nodePath.join(input.homeDir, ".claude", "plugins");
  const [manifestRaw, canonicalCacheRoot] = await Promise.all([
    fs
      .readFile(nodePath.join(claudePluginsDir, "installed_plugins.json"), "utf8")
      .catch(() => null),
    canonicalPath(nodePath.join(claudePluginsDir, "cache")),
  ]);
  if (!manifestRaw || !canonicalCacheRoot) {
    return [];
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    return [];
  }

  const roots: ClaudePluginSkillRoot[] = [];
  const seen = new Set<string>();
  const selectedPluginIds = new Set<string>();
  const cwd = input.cwd?.trim() || null;
  for (const { pluginId, install } of parseInstalledPlugins(manifest)) {
    if (selectedPluginIds.has(pluginId)) {
      continue;
    }
    const namespace = namespaceForPlugin(pluginId);
    if (!namespace || !(await installAppliesToCwd(install, cwd))) {
      continue;
    }
    // Claude resolves one effective installation per plugin ID. Once the
    // highest-precedence applicable scope is selected, a lower-precedence copy
    // must not contribute additional skills even if the selected path is broken.
    selectedPluginIds.add(pluginId);
    const canonicalInstallPath = await canonicalPath(install.installPath);
    if (!canonicalInstallPath || !pathIsWithin(canonicalCacheRoot, canonicalInstallPath)) {
      continue;
    }
    const skillsPath = await canonicalPath(nodePath.join(canonicalInstallPath, "skills"));
    if (!skillsPath || !pathIsWithin(canonicalInstallPath, skillsPath)) {
      continue;
    }
    try {
      if (!(await fs.stat(skillsPath)).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    const key = `${pluginId}\u0000${canonicalInstallPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    roots.push({ path: skillsPath, scope: "claude", namespace, followSymlinks: false });
  }
  return roots;
}
