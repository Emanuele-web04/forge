import { ThreadId, type BrowserElementRef, type BrowserSnapshotId } from "@synara/contracts";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { BrowserAutomationHostError } from "./hostErrors";
import { BROWSER_SEMANTIC_SNAPSHOT_EXPRESSION } from "./semanticSnapshot";
import { resolveBrowserTarget } from "./targets";

const TAB_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222" as BrowserSnapshotId;
const ELEMENT_REF = "e1" as BrowserElementRef;

class FakeElement {
  readonly nodeType = 1;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly shadowRoot = null;
  readonly isContentEditable = false;
  readonly multiple = false;
  parentElement: FakeElement | null = null;
  ownerDocument!: FakeDocument;

  constructor(
    readonly localName: string,
    private readonly ownText = "",
    attributes: Readonly<Record<string, string>> = {},
  ) {
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
  }

  get textContent(): string {
    return [this.ownText, ...this.children.map((child) => child.textContent)]
      .filter(Boolean)
      .join(" ");
  }

  get childNodes(): readonly unknown[] {
    return [
      ...(this.ownText
        ? [{ nodeType: 3, nodeValue: this.ownText, parentElement: this, childNodes: [] }]
        : []),
      ...this.children,
    ];
  }

  append(...children: FakeElement[]): this {
    for (const child of children) {
      if (child.parentElement) {
        const previousIndex = child.parentElement.children.indexOf(child);
        if (previousIndex >= 0) child.parentElement.children.splice(previousIndex, 1);
      }
      child.parentElement = this;
      this.children.push(child);
      if (this.ownerDocument) this.ownerDocument.adopt(child);
    }
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  // Selector support is limited to the comma-separated tag lists the embedded
  // credential classifier actually queries ("input, textarea").
  querySelectorAll(selector: string): FakeElement[] {
    const tags = new Set(selector.split(",").map((part) => part.trim().toLowerCase()));
    const matches: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (tags.has(child.localName)) matches.push(child);
        walk(child);
      }
    };
    walk(this);
    return matches;
  }

  getBoundingClientRect() {
    return { x: 10, y: 10, top: 10, right: 90, bottom: 42, left: 10, width: 80, height: 32 };
  }

  getRootNode(): FakeDocument {
    return this.ownerDocument;
  }
}

class FakeInputElement extends FakeElement {
  constructor(attributes: Readonly<Record<string, string>>) {
    super("input", "", attributes);
  }

  get type(): string {
    return (this.getAttribute("type") ?? "text").toLowerCase();
  }

  get value(): string {
    return this.getAttribute("value") ?? "";
  }
}

class FakeTextAreaElement extends FakeElement {
  constructor(attributes: Readonly<Record<string, string>>) {
    super("textarea", "", attributes);
  }

  get value(): string {
    return this.getAttribute("value") ?? "";
  }
}

class FakeDocument {
  readonly host = null;
  textWalkerVisits = 0;

  constructor(readonly roots: readonly FakeElement[]) {
    for (const root of roots) this.adopt(root);
  }

  adopt(element: FakeElement): void {
    element.ownerDocument = this;
    for (const child of element.children) this.adopt(child);
  }

  get children(): readonly FakeElement[] {
    return this.roots;
  }

  querySelectorAll(): FakeElement[] {
    const elements: FakeElement[] = [];
    const visit = (element: FakeElement) => {
      elements.push(element);
      for (const child of element.children) visit(child);
    };
    for (const root of this.roots) visit(root);
    return elements;
  }

  getElementById(id: string): FakeElement | null {
    return this.querySelectorAll().find((element) => element.getAttribute("id") === id) ?? null;
  }

  createTreeWalker(root: FakeDocument | FakeElement) {
    const frames: { children: readonly unknown[]; index: number }[] = [];
    const pushChildren = (
      node: FakeDocument | FakeElement | { readonly childNodes?: readonly unknown[] },
    ) => {
      const children = node instanceof FakeDocument ? node.children : node.childNodes;
      if (children && children.length > 0) frames.push({ children, index: 0 });
    };
    pushChildren(root);
    const walker: { currentNode: unknown; nextNode: () => boolean } = {
      currentNode: null,
      nextNode: () => {
        while (frames.length > 0) {
          const frame = frames[frames.length - 1]!;
          if (frame.index >= frame.children.length) {
            frames.pop();
            continue;
          }
          const node = frame.children[frame.index++] as {
            readonly nodeType?: number;
            readonly childNodes?: readonly unknown[];
          };
          if (node.nodeType === 3) {
            this.textWalkerVisits += 1;
            walker.currentNode = node;
            return true;
          }
          pushChildren(node);
        }
        return false;
      },
    };
    return walker;
  }

  createRange() {
    return {
      selectNodeContents: () => {},
      getBoundingClientRect: () => ({
        x: 10,
        y: 10,
        top: 10,
        right: 90,
        bottom: 42,
        left: 10,
        width: 80,
        height: 32,
      }),
    };
  }
}

