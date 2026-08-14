// FILE: ComposerPendingApprovalPanel.tsx
// Purpose: Detached card, floating just above the composer, that surfaces a pending
// tool approval — the command / file context plus approve / decline / cancel actions
// rendered as list-style choice rows. Mirrors ComposerPendingUserInputPanel (same
// surface, spacing, chips, and scoped keyboard shortcuts) so approvals and AskUserQuestion
// prompts read as one coherent decision surface instead of the old fused-banner look.
// Layer: Chat composer UI
// Exports: ComposerPendingApprovalPanel

import { type ApprovalRequestId, type ProviderApprovalDecision } from "@synara/contracts";
import { type KeyboardEvent } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";
import { ComposerChoiceRow, type ComposerChoiceTone } from "./ComposerChoiceRow";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "./composerPickerStyles";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  isResponding: boolean;
  onRespond: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
    lifecycleGeneration?: string,
    requestKind?: PendingApproval["requestKind"],
  ) => Promise<void>;
}

type ParsedApproval = {
  tool: string | null;
  fileName: string | null;
  fileDir: string | null;
  command: string | null;
  fallback: string | null;
};

type ApprovalAction = {
  decision: ProviderApprovalDecision;
  label: string;
  description: string;
  tone: ComposerChoiceTone;
};

// Order is the card-local shortcut order (1-4): recommended action first, stop-everything last.
const APPROVAL_ACTIONS: ReadonlyArray<ApprovalAction> = [
  {
    decision: "accept",
    label: "Approve once",
    description: "Allow just this request",
    tone: "primary",
  },
  {
    decision: "acceptForSession",
    label: "Always allow this session",
    description: "Don't ask again this session",
    tone: "neutral",
  },
  {
    decision: "decline",
    label: "Decline",
    description: "Reject and let the agent continue",
    tone: "destructive",
  },
  {
    decision: "cancel",
    label: "Cancel turn",
    description: "Stop the current turn",
    tone: "neutral",
  },
];

const KIND_PROMPT: Record<PendingApproval["requestKind"], string> = {
  command: "Approve this command?",
  "file-read": "Approve reading this file?",
  "file-change": "Approve this file change?",
  permissions: "Grant these permissions?",
};

export const ComposerPendingApprovalPanel = function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  isResponding,
  onRespond,
}: ComposerPendingApprovalPanelProps) {
  const parsed = parseApprovalDetail(approval.detail);
  const requestId = approval.requestId;
  const actions =
    approval.sessionApprovalAvailable === false
      ? APPROVAL_ACTIONS.filter((action) => action.decision !== "acceptForSession")
      : APPROVAL_ACTIONS;

  // Digit shortcuts bubble from focused controls inside this card only; a bare
  // number key elsewhere in the app must never approve a tool request.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isResponding || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (
      target instanceof HTMLElement &&
      target.closest('[contenteditable]:not([contenteditable="false"])')
    ) {
      return;
    }
    const digit = Number.parseInt(event.key, 10);
    if (Number.isNaN(digit) || digit < 1 || digit > actions.length) return;
    const action = actions[digit - 1];
    if (!action) return;
    event.preventDefault();
    void onRespond(requestId, action.decision, approval.lifecycleGeneration, approval.requestKind);
  };

  return (
    <div
      onKeyDown={handleKeyDown}
      className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "overflow-hidden px-3.5 py-3")}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-[13px] font-medium leading-snug text-foreground/90">
          {KIND_PROMPT[approval.requestKind]}
          {parsed.tool ? (
            <span className="ml-1.5 text-[11px] font-normal text-muted-foreground/50">
              {parsed.tool}
            </span>
          ) : null}
        </p>
        {pendingCount > 1 ? (
          <span className="flex h-4 shrink-0 items-center rounded bg-[var(--color-background-elevated-secondary)] px-1 text-[9.5px] font-medium tabular-nums text-[var(--color-text-foreground-secondary)]">
            1/{pendingCount}
          </span>
        ) : null}
      </div>
      <ApprovalDetail
        parsed={parsed}
        {...(approval.permissionProfile ? { permissionProfile: approval.permissionProfile } : {})}
      />
      <div className="mt-2.5 space-y-0.5">
        {actions.map((action, index) => (
          <ComposerChoiceRow
            key={action.decision}
            shortcut={index + 1}
            label={action.label}
            description={action.description}
            tone={action.tone}
            disabled={isResponding}
            onSelect={() =>
              void onRespond(
                requestId,
                action.decision,
                approval.lifecycleGeneration,
                approval.requestKind,
              )
            }
          />
        ))}
      </div>
    </div>
  );
};

function ApprovalDetail({
  parsed,
  permissionProfile,
}: {
  parsed: ParsedApproval;
  permissionProfile?: Record<string, unknown>;
}) {
  if (permissionProfile) {
    return (
      <div className="mt-2">
        {parsed.fallback ? (
          <p className="mb-1.5 text-[11.5px] leading-snug text-muted-foreground/70">
            {parsed.fallback}
          </p>
        ) : null}
        <pre
          className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-background-elevated-secondary)] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/85"
          title="Requested permission profile"
        >
          <code>{JSON.stringify(permissionProfile, null, 2)}</code>
        </pre>
      </div>
    );
  }

  if (parsed.fileName) {
    return (
      <div className="mt-2">
        <p
          className="truncate text-[12.5px] font-medium leading-tight text-foreground/85"
          title={parsed.fileDir ? `${parsed.fileDir}/${parsed.fileName}` : parsed.fileName}
        >
          {parsed.fileName}
        </p>
        {parsed.fileDir ? (
          <p
            className="mt-0.5 truncate font-mono text-[10.5px] leading-tight text-muted-foreground/55"
            title={parsed.fileDir}
          >
            {shortenPath(parsed.fileDir)}
          </p>
        ) : null}
      </div>
    );
  }

  const code = parsed.command ?? parsed.fallback;
  if (code) {
    return (
      <pre
        className="mt-2 overflow-hidden rounded-md bg-[var(--color-background-elevated-secondary)] px-2.5 py-1.5 font-mono text-[11.5px] leading-snug text-foreground/85"
        title={code}
      >
        <code className="block truncate">{code}</code>
      </pre>
    );
  }

  return (
    <p className="mt-2 text-[12px] text-muted-foreground/65">Review the request to continue.</p>
  );
}

