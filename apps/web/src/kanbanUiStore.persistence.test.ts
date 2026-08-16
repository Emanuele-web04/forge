import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { useKanbanUiStore } from "./kanbanUiStore";

function installMemoryLocalStorage() {
  const entries = new Map<string, string>();

  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      entries.delete(key);
    }),
    clear: vi.fn(() => {
      entries.clear();
    }),
    key: vi.fn((index: number) => Array.from(entries.keys())[index] ?? null),
    get length() {
      return entries.size;
    },
  });
}

type KanbanUiStore = typeof useKanbanUiStore;

function getPersistApi(store: KanbanUiStore) {
  return store.persist as unknown as {
    getOptions: () => {
      partialize: (state: ReturnType<typeof store.getState>) => unknown;
      merge: (
        persistedState: unknown,
        currentState: ReturnType<typeof store.getState>,
      ) => ReturnType<typeof store.getState>;
    };
  };
}

describe("kanbanUiStore view-mode persistence", () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to the v2 board in fresh state", async () => {
    const { useKanbanUiStore } = await import("./kanbanUiStore");
    const store = useKanbanUiStore as KanbanUiStore;
    expect(store.getState().kanbanViewMode).toBe("v2");
    expect(store.getState().kanbanNeedsReviewFilter).toBe(false);
  });

  it("round-trips a persisted classic mode through partialize and merge", async () => {
    const { useKanbanUiStore } = await import("./kanbanUiStore");
    const store = useKanbanUiStore as KanbanUiStore;
    store.setState((state) => ({
      ...state,
      kanbanViewMode: "classic",
      kanbanNeedsReviewFilter: true,
    }));
    const persistedState = getPersistApi(store)
      .getOptions()
      .partialize(store.getState()) as Partial<ReturnType<typeof store.getState>>;

    expect(persistedState.kanbanViewMode).toBe("classic");
    expect(persistedState.kanbanNeedsReviewFilter).toBe(true);

    const merged = getPersistApi(store).getOptions().merge(persistedState, store.getInitialState());
    expect(merged.kanbanViewMode).toBe("classic");
    expect(merged.kanbanNeedsReviewFilter).toBe(true);
  });

  it("sanitizes unknown persisted view modes back to v2", async () => {
    const { useKanbanUiStore } = await import("./kanbanUiStore");
    const store = useKanbanUiStore as KanbanUiStore;
    const merged = getPersistApi(store)
      .getOptions()
      .merge({ kanbanViewMode: "fancy", kanbanNeedsReviewFilter: "yes" }, store.getInitialState());
    expect(merged.kanbanViewMode).toBe("v2");
    expect(merged.kanbanNeedsReviewFilter).toBe(false);
  });

  it("sanitizes legacy persisted drafts that lack the new fields", async () => {
    const { useKanbanUiStore } = await import("./kanbanUiStore");
    const store = useKanbanUiStore as KanbanUiStore;
    const merged = getPersistApi(store)
      .getOptions()
      .merge({ draftOrderByProjectId: { "proj-1": ["card-a"] } }, store.getInitialState());
    expect(merged.kanbanViewMode).toBe("v2");
    expect(merged.kanbanNeedsReviewFilter).toBe(false);
    expect(merged.draftOrderByProjectId).toEqual({ "proj-1": ["card-a"] });
  });

  it("excludes ephemeral optimistic-dispatch state from persistence", async () => {
    const { useKanbanUiStore } = await import("./kanbanUiStore");
    const store = useKanbanUiStore as KanbanUiStore;
    const persistedState = getPersistApi(store)
      .getOptions()
      .partialize(store.getState()) as Partial<ReturnType<typeof store.getState>>;
    expect(persistedState.optimisticDispatchByThreadId).toBeUndefined();
  });

  it("round-trips a revealed needs-review fold through partialize and merge", async () => {
    const { useKanbanUiStore } = await import("./kanbanUiStore");
    const store = useKanbanUiStore as KanbanUiStore;
    store.setState((state) => ({
      ...state,
      kanbanNeedsReviewFilter: true,
      hasRevealedReviewFold: true,
    }));
    const persistedState = getPersistApi(store)
      .getOptions()
      .partialize(store.getState()) as Partial<ReturnType<typeof store.getState>>;

    expect(persistedState.hasRevealedReviewFold).toBe(true);

    const merged = getPersistApi(store).getOptions().merge(persistedState, store.getInitialState());
    expect(merged.hasRevealedReviewFold).toBe(true);
    expect(merged.kanbanNeedsReviewFilter).toBe(true);
  });

  it("sanitizes a non-boolean persisted reveal back to the folded default", async () => {
    const { useKanbanUiStore } = await import("./kanbanUiStore");
    const store = useKanbanUiStore as KanbanUiStore;
    const merged = getPersistApi(store)
      .getOptions()
      .merge({ hasRevealedReviewFold: "yes" }, store.getInitialState());
    expect(merged.hasRevealedReviewFold).toBe(false);
  });

  it("turns the filter off with the reveal so a stale fold never persists alone (H1)", async () => {
    const { useKanbanUiStore } = await import("./kanbanUiStore");
    const store = useKanbanUiStore as KanbanUiStore;
    store.setState((state) => ({
      ...state,
      kanbanNeedsReviewFilter: true,
      hasRevealedReviewFold: true,
    }));
    store.getState().setKanbanNeedsReviewFilter(false);
    const state = store.getState();
    expect(state.kanbanNeedsReviewFilter).toBe(false);
    expect(state.hasRevealedReviewFold).toBe(false);
  });
});
