import "../index.css";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { page } from "vitest/browser";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { EditorDirtyRouteGuard } from "./EditorDirtyRouteGuard";

async function mount(saving: boolean) {
  let settle!: (next: { dirty: boolean; saving: boolean }) => void;
  const root = createRootRoute({ component: Outlet });
  const editor = createRoute({
    getParentRoute: () => root,
    path: "/editor",
    component: () => {
      const [state, setState] = useState({ dirty: true, saving });
      settle = setState;
      return (
        <>
          <p>Editor buffer</p>
          <button onClick={() => void router.navigate({ to: "/settings" })}>Next page</button>
          <EditorDirtyRouteGuard enabled={state.dirty || state.saving} saving={state.saving} />
        </>
      );
    },
  });
  const next = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: () => <p>Next page content</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([editor, next]),
    history: createMemoryHistory({ initialEntries: ["/editor"] }),
  });
  const view = await render(<RouterProvider router={router} />);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  return { router, view, settle: (state: { dirty: boolean; saving: boolean }) => settle(state) };
}

it("keeps route navigation blocked when discard is cancelled", async () => {
  const { router, view } = await mount(false);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/editor");
  await page.getByRole("button", { name: "Next page" }).click();
  await page.getByRole("button", { name: "Discard changes and leave" }).click();
  await expect.poll(() => router.state.location.pathname).toBe("/settings");
  await view.unmount();
});

it.each([true, false])("settles a confirmed deferred departure with dirty=%s", async (dirty) => {
  const { router, view, settle } = await mount(true);
  await page.getByRole("button", { name: "Discard changes and leave" }).click();
  expect(router.state.location.pathname).toBe("/editor");
  await settle({ dirty, saving: false });
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  await expect.poll(() => router.state.location.pathname).toBe(dirty ? "/editor" : "/settings");
  await view.unmount();
});