/**
 * Parses the approval `detail` string into structured fields.
 *
 * Detail is produced server-side by `summarizeToolRequest` as
 * `"${toolName}: ${JSON.stringify(input)}"` and is clamped to ~400 characters.
 * That means JSON.parse often fails on truncated payloads like
 * `{"file_path":"/long/path","old_string":" .fo...`. We therefore try JSON
 * first and fall back to targeted regex extraction so we can still surface the
 * file path / command even from a chopped-off string.
 */
function parseApprovalDetail(detail: string | undefined): ParsedApproval {
  const empty: ParsedApproval = {
    tool: null,
    fileName: null,
    fileDir: null,
    command: null,
    fallback: null,
  };
  if (!detail || detail.length === 0) return empty;

  const colonIdx = detail.indexOf(": ");
  const tool = colonIdx === -1 ? null : detail.slice(0, colonIdx).trim() || null;
  const rawPayload = colonIdx === -1 ? detail : detail.slice(colonIdx + 2);
  const payload = stripTrailingEllipsis(rawPayload);

  const filePath =
    extractJsonString(payload, ["file_path", "path", "notebook_path", "filepath"]) ?? null;
  if (filePath) {
    const { name, parent } = splitPath(filePath);
    return { tool, fileName: name, fileDir: parent, command: null, fallback: null };
  }

  const command = extractJsonString(payload, ["command", "cmd"]) ?? null;
  if (command) {
    return {
      tool,
      fileName: null,
      fileDir: null,
      command: collapseWhitespace(command),
      fallback: null,
    };
  }

  const pattern = extractJsonString(payload, ["pattern", "query"]);
  if (pattern) {
    return {
      tool,
      fileName: null,
      fileDir: null,
      command: pattern,
      fallback: null,
    };
  }

  const url = extractJsonString(payload, ["url"]);
  if (url) {
    return { tool, fileName: null, fileDir: null, command: url, fallback: null };
  }

  // Payload is not a recognized JSON shape — treat it as a raw command/text.
  const fallback = collapseWhitespace(payload);
  return {
    tool,
    fileName: null,
    fileDir: null,
    command: null,
    fallback: fallback.length > 0 ? fallback : null,
  };
}

/**
 * Extracts the first matching string field from a (possibly truncated) JSON
 * object. Prefers a real JSON.parse when it succeeds, otherwise falls back to
 * a permissive regex that tolerates truncation mid-value.
 */
function extractJsonString(payload: string, keys: ReadonlyArray<string>): string | null {
  const parsed = tryParseJson(payload);
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }

  for (const key of keys) {
    const value = regexExtractString(payload, key);
    if (value && value.length > 0) {
      return value;
    }
  }
  return null;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Pulls a JSON string value for `key` out of a possibly truncated JSON-ish
 * payload. Handles the common `\"` and `\\` escapes inside the string body.
 * If the value is unterminated (truncation), returns whatever was captured.
 */
function regexExtractString(payload: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Anchored to `"key"` followed by a colon and an opening quote.
  const pattern = new RegExp(`"${escapedKey}"\\s*:\\s*"`, "g");
  const match = pattern.exec(payload);
  if (!match) return null;

  const start = match.index + match[0].length;
  let out = "";
  for (let i = start; i < payload.length; i++) {
    const ch = payload[i];
    if (ch === "\\") {
      const next = payload[i + 1];
      if (next === undefined) break;
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else out += next;
      i += 1;
      continue;
    }
    if (ch === '"') {
      return out;
    }
    out += ch;
  }
  // Truncated before closing quote — return partial value if we got anything.
  return out.length > 0 ? out : null;
}

function stripTrailingEllipsis(value: string): string {
  return value.replace(/\.{3}$/u, "").replace(/…$/u, "");
}

function splitPath(path: string): { name: string; parent: string | null } {
  const normalized = path.replace(/\\/g, "/");
  const trimmed = normalized.replace(/\/+$/, "");
  const lastSep = trimmed.lastIndexOf("/");
  if (lastSep === -1) {
    return { name: trimmed, parent: null };
  }
  return {
    name: trimmed.slice(lastSep + 1) || trimmed,
    parent: trimmed.slice(0, lastSep) || null,
  };
}

function shortenPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const homeMatch = normalized.match(/^\/(?:Users|home)\/[^/]+(?=\/|$)/);
  const withoutHome = homeMatch ? `~${normalized.slice(homeMatch[0].length)}` : normalized;
  const segments = withoutHome.split("/").filter((s) => s.length > 0);
  if (segments.length <= 3) {
    return withoutHome;
  }
  const leading = withoutHome.startsWith("~") ? "~" : "";
  const tail = segments.slice(-2).join("/");
  return `${leading}/…/${tail}`.replace(/^\/…/, "…");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
