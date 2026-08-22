import {
  PROVIDER_DISPLAY_NAMES,
  THREAD_GOAL_MAX_CHARS,
  type GitBranch,
  type ProviderInteractionMode,
  type ProviderKind,
} from "@synara/contracts";
import { DEFAULT_PROVIDER_ORDER } from "./providerOrdering";
import {
  BUILT_IN_COMPOSER_SLASH_COMMANDS,
  isBuiltInComposerSlashCommandName,
  normalizeComposerSlashCommandName,
  type BuiltInComposerSlashCommand,
} from "@synara/shared/composerSlashCommands";
import { rankProviderDiscoveryItems } from "./lib/providerDiscovery";

export { BUILT_IN_COMPOSER_SLASH_COMMANDS };

export type ComposerSlashCommand = BuiltInComposerSlashCommand;

export interface ComposerSlashCommandDefinition {
  command: ComposerSlashCommand;
  label: `/${ComposerSlashCommand}`;
  description: string;
  source: "app" | "shared";
}

export interface ComposerSlashInvocation {
  command: ComposerSlashCommand;
  args: string;
}

export type FastSlashCommandAction = "toggle" | "on" | "off" | "status" | "invalid";
export type ForkSlashCommandTarget = "local" | "worktree";
export type GoalSlashCommandAction =
  | { readonly action: "show" }
  | { readonly action: "clear" }
  | { readonly action: "pause" }
  | { readonly action: "resume" }
  | { readonly action: "edit" }
  | { readonly action: "set"; readonly goal: string }
  | { readonly action: "too-long" };

const CLAUDE_NATIVE_COMMAND_ALIASES: Record<string, readonly string[]> = {
  clear: ["reset", "new"],
  config: ["settings"],
  desktop: ["app"],
  exit: ["quit"],
  feedback: ["bug"],
  mobile: ["ios", "android"],
  permissions: ["allowed-tools"],
  "remote-control": ["rc"],
  resume: ["continue"],
};

function getProviderNativeSlashCommandAliases(
  provider: ProviderKind,
  command: string,
): readonly string[] {
  const normalizedCommand = normalizeComposerSlashCommandName(command);
  if (provider !== "claudeAgent") {
    return [];
  }
  return CLAUDE_NATIVE_COMMAND_ALIASES[normalizedCommand] ?? [];
}

function expandProviderNativeSlashCommandNames(
  provider: ProviderKind,
  commandNames: ReadonlyArray<string>,
): string[] {
  const expandedNames = new Set<string>();
  for (const commandName of commandNames) {
    const normalizedCommandName = normalizeComposerSlashCommandName(commandName);
    if (!normalizedCommandName) {
      continue;
    }
    expandedNames.add(normalizedCommandName);
    for (const alias of getProviderNativeSlashCommandAliases(provider, normalizedCommandName)) {
      expandedNames.add(alias);
    }
  }
  return [...expandedNames];
}

/**
 * Providers where app-owned /review (target picker + structured prompt) must
 * win over listing a native "review" command. OpenCode exposes /review in its
 * command list but does not honor bare `/review` text turns (#218).
 */
export function providerUsesAppOwnedReviewSlashCommand(provider: ProviderKind): boolean {
  return provider === "codex" || provider === "opencode";
}

function shouldKeepBuiltInSlashCommandDespiteNativeCollision(
  provider: ProviderKind,
  command: ComposerSlashCommand,
): boolean {
  return (
    command === "debug" ||
    command === "default" ||
    command === "automation" ||
    command === "export" ||
    command === "feedback" ||
    // /fork is app-owned everywhere: it creates a Synara thread with fork
    // lineage (native session forking per provider), which a provider-native
    // "fork" text command cannot do.
    command === "fork" ||
    command === "goal" ||
    (providerUsesAppOwnedReviewSlashCommand(provider) && command === "review")
  );
}

export function shouldHideProviderNativeCommandFromComposerMenu(
  provider: ProviderKind,
  command: string,
  options: { readonly availableAppCommands?: ReadonlySet<string> } = {},
): boolean {
  const normalizedCommand = normalizeComposerSlashCommandName(command);
  const appCommandIsAvailable = options.availableAppCommands?.has(normalizedCommand) ?? true;
  return (
    normalizedCommand === "automation" ||
    normalizedCommand === "debug" ||
    normalizedCommand === "default" ||
    (normalizedCommand === "export" && appCommandIsAvailable) ||
    (normalizedCommand === "feedback" && appCommandIsAvailable) ||
    (normalizedCommand === "fork" && appCommandIsAvailable) ||
    (normalizedCommand === "goal" && appCommandIsAvailable) ||
    (providerUsesAppOwnedReviewSlashCommand(provider) && normalizedCommand === "review")
  );
}

