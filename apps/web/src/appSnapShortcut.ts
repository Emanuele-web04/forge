// FILE: appSnapShortcut.ts
// Purpose: Detect AppSnap shortcut overlap with Synara's renderer keybindings.

import type {
  DesktopAppSnapKeyChord,
  KeybindingCommand,
  KeybindingShortcut,
  ResolvedKeybindingsConfig,
} from "@synara/contracts";
import { appSnapShortcutKeyLabel } from "@synara/shared/appSnapShortcut";

import { DEFAULT_SHORTCUT_FALLBACKS } from "./keybindings";

function bindingModifiers(shortcut: KeybindingShortcut): Set<DesktopAppSnapKeyChord["modifier"]> {
  const modifiers = new Set<DesktopAppSnapKeyChord["modifier"]>();
  if (shortcut.modKey || shortcut.metaKey) modifiers.add("command");
  if (shortcut.ctrlKey) modifiers.add("control");
  if (shortcut.altKey) modifiers.add("option");
  if (shortcut.shiftKey) modifiers.add("shift");
  return modifiers;
}

function bindingKeyLabel(shortcut: KeybindingShortcut): string {
  const key = shortcut.key.toLowerCase();
  if (key === " ") return "Space";
  if (key === "enter") return "Return";
  if (key === "escape") return "Esc";
  if (key === "arrowup") return "↑";
  if (key === "arrowdown") return "↓";
  if (key === "arrowleft") return "←";
  if (key === "arrowright") return "→";
  return key.length === 1 ? key.toUpperCase() : key;
}

export function appSnapShortcutConflictCommand(
  shortcut: DesktopAppSnapKeyChord,
  configuredKeybindings: ResolvedKeybindingsConfig,
): KeybindingCommand | null {
  const configuredCommands = new Set(configuredKeybindings.map((binding) => binding.command));
  const bindings = [
    ...configuredKeybindings,
    ...DEFAULT_SHORTCUT_FALLBACKS.filter((binding) => !configuredCommands.has(binding.command)),
  ];
  const shortcutKeyLabel = appSnapShortcutKeyLabel(shortcut.key).toUpperCase();

  for (const binding of bindings) {
    const modifiers = bindingModifiers(binding.shortcut);
    if (
      modifiers.size === 1 &&
      modifiers.has(shortcut.modifier) &&
      bindingKeyLabel(binding.shortcut).toUpperCase() === shortcutKeyLabel
    ) {
      return binding.command;
    }
  }
  return null;
}
