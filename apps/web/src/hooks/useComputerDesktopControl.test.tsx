import { ThreadId, type ThreadComputerState } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useComputerDesktopControl } from "./useComputerDesktopControl";

const interrupt = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const current = vi.hoisted(() => ({ state: undefined as ThreadComputerState | undefined }));
vi.mock("~/lib/threadTurnInterrupt", () => ({ interruptThreadTurn: interrupt }));
vi.mock("../computerStateStore", () => ({
  selectThreadComputerState: () => () => current.state,
  useComputerStateStore: (selector: () => unknown) => selector(),
}));

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  let controls!: ReturnType<typeof useComputerDesktopControl>;
  function Probe() {
    controls = useComputerDesktopControl(ThreadId.makeUnsafe("viewed-thread"));
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );
  return controls;
}

describe("desktop Stop control", () => {
  it("stays available between calls and interrupts the actual desktop owner", async () => {
    current.state = {
      controlOwnerThreadId: ThreadId.makeUnsafe("owning-thread"),
      agentActive: false,
      capabilities: { visibleDesktop: true },
    } as ThreadComputerState;
    const controls = mount();
    expect(controls.agentActive).toBe(true);
    expect(controls.visibleDesktop).toBe(true);
    controls.stop();
    await vi.waitFor(() => expect(interrupt.mock.calls[0]?.[0]).toBe("owning-thread"));
  });

  it("becomes inactive immediately when ownership and activity end", () => {
    current.state = {
      agentActive: false,
      capabilities: { visibleDesktop: true },
    } as ThreadComputerState;
    expect(mount().agentActive).toBe(false);
  });
});
