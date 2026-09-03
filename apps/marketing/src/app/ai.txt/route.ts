// FILE: ai.txt/route.ts
// Purpose: Serves crawler guidance and public product facts for AI agents.
// Layer: App Router route handler.

import { buildAiTxt } from "@/lib/llmText";

export const revalidate = 86400;

export function GET() {
  return new Response(`${buildAiTxt()}\n`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
