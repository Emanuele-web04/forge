# Recap: SEO and AI Indexing

> Generated: 2026-06-12 | Scope: 29 files

---

## Summary

The goal was to strengthen Synara's technical SEO, Search Console readiness, and AI-search discoverability. The site now has richer metadata, safer JSON-LD, a sitemap index, split sitemaps, explicit crawler guidance, dynamic LLM text files, a web manifest, stable sitemap dates, canonical repository links, and per-release changelog pages with unique visible content. Build, lint, endpoint smoke tests, and an in-app browser check passed.

---

## Files Affected

| File                                   | Status   | Role                                                                               |
| -------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `src/lib/seo.ts`                       | Modified | Central SEO constants, crawler list, JSON-LD builders, canonical URLs              |
| `src/lib/siteRoutes.ts`                | Created  | Shared canonical route list for sitemap generation                                 |
| `src/lib/releaseDates.ts`              | Created  | Stable release and privacy dates for sitemap `lastmod` and JSON-LD                 |
| `src/lib/llmText.ts`                   | Created  | Builds `/llms.txt`, `/llms-full.txt`, and `/ai.txt` content                        |
| `src/data/faqs.ts`                     | Created  | Shared FAQ data for visible UI and FAQPage JSON-LD                                 |
| `src/app/sitemap.ts`                   | Modified | Main sitemap for static pages and AI text routes                                   |
| `src/app/changelog/sitemap.ts`         | Created  | Changelog release sitemap                                                          |
| `src/app/sitemap-index.xml/route.ts`   | Created  | Sitemap index for Search Console submission                                        |
| `src/app/robots.ts`                    | Modified | Allows search and AI user agents, disallows `/api/`, lists all sitemap URLs        |
| `src/app/llms.txt/route.ts`            | Created  | Dynamic concise LLM discovery document                                             |
| `src/app/llms-full.txt/route.ts`       | Created  | Dynamic expanded LLM context document                                              |
| `src/app/ai.txt/route.ts`              | Created  | AI crawler summary and product facts                                               |
| `src/app/manifest.ts`                  | Created  | Web app manifest with icons, categories, screenshots                               |
| `public/llms.txt`                      | Deleted  | Replaced by dynamic App Router route                                               |
| `src/app/layout.tsx`                   | Modified | Root Metadata API fields and safe global JSON-LD serialization                     |
| `src/app/page.tsx`                     | Modified | Homepage FAQ and breadcrumb JSON-LD, canonical GitHub URL                          |
| `src/app/install/page.tsx`             | Modified | Download page JSON-LD and breadcrumb                                               |
| `src/app/changelog/page.tsx`           | Modified | CollectionPage and breadcrumb JSON-LD                                              |
| `src/app/changelog/[version]/page.tsx` | Modified | Per-release TechArticle and breadcrumb JSON-LD                                     |
| `src/app/privacy/page.tsx`             | Modified | Privacy WebPage and breadcrumb JSON-LD                                             |
| `src/components/FAQ.tsx`               | Modified | Uses shared FAQ data                                                               |
| `src/components/Navbar.tsx`            | Modified | Uses canonical Synara GitHub repository URL                                        |
| `src/components/ChangelogContent.tsx`  | Modified | Renders either the full archive or one release; uses canonical Synara releases URL |
| `src/components/ScrollToRelease.tsx`   | Deleted  | Removed because per-release pages no longer render the full archive                |
| `src/components/AskAISection.tsx`      | Modified | Uses canonical non-www domain in AI prompt                                         |
| `src/lib/githubStars.ts`               | Modified | Fetches stars from canonical Synara repository                                     |
| `src/lib/installerCount.ts`            | Modified | Fetches installer counts from canonical Synara repository                          |

---

## Logic Explanation

### Problem

The site already had basic metadata, a single sitemap, robots.txt, and a static `llms.txt`, but several signals were shallow or inconsistent. Release pages all used build-time `new Date()` in the sitemap, AI/search crawlers were not called out explicitly, and repository links were split between the older project identity and the current `synara` identity.

