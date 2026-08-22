import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { prepareComposerImageFile } from "./composerImagePreparation";

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Canvas encode failed."))),
      type,
    );
  });
}

async function highDetailPng(name: string, transparent: boolean): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = 2_560;
  canvas.height = 2_560;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  const pixels = context.createImageData(canvas.width, canvas.height);
  let state = 0x12345678;
  for (let index = 0; index < pixels.data.length; index += 4) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    pixels.data[index] = state & 0xff;
    pixels.data[index + 1] = (state >>> 8) & 0xff;
    pixels.data[index + 2] = (state >>> 16) & 0xff;
    pixels.data[index + 3] = transparent && index % 16 === 0 ? 128 : 255;
  }
  context.putImageData(pixels, 0, 0);
  return new File([await canvasBlob(canvas, "image/png")], name, { type: "image/png" });
}

describe("composer image preparation in Chromium", () => {
  it("decodes and re-encodes a genuinely oversized clipboard PNG", async () => {
    const source = await highDetailPng("CleanShot@2x.png", true);
    expect(source.size).toBeGreaterThan(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);

    const prepared = await prepareComposerImageFile(source);

    expect(prepared.name).toBe("CleanShot@2x.webp");
    expect(prepared.type).toBe("image/webp");
    expect(prepared.size).toBeGreaterThan(0);
    expect(prepared.size).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    const bitmap = await createImageBitmap(prepared);
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = 1;
    sampleCanvas.height = 1;
    const sampleContext = sampleCanvas.getContext("2d");
    if (!sampleContext) throw new Error("Sample canvas is unavailable.");
    sampleContext.drawImage(bitmap, 0, 0, 1, 1, 0, 0, 1, 1);
    expect(sampleContext.getImageData(0, 0, 1, 1).data[3]).toBeLessThan(255);
    bitmap.close();
  });

  it("uses the faster JPEG encoder when a clipboard PNG is fully opaque", async () => {
    const source = await highDetailPng("CleanShot@2x.png", false);
    expect(source.size).toBeGreaterThan(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);

    const prepared = await prepareComposerImageFile(source);

    expect(prepared.name).toBe("CleanShot@2x.jpg");
    expect(prepared.type).toBe("image/jpeg");
    expect(prepared.size).toBeGreaterThan(0);
    expect(prepared.size).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
  });
});
