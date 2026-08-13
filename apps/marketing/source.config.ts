import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // Stamp pages with their last git commit date so DocsPage can show it.
    // On Vercel this needs the VERCEL_DEEP_CLONE=true env var to see history.
    lastModified: true,
  },
});

export default defineConfig();
