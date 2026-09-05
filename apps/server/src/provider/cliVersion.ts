export const CLI_VERSION_PATTERN = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/;

export interface ParsedCliVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string>;
}

export function splitPrerelease(version: string): { main: string; prerelease: string | undefined } {
  const separatorIndex = version.indexOf("-");
  if (separatorIndex === -1) {
    return { main: version, prerelease: undefined };
  }
  return {
    main: version.slice(0, separatorIndex),
    prerelease: version.slice(separatorIndex + 1),
  };
}

export function normalizeCliVersion(version: string): string {
  const { main, prerelease } = splitPrerelease(version.trim());
  const segments = main
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 2) {
    segments.push("0");
  }

  return prerelease ? `${segments.join(".")}-${prerelease}` : segments.join(".");
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left.localeCompare(right);
}

export function compareParsedCliVersions(
  parsedLeft: ParsedCliVersion,
  parsedRight: ParsedCliVersion,
): number {
  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }
  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch - parsedRight.patch;
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) {
    return 0;
  }
  if (parsedLeft.prerelease.length === 0) {
    return 1;
  }
  if (parsedRight.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}
