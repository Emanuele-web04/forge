// FILE: codexProcessEnv.ts
// Purpose: Builds the exact environment used when Synara launches Codex subprocesses.
// Layer: Server runtime utility
// Exports: Codex process env builder and browser-plugin overlay helpers.
// Depends on: Codex home path helpers, shared Codex config parsing, login-shell env reader.

import * as fs from "node:fs/promises";
import path from "node:path";

import { readActiveCodexProviderEnvKey } from "@synara/shared/codexConfig";
import {
  readEnvironmentFromLoginShell,
  resolveLoginShell,
  type ShellEnvironmentReader,
} from "@synara/shared/shell";

import { resolveBaseCodexHomePath, resolveSynaraCodexHomeOverlayPath } from "./codexHomePaths.ts";
import {
  buildProviderChildEnvironment,
  registerProviderCredentialKey,
} from "./providerChildEnvironment.ts";

const CODEX_PROCESS_SHELL_ENV_NAMES = ["PATH", "SSH_AUTH_SOCK"] as const;
const CODEX_OVERLAY_SHARED_STATE_FILES = new Set(["auth.json"]);
const SYNARA_CONFIG_SUPPRESSIONS_FILE = "synara-config-suppressions-v1.json";
const SYNARA_MANAGED_MCP_TABLE_HEADER = "[mcp_servers.synara]";
export const SYNARA_COMPETING_BROWSER_PLUGIN_SECTION_HEADERS = [
  '[plugins."browser@openai-bundled"]',
  '[plugins."chrome@openai-bundled"]',
  '[plugins."computer-use@openai-bundled"]',
] as const;
const MAX_CONFIG_SUPPRESSION_SECTIONS = 32;
const MAX_CONFIG_SUPPRESSION_HEADER_LENGTH = 256;
const codexOverlayPreparationQueues = new Map<string, Promise<void>>();
// Retired local browser integrations used a stable six-character namespace.
// Match the structural conflict without retaining any previous product name.
const CONFLICTING_LOCAL_BROWSER_PLUGIN_SECTION_PATTERN =
  /^\[plugins\."[a-z0-9][a-z0-9-]{5}-browser@local"\]$/;

interface CodexOverlayEntryLinker {
  readonly symlink: typeof fs.symlink;
  readonly copyFile: typeof fs.copyFile;
}

function isSafePluginSectionHeader(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_CONFIG_SUPPRESSION_HEADER_LENGTH &&
    /^\[plugins\."[^"\r\n]+"\]$/.test(value)
  );
}

export async function readSynaraConfigSuppressions(markerPath: string): Promise<readonly string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return [];
    const marker = parsed as { version?: unknown; sectionHeaders?: unknown };
    if (marker.version !== 1 || !Array.isArray(marker.sectionHeaders)) return [];
    if (marker.sectionHeaders.length > MAX_CONFIG_SUPPRESSION_SECTIONS) return [];
    return [...new Set(marker.sectionHeaders.filter(isSafePluginSectionHeader))];
  } catch {
    return [];
  }
}

function findConflictingLocalBrowserPluginSections(config: string): readonly string[] {
  return [
    ...new Set(
      config
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => CONFLICTING_LOCAL_BROWSER_PLUGIN_SECTION_PATTERN.test(line)),
    ),
  ];
}

