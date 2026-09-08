import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asarPath = process.env.SYNARA_ASAR_MODULE;
if (!asarPath) throw new Error("Set SYNARA_ASAR_MODULE to the installed @electron/asar module.");
const asar = await import(pathToFileURL(asarPath).href);
const home = await mkdtemp(path.join(tmpdir(), "synara-betterwright-asar-"));
const stage = path.join(home, "stage");
await mkdir(stage);
// The CJS fixture is generated from the TypeScript smoke: bundling keeps the
// probe identical to the unpackaged run while staying requireable from ASAR.
const fixture = path.join(desktop, ".smoke/betterwright-smoke.cjs");
await mkdir(path.dirname(fixture), { recursive: true });
await execFileAsync("bun", [
  "build",
  path.join(desktop, "scripts/betterwright-smoke.ts"),
  "--target=node",
  "--format=cjs",
  "--external",
  "betterwright",
  "--external",
  "electron",
  `--outfile=${fixture}`,
]);
await cp(path.join(desktop, ".smoke/betterwright-smoke.cjs"), path.join(stage, "main.cjs"));
await writeFile(
  path.join(stage, "package.json"),
  JSON.stringify({ name: "synara-browser-smoke", version: "1.0.0", main: "main.cjs" }),
);
const staged = new Map();

async function packageRoot(name, from) {
  const resolve = createRequire(path.join(from, "package.json"));
  try {
    return path.dirname(resolve.resolve(`${name}/package.json`));
  } catch {
    let current = path.dirname(resolve.resolve(name));
    for (;;) {
      try {
        if (JSON.parse(await readFile(path.join(current, "package.json"), "utf8")).name === name)
          return current;
      } catch {}
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`Package root not found: ${name}`);
      current = parent;
    }
  }
}

async function stagePackage(name, source) {
  source = await realpath(source);
  if (staged.has(name)) {
    if (staged.get(name) !== source)
      throw new Error(`Smoke fixture cannot flatten two versions of ${name}.`);
    return;
  }
  {
    const target = path.join(stage, "node_modules", name);
    staged.set(name, source);
    await cp(source, target, {
      recursive: true,
      filter: (entry) =>
        entry === source || !path.relative(source, entry).split(path.sep).includes("node_modules"),
    });
    const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      let root;
      try {
        root = await packageRoot(dependency, source);
      } catch (error) {
        if (manifest.optionalDependencies?.[dependency]) continue;
        throw error;
      }
      await stagePackage(dependency, root);
    }
  }
}

for (const name of ["betterwright", "ws"])
  await stagePackage(name, await packageRoot(name, desktop));
const archive = path.join(home, "app.asar");
await asar.createPackageWithOptions(stage, archive, { unpack: "**/*.node" });
const child = spawn(require("electron"), [archive], {
  stdio: "inherit",
  env: { ...process.env, SYNARA_SMOKE_HOME: path.join(home, "runtime") },
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  console.log(`ASAR smoke artifacts: ${home}`);
  process.exitCode = code ?? 1;
});
