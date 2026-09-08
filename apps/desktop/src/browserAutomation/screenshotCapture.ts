import type {
  BrowserScreenshotHostOutput,
  BrowserScreenshotInput,
  BrowserTabId,
} from "@synara/contracts";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { drainOnAbort, sendCdpCommand, throwIfAborted } from "./cdpRuntime";
import { browserHostError } from "./hostErrors";

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOT_WIDTH = 3_840;
const MAX_FULL_PAGE_HEIGHT = 16_384;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let screenshotTail: Promise<void> = Promise.resolve();

const withScreenshotLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = screenshotTail;
  let release!: () => void;
  screenshotTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
};

function screenshotTooLarge(runtime: BrowserAutomationVisibleRuntime): never {
  return browserHostError({
    code: "BrowserScreenshotTooLarge",
    tabId: runtime.tabId as BrowserTabId,
  });
}

const pngDimensions = (
  runtime: BrowserAutomationVisibleRuntime,
  data: Buffer,
): { readonly width: number; readonly height: number } => {
  if (
    data.byteLength < 24 ||
    !data.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) ||
    data.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    screenshotTooLarge(runtime);
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width < 1 || height < 1) {
    screenshotTooLarge(runtime);
  }
  return { width, height };
};

const boundedUrl = (value: string): string => {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= 8_192) return value;
  let end = 8_192;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
};

const captureViewport = async (
  runtime: BrowserAutomationVisibleRuntime,
  signal?: AbortSignal,
): Promise<{ readonly png: Buffer; readonly width: number; readonly height: number }> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAborted(signal);
    let image = await drainOnAbort(runtime.webContents.capturePage(), signal);
    const initialSize = image.getSize();
    if (initialSize.width > MAX_SCREENSHOT_WIDTH || initialSize.height > MAX_FULL_PAGE_HEIGHT) {
      const scale = Math.min(
        MAX_SCREENSHOT_WIDTH / initialSize.width,
        MAX_FULL_PAGE_HEIGHT / initialSize.height,
      );
      image = image.resize({
        width: Math.max(1, Math.floor(initialSize.width * scale)),
        height: Math.max(1, Math.floor(initialSize.height * scale)),
        quality: "best",
      });
    }
    const png = image.toPNG();
    if (png.byteLength >= 24) {
      const dimensions = pngDimensions(runtime, png);
      if (
        png.byteLength > MAX_SCREENSHOT_BYTES ||
        dimensions.width > MAX_SCREENSHOT_WIDTH ||
        dimensions.height > MAX_FULL_PAGE_HEIGHT
      )
        screenshotTooLarge(runtime);
      return { png, ...dimensions };
    }
  }
  screenshotTooLarge(runtime);
};

const captureFullPage = async (
  runtime: BrowserAutomationVisibleRuntime,
  signal?: AbortSignal,
): Promise<{
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  readonly clipped: boolean;
}> => {
  const metrics = await sendCdpCommand<{
    readonly cssContentSize: { readonly width: number; readonly height: number };
  }>(runtime, "Page.getLayoutMetrics", {}, signal);
  const rawWidth = Math.max(1, Math.ceil(metrics.cssContentSize.width));
  const rawHeight = Math.max(1, Math.ceil(metrics.cssContentSize.height));
  const width = Math.min(MAX_SCREENSHOT_WIDTH, rawWidth);
  const height = Math.min(MAX_FULL_PAGE_HEIGHT, rawHeight);
  const clipped = width < rawWidth || height < rawHeight;
  const scales = [1, 0.75, 0.5, 0.25] as const;
  for (const scale of scales) {
    throwIfAborted(signal);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await sendCdpCommand<{ readonly data?: string }>(
        runtime,
        "Page.captureScreenshot",
        {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: true,
          optimizeForSpeed: true,
          clip: { x: 0, y: 0, width, height, scale },
        },
        signal,
      );
      const data =
        typeof response.data === "string" ? Buffer.from(response.data, "base64") : Buffer.alloc(0);
      if (data.byteLength < 24) continue;
      const dimensions = pngDimensions(runtime, data);
      if (dimensions.width > MAX_SCREENSHOT_WIDTH || dimensions.height > MAX_FULL_PAGE_HEIGHT)
        break;
      if (data.byteLength <= MAX_SCREENSHOT_BYTES) {
        return { png: data, ...dimensions, clipped };
      }
      break;
    }
  }
  screenshotTooLarge(runtime);
};

/** Capture pixels from the same visible guest, serialized across Chromium. */
export const captureBrowserScreenshot = async (
  runtime: BrowserAutomationVisibleRuntime,
  input: Pick<BrowserScreenshotInput, "fullPage">,
  signal?: AbortSignal,
): Promise<BrowserScreenshotHostOutput> =>
  withScreenshotLock(async () => {
    throwIfAborted(signal);
    const captured = input.fullPage
      ? await captureFullPage(runtime, signal)
      : { ...(await captureViewport(runtime, signal)), clipped: false };
    throwIfAborted(signal);
    const metadata = {
      mimeType: "image/png" as const,
      width: captured.width,
      height: captured.height,
      byteLength: captured.png.byteLength,
    };
    return {
      structuredContent: {
        tabId: runtime.tabId as BrowserTabId,
        url: boundedUrl(runtime.webContents.getURL()),
        capturedAt:
          new Date().toISOString() as unknown as BrowserScreenshotHostOutput["structuredContent"]["capturedAt"],
        mode: input.fullPage ? "fullPage" : "viewport",
        clipped: captured.clipped,
        image: metadata,
      },
      image: { ...metadata, data: captured.png.toString("base64") },
    };
  });
