// FILE: composerImagePreparation.ts
// Purpose: Normalize oversized composer images without decoding unbounded pixels on the UI thread.
// Layer: Web composer utility

import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_IMPORT_BYTES,
} from "@synara/contracts";

const MEBIBYTE = 1024 * 1024;
const JPEG_HEADER_READ_BYTES = 1024 * 1024;
const RASTER_HEADER_READ_BYTES = 64;

export const COMPOSER_IMAGE_MAX_IMPORT_BYTES = PROVIDER_SEND_TURN_MAX_IMAGE_IMPORT_BYTES;
export const COMPOSER_IMAGE_OPTIMIZED_TARGET_BYTES = 8 * MEBIBYTE;

const COMPOSER_IMAGE_MAX_SOURCE_PIXELS = 64_000_000;
const COMPOSER_IMAGE_MAX_SOURCE_EDGE = 16_384;
const COMPOSER_IMAGE_MAX_RENDER_PIXELS = 24_000_000;
const COMPOSER_IMAGE_MAX_RENDER_EDGE = 8_192;
const COMPOSER_IMAGE_QUALITY = 0.92;
const COMPOSER_IMAGE_MAX_RESIZE_ATTEMPTS = 3;
const AUTOMATICALLY_OPTIMIZABLE_IMAGE_TYPES = new Set([
  "image/bmp",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

interface DecodedComposerImage extends ImageDimensions {
  readonly source: CanvasImageSource;
  readonly release: () => void;
}

interface WorkerResponse {
  readonly ok: boolean;
  readonly blob?: Blob;
  readonly message?: string;
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export class ComposerImagePreparationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ComposerImagePreparationError";
  }
}

function imageName(file: File): string {
  return file.name.trim() || "image";
}

function optimizedName(name: string, mimeType: "image/jpeg" | "image/webp"): string {
  const trimmed = name.trim() || "image";
  const extensionIndex = trimmed.lastIndexOf(".");
  const basename = extensionIndex > 0 ? trimmed.slice(0, extensionIndex) : trimmed;
  return `${basename}${mimeType === "image/webp" ? ".webp" : ".jpg"}`;
}

function validDimensions(width: number, height: number): ImageDimensions | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function pngDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return null;
  }
  return validDimensions(view.getUint32(16, false), view.getUint32(20, false));
}

function bmpDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  return validDimensions(Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)));
}

function jpegDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = view.getUint16(offset, false);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker) && segmentLength >= 7) {
      return validDimensions(view.getUint16(offset + 5, false), view.getUint16(offset + 3, false));
    }
    offset += segmentLength;
  }
  return null;
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function webpDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
  const ascii = (offset: number, value: string) =>
    [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (bytes.length < 30 || !ascii(0, "RIFF") || !ascii(8, "WEBP")) return null;
  if (ascii(12, "VP8X")) {
    return validDimensions(uint24LittleEndian(bytes, 24) + 1, uint24LittleEndian(bytes, 27) + 1);
  }
  if (ascii(12, "VP8 ") && bytes.length >= 30) {
    return validDimensions(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  }
  if (ascii(12, "VP8L") && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[21] ?? 0;
    const b2 = bytes[22] ?? 0;
    const b3 = bytes[23] ?? 0;
    const b4 = bytes[24] ?? 0;
    return validDimensions(
      1 + b1 + ((b2 & 0x3f) << 8),
      1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
    );
  }
  return null;
}

async function readImageDimensions(file: File): Promise<ImageDimensions> {
  const headerBytes =
    file.type.toLowerCase() === "image/jpeg" || file.type.toLowerCase() === "image/jpg"
      ? JPEG_HEADER_READ_BYTES
      : RASTER_HEADER_READ_BYTES;
  const header = await file.slice(0, Math.min(file.size, headerBytes)).arrayBuffer();
  const bytes = new Uint8Array(header);
  const view = new DataView(header);
  const mimeType = file.type.toLowerCase();
  const dimensions =
    mimeType === "image/png"
      ? pngDimensions(bytes, view)
      : mimeType === "image/bmp"
        ? bmpDimensions(bytes, view)
        : mimeType === "image/jpeg" || mimeType === "image/jpg"
          ? jpegDimensions(bytes, view)
          : mimeType === "image/webp"
            ? webpDimensions(bytes, view)
            : null;
  if (!dimensions) {
    throw new ComposerImagePreparationError("The image dimensions could not be read safely.");
  }
  if (
    Math.max(dimensions.width, dimensions.height) > COMPOSER_IMAGE_MAX_SOURCE_EDGE ||
    dimensions.width * dimensions.height > COMPOSER_IMAGE_MAX_SOURCE_PIXELS
  ) {
    throw new ComposerImagePreparationError(
      `'${imageName(file)}' has too many pixels to optimize safely.`,
    );
  }
  return dimensions;
}

function boundedRenderSize(width: number, height: number): ImageDimensions {
  const edgeScale = Math.min(1, COMPOSER_IMAGE_MAX_RENDER_EDGE / Math.max(width, height));
  const pixelScale = Math.min(1, Math.sqrt(COMPOSER_IMAGE_MAX_RENDER_PIXELS / (width * height)));
  const scale = Math.min(edgeScale, pixelScale);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function outputMimeType(file: File): "image/jpeg" | "image/webp" {
  const mimeType = file.type.toLowerCase();
  return mimeType === "image/png" || mimeType === "image/webp" ? "image/webp" : "image/jpeg";
}

function loadHtmlImage(file: File, expectedSize: ImageDimensions): Promise<DecodedComposerImage> {
  if (expectedSize.width * expectedSize.height > COMPOSER_IMAGE_MAX_RENDER_PIXELS) {
    throw new ComposerImagePreparationError(
      "This browser cannot downscale the image safely before decoding it.",
    );
  }
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    const release = () => URL.revokeObjectURL(objectUrl);
    image.addEventListener(
      "load",
      () => {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (width <= 0 || height <= 0) {
          release();
          reject(new ComposerImagePreparationError("The image has no readable pixels."));
          return;
        }
        resolve({ source: image, width, height, release });
      },
      { once: true },
    );
    image.addEventListener(
      "error",
      () => {
        release();
        reject(new ComposerImagePreparationError("The image could not be decoded."));
      },
      { once: true },
    );
    image.src = objectUrl;
  });
}

async function decodeComposerImage(
  file: File,
  sourceSize: ImageDimensions,
  renderSize: ImageDimensions,
): Promise<DecodedComposerImage> {
  if (typeof createImageBitmap !== "function") return loadHtmlImage(file, sourceSize);
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
      resizeWidth: renderSize.width,
      resizeHeight: renderSize.height,
      resizeQuality: "high",
    });
    if (bitmap.width <= 0 || bitmap.height <= 0) {
      bitmap.close();
      throw new ComposerImagePreparationError("The image has no readable pixels.");
    }
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  } catch (cause) {
    if (cause instanceof ComposerImagePreparationError) throw cause;
    try {
      return await loadHtmlImage(file, sourceSize);
    } catch {
      throw new ComposerImagePreparationError("The image could not be decoded.", { cause });
    }
  }
}

function encodeCanvas(
  source: CanvasImageSource,
  size: ImageDimensions,
  mimeType: "image/jpeg" | "image/webp",
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d", { alpha: mimeType !== "image/jpeg" });
  if (!context) {
    throw new ComposerImagePreparationError("Image optimization is unavailable in this browser.");
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  if (mimeType === "image/jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size.width, size.height);
  }
  context.drawImage(source, 0, 0, size.width, size.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        canvas.width = 1;
        canvas.height = 1;
        if (!blob || blob.size === 0 || blob.type !== mimeType) {
          reject(new ComposerImagePreparationError("The optimized image could not be encoded."));
          return;
        }
        resolve(blob);
      },
      mimeType,
      COMPOSER_IMAGE_QUALITY,
    );
  });
}