/**
 * True when a discovered native "review" command should be sent as plain
 * `/review` text. Codex/OpenCode use the app review UX instead (#218).
 */
export function providerSupportsTextNativeReviewCommand(
  provider: ProviderKind,
  nativeCommandNames: ReadonlyArray<{ readonly name: string } | string>,
): boolean {
  if (providerUsesAppOwnedReviewSlashCommand(provider)) {
    return false;
  }
  return nativeCommandNames.some((command) => {
    const name = typeof command === "string" ? command : command.name;
    return name.trim().toLowerCase() === "review";
  });
}

export function getProviderNativeSlashCommandSearchTerms(
  provider: ProviderKind,
  command: string,
): readonly string[] {
  const normalizedCommand = normalizeComposerSlashCommandName(command);
  return [normalizedCommand, ...getProviderNativeSlashCommandAliases(provider, normalizedCommand)];
}

const COMPOSER_SLASH_COMMAND_DEFINITIONS: Record<
  ComposerSlashCommand,
  ComposerSlashCommandDefinition
> = {
  clear: {
    command: "clear",
    label: "/clear",
    description: "Start a fresh thread and clear the current conversation context",
    source: "shared",
  },
  compact: {
    command: "compact",
    label: "/compact",
    description: "Compact the current thread context to free space",
    source: "app",
  },
  model: {
    command: "model",
    label: "/model",
    description: "Switch response model for this thread",
    source: "shared",
  },
  plan: {
    command: "plan",
    label: "/plan",
    description: "Switch this thread into plan mode",
    source: "app",
  },
  debug: {
    command: "debug",
    label: "/debug",
    description: "Switch this thread into evidence-first debug mode",
    source: "app",
  },
  default: {
    command: "default",
    label: "/default",
    description: "Switch this thread back to normal chat mode",
    source: "app",
  },
  review: {
    command: "review",
    label: "/review",
    description: "Start a code review for current changes",
    source: "app",
  },
  fork: {
    command: "fork",
    label: "/fork",
    description: "Fork this thread into local or a new worktree",
    source: "app",
  },
  side: {
    command: "side",
    label: "/side",
    description: "Open a guarded Side from this thread, optionally on another provider",
    source: "app",
  },
  status: {
    command: "status",
    label: "/status",
    description: "Show context usage and rate-limit status",
    source: "app",
  },
  subagents: {
    command: "subagents",
    label: "/subagents",
    description: "Insert a prompt that asks the assistant to delegate work",
    source: "app",
  },
  fast: {
    command: "fast",
    label: "/fast",
    description: "Turn fast mode on or off for this thread",
    source: "app",
  },
  export: {
    command: "export",
    label: "/export",
    description: "Download this thread as a ZIP archive (thread.json + transcript.md)",
    source: "app",
  },
  goal: {
    command: "goal",
    label: "/goal",
    description: "Set, edit, pause, resume, or clear this thread's persistent goal",
    source: "app",
  },
  feedback: {
    command: "feedback",
    label: "/feedback",
    description: "Send feedback to the Synara team",
    source: "app",
  },
  automation: {
    command: "automation",
    label: "/automation",
    description: "Create a scheduled automation from this prompt",
    source: "app",
  },
};

export function isBuiltInComposerSlashCommand(value: string): value is ComposerSlashCommand {
  return isBuiltInComposerSlashCommandName(value);
}

export function parseComposerSlashInvocation(text: string): ComposerSlashInvocation | null {
  return parseComposerSlashInvocationForCommands(text, BUILT_IN_COMPOSER_SLASH_COMMANDS);
}

export function parseComposerSlashInvocationForCommands(
  text: string,
  commands: ReadonlyArray<ComposerSlashCommand>,
): ComposerSlashInvocation | null {
  const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = normalizeComposerSlashCommandName(match[1] ?? "");
  if (!command || !commands.includes(command as ComposerSlashCommand)) {
    return null;
  }
  return {
    command: command as ComposerSlashCommand,
    args: (match[2] ?? "").trim(),
  };
}

export function filterComposerSlashCommands(
  query: string,
  commands: ReadonlyArray<ComposerSlashCommand> = BUILT_IN_COMPOSER_SLASH_COMMANDS,
): ComposerSlashCommandDefinition[] {
  const matches = rankProviderDiscoveryItems(commands, query, (command) => {
    const definition = COMPOSER_SLASH_COMMAND_DEFINITIONS[command];
    return [
      { value: command },
      { value: definition.label.slice(1) },
      { value: definition.description, weight: 200 },
    ];
  });

  return matches.map((command) => COMPOSER_SLASH_COMMAND_DEFINITIONS[command]);
}

function hasMeaningfulComposerText(prompt: string): boolean {
  return prompt.trim().length > 0;
}

