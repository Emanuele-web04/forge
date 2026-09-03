// FILE: changelog/[version]/page.tsx
// Purpose: Shareable per-release deep link — /changelog/v0.1.1. Renders only
//          the targeted release so canonical URL, metadata, and visible content
//          all describe the same page.
// Layer: App Router dynamic page (statically generated per release).
// Note: The [version] segment is the slug "v0.1.1" (see toVersionSlug); we strip
//       the leading "v" to look the release up in CHANGELOG_ENTRIES.

import { notFound } from "next/navigation";
import ChangelogContent from "@/components/ChangelogContent";
import { breadcrumbJsonLd, jsonLdScript, pageMetadata, releaseJsonLd } from "@/lib/seo";
import { findRelease, fromVersionSlug, getSortedReleases, toVersionSlug } from "@/lib/changelog";

// Pre-render one static page per release: /changelog/v0.1.1, v0.1.0, …
export function generateStaticParams() {
  return getSortedReleases().map((entry) => ({
    version: toVersionSlug(entry.version),
  }));
}

// Only the versions we generate are valid; anything else 404s.
export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<{ version: string }> }) {
  const { version: slug } = await params;
  const entry = findRelease(fromVersionSlug(slug));
  if (!entry) return {};

  const highlights = entry.features.map((f) => f.title).join(", ");
  return pageMetadata({
    title: `Synara ${entry.version} — Changelog`,
    description: `What's new in Synara ${entry.version} (${entry.date}): ${highlights}.`,
    path: `/changelog/${toVersionSlug(entry.version)}`,
  });
}

export default async function ChangelogVersionPage({
  params,
}: {
  params: Promise<{ version: string }>;
}) {
  const { version: slug } = await params;
  const entry = findRelease(fromVersionSlug(slug));
  if (!entry) notFound();

  const jsonLd = [
    releaseJsonLd(entry),
    breadcrumbJsonLd([
      { name: "Synara", path: "/" },
      { name: "Changelog", path: "/changelog" },
      {
        name: `Synara ${entry.version}`,
        path: `/changelog/${toVersionSlug(entry.version)}`,
      },
    ]),
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
      <ChangelogContent
        releases={[entry]}
        title={`Synara ${entry.version} release notes.`}
        description={`What changed in Synara ${entry.version} (${entry.date}), including ${entry.features
          .map((feature) => feature.title)
          .join(", ")}.`}
      />
    </>
  );
}
