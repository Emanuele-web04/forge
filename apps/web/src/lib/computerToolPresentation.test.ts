// FILE: computerToolPresentation.test.ts
// Purpose: Pin the approval card's account of a desktop action — the question being
//          asked is "click what", and the answer must not be the raw wire call.
// Layer: Web UI logic tests

import type { ComputerWindow } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  computerToolName,
  describeComputerToolCall,
  isComputerToolName,
} from "./computerToolPresentation";

const SAFARI: ComputerWindow = {
  id: "win-7",
  title: "Google",
  appName: "Safari",
  focused: true,
  minimized: false,
  visible: true,
} as unknown as ComputerWindow;

describe("computerToolName", () => {
  it("recovers the gateway tool through whatever wrapping a provider applied", () => {
    expect(computerToolName("mcp__synara__computer_click")).toBe("computer_click");
    expect(computerToolName("computer_click")).toBe("computer_click");
    expect(computerToolName("MCP__Synara__Computer_Type_Text")).toBe("computer_type_text");
    expect(computerToolName("browser_click")).toBeNull();
    expect(computerToolName(undefined)).toBeNull();
  });

  it("does not claim a merely similar name", () => {
    expect(isComputerToolName("my_computer_clicker")).toBe(false);
  });
});

describe("describeComputerToolCall", () => {
  it("says verb, coordinate and window instead of the raw call", () => {
    const described = describeComputerToolCall({
      toolName: "mcp__synara__computer_click",
      args: { x: 812, y: 344, window_id: "win-7" },
      windows: [SAFARI],
    });
    expect(described?.summary).toBe("Click at (812, 344) in Safari — Google");
  });

  it("drops a window id it cannot resolve rather than printing it", () => {
    // An opaque id tells the user nothing they can check against their screen.
    const described = describeComputerToolCall({
      toolName: "computer_click",
      args: { x: 10, y: 20, window_id: "win-missing" },
      windows: [SAFARI],
    });
    expect(described?.summary).toBe("Click at (10, 20)");
    expect(described?.params.some((row) => row.name === "Window")).toBe(false);
  });

  it("prefers a semantic label over coordinates, because that is what was targeted", () => {
    expect(
      describeComputerToolCall({
        toolName: "computer_click",
        args: { label: "Save", x: 5, y: 6 },
      })?.summary,
    ).toBe("Click on “Save”");
  });

  it("shows what is being typed, and calls a clipboard write a clipboard write", () => {
    // `computer_write_clipboard` used to be classified a *file change* by a
    // substring match on "write"; naming its payload "Text" would leave the same
    // impression, that something is being typed into whatever has focus.
    expect(
      describeComputerToolCall({ toolName: "computer_type_text", args: { text: "hello" } })
        ?.summary,
    ).toBe("Type “hello”");
    const clipboard = describeComputerToolCall({
      toolName: "computer_write_clipboard",
      args: { text: "secret" },
    });
    expect(clipboard?.summary).toBe("Write to the clipboard “secret”");
    expect(clipboard?.params).toContainEqual({ name: "Clipboard", value: "secret" });
  });

  it("gives a scroll a direction and a shortcut its keys", () => {
    expect(
      describeComputerToolCall({ toolName: "computer_scroll", args: { delta_y: 240 } })?.summary,
    ).toBe("Scroll down");
    expect(
      describeComputerToolCall({ toolName: "computer_hotkey", args: { keys: ["cmd", "s"] } })
        ?.summary,
    ).toBe("Press a shortcut cmd+s");
  });

  it("renders a coordinate pair as one row, because it is one fact", () => {
    const described = describeComputerToolCall({
      toolName: "computer_click",
      args: { x: 812, y: 344 },
    });
    expect(described?.params).toEqual([{ name: "Position", value: "812, 344" }]);
  });

  it("returns null for anything that is not a desktop tool", () => {
    expect(describeComputerToolCall({ toolName: "Bash", args: { command: "ls" } })).toBeNull();
  });
});