function nextRenderSize(size: ImageDimensions, encodedBytes: number): ImageDimensions {
  const estimatedScale = Math.sqrt(COMPOSER_IMAGE_OPTIMIZED_TARGET_BYTES / encodedBytes) * 0.94;
  const scale = Math.min(0.9, Math.max(0.5, estimatedScale));
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

async function optimizeOnMainThread(
  file: File,
  sourceSize: ImageDimensions,
  initialSize: ImageDimensions,
  mimeType: "image/jpeg" | "image/webp",
): Promise<Blob> {
  const decoded = await decodeComposerImage(file, sourceSize, initialSize);
  try {
    let size = { width: decoded.width, height: decoded.height };
    let blob = await encodeCanvas(decoded.source, size, mimeType);
    for (
      let attempt = 0;
      blob.size > COMPOSER_IMAGE_OPTIMIZED_TARGET_BYTES &&
      attempt < COMPOSER_IMAGE_MAX_RESIZE_ATTEMPTS;
      attempt += 1
    ) {
      size = nextRenderSize(size, blob.size);
      blob = await encodeCanvas(decoded.source, size, mimeType);
    }
    return blob;
  } finally {
    decoded.release();
  }
}

function optimizeInWorker(
  file: File,
  initialSize: ImageDimensions,
  mimeType: "image/jpeg" | "image/webp",
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./composerImagePreparation.worker.ts", import.meta.url), {
      type: "module",
    });
    const finish = () => worker.terminate();
    worker.addEventListener(
      "message",
      (event: MessageEvent<WorkerResponse>) => {
        finish();
        if (event.data.ok && event.data.blob) {
          resolve(event.data.blob);
          return;
        }
        reject(
          new ComposerImagePreparationError(event.data.message ?? "Image optimization failed."),
        );
      },
      { once: true },
    );
    worker.addEventListener(
      "error",
      (event) => {
        finish();
        reject(new ComposerImagePreparationError(event.message || "Image optimization failed."));
      },
      { once: true },
    );
    worker.postMessage({
      file,
      width: initialSize.width,
      height: initialSize.height,
      mimeType,
      quality: COMPOSER_IMAGE_QUALITY,
      targetBytes: COMPOSER_IMAGE_OPTIMIZED_TARGET_BYTES,
      maxResizeAttempts: COMPOSER_IMAGE_MAX_RESIZE_ATTEMPTS,
    });
  });
}

async function optimizeOversizedComposerImage(file: File): Promise<File> {
  const dimensions = await readImageDimensions(file);
  const renderSize = boundedRenderSize(dimensions.width, dimensions.height);
  const mimeType = outputMimeType(file);
  let blob: Blob;
  if (typeof Worker === "function" && typeof OffscreenCanvas === "function") {
    blob = await optimizeInWorker(file, renderSize, mimeType);
  } else {
    blob = await optimizeOnMainThread(file, dimensions, renderSize, mimeType);
  }
  if (blob.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    throw new ComposerImagePreparationError(
      `'${imageName(file)}' is still too large after automatic optimization.`,
    );
  }
  const encodedMimeType = blob.type === "image/jpeg" ? "image/jpeg" : mimeType;
  return new File([blob], optimizedName(file.name, encodedMimeType), {
    type: encodedMimeType,
    lastModified: file.lastModified,
  });
}

/** Leaves provider-safe images untouched; oversized raster images are bounded and normalized. */
export async function prepareComposerImageFile(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) {
    throw new ComposerImagePreparationError(`'${imageName(file)}' is not an image file.`);
  }
  if (file.size <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) return file;
  if (file.size > COMPOSER_IMAGE_MAX_IMPORT_BYTES) {
    throw new ComposerImagePreparationError(
      `'${imageName(file)}' exceeds the ${COMPOSER_IMAGE_MAX_IMPORT_BYTES / MEBIBYTE}MB image import limit.`,
    );
  }
  if (!AUTOMATICALLY_OPTIMIZABLE_IMAGE_TYPES.has(file.type.toLowerCase())) {
    throw new ComposerImagePreparationError(
      `'${imageName(file)}' is too large and its image format cannot be optimized automatically.`,
    );
  }
  try {
    return await optimizeOversizedComposerImage(file);
  } catch (cause) {
    if (cause instanceof ComposerImagePreparationError) throw cause;
    throw new ComposerImagePreparationError(`Synara could not optimize '${imageName(file)}'.`, {
      cause,
    });
  }
}