interface PageHarness {
  readonly document: FakeDocument;
  readonly globalObject: Record<string, unknown>;
}

interface SemanticElementResult {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly context: readonly { readonly role: string; readonly name: string }[];
  readonly value?: string;
}

interface SemanticSnapshotResult {
  readonly elements: readonly SemanticElementResult[];
  readonly visibleText: string;
  readonly semanticTruncated: boolean;
  readonly visibleTextTruncated: boolean;
}

interface StoredRefState {
  readonly refs: Map<string, { readonly element: FakeElement; readonly fingerprint: string }>;
  readonly fingerprint: (element: FakeElement) => string;
}

const evaluatePageExpression = (harness: PageHarness, expression: string): unknown => {
  const execute = new Function(
    "globalThis",
    "document",
    "getComputedStyle",
    "innerHeight",
    "innerWidth",
    "NodeFilter",
    `"use strict"; return ${expression};`,
  ) as (...argumentsValue: readonly unknown[]) => unknown;
  return execute(
    harness.globalObject,
    harness.document,
    () => ({ display: "block", visibility: "visible", opacity: "1" }),
    768,
    1_024,
    { SHOW_TEXT: 4 },
  );
};

const snapshotHarness = (root: FakeElement): PageHarness => ({
  document: new FakeDocument([root]),
  globalObject: {},
});

const automationState = (harness: PageHarness): StoredRefState =>
  harness.globalObject.__synaraBrowserAutomationV1 as StoredRefState;

