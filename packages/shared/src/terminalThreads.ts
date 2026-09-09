// FILE: terminalThreads.ts
// Purpose: Shared terminal identity helpers for naming, provider attribution, and run state.
// Layer: Shared terminal metadata utilities
// Exports: command parsing plus resolved terminal presentation metadata for web/server consumers.

export const GENERIC_TERMINAL_THREAD_TITLE = "New terminal";
export type TerminalCliKind = "codex" | "claude" | "antigravity";
export type TerminalIconKey = "terminal" | "openai" | "claude" | "antigravity";
export type TerminalActivityState = "running" | "attention" | "review";
export type TerminalVisualState = "idle" | TerminalActivityState;
export type TerminalAgentHookEventType = "Start" | "Stop" | "PermissionRequest";
export const SYNARA_TERMINAL_CLI_KIND_ENV_KEY = "SYNARA_TERMINAL_CLI_KIND";
export const SYNARA_TERMINAL_HOOK_OSC_PREFIX = "633;SYNARA_AGENT_EVENT=";
export type ManagedTerminalCliKind = Exclude<TerminalCliKind, "antigravity">;
export const MANAGED_TERMINAL_COMMAND_NAME_BY_CLI_KIND: Record<ManagedTerminalCliKind, string> = {
  codex: "codex",
  claude: "claude",
};

export interface TerminalCommandIdentity {
  cliKind: TerminalCliKind | null;
  iconKey: TerminalIconKey;
  title: string;
}

export interface ResolvedTerminalVisualIdentity extends TerminalCommandIdentity {
  state: TerminalVisualState;
}

export function isGenericTerminalThreadTitle(title: string | null | undefined): boolean {
  return (title ?? "").trim() === GENERIC_TERMINAL_THREAD_TITLE;
}

const MAX_TERMINAL_INPUT_BUFFER_LENGTH = 512;
const MAX_TERMINAL_TITLE_LENGTH = 48;

const WRAPPER_COMMANDS = new Set(["builtin", "command", "env", "noglob", "nocorrect", "sudo"]);
const CODEX_COMMAND_NAMES = new Set(["codex", "codex-cli"]);
const CLAUDE_COMMAND_NAMES = new Set(["claude", "claude-code", "claude_code"]);
const ANTIGRAVITY_COMMAND_NAMES = new Set(["agy", "antigravity", "antigravity-cli"]);
const TITLE_CODEX_TEXT_PATTERNS = [/\bopenai codex\b/i, /\bcodex cli\b/i];
const TITLE_CLAUDE_TEXT_PATTERNS = [/\bclaude code\b/i];
const TITLE_ANTIGRAVITY_TEXT_PATTERNS = [/\bantigravity(?: cli)?\b/i, /^agy(?: cli)?$/i];
const PROCESS_CODEX_TEXT_PATTERNS = [/@openai\/codex/i];
const PROCESS_CLAUDE_TEXT_PATTERNS = [/@anthropic-ai\/claude-code/i, /anthropic\/claude-code/i];
const PROCESS_ANTIGRAVITY_TEXT_PATTERNS = [/google-antigravity\/antigravity-cli/i];
const IGNORED_TERMINAL_TITLE_COMMANDS = new Set([
  ".",
  "alias",
  "cd",
  "clear",
  "exit",
  "export",
  "history",
  "la",
  "ll",
  "logout",
  "ls",
  "pwd",
  "reset",
  "source",
  "unalias",
  "unset",
]);

function truncateTerminalTitle(title: string): string {
  return title.length <= MAX_TERMINAL_TITLE_LENGTH
    ? title
    : title.slice(0, MAX_TERMINAL_TITLE_LENGTH).trimEnd();
}

function normalizeCommandToken(token: string): string {
  const normalizedPath = token.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment) {
      return segment.toLowerCase();
    }
  }
  return normalizedPath.toLowerCase();
}

