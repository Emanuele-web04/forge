// FILE: releases.ts
// Purpose: Defines the GitHub release source used by the marketing site download flows.
// Layer: Marketing util
// Exports: repo/release URLs plus the latest-release fetch helper.

const REPO = "Emanuele-web04/Synara";
export const REPO_URL = `https://github.com/${REPO}`;

export const RELEASES_URL = `https://github.com/${REPO}/releases`;

const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = "synara-latest-release";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

export async function fetchLatestRelease(): Promise<Release> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const data = await fetch(API_URL).then((r) => r.json());

  if (data?.assets) {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  }

  return data;
}
