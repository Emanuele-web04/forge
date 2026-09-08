import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fresh HOME keeps native-reader tests away from personal browser profiles.
const home = await mkdtemp(join(tmpdir(), "synara-cookie-fixture-"));
const strings = ["127.0.0.1", "synara_synthetic_import", "/", "synthetic-only"];
const header = Buffer.alloc(56);
let offset = header.length;
const fields = strings.map((value, index) => {
  const bytes = Buffer.from(`${value}\0`);
  header.writeUInt32LE(offset, 16 + index * 4);
  offset += bytes.length;
  return bytes;
});
header.writeUInt32LE(offset, 0);
header.writeDoubleLE(Date.now() / 1000 + 86_400 - 978_307_200, 40);
const record = Buffer.concat([header, ...fields]);
const pageHeader = Buffer.alloc(16);
pageHeader.set([0, 0, 1, 0]);
pageHeader.writeUInt32LE(1, 4);
pageHeader.writeUInt32LE(16, 8);
const page = Buffer.concat([pageHeader, record]);
const fileHeader = Buffer.alloc(12);
fileHeader.write("cook");
fileHeader.writeUInt32BE(1, 4);
fileHeader.writeUInt32BE(page.length, 8);
const directory = join(home, "Library", "Cookies");
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(join(directory, "Cookies.binarycookies"), Buffer.concat([fileHeader, page]), {
  mode: 0o600,
  flag: "wx",
});
console.log(home);
