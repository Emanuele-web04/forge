import { isBuiltInComposerSlashCommand, type ComposerSlashCommand } from "./composerSlashCommands";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "./lib/terminalContext";
import {
  createComposerMentionTokenRegex,
  extractComposerMentionPath,
  findThreadProviderMentionReferenceForToken,
  isPluginProviderMentionReference,
  providerMentionMatchesToken,
} from "./lib/composerMentions";
import {
  LINK_TOKEN_SOURCE,
  normalizeComposerLinkUrl,
  trimTrailingLinkPunctuation,
} from "./lib/linkChips";
import { resolveAgentAlias } from "@synara/contracts";
import type { ProviderMentionReference } from "@synara/contracts";
import { threadIdFromThreadMentionPath } from "@synara/shared/threadMentions";

export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      path: string;
      kind?: "path" | "plugin" | "thread";
      threadId?: string;
      /**
       * Raw token length in the source text (`@name` vs `@"name with spaces"`).
       * Cursor math must use this — quoted tokens are longer than path.length + 1.
       */
      tokenLength?: number;
    }
  | {
      type: "skill";
      name: string;
      prefix?: string;
    }
  | {
      type: "slash-command";
      command: ComposerSlashCommand;
    }
  | {
      type: "terminal-context";
      context: TerminalContextDraft | null;
    }
  | {
      /** Agent mention: @alias - chip for subagent reference (parens are plain text) */
      type: "agent-mention";
      alias: string;
      color: string;
    }
  | {
      /** URL/domain rendered as a tappable link chip. */
      type: "link";
      url: string;
    };

const SKILL_TOKEN_REGEX = /(^|\s)([$/])([a-zA-Z][a-zA-Z0-9_:-]*)(?=\s)/g;
const DISPLAY_SKILL_TOKEN_REGEX = /(^|\s)([$/])([a-zA-Z][a-zA-Z0-9_:-]*)(?=\s|$)/g;
const SLASH_COMMAND_CHIP_TOKEN_REGEX = /(^|\s)\/([a-zA-Z][a-zA-Z0-9_-]*)(?=\s)/i;

// Built-in commands that render as an inline chip (icon + label) instead of plain
// text, both while typing and in the sent message. Everything else stays literal.
const COMPOSER_SLASH_COMMAND_CHIP_NAMES = new Set<ComposerSlashCommand>(["automation", "goal"]);

// While typing (composer) a URL only becomes a chip once a delimiter follows it,
// mirroring how skills/mentions wait for a trailing boundary. For read-only
// display we also accept a URL that sits at the very end of the text.
const LINK_TOKEN_TYPING_PATTERN = `${LINK_TOKEN_SOURCE}(?=\\s)`;
const LINK_TOKEN_DISPLAY_PATTERN = `${LINK_TOKEN_SOURCE}(?=\\s|$)`;
// Global variants drive `matchAll` in the segment split (collect every token in the text).
const LINK_TOKEN_REGEX = new RegExp(LINK_TOKEN_TYPING_PATTERN, "g");
const DISPLAY_LINK_TOKEN_REGEX = new RegExp(LINK_TOKEN_DISPLAY_PATTERN, "g");
// Non-global twins for the single first-match lookup on the per-keystroke transform path. Reused
// (no per-call RegExp allocation) and stateless — a non-global `exec` ignores and never advances
// `lastIndex`, so these can't pollute the global variants the split helpers feed to `matchAll`.
const LINK_TOKEN_FIRST_REGEX = new RegExp(LINK_TOKEN_TYPING_PATTERN);
const DISPLAY_LINK_TOKEN_FIRST_REGEX = new RegExp(LINK_TOKEN_DISPLAY_PATTERN);

