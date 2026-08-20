// FILE: check-brand-identity.ts
// Purpose: Prevents retired first-party identities from returning to tracked files.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const characters = (...codes: number[]): string => String.fromCharCode(...codes);
const retiredShortName = characters(116, 51);
const retiredFirstName = `${retiredShortName}${characters(99, 111, 100, 101)}`;
const retiredCompanyName = `${retiredShortName}${characters(116, 111, 111, 108, 115)}`;
const retiredSecondName = characters(100, 112, 99, 111, 100, 101);
const retiredPredecessorName = characters(99, 111, 100, 101, 116, 104, 105, 110, 103);
const incorrectBundleDomain = characters(99, 111, 109, 46, 115, 121, 110, 97, 114, 97);
const retiredFirstDisplayName = characters(84, 51, 67, 111, 100, 101);
const retiredFirstSpacedDisplayName = `${characters(84, 51)} Code`;
const retiredCompanyDisplayName = `${characters(84, 51)} ${characters(84, 111, 111, 108, 115)}`;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const joinedWithOptionalSeparator = (left: string, right: string): string =>
  `${escapeRegExp(left)}[\\s._/@:-]*${escapeRegExp(right)}`;

const forbiddenPatterns = [
  new RegExp(
    joinedWithOptionalSeparator(retiredShortName, retiredFirstName.slice(retiredShortName.length)),
    "i",
  ),
  new RegExp(
    joinedWithOptionalSeparator(
      retiredShortName,
      retiredCompanyName.slice(retiredShortName.length),
    ),
    "i",
  ),
  new RegExp(
    joinedWithOptionalSeparator(retiredSecondName.slice(0, 2), retiredSecondName.slice(2)),
    "i",
  ),
  new RegExp(escapeRegExp(retiredPredecessorName), "i"),
  new RegExp(`@${escapeRegExp(retiredCompanyName)}`, "i"),
  new RegExp(
    `(?:^|[\\s"'\\x60./:@_-])${escapeRegExp(retiredShortName)}(?:$|[\\s"'\\x60./:@_-])`,
    "i",
  ),
  new RegExp(escapeRegExp(incorrectBundleDomain), "i"),
] as const;

interface ApprovedAttribution {
  readonly path: string;
  readonly line: string;
  readonly markdownSection?: string;
}

const approvedAttributions: readonly ApprovedAttribution[] = [
  {
    path: "LICENSE",
    line: `Copyright (c) 2026 ${retiredCompanyDisplayName} Inc.`,
  },
  {
    path: "README.md",
    markdownSection: "## Origins",
    line: `Synara began as a clone of [${retiredFirstDisplayName}](https://github.com/pingdotgg/${retiredFirstName}), but it has since become a substantially different product with its own branding, packaging, release system, provider orchestration, desktop app behavior, and product direction.`,
  },
  {
    path: "CHANGELOG.md",
    markdownSection: "## 0.7.0 - 2026-08-05",
    line: `**A review of the Synara codebase found an analytics configuration that came from the original ${retiredFirstSpacedDisplayName} codebase when Synara was created as a clone in March. We did not add it, and we have no access to the PostHog project receiving the events.**`,
  },
  {
    path: "apps/web/src/whatsNew/entries.ts",
    line: `"A review of the Synara codebase found an analytics configuration that came from the original ${retiredFirstSpacedDisplayName} codebase when Synara was created as a clone in March.",`,
  },
];

// Raster images cannot be searched for embedded text. Keep the user-facing
// screenshots behind reviewed digests so changing either one requires another
// explicit visual identity audit instead of silently bypassing this guard.
const approvedVisualAssetDigests = new Map<string, string>([
  [
    "apps/marketing/public/screenshot.jpeg",
    "0b4be139f13dd08885a1aac26fc1f7c623697db157777d16360e985c93d47bcf",
  ],
  [
    "assets/prod/synara-hero.jpeg",
    "07fbd00bde259b5ed2c69f404c00c1347de2fa46fa4a5e2aa70f016912dc2490",
  ],
]);

export interface BrandIdentityFile {
  readonly path: string;
  readonly contents: string;
}

export interface BrandIdentityViolation {
  readonly path: string;
  readonly line: number | null;
  readonly text: string;
}

export interface BrandIdentityBinaryFile {
  readonly path: string;
  readonly contents: Uint8Array;
}

function containsForbiddenIdentity(value: string): boolean {
  return forbiddenPatterns.some((pattern) => pattern.test(value));
}

function findApprovedAttribution(
  path: string,
  line: string,
  markdownSection: string | null,
  consumedAttributions: ReadonlySet<number>,
): number | null {
  const index = approvedAttributions.findIndex(
    (attribution, candidateIndex) =>
      !consumedAttributions.has(candidateIndex) &&
      attribution.path === path &&
      attribution.line === line.trim() &&
      (attribution.markdownSection === undefined ||
        attribution.markdownSection === markdownSection),
  );
  return index === -1 ? null : index;
}

export function findBrandIdentityViolations(
  files: readonly BrandIdentityFile[],
): BrandIdentityViolation[] {
  const violations: BrandIdentityViolation[] = [];
  for (const file of files) {
    if (containsForbiddenIdentity(file.path)) {
      violations.push({ path: file.path, line: null, text: file.path });
    }
    const consumedAttributions = new Set<number>();
    let markdownSection: string | null = null;
    for (const [index, line] of file.contents.split(/\r?\n/).entries()) {
      if (/^#{1,2}\s+/.test(line)) markdownSection = line.trim();
      if (!containsForbiddenIdentity(line)) continue;
      const approvedAttribution = findApprovedAttribution(
        file.path,
        line,
        markdownSection,
        consumedAttributions,
      );
      if (approvedAttribution !== null) {
        consumedAttributions.add(approvedAttribution);
        continue;
      }
      violations.push({ path: file.path, line: index + 1, text: line.trim() });
    }
  }
  return violations;
}

export function findVisualBrandAssetViolations(
  files: readonly BrandIdentityBinaryFile[],
  approvedDigests: ReadonlyMap<string, string> = approvedVisualAssetDigests,
): BrandIdentityViolation[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const violations: BrandIdentityViolation[] = [];
  for (const [path, approvedDigest] of approvedDigests) {
    const file = filesByPath.get(path);
    if (!file) {
      violations.push({
        path,
        line: null,
        text: "Required visual brand asset is missing.",
      });
      continue;
    }
    const digest = createHash("sha256").update(file.contents).digest("hex");
    if (digest !== approvedDigest) {
      violations.push({
        path,
        line: null,
        text: "Visual brand asset changed; perform a visual identity review before approving it.",
      });
    }
  }
  return violations;
}

function readTrackedFiles(): BrandIdentityBinaryFile[] {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  return paths.map((path) => ({ path, contents: readFileSync(path) }));
}

function main(): void {
  const trackedFiles = readTrackedFiles();
  const searchableFiles = trackedFiles.map((file) => ({
    path: file.path,
    contents: file.contents.includes(0) ? "" : Buffer.from(file.contents).toString("utf8"),
  }));
  const violations = [
    ...findBrandIdentityViolations(searchableFiles),
    ...findVisualBrandAssetViolations(trackedFiles),
  ];
  if (violations.length === 0) {
    console.log("Synara identity check passed.");
    return;
  }

  console.error("Retired first-party identity found:");
  for (const violation of violations) {
    const location =
      violation.line === null ? violation.path : `${violation.path}:${violation.line}`;
    console.error(`- ${location}: ${violation.text}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) main();
