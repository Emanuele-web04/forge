import * as Crypto from "node:crypto";

import type {
  BrowserSnapshotHostOutput,
  BrowserSnapshotOutput,
  BrowserTabId,
} from "@synara/contracts";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import {
  drainOnAbort,
  evaluateInContext,
  observePage,
  sendCdpCommand,
  throwIfAborted,
} from "./cdpRuntime";
import { browserHostError } from "./hostErrors";

const MAX_STRUCTURED_SNAPSHOT_BYTES = 512 * 1024;
const MAX_VISIBLE_TEXT_BYTES = 6 * 1024;
const MAX_SEMANTIC_ELEMENTS = 120;
const MAX_CONTEXT_ANCESTORS = 4;
const MAX_DOM_ELEMENTS_VISITED = 20_000;
const MAX_VISIBLE_TEXT_NODES_VISITED = 20_000;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
export const BROWSER_AUTOMATION_WORLD_NAME = "synara-browser-automation-v1";

// Shared by snapshots and locator resolution so whichever operation reaches a
// page first installs the same bounded state without making ordinary locators
// pay the cost of the semantic fingerprint helpers.
export const BROWSER_AUTOMATION_BASE_STATE_BOOTSTRAP = String.raw`
  const key = "__synaraBrowserAutomationV1";
  let state = globalThis[key];
  if (!state || typeof state !== "object") {
    state = {};
    globalThis[key] = state;
  }
  if (!Number.isSafeInteger(state.generation)) state.generation = 0;
  if (!(state.refs instanceof Map)) state.refs = new Map();
  if (!("currentTarget" in state)) state.currentTarget = null;
  if (typeof state.observe !== "function") state.observe = () => {};
`;

