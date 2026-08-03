import { describe, expect, it } from "vitest";

import { buildCodexTurnInput } from "./codexTurnInput.ts";

describe("buildCodexTurnInput", () => {
  it("preserves Codex wire-item ordering", () => {
    expect(
      buildCodexTurnInput({
        input: "Review this",
        attachments: [{ type: "image", url: "data:image/png;base64,abc" }],
        skills: [{ name: "check-code", path: "/skills/check-code/SKILL.md" }],
        mentions: [{ name: "AGENTS.md", path: "/repo/AGENTS.md" }],
      }),
    ).toEqual([
      { type: "text", text: "Review this", text_elements: [] },
      { type: "image", url: "data:image/png;base64,abc" },
      { type: "skill", name: "check-code", path: "/skills/check-code/SKILL.md" },
      { type: "mention", name: "AGENTS.md", path: "/repo/AGENTS.md" },
    ]);
  });

  it("preserves whitespace text while omitting an empty string", () => {
    expect(buildCodexTurnInput({ input: "   " })).toEqual([
      { type: "text", text: "   ", text_elements: [] },
    ]);
    expect(buildCodexTurnInput({ input: "" })).toEqual([]);
  });

  it("accepts non-text input items without inventing text", () => {
    expect(
      buildCodexTurnInput({
        attachments: [{ type: "image", url: "file:///tmp/image.png" }],
        skills: [{ name: "review", path: "/skills/review/SKILL.md" }],
        mentions: [{ name: "README", path: "/repo/README.md" }],
      }),
    ).toEqual([
      { type: "image", url: "file:///tmp/image.png" },
      { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
      { type: "mention", name: "README", path: "/repo/README.md" },
    ]);
  });

  it("preserves local image paths without converting them to URLs", () => {
    expect(
      buildCodexTurnInput({
        attachments: [{ type: "localImage", path: "/tmp/screenshot.png" }],
      }),
    ).toEqual([{ type: "localImage", path: "/tmp/screenshot.png" }]);
  });
});
