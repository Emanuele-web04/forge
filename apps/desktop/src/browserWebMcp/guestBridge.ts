import { contextBridge, ipcRenderer } from "electron";

import { BROWSER_IPC_CHANNELS } from "../ipcChannels";

/**
 * Install the page-facing WebMCP compatibility API and Synara's private bridge
 * in the main world before application scripts run. This function is
 * serialized by Electron, so every helper intentionally lives inside it.
 */
export function installWebMcpBridgeInMainWorld(hostAllowsCompatibility = false): void {
  type JsonObject = Record<string, unknown>;
  type PageTool = {
    readonly name: string;
    readonly title?: string;
    readonly description: string;
    readonly inputSchema?: unknown;
    readonly execute?: (input: JsonObject, options: { readonly signal: AbortSignal }) => unknown;
    readonly annotations?: {
      readonly readOnlyHint?: boolean;
      readonly untrustedContentHint?: boolean;
    };
    readonly origin?: string;
    readonly window?: Window;
  };
  type RegisteredPageTool = PageTool & {
    readonly origin: string;
    readonly window: Window;
  };

  const BRIDGE_PROPERTY = "__synaraWebMcpBridgeV1";
  const root = globalThis as typeof globalThis & Record<string, unknown>;
  if (root[BRIDGE_PROPERTY] !== undefined) return;

  const documentRecord = document as Document & { modelContext?: unknown };
  const navigatorRecord = navigator as Navigator & { modelContext?: unknown };
  const documentModelContext = documentRecord.modelContext;
  const navigatorModelContext = navigatorRecord.modelContext;
  const nativeModelContext = documentModelContext ?? navigatorModelContext;
  const documentPolicy = document as Document & {
    readonly permissionsPolicy?: {
      readonly allowsFeature?: (feature: string) => boolean;
      readonly features?: () => readonly string[];
    };
    readonly featurePolicy?: {
      readonly allowsFeature?: (feature: string) => boolean;
      readonly features?: () => readonly string[];
    };
  };
  const permissionsPolicy = documentPolicy.permissionsPolicy ?? documentPolicy.featurePolicy;
  if (globalThis.isSecureContext !== true) return;
  const supportsToolsPolicy = permissionsPolicy?.features?.().includes("tools") === true;
  const toolsPolicyAllowed =
    supportsToolsPolicy && permissionsPolicy?.allowsFeature?.("tools") === true;
  // Native WebMCP owns its own Permissions-Policy enforcement. The compatibility
  // API must fail closed unless Chromium can positively identify and allow the
  // draft's `tools` feature; treating an unknown feature as allowed would ignore
  // a page's policy on Electron versions that predate WebMCP.
  if (!nativeModelContext && !toolsPolicyAllowed && !hostAllowsCompatibility) return;
  if (supportsToolsPolicy && !toolsPolicyAllowed) return;

  const MAX_TOOLS = 128;
  const MAX_NAME_BYTES = 128;
  const MAX_TITLE_BYTES = 1_024;
  const MAX_DESCRIPTION_BYTES = 4_096;
  const MAX_SCHEMA_BYTES = 16_384;
  const MAX_BRIDGE_LIST_BYTES = 24 * 1_024;
  // Tool output is fed back to a model. Keep this materially below the generic
  // browser JSON ceiling so a page cannot flood the turn context.
  const MAX_RESULT_BYTES = 65_536;
  const encoder = new TextEncoder();
  const byteLength = (value: string): number => encoder.encode(value).byteLength;
  const jsonDepth = (value: unknown, depth = 0): number => {
    if (value === null || typeof value !== "object") return depth;
    if (depth > 20) return depth;
    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    return children.reduce(
      (maximum, child) => Math.max(maximum, jsonDepth(child, depth + 1)),
      depth,
    );
  };
  const normalizedText = (value: unknown, maximumBytes: number): string | null => {
    if (typeof value !== "string") return null;
    const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
    return normalized.length > 0 && byteLength(normalized) <= maximumBytes ? normalized : null;
  };
  const normalizedToolName = (value: unknown): string | null => {
    const name = normalizedText(value, MAX_NAME_BYTES);
    return name && /^[A-Za-z0-9_.-]+$/u.test(name) ? name : null;
  };
  const descriptorSignature = async (descriptor: string): Promise<string> => {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(descriptor));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  };
  const normalizedSchema = (value: unknown): JsonObject | null => {
    let candidate = value;
    if (typeof candidate === "string") {
      if (byteLength(candidate) > MAX_SCHEMA_BYTES) return null;
      try {
        candidate = JSON.parse(candidate) as unknown;
      } catch {
        return null;
      }
    }
    if (candidate === undefined) candidate = { type: "object", properties: {} };
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
      return null;
    try {
      const serialized = JSON.stringify(candidate);
      const cloned = JSON.parse(serialized) as JsonObject;
      if (byteLength(serialized) > MAX_SCHEMA_BYTES || jsonDepth(cloned) > 20) return null;
      return cloned;
    } catch {
      return null;
    }
  };
  const safeError = (error: unknown): { readonly name: string; readonly message: string } => {
    let rawName = "WebMcpToolError";
    let rawMessage = "The page-declared WebMCP tool failed.";
    try {
      if (error instanceof Error) {
        rawName = error.name;
        rawMessage = error.message;
      } else {
        rawMessage = String(error);
      }
    } catch {
      // A page may reject with an object whose coercion itself throws. Never
      // let that hostile error value escape Synara's bounded error envelope.
    }
    return {
      name: normalizedText(rawName, MAX_NAME_BYTES) ?? "WebMcpToolError",
      message:
        normalizedText(rawMessage, MAX_DESCRIPTION_BYTES) ??
        "The page-declared WebMCP tool failed.",
    };
  };

  const awaitWithAbort = async <T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!signal) return await operation;
    if (signal.aborted) throw signal.reason;
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };

  const declarativeForm = Symbol("synara.webmcp.declarative-form");
  type DeclarativeTool = RegisteredPageTool & { readonly [declarativeForm]: HTMLFormElement };
  let ensureDeclarativeObservation = (): void => undefined;

  const controlDescription = (control: Element): string | undefined => {
    const explicit = normalizedText(control.getAttribute("toolparamdescription"), 1_024);
    if (explicit) return explicit;
    if (
      (control instanceof HTMLInputElement ||
        control instanceof HTMLSelectElement ||
        control instanceof HTMLTextAreaElement) &&
      control.labels?.length
    ) {
      const label = normalizedText(control.labels[0]?.textContent, 1_024);
      if (label) return label;
    }
    return (
      normalizedText(control.getAttribute("aria-description"), 1_024) ??
      normalizedText(control.getAttribute("aria-label"), 1_024) ??
      undefined
    );
  };

  const declarativeSchema = (form: HTMLFormElement): JsonObject => {
    const properties: Record<string, JsonObject> = {};
    const required = new Set<string>();
    const controls = Array.from(form.elements).filter(
      (element): element is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
        (element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLTextAreaElement) &&
        !element.disabled &&
        element.name.trim().length > 0,
    );
    for (const control of controls) {
      const name = control.name;
      if (properties[name]) {
        if (control.required) required.add(name);
        continue;
      }
      const description = controlDescription(control);
      let property: JsonObject = { type: "string", ...(description ? { description } : {}) };
      if (control instanceof HTMLInputElement) {
        if (["button", "file", "hidden", "image", "reset", "submit"].includes(control.type)) {
          continue;
        }
        if (control.type === "checkbox") {
          property = { type: "boolean", ...(description ? { description } : {}) };
        } else if (control.type === "number" || control.type === "range") {
          property = { type: "number", ...(description ? { description } : {}) };
        } else if (control.type === "radio") {
          const values = controls
            .filter(
              (candidate): candidate is HTMLInputElement =>
                candidate instanceof HTMLInputElement &&
                candidate.type === "radio" &&
                candidate.name === name,
            )
            .map((candidate) => candidate.value);
          property = {
            type: "string",
            enum: [...new Set(values)],
            ...(description ? { description } : {}),
          };
        }
      } else if (control instanceof HTMLSelectElement) {
        const values = Array.from(control.options).map((option) => option.value);
        const titles = Array.from(control.options).map((option) => ({
          type: "string",
          const: option.value,
          title: option.textContent?.trim() || option.value,
        }));
        property = control.multiple
          ? {
              type: "array",
              items: { type: "string", enum: values },
              ...(description ? { description } : {}),
            }
          : {
              type: "string",
              anyOf: titles,
              enum: values,
              ...(description ? { description } : {}),
            };
      }
      properties[name] = property;
      if (control.required) required.add(name);
    }
    return {
      type: "object",
      properties,
      ...(required.size > 0 ? { required: [...required] } : {}),
    };
  };

  const declarativeTools = (): DeclarativeTool[] =>
    Array.from(document.querySelectorAll<HTMLFormElement>("form[toolname][tooldescription]"))
      .slice(0, MAX_TOOLS)
      .flatMap((form) => {
        const name = normalizedToolName(form.getAttribute("toolname"));
        const description = normalizedText(
          form.getAttribute("tooldescription"),
          MAX_DESCRIPTION_BYTES,
        );
        if (!name || !description) return [];
        const tool = {
          name,
          description,
          inputSchema: declarativeSchema(form),
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          origin: globalThis.location.origin,
          window: globalThis.window,
          execute: async () => null,
          [declarativeForm]: form,
        } satisfies DeclarativeTool;
        return [tool];
      });

  const fillDeclarativeForm = (form: HTMLFormElement, input: JsonObject): void => {
    for (const [name, value] of Object.entries(input)) {
      const controls = Array.from(form.elements).filter(
        (element): element is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
          (element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement) &&
          element.name === name &&
          !element.disabled,
      );
      for (const control of controls) {
        if (control instanceof HTMLInputElement && control.type === "checkbox") {
          control.checked = value === true;
        } else if (control instanceof HTMLInputElement && control.type === "radio") {
          control.checked = String(value) === control.value;
        } else if (control instanceof HTMLSelectElement && control.multiple) {
          const selected = new Set(Array.isArray(value) ? value.map(String) : [String(value)]);
          for (const option of Array.from(control.options)) {
            option.selected = selected.has(option.value);
          }
        } else {
          control.value = value === null || value === undefined ? "" : String(value);
        }
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    form.scrollIntoView({ block: "center", inline: "nearest" });
    const firstEditable = Array.from(form.elements).find(
      (element): element is HTMLElement => element instanceof HTMLElement && !element.hidden,
    );
    firstEditable?.focus({ preventScroll: true });
    const activated = new CustomEvent("toolactivated");
    Object.defineProperty(activated, "toolName", { value: form.getAttribute("toolname") ?? "" });
    (modelContext as EventTarget).dispatchEvent(activated);
  };

  const submitDeclarativeForm = async (
    form: HTMLFormElement,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (!form.hasAttribute("toolautosubmit")) {
      return "The page form was filled and is awaiting user submission.";
    }
    const submitter = form.querySelector<HTMLElement>(
      'button[type="submit"], input[type="submit"], button:not([type])',
    );
    const event = new SubmitEvent("submit", {
      bubbles: true,
      cancelable: true,
      submitter:
        submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
          ? submitter
          : null,
    });
    let response: Promise<unknown> | null = null;
    Object.defineProperty(event, "agentInvoked", { value: true });
    Object.defineProperty(event, "respondWith", {
      value: (result: Promise<unknown>) => {
        if (response) throw new DOMException("respondWith was already called", "InvalidStateError");
        if (!event.defaultPrevented) {
          throw new DOMException("respondWith requires preventDefault", "InvalidStateError");
        }
        response = Promise.resolve(result);
      },
    });
    const shouldSubmit = form.dispatchEvent(event);
    if (response) return await awaitWithAbort(response, signal);
    if (shouldSubmit) HTMLFormElement.prototype.submit.call(form);
    return null;
  };

  class CompatibilityModelContext extends EventTarget {
    readonly #tools = new Map<string, PageTool>();
    #toolChangeHandler: EventListener | null = null;

    get ontoolchange(): EventListener | null {
      return this.#toolChangeHandler;
    }

    set ontoolchange(handler: EventListener | null) {
      if (this.#toolChangeHandler) this.removeEventListener("toolchange", this.#toolChangeHandler);
      this.#toolChangeHandler = typeof handler === "function" ? handler : null;
      if (this.#toolChangeHandler) {
        ensureDeclarativeObservation();
        this.addEventListener("toolchange", this.#toolChangeHandler);
      }
    }

    override addEventListener(
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (type === "toolchange") ensureDeclarativeObservation();
      super.addEventListener(type, callback, options);
    }

    async registerTool(
      tool: PageTool,
      options: { readonly signal?: AbortSignal } = {},
    ): Promise<void> {
      const name = normalizedToolName(tool?.name);
      const description = normalizedText(tool?.description, MAX_DESCRIPTION_BYTES);
      const title =
        tool?.title === undefined ? undefined : normalizedText(tool.title, MAX_TITLE_BYTES);
      const inputSchema = normalizedSchema(tool?.inputSchema);
      if (!name || !description || tool?.execute instanceof Function === false || !inputSchema) {
        throw new TypeError("Invalid WebMCP tool definition");
      }
      if (options.signal?.aborted) throw options.signal.reason;
      if (this.#tools.has(name)) {
        throw new DOMException(
          "A WebMCP tool with this name is already registered",
          "InvalidStateError",
        );
      }
      this.#tools.set(name, {
        name,
        ...(title ? { title } : {}),
        description,
        inputSchema,
        execute: tool.execute,
        annotations: {
          readOnlyHint: tool.annotations?.readOnlyHint === true,
          untrustedContentHint: tool.annotations?.untrustedContentHint === true,
        },
      });
      const unregister = () => {
        if (this.#tools.get(name)?.execute !== tool.execute) return;
        this.#tools.delete(name);
        this.dispatchEvent(new Event("toolchange"));
      };
      options.signal?.addEventListener("abort", unregister, { once: true });
      this.dispatchEvent(new Event("toolchange"));
    }

    async getTools(): Promise<RegisteredPageTool[]> {
      ensureDeclarativeObservation();
      const imperative = [...this.#tools.values()].map((tool) => ({
        ...tool,
        origin: globalThis.location.origin,
        window: globalThis.window,
      }));
      const declarative = declarativeTools();
      return [...imperative, ...declarative]
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_TOOLS);
    }

    async executeTool(
      tool: RegisteredPageTool,
      inputObject: JsonObject,
      options: { readonly signal?: AbortSignal } = {},
    ): Promise<string> {
      if (inputObject === null || typeof inputObject !== "object" || Array.isArray(inputObject)) {
        throw new TypeError("WebMCP tool arguments must be a JSON object");
      }
      if (options.signal?.aborted) throw options.signal.reason;
      let result: unknown;
      if (declarativeForm in tool) {
        const form = (tool as DeclarativeTool)[declarativeForm];
        if (!form.isConnected) {
          throw new DOMException("The WebMCP form is stale", "InvalidStateError");
        }
        if (options.signal?.aborted) throw options.signal.reason;
        fillDeclarativeForm(form, inputObject);
        result = await submitDeclarativeForm(form, options.signal);
      } else {
        const registered = this.#tools.get(tool.name);
        if (!registered?.execute) {
          throw new DOMException("The WebMCP tool is stale", "InvalidStateError");
        }
        const controller = new AbortController();
        const forwardAbort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", forwardAbort, { once: true });
        try {
          result = await registered.execute(inputObject, { signal: controller.signal });
        } finally {
          options.signal?.removeEventListener("abort", forwardAbort);
        }
      }
      const serialized = JSON.stringify(result === undefined ? null : result);
      if (serialized === undefined) {
        throw new TypeError("WebMCP tool result is not JSON serializable");
      }
      return serialized;
    }
  }

  let modelContext = nativeModelContext;
  // The current draft moved ModelContext to Document and accepts an object.
  // Chromium's earlier navigator API accepted stringified JSON instead.
  const nativeInputFormat = documentModelContext ? "object" : "json-string";
  let implementation: "native" | "compatibility" = "native";
  if (!modelContext) {
    modelContext = new CompatibilityModelContext();
    implementation = "compatibility";
  }
  if (!documentRecord.modelContext) {
    Object.defineProperty(documentRecord, "modelContext", { value: modelContext });
  }
  if (!navigatorRecord.modelContext) {
    Object.defineProperty(navigatorRecord, "modelContext", { value: modelContext });
  }

  const context = modelContext as {
    readonly getTools: () => Promise<RegisteredPageTool[]>;
    readonly executeTool: (
      tool: RegisteredPageTool,
      input: JsonObject | string,
      options?: { readonly signal?: AbortSignal },
    ) => Promise<unknown>;
  };
  const pending = new Map<string, AbortController>();
  const normalizeTool = async (
    tool: RegisteredPageTool,
    index: number,
  ): Promise<{
    readonly index: number;
    readonly signature: string;
    readonly name: string;
    readonly title?: string;
    readonly description: string;
    readonly inputSchema: JsonObject;
    readonly origin: string;
    readonly annotations: {
      readonly readOnlyHint: boolean;
      readonly untrustedContentHint: boolean;
    };
  } | null> => {
    const name = normalizedToolName(tool?.name);
    const description = normalizedText(tool?.description, MAX_DESCRIPTION_BYTES);
    const title =
      tool?.title === undefined ? undefined : normalizedText(tool.title, MAX_TITLE_BYTES);
    const inputSchema = normalizedSchema(tool?.inputSchema);
    const origin = normalizedText(tool?.origin ?? globalThis.location.origin, 8_192);
    if (!name || !description || !inputSchema || !origin) return null;
    const descriptor = {
      name,
      ...(title ? { title } : {}),
      description,
      inputSchema,
      origin,
      annotations: {
        readOnlyHint: tool.annotations?.readOnlyHint === true,
        // All page-provided metadata and results are untrusted to Synara even
        // when the page author omits the WebMCP hint.
        untrustedContentHint: true,
      },
    };
    return {
      index,
      signature: await descriptorSignature(JSON.stringify(descriptor)),
      ...descriptor,
    };
  };

  const bridge = Object.freeze({
    version: 1,
    implementation,
    async list() {
      if (typeof context.getTools !== "function" || typeof context.executeTool !== "function") {
        return { available: false, implementation: "unavailable", tools: [], skippedToolCount: 0 };
      }
      const rawTools = await context.getTools();
      const bounded = Array.isArray(rawTools) ? rawTools.slice(0, MAX_TOOLS) : [];
      const tools: Array<NonNullable<Awaited<ReturnType<typeof normalizeTool>>>> = [];
      let contentBytes = 0;
      let skippedForBounds = 0;
      for (const [index, tool] of bounded.entries()) {
        const normalized = await normalizeTool(tool, index);
        if (!normalized) {
          skippedForBounds += 1;
          continue;
        }
        const toolBytes = byteLength(JSON.stringify(normalized));
        if (contentBytes + toolBytes > MAX_BRIDGE_LIST_BYTES) {
          skippedForBounds += 1;
          continue;
        }
        contentBytes += toolBytes;
        tools.push(normalized);
      }
      return {
        available: true,
        implementation,
        tools,
        skippedToolCount:
          Math.max(0, (Array.isArray(rawTools) ? rawTools.length : 0) - bounded.length) +
          skippedForBounds,
      };
    },
    async invoke(index: number, signature: string, inputJson: string, invocationId: string) {
      const rawTools = await context.getTools();
      const tool = Array.isArray(rawTools) ? rawTools[index] : undefined;
      const normalized = tool ? await normalizeTool(tool, index) : null;
      if (!tool || !normalized || normalized.signature !== signature) return { status: "stale" };
      const parsed = JSON.parse(inputJson) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          status: "failed",
          error: { name: "TypeError", message: "WebMCP tool arguments must be a JSON object." },
        };
      }
      const controller = new AbortController();
      pending.set(invocationId, controller);
      try {
        const executionInput =
          implementation === "native" && nativeInputFormat === "json-string"
            ? inputJson
            : (parsed as JsonObject);
        const rawResult = await context.executeTool(tool, executionInput, {
          signal: controller.signal,
        });
        // The current draft returns stringified JSON. Accept an object as well
        // so Synara remains compatible with early-preview Chromium builds.
        const serializedResult =
          typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
        if (
          typeof serializedResult !== "string" ||
          byteLength(serializedResult) > MAX_RESULT_BYTES
        ) {
          return {
            status: "failed",
            error: {
              name: "WebMcpResultTooLarge",
              message: "The page-declared WebMCP tool returned more than 64 KiB of JSON.",
            },
          };
        }
        const cloned = JSON.parse(serializedResult) as unknown;
        if (jsonDepth(cloned) > 20) {
          return {
            status: "failed",
            error: {
              name: "WebMcpResultTooDeep",
              message: "The page-declared WebMCP tool returned JSON deeper than 20 levels.",
            },
          };
        }
        return { status: "completed", result: cloned };
      } catch (error) {
        return { status: "failed", error: safeError(error) };
      } finally {
        pending.delete(invocationId);
      }
    },
    cancel(invocationId: string) {
      pending.get(invocationId)?.abort(new DOMException("WebMCP call cancelled", "AbortError"));
    },
  });
  Object.defineProperty(root, BRIDGE_PROPERTY, {
    value: bridge,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  if (implementation === "compatibility") {
    let observer: MutationObserver | null = null;
    let queued = false;
    const notifyToolChange = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        (modelContext as EventTarget).dispatchEvent(new Event("toolchange"));
      });
    };
    const isInsideToolForm = (value: unknown): boolean => {
      if (value === null || typeof value !== "object") return false;
      const element = value as {
        readonly matches?: (selector: string) => boolean;
        readonly closest?: (selector: string) => unknown;
      };
      return (
        element.matches?.("form[toolname][tooldescription]") === true ||
        Boolean(element.closest?.("form[toolname][tooldescription]"))
      );
    };
    const containsToolForm = (value: unknown): boolean => {
      if (isInsideToolForm(value)) return true;
      if (value === null || typeof value !== "object") return false;
      return Boolean(
        (value as { readonly querySelector?: (selector: string) => unknown }).querySelector?.(
          "form[toolname][tooldescription]",
        ),
      );
    };
    const mutationAffectsTools = (mutation: MutationRecord): boolean => {
      if (mutation.type === "attributes") {
        const target = mutation.target as Element;
        if (
          (mutation.attributeName === "toolname" || mutation.attributeName === "tooldescription") &&
          target.matches?.("form")
        ) {
          return true;
        }
        return isInsideToolForm(target);
      }
      return (
        isInsideToolForm(mutation.target) ||
        Array.from(mutation.addedNodes).some(containsToolForm) ||
        Array.from(mutation.removedNodes).some(containsToolForm)
      );
    };
    ensureDeclarativeObservation = () => {
      if (observer) return;
      observer = new MutationObserver((mutations) => {
        if (mutations.some(mutationAffectsTools)) notifyToolChange();
      });
      observer.observe(document.documentElement ?? document, {
        attributes: true,
        attributeFilter: [
          "disabled",
          "name",
          "required",
          "toolautosubmit",
          "tooldescription",
          "toolname",
          "toolparamdescription",
          "type",
        ],
        childList: true,
        subtree: true,
      });
    };
  }
}

try {
  const hostAllowsCompatibility =
    ipcRenderer.sendSync(BROWSER_IPC_CHANNELS.webMcpCompatibilityPolicy) === true;
  contextBridge.executeInMainWorld({
    func: installWebMcpBridgeInMainWorld,
    args: [hostAllowsCompatibility],
  });
} catch {
  // The browser remains usable through DOM automation if the host Chromium
  // cannot install the compatibility bridge.
}
