import {
  CLI_VERSION_PATTERN,
  compareParsedCliVersions,
  normalizeCliVersion,
  splitPrerelease,
  type ParsedCliVersion,
} from "./cliVersion.ts";

export const MINIMUM_CODEX_CLI_VERSION = "0.37.0";
// `approvalsReviewer: "auto_review"` and its companion messages shipped in rust-v0.124.0.
export const MINIMUM_CODEX_AUTO_REVIEW_CLI_VERSION = "0.124.0";
// `excludeTurns` for thread/resume and thread/fork shipped in rust-v0.125.0.
export const MINIMUM_CODEX_EXCLUDE_TURNS_CLI_VERSION = "0.125.0";

function parseSemver(version: string): ParsedCliVersion | null {
  const normalized = normalizeCliVersion(version);
  const { main, prerelease } = splitPrerelease(normalized);
  const segments = main.split(".");
  if (segments.length !== 3) {
    return null;
  }

  const [majorSegment, minorSegment, patchSegment] = segments;
  if (majorSegment === undefined || minorSegment === undefined || patchSegment === undefined) {
    return null;
  }

  // Preserve Codex's numeric-prefix parsing; generic provider versions require digits only.
  const major = Number.parseInt(majorSegment, 10);
  const minor = Number.parseInt(minorSegment, 10);
  const patch = Number.parseInt(patchSegment, 10);
  if (![major, minor, patch].every(Number.isInteger)) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease:
      prerelease
        ?.split(".")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0) ?? [],
  };
}

export function compareCodexCliVersions(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  return compareParsedCliVersions(parsedLeft, parsedRight);
}

export function parseCodexCliVersion(output: string): string | null {
  const match = CLI_VERSION_PATTERN.exec(output);
  if (!match?.[1]) {
    return null;
  }

  const parsed = parseSemver(match[1]);
  if (!parsed) {
    return null;
  }

  return normalizeCliVersion(match[1]);
}

export function isCodexCliVersionSupported(version: string): boolean {
  return compareCodexCliVersions(version, MINIMUM_CODEX_CLI_VERSION) >= 0;
}

export function formatCodexCliUpgradeMessage(
  version: string | null,
  minimumVersion = MINIMUM_CODEX_CLI_VERSION,
): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Codex CLI ${versionLabel} is too old for Synara. Upgrade to v${minimumVersion} or newer and restart Synara.`;
}
