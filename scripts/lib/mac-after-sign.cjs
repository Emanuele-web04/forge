// FILE: mac-after-sign.cjs
// Purpose: electron-builder `afterSign` hook — strips the nested computer-use helper's
//          inherited entitlements, re-seals the app, and notarizes what actually ships.
// Layer: Release/build helper (runs inside the electron-builder process)
// Depends on: mac-after-sign.json, written beside this file by build-desktop-artifact.ts.
//
// Why this exists
// ---------------
// electron-builder signs every nested executable with `entitlementsInherit`,
// which for an Electron app must carry `allow-jit`,
// `allow-unsigned-executable-memory`, `disable-library-validation` and
// `device.audio-input` — the renderer, GPU and plugin helpers need them.
// `Contents/Helpers/Synara Computer Use.app` is not one of those helpers. It is
// the process holding Accessibility and Screen Recording, and it needs no
// entitlement at all (its only `dlopen` is Apple's SkyLight, which library
// validation permits). electron-builder exposes no per-file entitlement
// override, so the only place to correct it is after its signing pass.
//
// Re-signing a nested bundle invalidates the outer app's seal, so the app is
// re-signed too. That in turn is why notarization is done here rather than by
// electron-builder: `notarizeIfProvided` runs *inside* electron-builder's sign
// step, i.e. before this hook, so leaving it there would staple a ticket for a
// code directory hash the shipped app no longer has. `mac.notarize` is set to
// `false` in the generated config and this hook owns the submission instead —
// after the app is in its final shape, and before any dmg/zip target packages
// it.
//
// This is plain CommonJS on purpose: electron-builder `require`s hook modules
// out of the staged app directory, which has no TypeScript pipeline. Everything
// variable (paths, whether to notarize) arrives through the JSON sidecar so
// nothing here restates a constant that lives in TypeScript.

"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { isAbsolute, join, resolve } = require("node:path");

const CONFIG_PATH = join(__dirname, "mac-after-sign.json");
/** Notarization of a full desktop app is minutes, and Apple's queue sets the pace. */
const NOTARIZE_TIMEOUT = "30m";
const COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function log(message) {
  console.log(`[mac-after-sign] ${message}`);
}

function readConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing ${CONFIG_PATH}; build-desktop-artifact.ts must stage it beside the hook.`,
    );
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? "unknown"}):\n${output}`,
    );
  }
  return { status: result.status, output };
}

/**
 * How the outer app ended up signed, read back off the bundle rather than
 * guessed from configuration.
 *
 * The hook has to reproduce that signature when it re-seals, and the two ways
 * the build can get here — a discovered Developer ID identity, or no identity
 * at all — differ in identity, timestamp policy and hardened runtime. Reading
 * the artifact is the only answer that cannot drift from what actually
 * happened.
 */
function readSignature(bundlePath) {
  const { status, output } = run("codesign", ["-dvv", "--verbose=4", bundlePath], {
    allowFailure: true,
  });
  if (status !== 0) return { signed: false, adhoc: false, identity: null, hardenedRuntime: false };
  const adhoc = /^Signature=adhoc$/m.test(output);
  const authority = /^Authority=(.+)$/m.exec(output)?.[1]?.trim();
  const flags = /^CodeDirectory .*\bflags=0x[0-9a-f]+\(([^)]*)\)/m.exec(output)?.[1] ?? "";
  return {
    signed: true,
    adhoc,
    identity: adhoc ? "-" : (authority ?? null),
    hardenedRuntime: flags.split(",").includes("runtime"),
  };
}

/** The entitlements a signed bundle currently carries, as raw plist XML ("" when none). */
function readEntitlements(bundlePath) {
  const { status, output } = run("codesign", ["-d", "--entitlements", ":-", "--xml", bundlePath], {
    allowFailure: true,
  });
  if (status !== 0) return "";
  // `codesign -d` writes its `Executable=` banner to stderr and the plist to
  // stdout; both are joined above, so pick out the document itself.
  const start = output.indexOf("<?xml");
  return start === -1 ? "" : output.slice(start).trim();
}

