// FILE: changelog/page.tsx
// Purpose: Public changelog — every Synara release, newest first. Editorial,
//          single-column layout inspired by the OpenAI Codex changelog, in our
//          palette: muted date, large headline with a light-gray version, airy
//          bullet lists, and inline `code` chips.
// Layer: App Router page (static). Body lives in ChangelogContent so the
//        per-version /changelog/v0.1.1 deep-link route can reuse it verbatim.
// Note: Content mirrors the in-app "What's new" changelog (src/data/changelog.ts).

import ChangelogContent from "@/components/ChangelogContent";
import { breadcrumbJsonLd, changelogCollectionJsonLd, jsonLdScript, pageMetadata } from "@/lib/seo";
import { getSortedReleases } from "@/lib/changelog";

export const metadata = pageMetadata({
  title: "Changelog — Synara",
  description:
    "Every Synara release: new providers, performance work, and the steady polish that makes the app faster and sturdier. Updated with each version.",
  path: "/changelog",
});

export default function ChangelogPage() {
  const releases = getSortedReleases();
  const jsonLd = [
    changelogCollectionJsonLd(releases),
    breadcrumbJsonLd([
      { name: "Synara", path: "/" },
      { name: "Changelog", path: "/changelog" },
    ]),
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
      <ChangelogContent />
    </>
  );
}
