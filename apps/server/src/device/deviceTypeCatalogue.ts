/**
 * deviceTypeCatalogue - screen geometry and product family, known before boot.
 *
 * The native helper reports a device's real geometry, but only once it has
 * attached to a booted simulator. That is far too late for the pane: picking an
 * iPad from the picker drew an iPhone-shaped chassis until the stream arrived,
 * then snapped to the right shape seconds later.
 *
 * Every simulator device type ships a `profile.plist` carrying `mainScreenWidth`
 * / `mainScreenHeight` / `mainScreenScale`, and `simctl list devicetypes` maps
 * each device to its bundle and product family. Both are readable with the
 * device shut down, so discovery can carry geometry from the first listing.
 *
 * The helper's attachment still wins when it disagrees: it measures the actual
 * framebuffer of the running boot, and that is what input is validated against.
 *
 * @module device/deviceTypeCatalogue
 */
import * as path from "node:path";

import type { DeviceFamily, DeviceGeometry } from "@synara/contracts";

import type { runProcess } from "../processRunner.ts";

export interface DeviceTypeProfile {
  readonly family: DeviceFamily;
  readonly geometry: DeviceGeometry;
}

/** Identifier -> profile, as read from the installed simulator device types. */
export type DeviceTypeCatalogue = ReadonlyMap<string, DeviceTypeProfile>;

/**
 * Apple's product families, mapped onto the two chassis the pane draws. Anything
 * unrecognised (a watch, a TV) yields null and is drawn from the device name,
 * because guessing "phone" for an Apple TV is worse than the name heuristic.
 */
function familyFor(productFamily: unknown): DeviceFamily | null {
  switch (String(productFamily)) {
    case "iPhone":
    case "iPod touch":
      return "phone";
    case "iPad":
      return "tablet";
    default:
      return null;
  }
}

interface SimctlDeviceType {
  readonly identifier?: unknown;
  readonly productFamily?: unknown;
  readonly bundlePath?: unknown;
}

export interface ParsedDeviceType {
  readonly identifier: string;
  readonly family: DeviceFamily;
  readonly profilePath: string;
}

/**
 * Parse `simctl list devicetypes --json` into the entries worth reading a
 * profile for. Entries missing an identifier, a bundle, or a family this pane
 * can draw are dropped rather than half-filled.
 */
export function parseSimctlDeviceTypes(json: string): readonly ParsedDeviceType[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list = (parsed as { devicetypes?: unknown }).devicetypes;
  if (!Array.isArray(list)) return [];

  const entries: ParsedDeviceType[] = [];
  for (const raw of list as readonly SimctlDeviceType[]) {
    const identifier = typeof raw.identifier === "string" ? raw.identifier : null;
    const bundlePath = typeof raw.bundlePath === "string" ? raw.bundlePath : null;
    const family = familyFor(raw.productFamily);
    if (!identifier || !bundlePath || family === null) continue;
    entries.push({
      identifier,
      family,
      profilePath: path.join(bundlePath, "Contents", "Resources", "profile.plist"),
    });
  }
  return entries;
}

/**
 * Pull geometry out of a device type profile.
 *
 * The plist reports the screen in pixels plus a scale; the contract carries
 * points, because that is the unit input is injected in. A profile missing any
 * of the three (or reporting nonsense) yields null, so a device keeps whatever
 * the helper later measures rather than inheriting a bad guess.
 */
export function parseDeviceTypeProfile(json: string): DeviceGeometry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const profile = parsed as Record<string, unknown>;
  const read = (key: string): number | null => {
    const value = profile[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  };
  const pixelWidth = read("mainScreenWidth");
  const pixelHeight = read("mainScreenHeight");
  const scale = read("mainScreenScale");
  if (pixelWidth === null || pixelHeight === null || scale === null) return null;
  return {
    pointWidth: Math.round(pixelWidth / scale),
    pointHeight: Math.round(pixelHeight / scale),
    scale,
  };
}

/**
 * Read every installed device type's family and geometry.
 *
 * Costs one `simctl list devicetypes` plus a `plutil` per type — around 120
 * short-lived processes on a full Xcode — so the caller caches it for the
 * process lifetime. Any single failure is skipped rather than failing the whole
 * catalogue: one unreadable profile must not cost the geometry of the other 120.
 */
export async function readDeviceTypeCatalogue(input: {
  readonly run: typeof runProcess;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): Promise<DeviceTypeCatalogue> {
  const listing = await input
    .run("xcrun", ["simctl", "list", "devicetypes", "--json"], {
      timeoutMs: 30_000,
      allowNonZeroExit: true,
      outputMode: "truncate",
      env: input.env,
    })
    .catch(() => null);
  if (!listing || listing.code !== 0) return new Map();

  const entries = parseSimctlDeviceTypes(listing.stdout);
  const catalogue = new Map<string, DeviceTypeProfile>();
  await Promise.all(
    entries.map(async (entry) => {
      const result = await input
        .run("plutil", ["-convert", "json", "-o", "-", entry.profilePath], {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        })
        .catch(() => null);
      if (!result || result.code !== 0) return;
      const geometry = parseDeviceTypeProfile(result.stdout);
      if (!geometry) return;
      catalogue.set(entry.identifier, { family: entry.family, geometry });
    }),
  );
  return catalogue;
}
