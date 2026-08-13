// FILE: layout.tsx
// Purpose: Root document shell with global fonts, metadata, analytics, and JSON-LD.
// Layer: App Router layout.

import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeScript } from "@/components/ThemeScript";
import { Analytics } from "@vercel/analytics/next";
import { RootProvider } from "fumadocs-ui/provider/next";
import {
  SITE_URL,
  SITE_NAME,
  SITE_TITLE,
  SITE_DESCRIPTION,
  OG_IMAGE,
  SITE_JSONLD,
  SITE_IMAGES,
  SEO_KEYWORDS,
  CREATOR_NAME,
  CREATOR_URL,
  jsonLdScript,
} from "@/lib/seo";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: SITE_NAME,
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  keywords: SEO_KEYWORDS,
  authors: [{ name: CREATOR_NAME, url: CREATOR_URL }],
  creator: CREATOR_NAME,
  publisher: SITE_NAME,
  category: "technology",
  classification: "Developer tools, agentic development, productivity software",
  referrer: "origin-when-cross-origin",
  manifest: "/manifest.webmanifest",
  alternates: { canonical: "/" },
  icons: {
    icon: [
      { url: "/icon.png", type: "image/png" },
      { url: SITE_IMAGES.icon, type: "image/png", sizes: "2048x2048" },
    ],
    apple: [{ url: "/apple-icon.png", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: SITE_NAME,
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    url: "/",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    creator: "@emanueledpt",
    images: [OG_IMAGE],
  },
};

// Vercel Web Analytics only reports from a Vercel deployment, so the gate is
// still `VERCEL` rather than "any production": on Workers the script would
// load and silently collect nothing. Swapping to Cloudflare Web Analytics is a
// separate decision (it changes what /privacy documents), so this stays as-is
// and simply stays off on the Workers preview.
const analyticsEnabled = Boolean(process.env.VERCEL) && process.env.VISUAL_TEST !== "1";

export const viewport: Viewport = {
  themeColor: "#111111",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <ThemeScript />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdScript(SITE_JSONLD) }}
        />
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
        {analyticsEnabled ? <Analytics /> : null}
      </body>
    </html>
  );
}
