// FILE: llms.txt/route.ts
// Purpose: Serves concise Markdown context for LLMs and AI browsing tools.
// Layer: App Router route handler.

import { buildLlmsTxt } from "@/lib/llmText";

export const revalidate = 86400;

export function GET() {
  return new Response(`${buildLlmsTxt()}\n`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
