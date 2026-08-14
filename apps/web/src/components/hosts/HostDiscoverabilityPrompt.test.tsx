// FILE: HostDiscoverabilityPrompt.test.tsx
// Purpose: The consent prompt opens for a shared workspace and stays shut for
//          a personal one (ADR 0002/0015), and both answers are recorded.
// Layer: Component rendering tests
// Depends on: the prompt, a mocked NativeApi, and React server rendering.

import type {
  AccountHost,
  AccountMe,
  AccountStatus,
  EnvironmentId,
  NativeApi,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { accountQueryKeys } from "~/lib/accountReactQuery";
import { remoteHostQueryKeys } from "~/lib/remoteHosts/queries";
import type { RemoteHostEnrollment } from "~/lib/remoteHosts/api";

const hostsApiMock = {
  listHosts: vi.fn(),
  updateHost: vi.fn(),
  deleteHost: vi.fn(),
  listDevices: vi.fn(),
  revokeDevice: vi.fn(),
  approveDeviceLink: vi.fn(),
  requestGrant: vi.fn(),
  enrollment: vi.fn(),
  unlinkLocalHost: vi.fn(),
};

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ account: {}, hosts: hostsApiMock }) as unknown as NativeApi,
  readNativeApi: () => ({ account: {}, hosts: hostsApiMock }) as unknown as NativeApi,
}));

// The Dialog portals to document.body, which React's static renderer has no
// concept of. Substituting a plain wrapper keeps `open` observable in the
// markup — the one thing this component decides.
const capturedDialogOpen: (boolean | undefined)[] = [];
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) => {
    capturedDialogOpen.push(open);
    return open ? <div data-testid="dialog">{children}</div> : null;
  },
  DialogPopup: ({ children }: ComponentProps<"div">) => <div>{children}</div>,
  DialogHeader: ({ children }: ComponentProps<"div">) => <div>{children}</div>,
  DialogTitle: ({ children }: ComponentProps<"h2">) => <h2>{children}</h2>,
  DialogDescription: ({ children }: ComponentProps<"p">) => <p>{children}</p>,
  DialogFooter: ({ children }: ComponentProps<"div">) => <div>{children}</div>,
}));

const { HostDiscoverabilityPrompt } = await import("./HostDiscoverabilityPrompt");

afterEach(() => {
  vi.clearAllMocks();
  capturedDialogOpen.length = 0;
});

function makeHost(overrides: Partial<AccountHost> = {}): AccountHost {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    environmentId: "env_1" as EnvironmentId,
    name: "Ada's MacBook",
    platform: "darwin",
    kind: "local",
    endpoints: [],
    ownerUserId: "user_1",
    discoverable: true,
    linked: true,
    keyGeneration: 1,
    mine: true,
    createdAt: "2026-08-13T10:00:00.000Z",
    lastSeenAt: "2026-08-13T10:00:00.000Z",
    ...overrides,
  };
}

function makeMe(organizationName: string): AccountMe {
  return {
    id: "user_1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    organization: { id: "org_1", name: organizationName },
    profile: null,
  };
}

function renderPrompt(input: {
  enrollment: RemoteHostEnrollment | null;
  organizationName?: string;
}): { html: string; open: boolean | undefined } {
  const queryClient = new QueryClient();
  queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), {
    state: "signed-in",
    me: makeMe(input.organizationName ?? "Acme"),
  });
  if (input.enrollment) {
    queryClient.setQueryData(remoteHostQueryKeys.enrollment(), input.enrollment);
  }
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      {(<HostDiscoverabilityPrompt />) as ReactNode}
    </QueryClientProvider>,
  );
  return { html, open: capturedDialogOpen.at(-1) };
}

describe("HostDiscoverabilityPrompt", () => {
  // Desktop registers its bundled host automatically and discoverability
  // defaults on — in a team that default would silently hand every member
  // code execution on someone's laptop, so it must be asked for once.
  it("opens for a multi-member workspace", () => {
    const { html, open } = renderPrompt({
      enrollment: {
        host: makeHost(),
        organizationMemberCount: 5,
        discoverabilityAcknowledged: false,
      },
      organizationName: "Acme Engineering",
    });

    expect(open).toBe(true);
    expect(html).toContain("Share this machine with Acme Engineering?");
    expect(html).toContain("Ada&#x27;s MacBook");
  });

  it("stays shut for a personal workspace", () => {
    const { html, open } = renderPrompt({
      enrollment: {
        host: makeHost(),
        organizationMemberCount: 1,
        discoverabilityAcknowledged: false,
      },
    });

    expect(open).toBe(false);
    expect(html).toBe("");
  });

  it("stays shut once the owner has already answered", () => {
    const { open } = renderPrompt({
      enrollment: {
        host: makeHost(),
        organizationMemberCount: 5,
        discoverabilityAcknowledged: true,
      },
    });

    expect(open).toBe(false);
  });

  it("stays shut when this shell has no registered host", () => {
    const { html } = renderPrompt({
      enrollment: {
        host: null,
        organizationMemberCount: 5,
        discoverabilityAcknowledged: false,
      },
    });

    expect(html).toBe("");
  });

  // An identity-provider hiccup must not manufacture a sharing prompt.
  it("stays shut when the member count is unavailable", () => {
    const { open } = renderPrompt({
      enrollment: {
        host: makeHost(),
        organizationMemberCount: null,
        discoverabilityAcknowledged: false,
      },
    });

    expect(open).toBe(false);
  });

  it("stays shut before enrollment has been read", () => {
    const { html } = renderPrompt({ enrollment: null });

    expect(html).toBe("");
  });

  // Both buttons are answers: declining writes `discoverable: false` rather
  // than dismissing, so the question does not return every launch.
  it("offers both an accept and a decline, and no dismiss", () => {
    const { html } = renderPrompt({
      enrollment: {
        host: makeHost(),
        organizationMemberCount: 5,
        discoverabilityAcknowledged: false,
      },
    });

    expect(html).toContain("Share");
    expect(html).toContain("Keep private");
    expect(html).not.toContain("Later");
    expect(html).not.toMatch(/aria-label="Close"/);
  });

  it("explains what sharing actually grants", () => {
    const { html } = renderPrompt({
      enrollment: {
        host: makeHost(),
        organizationMemberCount: 5,
        discoverabilityAcknowledged: false,
      },
    });

    expect(html).toContain("open sessions");
  });
});
