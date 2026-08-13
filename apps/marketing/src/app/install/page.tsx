// FILE: install/page.tsx
// Purpose: Dedicated download page for macOS, Windows, and Linux installers.
// Layer: App Router page

import Navbar from "@/components/Navbar";
import SiteFooter from "@/components/SiteFooter";
import InstallOptions from "@/components/InstallOptions";
import { PRODUCT_CATEGORY } from "@/data/product";
import { getReleaseDownloads } from "@/lib/releases";
import { getStoredInstallerCount } from "@/lib/installerCount";
import { INSTALL_JSONLD, breadcrumbJsonLd, jsonLdScript, pageMetadata } from "@/lib/seo";

const INSTALL_PAGE_JSONLD = [
  INSTALL_JSONLD,
  breadcrumbJsonLd([
    { name: "Synara", path: "/" },
    { name: "Download", path: "/install" },
  ]),
];

export const metadata = pageMetadata({
  title: "Download Synara — Coding Agent Workspace",
  description: `Download Synara for macOS, Windows, and Linux. ${PRODUCT_CATEGORY}`,
  path: "/install",
});

// Release artifacts change rarely; rebuild this route at most every 30 minutes.
export const revalidate = 1800;

export default async function InstallPage() {
  const [downloads, installerCount] = [await getReleaseDownloads(), getStoredInstallerCount()];

  return (
    <div className="flex min-h-screen flex-col bg-[var(--page-bg)] text-[var(--text-primary)]">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(INSTALL_PAGE_JSONLD) }}
      />
      <Navbar />

      <main id="main-content">
        <section aria-labelledby="install-heading" className="pt-10 pb-16 sm:pt-16 sm:pb-24">
          <div className="mx-auto w-full max-w-4xl px-4 text-center sm:px-6">
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
              {PRODUCT_CATEGORY}
            </p>
            <h1
              id="install-heading"
              className="mt-4 text-[2rem] font-medium leading-[1.08] tracking-[-0.04em] text-[var(--text-primary)] sm:text-[3rem]"
            >
              Download Synara
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-[14px] leading-[1.7] text-[var(--text-secondary)] sm:text-[16px]">
              Install the desktop app, connect a coding-agent runtime already authenticated on your
              machine, and start with one repository and one bounded task.
            </p>

            <div className="mt-12">
              <InstallOptions downloads={downloads} installerCount={installerCount} />
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
