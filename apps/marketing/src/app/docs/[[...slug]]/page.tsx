import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findNeighbour } from "fumadocs-core/page-tree";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  PageLastUpdate,
} from "fumadocs-ui/layouts/docs/page";
import { DocsPagination } from "@/components/docs/pagination";
import { getMDXComponents } from "@/components/mdx";
import { docsSource } from "@/lib/docs";
import { documentationPageJsonLd, documentationPageMetadata } from "@/lib/discovery";
import { breadcrumbJsonLd, jsonLdScript } from "@/lib/seo";

type DocumentationPageProps = {
  params: Promise<{ slug?: string[] }>;
};

const FALLBACK_DOCUMENTATION_DESCRIPTION = "Synara product documentation.";

function documentationTitle(pageTitle: string, pageUrl: string) {
  return pageUrl === "/docs" ? "Synara Documentation" : `${pageTitle} — Synara Docs`;
}

function documentationBreadcrumbs(slug: string[] | undefined, title: string, url: string) {
  const items = [{ name: "Documentation", path: "/docs" }];
  const segments = slug ?? [];

  for (let length = 1; length < segments.length; length += 1) {
    const parent = docsSource.getPage(segments.slice(0, length));
    if (parent && parent.url !== "/docs") {
      items.push({ name: parent.data.title, path: parent.url });
    }
  }

  if (url !== "/docs") items.push({ name: title, path: url });
  return items;
}

export default async function DocumentationPage({ params }: DocumentationPageProps) {
  const { slug } = await params;
  const page = docsSource.getPage(slug);

  if (!page) notFound();

  const Content = page.data.body;
  const neighbours = findNeighbour(docsSource.getPageTree(), page.url);
  const title = documentationTitle(page.data.title, page.url);
  const description = page.data.description ?? FALLBACK_DOCUMENTATION_DESCRIPTION;
  const breadcrumbs = documentationBreadcrumbs(slug, page.data.title, page.url);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(
            documentationPageJsonLd({
              title,
              description,
              path: page.url,
              lastModified: page.data.lastModified,
            }),
          ),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(breadcrumbJsonLd(breadcrumbs)) }}
      />
      <DocsPage
        role="main"
        aria-label="Documentation content"
        toc={page.data.toc}
        tableOfContent={{
          style: "clerk",
          container: { role: "navigation", "aria-labelledby": "toc-title" },
        }}
        breadcrumb={{ includeRoot: false, includePage: true }}
        footer={{ enabled: false }}
      >
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription>{description}</DocsDescription>
        <DocsBody>
          <Content components={getMDXComponents()} />
        </DocsBody>
        <div className="docs-meta mt-6 flex flex-row flex-wrap items-center justify-end gap-3 border-t border-border pt-4 text-[0.8125rem] text-muted-foreground">
          {page.data.lastModified ? <PageLastUpdate date={page.data.lastModified} /> : null}
        </div>
        <DocsPagination previous={neighbours.previous} next={neighbours.next} />
      </DocsPage>
    </>
  );
}

export async function generateMetadata({ params }: DocumentationPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = docsSource.getPage(slug);

  if (!page) notFound();

  return documentationPageMetadata({
    title: documentationTitle(page.data.title, page.url),
    description: page.data.description ?? FALLBACK_DOCUMENTATION_DESCRIPTION,
    path: page.url,
  });
}

export function generateStaticParams() {
  return docsSource.generateParams();
}