export function canOfferForkSlashCommand(input: {
  prompt: string;
  imageCount: number;
  terminalContextCount: number;
  selectedSkillCount: number;
  selectedMentionCount: number;
  interactionMode: ProviderInteractionMode;
}): boolean {
  return (
    !hasMeaningfulComposerText(input.prompt) &&
    input.imageCount === 0 &&
    input.terminalContextCount === 0 &&
    input.selectedSkillCount === 0 &&
    input.selectedMentionCount === 0 &&
    input.interactionMode === "default"
  );
}

export function canOfferSideSlashCommand(input: {
  prompt: string;
  imageCount: number;
  terminalContextCount: number;
  selectedSkillCount: number;
  selectedMentionCount: number;
  interactionMode: ProviderInteractionMode;
  isSidechat: boolean;
}): boolean {
  return (
    !hasMeaningfulComposerText(input.prompt) &&
    input.imageCount === 0 &&
    input.terminalContextCount === 0 &&
    input.selectedSkillCount === 0 &&
    input.selectedMentionCount === 0 &&
    input.interactionMode === "default" &&
    !input.isSidechat
  );
}

export function canOfferReviewSlashCommand(input: {
  prompt: string;
  imageCount: number;
  terminalContextCount: number;
  selectedSkillCount: number;
  selectedMentionCount: number;
}): boolean {
  return (
    !hasMeaningfulComposerText(input.prompt) &&
    input.imageCount === 0 &&
    input.terminalContextCount === 0 &&
    input.selectedSkillCount === 0 &&
    input.selectedMentionCount === 0
  );
}

