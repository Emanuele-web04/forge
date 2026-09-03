// FILE: llms-full.txt/route.ts
// Purpose: Serves expanded product, FAQ, and changelog context for AI retrieval.
// Layer: App Router route handler.

import { buildLlmsFullTxt } from "@/lib/llmText";

export const revalidate = false;

export async function GET() {
  return new Response(`${await buildLlmsFullTxt()}\n`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
