import Image from "next/image";
import Link from "next/link";
import { FaGithub } from "react-icons/fa";
import { formatStars, getStars } from "@/lib/githubStars";
import { GITHUB_REPO_URL } from "@/lib/seo";
import { ThemeToggle } from "@/components/ThemeToggle";
import MobileNav from "@/components/MobileNav";

export default async function Navbar() {
  const stars = await getStars();
  return (
    <nav aria-label="Primary navigation" className="relative w-full px-4 py-4 sm:px-6">
      <div className="mx-auto flex h-9 max-w-6xl items-center justify-between gap-2 sm:gap-6">
        <Link
          href="/"
          aria-label="Synara home"
          className="flex shrink-0 items-center gap-2 text-[14px] font-medium tracking-[-0.02em] text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
        >
          <Image
            src="/synara-icon.png"
            alt=""
            width={22}
            height={22}
            className="rounded-[5px] border border-[var(--divide)]"
          />
          <span className="hidden sm:inline">Synara</span>
        </Link>

        {/*
          Middle nav: mobile prioritizes Docs + Changelog alongside the primary
          actions. X and Install are revealed at sm+.
        */}
        <div className="hidden min-w-0 flex-1 items-center justify-center gap-3 text-[13px] text-[var(--text-tertiary)] sm:flex sm:gap-6">
          <a
            href="https://x.com/trySynara"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden shrink-0 transition-colors hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)] sm:inline"
          >
            X
          </a>
          <Link
            href="/install"
            className="hidden shrink-0 transition-colors hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)] sm:inline"
          >
            Install
          </Link>
          <Link
            href="/docs"
            className="shrink-0 transition-colors hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
          >
            Docs
          </Link>
          <Link
            href="/changelog"
            className="shrink-0 transition-colors hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
          >
            Changelog
          </Link>
          <Link
            href="/sponsor"
            className="hidden shrink-0 transition-colors hover:text-[var(--text-primary)] sm:inline"
          >
            Sponsor
          </Link>
        </div>

        <div className="hidden shrink-0 items-center gap-1.5 sm:flex sm:gap-3">
          <ThemeToggle />
          {stars !== null ? (
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`GitHub stars: ${formatStars(stars)}`}
              className="flex items-center gap-1 text-[12.5px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)] sm:gap-1.5 sm:text-[13px]"
            >
              <FaGithub className="size-4 text-[var(--text-primary)]" />
              {formatStars(stars)}
            </a>
          ) : null}
          <Link
            href="/install"
            className="rounded-full border border-[var(--divide)] px-3 py-1 text-[12.5px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--mock-row)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)] sm:px-3.5 sm:text-[13px]"
          >
            Download
          </Link>
        </div>
        <MobileNav />
      </div>
    </nav>
  );
}