export function disableCodexConfigSections(
  config: string,
  sectionHeaders: readonly string[],
  appendMissing = false,
): string {
  const targetsByName = new Map<string, string>();
  for (const header of sectionHeaders) {
    if (!isSafePluginSectionHeader(header)) continue;
    const tableName = normalizeTomlTableHeaderName(header);
    if (tableName !== undefined && !targetsByName.has(tableName)) {
      targetsByName.set(tableName, header);
    }
  }
  const lines = config.split(/\r?\n/);
  const output: string[] = [];
  let inTargetSection = false;
  const seenTargetSections = new Set<string>();
  let targetSectionHasEnabled = false;

  const closeTargetSection = () => {
    if (inTargetSection && !targetSectionHasEnabled) {
      output.push("enabled = false");
    }
  };

  for (const line of lines) {
    const tableName = normalizeTomlTableHeaderName(line);
    if (tableName !== undefined) {
      closeTargetSection();
      inTargetSection = targetsByName.has(tableName);
      if (inTargetSection) seenTargetSections.add(tableName);
      targetSectionHasEnabled = false;
      output.push(line);
      continue;
    }

    if (inTargetSection && /^\s*enabled\s*=/.test(line)) {
      output.push("enabled = false");
      targetSectionHasEnabled = true;
      continue;
    }

    output.push(line);
  }

  closeTargetSection();

  if (appendMissing) {
    for (const [tableName, header] of targetsByName) {
      if (seenTargetSections.has(tableName)) continue;
      if (output.length > 0 && output.at(-1)?.trim()) {
        output.push("");
      }
      output.push(header, "enabled = false");
    }
  }

  return output.join("\n");
}

async function writeSynaraConfigSuppressions(
  markerPath: string,
  sectionHeaders: readonly string[],
): Promise<void> {
  const normalized = [...new Set(sectionHeaders.filter(isSafePluginSectionHeader))].slice(
    0,
    MAX_CONFIG_SUPPRESSION_SECTIONS,
  );
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify({ version: 1, sectionHeaders: normalized }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.rename(temporaryPath, markerPath);
}

export async function linkOrCopyCodexOverlayEntry(
  input: {
    readonly entryName: string;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly type: "dir" | "file";
  },
  linker: CodexOverlayEntryLinker = {
    symlink: fs.symlink,
    copyFile: fs.copyFile,
  },
): Promise<void> {
  try {
    await linker.symlink(input.sourcePath, input.targetPath, input.type);
  } catch (error: unknown) {
    if (input.type === "file" && CODEX_OVERLAY_SHARED_STATE_FILES.has(input.entryName)) {
      await linker.copyFile(input.sourcePath, input.targetPath);
      return;
    }
    throw error;
  }
}

export function prioritizeCodexOverlayEntries(entries: readonly string[]): string[] {
  const sharedStateEntries: string[] = [];
  const otherEntries: string[] = [];

  for (const entry of entries) {
    if (CODEX_OVERLAY_SHARED_STATE_FILES.has(entry)) {
      sharedStateEntries.push(entry);
    } else {
      otherEntries.push(entry);
    }
  }

  return [...sharedStateEntries, ...otherEntries];
}

async function ensureCodexOverlaySymlink(input: {
  readonly entryName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly type: "dir" | "file";
}): Promise<void> {
  let targetStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    targetStat = await fs.lstat(input.targetPath);
  } catch {
    targetStat = undefined;
  }

  if (targetStat) {
    if (targetStat.isSymbolicLink() && (await fs.readlink(input.targetPath)) === input.sourcePath) {
      return;
    }

    if (
      targetStat.isSymbolicLink() ||
      /^.+\.sqlite(?:-(?:wal|shm|journal))?$/.test(input.entryName) ||
      CODEX_OVERLAY_SHARED_STATE_FILES.has(input.entryName)
    ) {
      // SQLite files must stay generation-matched, and auth must mirror the
      // user's real Codex home so external `codex login` changes are visible.
      await fs.rm(input.targetPath, { recursive: true, force: true });
    } else {
      return;
    }
  }

  await linkOrCopyCodexOverlayEntry(input);
}

export function appendCodexConfigSection(config: string, section: string): string {
  const trimmedSection = section.trim();
  if (!trimmedSection) {
    return config;
  }
  if (config.includes(trimmedSection.split("\n")[0] ?? trimmedSection)) {
    return config;
  }
  const base = config.trimEnd();
  return base.length > 0 ? `${base}\n\n${trimmedSection}\n` : `${trimmedSection}\n`;
}

