// FILE: automationInlineDraft.test.ts
// Purpose: Locks down commit-on-blur draft behavior: commit, revert, rebase, invalid drafts,
// unmount flush, and the Escape-blur ordering.
// Layer: Web lib test
// Depends on: automationInlineDraft hooks via the shared react hook harness.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("../test/reactHookHarness")).reactHookHarnessMock);

import { reactHookHarness } from "../test/reactHookHarness";
import { useCommitDraft, useCommitDraftBlurHandlers } from "./automationInlineDraft";

describe("useCommitDraft", () => {
  const onCommit = vi.fn();
  let value = "saved";
  let validate: ((candidate: string) => string | null) | undefined;
  let normalize: ((candidate: string) => string) | undefined;
  let flushOnUnmount: boolean | undefined;

  const render = () => {
    reactHookHarness.beginRender();
    return useCommitDraft({ value, onCommit, validate, normalize, flushOnUnmount });
  };

  beforeEach(() => {
    reactHookHarness.reset();
    onCommit.mockReset();
    value = "saved";
    validate = undefined;
    normalize = undefined;
    flushOnUnmount = undefined;
  });

  it("mirrors the saved value until a draft is typed", () => {
    expect(render().draft).toBe("saved");
    expect(render().error).toBeNull();
  });

  it("commits a changed valid draft and clears the pending state", () => {
    let hook = render();
    hook.setDraft("updated");
    hook = render();
    expect(hook.draft).toBe("updated");

    hook.commit();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("updated");
    expect(render().draft).toBe("saved");
  });

  it("does not commit a draft equal to the saved value", () => {
    let hook = render();
    hook.setDraft("saved");
    hook = render();

    hook.commit();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("silently reverts an invalid draft on commit", () => {
    validate = (candidate) => (candidate.trim() === "" ? "Required" : null);
    let hook = render();
    hook.setDraft("   ");
    hook = render();
    expect(hook.error).toBe("Required");

    hook.commit();
    expect(onCommit).not.toHaveBeenCalled();
    hook = render();
    expect(hook.draft).toBe("saved");
    expect(hook.error).toBeNull();
  });

  it("discards the pending draft on revert", () => {
    let hook = render();
    hook.setDraft("typed");
    hook = render();

    hook.revert();
    expect(render().draft).toBe("saved");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("rebases onto an external value change and drops the stale draft", () => {
    const hook = render();
    hook.setDraft("typed");

    value = "stream-updated";
    const rebased = render();
    expect(rebased.draft).toBe("stream-updated");

    rebased.commit();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("flushes a valid pending draft on unmount", () => {
    render().setDraft("typed then navigated away");
    render();

    reactHookHarness.unmount();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("typed then navigated away");
  });

  it("does not flush a committed draft again when it immediately unmounts", () => {
    render().setDraft("committed before navigation");
    const hook = render();

    hook.commit();
    reactHookHarness.unmount();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("committed before navigation");
  });

  it("does not flush an invalid or unchanged draft on unmount", () => {
    validate = (candidate) => (candidate.trim() === "" ? "Required" : null);
    render().setDraft("  ");
    render();
    reactHookHarness.unmount();
    expect(onCommit).not.toHaveBeenCalled();

    render();
    reactHookHarness.unmount();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not flush on unmount when flushOnUnmount is off", () => {
    flushOnUnmount = false;
    render().setDraft("pending schedule edit");
    render();

    reactHookHarness.unmount();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits the normalized draft and treats a whitespace-only edit as unchanged", () => {
    normalize = (candidate) => candidate.trim();
    let hook = render();
    hook.setDraft("  saved  ");
    hook = render();

    hook.commit();
    expect(onCommit).not.toHaveBeenCalled();

    hook = render();
    hook.setDraft("  updated  ");
    hook = render();
    hook.commit();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("updated");
  });

  it("validates the normalized draft, not the raw text", () => {
    normalize = (candidate) => candidate.trim();
    validate = (candidate) => (candidate === "" ? "Required" : null);
    let hook = render();
    hook.setDraft("   ");
    hook = render();
    expect(hook.error).toBe("Required");

    hook.commit();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("useCommitDraftBlurHandlers", () => {
  beforeEach(() => {
    reactHookHarness.reset();
  });

  it("commits on blur, but reverts when the blur came from Escape", () => {
    const commit = vi.fn();
    const revert = vi.fn();
    reactHookHarness.beginRender();
    const handlers = useCommitDraftBlurHandlers({ commit, revert });

    handlers.onBlur();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(revert).not.toHaveBeenCalled();

    // Escape: element.blur() fires onBlur synchronously before revertAndBlur returns.
    handlers.revertAndBlur({ blur: () => handlers.onBlur() });
    expect(revert).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);

    handlers.onBlur();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(revert).toHaveBeenCalledTimes(1);
  });
});
