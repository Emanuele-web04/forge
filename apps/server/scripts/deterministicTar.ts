// FILE: deterministicTar.ts
// Purpose: Produce a byte-stable ustar+gzip archive without depending on the
//          incompatible reproducibility flags exposed by GNU tar and bsdtar.

import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

const TAR_BLOCK_SIZE = 512;
const TAR_END_BLOCKS = 2;

interface ArchiveEntry {
  readonly archivePath: string;
  readonly sourcePath: string;
  readonly kind: "directory" | "file";
  readonly mode: number;
}

export interface DeterministicTarGzipInput {
  readonly sourceDirectory: string;
  readonly entryNames: ReadonlyArray<string>;
  readonly outputPath: string;
}

function normalizeEntryName(entryName: string): string {
  const normalized = entryName.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid tar entry name: ${JSON.stringify(entryName)}`);
  }
  return normalized;
}

function sourcePathFor(sourceDirectory: string, archivePath: string): string {
  const sourceRoot = resolve(sourceDirectory);
  const sourcePath = resolve(sourceRoot, ...archivePath.split("/"));
  if (sourcePath !== sourceRoot && !sourcePath.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error(`Tar entry escapes source directory: ${archivePath}`);
  }
  return sourcePath;
}

async function collectEntry(
  sourceDirectory: string,
  archivePath: string,
  entries: ArchiveEntry[],
): Promise<void> {
  const sourcePath = sourcePathFor(sourceDirectory, archivePath);
  const stats = await lstat(sourcePath);

  if (stats.isDirectory()) {
    entries.push({
      archivePath: `${archivePath}/`,
      sourcePath,
      kind: "directory",
      mode: 0o755,
    });
    const children = (await readdir(sourcePath)).toSorted();
    for (const child of children) {
      await collectEntry(sourceDirectory, `${archivePath}/${child}`, entries);
    }
    return;
  }

  if (!stats.isFile()) {
    throw new Error(`Tar input must contain only regular files and directories: ${archivePath}`);
  }

  // Release modes are content semantics, not a reflection of the checkout's
  // umask. Preserve executability while canonicalizing every other mode bit.
  const mode = (stats.mode & 0o111) === 0 ? 0o644 : 0o755;
  entries.push({ archivePath, sourcePath, kind: "file", mode });
}

function writeStringField(
  header: Buffer,
  value: string,
  offset: number,
  length: number,
  label: string,
): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength > length) {
    throw new Error(`${label} is too long for ustar (${encoded.byteLength} > ${length} bytes)`);
  }
  encoded.copy(header, offset);
}

function writeOctalField(
  header: Buffer,
  value: number,
  offset: number,
  length: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label} for ustar: ${value}`);
  }
  const digits = value.toString(8);
  if (digits.length > length - 1) {
    throw new Error(`${label} is too large for ustar: ${value}`);
  }
  header.write(`${digits.padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function splitUstarPath(archivePath: string): { readonly name: string; readonly prefix: string } {
  if (Buffer.byteLength(archivePath, "utf8") <= 100) {
    return { name: archivePath, prefix: "" };
  }

  let separatorIndex = archivePath.lastIndexOf("/");
  while (separatorIndex > 0) {
    const prefix = archivePath.slice(0, separatorIndex);
    const name = archivePath.slice(separatorIndex + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
    separatorIndex = archivePath.lastIndexOf("/", separatorIndex - 1);
  }

  throw new Error(`Tar entry path cannot be represented in ustar: ${archivePath}`);
}

function createHeader(entry: ArchiveEntry, sizeBytes: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const { name, prefix } = splitUstarPath(entry.archivePath);

  writeStringField(header, name, 0, 100, "tar entry name");
  writeOctalField(header, entry.mode, 100, 8, "mode");
  writeOctalField(header, 0, 108, 8, "uid");
  writeOctalField(header, 0, 116, 8, "gid");
  writeOctalField(header, sizeBytes, 124, 12, "file size");
  writeOctalField(header, 0, 136, 12, "mtime");
  header.fill(0x20, 148, 156);
  header[156] = entry.kind === "directory" ? "5".charCodeAt(0) : "0".charCodeAt(0);
  writeStringField(header, "ustar\0", 257, 6, "ustar magic");
  writeStringField(header, "00", 263, 2, "ustar version");
  writeStringField(header, "root", 265, 32, "owner name");
  writeStringField(header, "root", 297, 32, "group name");
  writeOctalField(header, 0, 329, 8, "device major");
  writeOctalField(header, 0, 337, 8, "device minor");
  writeStringField(header, prefix, 345, 155, "tar entry prefix");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumDigits = checksum.toString(8);
  if (checksumDigits.length > 6) {
    throw new Error(`Tar header checksum is too large: ${checksum}`);
  }
  header.write(`${checksumDigits.padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function paddingFor(sizeBytes: number): Buffer {
  const remainder = sizeBytes % TAR_BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(TAR_BLOCK_SIZE - remainder);
}

export async function writeDeterministicTarGzip(input: DeterministicTarGzipInput): Promise<void> {
  const entries: ArchiveEntry[] = [];
  for (const entryName of input.entryNames) {
    await collectEntry(input.sourceDirectory, normalizeEntryName(entryName), entries);
  }
  entries.sort((left, right) =>
    left.archivePath < right.archivePath ? -1 : left.archivePath > right.archivePath ? 1 : 0,
  );

  const archiveParts: Buffer[] = [];
  for (const entry of entries) {
    const contents = entry.kind === "file" ? await readFile(entry.sourcePath) : Buffer.alloc(0);
    archiveParts.push(createHeader(entry, contents.byteLength));
    if (contents.byteLength > 0) archiveParts.push(contents, paddingFor(contents.byteLength));
  }
  archiveParts.push(Buffer.alloc(TAR_BLOCK_SIZE * TAR_END_BLOCKS));

  const gzip = gzipSync(Buffer.concat(archiveParts), { level: 9 });
  // Node already emits a zero gzip mtime, but pinning both the timestamp and
  // OS byte here makes the contract explicit across supported Node hosts.
  gzip.fill(0, 4, 8);
  gzip[9] = 0xff;

  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, gzip, { mode: 0o644 });
}
