// FILE: windowsShellIco.ts
// Purpose: Build BMP-in-ICO bytes that Explorer's taskbar can extract.
// Layer: Desktop-native Windows shell integration
// PNG-compressed ICO entries update window chrome but resolve to the generic
// blank-page glyph on the Win11 taskbar.

export const WINDOWS_SHELL_ICO_BMP_SIZES = [16, 20, 24, 32, 40, 48] as const;

export interface ShellIcoBitmap {
  readonly width: number;
  readonly height: number;
  readonly bgra: Buffer;
}

export interface IcoPngImage {
  readonly width: number;
  readonly height: number;
  readonly png: Buffer;
}

export interface IcoEntryInfo {
  readonly width: number;
  readonly height: number;
  readonly encoding: "png" | "bmp";
}

export function inspectIcoEntries(ico: Buffer): IcoEntryInfo[] {
  return readIcoDirectory(ico).map((entry) => {
    const header = ico.subarray(entry.offset, entry.offset + 8);
    const encoding = header[0] === 0x89 && header[1] === 0x50 ? "png" : "bmp";
    return { width: entry.width, height: entry.height, encoding };
  });
}

export function extractIcoPngImages(ico: Buffer): IcoPngImage[] {
  const images: IcoPngImage[] = [];
  for (const entry of readIcoDirectory(ico)) {
    const bytes = ico.subarray(entry.offset, entry.offset + entry.size);
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) continue;
    images.push({ width: entry.width, height: entry.height, png: Buffer.from(bytes) });
  }
  return images;
}

export function encodeWindowsShellIco(images: readonly ShellIcoBitmap[]): Buffer {
  const unique = new Map<number, ShellIcoBitmap>();
  for (const image of images) {
    if (image.width <= 0 || image.width !== image.height) continue;
    if (image.bgra.length !== image.width * image.height * 4) continue;
    unique.set(image.width, image);
  }
  const ordered = [...unique.values()].sort((a, b) => a.width - b.width);
  if (ordered.length === 0) {
    throw new Error("No valid bitmaps to encode as a Windows shell ICO");
  }

  const encoded = ordered.map(encodeBmpImage);
  const headerSize = 6 + encoded.length * 16;
  let offset = headerSize;
  const totalSize = encoded.reduce((sum, image) => sum + image.length, headerSize);
  const ico = Buffer.alloc(totalSize);
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(encoded.length, 4);
  for (const [index, image] of encoded.entries()) {
    const size = ordered[index]?.width ?? 0;
    const entry = 6 + index * 16;
    ico[entry] = size >= 256 ? 0 : size;
    ico[entry + 1] = size >= 256 ? 0 : size;
    ico[entry + 2] = 0;
    ico[entry + 3] = 0;
    ico.writeUInt16LE(1, entry + 4);
    ico.writeUInt16LE(32, entry + 6);
    ico.writeUInt32LE(image.length, entry + 8);
    ico.writeUInt32LE(offset, entry + 12);
    image.copy(ico, offset);
    offset += image.length;
  }
  return ico;
}

export function toWindowsShellIco(
  ico: Buffer,
  decodePng: (png: Buffer, size: number) => ShellIcoBitmap | null,
): Buffer {
  const pngs = extractIcoPngImages(ico);
  if (pngs.length === 0) return ico;
  const largest = pngs.reduce((best, image) => (image.width > best.width ? image : best));
  const bitmaps: ShellIcoBitmap[] = [];
  for (const size of WINDOWS_SHELL_ICO_BMP_SIZES) {
    const source = pngs.find((image) => image.width === size) ?? largest;
    const bitmap = decodePng(source.png, size);
    if (bitmap) bitmaps.push(bitmap);
  }
  if (bitmaps.length === 0) return ico;
  return encodeWindowsShellIco(bitmaps);
}

interface IcoDirectoryEntry {
  readonly width: number;
  readonly height: number;
  readonly size: number;
  readonly offset: number;
}

function readIcoDirectory(ico: Buffer): IcoDirectoryEntry[] {
  if (ico.length < 6) return [];
  const type = ico.readUInt16LE(2);
  const count = ico.readUInt16LE(4);
  if (type !== 1 || count === 0) return [];
  const entries: IcoDirectoryEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    if (entry + 16 > ico.length) break;
    const width = ico[entry] === 0 ? 256 : ico[entry]!;
    const height = ico[entry + 1] === 0 ? 256 : ico[entry + 1]!;
    const size = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    if (offset < 0 || size < 0 || offset + size > ico.length) continue;
    entries.push({ width, height, size, offset });
  }
  return entries;
}

function encodeBmpImage(image: ShellIcoBitmap): Buffer {
  const xorSize = image.width * image.height * 4;
  const andRowSize = Math.ceil(image.width / 32) * 4;
  const andSize = andRowSize * image.height;
  const buffer = Buffer.alloc(40 + xorSize + andSize);
  buffer.writeUInt32LE(40, 0);
  buffer.writeInt32LE(image.width, 4);
  buffer.writeInt32LE(image.height * 2, 8);
  buffer.writeUInt16LE(1, 12);
  buffer.writeUInt16LE(32, 14);
  buffer.writeUInt32LE(0, 16);
  buffer.writeUInt32LE(xorSize, 20);
  let offset = 40;
  for (let y = image.height - 1; y >= 0; y -= 1) {
    const row = image.bgra.subarray(y * image.width * 4, (y + 1) * image.width * 4);
    row.copy(buffer, offset);
    offset += row.length;
  }
  return buffer;
}
