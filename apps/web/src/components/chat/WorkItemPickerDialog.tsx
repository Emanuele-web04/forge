// FILE: WorkItemPickerDialog.tsx
// Purpose: Search and attach GitHub issues / PRs to the composer.

import type { WorkItemAttachment } from "@synara/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { workItemKey, WORK_ITEM_ATTACHMENT_LIMIT } from "~/lib/composerWorkItems";
import { useDebouncedWorkItemsSearch } from "~/lib/workItemReactQuery";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { WorkItemAttachmentChip } from "./WorkItemAttachmentChip";

export interface WorkItemPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cwd: string | null;
  selectedItems: WorkItemAttachment[];
  onSelect: (item: WorkItemAttachment) => void;
  onRemove: (itemKey: string) => void;
}

export function WorkItemPickerDialog({
  open,
  onOpenChange,
  cwd,
  selectedItems,
  onSelect,
  onRemove,
}: WorkItemPickerDialogProps) {
  const [query, setQuery] = useState("");
  const search = useDebouncedWorkItemsSearch(cwd, query, open);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      const handle = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(handle);
    }
    setQuery("");
  }, [open]);

  const selectedKeys = useMemo(
    () => new Set(selectedItems.map((item) => workItemKey(item))),
    [selectedItems],
  );
  const isFull = selectedItems.length >= WORK_ITEM_ATTACHMENT_LIMIT;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Attach issue or PR</DialogTitle>
          <DialogDescription>
            Search the current project repository for issues and pull requests.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={cwd ? "Search issues and PRs" : "No project directory"}
            disabled={!cwd}
          />

          {isFull ? (
            <p className="text-xs text-muted-foreground">
              You can attach up to 5 issues or PRs. Remove one to add more.
            </p>
          ) : null}

          <div className="min-h-[12rem]">
            {search.isLoading ? (
              <div className="flex h-24 items-center justify-center">
                <Spinner className="size-4" />
              </div>
            ) : search.error || search.data?.available === false ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                <p className="text-sm text-muted-foreground">
                  {search.error instanceof Error
                    ? search.error.message
                    : (search.data?.errorHint ??
                      "GitHub search is not available for this project.")}
                </p>
                <Button variant="secondary" size="sm" onClick={() => void search.refetch()}>
                  Retry
                </Button>
              </div>
            ) : search.data?.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {query.length === 0
                  ? "No recent open issues or PRs found."
                  : "No matching issues or PRs found."}
              </p>
            ) : (
              <ScrollArea className="max-h-64">
                <ul className="space-y-1">
                  {search.data?.items.map((item) => {
                    const key = workItemKey(item);
                    const selected = selectedKeys.has(key);
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          disabled={selected || isFull}
                          onClick={() => onSelect(item)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                            selected
                              ? "bg-[var(--color-background-button-secondary-hover)] text-muted-foreground"
                              : "hover:bg-[var(--color-background-button-secondary-hover)]",
                            isFull && !selected && "opacity-50",
                          )}
                        >
                          <span
                            className={cn(
                              "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold",
                              item.kind === "issue"
                                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                                : "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
                            )}
                          >
                            {item.kind === "issue" ? "Issue" : "PR"}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-medium">
                            #{item.number} {item.title}
                          </span>
                          {selected ? (
                            <span className="text-[10px] text-muted-foreground">Attached</span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </ScrollArea>
            )}
          </div>

          {selectedItems.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 border-t border-border pt-3">
              {selectedItems.map((item) => (
                <WorkItemAttachmentChip
                  key={workItemKey(item)}
                  item={item}
                  onRemove={() => onRemove(workItemKey(item))}
                />
              ))}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="secondary">Done</Button>} />
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
