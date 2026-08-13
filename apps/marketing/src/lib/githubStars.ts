// FILE: lib/githubStars.ts
// Purpose: Fetches and formats the public GitHub star count shown in the navbar.
// Layer: server utility.

const GITHUB_REPO_API_URL = "https://api.github.com/repos/Emanuele-web04/synara";

export async function getStars(): Promise<number | null> {
  if (process.env.VISUAL_TEST === "1") return 4300;

  try {
    const res = await fetch(GITHUB_REPO_API_URL, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.stargazers_count ?? null;
  } catch {
    return null;
  }
}

export function formatStars(count: number): string {
  if (count >= 1000) {
    const k = count / 1000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return count.toString();
}
