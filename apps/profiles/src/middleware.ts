import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Single-domain dev deployment (synara.vrbty.dev): this app owns the domain;
// non-profile pages proxy to the marketing site. /_next is shared by both
// apps and Next reserves it (config rewrites never fire there), so asset
// requests resolve local-first via a guarded self-probe: a local hit serves
// as-is, a miss proxies to the marketing origin. The x-asset-probe header
// stops the probe from re-entering this middleware. Production never sets
// MARKETING_ORIGIN and never enters any branch here.
const marketingOrigin = process.env.MARKETING_ORIGIN;
const PROBE_HEADER = "x-asset-probe";

export async function middleware(request: NextRequest) {
  if (!marketingOrigin) return NextResponse.next();
  if (request.headers.get(PROBE_HEADER)) return NextResponse.next();
  const { pathname, search } = request.nextUrl;

  if (pathname.startsWith("/@") || pathname.startsWith("/%40")) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/_next/")) {
    const probe = await fetch(new URL(pathname + search, request.url), {
      method: "HEAD",
      headers: { [PROBE_HEADER]: "1" },
    }).catch(() => null);
    if (probe?.ok) return NextResponse.next();
    return NextResponse.rewrite(new URL(`${pathname}${search}`, marketingOrigin));
  }

  return NextResponse.rewrite(new URL(`${pathname}${search}`, marketingOrigin));
}

export const config = {
  matcher: ["/((?!favicon.ico).*)"],
};