function stripScriptExtension(token: string): string {
  return token.replace(/\.(?:cjs|cts|js|jsx|mjs|mts|py|ts|tsx)$/i, "");
}

function deriveCliKindFromNormalizedToken(token: string): TerminalCliKind | null {
  const normalizedToken = stripScriptExtension(token.trim().toLowerCase());
  if (normalizedToken.length === 0) {
    return null;
  }
  if (CODEX_COMMAND_NAMES.has(normalizedToken) || normalizedToken === "@openai/codex") {
    return "codex";
  }
  if (
    CLAUDE_COMMAND_NAMES.has(normalizedToken) ||
    normalizedToken === "@anthropic-ai/claude-code"
  ) {
    return "claude";
  }
  if (ANTIGRAVITY_COMMAND_NAMES.has(normalizedToken)) {
    return "antigravity";
  }
  return null;
}

function deriveCliKindFromTokenList(tokens: string[]): TerminalCliKind | null {
  for (const token of tokens) {
    const cliKind = deriveCliKindFromNormalizedToken(normalizeCommandToken(token));
    if (cliKind) {
      return cliKind;
    }
  }
  return null;
}

function textMatchesCliPatterns(
  text: string,
  patterns: ReadonlyArray<RegExp>,
  cliKind: TerminalCliKind,
): TerminalCliKind | null {
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return cliKind;
    }
  }
  return null;
}

function deriveCliKindFromProcessText(text: string | null | undefined): TerminalCliKind | null {
  const normalizedText = text?.trim();
  if (!normalizedText) {
    return null;
  }
  return (
    textMatchesCliPatterns(normalizedText, PROCESS_CODEX_TEXT_PATTERNS, "codex") ??
    textMatchesCliPatterns(normalizedText, PROCESS_CLAUDE_TEXT_PATTERNS, "claude") ??
    textMatchesCliPatterns(normalizedText, PROCESS_ANTIGRAVITY_TEXT_PATTERNS, "antigravity")
  );
}

function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escapeNext = false;

  for (const char of command.trim()) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = quote !== "'";
      if (!escapeNext) {
        current += char;
      }
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function stripShellPrefixes(tokens: string[]): string[] {
  let startIndex = 0;
  while (startIndex < tokens.length && isEnvAssignmentToken(tokens[startIndex] ?? "")) {
    startIndex += 1;
  }
  while (
    startIndex < tokens.length &&
    WRAPPER_COMMANDS.has(normalizeCommandToken(tokens[startIndex]!))
  ) {
    startIndex += 1;
    while (startIndex < tokens.length && isEnvAssignmentToken(tokens[startIndex] ?? "")) {
      startIndex += 1;
    }
  }
  return tokens.slice(startIndex);
}

function unwrapExecutorCommand(tokens: string[]): string[] {
  const [first, second, third] = tokens;
  const normalizedFirst = normalizeCommandToken(first ?? "");
  const normalizedSecond = normalizeCommandToken(second ?? "");

  if ((normalizedFirst === "npx" || normalizedFirst === "bunx") && second) {
    return [second, ...tokens.slice(2)];
  }
  if (normalizedFirst === "pnpm" && normalizedSecond === "dlx" && third) {
    return [third, ...tokens.slice(3)];
  }
  if (normalizedFirst === "npm" && normalizedSecond === "exec" && third) {
    return [third, ...tokens.slice(3)];
  }
  return tokens;
}

function derivePackageManagerTitle(tokens: string[]): string | null {
  const [first, second, third] = tokens.map(normalizeCommandToken);
  if (!first || !["bun", "npm", "pnpm", "yarn"].includes(first)) {
    return null;
  }
  if (second && ["create", "dlx", "exec", "run"].includes(second) && third) {
    return `${first} ${second} ${third}`;
  }
  if (second) {
    return `${first} ${second}`;
  }
  return first;
}