export const SYNARA_MANAGED_CODEX_CONFIG_BEGIN = "# >>> synara managed config >>>";
export const SYNARA_MANAGED_CODEX_CONFIG_END = "# <<< synara managed config <<<";

export function extractManagedCodexConfigSection(config: string): string | undefined {
  const begin = config.indexOf(SYNARA_MANAGED_CODEX_CONFIG_BEGIN);
  if (begin === -1) {
    return undefined;
  }
  const contentStart = begin + SYNARA_MANAGED_CODEX_CONFIG_BEGIN.length;
  const end = config.indexOf(SYNARA_MANAGED_CODEX_CONFIG_END, contentStart);
  if (end === -1) {
    return undefined;
  }
  const content = config.slice(contentStart, end).trim();
  return content.length > 0 ? content : undefined;
}

function normalizeTomlTableHeaderName(line: string): string | undefined {
  const match = /^\s*\[\s*(.*?)\s*\]\s*(?:#.*)?$/.exec(line);
  if (!match) {
    return undefined;
  }
  const tableName = match[1];
  if (tableName === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  let index = 0;
  const skipWhitespace = () => {
    while (index < tableName.length && /[\t ]/.test(tableName[index]!)) index += 1;
  };
  const parseBasicQuotedKey = (): string | undefined => {
    index += 1;
    let value = "";
    while (index < tableName.length) {
      const character = tableName[index++]!;
      if (character === '"') return value;
      if (character !== "\\") {
        if (character.charCodeAt(0) < 0x20) return undefined;
        value += character;
        continue;
      }
      const escape = tableName[index++];
      const simpleEscapes: Readonly<Record<string, string>> = {
        b: "\b",
        t: "\t",
        n: "\n",
        f: "\f",
        r: "\r",
        '"': '"',
        "\\": "\\",
      };
      if (escape !== undefined && simpleEscapes[escape] !== undefined) {
        value += simpleEscapes[escape];
        continue;
      }
      if (escape !== "u" && escape !== "U") return undefined;
      const length = escape === "u" ? 4 : 8;
      const hexadecimal = tableName.slice(index, index + length);
      if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hexadecimal)) return undefined;
      const codePoint = Number.parseInt(hexadecimal, 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
      value += String.fromCodePoint(codePoint);
      index += length;
    }
    return undefined;
  };
  const parseLiteralQuotedKey = (): string | undefined => {
    index += 1;
    const end = tableName.indexOf("'", index);
    if (end === -1) return undefined;
    const value = tableName.slice(index, end);
    index = end + 1;
    return value;
  };

  while (index < tableName.length) {
    skipWhitespace();
    let part: string | undefined;
    if (tableName[index] === '"') {
      part = parseBasicQuotedKey();
    } else if (tableName[index] === "'") {
      part = parseLiteralQuotedKey();
    } else {
      const start = index;
      while (index < tableName.length && /[A-Za-z0-9_-]/.test(tableName[index]!)) index += 1;
      part = index > start ? tableName.slice(start, index) : undefined;
    }
    if (part === undefined) return undefined;
    parts.push(part);
    skipWhitespace();
    if (index === tableName.length) break;
    if (tableName[index] !== ".") return undefined;
    index += 1;
    skipWhitespace();
    if (index === tableName.length) return undefined;
  }
  return parts.length > 0 ? JSON.stringify(parts) : undefined;
}

interface TomlTableHeaderLocation {
  readonly index: number;
  readonly end: number;
}

function findTomlTableHeader(config: string, header: string): TomlTableHeaderLocation | undefined {
  const target = normalizeTomlTableHeaderName(header);
  if (!target) {
    return undefined;
  }
  let offset = 0;
  for (const rawLine of config.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (normalizeTomlTableHeaderName(line) === target) {
      return { index: offset, end: offset + line.length };
    }
    offset += rawLine.length + 1;
  }
  return undefined;
}

function findNextTomlTableHeaderIndex(config: string, start: number): number {
  const tail = config.slice(start);
  let offset = 0;
  for (const rawLine of tail.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (normalizeTomlTableHeaderName(line) !== undefined) {
      return start + offset;
    }
    offset += rawLine.length + 1;
  }
  return config.length;
}

export function configHasTomlTableHeader(config: string, header: string): boolean {
  return findTomlTableHeader(config, header) !== undefined;
}

function splitTomlTables(snippet: string): string[] {
  const tables: string[] = [];
  let current: string[] = [];
  for (const line of snippet.split("\n")) {
    if (/^\s*\[/.test(line) && current.length > 0) {
      tables.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    tables.push(current.join("\n").trim());
  }
  return tables.filter((table) => table.length > 0);
}

function findTomlTableHeaderInNamespace(
  config: string,
  namespaceHeader: string,
): TomlTableHeaderLocation | undefined {
  const namespace = normalizeTomlTableHeaderName(namespaceHeader);
  if (!namespace) {
    return undefined;
  }
  const descendantPrefix = `${namespace.slice(0, -1)},`;
  let offset = 0;
  for (const rawLine of config.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const table = normalizeTomlTableHeaderName(line);
    if (table === namespace || table?.startsWith(descendantPrefix)) {
      return { index: offset, end: offset + line.length };
    }
    offset += rawLine.length + 1;
  }
  return undefined;
}

function removeTomlTableNamespace(config: string, namespaceHeader: string): string {
  let result = config;
  while (true) {
    const match = findTomlTableHeaderInNamespace(result, namespaceHeader);
    if (!match) {
      return result;
    }
    const tableEnd = findNextTomlTableHeaderIndex(result, match.end);
    result = `${result.slice(0, match.index)}${result.slice(tableEnd)}`;
  }
}

function maskTomlComments(input: string): string {
  let result = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let inComment = false;

  for (const character of input) {
    if (inComment) {
      if (character === "\n" || character === "\r") {
        inComment = false;
        result += character;
      } else {
        result += " ";
      }
      continue;
    }

    if (quote) {
      result += character;
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      result += character;
    } else if (character === "#") {
      inComment = true;
      result += " ";
    } else {
      result += character;
    }
  }

  return result;
}

function findTomlArrayEnd(input: string, openBracketIndex: number): number | undefined {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let depth = 0;

  for (let index = openBracketIndex; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return undefined;
}

function mergeTomlStringArrayValues(
  config: string,
  tableHeader: string,
  key: string,
  values: readonly string[],
): string {
  const additions = [...new Set(values.filter(Boolean))];
  if (additions.length === 0) {
    return config;
  }
  const headerMatch = findTomlTableHeader(config, tableHeader);
  if (!headerMatch) {
    return config;
  }
  const tableStart = headerMatch.end;
  const tableEnd = findNextTomlTableHeaderIndex(config, tableStart);
  const tableBody = config.slice(tableStart, tableEnd);
  const activeTableBody = maskTomlComments(tableBody);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const arrayPattern = new RegExp(`(^[\\t ]*${escapedKey}[\\t ]*=[\\t ]*\\[)`, "m");
  const arrayMatch = arrayPattern.exec(activeTableBody);

  if (arrayMatch) {
    const openBracketIndex = arrayMatch.index + arrayMatch[0].lastIndexOf("[");
    const closeBracketIndex = findTomlArrayEnd(activeTableBody, openBracketIndex);
    if (closeBracketIndex === undefined) {
      return config;
    }
    const activeArray = activeTableBody.slice(openBracketIndex + 1, closeBracketIndex);
    const missing = additions.filter((value) => {
      const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(`(["'])${escapedValue}\\1`).test(activeArray);
    });
    if (missing.length === 0) {
      return config;
    }

    const insertAt = tableStart + openBracketIndex + 1;
    const separator = activeArray.trim().length > 0 ? ", " : "";
    return `${config.slice(0, insertAt)}${missing.map((value) => JSON.stringify(value)).join(", ")}${separator}${config.slice(insertAt)}`;
  }

  return `${config.slice(0, tableStart)}\n${key} = [${additions.map((value) => JSON.stringify(value)).join(", ")}]${config.slice(tableStart)}`;
}

export function mergeShellEnvPolicyExclude(config: string, envVarName: string): string {
  return mergeTomlStringArrayValues(
    config,
    "[shell_environment_policy]",
    "exclude",
    envVarName ? [envVarName] : [],
  );
}

function appendManagedCodexConfigSection(config: string, section: string): string {
  let overlayConfig = config;
  const managedMcpTableName = normalizeTomlTableHeaderName(SYNARA_MANAGED_MCP_TABLE_HEADER);
  const tables: string[] = [];

  for (const table of splitTomlTables(section.trim())) {
    const header = table.split("\n")[0]?.trim();
    if (header === undefined) {
      tables.push(table);
      continue;
    }
    if (normalizeTomlTableHeaderName(header) === managedMcpTableName) {
      // The session-scoped gateway entry is authoritative inside Synara's
      // overlay. The user's source config remains untouched.
      overlayConfig = removeTomlTableNamespace(overlayConfig, SYNARA_MANAGED_MCP_TABLE_HEADER);
      tables.push(table);
      continue;
    }
    if (!configHasTomlTableHeader(overlayConfig, header)) {
      tables.push(table);
    }
  }

  if (tables.length === 0) {
    return overlayConfig;
  }
  return appendCodexConfigSection(
    overlayConfig,
    `${SYNARA_MANAGED_CODEX_CONFIG_BEGIN}\n${tables.join("\n\n")}\n${SYNARA_MANAGED_CODEX_CONFIG_END}`,
  );
}

async function serializeCodexOverlayPreparation<A>(
  overlayHomePath: string,
  prepare: () => Promise<A>,
): Promise<A> {
  const previous = codexOverlayPreparationQueues.get(overlayHomePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(prepare);
  const queued = current.then(
    () => undefined,
    () => undefined,
  );
  codexOverlayPreparationQueues.set(overlayHomePath, queued);
  try {
    return await current;
  } finally {
    if (codexOverlayPreparationQueues.get(overlayHomePath) === queued) {
      codexOverlayPreparationQueues.delete(overlayHomePath);
    }
  }
}

async function prepareSynaraCodexHomeOverlayUnlocked(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly appendConfigToml?: string;
}): Promise<string | undefined> {
  const sourceHomePath = resolveBaseCodexHomePath(input.env, input.homePath);
  const overlayHomePath = resolveSynaraCodexHomeOverlayPath(input.env, sourceHomePath);
  if (path.resolve(sourceHomePath) === path.resolve(overlayHomePath)) {
    return undefined;
  }

  await fs.mkdir(overlayHomePath, { recursive: true });

  try {
    // Auth must get a best-effort link/copy before optional entries whose
    // symlinks may fail on restricted Windows installs.
    for (const entry of prioritizeCodexOverlayEntries(await fs.readdir(sourceHomePath))) {
      if (entry === "config.toml") {
        continue;
      }
      const sourcePath = path.join(sourceHomePath, entry);
      const targetPath = path.join(overlayHomePath, entry);
      const stat = await fs.lstat(sourcePath);
      await ensureCodexOverlaySymlink({
        entryName: entry,
        sourcePath,
        targetPath,
        type: stat.isDirectory() ? "dir" : "file",
      });
    }
  } catch {
    // If the source home is partially missing, Codex can still start with the
    // overlay config and create any required state lazily.
  }

  const sourceConfigPath = path.join(sourceHomePath, "config.toml");
  const sourceConfig = await fs.readFile(sourceConfigPath, "utf8").catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw cause;
  });
  const suppressionMarkerPath = path.join(overlayHomePath, SYNARA_CONFIG_SUPPRESSIONS_FILE);
  const suppressedSections = [
    ...new Set([
      ...SYNARA_COMPETING_BROWSER_PLUGIN_SECTION_HEADERS,
      ...findConflictingLocalBrowserPluginSections(sourceConfig),
      ...(await readSynaraConfigSuppressions(suppressionMarkerPath)),
    ]),
  ].slice(0, MAX_CONFIG_SUPPRESSION_SECTIONS);
  const overlayConfigPath = path.join(overlayHomePath, "config.toml");
  let overlayConfig = disableCodexConfigSections(sourceConfig, suppressedSections, true);
  const managedSection =
    input.appendConfigToml ??
    (await fs
      .readFile(overlayConfigPath, "utf8")
      .then(extractManagedCodexConfigSection)
      .catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw cause;
      }));
  if (managedSection) {
    overlayConfig = appendManagedCodexConfigSection(overlayConfig, managedSection);
    const tokenEnvVar = /bearer_token_env_var\s*=\s*"([^"]+)"/.exec(managedSection)?.[1];
    if (tokenEnvVar) {
      overlayConfig = mergeShellEnvPolicyExclude(overlayConfig, tokenEnvVar);
    }
  }
  await fs.writeFile(overlayConfigPath, overlayConfig, "utf8");
  await writeSynaraConfigSuppressions(suppressionMarkerPath, suppressedSections);

  return overlayHomePath;
}

