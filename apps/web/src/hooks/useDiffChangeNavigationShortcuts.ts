import type { ResolvedKeybindingsConfig } from "@synara/contracts";
import { useEffect, type RefObject } from "react";

import { isEditableEventTarget } from "../lib/editableEventTarget";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import type { DiffChangeNavigationDirection } from "../components/DiffPanel.logic";

function isDisplayed(element: HTMLElement): boolean {
  return typeof element.checkVisibility === "function"
    ? element.checkVisibility()
    : element.offsetParent !== null;
}

export function useDiffChangeNavigationShortcuts({
  keybindings,
  enabled,
  surfaceRef,
  onNavigate,
}: {
  keybindings: ResolvedKeybindingsConfig;
  enabled: boolean;
  /**
   * The diff surface the shortcuts drive. The panel stays mounted (with warm
   * queries) while another editor pane is shown, so the shortcuts only act
   * when this surface is actually displayed.
   */
  surfaceRef: RefObject<HTMLElement | null>;
  onNavigate: (direction: DiffChangeNavigationDirection) => void;
}): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (isEditableEventTarget(event)) return;
      const surface = surfaceRef.current;
      if (!surface || !isDisplayed(surface)) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command !== "diff.change.next" && command !== "diff.change.previous") return;
      event.preventDefault();
      event.stopPropagation();
      onNavigate(command === "diff.change.next" ? "next" : "previous");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, keybindings, onNavigate, surfaceRef]);
}
