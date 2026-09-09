import defaultMdxComponents from "fumadocs-ui/mdx";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import type { MDXComponents } from "mdx/types";
import { Callout } from "@/components/docs/callout";
import { Card, Cards } from "@/components/docs/card";
import { Step, Steps } from "@/components/docs/steps";
import { DocsGallery, DocsImage, DocsScreenshot, DocsVideo } from "@/components/docs/media";

/*
 * Every docs page gets these without per-file imports. Headings and code
 * blocks come from the fumadocs defaults; Callout, Card(s), and Step(s) are
 * shadcn-based replacements so docs surfaces match the site design system.
 */
export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    Callout,
    Card,
    Cards,
    DocsGallery,
    DocsImage,
    DocsScreenshot,
    DocsVideo,
    Step,
    Steps,
    Tab,
    Tabs,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