// Snapshot refs retain the exact guest DOM node plus a small identity
// fingerprint. Unrelated live-page mutations remain valid, while a virtualized
// node reused under different semantic ancestry fails closed.
export const BROWSER_AUTOMATION_STATE_BOOTSTRAP = String.raw`
  ${BROWSER_AUTOMATION_BASE_STATE_BOOTSTRAP}
  const identityText = (value, maximum = 256) => String(value ?? "").slice(0, maximum * 4)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, maximum);
  const implicitContextRole = (element) => {
    const tag = element?.localName || "";
    if (tag === "a" && element.hasAttribute?.("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return element.multiple ? "listbox" : "combobox";
    if (tag === "input") {
      const type = String(element.getAttribute?.("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type !== "hidden") return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    return ({ img: "img", ul: "list", ol: "list", li: "listitem", table: "table",
      tbody: "rowgroup", thead: "rowgroup", tfoot: "rowgroup", tr: "row", td: "cell",
      th: "columnheader", nav: "navigation", main: "main", form: "form", article: "article",
      aside: "complementary", header: "banner", footer: "contentinfo", section: "region",
      details: "group" })[tag] || "none";
  };
  const supportedContextRoles = new Set("alert alertdialog application article banner button cell checkbox columnheader combobox complementary contentinfo definition dialog directory document feed figure form grid gridcell group heading img link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status switch tab table tablist tabpanel term textbox timer toolbar tooltip tree treegrid treeitem".split(" "));
  const contextRoleFor = (element) => {
    const role = identityText(element?.getAttribute?.("role") || implicitContextRole(element), 64)
      .split(" ")[0].toLowerCase() || "none";
    return supportedContextRoles.has(role) ? role : "none";
  };
  const boundedDescendantText = (element) => {
    const parts = [];
    const frames = [];
    let length = 0;
    let visited = 0;
    const pushChildren = (node) => {
      const children = node?.childNodes;
      if (children && Number(children.length) > 0) frames.push({ children, index: 0 });
    };
    pushChildren(element);
    while (frames.length > 0 && length < 96 && visited < 48) {
      const frame = frames[frames.length - 1];
      if (frame.index >= frame.children.length) {
        frames.pop();
        continue;
      }
      const node = frame.children[frame.index++];
      visited += 1;
      if (node?.nodeType === 3) {
        const text = identityText(node.nodeValue, 96 - length);
        if (text) { parts.push(text); length += text.length + 1; }
        continue;
      }
      pushChildren(node);
    }
    return identityText(parts.join(" "), 96);
  };
  const explicitContextNameFor = (element) => {
    const labelledBy = identityText(element?.getAttribute?.("aria-labelledby"), 256);
    const root = element?.getRootNode?.();
    const labelled = labelledBy ? labelledBy.split(/\s+/).map((id) =>
      boundedDescendantText(root?.getElementById?.(id) || element?.ownerDocument?.getElementById?.(id))
    ).join(" ") : "";
    const labels = [];
    const labelElements = element?.labels;
    for (let index = 0; index < Math.min(Number(labelElements?.length) || 0, 8); index += 1) {
      labels.push(boundedDescendantText(labelElements[index]));
    }
    return identityText(element?.getAttribute?.("aria-label") || labelled || labels.join(" ") ||
      element?.getAttribute?.("alt") || element?.getAttribute?.("placeholder") ||
      element?.getAttribute?.("title"), 96);
  };
  const contextualTextRoles = new Set("article cell definition figure gridcell group listitem menuitem menuitemcheckbox menuitemradio option row rowheader tabpanel treeitem".split(" "));
  const composedParent = (element) => element?.parentElement || element?.getRootNode?.()?.host || null;
  state.semanticContext = (element) => {
    const context = [];
    const seen = new Set();
    const selfText = boundedDescendantText(element);
    let hasDistinctiveSemanticContext = false;
    let hasGenericContext = false;
    let ancestor = composedParent(element);
    for (let depth = 0; ancestor && depth < 16 && context.length < ${MAX_CONTEXT_ANCESTORS}; depth += 1) {
      if (seen.has(ancestor)) break;
      seen.add(ancestor);
      const role = contextRoleFor(ancestor);
      const semantic = role !== "none" && role !== "presentation";
      const explicitName = explicitContextNameFor(ancestor);
      const mayUseDescendantText = contextualTextRoles.has(role) ||
        (!semantic && !hasDistinctiveSemanticContext && !hasGenericContext);
      const name = explicitName || (mayUseDescendantText ? boundedDescendantText(ancestor) : "");
      const usefulGeneric = !semantic && name && name !== selfText &&
        !hasDistinctiveSemanticContext && !hasGenericContext;
      if (name && (semantic || usefulGeneric)) {
        if (usefulGeneric) hasGenericContext = true;
        else hasDistinctiveSemanticContext = true;
        const previous = context[context.length - 1];
        if (!previous || previous.role !== role || previous.name !== name) context.push({ role, name });
      }
      ancestor = composedParent(ancestor);
    }
    return context.reverse();
  };
  // Install the current implementation on every snapshot. A newer snapshot
  // therefore cannot retain an older, context-free function in the world.
  state.fingerprint = (element, semanticContext = state.semanticContext(element)) => JSON.stringify([
    element?.localName || "",
    identityText(element?.getAttribute?.("role"), 64),
    identityText(element?.getAttribute?.("type"), 64),
    identityText(element?.getAttribute?.("aria-label")),
    identityText(element?.getAttribute?.("aria-labelledby")),
    identityText(element?.getAttribute?.("placeholder")),
    identityText(element?.getAttribute?.("alt")),
    identityText(element?.getAttribute?.("title")),
    identityText(element?.getAttribute?.("href"), 2048),
    boundedDescendantText(element),
    semanticContext,
  ]);
`;

export interface BrowserSnapshotHandle {
  readonly snapshotId: string;
  readonly tabId: string;
  readonly contextId: number;
  readonly generation: number;
  readonly humanControlEpoch: number;
}

interface RawSemanticElement {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly context?: readonly {
    readonly role: string;
    readonly name: string;
  }[];
  readonly description?: string;
  readonly value?: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly states: readonly string[];
}

interface RawSemanticSnapshot {
  readonly generation: number;
  readonly elements: readonly RawSemanticElement[];
  readonly visibleText: string;
  readonly semanticTruncated: boolean;
  readonly visibleTextTruncated: boolean;
}

