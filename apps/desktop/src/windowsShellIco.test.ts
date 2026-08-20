import FS from "node:fs";
import Path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  encodeWindowsShellIco,
  extractIcoPngImages,
  inspectIcoEntries,
  toWindowsShellIco,
  WINDOWS_SHELL_ICO_BMP_SIZES,
} from "./windowsShellIco";

const appIconWindowsIco = Path.join(
  Path.dirname(fileURLToPath(import.meta.url)),
  "../resources/app-icon-windows.ico",
);

describe("windowsShellIco", () => {
  it("encodes 32-bit BMP entries that Explorer can extract for the taskbar", () => {
    const size = 16;
    const bgra = Buffer.alloc(size * size * 4, 255);
    const ico = encodeWindowsShellIco([{ width: size, height: size, bgra }]);
    const entries = inspectIcoEntries(ico);
    expect(entries).toEqual([{ width: 16, height: 16, encoding: "bmp" }]);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt32LE(18)).toBe(22);
    expect(ico.readUInt32LE(22)).toBe(40);
  });

  it("reads PNG images from the scenic Windows ICO", () => {
    const ico = FS.readFileSync(appIconWindowsIco);
    const pngs = extractIcoPngImages(ico);
    expect(inspectIcoEntries(ico).every((entry) => entry.encoding === "png")).toBe(true);
    expect(pngs.map((image) => image.width)).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });

  it("rebuilds a PNG ICO as BMP sizes used by the Win11 taskbar", () => {
    const ico = FS.readFileSync(appIconWindowsIco);
    const shellIco = toWindowsShellIco(ico, (_png, size) => ({
      width: size,
      height: size,
      bgra: Buffer.alloc(size * size * 4, 128),
    }));
    const entries = inspectIcoEntries(shellIco);
    expect(entries.map((entry) => entry.width)).toEqual([...WINDOWS_SHELL_ICO_BMP_SIZES]);
    expect(entries.every((entry) => entry.encoding === "bmp")).toBe(true);
  });
});
