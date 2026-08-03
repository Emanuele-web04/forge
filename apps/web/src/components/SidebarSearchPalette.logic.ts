// Purpose: Scores sidebar palette results for actions, themes, projects, and chat threads.
// Keeps search local and deterministic so the palette can rank title hits above
// message-content hits while still surfacing a useful snippet for chat matches.
import type { ComponentType } from "react";

import type { ProviderKind } from "@synara/contracts";
import { basenameOfPath } from "../file-icons";
import type { ThemeMode, ThemeVariant } from "../theme/theme.logic";

export interface SidebarSearchAction {
  id: string;
  label: string;
  description: string;
  keywords?: readonly string[];
  shortcutLabel?: string | null;
  /** Dynamic actions (e.g. "Switch to <space>") execute this instead of a wired-up prop. */
  run?: () => void;
  /** Overrides the id-keyed icon map for actions whose glyph is data (a space's icon). */
  icon?: ComponentType<{ className?: string }>;
  /**
   * Type-to-jump targets (one per space) only appear once the user types; listing them
   * all in the empty palette would push threads and projects below the fold.
   */
  requiresQuery?: boolean;
}

export interface SidebarSearchTheme {
  id: string;
  type: "mode" | "code-theme";
  label: string;
  description: string;
  keywords?: readonly string[];
  mode?: ThemeMode;
  codeThemeId?: string;
  variant?: ThemeVariant;
  isActive: boolean;
}