export const BROWSER_SEMANTIC_SNAPSHOT_EXPRESSION = String.raw`(() => {
  ${BROWSER_AUTOMATION_STATE_BOOTSTRAP}

  const clean = (value, maximum = 192) => String(value ?? "").slice(0, maximum * 4)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, maximum);
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" &&
      style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
  };
  const roleFor = contextRoleFor;
  const textNameRoles = new Set("button heading link menuitem menuitemcheckbox menuitemradio option tab treeitem".split(" "));
  const explicitNameFor = (element) => {
    const labelledBy = clean(element.getAttribute("aria-labelledby"), 512);
    const root = element.getRootNode?.();
    const labelled = labelledBy ? labelledBy.split(/\s+/).map((id) =>
      boundedDescendantText(root?.getElementById?.(id) || document.getElementById(id))
    ).join(" ") : "";
    const labels = [];
    const labelElements = element.labels;
    for (let index = 0; index < Math.min(Number(labelElements?.length) || 0, 8); index += 1) {
      labels.push(boundedDescendantText(labelElements[index]));
    }
    return clean(element.getAttribute("aria-label") || labelled || labels.join(" ") || element.getAttribute("alt") ||
      element.getAttribute("placeholder") || element.getAttribute("title") || "");
  };
  const nameFor = (element, role) => explicitNameFor(element) ||
    (textNameRoles.has(role) ? clean(boundedDescendantText(element)) : "");
  const actionableRoles = new Set("button checkbox combobox link listbox menuitem menuitemcheckbox menuitemradio option radio scrollbar searchbox slider spinbutton switch tab textbox treeitem".split(" "));
  const informativeRoles = new Set("alert alertdialog article dialog document figure form heading img main navigation note status table toolbar".split(" "));
  const round = (value) => Math.round(value * 10) / 10;
  const elements = [];
  const candidates = [];
  const textRoots = [document];
  const seenShadowRoots = new Set();
  const traversalFrames = [];
  const pushTraversalFrame = (container) => {
    const children = container?.children;
    if (children && Number(children.length) > 0) traversalFrames.push({ children, index: 0 });
  };
  pushTraversalFrame(document);
  while (traversalFrames.length > 0 && candidates.length < ${MAX_DOM_ELEMENTS_VISITED}) {
    const frame = traversalFrames[traversalFrames.length - 1];
    if (frame.index >= frame.children.length) {
      traversalFrames.pop();
      continue;
    }
    const element = frame.children[frame.index++];
    if (!element) continue;
    candidates.push(element);
    // Process an open shadow tree before the host's light-DOM descendants,
    // matching the previous recursive ordering without materializing either tree.
    pushTraversalFrame(element);
    const shadowRoot = element.shadowRoot;
    if (shadowRoot && !seenShadowRoots.has(shadowRoot)) {
      seenShadowRoots.add(shadowRoot);
      state.observe(shadowRoot);
      textRoots.push(shadowRoot);
      pushTraversalFrame(shadowRoot);
    }
  }
  const domTraversalTruncated = traversalFrames.some((frame) => frame.index < frame.children.length);
  state.refs.clear();
  const ranked = [];
  let candidateIndex = 0;
  for (const element of candidates) {
    if (!visible(element)) continue;
    const role = roleFor(element);
    const explicitName = explicitNameFor(element);
    const actionable = actionableRoles.has(role) || element.hasAttribute("tabindex") ||
      element.isContentEditable;
    const semantic = actionable || informativeRoles.has(role) || explicitName;
    if (!semantic) continue;
    const rect = element.getBoundingClientRect();
    const inViewport = rect.bottom >= -160 && rect.right >= -160 &&
      rect.top <= innerHeight + 160 && rect.left <= innerWidth + 160;
    ranked.push({
      element, role, rect, name: nameFor(element, role), index: candidateIndex++,
      priority: (inViewport ? 100 : 0) + (actionable ? 40 : 0) + (explicitName ? 10 : 0),
    });
  }
  ranked.sort((left, right) => right.priority - left.priority || left.index - right.index);
  const semanticTruncated = domTraversalTruncated || ranked.length > ${MAX_SEMANTIC_ELEMENTS};
  for (const candidate of ranked.slice(0, ${MAX_SEMANTIC_ELEMENTS})) {
    const { element, role, rect, name } = candidate;
    const ref = "e" + (elements.length + 1);
    const context = state.semanticContext(element);
    state.refs.set(ref, { element, fingerprint: state.fingerprint(element, context) });
    const states = [];
    for (const attribute of ["disabled", "checked", "selected", "expanded", "pressed", "readonly", "required"]) {
      const value = element.getAttribute(attribute) ?? element.getAttribute("aria-" + attribute);
      if (value !== null && value !== "false") states.push(attribute);
    }
    if (element.isContentEditable) states.push("editable");
    const rawValue = "value" in element ? element.value : undefined;
    const value = element.localName === "input" && element.type === "password"
      ? "redacted"
      : clean(rawValue, 1024);
    const item = {
      ref, role, name, context,
      bounds: { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) }, states,
    };
    const description = clean(element.getAttribute("aria-description") || element.getAttribute("aria-describedby"));
    if (description) item.description = description;
    if (value) item.value = value;
    elements.push(item);
  }
  const visibleTextParts = [];
  const seenText = new Set();
  let collectedTextLength = 0;
  let visitedTextNodes = 0;
  let textTraversalTruncated = false;
  const collectVisibleText = (root) => {
    if (collectedTextLength >= 9000 || visitedTextNodes >= ${MAX_VISIBLE_TEXT_NODES_VISITED}) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (collectedTextLength < 9000 && visitedTextNodes < ${MAX_VISIBLE_TEXT_NODES_VISITED}) {
      if (!walker.nextNode()) return;
      visitedTextNodes += 1;
      const node = walker.currentNode;
      const text = clean(node.nodeValue, 512);
      const parent = node.parentElement;
      if (!text || !parent || !visible(parent) || seenText.has(text)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.bottom < -40 || rect.right < -40 || rect.top > innerHeight + 40 || rect.left > innerWidth + 40) continue;
      seenText.add(text);
      visibleTextParts.push(text);
      collectedTextLength += text.length + 1;
    }
    if (visitedTextNodes >= ${MAX_VISIBLE_TEXT_NODES_VISITED}) textTraversalTruncated = true;
  };
  for (let index = 0; index < textRoots.length; index += 1) {
    collectVisibleText(textRoots[index]);
    if (collectedTextLength >= 9000 || visitedTextNodes >= ${MAX_VISIBLE_TEXT_NODES_VISITED}) {
      if (index + 1 < textRoots.length) textTraversalTruncated = true;
      break;
    }
  }
  const rawVisibleText = visibleTextParts.join(" ");
  const visibleText = rawVisibleText.slice(0, 9000);
  return {
    generation: state.generation,
    elements,
    visibleText,
    semanticTruncated,
    visibleTextTruncated: textTraversalTruncated || collectedTextLength >= 9000 || rawVisibleText.length > visibleText.length,
  };
})()`;

