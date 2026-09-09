// FILE: lib/docsMarkdown.ts
// Purpose: Renders the canonical documentation as agent-readable Markdown.
// Layer: server utility for Markdown docs routes and the full AI corpus.

import { docsSource } from "@/lib/docs";
import { SITE_URL } from "@/lib/seo";

type DocumentationPage = ReturnType<typeof docsSource.getPages>[number];

export async function buildDocumentationMarkdown(page: DocumentationPage) {
  const content = await page.data.getText("processed");

  return [
    `# ${page.data.title}`,
    "",
    `Canonical URL: ${SITE_URL}${page.url}`,
    "",
    content.trim(),
  ].join("\n");
}

export async function buildDocumentationCorpus() {
  const pages = await Promise.all(docsSource.getPages().map(buildDocumentationMarkdown));
  return pages.join("\n\n---\n\n");
}