function entitlementKeys(plistXml) {
  return [...plistXml.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
}

function signArguments(signature, entitlementsPath) {
  const args = ["--force", "--sign", signature.identity ?? "-"];
  if (entitlementsPath) args.push("--entitlements", entitlementsPath);
  if (signature.hardenedRuntime) args.push("--options", "runtime");
  args.push(signature.adhoc ? "--timestamp=none" : "--timestamp");
  return args;
}

async function resolveKeychain(packager) {
  // A CI build imports `CSC_LINK` into a throwaway keychain that is not on the
  // search list, so `codesign -s` would not find the identity that had just
  // signed this very app without being told where it lives. The keychain is
  // still alive during `afterSign`; electron-builder deletes it afterwards.
  try {
    const info = await packager?.codeSigningInfo?.value;
    return info?.keychainFile ?? null;
  } catch {
    return null;
  }
}

function resolveFromProject(projectDir, candidate) {
  return isAbsolute(candidate) ? candidate : resolve(projectDir, candidate);
}

function notarize(appPath, projectDir) {
  const key = process.env.APPLE_API_KEY?.trim();
  const keyId = process.env.APPLE_API_KEY_ID?.trim();
  const issuer = process.env.APPLE_API_ISSUER?.trim();
  if (!key || !keyId || !issuer) {
    throw new Error(
      "Notarization was requested but APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER are not all set.",
    );
  }

  const workDir = mkdtempSync(join(tmpdir(), "synara-notarize-"));
  try {
    const archive = join(workDir, "app.zip");
    // notarytool takes an archive, never a bundle directory. `ditto` is the one
    // zip on macOS that preserves the symlinks inside Electron's frameworks,
    // which is why the update-zip finalizer uses it too.
    run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, archive]);
    log("submitting the app to Apple's notary service...");
    run("xcrun", [
      "notarytool",
      "submit",
      archive,
      "--key",
      resolveFromProject(projectDir, key),
      "--key-id",
      keyId,
      "--issuer",
      issuer,
      "--wait",
      "--timeout",
      NOTARIZE_TIMEOUT,
    ]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  // `notarytool --wait` has historically exited zero on a rejected submission,
  // so stapling is the assertion: a ticket Apple never issued cannot be
  // stapled. `spctl` then reports the verdict a user's Mac will reach, which is
  // the only statement that actually matters. This mirrors what
  // `scripts/lib/mac-dmg-finalize.ts` does for the disk image.
  run("xcrun", ["stapler", "staple", appPath]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  run("xcrun", ["stapler", "validate", appPath]);
  log("notarized, stapled and Gatekeeper-assessed the app.");
}

/**
 * Re-signs the nested computer-use helper without entitlements and re-seals the
 * app around it. Returns whether anything was changed.
 */
function repairHelperEntitlements(appPath, config, projectDir, keychain) {
  const helperPath = join(appPath, config.helperBundleRelativePath);
  if (!existsSync(helperPath)) {
    throw new Error(`Packaged app is missing ${config.helperBundleRelativePath}.`);
  }

  const appSignature = readSignature(appPath);
  if (!appSignature.signed) {
    // Nothing signed this app, so nothing re-signed the helper either: it still
    // carries the entitlement-free ad-hoc signature `build-computer-helper.mjs`
    // gave it. Verified rather than assumed — a helper that somehow acquired
    // entitlements with no outer signature to re-seal is a state this hook
    // cannot repair and must not paper over.
    const keys = entitlementKeys(readEntitlements(helperPath));
    if (keys.length > 0) {
      throw new Error(
        `The computer-use helper carries entitlements (${keys.join(", ")}) but the app is unsigned, so it cannot be re-sealed.`,
      );
    }
    log("app is unsigned; helper already carries no entitlements.");
    return false;
  }

  const existingKeys = entitlementKeys(readEntitlements(helperPath));
  if (existingKeys.length === 0) {
    log("helper already carries no entitlements; nothing to strip.");
    return false;
  }

  log(`stripping helper entitlements: ${existingKeys.join(", ")}`);
  const helperEntitlements = resolveFromProject(projectDir, config.helperEntitlementsPath);
  const appEntitlements = resolveFromProject(projectDir, config.appEntitlementsPath);
  const keychainArgs = keychain ? ["--keychain", keychain] : [];

  run("codesign", [
    ...signArguments(appSignature, helperEntitlements),
    ...keychainArgs,
    helperPath,
  ]);
  // Re-sealing the outer bundle is not optional: its `CodeResources` records the
  // helper's code directory hash, which just changed.
  run("codesign", [...signArguments(appSignature, appEntitlements), ...keychainArgs, appPath]);

  const remaining = entitlementKeys(readEntitlements(helperPath));
  if (remaining.length > 0) {
    throw new Error(`Helper still carries entitlements after re-signing: ${remaining.join(", ")}`);
  }
  run("codesign", ["--verify", "--strict", "--verbose=2", helperPath]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  log("helper re-signed with no entitlements and the app re-sealed.");
  return true;
}

// Exported for `scripts/mac-after-sign.test.ts`, which builds a real signed
// bundle pair on a macOS host and asserts the repair against `codesign` itself.
// The notarization half cannot be tested without Apple's notary service, so the
// half that can be is kept reachable.
exports.repairHelperEntitlements = repairHelperEntitlements;

function verifyAppSignature(appPath) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

exports.verifyAppSignature = verifyAppSignature;

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const config = readConfig();
  const packager = context.packager;
  const projectDir = packager?.info?.projectDir ?? packager?.projectDir ?? process.cwd();
  const appPath = join(context.appOutDir, `${packager.appInfo.productFilename}.app`);

  const keychain = await resolveKeychain(packager);
  repairHelperEntitlements(appPath, config, projectDir, keychain);
  // A valid nested helper is insufficient: macOS attributes its privacy
  // requests to the outer app. In particular, reject Electron's unsealed
  // linker signature even when the helper needed no entitlement repair.
  verifyAppSignature(appPath);

  if (config.notarize) {
    notarize(appPath, projectDir);
  }
};