async function prepareSynaraCodexHomeOverlay(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly appendConfigToml?: string;
}): Promise<string | undefined> {
  const sourceHomePath = resolveBaseCodexHomePath(input.env, input.homePath);
  const overlayHomePath = resolveSynaraCodexHomeOverlayPath(input.env, sourceHomePath);
  if (path.resolve(sourceHomePath) === path.resolve(overlayHomePath)) {
    return undefined;
  }
  return serializeCodexOverlayPreparation(overlayHomePath, () =>
    prepareSynaraCodexHomeOverlayUnlocked(input),
  );
}

export async function buildCodexProcessEnv(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly homePath?: string;
    readonly platform?: NodeJS.Platform;
    readonly readEnvironment?: ShellEnvironmentReader;
    readonly appendConfigToml?: string;
  } = {},
): Promise<NodeJS.ProcessEnv> {
  const baseEnv = { ...(input.env ?? process.env) };
  const overlayHomePath = await prepareSynaraCodexHomeOverlay({
    env: baseEnv,
    ...(input.homePath ? { homePath: input.homePath } : {}),
    ...(input.appendConfigToml ? { appendConfigToml: input.appendConfigToml } : {}),
  });
  const configuredEnv =
    overlayHomePath || input.homePath
      ? { ...baseEnv, CODEX_HOME: overlayHomePath ?? input.homePath }
      : baseEnv;
  const platform = input.platform ?? process.platform;
  const effectiveEnv = buildProviderChildEnvironment({
    provider: "codex",
    baseEnv: configuredEnv,
  });
  const providerEnvKey = readActiveCodexProviderEnvKey(effectiveEnv);
  if (providerEnvKey) {
    registerProviderCredentialKey(providerEnvKey);
  }

  if (platform === "darwin" || platform === "linux") {
    try {
      const shell = resolveLoginShell(platform, effectiveEnv.SHELL);
      if (shell && providerEnvKey && !effectiveEnv[providerEnvKey]?.trim()) {
        const shellEnvironment = (input.readEnvironment ?? readEnvironmentFromLoginShell)(shell, [
          ...CODEX_PROCESS_SHELL_ENV_NAMES,
          providerEnvKey,
        ]);

        if (shellEnvironment.PATH) {
          effectiveEnv.PATH = shellEnvironment.PATH;
        }
        if (!effectiveEnv.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
          effectiveEnv.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
        }
        if (shellEnvironment[providerEnvKey]) {
          effectiveEnv[providerEnvKey] = shellEnvironment[providerEnvKey];
        }
      }
    } catch {
      // Keep inherited environment if shell lookup fails.
    }
  }

  return effectiveEnv;
}
