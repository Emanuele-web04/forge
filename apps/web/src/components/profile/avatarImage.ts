// FILE: avatarImage.ts
// Purpose: Compress a user-picked profile photo entirely on-device into a tiny, square
// data URL so it can be persisted in localStorage without consuming much space. No I/O
// leaves the device.
// Layer: web profile feature.

// Square output edge in CSS px. 160 covers the largest avatar (size-20 / share card) at 2x
// without storing anything close to the original photo.
const AVATAR_MAX_EDGE = 160;
const AVATAR_QUALITY = 0.82;

// Hard cap on the encoded string so a pathological image can never blow the localStorage
// budget. Comfortable for a 160px square (~5–12 KB typical).
export const AVATAR_MAX_DATA_URL_LENGTH = 200_000;

export class AvatarImageError extends Error {}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new AvatarImageError("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new AvatarImageError("That file isn't a readable image."));
    img.src = src;
  });
}

/**
 * Splits a `compressAvatarImage` data URL into the raw base64 payload and its
 * content type, as the account upload RPC wants them. Only the compressor's
 * own outputs (webp/jpeg base64 data URLs) are valid input; anything else is
 * a programming error surfaced as an AvatarImageError.
 */
export function avatarDataUrlToUpload(dataUrl: string): {
  bytes: string;
  contentType: "image/webp" | "image/jpeg";
} {
  const match = /^data:(image\/webp|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) {
    throw new AvatarImageError("Could not encode that image for upload.");
  }
  return { bytes: match[2]!, contentType: match[1] as "image/webp" | "image/jpeg" };
}

// Resize + center-crop to a square and re-encode (WebP, JPEG fallback) at low quality.
export async function compressAvatarImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new AvatarImageError("Please choose an image file.");
  }

  const sourceUrl = await readFileAsDataUrl(file);
  const img = await loadImage(sourceUrl);

  const sourceEdge = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
  if (sourceEdge <= 0) {
    throw new AvatarImageError("That image has no pixels.");
  }
  const edge = Math.min(AVATAR_MAX_EDGE, sourceEdge);

  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new AvatarImageError("Image compression isn't supported in this browser.");
  }

  const sx = ((img.naturalWidth || img.width) - sourceEdge) / 2;
  const sy = ((img.naturalHeight || img.height) - sourceEdge) / 2;
  ctx.drawImage(img, sx, sy, sourceEdge, sourceEdge, 0, 0, edge, edge);

  const webp = canvas.toDataURL("image/webp", AVATAR_QUALITY);
  const dataUrl = webp.startsWith("data:image/webp")
    ? webp
    : canvas.toDataURL("image/jpeg", AVATAR_QUALITY);

  if (dataUrl.length > AVATAR_MAX_DATA_URL_LENGTH) {
    throw new AvatarImageError("That image is too large even after compression.");
  }
  return dataUrl;
}