### Approach

The implementation keeps Next.js App Router metadata conventions instead of adding manual head tags. It centralizes SEO constants in `src/lib/seo.ts`, shares canonical route data through `src/lib/siteRoutes.ts`, and generates text discovery files dynamically so changelog and FAQ content do not drift.

### Step-by-step

1. The root layout now owns the site-level Metadata API fields: canonical base URL, manifest, icons, app metadata, safe JSON-LD serialization, and shared keywords. This keeps browser, crawler, and social metadata generated by Next.

2. `/sitemap.xml` now covers homepage, install, changelog, privacy, and AI text files with stable `lastmod` values. `/changelog/sitemap.xml` covers every release URL using parsed changelog dates instead of the current build date.

3. `/sitemap-index.xml` lists the sitemap files so Search Console can submit one URL and discover both the static and changelog sitemap surfaces.

4. `/robots.txt` allows the whole public site, explicitly allows useful AI/search user agents, disallows `/api/`, and points crawlers at the sitemap index plus child sitemaps.

5. `/llms.txt`, `/llms-full.txt`, and `/ai.txt` are generated from shared product data, FAQ data, and changelog data. They are an extra AI-agent aid, not treated as a guaranteed Google ranking mechanism.

6. Page-specific JSON-LD now describes the visible content on each route: FAQPage on the homepage, WebPage/DownloadAction on install, CollectionPage for changelog, TechArticle for release pages, privacy WebPage, and BreadcrumbList where useful.

7. Per-release changelog routes now pass a single release into `ChangelogContent`, so `/changelog/v0.1.9` renders only 0.1.9 instead of duplicating the full archive. This keeps canonical URLs, sitemap entries, page metadata, JSON-LD, and visible content aligned.

### Tradeoffs & Edge Cases

The release dates are inferred as 2026 because the source changelog stores labels like `Jun 12` instead of full ISO dates. A future cleanup could add explicit ISO dates directly to `src/data/changelog.ts` for perfect long-term accuracy.

The AI text files are included in the sitemap with low priority. Google says `llms.txt` is not required for AI Overviews or AI Mode, but exposing these documents is useful for LLM agents, browser agents, and AI search tools that do read plain text context.

---

## Flow Diagram

### Happy Path

```mermaid
flowchart TD
    A[src/lib/seo.ts] -->|constants and JSON-LD builders| B[src/app/layout.tsx]
    A -->|metadata helpers| C[page routes]
    D[src/lib/siteRoutes.ts] -->|static entries| E[src/app/sitemap.ts]
    D -->|release entries| F[src/app/changelog/sitemap.ts]
    D -->|sitemap paths| G[src/app/sitemap-index.xml/route.ts]
    H[src/lib/llmText.ts] -->|concise context| I[src/app/llms.txt/route.ts]
    H -->|full context| J[src/app/llms-full.txt/route.ts]
    H -->|crawler facts| K[src/app/ai.txt/route.ts]
    A -->|AI user agents| L[src/app/robots.ts]
    E -->|/sitemap.xml| M[Search crawlers]
    F -->|/changelog/sitemap.xml| M
    G -->|/sitemap-index.xml| M
    I -->|/llms.txt| N[AI agents]
    J -->|/llms-full.txt| N
    K -->|/ai.txt| N
    O[src/app/changelog/[version]/page.tsx] -->|single release| P[src/components/ChangelogContent.tsx]
    Q[src/app/changelog/page.tsx] -->|all releases| P
```

---

## High School Explanation

Imagine Synara's website is a school project you want everyone to find.

The sitemap is the table of contents. Google can now see the main pages and every release note page, with real dates instead of "today" stamped everywhere.

The robots file is the front desk sign. It says, "You can visit the public pages, please skip the API room, and here are the maps."

The JSON-LD is like labeled sticky notes on the project board. It tells search engines, "This is the app, this is the download page, these are FAQs, these are release notes."

The LLM files are a cheat sheet for AI tools. If an AI assistant wants a quick, clean summary of Synara, it gets one without digging through the whole page.
