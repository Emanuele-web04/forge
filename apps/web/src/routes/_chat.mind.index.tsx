import { type MindListResult, type MindMemory, type MindMemoryType } from "@synara/contracts";
import { type VariantProps } from "class-variance-authority";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "~/components/chat/chatHeaderControls";
import { CHAT_BACKGROUND_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge, badgeVariants } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { SearchInput } from "~/components/ui/search-input";
import { toastManager } from "~/components/ui/toast";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { CentralIcon } from "~/lib/central-icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { pinActionLabel, PinStatusIcon } from "~/lib/pin";
import { cn } from "~/lib/utils";
import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";

export const Route = createFileRoute("/_chat/mind/")({
  component: MindRouteView,
});

const mindQueryKey = ["mind"] as const;

const EMPTY_MIND_LIST: MindListResult = { memories: [], count: 0, cap: 0 };

/** Quiet color coding for the four memory types, from the shared badge variants. */
type MindBadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;
const MIND_TYPE_BADGE_VARIANT: Record<MindMemoryType, MindBadgeVariant> = {
  decision: "info",
  procedural: "secondary",
  semantic: "outline",
  episodic: "warning",
};

/**
 * Mind list row: a leading type badge, a two-line text/detail stack, and trailing
 * pin toggle plus hover-reveal delete. Not clickable — there is no memory detail
 * surface; the row is the whole interaction (pin, delete).
 */
function MindListRow({
  memory,
  projectName,
  onTogglePinned,
  onDelete,
}: {
  readonly memory: MindMemory;
  readonly projectName: string;
  readonly onTogglePinned: () => void;
  readonly onDelete: () => void;
}) {
  const pinLabel = pinActionLabel("memory", memory.pinned);
  return (
    <div
      className={cn(
        "group flex w-full items-start gap-2.5 rounded-md px-2 py-2.5 text-left",
        ELEVATED_HOVER_SURFACE_CLASS_NAME,
      )}
    >
      <span className="mt-0.5 flex shrink-0">
        <Badge size="sm" variant={MIND_TYPE_BADGE_VARIANT[memory.type]} className="capitalize">
          {memory.type}
        </Badge>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[0.8125rem] text-foreground">{memory.text}</span>
        <span className="truncate text-xs text-muted-foreground">
          {projectName} · {formatRelativeTime(memory.createdAt)} · weight {memory.weight.toFixed(2)}
          {memory.pinned ? " · pinned" : ""}
        </span>
      </span>
      <button
        type="button"
        aria-label={pinLabel}
        title={pinLabel}
        onClick={onTogglePinned}
        className="shrink-0 self-center rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <PinStatusIcon pinned={memory.pinned} className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Delete memory"
        title="Delete"
        onClick={onDelete}
        className="shrink-0 self-center rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        <CentralIcon name="trash-can-simple" className="size-3.5" />
      </button>
    </div>
  );
}

