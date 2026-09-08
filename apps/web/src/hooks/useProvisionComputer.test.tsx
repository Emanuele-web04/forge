// FILE: useProvisionComputer.test.tsx
// Purpose: Pin the one "Set up computer control" mutation both surfaces share —
//          the cache write that repaints them, the ready callback, and who gets toasts.
//
// The bug that produced the hook: the chat card and the settings panel each
// owned a private implementation, so they said different things about the same
// server call and could fire it concurrently. What is checked here is the part
// observable from outside React — the query cache, the toast manager, and the
// RPC itself. The single-flight guard reads React state across renders, which
// this lane (server rendering, no DOM) cannot drive; `isPending` is React
// Query's own, and the words are pinned by `computerProvisioning.test.ts`.

import type { ComputerProvisionResult, ComputerStatusResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { useProvisionComputer } from "./useProvisionComputer";

const provisionComputer = vi.hoisted(() => vi.fn());
const toastAdd = vi.hoisted(() => vi.fn());

vi.mock("~/lib/serverReactQuery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/serverReactQuery")>();
  return { ...actual, provisionComputer };
});

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: toastAdd } }));

function status(overrides: Partial<ComputerStatusResult> = {}): ComputerStatusResult {
  return {
    computerId: "desktop",
    availability: { kind: "available" },
    capabilities: {
      windows: true,
      windowBounds: true,
      stacking: true,
      capture: true,
      input: true,
      clipboard: true,
      focus: true,
      raise: true,
      ghostCursor: true,
      visibleDesktop: true,
    },
    health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
    ...overrides,
  };
}

function blockedStatus(): ComputerStatusResult {
  return status({
    availability: {
      kind: "permission-required",
      missing: ["accessibility"],
      message: "macOS is asking for Accessibility.",
      buildSignature: "adhoc",
    },
  });
}

/** Mounts the hook once and hands back the result it produced on that render. */
function mountProvisionHook(
  queryClient: QueryClient,
  options?: Parameters<typeof useProvisionComputer>[0],
): ReturnType<typeof useProvisionComputer> {
  const captured: { current: ReturnType<typeof useProvisionComputer> | null } = { current: null };
  function Probe() {
    captured.current = useProvisionComputer(options);
    return <span />;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );
  if (!captured.current) throw new Error("useProvisionComputer probe did not render.");
  return captured.current;
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function reset() {
  provisionComputer.mockReset();
  toastAdd.mockReset();
}

describe("useProvisionComputer", () => {
  it("writes the refreshed status the call returned straight into the cache", async () => {
    reset();
    const result: ComputerProvisionResult = { summary: "Granted.", status: status() };
    provisionComputer.mockResolvedValue(result);
    const queryClient = createQueryClient();

    mountProvisionHook(queryClient).provision();

    // The call already answers with fresh status, so no surface has to race a
    // refetch against a backend that has only just rebuilt its providers.
    await vi.waitFor(() => {
      expect(queryClient.getQueryData(serverQueryKeys.computerStatus())).toEqual(result.status);
    });
    expect(provisionComputer).toHaveBeenCalledTimes(1);
  });

  it("runs onReady when the desktop came back with nothing left to set up", async () => {
    reset();
    provisionComputer.mockResolvedValue({ summary: "Granted.", status: status() });
    const onReady = vi.fn();

    mountProvisionHook(createQueryClient(), { onReady }).provision();

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });

  it("leaves onReady alone when a grant is still missing", async () => {
    reset();
    const result: ComputerProvisionResult = { summary: "Still missing.", status: blockedStatus() };
    provisionComputer.mockResolvedValue(result);
    const onReady = vi.fn();
    const queryClient = createQueryClient();

    mountProvisionHook(queryClient, { onReady }).provision();

    await vi.waitFor(() => {
      expect(queryClient.getQueryData(serverQueryKeys.computerStatus())).toEqual(result.status);
    });
    // A provision that did not finish the job must not tell the card it is done;
    // the card re-derives "needs setup" from the status just written instead.
    expect(onReady).not.toHaveBeenCalled();
  });

  it("stays silent unless the surface asked to be notified", async () => {
    reset();
    provisionComputer.mockResolvedValue({ summary: "Granted.", status: status() });
    const queryClient = createQueryClient();

    mountProvisionHook(queryClient).provision();

    await vi.waitFor(() => {
      expect(queryClient.getQueryData(serverQueryKeys.computerStatus())).toBeDefined();
    });
    // The settings panel renders the same account inline and would otherwise say
    // everything twice.
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("raises the opening toast before the call, then one for the outcome", async () => {
    reset();
    provisionComputer.mockResolvedValue({ summary: "Granted.", status: status() });

    mountProvisionHook(createQueryClient(), {
      notify: true,
      missing: ["accessibility"],
    }).provision();

    // Synchronously, because the call's visible effect is a macOS dialog
    // appearing over Synara and the user needs to know Synara asked for it.
    expect(toastAdd).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(2));
  });

  it("reports a failed provision and writes nothing to the cache", async () => {
    reset();
    provisionComputer.mockRejectedValue(new Error("no toolchain"));
    const queryClient = createQueryClient();

    mountProvisionHook(queryClient, { notify: true }).provision();

    await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(2));
    expect(queryClient.getQueryData(serverQueryKeys.computerStatus())).toBeUndefined();
  });
});