describe("semantic snapshot context", () => {
  it("redacts password input values regardless of attribute casing", () => {
    const password = new FakeInputElement({
      "aria-label": "Password",
      type: "PaSsWoRd",
      value: "correct horse battery staple",
    });
    const harness = snapshotHarness(password);

    const snapshot = evaluatePageExpression(
      harness,
      BROWSER_SEMANTIC_SNAPSHOT_EXPRESSION,
    ) as SemanticSnapshotResult;

    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.elements[0]).toMatchObject({ role: "textbox", value: "redacted" });
    expect(JSON.stringify(snapshot)).not.toContain("correct horse battery staple");
  });

  it("redacts one-time verification codes in text inputs", () => {
    const verificationCode = new FakeInputElement({
      "aria-label": "Verification code",
      autocomplete: "one-time-code",
      value: "123456",
    });
    const harness = snapshotHarness(verificationCode);

    const snapshot = evaluatePageExpression(
      harness,
      BROWSER_SEMANTIC_SNAPSHOT_EXPRESSION,
    ) as SemanticSnapshotResult;

    expect(snapshot.elements[0]).toMatchObject({ role: "textbox", value: "redacted" });
    expect(JSON.stringify(snapshot)).not.toContain("123456");
  });

  it("redacts verification codes in labeled textareas", () => {
    const verificationCode = new FakeTextAreaElement({
      "aria-label": "Verification code",
      value: "654321",
    });
    const harness = snapshotHarness(verificationCode);

    const snapshot = evaluatePageExpression(
      harness,
      BROWSER_SEMANTIC_SNAPSHOT_EXPRESSION,
    ) as SemanticSnapshotResult;

    expect(snapshot.elements[0]).toMatchObject({ role: "textbox", value: "redacted" });
    expect(JSON.stringify(snapshot)).not.toContain("654321");
  });

  it("keeps benign email values visible outside authentication flows", () => {
    const email = new FakeInputElement({
      "aria-label": "Email address",
      type: "email",
      name: "email",
      value: "user@example.test",
    });
    const form = new FakeElement("form", "", { action: "/subscribe", class: "newsletter" });
    form.append(email);
    const harness = snapshotHarness(form);

    const snapshot = evaluatePageExpression(
      harness,
      BROWSER_SEMANTIC_SNAPSHOT_EXPRESSION,
    ) as SemanticSnapshotResult;

    const emailElement = snapshot.elements.find((element) => element.name === "Email address");
    expect(emailElement).toMatchObject({ role: "textbox", value: "user@example.test" });
  });

  it("redacts email values when the form also collects a password", () => {
    const email = new FakeInputElement({
      "aria-label": "Email address",
      type: "email",
      name: "email",
      value: "user@example.test",
    });
    const password = new FakeInputElement({
      "aria-label": "Password",
      type: "password",
      value: "hunter2",
    });
    const form = new FakeElement("form", "", { action: "/next" });
    form.append(email, password);
    const harness = snapshotHarness(form);

    const snapshot = evaluatePageExpression(
      harness,
      BROWSER_SEMANTIC_SNAPSHOT_EXPRESSION,
    ) as SemanticSnapshotResult;

    const emailElement = snapshot.elements.find((element) => element.name === "Email address");
    expect(emailElement).toMatchObject({ role: "textbox", value: "redacted" });
    expect(JSON.stringify(snapshot)).not.toContain("user@example.test");
    expect(JSON.stringify(snapshot)).not.toContain("hunter2");
  });

  it("redacts localized password fields without type=password", () => {
    const localized = new FakeInputElement({
      "aria-label": "Contraseña",
      value: "correcto caballo",
    });
    const harness = snapshotHarness(localized);

    const snapshot = evaluatePageExpression(
      harness,
      BROWSER_SEMANTIC_SNAPSHOT_EXPRESSION,
    ) as SemanticSnapshotResult;

    expect(snapshot.elements[0]).toMatchObject({ role: "textbox", value: "redacted" });
    expect(JSON.stringify(snapshot)).not.toContain("correcto caballo");
  });

  it("keeps credential text nodes out of the visible-text capture", () => {
    const root = new FakeElement("main");
    const secretArea = new FakeElement("textarea", "654321", {
      "aria-label": "Verification code",
    });
    root.append(new FakeElement("span", "Public text"), secretArea);
    const harness = snapshotHarness(root);

    const snapshot = evaluatePageExpression(
      harness,
      BROWSER_SEMANTIC_SNAPSHOT_EXPRESSION,
    ) as SemanticSnapshotResult;

    expect(snapshot.visibleText).toContain("Public text");
    expect(snapshot.visibleText).not.toContain("654321");
  });

  it("strictly bounds element and text-node traversal on adversarial pages", () => {
    const root = new FakeElement("main");
    for (let index = 0; index < 19_999; index += 1) {
      root.append(new FakeElement("span", " "));
    }
    const beyondElementBudget = new FakeElement("button", " ");
    beyondElementBudget.getBoundingClientRect = () => {
      throw new Error("semantic traversal exceeded its element budget");
    };
    root.append(beyondElementBudget, new FakeElement("span", " "));
    const harness = snapshotHarness(root);

    const snapshot = evaluatePageExpression(
      harness,
      BROWSER_SEMANTIC_SNAPSHOT_EXPRESSION,
    ) as SemanticSnapshotResult;

    expect(snapshot.semanticTruncated).toBe(true);
    expect(snapshot.visibleTextTruncated).toBe(true);
    expect(snapshot.visibleText).toBe("");
    expect(harness.document.textWalkerVisits).toBe(20_000);
  });

  it("distinguishes repeated controls by bounded semantic ancestry", () => {
    const aliceDelete = new FakeElement("button", "Delete");
    const bobDelete = new FakeElement("button", "Delete");
    const users = new FakeElement("ul").append(
      new FakeElement("li").append(new FakeElement("span", "Alice"), aliceDelete),
      new FakeElement("li").append(new FakeElement("span", "Bob"), bobDelete),
    );
    const harness = snapshotHarness(users);

    const snapshot = evaluatePageExpression(
      harness,
      BROWSER_SEMANTIC_SNAPSHOT_EXPRESSION,
    ) as SemanticSnapshotResult;
    const deleteControls = snapshot.elements.filter(
      (element) => element.role === "button" && element.name === "Delete",
    );

    expect(deleteControls).toHaveLength(2);
    expect(deleteControls[0]?.context).toEqual([{ role: "listitem", name: "Alice Delete" }]);
    expect(deleteControls[1]?.context).toEqual([{ role: "listitem", name: "Bob Delete" }]);
    expect(deleteControls[0]?.context).not.toEqual(deleteControls[1]?.context);
    expect(deleteControls.every((element) => element.context.length <= 4)).toBe(true);
  });

  it("marks a reused live node stale when its semantic context changes", async () => {
    const reusedDelete = new FakeElement("button", "Delete");
    const alice = new FakeElement("li").append(new FakeElement("span", "Alice"), reusedDelete);
    const bob = new FakeElement("li").append(new FakeElement("span", "Bob"));
    const harness = snapshotHarness(new FakeElement("ul").append(alice, bob));
    evaluatePageExpression(harness, BROWSER_SEMANTIC_SNAPSHOT_EXPRESSION);
    const stored = automationState(harness).refs.get("e1");
    expect(stored?.element).toBe(reusedDelete);

    bob.append(reusedDelete);
    expect(stored?.fingerprint).not.toBe(automationState(harness).fingerprint(reusedDelete));

    const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method !== "Runtime.evaluate") throw new Error(`Unexpected CDP method: ${method}`);
      return {
        result: {
          value: evaluatePageExpression(harness, String(params?.expression ?? "")),
        },
      };
    });
    const webContents = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => true,
        attach: vi.fn(),
        sendCommand,
      },
    } as unknown as WebContents;
    const runtime: BrowserAutomationVisibleRuntime = {
      threadId: ThreadId.makeUnsafe("thread-semantic-context"),
      tabId: TAB_ID,
      webContents,
    };

    await expect(
      resolveBrowserTarget(
        runtime,
        { ref: ELEMENT_REF, snapshotId: SNAPSHOT_ID },
        {
          snapshotId: SNAPSHOT_ID,
          tabId: TAB_ID,
          contextId: 12,
          generation: 0,
          humanControlEpoch: 0,
        },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BrowserAutomationHostError &&
        error.browserError.code === "BrowserStaleReference",
    );
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });
});
