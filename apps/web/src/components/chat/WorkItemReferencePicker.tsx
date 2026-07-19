// FILE: WorkItemReferencePicker.tsx
// Purpose: Dialog to search/select Linear issues or GitHub issues/PRs as composer references.
// Layer: Chat composer presentation

import {
  type WorkItemAuthStatus,
  type WorkItemSearchHit,
  type WorkItemSource,
  type WorkItemReference,
} from "@synara/contracts";
import { useCallback, useEffect, useId, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { parseWorkItemUrl, workItemSourceLabel } from "~/lib/workItemReferences";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { cn } from "~/lib/utils";

type PickerTab = WorkItemSource;

const TABS: ReadonlyArray<{ id: PickerTab; label: string }> = [
  { id: "linear-issue", label: "Linear" },
  { id: "github-issue", label: "Issues" },
  { id: "github-pr", label: "PRs" },
];

function authStatusMessage(status: WorkItemAuthStatus, message: string | null): string {
  if (message && message.trim().length > 0) {
    return message;
  }
  switch (status) {
    case "gh-not-installed":
      return "GitHub CLI (`gh`) is required but not available on PATH.";
    case "gh-not-authenticated":
      return "GitHub CLI is not authenticated. Run `gh auth login` and retry.";
    case "linear-key-missing":
      return "Add a Linear API key in Settings → Integrations to search issues.";
    case "linear-key-invalid":
      return "Linear API key is invalid. Update it in Settings and try again.";
    case "unavailable":
      return "Unable to load work items right now.";
    case "ready":
      return "";
  }
}

export function WorkItemReferencePicker(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cwd: string | null;
  repository: string | null;
  onSelect: (reference: WorkItemReference) => void;
}) {
  const { open, onOpenChange, cwd, repository, onSelect } = props;
  const searchInputId = useId();
  const [tab, setTab] = useState<PickerTab>("linear-issue");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ReadonlyArray<WorkItemSearchHit>>([]);
  const [authStatus, setAuthStatus] = useState<WorkItemAuthStatus>("ready");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attachingId, setAttachingId] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);

  const runSearch = useCallback(
    async (nextTab: PickerTab, nextQuery: string) => {
      if (!cwd && nextTab !== "linear-issue") {
        setItems([]);
        setAuthStatus("unavailable");
        setStatusMessage("Open a project workspace to browse GitHub issues and PRs.");
        return;
      }
      setLoading(true);
      setPasteError(null);
      try {
        const result = await ensureNativeApi().workItems.search({
          cwd: cwd ?? "/",
          repository,
          source: nextTab,
          query: nextQuery,
          limit: 20,
        });
        setItems(result.items);
        setAuthStatus(result.authStatus);
        setStatusMessage(result.message);
      } catch (error) {
        setItems([]);
        setAuthStatus("unavailable");
        setStatusMessage(error instanceof Error ? error.message : "Search failed.");
      } finally {
        setLoading(false);
      }
    },
    [cwd, repository],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const handle = window.setTimeout(() => {
      void runSearch(tab, query);
    }, 200);
    return () => window.clearTimeout(handle);
  }, [open, tab, query, runSearch]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setPasteError(null);
      setAttachingId(null);
    }
  }, [open]);

  const attachHit = async (hit: WorkItemSearchHit) => {
    if (!cwd) {
      return;
    }
    setAttachingId(hit.id);
    setPasteError(null);
    try {
      const result = await ensureNativeApi().workItems.get({
        cwd,
        repository: hit.repository ?? repository,
        source: hit.source,
        reference: hit.source === "linear-issue" ? hit.identifier : hit.id,
      });
      if (!result.item) {
        setPasteError(authStatusMessage(result.authStatus, result.message));
        return;
      }
      onSelect(result.item);
      onOpenChange(false);
    } catch (error) {
      setPasteError(error instanceof Error ? error.message : "Failed to attach reference.");
    } finally {
      setAttachingId(null);
    }
  };

  const attachFromPaste = async () => {
    const parsed = parseWorkItemUrl(query);
    if (!parsed) {
      // Also allow bare Linear identifiers / issue numbers in the search field.
      if (/^[A-Za-z]+-\d+$/.test(query.trim()) || /^\d+$/.test(query.trim())) {
        if (!cwd) {
          setPasteError("Open a project workspace first.");
          return;
        }
        setAttachingId(query.trim());
        try {
          const result = await ensureNativeApi().workItems.get({
            cwd,
            repository,
            source: /^[A-Za-z]+-\d+$/.test(query.trim())
              ? "linear-issue"
              : tab === "github-pr"
                ? "github-pr"
                : "github-issue",
            reference: query.trim(),
          });
          if (!result.item) {
            setPasteError(authStatusMessage(result.authStatus, result.message));
            return;
          }
          onSelect(result.item);
          onOpenChange(false);
        } catch (error) {
          setPasteError(error instanceof Error ? error.message : "Failed to attach reference.");
        } finally {
          setAttachingId(null);
        }
        return;
      }
      setPasteError("Paste a GitHub issue/PR URL or Linear issue URL, or search below.");
      return;
    }
    if (!cwd && parsed.source !== "linear-issue") {
      setPasteError("Open a project workspace to attach GitHub references.");
      return;
    }
    setAttachingId(parsed.reference);
    try {
      const result = await ensureNativeApi().workItems.get({
        // Linear fetch ignores cwd; GitHub paths require a real workspace root.
        cwd: cwd ?? "/",
        repository: parsed.repository ?? repository,
        source: parsed.source,
        reference: parsed.url,
      });
      if (!result.item) {
        setPasteError(authStatusMessage(result.authStatus, result.message));
        return;
      }
      onSelect(result.item);
      onOpenChange(false);
    } catch (error) {
      setPasteError(error instanceof Error ? error.message : "Failed to attach reference.");
    } finally {
      setAttachingId(null);
    }
  };

  const emptyAuthMessage =
    authStatus !== "ready" ? authStatusMessage(authStatus, statusMessage) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add reference</DialogTitle>
          <DialogDescription>
            Attach a Linear ticket, GitHub issue, or pull request as context for this chat.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="flex gap-1 rounded-md bg-muted/50 p-1">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={cn(
                  "flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors",
                  tab === entry.id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <label htmlFor={searchInputId} className="sr-only">
              Search or paste URL
            </label>
            <div className="flex gap-2">
              <input
                id={searchInputId}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={
                  tab === "linear-issue"
                    ? "Search Linear or paste linear.app/…/issue/ENG-12"
                    : tab === "github-pr"
                      ? "Search PRs or paste github.com/…/pull/42"
                      : "Search issues or paste github.com/…/issues/42"
                }
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void attachFromPaste();
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void attachFromPaste()}
                disabled={attachingId !== null}
              >
                Attach
              </Button>
            </div>
            {pasteError ? <p className="text-xs text-destructive">{pasteError}</p> : null}
            {tab !== "linear-issue" && !repository ? (
              <p className="text-xs text-muted-foreground">
                No GitHub repository detected for this workspace.
              </p>
            ) : null}
          </div>

          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            {loading ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">Searching…</p>
            ) : emptyAuthMessage ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {emptyAuthMessage}
              </p>
            ) : items.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                No {workItemSourceLabel(tab).toLowerCase()}s found.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((item) => (
                  <li key={`${item.source}:${item.id}`}>
                    <button
                      type="button"
                      className="flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 disabled:opacity-60"
                      disabled={attachingId !== null}
                      onClick={() => void attachHit(item)}
                    >
                      <span className="text-xs font-medium text-muted-foreground">
                        {item.identifier}
                        {attachingId === item.id ? " · attaching…" : ""}
                      </span>
                      <span className="text-sm font-medium leading-snug">{item.title}</span>
                      {item.bodyPreview ? (
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {item.bodyPreview}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
