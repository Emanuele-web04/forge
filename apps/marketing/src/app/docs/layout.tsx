import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { docsSource } from "@/lib/docs";
import { docsLayoutOptions } from "@/lib/docsLayout";
import { DocsA11yLabels } from "@/components/docs/DocsA11yLabels";
import { DocsSmoothScroll } from "@/components/docs/DocsSmoothScroll";

export default function DocumentationLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <DocsLayout
        {...docsLayoutOptions()}
        tree={docsSource.getPageTree()}
        // Folder triggers are hidden via CSS (flat shadcn-style tree), so every
        // level must render expanded or nested pages would be unreachable.
        sidebar={{ collapsible: true, defaultOpenLevel: 6, prefetch: false }}
        tabs={false}
      >
        {children}
      </DocsLayout>
      <DocsA11yLabels />
      <DocsSmoothScroll />
    </>
  );
}