export interface SidebarSearchProject {
  id: string;
  name: string;
  remoteName: string;
  folderName: string;
  localName: string | null;
  cwd: string;
  spaceName: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface SidebarSearchProjectMatch {
  id: string;
  project: SidebarSearchProject;
}

export interface SidebarSearchThread {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  projectRemoteName: string;
  spaceName: string;
  provider: ProviderKind;
  createdAt: string;
  updatedAt?: string | undefined;
  messages: readonly {
    text: string;
  }[];
}

export interface SidebarSearchThreadMatch {
  id: string;
  thread: SidebarSearchThread;
  matchKind: "message" | "project" | "title";
  snippet: string | null;
  messageMatchCount: number;
}

function normalizeText(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

function normalizeDisplayText(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ");
}

function tokenizeQuery(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 0);
}

function truncateSnippet(value: string, startIndex: number, queryLength: number): string {
  const SNIPPET_MAX_LENGTH = 88;
  const safeStartIndex = Math.max(0, startIndex);
  if (value.length <= SNIPPET_MAX_LENGTH) {
    return value;
  }

  const contextBefore = Math.min(28, safeStartIndex);
  const queryCenter = safeStartIndex + Math.max(queryLength, 1) / 2;
  const desiredStart = Math.max(
    0,
    Math.round(queryCenter - SNIPPET_MAX_LENGTH / 2) - contextBefore,
  );
  const boundedStart = Math.min(desiredStart, Math.max(0, value.length - SNIPPET_MAX_LENGTH));
  const boundedEnd = Math.min(value.length, boundedStart + SNIPPET_MAX_LENGTH);
  const prefix = boundedStart > 0 ? "..." : "";
  const suffix = boundedEnd < value.length ? "..." : "";
  return `${prefix}${value.slice(boundedStart, boundedEnd).trim()}${suffix}`;
}

function buildMessageSnippet(
  messageText: string,
  query: string,
  queryTokens: readonly string[],
): string {
  const displayMessage = normalizeDisplayText(messageText);
  if (!displayMessage) {
    return "";
  }
  const normalizedMessage = displayMessage.toLowerCase();

  const phraseIndex = normalizedMessage.indexOf(query);
  if (phraseIndex >= 0) {
    return truncateSnippet(displayMessage, phraseIndex, query.length);
  }

  let earliestTokenIndex = Number.POSITIVE_INFINITY;
  let matchedToken = "";
  for (const token of queryTokens) {
    const tokenIndex = normalizedMessage.indexOf(token);
    if (tokenIndex >= 0 && tokenIndex < earliestTokenIndex) {
      earliestTokenIndex = tokenIndex;
      matchedToken = token;
    }
  }

  if (!Number.isFinite(earliestTokenIndex)) {
    return truncateSnippet(displayMessage, 0, 0);
  }

  return truncateSnippet(displayMessage, earliestTokenIndex, matchedToken.length);
}

function scoreMessage(
  messages: SidebarSearchThread["messages"],
  query: string,
  queryTokens: readonly string[],
): {
  messageMatchCount: number;
  score: number | null;
  snippet: string | null;
} {
  let bestScore: number | null = null;
  let bestSnippet: string | null = null;
  let matchCount = 0;

  for (const message of messages) {
    const normalizedMessage = normalizeText(message.text);
    if (!normalizedMessage) continue;

    let score: number | null = null;
    if (normalizedMessage === query) {
      score = 165;
    } else if (normalizedMessage.startsWith(query)) {
      score = 155;
    } else if (normalizedMessage.includes(query)) {
      score = 145;
    } else if (
      queryTokens.length > 1 &&
      queryTokens.every((token) => normalizedMessage.includes(token))
    ) {
      score = 132;
    }

    if (score === null) continue;

    matchCount += 1;
    if (bestScore === null || score > bestScore) {
      bestScore = score;
      bestSnippet = buildMessageSnippet(message.text, query, queryTokens);
    }
  }

  return {
    messageMatchCount: matchCount,
    score: bestScore,
    snippet: bestSnippet,
  };
}

function scoreAction(action: SidebarSearchAction, query: string): number | null {
  if (!query) return 0;

  const label = normalizeText(action.label);
  const description = normalizeText(action.description);
  const keywords = (action.keywords ?? []).map(normalizeText);

  if (label === query) return 140;
  if (label.startsWith(query)) return 120;
  if (keywords.some((keyword) => keyword === query)) return 110;
  if (label.includes(query)) return 100;
  if (keywords.some((keyword) => keyword.includes(query))) return 90;
  if (description.includes(query)) return 70;
  return null;
}

function scoreTheme(theme: SidebarSearchTheme, query: string): number | null {
  if (!query) return 0;

  const label = normalizeText(theme.label);
  const description = normalizeText(theme.description);
  const keywords = (theme.keywords ?? []).map(normalizeText);

  if (label === query) return 145;
  if (keywords.some((keyword) => keyword === query)) return 135;
  if (label.startsWith(query)) return 125;
  if (label.includes(query)) return 110;
  if (keywords.some((keyword) => keyword.includes(query))) return 95;
  if (description.includes(query)) return 75;
  return null;
}

function scoreProject(project: SidebarSearchProject, query: string): number | null {
  if (!query) return null;

  const name = normalizeText(project.name);
  const remoteName = normalizeText(project.remoteName);
  const cwd = normalizeText(project.cwd);
  const folder = normalizeText(project.folderName || basenameOfPath(project.cwd));
  const spaceName = normalizeText(project.spaceName);

  if (name === query) return 150;
  if (remoteName === query) return 150;
  if (folder === query) return 145;
  if (name.startsWith(query)) return 130;
  if (remoteName.startsWith(query)) return 130;
  if (folder.startsWith(query)) return 120;
  if (name.includes(query)) return 105;
  if (remoteName.includes(query)) return 105;
  if (folder.includes(query)) return 95;
  if (spaceName === query) return 90;
  if (cwd.includes(query)) return 70;
  if (spaceName.includes(query)) return 60;
  return null;
}

export function matchSidebarSearchActions(
  actions: readonly SidebarSearchAction[],
  query: string,
): SidebarSearchAction[] {
  const normalizedQuery = normalizeText(query);

  return actions
    .filter((action) => !action.requiresQuery || normalizedQuery.length > 0)
    .map((action, index) => ({
      action,
      index,
      score: scoreAction(action, normalizedQuery),
    }))
    .filter((candidate) => candidate.score !== null)
    .toSorted((left, right) => {
      if (left.score !== right.score) return (right.score ?? 0) - (left.score ?? 0);
      return left.index - right.index;
    })
    .map((candidate) => candidate.action);
}

export function matchSidebarSearchThemes(
  themes: readonly SidebarSearchTheme[],
  query: string,
): SidebarSearchTheme[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return [...themes];
  }