function createTerminalCommandIdentity(
  title: string,
  cliKind: TerminalCliKind | null,
): TerminalCommandIdentity {
  return {
    cliKind,
    iconKey:
      cliKind === "codex"
        ? "openai"
        : cliKind === "claude"
          ? "claude"
          : cliKind === "antigravity"
            ? "antigravity"
            : "terminal",
    title,
  };
}

export function defaultTerminalTitleForCliKind(cliKind: TerminalCliKind): string {
  return cliKind === "codex"
    ? "Codex CLI"
    : cliKind === "claude"
      ? "Claude Code"
      : "Antigravity CLI";
}

export function managedTerminalCommandNameForCliKind(cliKind: ManagedTerminalCliKind): string {
  return MANAGED_TERMINAL_COMMAND_NAME_BY_CLI_KIND[cliKind];
}

export function terminalCliKindFromValue(value: string | null | undefined): TerminalCliKind | null {
  const normalizedValue = value?.trim().toLowerCase();
  return normalizedValue === "codex" ||
    normalizedValue === "claude" ||
    normalizedValue === "antigravity"
    ? normalizedValue
    : null;
}

// Prefer the actual spawned process name over shell aliases when attributing terminal providers.
export function deriveTerminalProcessIdentity(
  command: string | null | undefined,
): TerminalCommandIdentity | null {
  const strippedCommand = command?.trim() ?? "";
  if (strippedCommand.length === 0) {
    return null;
  }
  const tokenCliKind =
    deriveCliKindFromTokenList(tokenizeShellCommand(strippedCommand)) ??
    deriveCliKindFromProcessText(strippedCommand);
  if (tokenCliKind === "codex") {
    return createTerminalCommandIdentity(defaultTerminalTitleForCliKind("codex"), "codex");
  }
  if (tokenCliKind === "claude") {
    return createTerminalCommandIdentity(defaultTerminalTitleForCliKind("claude"), "claude");
  }
  if (tokenCliKind === "antigravity") {
    return createTerminalCommandIdentity(
      defaultTerminalTitleForCliKind("antigravity"),
      "antigravity",
    );
  }
  return null;
}

function inferCliKindFromTitle(title: string | null | undefined): TerminalCliKind | null {
  const normalizedTitle = title?.trim().toLowerCase();
  if (!normalizedTitle) {
    return null;
  }
  if (/^codex(?: cli)?(?: \d+)?$/.test(normalizedTitle)) {
    return "codex";
  }
  if (/^claude(?: code)?(?: \d+)?$/.test(normalizedTitle) || normalizedTitle === "claude-code") {
    return "claude";
  }
  if (/^(?:antigravity(?: cli)?|agy(?: cli)?)(?: \d+)?$/.test(normalizedTitle)) {
    return "antigravity";
  }
  return (
    textMatchesCliPatterns(normalizedTitle, TITLE_CODEX_TEXT_PATTERNS, "codex") ??
    textMatchesCliPatterns(normalizedTitle, TITLE_CLAUDE_TEXT_PATTERNS, "claude") ??
    textMatchesCliPatterns(normalizedTitle, TITLE_ANTIGRAVITY_TEXT_PATTERNS, "antigravity")
  );
}

