import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { useKanbanUiStore } from "./kanbanUiStore";

type KanbanUiStore = typeof useKanbanUiStore;

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

// Each test must import the module fresh so the resetModules in beforeEach
// rebuilds the zustand persist layer against the stubbed localStorage.
const loadStore = async () => (await import("./kanbanUiStore")).useKanbanUiStore as KanbanUiStore;

function persistApi(store: KanbanUiStore) {
  return store.persist as unknown as {
    getOptions: () => {
      partialize: (
        state: ReturnType<typeof store.getState>,
      ) => Partial<ReturnType<typeof store.getState>>;
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

  it("defaults fresh state to the v2 board with folded review", async () => {
    const state = (await loadStore()).getState();
    expect(state.kanbanViewMode).toBe("v2");
    expect(state.kanbanNeedsReviewFilter).toBe(false);
  });

  it("round-trips persisted classic mode through partialize and merge", async () => {
    const store = await loadStore();
    store.setState((state) => ({
      ...state,
      kanbanViewMode: "classic",
      kanbanNeedsReviewFilter: true,
    }));
    const options = persistApi(store).getOptions();
    const persistedState = options.partialize(store.getState());

    expect(persistedState.kanbanViewMode).toBe("classic");
    expect(persistedState.kanbanNeedsReviewFilter).toBe(true);

    const merged = options.merge(persistedState, store.getInitialState());
    expect(merged.kanbanViewMode).toBe("classic");
    expect(merged.kanbanNeedsReviewFilter).toBe(true);
  });

  it("round-trips a revealed needs-review fold and excludes ephemeral optimistic dispatches", async () => {
    const store = await loadStore();
    store.setState((state) => ({
      ...state,
      kanbanNeedsReviewFilter: true,
      hasRevealedReviewFold: true,
    }));
    const options = persistApi(store).getOptions();
    const persistedState = options.partialize(store.getState());

    expect(persistedState.hasRevealedReviewFold).toBe(true);
    expect(persistedState.optimisticDispatchByThreadId).toBeUndefined();

    const merged = options.merge(persistedState, store.getInitialState());
    expect(merged.hasRevealedReviewFold).toBe(true);
    expect(merged.kanbanNeedsReviewFilter).toBe(true);
  });

  it("sanitizes malformed or legacy persisted state back to safe defaults", async () => {
    const store = await loadStore();
    const { merge } = persistApi(store).getOptions();
    const initialState = () => store.getInitialState();

    // Unknown view mode and non-boolean filter snap back to v2/false.
    const fancy = merge(
      { kanbanViewMode: "fancy", kanbanNeedsReviewFilter: "yes" },
      initialState(),
    );
    expect(fancy.kanbanViewMode).toBe("v2");
    expect(fancy.kanbanNeedsReviewFilter).toBe(false);

    // Legacy persisted drafts lacking the new fields keep their draft order.
    const legacy = merge({ draftOrderByProjectId: { "proj-1": ["card-a"] } }, initialState());
    expect(legacy.draftOrderByProjectId).toEqual({ "proj-1": ["card-a"] });
    expect(legacy.kanbanViewMode).toBe("v2");
    expect(legacy.kanbanNeedsReviewFilter).toBe(false);

    // A non-boolean reveal folds back instead of leaking truthy strings.
    expect(merge({ hasRevealedReviewFold: "yes" }, initialState()).hasRevealedReviewFold).toBe(
      false,
    );
  });

  it("turns the filter off with the reveal so a stale fold never persists alone (H1)", async () => {
    const store = await loadStore();
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