// Agent mention chip: @alias(
// Keep plain @alias text editable while typing so the picker can stay open.
const AGENT_MENTION_TOKEN_REGEX = /(^|\s)@([a-zA-Z0-9._-]+)(?=\()/g;

/**
 * Finds the first bare-URL token in `text` using the same rules as the segment split: while
 * editing, a URL only counts once a delimiter follows it (`includeTrailingTokenAtEnd: false`);
 * read-only display also accepts a URL sitting at the very end. Shared by the composer's live
 * link-chip transform so it stays in lockstep with how prompts are tokenized for display.
 */
export function matchComposerLinkToken(
  text: string,
  options: { includeTrailingTokenAtEnd: boolean },
): { url: string; start: number; end: number } | null {
  // Fast reject: links either have a scheme or a dotted host, so ordinary prose/typing skips the
  // regex entirely and keeps the live transform as light as plain text.
  if (!text.includes("http") && !text.includes(".")) {
    return null;
  }
  const regex = options.includeTrailingTokenAtEnd
    ? DISPLAY_LINK_TOKEN_FIRST_REGEX
    : LINK_TOKEN_FIRST_REGEX;
  const match = regex.exec(text);
  if (!match) {
    return null;
  }
  const rawUrl = trimTrailingLinkPunctuation(match[0]);
  const url = normalizeComposerLinkUrl(rawUrl);
  if (!url) {
    return null;
  }
  const start = match.index ?? 0;
  return { url, start, end: start + rawUrl.length };
}

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

type InlineTokenMatch =
  | {
      kind: "mention" | "skill";
      value: string;
      skillPrefix?: string;
      start: number;
      end: number;
    }
  | {
      kind: "slash-command";
      command: ComposerSlashCommand;
      start: number;
      end: number;
    }
  | {
      kind: "agent-mention";
      alias: string;
      color: string;
      start: number;
      end: number;
    }
  | {
      kind: "link";
      url: string;
      start: number;
      end: number;
    };

function isComposerSlashCommandChipName(value: string): value is ComposerSlashCommand {
  return isBuiltInComposerSlashCommand(value) && COMPOSER_SLASH_COMMAND_CHIP_NAMES.has(value);
}

export function matchComposerSlashCommandChipToken(
  text: string,
): { command: ComposerSlashCommand; start: number; end: number } | null {
  const match = SLASH_COMMAND_CHIP_TOKEN_REGEX.exec(text);
  if (!match) {
    return null;
  }
  const whitespace = match[1] ?? "";
  const command = (match[2] ?? "").toLowerCase();
  if (!isComposerSlashCommandChipName(command)) {
    return null;
  }
  const start = (match.index ?? 0) + whitespace.length;
  return { command, start, end: start + command.length + 1 };
}

function collectInlineTokenMatches(
  text: string,
  options: {
    includeTrailingTokenAtEnd: boolean;
    includeSlashCommandChips: boolean;
  },
): InlineTokenMatch[] {
  const matches: InlineTokenMatch[] = [];
  const mentionRegex = createComposerMentionTokenRegex({
    includeTrailingTokenAtEnd: options.includeTrailingTokenAtEnd,
  });
  const skillRegex = options.includeTrailingTokenAtEnd
    ? DISPLAY_SKILL_TOKEN_REGEX
    : SKILL_TOKEN_REGEX;
  const linkRegex = options.includeTrailingTokenAtEnd ? DISPLAY_LINK_TOKEN_REGEX : LINK_TOKEN_REGEX;

  // Ranges covered by higher-priority tokens, so mentions/skills do not match
  // inside a URL (e.g. an `@` host) and links do not match inside an agent token.
  const reservedRanges: Array<{ start: number; end: number }> = [];
  const isReserved = (pos: number): boolean =>
    reservedRanges.some((range) => pos >= range.start && pos < range.end);

  // Links win first: a URL is an opaque span that other token kinds must skip.
  for (const match of text.matchAll(linkRegex)) {
    const start = match.index ?? 0;
    const rawUrl = trimTrailingLinkPunctuation(match[0]);
    const url = normalizeComposerLinkUrl(rawUrl);
    if (!url) continue;
    const end = start + rawUrl.length;
    reservedRanges.push({ start, end });
    matches.push({ kind: "link", url, start, end });
  }

  // Track positions covered by agent mentions to avoid double-matching
  const agentMentionRanges: Array<{ start: number; end: number }> = [];

  // First, match agent mentions: @alias (just the alias, parens are plain text)
  for (const match of text.matchAll(AGENT_MENTION_TOKEN_REGEX)) {
    const whitespace = match[1] ?? "";
    const alias = match[2] ?? "";
    const matchIndex = match.index ?? 0;
    const start = matchIndex + whitespace.length;
    const end = start + 1 + alias.length; // @alias

    // Skip if this falls inside a URL token
    if (isReserved(start)) continue;

    // Try to resolve the alias
    const resolved = resolveAgentAlias(alias);
    if (!resolved) {
      // Not a valid agent alias, skip - will be handled as regular mention
      continue;
    }

    agentMentionRanges.push({ start, end });

    matches.push({
      kind: "agent-mention",
      alias,
      color: resolved.color,
      start,
      end,
    });
  }

  // Helper to check if a position is inside an agent mention
  const isInsideAgentMention = (pos: number): boolean =>
    agentMentionRanges.some((range) => pos >= range.start && pos < range.end);

  for (const match of text.matchAll(mentionRegex)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const path = extractComposerMentionPath(match);
    const matchIndex = match.index ?? 0;
    const start = matchIndex + prefix.length;
    const end = start + fullMatch.length - prefix.length;

    // Skip if this overlaps with an agent mention or sits inside a URL
    if (isInsideAgentMention(start) || isReserved(start)) continue;

    if (path.length > 0) {
      matches.push({ kind: "mention", value: path, start, end });
    }
  }

  for (const match of text.matchAll(skillRegex)) {
    const fullMatch = match[0];
    const whitespace = match[1] ?? "";
    const skillPrefix = match[2] ?? "$";
    const name = match[3] ?? "";
    const matchIndex = match.index ?? 0;
    const start = matchIndex + whitespace.length;
    const end = start + fullMatch.length - whitespace.length;

    // Skip if this overlaps with an agent mention or sits inside a URL
    if (isInsideAgentMention(start) || isReserved(start)) continue;

    if (name.length === 0) {
      continue;
    }

    const normalizedName = name.toLowerCase();
    if (skillPrefix === "/" && isBuiltInComposerSlashCommand(normalizedName)) {
      if (options.includeSlashCommandChips && isComposerSlashCommandChipName(normalizedName)) {
        matches.push({ kind: "slash-command", command: normalizedName, start, end });
      }
      // Skip the other built-in slash commands so `/clear`, `/plan` etc. stay as plain text.
      continue;
    }

    matches.push({ kind: "skill", value: name, skillPrefix, start, end });
  }

  matches.sort((a, b) => a.start - b.start);
  return matches;
}

function splitTextIntoPromptSegments(
  text: string,
  options: {
    includeTrailingTokenAtEnd: boolean;
    includeSlashCommandChips: boolean;
    mentionReferences?: ReadonlyArray<ProviderMentionReference>;
  },
): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  if (!text) {
    return segments;
  }

  const matches = collectInlineTokenMatches(text, options);
  let cursor = 0;

  for (const match of matches) {
    if (match.start < cursor) continue;

    if (match.start > cursor) {
      pushTextSegment(segments, text.slice(cursor, match.start));
    }

    if (match.kind === "link") {
      segments.push({ type: "link", url: match.url });
    } else if (match.kind === "agent-mention") {
      segments.push({
        type: "agent-mention",
        alias: match.alias,
        color: match.color,
      });
    } else if (match.kind === "mention") {
      const threadMention = findThreadProviderMentionReferenceForToken(
        match.value,
        options.mentionReferences,
      );
      const isPluginMention =
        options.mentionReferences?.some(
          (mention) =>
            isPluginProviderMentionReference(mention) &&
            providerMentionMatchesToken(mention, match.value),
        ) ?? false;
      const tokenLength = match.end - match.start;
      const threadId = threadMention ? threadIdFromThreadMentionPath(threadMention.path) : null;
      segments.push(
        threadMention
          ? {
              type: "mention",
              path: match.value,
              kind: "thread",
              ...(threadId !== null ? { threadId } : {}),
              tokenLength,
            }
          : isPluginMention
            ? { type: "mention", path: match.value, kind: "plugin", tokenLength }
            : { type: "mention", path: match.value, tokenLength },
      );
    } else if (match.kind === "slash-command") {
      segments.push({ type: "slash-command", command: match.command });
    } else {
      const skillSegment: ComposerPromptSegment = match.skillPrefix
        ? { type: "skill", name: match.value, prefix: match.skillPrefix }
        : { type: "skill", name: match.value };
      segments.push(skillSegment);
    }

    cursor = match.end;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }

  return segments;
}

