import { describe, expect, it } from "vitest";
import { EDITOR_ICON_ROUTE_PATH } from "@synara/shared/editorIcons";
import {
  resolveAvailableEditorOptions,
  resolveEditorIcon,
  resolveEditorLabel,
  resolveEditorNativeIconUrl,
} from "./editorMetadata";

describe("resolveEditorLabel", () => {
  it("uses platform-specific labels for the file manager option", () => {
    expect(resolveEditorLabel("file-manager", "MacIntel")).toBe("Finder");
    expect(resolveEditorLabel("file-manager", "Win32")).toBe("Explorer");
    expect(resolveEditorLabel("file-manager", "Linux x86_64")).toBe("Files");
  });
});

describe("resolveAvailableEditorOptions", () => {
  it("surfaces every supported available editor from the shared contracts catalog", () => {
    expect(
      resolveAvailableEditorOptions("MacIntel", [
        "cursor",
        "trae",
        "vscode-insiders",
        "vscodium",
        "zed",
        "idea",
        "ghostty",
        "muxy",
        "terminal",
        "iterm",
        "warp",
        "xcode",
        "webstorm",
        "pycharm",
        "phpstorm",
        "goland",
        "clion",
        "rider",
        "rubymine",
        "datagrip",
        "rustrover",
        "android-studio",
        "windsurf",
        "sublime",
        "file-manager",
      ]).map((option) => option.value),
    ).toEqual([
      "cursor",
      "trae",
      "vscode-insiders",
      "vscodium",
      "zed",
      "windsurf",
      "sublime",
      "ghostty",
      "muxy",
      "terminal",
      "iterm",
      "warp",
      "xcode",
      "idea",
      "webstorm",
      "pycharm",
      "phpstorm",
      "goland",
      "clion",
      "rider",
      "rubymine",
      "datagrip",
      "rustrover",
      "android-studio",
      "file-manager",
    ]);
  });

  it("provides dedicated icons for newly supported editor rows", () => {
    expect(resolveEditorIcon("ghostty").name).toBe("GhosttyIcon");
    expect(resolveEditorIcon("muxy").name).toBe("TerminalAppIcon");
    expect(resolveEditorIcon("terminal").name).toBe("TerminalAppIcon");
    expect(resolveEditorIcon("iterm").name).toBe("TerminalAppIcon");
    expect(resolveEditorIcon("xcode").name).toBe("SimpleIcon");
    expect(resolveEditorIcon("webstorm").name).toBe("SimpleIcon");
  });

  it("builds authenticated editor icon route urls", () => {
    expect(resolveEditorNativeIconUrl("ghostty")).toContain(`${EDITOR_ICON_ROUTE_PATH}?id=ghostty`);
  });
});