export function buildSubagentsPrompt(existingPrompt: string): string {
  const cannedPrompt =
    "Run subagents for different tasks. Delegate distinct work in parallel when helpful and then synthesize the results.";
  const trimmedPrompt = existingPrompt.trim();
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${cannedPrompt}` : cannedPrompt;
}

export function buildReviewPrompt(input: { target: "changes" | "base-branch" }): string {
  const baseInstruction =
    "Review the local code changes for bugs, risks, behavioural regressions, and missing tests. Findings first, ordered by severity.";
  if (input.target === "base-branch") {
    return `${baseInstruction}\nFocus on the current branch diff against its base branch.`;
  }
  return `${baseInstruction}\nFocus on the current uncommitted changes.`;
}

export function parseFastSlashCommandAction(text: string): FastSlashCommandAction | null {
  const invocation = parseComposerSlashInvocation(text);
  if (!invocation || invocation.command !== "fast") {
    return null;
  }
  const arg = invocation.args.toLowerCase();
  if (!arg) {
    return "toggle";
  }
  if (arg === "on") {
    return "on";
  }
  if (arg === "off") {
    return "off";
  }
  if (arg === "status") {
    return "status";
  }
  return "invalid";
}

export function parseGoalSlashCommandArgs(args: string): GoalSlashCommandAction {
  const goal = args.trim();
  if (!goal) {
    return { action: "show" };
  }
  const control = goal.toLowerCase();
  if (control === "clear") {
    return { action: "clear" };
  }
  if (control === "pause" || control === "resume" || control === "edit") {
    return { action: control };
  }
  if (goal.length > THREAD_GOAL_MAX_CHARS) {
    return { action: "too-long" };
  }
  return { action: "set", goal };
}

export function resolveComposerSlashRootBranch(input: {
  branches: ReadonlyArray<GitBranch> | null | undefined;
  activeProjectCwd: string | null | undefined;
  activeThreadBranch: string | null | undefined;
}): string | null {
  return (
    input.branches?.find(
      (branch) =>
        branch.current === true &&
        (branch.worktreePath === null ||
          branch.worktreePath === undefined ||
          branch.worktreePath === input.activeProjectCwd),
    )?.name ??
    input.branches?.find((branch) => branch.current === true)?.name ??
    input.activeThreadBranch ??
    null
  );
}

export function getAvailableComposerSlashCommands(input: {
  provider: ProviderKind;
  supportsFastSlashCommand: boolean;
  canOfferCompactCommand: boolean;
  canOfferReviewCommand: boolean;
  canOfferForkCommand: boolean;
  canOfferSideCommand: boolean;
  canOfferExportCommand: boolean;
  providerNativeCommandNames?: ReadonlyArray<string>;
}): ComposerSlashCommand[] {
  const collidingNativeCommandNames = new Set<ComposerSlashCommand>(
    expandProviderNativeSlashCommandNames(
      input.provider,
      input.providerNativeCommandNames ?? [],
    ).filter(
      (name): name is ComposerSlashCommand =>
        isBuiltInComposerSlashCommand(name) &&
        !shouldKeepBuiltInSlashCommandDespiteNativeCollision(input.provider, name),
    ),
  );

  const availableCommands: ComposerSlashCommand[] =
    input.provider !== "claudeAgent"
      ? [
          "clear",
          ...(input.canOfferCompactCommand ? (["compact"] as const) : []),
          "model",
          ...(input.supportsFastSlashCommand ? (["fast"] as const) : []),
          "plan",
          "debug",
          "default",
          ...(input.canOfferReviewCommand ? (["review"] as const) : []),
          ...(input.canOfferForkCommand ? (["fork"] as const) : []),
          ...(input.canOfferSideCommand ? (["side"] as const) : []),
          "status",
          "subagents",
          ...(input.canOfferExportCommand ? (["export"] as const) : []),
          "goal",
          "feedback",
          "automation",
        ]
      : [
          // Claude owns most slash-command UX natively; sidechat remains app-level because it
          // creates a Synara split/context clone before the provider sees the first turn.
          // /fork is app-level for the same reason — it creates a Synara thread with fork
          // lineage (native session forking under the hood), not a provider text command.
          // /export is app-level too — Synara owns the thread transcript, so the download
          // happens in the app rather than being forwarded to Claude's native /export.
          ...(input.canOfferForkCommand ? (["fork"] as const) : []),
          ...(input.canOfferSideCommand ? (["side"] as const) : []),
          ...(input.canOfferExportCommand ? (["export"] as const) : []),
          "goal",
          "debug",
          "default",
          "feedback",
          "automation",
        ];
  return availableCommands.filter((command) => !collidingNativeCommandNames.has(command));
}

export function hasProviderNativeSlashCommand(
  provider: ProviderKind,
  commandNames: ReadonlyArray<string>,
  command: string,
): boolean {
  const normalizedCommand = normalizeComposerSlashCommandName(command);
  return expandProviderNativeSlashCommandNames(provider, commandNames).includes(normalizedCommand);
}

export function buildSlashReviewComposerPrompt(args: string): string {
  const trimmedArgs = args.trim();
  const normalizedArgs = trimmedArgs.toLowerCase();
  const reviewTarget =
    normalizedArgs === "base" || normalizedArgs.startsWith("base ") ? "base-branch" : "changes";
  const basePrompt = buildReviewPrompt({ target: reviewTarget });
  if (!trimmedArgs) {
    return basePrompt;
  }
  if (reviewTarget === "base-branch") {
    const baseBranchHint = trimmedArgs.replace(/^base\b/i, "").trim();
    return baseBranchHint.length > 0
      ? `${basePrompt}\nUse ${baseBranchHint} as the base branch if needed.`
      : basePrompt;
  }
  return `${basePrompt}\nFocus especially on: ${trimmedArgs}`;
}

export interface SideSlashCommandArgs {
  targetProvider: ProviderKind | null;
  prompt: string;
  unavailableProvider: ProviderKind | null;
}

function matchSideProviderToken(token: string): ProviderKind | null {
  const normalized = token.toLowerCase();
  return (
    DEFAULT_PROVIDER_ORDER.find(
      (provider) =>
        provider.toLowerCase() === normalized ||
        PROVIDER_DISPLAY_NAMES[provider].toLowerCase() === normalized,
    ) ?? null
  );
}

// `/side [provider] [prompt]`: an optional leading provider token (kind or
// display name) starts the sidechat on that provider.
export function parseSideSlashCommandArgs(
  args: string,
  input: {
    currentProvider: ProviderKind;
    availableTargetProviders: ReadonlyArray<ProviderKind>;
  },
): SideSlashCommandArgs {
  const trimmedArgs = args.trim();
  const firstToken = trimmedArgs.split(/\s+/, 1)[0] ?? "";
  const matchedProvider = firstToken.length > 0 ? matchSideProviderToken(firstToken) : null;
  if (!matchedProvider) {
    return { targetProvider: null, prompt: trimmedArgs, unavailableProvider: null };
  }
  const prompt = trimmedArgs.slice(firstToken.length).trim();
  if (matchedProvider === input.currentProvider) {
    return { targetProvider: null, prompt, unavailableProvider: null };
  }
  if (!input.availableTargetProviders.includes(matchedProvider)) {
    return { targetProvider: null, prompt, unavailableProvider: matchedProvider };
  }
  return { targetProvider: matchedProvider, prompt, unavailableProvider: null };
}

// `/fork` optionally accepts only an explicit target shorthand like `/fork local`.
export function parseForkSlashCommandArgs(args: string): {
  target: ForkSlashCommandTarget | null;
  invalid: boolean;
} {
  const trimmedArgs = args.trim();
  if (!trimmedArgs) {
    return { target: null, invalid: false };
  }

  const match = /^(local|worktree)$/i.exec(trimmedArgs);
  if (!match) {
    return { target: null, invalid: true };
  }

  return {
    target: match[1]!.toLowerCase() as ForkSlashCommandTarget,
    invalid: false,
  };
}
