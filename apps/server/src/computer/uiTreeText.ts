/**
 * Rendering and clamping a `ComputerUiNode` tree as text.
 *
 * Backend-neutral on purpose. This used to live in `atspiTreeTargeting.ts`,
 * which is the Linux AT-SPI fusion module, so the macOS backend and its AX tree
 * parser both imported their text helpers from the AT-SPI path — a dependency
 * that says something untrue about the code and would have to be untangled by
 * whoever next touched either platform. Nothing here knows where the tree came
 * from.
 *
 * @module computer/uiTreeText
 */
import type { ComputerUiNode } from "@synara/contracts";

import { clampTextToLength } from "./utf8Truncation.ts";

export function describeComputerUiTree(root: ComputerUiNode): string {
  const lines: string[] = [];
  const visit = (node: ComputerUiNode, depth: number): void => {
    const label = node.label ?? node.description ?? "(unlabelled)";
    // The text rendering is what most agents actually read, so a subtree the
    // walk cut short has to say so here too — otherwise a missing control looks
    // like an absent one.
    const truncated = node.truncated === true ? " …(truncated)" : "";
    lines.push(
      `${"  ".repeat(depth)}${node.role}: ${label}${node.value ? ` = ${node.value}` : ""}${truncated}`,
    );
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return lines.join("\n");
}

/**
 * `text` cut to `maxLength` characters with a marker in place of the tail.
 *
 * Kept as this module's name for the shared surrogate-safe clamp, because every
 * caller here is talking about a UI node's text.
 */
export function clampNodeText(text: string, maxLength: number): string {
  return clampTextToLength(text, maxLength);
}
