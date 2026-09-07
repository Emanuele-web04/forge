// FILE: installerCount.ts
// Purpose: Fetches, summarizes, and falls back for installer download totals.
// Layer: Server utility
// Depends on: GitHub Releases API, src/data/installer-downloads.json, optional GITHUB_TOKEN

import "server-only";

import storedInstallerDownloads from "@/data/installer-downloads.json";

const RELEASES_API_URL = "https://api.github.com/repos/Emanuele-web04/synara/releases?per_page=100";

const INSTALLER_FILE_PATTERN = /\.(dmg|exe|AppImage)$/i;

type GitHubReleaseAsset = {
  download_count?: number;
  name?: string;
};

type GitHubRelease = {
  assets?: GitHubReleaseAsset[];
};

export function getStoredInstallerCount(): number | null {
  return storedInstallerDownloads.count > 0 ? storedInstallerDownloads.count : null;
}

// Counts only actual installer artifacts so updater metadata and blockmaps do not inflate totals.
export function countInstallerDownloads(releases: GitHubRelease[]): number {
  return releases.reduce((total, release) => {
    const releaseTotal =
      release.assets?.reduce((assetTotal, asset) => {
        if (!asset.name || !INSTALLER_FILE_PATTERN.test(asset.name)) {
          return assetTotal;
        }

        return assetTotal + (asset.download_count ?? 0);
      }, 0) ?? 0;

    return total + releaseTotal;
  }, 0);
}

// Fetches live GitHub totals first, then falls back to the daily Codex-updated snapshot.
export async function getInstallerCount(): Promise<number | null> {
  if (process.env.VISUAL_TEST === "1") return getStoredInstallerCount();

  try {
    const headers: HeadersInit = {
      Accept: "application/vnd.github+json",
    };

    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const response = await fetch(RELEASES_API_URL, {
      headers,
      cache: "no-store",
    });

    if (!response.ok) return getStoredInstallerCount();

    const releases = (await response.json()) as GitHubRelease[];
    const count = countInstallerDownloads(releases);

    // New releases can briefly report zero while assets/download counts settle.
    return count > 0 ? count : getStoredInstallerCount();
  } catch {
    return getStoredInstallerCount();
  }
}
