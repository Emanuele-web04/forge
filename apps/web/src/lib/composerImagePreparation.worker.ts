// FILE: composerImagePreparation.worker.ts
// Purpose: Decode, resize, and encode oversized composer images away from the renderer UI thread.
// Layer: Web worker

interface OptimizeRequest {
  readonly file: File;
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/jpeg" | "image/webp";
  readonly quality: number;
  readonly targetBytes: number;
  readonly maxResizeAttempts: number;
}

const workerScope = self as unknown as {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<OptimizeRequest>) => void,
  ) => void;
  postMessage: (message: unknown) => void;
};

function nextSize(width: number, height: number, targetBytes: number, encodedBytes: number) {
  const estimatedScale = Math.sqrt(targetBytes / encodedBytes) * 0.94;
  const scale = Math.min(0.9, Math.max(0.5, estimatedScale));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function render(
  bitmap: ImageBitmap,
  canvas: OffscreenCanvas,
  width: number,
  height: number,
  mimeType: "image/jpeg" | "image/webp",
): OffscreenCanvasRenderingContext2D {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", {
    alpha: mimeType !== "image/jpeg",
  });
  if (!context) throw new Error("Image optimization is unavailable in this worker.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  if (mimeType === "image/jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  return context;
}

function hasTransparency(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  const pixelsPerTile = 2 * 1024 * 1024;
  const tileHeight = Math.max(1, Math.floor(pixelsPerTile / width));
  for (let top = 0; top < height; top += tileHeight) {
    const rows = Math.min(tileHeight, height - top);
    const pixels = context.getImageData(0, top, width, rows).data;
    for (let alpha = 3; alpha < pixels.length; alpha += 4) {
      if (pixels[alpha] !== 255) return true;
    }
  }
  return false;
}

async function encodeRendered(
  canvas: OffscreenCanvas,
  mimeType: "image/jpeg" | "image/webp",
  quality: number,
): Promise<Blob> {
  const blob = await canvas.convertToBlob({ type: mimeType, quality });
  if (blob.size === 0 || blob.type !== mimeType) {
    throw new Error("The optimized image could not be encoded.");
  }
  return blob;
}

workerScope.addEventListener("message", (event) => {
  void (async () => {
    const request = event.data;
    const bitmap = await createImageBitmap(request.file, {
      imageOrientation: "from-image",
      resizeWidth: request.width,
      resizeHeight: request.height,
      resizeQuality: "high",
    });
    try {
      const canvas = new OffscreenCanvas(request.width, request.height);
      let width = bitmap.width;
      let height = bitmap.height;
      const context = render(bitmap, canvas, width, height, request.mimeType);
      const mimeType =
        request.mimeType === "image/webp" && !hasTransparency(context, width, height)
          ? "image/jpeg"
          : request.mimeType;
      let blob = await encodeRendered(canvas, mimeType, request.quality);
      for (
        let attempt = 0;
        blob.size > request.targetBytes && attempt < request.maxResizeAttempts;
        attempt += 1
      ) {
        ({ width, height } = nextSize(width, height, request.targetBytes, blob.size));
        render(bitmap, canvas, width, height, mimeType);
        blob = await encodeRendered(canvas, mimeType, request.quality);
      }
      workerScope.postMessage({ ok: true, blob });
    } finally {
      bitmap.close();
    }
  })().catch((cause) => {
    workerScope.postMessage({
      ok: false,
      message: cause instanceof Error ? cause.message : "Image optimization failed.",
    });
  });
});

export {};
