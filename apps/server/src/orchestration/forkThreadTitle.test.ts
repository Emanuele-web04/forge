import { describe, expect, it } from "vitest";

import { buildForkThreadTitle } from "./forkThreadTitle.ts";

interface TestThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly forkSourceThreadId: string | null;
  readonly sidechatSourceThreadId: string | null;
}

function thread(
  id: string,
  title: string,
  forkSourceThreadId: string | null = null,
  sidechatSourceThreadId: string | null = null,
): TestThread {
  return {
    id,
    projectId: "project-1",
    title,
    forkSourceThreadId,
    sidechatSourceThreadId,
  };
}

describe("buildForkThreadTitle", () => {
  it("starts a fork lineage at version two", () => {
    const root = thread("root", "ciao");

    expect(buildForkThreadTitle(root, [root])).toBe("ciao (2)");
  });

  it("increments the whole lineage when forking a fork", () => {
    const root = thread("root", "ciao");
    const second = thread("second", "ciao (2)", root.id);
    const third = thread("third", "ciao (3)", second.id);

    expect(buildForkThreadTitle(second, [root, second, third])).toBe("ciao (4)");
  });

  it("ignores sidechats and unrelated roots with the same title", () => {
    const root = thread("root", "ciao");
    const second = thread("second", "ciao (2)", root.id);
    const sidechat = thread("sidechat", "Sidechat: ciao", root.id, root.id);
    const unrelated = thread("unrelated", "ciao");

    expect(buildForkThreadTitle(second, [root, second, sidechat, unrelated])).toBe("ciao (3)");
  });

  it("continues a versioned source title when its ancestor is unavailable", () => {
    const source = thread("source", "ciao (4)", "missing-root");

    expect(buildForkThreadTitle(source, [source])).toBe("ciao (5)");
  });

  it("does not stack version suffixes when the lineage root is already numbered", () => {
    const root = thread("root", "ciao (2)");

    expect(buildForkThreadTitle(root, [root])).toBe("ciao (3)");
  });
});