  return themes
    .map((theme, index) => ({
      theme,
      index,
      score: scoreTheme(theme, normalizedQuery),
    }))
    .filter((candidate) => candidate.score !== null)
    .toSorted((left, right) => {
      if (left.score !== right.score) return (right.score ?? 0) - (left.score ?? 0);
      if (left.theme.isActive !== right.theme.isActive) {
        return left.theme.isActive ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map((candidate) => candidate.theme);
}

export function matchSidebarSearchProjects(
  projects: readonly SidebarSearchProject[],
  query: string,
  limit = 6,
): SidebarSearchProjectMatch[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  return projects
    .map((project) => ({
      id: `project:${project.id}`,
      project,
      score: scoreProject(project, normalizedQuery),
      recency: Date.parse(project.updatedAt ?? project.createdAt ?? "") || 0,
    }))
    .filter((candidate) => candidate.score !== null)
    .toSorted((left, right) => {
      if (left.score !== right.score) return (right.score ?? 0) - (left.score ?? 0);
      if (left.recency !== right.recency) return right.recency - left.recency;
      return left.project.name.localeCompare(right.project.name);
    })
    .slice(0, limit)
    .map(({ id, project }) => ({ id, project }));
}

export function matchSidebarSearchThreads(
  threads: readonly SidebarSearchThread[],
  query: string,
  limit = 8,
): SidebarSearchThreadMatch[] {
  const normalizedQuery = normalizeText(query);
  const queryTokens = tokenizeQuery(query);

  if (!normalizedQuery) {
    return threads
      .map((thread) => ({
        id: `thread:${thread.id}`,
        thread,
        matchKind: "title" as const,
        snippet: null,
        messageMatchCount: 0,
        recency: Date.parse(thread.updatedAt ?? thread.createdAt) || 0,
      }))
      .toSorted((left, right) => right.recency - left.recency)
      .slice(0, 3)
      .map(({ id, matchKind, messageMatchCount, snippet, thread }) => ({
        id,
        thread,
        matchKind,
        snippet,
        messageMatchCount,
      }));
  }

  return threads
    .map((thread, index) => {
      const title = normalizeText(thread.title);
      const projectName = normalizeText(thread.projectName);
      const projectRemoteName = normalizeText(thread.projectRemoteName);
      const spaceName = normalizeText(thread.spaceName);
      const messageMatch = scoreMessage(thread.messages, normalizedQuery, queryTokens);
      let score: number | null = null;
      let matchKind: SidebarSearchThreadMatch["matchKind"] = "title";
      let snippet: string | null = null;

      if (title === normalizedQuery) {
        score = 170;
        matchKind = "title";
      } else if (title.startsWith(normalizedQuery)) {
        score = 145;
        matchKind = "title";
      } else if (title.includes(normalizedQuery)) {
        score = 125;
        matchKind = "title";
      } else if (messageMatch.score !== null) {
        score = messageMatch.score;
        matchKind = "message";
        snippet = messageMatch.snippet;
      } else if (
        projectName.startsWith(normalizedQuery) ||
        projectRemoteName.startsWith(normalizedQuery)
      ) {
        score = 80;
        matchKind = "project";
      } else if (
        projectName.includes(normalizedQuery) ||
        projectRemoteName.includes(normalizedQuery)
      ) {
        score = 65;
        matchKind = "project";
      } else if (spaceName.includes(normalizedQuery)) {
        score = 55;
        matchKind = "project";
      }

      return {
        id: `thread:${thread.id}`,
        thread,
        index,
        score,
        matchKind,
        snippet,
        messageMatchCount: messageMatch.messageMatchCount,
        recency: Date.parse(thread.updatedAt ?? thread.createdAt) || 0,
        titleLength: thread.title.length,
      };
    })
    .filter((candidate) => candidate.score !== null)
    .toSorted((left, right) => {
      if (left.score !== right.score) return (right.score ?? 0) - (left.score ?? 0);
      if (left.recency !== right.recency) return right.recency - left.recency;
      if (left.titleLength !== right.titleLength) return left.titleLength - right.titleLength;
      return left.index - right.index;
    })
    .slice(0, limit)
    .map(({ id, matchKind, messageMatchCount, snippet, thread }) => ({
      id,
      thread,
      matchKind,
      snippet,
      messageMatchCount,
    }));
}
