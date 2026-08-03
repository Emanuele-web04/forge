// FILE: workItemReferences.ts
// Purpose: Normalize, parse URLs for, and serialize Linear/GitHub work-item
//          references attached to a composer draft into a trailing prompt block.
// Layer: Chat composer and transcript helpers

import type { WorkItemReference, WorkItemSource } from "@synara/contracts";

import { randomUUID } from "./utils";

export const WORK_ITEM_BODY_MAX_CHARS = 12_000;
const WORK_ITEM_PREVIEW_MAX_CHARS = 80;

export interface WorkItemReferenceDraft extends WorkItemReference {
  /** Local draft id so multiple attachments of the same remote id can be managed. */
  draftId: string;
}

export interface ParsedWorkItemUrl {
  source: WorkItemSource;
  reference: string;
  repository: string | null;
  url: string;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

export function truncateWorkItemBody(body: string): string {
  const normalized = normalizeBody(body);
  if (normalized.length <= WORK_ITEM_BODY_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, WORK_ITEM_BODY_MAX_CHARS - 1)}…`;
}

export function formatWorkItemBodyPreview(body: string): string {
  const normalized = normalizeBody(body).replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "";
  }
  return normalized.length > WORK_ITEM_PREVIEW_MAX_CHARS
    ? `${normalized.slice(0, WORK_ITEM_PREVIEW_MAX_CHARS - 1)}…`
    : normalized;
}

export function workItemSourceLabel(source: WorkItemSource): string {
  switch (source) {
    case "github-issue":
      return "GitHub issue";
    case "github-pr":
      return "GitHub PR";
    case "linear-issue":
      return "Linear";
  }
}

export function formatWorkItemChipLabel(reference: Pick<WorkItemReference, "identifier" | "title">): string {
  const title = reference.title.trim();
  if (title.length === 0) {
    return reference.identifier;
  }
  return `${reference.identifier}: ${title}`;
}

export function createWorkItemReferenceDraft(
  reference: WorkItemReference,
): WorkItemReferenceDraft {
  const body = truncateWorkItemBody(reference.body);
  return {
    ...reference,
    draftId: randomUUID(),
    body,
    bodyPreview: reference.bodyPreview.trim() || formatWorkItemBodyPreview(body),
    title: reference.title.trim(),
    identifier: reference.identifier.trim(),
    url: reference.url.trim(),
    id: reference.id.trim(),
    repository: reference.repository?.trim() || null,
  };
}

export function workItemReferenceDedupKey(
  reference: Pick<WorkItemReference, "source" | "id" | "url">,
): string {
  return `${reference.source}:${reference.id}:${reference.url}`;
}

/** Parse GitHub issue/PR and Linear issue URLs into a fetchable reference. */
export function parseWorkItemUrl(raw: string): ParsedWorkItemUrl | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let href = trimmed;
  if (!/^https?:\/\//i.test(href)) {
    href = `https://${href.replace(/^\/+/, "")}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "github.com" || host === "www.github.com") {
    const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
    const owner = parts[0];
    const repo = parts[1];
    const kind = parts[2];
    const number = parts[3];
    if (!owner || !repo || !number || !/^\d+$/.test(number)) {
      return null;
    }
    if (kind === "issues") {
      return {
        source: "github-issue",
        reference: number,
        repository: `${owner}/${repo}`,
        url: `https://github.com/${owner}/${repo}/issues/${number}`,
      };
    }
    if (kind === "pull") {
      return {
        source: "github-pr",
        reference: number,
        repository: `${owner}/${repo}`,
        url: `https://github.com/${owner}/${repo}/pull/${number}`,
      };
    }
    return null;
  }

  if (host === "linear.app" || host.endsWith(".linear.app")) {
    const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
    // linear.app/<team>/issue/<KEY-123>/...
    const issueIndex = parts.findIndex((part) => part === "issue");
    const identifier = issueIndex >= 0 ? parts[issueIndex + 1] : null;
    if (!identifier || !/^[A-Za-z]+-\d+$/.test(identifier)) {
      return null;
    }
    return {
      source: "linear-issue",
      reference: identifier.toUpperCase(),
      repository: null,
      url: `https://linear.app/${parts[0] ?? "team"}/issue/${identifier.toUpperCase()}`,
    };
  }

  return null;
}

export function buildWorkItemReferencesPromptBlock(
  references: ReadonlyArray<WorkItemReference>,
): string {
  if (references.length === 0) {
    return "";
  }

  const lines: string[] = [];
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index]!;
    const body = truncateWorkItemBody(reference.body);
    lines.push(
      `- [${reference.source}] ${reference.identifier} — ${reference.title} (${reference.url}):`,
    );
    if (body.length > 0) {
      for (const line of body.split("\n")) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push("  (no description)");
    }
    if (index < references.length - 1) {
      lines.push("");
    }
  }
  return ["<work_item_references>", ...lines, "</work_item_references>"].join("\n");
}

export function appendWorkItemReferencesToPrompt(
  prompt: string,
  references: ReadonlyArray<WorkItemReference>,
): string {
  const trimmedPrompt = prompt.trim();
  const block = buildWorkItemReferencesPromptBlock(references);
  if (block.length === 0) {
    return trimmedPrompt;
  }
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${block}` : block;
}
