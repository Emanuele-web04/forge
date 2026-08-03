import type { BrowserCaptureScreenshotResult, NativeApi, ThreadId } from "@synara/contracts";

import type { ComposerImageAttachment } from "../composerDraftStore";
import { prepareComposerImageAttachmentsFromFiles } from "./composerSend";

const EXPLICIT_COMPUTER_USE_PATTERNS = [
  "computer use",
  "computer-use",
  "@computer-use",
  "@computer use",
  "mcp__computer_use__",
];

const INTERNAL_BROWSER_SCOPE_PATTERNS = [
  "browser interno",
  "internal browser",
  "browser in chat",
  "browser della chat",
  "chat browser",
  "in-app browser",
  "browser panel",
  "tab attiva",
  "active tab",
  "pagina aperta",
  "page open",
  "pagina nel browser",
  "page in the browser",
];

const INTERNAL_BROWSER_ACTION_PATTERNS = [
  "guarda",
  "vedi",
  "dimmi cosa vedi",
  "leggi",
  "descrivi",
  "riassumi",
  "ispeziona",
  "look at",
  "what do you see",
  "read",
  "describe",
  "summarize",
  "inspect",
  "screenshot",
  "screen",
];

function normalizePromptForMatching(prompt: string): string {
  return prompt.toLowerCase().replace(/\s+/g, " ").trim();
}

export function promptRequestsExplicitComputerUse(prompt: string): boolean {
  const normalized = normalizePromptForMatching(prompt);
  return EXPLICIT_COMPUTER_USE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function promptLooksLikeInternalBrowserTask(prompt: string): boolean {
  const normalized = normalizePromptForMatching(prompt);
  const mentionsInternalBrowser = INTERNAL_BROWSER_SCOPE_PATTERNS.some((pattern) =>
    normalized.includes(pattern),
  );
  if (!mentionsInternalBrowser) {
    return false;
  }
  return INTERNAL_BROWSER_ACTION_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function screenshotAttachmentName(input: BrowserCaptureScreenshotResult): string {
  return input.name.trim().length > 0 ? input.name : `browser-${Date.now()}.png`;
}

function fileFromBrowserScreenshot(screenshot: BrowserCaptureScreenshotResult): File {
  if (screenshot.bytes.byteLength === 0) {
    throw new Error("Browser screenshot is empty.");
  }
  const bytes = new Uint8Array(screenshot.bytes);
  return new File([bytes], screenshotAttachmentName(screenshot), {
    type: screenshot.mimeType,
  });
}

export async function prepareComposerImageFromBrowserScreenshot(
  screenshot: BrowserCaptureScreenshotResult,
): Promise<ComposerImageAttachment> {
  const file = fileFromBrowserScreenshot(screenshot);
  const result = await prepareComposerImageAttachmentsFromFiles({
    files: [file],
    existingAttachmentCount: 0,
  });
  const image = result.images[0];
  if (!image) {
    throw new Error(result.error ?? "Browser screenshot could not be prepared.");
  }
  return image;
}

export interface BrowserPromptAttachmentResolution {
  requested: boolean;
  image: ComposerImageAttachment | null;
  reason?: "no-open-browser" | "no-active-tab" | "attachment-processing-failed";
}

export async function maybeResolveBrowserPromptAttachment(input: {
  api: NativeApi;
  threadId: ThreadId;
  prompt: string;
}): Promise<BrowserPromptAttachmentResolution> {
  if (
    promptRequestsExplicitComputerUse(input.prompt) ||
    !promptLooksLikeInternalBrowserTask(input.prompt)
  ) {
    return { requested: false, image: null };
  }

  const browserState = await input.api.browser.getState({
    threadId: input.threadId,
  });
  if (!browserState.open) {
    return { requested: true, image: null, reason: "no-open-browser" };
  }

  const activeTab =
    browserState.tabs.find((tab) => tab.id === browserState.activeTabId) ??
    browserState.tabs[0] ??
    null;
  if (!activeTab) {
    return { requested: true, image: null, reason: "no-active-tab" };
  }

  const screenshot = await input.api.browser.captureScreenshot({
    threadId: input.threadId,
    tabId: activeTab.id,
  });
  try {
    return {
      requested: true,
      image: await prepareComposerImageFromBrowserScreenshot(screenshot),
    };
  } catch {
    return { requested: true, image: null, reason: "attachment-processing-failed" };
  }
}