const boundedUtf8 = (value: string, maximumBytes: number): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
};

export const createAutomationWorld = async (
  runtime: BrowserAutomationVisibleRuntime,
  signal?: AbortSignal,
): Promise<number> => {
  throwIfAborted(signal);
  await sendCdpCommand(runtime, "Page.enable", {}, signal);
  await sendCdpCommand(runtime, "Runtime.enable", {}, signal);
  const tree = await sendCdpCommand<{
    readonly frameTree?: { readonly frame?: { readonly id?: string } };
  }>(runtime, "Page.getFrameTree", {}, signal);
  const frameId = tree.frameTree?.frame?.id;
  if (!frameId) throw new Error("The visible browser has no main frame.");
  const world = await sendCdpCommand<{ readonly executionContextId?: number }>(
    runtime,
    "Page.createIsolatedWorld",
    { frameId, worldName: BROWSER_AUTOMATION_WORLD_NAME, grantUniveralAccess: false },
    signal,
  );
  throwIfAborted(signal);
  if (!world.executionContextId) throw new Error("The browser automation world is unavailable.");
  return world.executionContextId;
};

export const captureSemanticSnapshot = async (
  runtime: BrowserAutomationVisibleRuntime,
  input: {
    readonly includeImage: boolean;
    readonly includeDiagnostics: boolean;
    readonly humanControlEpoch: number;
  },
  signal?: AbortSignal,
): Promise<{
  readonly output: BrowserSnapshotHostOutput;
  readonly handle: BrowserSnapshotHandle;
}> => {
  throwIfAborted(signal);
  const contextId = await createAutomationWorld(runtime, signal);
  const semantic = await evaluateInContext<RawSemanticSnapshot>(
    runtime,
    BROWSER_SEMANTIC_SNAPSHOT_EXPRESSION,
    {
      contextId,
      signal,
    },
  );
  if (!semantic.value || !Array.isArray(semantic.value.elements)) {
    throw new Error("The browser semantic snapshot was malformed.");
  }
  const page = await observePage(runtime, signal);
  const snapshotId = Crypto.randomUUID();
  const truncationReasons: string[] = [];
  if (semantic.value.semanticTruncated) truncationReasons.push("semantic-element-limit");
  if (
    semantic.value.visibleTextTruncated ||
    Buffer.byteLength(semantic.value.visibleText, "utf8") > MAX_VISIBLE_TEXT_BYTES
  ) {
    truncationReasons.push("visible-text-limit");
  }
  let structuredContent: BrowserSnapshotOutput = {
    snapshotId: snapshotId as BrowserSnapshotOutput["snapshotId"],
    tabId: runtime.tabId as BrowserTabId,
    url: boundedUtf8(page.url, 8_192),
    title: boundedUtf8(page.title, 2_048),
    capturedAt: new Date().toISOString() as unknown as BrowserSnapshotOutput["capturedAt"],
    viewport: page.viewport,
    semanticSource: "bounded-wai-aria",
    semanticCoverage: {
      openShadow: "observed",
      interceptedClosedShadow: "unobservable",
      declarativeClosedShadow: "unobservable",
    },
    elements: semantic.value.elements.map((element) => ({
      ...element,
      role: element.role as BrowserSnapshotOutput["elements"][number]["role"],
      name: boundedUtf8(element.name, 256),
      context: (element.context ?? [])
        .slice(0, MAX_CONTEXT_ANCESTORS)
        .map((ancestor: { readonly role: string; readonly name: string }) => ({
          role: ancestor.role as BrowserSnapshotOutput["elements"][number]["role"],
          name: boundedUtf8(ancestor.name, 512),
        })),
      ...(element.description ? { description: boundedUtf8(element.description, 256) } : {}),
      ...(element.value ? { value: boundedUtf8(element.value, 1_024) } : {}),
      states: [...element.states].slice(0, 24),
    })),
    visibleText: boundedUtf8(semantic.value.visibleText, MAX_VISIBLE_TEXT_BYTES),
    diagnostics: input.includeDiagnostics
      ? [
          {
            code: "semantic-runtime",
            message: "Snapshot collected from the shared Electron browser runtime.",
          },
          {
            code: "closed-shadow-unobservable",
            message:
              "Closed shadow roots created before snapshot collection cannot be observed safely.",
          },
        ]
      : [],
    truncationReasons,
  };

  while (
    Buffer.byteLength(JSON.stringify(structuredContent), "utf8") > MAX_STRUCTURED_SNAPSHOT_BYTES &&
    structuredContent.elements.length > 0
  ) {
    structuredContent = {
      ...structuredContent,
      elements: structuredContent.elements.slice(0, -1),
      truncationReasons: structuredContent.truncationReasons.includes("structured-byte-limit")
        ? structuredContent.truncationReasons
        : [...structuredContent.truncationReasons, "structured-byte-limit"],
    };
  }
  if (
    Buffer.byteLength(JSON.stringify(structuredContent), "utf8") > MAX_STRUCTURED_SNAPSHOT_BYTES
  ) {
    browserHostError({
      code: "BrowserSnapshotTooLarge",
      retryable: true,
      phase: "snapshot",
      effectMayHaveCommitted: false,
      tabId: runtime.tabId as BrowserTabId,
    });
  }

  let image: BrowserSnapshotHostOutput["image"];
  if (input.includeImage) {
    throwIfAborted(signal);
    let nativeImage = await drainOnAbort(runtime.webContents.capturePage(), signal);
    throwIfAborted(signal);
    const originalSize = nativeImage.getSize();
    if (originalSize.width > 3_840 || originalSize.height > 2_160) {
      const scale = Math.min(3_840 / originalSize.width, 2_160 / originalSize.height);
      nativeImage = nativeImage.resize({
        width: Math.max(1, Math.floor(originalSize.width * scale)),
        height: Math.max(1, Math.floor(originalSize.height * scale)),
        quality: "best",
      });
    }
    const png = nativeImage.toPNG();
    const size = nativeImage.getSize();
    if (png.byteLength === 0 || png.byteLength > MAX_SCREENSHOT_BYTES) {
      browserHostError({
        code: "BrowserSnapshotTooLarge",
        retryable: true,
        phase: "snapshot",
        effectMayHaveCommitted: false,
        tabId: runtime.tabId as BrowserTabId,
      });
    }
    const imageMetadata: NonNullable<BrowserSnapshotOutput["image"]> = {
      mimeType: "image/png",
      width: Math.max(1, size.width),
      height: Math.max(1, size.height),
      byteLength: png.byteLength,
    };
    structuredContent = { ...structuredContent, image: imageMetadata };
    image = {
      ...imageMetadata,
      data: png.toString("base64"),
    };
  }

  return {
    output: { structuredContent, ...(image ? { image } : {}) },
    handle: {
      snapshotId,
      tabId: runtime.tabId,
      contextId,
      generation: semantic.value.generation,
      humanControlEpoch: input.humanControlEpoch,
    },
  };
};
