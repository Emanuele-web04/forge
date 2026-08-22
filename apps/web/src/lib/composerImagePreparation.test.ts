import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_IMPORT_BYTES,
} from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareComposerImageFile } from "./composerImagePreparation";

function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

describe("prepareComposerImageFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves provider-safe images byte-for-byte untouched", async () => {
    const file = new File(["png"], "screen.png", { type: "image/png" });

    await expect(prepareComposerImageFile(file)).resolves.toBe(file);
  });

  it("rejects raw images above the bounded import limit before decoding", async () => {
    const file = new File(["png"], "massive.png", { type: "image/png" });
    Object.defineProperty(file, "size", {
      configurable: true,
      value: PROVIDER_SEND_TURN_MAX_IMAGE_IMPORT_BYTES + 1,
    });
    const createImageBitmapMock = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);

    await expect(prepareComposerImageFile(file)).rejects.toThrow("32MB image import limit");
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });

  it("converts oversized Retina PNGs into bounded JPEG files", async () => {
    const source = new File([pngHeader(6_016, 3_384)], "CleanShot 2026-08-02 at 4.00.23@2x.png", {
      type: "image/png",
      lastModified: 42,
    });
    Object.defineProperty(source, "size", {
      configurable: true,
      value: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
    });
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 6_016, height: 3_384, close }),
    );

    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        fillStyle: "",
        fillRect: vi.fn(),
        drawImage,
      })),
      toBlob: vi.fn((callback: BlobCallback, type = "image/webp") =>
        callback(new Blob([new Uint8Array(1024)], { type })),
      ),
    };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });

    const prepared = await prepareComposerImageFile(source);

    expect(prepared).not.toBe(source);
    expect(prepared.name).toBe("CleanShot 2026-08-02 at 4.00.23@2x.webp");
    expect(prepared.type).toBe("image/webp");
    expect(prepared.size).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    expect(prepared.lastModified).toBe(42);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects excessive pixel dimensions before decoding", async () => {
    const source = new File([pngHeader(10_000, 10_000)], "pixel-bomb.png", {
      type: "image/png",
    });
    Object.defineProperty(source, "size", {
      configurable: true,
      value: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
    });
    const createImageBitmapMock = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);

    await expect(prepareComposerImageFile(source)).rejects.toThrow(
      "too many pixels to optimize safely",
    );
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });
});