function MindRouteView() {
  const queryClient = useQueryClient();
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const projects = useStore((state) => state.projects);
  const [search, setSearch] = useState("");

  const mindQuery = useQuery({
    queryKey: mindQueryKey,
    queryFn: () => ensureNativeApi().mind.list({}),
  });
  const data = mindQuery.data ?? EMPTY_MIND_LIST;

  // Optimistic removal: the row disappears immediately; the server's forget is
  // idempotent, so the invalidate-on-settle only converges the count/cap meta.
  const forgetMutation = useMutation({
    mutationFn: (memory: MindMemory) =>
      ensureNativeApi().mind.forget({ memoryId: memory.memoryId }),
    onMutate: async (memory) => {
      await queryClient.cancelQueries({ queryKey: mindQueryKey });
      const previous = queryClient.getQueryData<MindListResult>(mindQueryKey);
      queryClient.setQueryData<MindListResult>(mindQueryKey, (prev) =>
        prev
          ? {
              memories: prev.memories.filter((item) => item.memoryId !== memory.memoryId),
              count: Math.max(0, prev.count - 1),
              cap: prev.cap,
            }
          : prev,
      );
      return { previous };
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: mindQueryKey }),
    onError: (error, _memory, context) => {
      if (context?.previous) queryClient.setQueryData(mindQueryKey, context.previous);
      toastManager.add({ type: "error", title: error.message });
    },
  });

  // Optimistic pin flip, same rollback shape as forget.
  const setPinnedMutation = useMutation({
    mutationFn: (input: { readonly memory: MindMemory; readonly pinned: boolean }) =>
      ensureNativeApi().mind.setPinned({ memoryId: input.memory.memoryId, pinned: input.pinned }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: mindQueryKey });
      const previous = queryClient.getQueryData<MindListResult>(mindQueryKey);
      queryClient.setQueryData<MindListResult>(mindQueryKey, (prev) =>
        prev
          ? {
              ...prev,
              memories: prev.memories.map((item) =>
                item.memoryId === input.memory.memoryId ? { ...item, pinned: input.pinned } : item,
              ),
            }
          : prev,
      );
      return { previous };
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: mindQueryKey }),
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(mindQueryKey, context.previous);
      toastManager.add({ type: "error", title: error.message });
    },
  });

  const projectNamesById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  // The server already returns weight-desc; re-sort so optimistic pin/weight edits
  // and any out-of-order cache merges keep the same order the server would send.
  const sortedMemories = useMemo(
    () =>
      [...data.memories].toSorted(
        (a, b) => b.weight - a.weight || a.memoryId.localeCompare(b.memoryId),
      ),
    [data.memories],
  );
  const filteredMemories = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query.length === 0) return sortedMemories;
    return sortedMemories.filter(
      (memory) =>
        memory.text.toLowerCase().includes(query) ||
        (projectNamesById.get(memory.projectId) ?? "").toLowerCase().includes(query),
    );
  }, [sortedMemories, search, projectNamesById]);

  const renderMindList = () => (
    <section className="flex flex-col gap-2">
      {filteredMemories.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-2 py-4 text-xs text-muted-foreground">
          <span>No memories match — clear search.</span>
          <Button variant="outline" size="sm" onClick={() => setSearch("")}>
            Clear search
          </Button>
        </div>
      ) : (
        <div className="flex flex-col">
          {filteredMemories.map((memory) => (
            <MindListRow
              key={memory.memoryId}
              memory={memory}
              projectName={projectNamesById.get(memory.projectId) ?? "Unknown project"}
              onTogglePinned={() => setPinnedMutation.mutate({ memory, pinned: !memory.pinned })}
              onDelete={() => forgetMutation.mutate(memory)}
            />
          ))}
        </div>
      )}
    </section>
  );

  return (
    <RouteInsetSurface>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        <header
          className={cn(
            CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
            CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            "drag-region",
            desktopTopBarTrafficLightGutterClassName,
            desktopTopBarWindowControlsGutterClassName,
          )}
        >
          <div className={cn("flex items-center gap-2 sm:gap-3", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}>
            <SidebarHeaderNavigationControls />
            <div className="min-w-0 flex-1" />
            <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
              <SearchInput
                aria-label="Search memories"
                placeholder="Search memories"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="w-56"
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh"
                title="Refresh"
                onClick={() => void mindQuery.refetch()}
              >
                <CentralIcon name="arrow-rotate-clockwise" className="size-4" />
              </Button>
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-12 pt-8">
            <h1 className="px-2 font-heading text-2xl font-semibold tracking-tight text-foreground">
              Mind
            </h1>
            {mindQuery.isError ? (
              <Alert variant="error" size="sm" className="text-destructive">
                <AlertDescription>
                  <span>
                    {mindQuery.error instanceof Error
                      ? mindQuery.error.message
                      : "Failed to load memories."}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => void mindQuery.refetch()}>
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : mindQuery.isLoading ? (
              <div className="py-16 text-center text-sm text-muted-foreground">
                Loading memories...
              </div>
            ) : data.memories.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-16 text-center">
                <p className="max-w-md text-sm font-medium text-foreground">
                  Mind is Synara's shared memory for your projects. Agents save durable decisions
                  and conventions here and recall them in any provider's session.
                </p>
                <p className="text-xs text-muted-foreground">Agents save memories as you work.</p>
              </div>
            ) : (
              renderMindList()
            )}
          </div>
        </main>
      </div>
    </RouteInsetSurface>
  );
}
