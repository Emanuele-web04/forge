// FILE: devicePromptContext.ts
// Purpose: Attach a simulator screenshot when the composer prompt is clearly about the device screen.
// Layer: Composer helper
// Exports: prompt matchers, screenshot -> attachment conversion, and the resolution entry point
// Depends on: nativeApi device namespace, composer image preparation
//
// Mirrors browserPromptContext: the agent can take its own screenshot through
// MCP, but a user typing "what do you see on the simulator?" expects the image
// to already be attached rather than to wait a round trip for the agent to ask.

import type {
  DeviceScreenshotResult,
  NativeApi,
  ThreadDeviceState,
  ThreadId,
} from "@synara/contracts";

import type { ComposerImageAttachment } from "../composerDraftStore";
import { prepareComposerImageAttachmentsFromFiles } from "./composerSend";

const DEVICE_SCOPE_PATTERNS = [
  "in the simulator",
  "on the simulator",
  "the simulator",
  "simulator screen",
  "ios simulator",
  "on the device",
  "device screen",
  "nel simulatore",
  "sul simulatore",
  "schermo del simulatore",
  "sul dispositivo",
];

const DEVICE_ACTION_PATTERNS = [
  "look at",
  "what do you see",
  "read",
  "describe",
  "summarize",
  "inspect",
  "screenshot",
  "screen",
  "check",
  "guarda",
  "vedi",
  "dimmi cosa vedi",
  "leggi",
  "descrivi",
  "riassumi",
  "ispeziona",
];

function normalizePromptForMatching(prompt: string): string {
  return prompt.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Requires both a scope mention and an action verb so "add a simulator target
 * to the build" does not silently attach a screenshot to an unrelated request.
 */
export function promptLooksLikeDeviceTask(prompt: string): boolean {
  const normalized = normalizePromptForMatching(prompt);
  if (!DEVICE_SCOPE_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return false;
  }
  return DEVICE_ACTION_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function deviceScreenshotAttachmentName(input: DeviceScreenshotResult): string {
  return input.name.trim().length > 0 ? input.name : `simulator-${Date.now()}.png`;
}

function fileFromDeviceScreenshot(screenshot: DeviceScreenshotResult): File {
  // Screenshots cross the JSON socket base64-encoded, unlike the browser's
  // Electron-only Uint8Array path.
  const binary = atob(screenshot.bytesBase64);
  if (binary.length === 0) {
    throw new Error("Simulator screenshot is empty.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new File([bytes], deviceScreenshotAttachmentName(screenshot), {
    type: screenshot.mimeType,
  });
}

export async function prepareComposerImageFromDeviceScreenshot(
  screenshot: DeviceScreenshotResult,
): Promise<ComposerImageAttachment> {
  const file = fileFromDeviceScreenshot(screenshot);
  const result = await prepareComposerImageAttachmentsFromFiles({
    files: [file],
    existingAttachmentCount: 0,
  });
  const image = result.images[0];
  if (!image) {
    throw new Error(result.error ?? "Simulator screenshot could not be prepared.");
  }
  return image;
}

export interface DevicePromptAttachmentResolution {
  requested: boolean;
  image: ComposerImageAttachment | null;
  reason?: "no-attached-device" | "device-not-booted" | "attachment-processing-failed";
}

export async function maybeResolveDevicePromptAttachment(input: {
  api: NativeApi;
  threadId: ThreadId;
  prompt: string;
}): Promise<DevicePromptAttachmentResolution> {
  if (!promptLooksLikeDeviceTask(input.prompt)) {
    return { requested: false, image: null };
  }

  let deviceState: ThreadDeviceState;
  try {
    deviceState = await input.api.device.getThreadState({ threadId: input.threadId });
  } catch {
    // Off-macOS or no engine: treat it as "nothing attached" rather than an
    // error, since the user's prompt may simply not be about a simulator.
    return { requested: true, image: null, reason: "no-attached-device" };
  }

  const attached = deviceState.attachedDeviceUdid
    ? (deviceState.devices.find((device) => device.udid === deviceState.attachedDeviceUdid) ?? null)
    : null;
  if (!attached) {
    return { requested: true, image: null, reason: "no-attached-device" };
  }
  if (attached.state !== "booted") {
    return { requested: true, image: null, reason: "device-not-booted" };
  }

  try {
    const screenshot = await input.api.device.screenshot({ udid: attached.udid });
    return {
      requested: true,
      image: await prepareComposerImageFromDeviceScreenshot(screenshot),
    };
  } catch {
    return { requested: true, image: null, reason: "attachment-processing-failed" };
  }
}
