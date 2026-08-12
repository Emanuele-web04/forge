import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Single-domain dev deployment (synara.vrbty.dev): this app owns the domain,
// so anything that is not a profile path proxies to the marketing site.
// This app's own /_next assets never reach the middleware — Vercel's CDN
// serves the deployment's static files first — so the marketing site's
// (differently-hashed) /_next paths are the only ones that fall through and
// get proxied. Production (trysynara.com) never sets MARKETING_ORIGIN and
// never enters this branch — there, the marketing project owns the domain
// and rewrites /@:handle in.
const marketingOrigin = process.env.MARKETING_ORIGIN;

export function middleware(request: NextRequest) {
  if (!marketingOrigin) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  // Profile pages stay here (the raw and URL-encoded @ spellings).
  if (pathname.startsWith("/@") || pathname.startsWith("/%40")) {
    return NextResponse.next();
  }
  return NextResponse.rewrite(new URL(`${pathname}${search}`, marketingOrigin));
}

export const config = {
  matcher: ["/((?!favicon.ico).*)"],
};
