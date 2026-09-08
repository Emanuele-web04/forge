// Build the exact upstream commit plus the native patch required by the host.
// The upstream binary archive is baseline provenance, never a patched artifact.
import { mkdir, readFile, writeFile, chmod, mkdtemp, rm, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const release = JSON.parse(
  await readFile(
    new URL("../../../packages/shared/src/cuaDriverRelease.json", import.meta.url),
    "utf8",
  ),
);
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const destination = resolve(
  option("--destination") ?? fileURLToPath(new URL("../resources/cua-driver/", import.meta.url)),
);
const arch = option("--arch") ?? process.arch;
const targets = { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" };
const architectures = arch === "universal" ? ["arm64", "x64"] : [arch];
const artifact = option("--artifact-dir") ?? process.env.SYNARA_CUA_ARTIFACT_DIR;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const patchPath = fileURLToPath(
  new URL("../patches/cua-driver/0001-synara-native.patch", import.meta.url),
);
const patch = await readFile(patchPath);
if (process.platform !== "darwin" || architectures.some((value) => !targets[value]))
  throw new Error("Native Cua provisioning requires macOS and --arch arm64, x64 or universal.");
if (option("--archive"))
  throw new Error(
    "The upstream binary lacks Synara's native patch. Use --source-checkout or --artifact-dir instead.",
  );
if (digest(patch) !== release.patchSha256) throw new Error("Cua native patch checksum mismatch.");
const temporary = await mkdtemp(join(tmpdir(), "synara-cua-package-"));
const environment = {
  ...process.env,
  CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
  GIT_TERMINAL_PROMPT: "0",
};
const run = (binary, args, cwd) =>
  execFileSync(binary, args, { cwd, env: environment, stdio: "inherit" });
const output = (binary, args, cwd) =>
  execFileSync(binary, args, { cwd, env: environment, encoding: "utf8" }).trim();
try {
  let binary;
  let provenance;
  if (artifact) {
    binary = join(resolve(artifact), "cua-driver");
    provenance = JSON.parse(await readFile(join(resolve(artifact), "provenance.json"), "utf8"));
    if (
      provenance.version !== release.version ||
      provenance.source !== release.source ||
      provenance.nativeRevision !== release.nativeRevision ||
      provenance.patchSha256 !== release.patchSha256 ||
      provenance.rustVersion !== release.rustVersion ||
      architectures.some((value) => !provenance.architectures?.includes(value)) ||
      digest(await readFile(binary)) !== provenance.binarySha256
    ) {
      throw new Error("Cua artifact identity, architecture or binary checksum mismatch.");
    }
  } else {
    let source = option("--source-checkout");
    if (source) source = resolve(source);
    else {
      source = join(temporary, "upstream");
      run("git", ["init", "--bare", source]);
      run("git", [
        "-C",
        source,
        "fetch",
        "--depth=1",
        "https://github.com/trycua/cua.git",
        release.source,
      ]);
    }
    const commit = output("git", ["-C", source, "rev-parse", `${release.source}^{commit}`]);
    if (commit !== release.source) throw new Error("Cua source commit mismatch.");
    const archive = join(temporary, "source.tar");
    // Ignore local checkout edits; only the pinned commit enters the build.
    run("git", ["-C", source, "archive", `--output=${archive}`, release.source, "libs/cua-driver"]);
    const build = join(temporary, "build");
    await mkdir(build);
    run("tar", ["-xf", archive, "-C", build]);
    run("patch", ["--batch", "--forward", "-p1", "-i", patchPath], build);
    const rust = join(build, "libs/cua-driver/rust");
    const rustcVersion = output("rustc", ["--version"], rust);
    if (!rustcVersion.startsWith(`rustc ${release.rustVersion} `))
      throw new Error(
        `Use the pinned Rust ${release.rustVersion} toolchain; found ${rustcVersion}.`,
      );
    const workspace = await readFile(join(rust, "Cargo.toml"), "utf8");
    if (!workspace.includes(`version = "${release.version}"`))
      throw new Error("Cua source package version mismatch.");
    const targetDir = resolve(process.env.CARGO_TARGET_DIR || join(temporary, "target"));
    const binaries = [];
    for (const architecture of architectures) {
      const target = targets[architecture];
      run(
        "cargo",
        [
          "build",
          "--release",
          "--locked",
          "--target-dir",
          targetDir,
          "--target",
          target,
          "-p",
          "cua-driver",
          ...(process.argv.includes("--offline") ? ["--offline"] : []),
        ],
        rust,
      );
      binaries.push(join(targetDir, target, "release/cua-driver"));
    }
    binary = join(temporary, "cua-driver");
    if (binaries.length > 1) run("lipo", ["-create", ...binaries, "-output", binary]);
    else await copyFile(binaries[0], binary);
    provenance = {
      version: release.version,
      source: release.source,
      nativeRevision: release.nativeRevision,
      patchSha256: release.patchSha256,
      rustVersion: release.rustVersion,
      rustcVersion,
      architectures,
      binarySha256: digest(await readFile(binary)),
      upstreamArchiveSha256: release.sha256,
    };
  }
  // Validate a foreign architecture without requiring Rosetta. The GUI also
  // verifies version, native revision, embedded mode and PID before dispatch.
  const present = output("lipo", ["-archs", binary]).split(/\s+/);
  if (architectures.some((value) => !present.includes(value === "x64" ? "x86_64" : "arm64")))
    throw new Error("Cua Mach-O is missing a requested architecture.");
  await mkdir(destination, { recursive: true });
  await copyFile(binary, join(destination, "cua-driver"));
  await chmod(join(destination, "cua-driver"), 0o755);
  await writeFile(join(destination, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  await copyFile(
    fileURLToPath(new URL("../../../docs/computer-use-cua/CUA-LICENSE.txt", import.meta.url)),
    join(destination, "LICENSE.txt"),
  );
  console.log(
    `Cua ${release.version} native revision ${release.nativeRevision} (${architectures.join("+")}) staged at ${destination}`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
