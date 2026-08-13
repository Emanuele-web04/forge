// FILE: DownloadButton.tsx
// Purpose: OS-aware hero CTA that routes to the installer page.
// Layer: Client component

"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { LuArrowDownToLine } from "react-icons/lu";
import { detectOS, type OS } from "@/lib/platform";

const LABEL: Record<OS, string> = {
  mac: "Download for macOS",
  windows: "Download for Windows",
  linux: "Download for Linux",
  unknown: "Download Synara",
};

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: { platform?: string };
};

type DownloadButtonProps = {
  className?: string;
};

export default function DownloadButton({ className = "" }: DownloadButtonProps) {
  const label = useSyncExternalStore(
    () => () => undefined,
    () => {
      const nav = navigator as NavigatorWithUserAgentData;
      return LABEL[
        detectOS(navigator.userAgent, nav.userAgentData?.platform ?? navigator.platform)
      ];
    },
    () => LABEL.unknown,
  );

  return (
    <Link
      href="/install"
      className={`inline-flex min-w-[10.5rem] items-center justify-center gap-2 rounded-full bg-[var(--btn-primary-bg)] px-5 py-2.5 text-[13px] font-medium text-[var(--btn-primary-fg)] transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)] ${className}`}
    >
      <span className="whitespace-nowrap">{label}</span>
      <LuArrowDownToLine className="size-4 shrink-0" aria-hidden="true" />
    </Link>
  );
}
