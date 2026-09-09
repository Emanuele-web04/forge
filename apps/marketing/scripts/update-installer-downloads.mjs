// FILE: update-installer-downloads.mjs
// Purpose: Refreshes stored installer counts and latest direct download links.
// Layer: Maintenance script for the Codex daily automation
// Depends on: GitHub Releases API, src/data installer JSON snapshots

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const downloadsOutputPath = resolve(projectRoot, "src/data/installer-downloads.json");
const latestOutputPath = resolve(projectRoot, "src/data/latest-release-downloads.json");
const releasesApiUrl = "https://api.github.com/repos/Emanuele-web04/synara/releases";
const latestReleaseApiUrl = `${releasesApiUrl}/latest`;
const installerFilePattern = /\.(dmg|exe|AppImage)$/i;

function createGitHubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
}

// Fetches every releases page so the stored figure remains a true all-time total.
async function fetchAllReleases() {
  const releases = [];

  for (let page = 1; ; page += 1) {
    const url = new URL(releasesApiUrl);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, { headers: createGitHubHeaders() });

    if (!response.ok) {
      throw new Error(`GitHub Releases API failed: ${response.status} ${response.statusText}`);
    }

    const pageReleases = await response.json();

    if (!Array.isArray(pageReleases) || pageReleases.length === 0) {
      break;
    }

    releases.push(...pageReleases);
  }

  return releases;
}

// Mirrors the website resolver's `/releases/latest` source, with the releases
// list as a rate-limit fallback so the maintenance job can still refresh.
async function fetchLatestRelease(releases) {
  const response = await fetch(latestReleaseApiUrl, {
    headers: createGitHubHeaders(),
  });

  if (response.ok) {
    return { release: await response.json(), source: latestReleaseApiUrl };
  }

  const stableRelease = releases.find((release) => !release.draft && !release.prerelease);

  if (stableRelease) {
    console.warn(
      `GitHub Latest Release API failed: ${response.status} ${response.statusText}; using ${stableRelease.tag_name} from releases list.`,
    );
    return { release: stableRelease, source: releasesApiUrl };
  }

  throw new Error(`GitHub Latest Release API failed: ${response.status} ${response.statusText}`);
}

function countInstallerDownloads(releases) {
  return releases.reduce((total, release) => {
    const releaseTotal =
      release.assets?.reduce((assetTotal, asset) => {
        if (!asset.name || !installerFilePattern.test(asset.name)) {
          return assetTotal;
        }

        return assetTotal + (asset.download_count ?? 0);
      }, 0) ?? 0;

    return total + releaseTotal;
  }, 0);
}

function getReleaseDownloads(release, source) {
  const assets = release.assets ?? [];
  const releasesUrl =
    release.html_url ?? `https://github.com/Emanuele-web04/synara/releases/tag/${release.tag_name}`;
  const urlFor = (pattern) =>
    assets.find((asset) => asset.name && pattern.test(asset.name))?.browser_download_url ??
    releasesUrl;

  const downloads = {
    version: release.tag_name ?? null,
    releasesUrl,
    mac: {
      arm64: urlFor(/arm64\.dmg$/i),
      x64: urlFor(/x64\.dmg$/i),
    },
    windows: urlFor(/\.exe$/i),
    linux: urlFor(/\.AppImage$/i),
    updatedAt: new Date().toISOString(),
    source,
  };

  if (
    !downloads.version ||
    downloads.mac.arm64 === releasesUrl ||
    downloads.mac.x64 === releasesUrl ||
    downloads.windows === releasesUrl ||
    downloads.linux === releasesUrl
  ) {
    throw new Error(
      `Latest release ${release.tag_name ?? "unknown"} is missing an installer asset.`,
    );
  }

  return downloads;
}

async function readExistingSnapshot(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

const releases = await fetchAllReleases();
const latestReleaseResult = await fetchLatestRelease(releases);
const count = countInstallerDownloads(releases);

if (count <= 0) {
  throw new Error("Refusing to write an empty installer download count.");
}

if (!latestReleaseResult.release) {
  throw new Error("Refusing to write latest downloads without a release.");
}

const previousSnapshot = await readExistingSnapshot(downloadsOutputPath);
const nextDownloadsSnapshot = {
  count,
  updatedAt: new Date().toISOString(),
  source: releasesApiUrl,
};
const nextLatestSnapshot = getReleaseDownloads(
  latestReleaseResult.release,
  latestReleaseResult.source,
);

await mkdir(dirname(downloadsOutputPath), { recursive: true });
await writeFile(downloadsOutputPath, `${JSON.stringify(nextDownloadsSnapshot, null, 2)}\n`);
await writeFile(latestOutputPath, `${JSON.stringify(nextLatestSnapshot, null, 2)}\n`);

const previousCount = previousSnapshot?.count ?? "unknown";
console.log(`Installer downloads: ${previousCount} -> ${count}`);
console.log(`Latest release downloads: ${nextLatestSnapshot.version}`);