export function splitPromptIntoDisplaySegments(
  prompt: string,
  mentionReferences: ReadonlyArray<ProviderMentionReference> = [],
): ComposerPromptSegment[] {
  return splitTextIntoPromptSegments(prompt, {
    // Sent messages echo the same chips the composer showed while typing, so a
    // `/goal`/`/automation` token keeps its icon + label instead of falling back
    // to raw text once the turn is submitted.
    includeTrailingTokenAtEnd: true,
    includeSlashCommandChips: true,
    mentionReferences,
  });
}

export function splitPromptIntoComposerSegments(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft> = [],
  mentionReferences: ReadonlyArray<ProviderMentionReference> = [],
): ComposerPromptSegment[] {
  if (!prompt) {
    return [];
  }

  const segments: ComposerPromptSegment[] = [];
  let textCursor = 0;
  let terminalContextIndex = 0;

  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      continue;
    }

    if (index > textCursor) {
      segments.push(
        ...splitTextIntoPromptSegments(prompt.slice(textCursor, index), {
          includeTrailingTokenAtEnd: false,
          includeSlashCommandChips: true,
          mentionReferences,
        }),
      );
    }
    segments.push({
      type: "terminal-context",
      context: terminalContexts[terminalContextIndex] ?? null,
    });
    terminalContextIndex += 1;
    textCursor = index + 1;
  }

  if (textCursor < prompt.length) {
    segments.push(
      ...splitTextIntoPromptSegments(prompt.slice(textCursor), {
        includeTrailingTokenAtEnd: false,
        includeSlashCommandChips: true,
        mentionReferences,
      }),
    );
  }

  return segments;
}
