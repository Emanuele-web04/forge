// FILE: ProjectPicker.browser.tsx
// Purpose: Prove the desktop-dialog refusal is enforced by the COMPONENT, so a
//          remote host cannot open a folder picker on the user's own machine.
// Layer: Chat picker tests (browser mode)
//
// WHY THIS FILE EXISTS
//
// `environmentCapabilities.test.ts` pins `resolveEnvironmentCapabilityRefusal`
// thoroughly. That predicate is not what protects the user: deleting the
// `if (refusal) return` in this component left the ENTIRE component suite green
// — 82 files, 1129 tests, exit 0 — while the guard vanished from the product.
// "No test reaches this call site" and "nothing in the whole suite notices this
// guard disappear" are different claims, and the second is much worse.
//
// The guard is NOT migrated to `withEnvironmentCapability` like the editor
// launcher was. Its action is a long async block inside a `try`, and this file
// documents that React Compiler cannot lower a value block there. The refusal
// already precedes the work, so forcing the callback shape would fight a
// compiler constraint for no safety gain. Tested rather than restructured.

import "../../index.css";

import { ProjectId, ThreadId, type EnvironmentId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EnvironmentScopeProvider } from "../../environmentScope";
import { useStore } from "../../store";
import { withAggregatedView } from "../../storeAggregation";
import { makeProject, makeStoreState } from "../../storeTestFixtures";
import { ProjectPicker } from "./ProjectPicker";

const REMOTE_ENVIRONMENT_ID = "aaaaaaaa-1111-4111-8111-111111111111" as EnvironmentId;
const REMOTE_THREAD_ID = ThreadId.makeUnsafe("thread-remote");
const PROJECT_ID = ProjectId.makeUnsafe("project-1");

const pickFolder = vi.fn(async () => "/Users/me/picked-on-my-laptop");

vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({ dialogs: { pickFolder } }),
  ensureNativeApi: () => ({ dialogs: { pickFolder } }),
}));

/**
 * A store whose thread is owned by a REMOTE environment, so the scope provider
 * resolves the picker into a remote scope. Ownership is positional — the thread
 * shell lives in that environment's record — because that is the only way the
 * real store expresses it.
 */
function seedRemoteOwnedThread(): void {
  const base = makeStoreState({
    projects: [makeProject({ id: PROJECT_ID })],
    threadsHydrated: true,
  });
  useStore.setState(
    withAggregatedView({
      ...base,
      environmentById: {
        ...base.environmentById,
        // A record built from scratch: spreading `base.environmentById[remote]`
        // spreads `undefined`, since the fixture only creates the local one.
        [REMOTE_ENVIRONMENT_ID]: {
          spaces: [],
          projects: [],
          sidebarThreadSummaryById: {},
          threadsHydrated: true,
          threadShellById: { [REMOTE_THREAD_ID]: { id: REMOTE_THREAD_ID } },
        },
      },
    } as never) as never,
  );
}

describe("ProjectPicker desktop-dialog refusal", () => {
  it("does NOT open a folder picker when the scope is a remote host", async () => {
    // The failure this prevents: the dialog opens on the machine the user is
    // sitting at and returns a LOCAL path, which is then added as a project on
    // a REMOTE host that does not have it. The path plausibly exists on both,
    // so it succeeds silently against the wrong checkout.
    seedRemoteOwnedThread();
    pickFolder.mockClear();

    const mounted = await render(
      <EnvironmentScopeProvider threadId={REMOTE_THREAD_ID}>
        <ProjectPicker selectionMode="workspace-root" onSelectWorkspaceRoot={vi.fn()} />
      </EnvironmentScopeProvider>,
    );

    await mounted.getByTestId("workspace-picker-trigger").click();
    const addAction = mounted.getByRole("button", { name: /add new project/i });
    await addAction.click();

    // The guard's whole job: the dialog is never opened.
    expect(pickFolder).not.toHaveBeenCalled();
    // And the user is told why, rather than being left with a dead button.
    await expect.element(mounted.getByText(/folder and file pickers/i)).toBeVisible();
    await mounted.unmount();
  });

  it("DOES open the folder picker on the local environment", async () => {
    // The other direction. A refusal that refuses everywhere would pass the
    // test above while breaking the feature for every single-server user.
    useStore.setState(makeStoreState({ projects: [makeProject({ id: PROJECT_ID })] }) as never);
    pickFolder.mockClear();

    const mounted = await render(
      <EnvironmentScopeProvider>
        <ProjectPicker selectionMode="workspace-root" onSelectWorkspaceRoot={vi.fn()} />
      </EnvironmentScopeProvider>,
    );

    await mounted.getByTestId("workspace-picker-trigger").click();
    await mounted.getByRole("button", { name: /add new project/i }).click();

    await vi.waitFor(() => {
      expect(pickFolder).toHaveBeenCalledTimes(1);
    });
    await mounted.unmount();
  });
});