// Convert a submitted shell command into a stable terminal identity for labels and icons.
export function deriveTerminalCommandIdentity(command: string): TerminalCommandIdentity | null {
  const strippedCommand = command.trim();
  if (strippedCommand.length === 0) {
    return null;
  }

  const baseTokens = stripShellPrefixes(tokenizeShellCommand(strippedCommand));
  if (baseTokens.length === 0) {
    return null;
  }

  const tokens = unwrapExecutorCommand(baseTokens);
  const normalizedTokens = tokens.map(normalizeCommandToken);
  const first = normalizedTokens[0];
  const second = normalizedTokens[1];

  if (!first || IGNORED_TERMINAL_TITLE_COMMANDS.has(first)) {
    return null;
  }
  const detectedCliKind = deriveCliKindFromTokenList(tokens);
  if (detectedCliKind === "codex") {
    return createTerminalCommandIdentity("Codex CLI", "codex");
  }
  if (detectedCliKind === "claude" || (first === "claude" && second === "code")) {
    return createTerminalCommandIdentity("Claude Code", "claude");
  }
  if (detectedCliKind === "antigravity") {
    return createTerminalCommandIdentity("Antigravity CLI", "antigravity");
  }
  if (first === "git") {
    return createTerminalCommandIdentity(
      truncateTerminalTitle(second ? `git ${second}` : "git"),
      null,
    );
  }

  const packageManagerTitle = derivePackageManagerTitle(tokens);
  if (packageManagerTitle) {
    return createTerminalCommandIdentity(truncateTerminalTitle(packageManagerTitle), null);
  }

  const genericTitle = normalizedTokens.slice(0, 2).join(" ").trim();
  return genericTitle.length > 0
    ? createTerminalCommandIdentity(truncateTerminalTitle(genericTitle), null)
    : null;
}

// Keep the legacy string-only helper for thread-title renames and narrow call sites.
export function deriveTerminalTitleFromCommand(command: string): string | null {
  return deriveTerminalCommandIdentity(command)?.title ?? null;
}

// Consume terminal input incrementally and emit terminal identity only when Enter submits a command.
export function consumeTerminalIdentityInput(
  buffer: string,
  data: string,
): { buffer: string; identity: TerminalCommandIdentity | null } {
  if (data.includes("\u001b")) {
    return { buffer, identity: null };
  }

  let nextBuffer = buffer;
  let nextIdentity: TerminalCommandIdentity | null = null;
  for (const char of data) {
    if (char === "\r" || char === "\n") {
      nextIdentity = deriveTerminalCommandIdentity(nextBuffer);
      nextBuffer = "";
      continue;
    }
    if (char === "\b" || char === "\u007f") {
      nextBuffer = nextBuffer.slice(0, -1);
      continue;
    }
    if (char === "\t") {
      nextBuffer += " ";
      continue;
    }
    if (char === "\u0003" || char === "\u0004" || char === "\u0015") {
      nextBuffer = "";
      continue;
    }
    if (char >= " ") {
      nextBuffer += char;
    }
  }

  return {
    buffer: nextBuffer.slice(-MAX_TERMINAL_INPUT_BUFFER_LENGTH),
    identity: nextIdentity,
  };
}

// Preserve the older title-only input API for server thread-title tracking.
export function consumeTerminalTitleInput(
  buffer: string,
  data: string,
): { buffer: string; title: string | null } {
  const nextIdentityState = consumeTerminalIdentityInput(buffer, data);
  return {
    buffer: nextIdentityState.buffer,
    title: nextIdentityState.identity?.title ?? null,
  };
}

// Resolve terminal label, icon, and activity state from persisted metadata plus runtime status.
export function resolveTerminalVisualIdentity(input: {
  cliKind?: TerminalCliKind | null | undefined;
  fallbackTitle: string;
  isRunning?: boolean | undefined;
  state?: TerminalVisualState | null | undefined;
  title?: string | null | undefined;
}): ResolvedTerminalVisualIdentity {
  const resolvedCliKind =
    input.cliKind === undefined ? inferCliKindFromTitle(input.title) : input.cliKind;
  const title =
    input.title?.trim() ||
    (resolvedCliKind ? defaultTerminalTitleForCliKind(resolvedCliKind) : input.fallbackTitle);
  const cliKind = resolvedCliKind ?? null;
  const state = input.state ?? (input.isRunning ? "running" : "idle");
  return {
    cliKind,
    iconKey:
      cliKind === "codex"
        ? "openai"
        : cliKind === "claude"
          ? "claude"
          : cliKind === "antigravity"
            ? "antigravity"
            : "terminal",
    state,
    title,
  };
}
