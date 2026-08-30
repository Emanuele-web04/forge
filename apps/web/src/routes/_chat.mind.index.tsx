import type {
  MindListResult,
  MindMemory,
  MindMemoryMatch,
  MindRecallResult,
  ProjectId,
} from "@synara/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "~/components/chat/chatHeaderControls";
import { CHAT_BACKGROUND_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { ComposerPickerSelectPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { toastManager } from "~/components/ui/toast";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { CentralIcon } from "~/lib/central-icons";
import {
  DISCLOSURE_INNER_CLASS,
  disclosureChevronClassName,
  disclosureContentClassName,
  disclosureShellClassName,
} from "~/lib/disclosureMotion";
import { cn } from "~/lib/utils";
import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";

export interface MindSearch {
  readonly projectId?: ProjectId;
  readonly q?: string;
}

const SEARCH_DEBOUNCE_MS = 200;

export const Route = createFileRoute("/_chat/mind/")({
  validateSearch: (raw: Record<string, unknown>): MindSearch => {
    const projectId =
      typeof raw.projectId === "string" && raw.projectId ? (raw.projectId as ProjectId) : undefined;
    const q = typeof raw.q === "string" && raw.q ? raw.q.slice(0, 200) : undefined;
    return {
      ...(projectId ? { projectId } : {}),
      ...(q ? { q } : {}),
    };
  },
  component: MindRouteView,
});

function useMindProjectId(search: MindSearch): ProjectId | null {
  const projects = useStore((state) => state.projects);
  return useMemo(() => {
    if (search.projectId && projects.some((project) => project.id === search.projectId)) {
      return search.projectId;
    }
    return projects[0]?.id ?? null;
  }, [projects, search.projectId]);
}

function MindRouteView() {
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  const projectId = useMindProjectId(search);
  const projects = useStore((state) => state.projects);
  const project = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  const [inputQuery, setInputQuery] = useState(search.q ?? "");
  const [memories, setMemories] = useState<readonly MindMemory[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());

  const trafficLightGutter = useDesktopTopBarTrafficLightGutterClassName();
  const windowControlsGutter = useDesktopTopBarWindowControlsGutterClassName();

  useEffect(() => {
    setInputQuery(search.q ?? "");
  }, [search.q]);

  useEffect(() => {
    const trimmed = inputQuery.trim();
    if (trimmed === (search.q ?? "")) return;
    const timer = window.setTimeout(() => {
      void navigate({
        search: () => ({
          ...(projectId ? { projectId } : {}),
          ...(trimmed ? { q: trimmed } : {}),
        }),
        replace: true,
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [inputQuery, projectId, search.q, navigate]);

  const load = useCallback(async () => {
    if (!projectId) {
      setMemories([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const api = ensureNativeApi();
      const query = search.q?.trim();
      if (query) {
        const result: MindRecallResult = await api.mind.search({
          projectId,
          query,
        });
        setMemories(result.items.map((match: MindMemoryMatch) => match.memory));
      } else {
        const result: MindListResult = await api.mind.list({ projectId });
        setMemories(result.memories);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load memories.");
    } finally {
      setIsLoading(false);
    }
  }, [projectId, search.q]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateSearch = useCallback(
    (patch: Partial<MindSearch>) => {
      void navigate({
        search: (prev) => ({
          ...(prev.projectId ? { projectId: prev.projectId } : {}),
          ...(patch.projectId ? { projectId: patch.projectId } : {}),
          ...(prev.q ? { q: prev.q } : {}),
          ...(patch.q ? { q: patch.q } : {}),
        }),
        replace: true,
      });
    },
    [navigate],
  );

  const toggleExpanded = useCallback((memoryId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(memoryId)) {
        next.delete(memoryId);
      } else {
        next.add(memoryId);
      }
      return next;
    });
  }, []);

  const handleTogglePin = useCallback(
    async (memory: MindMemory) => {
      if (!projectId) return;
      try {
        await ensureNativeApi().mind.pin({
          projectId,
          memoryId: memory.memoryId,
          pinned: !memory.pinned,
        });
        void load();
      } catch (err) {
        toastManager.add({
          type: "error",
          title: "Could not update pin",
          description: err instanceof Error ? err.message : "The pin status could not be saved.",
        });
      }
    },
    [projectId, load],
  );

  const handleForget = useCallback(
    async (memory: MindMemory) => {
      if (!projectId) return;
      const confirmed = await ensureNativeApi().dialogs.confirm("Delete this memory?");
      if (!confirmed) return;
      try {
        await ensureNativeApi().mind.forget({
          projectId,
          memoryId: memory.memoryId,
        });
        void load();
      } catch (err) {
        toastManager.add({
          type: "error",
          title: "Could not delete memory",
          description: err instanceof Error ? err.message : "The memory could not be deleted.",
        });
      }
    },
    [projectId, load],
  );

  const projectOptions = useMemo(
    () =>
      projects.map((p) => (
        <SelectItem key={p.id} value={p.id}>
          <span className="truncate">{p.name}</span>
        </SelectItem>
      )),
    [projects],
  );

  const isExpanded = (memoryId: string) => expandedIds.has(memoryId);

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
            trafficLightGutter,
            windowControlsGutter,
          )}
        >
          <div className={cn("flex items-center gap-2 sm:gap-3", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}>
            <SidebarHeaderNavigationControls />
            <h1 className="truncate font-heading text-sm font-medium">Mind</h1>
            <div className="min-w-0 flex-1" />
            <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh"
                title="Refresh"
                disabled={!projectId || isLoading}
                onClick={() => void load()}
              >
                <CentralIcon
                  name="arrow-rotate-clockwise"
                  className={cn("size-4", isLoading && "animate-spin")}
                />
              </Button>
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 pb-12 pt-6 sm:px-7">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                {projects.length > 0 ? (
                  <Select
                    value={projectId ?? ""}
                    onValueChange={(value) => {
                      if (!value) return;
                      updateSearch({ projectId: value as ProjectId });
                    }}
                  >
                    <SelectTrigger aria-label="Project" className="w-full sm:w-56">
                      <SelectValue>
                        {project ? (
                          <span className="truncate">{project.name}</span>
                        ) : (
                          <span className="text-muted-foreground">Select a project</span>
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <ComposerPickerSelectPopup>
                      <SelectItem value="" disabled>
                        <span className="text-muted-foreground">Select a project</span>
                      </SelectItem>
                      {projectOptions}
                    </ComposerPickerSelectPopup>
                  </Select>
                ) : (
                  <div className="text-sm text-muted-foreground">No projects yet.</div>
                )}
              </div>
              <div className="min-w-0 flex-[2]">
                <Input
                  type="search"
                  placeholder="Search memories"
                  value={inputQuery}
                  onChange={(event) => setInputQuery(event.target.value)}
                  disabled={!projectId}
                />
              </div>
            </div>

            {error ? (
              <div className="py-8 text-center text-sm text-destructive">{error}</div>
            ) : isLoading && memories.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted-foreground">
                Loading memories...
              </div>
            ) : !projectId ? (
              <div className="flex flex-col items-center gap-1 py-16 text-center">
                <p className="text-sm font-medium text-foreground">No project selected</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Select a project to view its durable memories.
                </p>
              </div>
            ) : memories.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-16 text-center">
                <p className="text-sm font-medium text-foreground">
                  Mind is where Synara keeps durable facts for this project.
                </p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Remember something above, or ask an agent to remember it for you.
                </p>
              </div>
            ) : (
              <section className="flex flex-col gap-2">
                {memories.map((memory) => {
                  const open = isExpanded(memory.memoryId);
                  return (
                    <div
                      key={memory.memoryId}
                      className={cn(
                        "rounded-lg border border-transparent px-2 py-2.5",
                        ELEVATED_HOVER_SURFACE_CLASS_NAME,
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <button
                          type="button"
                          onClick={() => toggleExpanded(memory.memoryId)}
                          className={cn(
                            "mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground",
                            disclosureChevronClassName(open),
                          )}
                          aria-expanded={open}
                          aria-label="Toggle details"
                          title="Details"
                        >
                          <CentralIcon name="chevron-right-small" className="size-3.5" />
                        </button>
                        <span className="min-w-0 flex-1 text-[0.8125rem] text-foreground">
                          {memory.text}
                        </span>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label={memory.pinned ? "Unpin memory" : "Pin memory"}
                            title={memory.pinned ? "Unpin" : "Pin"}
                            onClick={() => void handleTogglePin(memory)}
                          >
                            <CentralIcon
                              name="pin"
                              className={cn(
                                "size-3.5",
                                memory.pinned ? "text-foreground" : "text-muted-foreground/50",
                              )}
                            />
                          </Button>
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label="Delete memory"
                            title="Delete"
                            onClick={() => void handleForget(memory)}
                          >
                            <CentralIcon
                              name="trash-can-simple"
                              className="size-3.5 text-muted-foreground hover:text-destructive"
                            />
                          </Button>
                        </div>
                      </div>

                      <div className={cn("col-span-full", disclosureShellClassName(open))}>
                        <div className={DISCLOSURE_INNER_CLASS}>
                          <div
                            className={cn(
                              "flex flex-col gap-1 px-5 pb-1 pt-2 text-xs text-muted-foreground",
                              disclosureContentClassName(open),
                            )}
                          >
                            <span>Weight: {memory.weight.toFixed(2)}</span>
                            <span>
                              {memory.pinned ? "Pinned" : "Not pinned"} · Accessed{" "}
                              {memory.accessCount} times
                            </span>
                            <span className="text-muted-foreground/60">
                              Created {new Date(memory.createdAt).toLocaleString()} · Updated{" "}
                              {new Date(memory.updatedAt).toLocaleString()}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </section>
            )}
          </div>
        </main>
      </div>
    </RouteInsetSurface>
  );
}
