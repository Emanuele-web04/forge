// FILE: privacy/page.tsx
// Purpose: Full privacy page — the detailed, honest account of what Synara does
//          (and doesn't do) with your data. Linked from the homepage + footer.
// Layer: App Router page (static)
// Depends on: Navbar, SiteFooter, react-icons/lu
// Note: Claims verified against the synara codebase. Keep them in sync with the
//       app: local SQLite, direct-to-provider, no Synara account, explicit
//       feedback delivery, and anonymous analytics that are OFF by default.

import type { ReactNode } from "react";
import Link from "next/link";
import { LuCheck, LuX, LuArrowDownToLine } from "react-icons/lu";
import Navbar from "@/components/Navbar";
import SiteFooter from "@/components/SiteFooter";
import { SITE_URL, breadcrumbJsonLd, jsonLdScript, pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Privacy — Synara",
  description:
    "Synara's security and privacy boundary: local-first storage, direct-to-provider connections, no account, and anonymous analytics that are off by default.",
  path: "/privacy",
});

const LAST_UPDATED = "July 15, 2026";

const RECEIVED_IF_OPTED_IN = [
  "An event name (e.g. “app launched”, “provider connected”)",
  "An anonymous id (a random per-install id, or a one-way hash of your provider account id)",
  "Your OS, CPU architecture, and Synara version",
  "Whether you're on the desktop app or the web/CLI client",
];

const NEVER_COLLECTED = [
  "Your prompts, messages, or chat history",
  "Your code, files, diffs, or repository contents",
  "Your API keys, tokens, or provider credentials",
  "Your name, email, or IP-based location profile",
];

const PRIVACY_JSONLD = [
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${SITE_URL}/privacy#webpage`,
    name: "Synara privacy",
    url: `${SITE_URL}/privacy`,
    dateModified: "2026-07-15",
    description:
      "Synara security and privacy details covering local-first storage, direct-to-provider connections, no Synara account, and opt-in anonymous analytics.",
  },
  breadcrumbJsonLd([
    { name: "Synara", path: "/" },
    { name: "Privacy", path: "/privacy" },
  ]),
];

export default function PrivacyPage() {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--page-bg)] text-[var(--text-primary)]">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(PRIVACY_JSONLD) }}
      />
      <Navbar />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-10 pb-20 sm:px-6 sm:pt-14">
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
          Privacy
        </p>
        <h1 className="mt-3 text-[1.75rem] font-medium leading-[1.1] tracking-[-0.035em] sm:text-[2.25rem]">
          Private by default. Clear by design.
        </h1>
        <p className="mt-5 text-[14px] leading-[1.7] text-[var(--text-secondary)] sm:text-[15px]">
          Synara is a desktop app that runs on your machine and connects straight to the providers
          you already use. There&apos;s no Synara account, no Synara server holding your work, and
          your code or prompts are not sent to us during normal use. The only exception is feedback
          you explicitly write and submit through the Feedback Synara dialog, together with the
          limited diagnostics described below. This page spells out exactly what that means — in
          plain language, no &quot;just read the source&quot; required (though you can, it&apos;s
          open source).
        </p>

        <Section title="Where your data lives">
          <p>
            Your chats, projects, settings, and history are stored in a local database (SQLite) on
            your own device. Synara runs a small server process <em>locally</em> on your machine to
            power the app — it is not a hosted cloud service, and your data never leaves your
            computer just by using Synara.
          </p>
        </Section>

        <Section title="Where your prompts and code go">
          <p>
            When you chat with a model, Synara connects <strong>directly</strong> to the provider
            you chose — Claude, Codex, OpenCode, Cursor, Antigravity, Grok, Droid, and so on — using
            your own existing logins. Your prompts and code go only to that provider, governed by{" "}
            <em>their</em> privacy terms. Synara does not proxy, copy, or store that traffic on any
            server of ours.
          </p>
        </Section>

        <Section title="No account, no lock-in">
          <p>
            There&apos;s nothing to sign up for and no Synara login. Want to open Synara from your
            phone or another laptop? That&apos;s self-hosted: you expose <em>your</em> machine over
            your own network (LAN or Tailscale), protected by an auth token you generate and
            control. Nothing routes through us.
          </p>
        </Section>

        <Section title="Anonymous analytics — off by default">
          <p>
            Synara can send <strong>anonymous, aggregate usage analytics</strong> (via PostHog) to
            help us understand which features matter and where things break. This is{" "}
            <strong>off by default</strong> — it never runs unless you explicitly opt in.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <DataCard
              tone="receive"
              title="If you opt in, we receive"
              items={RECEIVED_IF_OPTED_IN}
            />
            <DataCard tone="never" title="Analytics never receives" items={NEVER_COLLECTED} />
          </div>

          <p className="mt-6">
            Analytics events carry no &quot;person profile&quot; and aren&apos;t tied to your
            identity. You can keep them disabled (the default) or, if you&apos;d like to help, turn
            them on by setting{" "}
            <code className="rounded bg-[var(--block-elevated)] px-1.5 py-0.5 font-mono text-[12px]">
              SYNARA_TELEMETRY_ENABLED=true
            </code>
            . An in-app <span className="text-[var(--text-primary)]">Settings → Privacy</span>{" "}
            toggle is on the way.
          </p>
        </Section>

        <Section title="Feedback you choose to send">
          <p>
            The in-app <strong>Feedback Synara</strong> dialog sends only when you press Submit. It
            includes the text you wrote, app version, operating system, provider and model, runtime
            modes, and session/turn status so we can understand the conditions around a problem.
          </p>
          <p>
            Automated diagnostics do not include chat messages, prompts, project paths, repository
            contents, session logs, or screenshots. Reports are delivered through our website and
            email provider to the Synara maintainer for support and product improvement, rather than
            being added to an analytics profile.
          </p>
        </Section>

        <Section title="Open source">
          <p>
            Synara is open source under the MIT license. If a sentence on this page isn&apos;t
            enough, you can verify every claim yourself —{" "}
            <a
              href="https://github.com/Emanuele-web04/synara"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent-link)] transition-colors hover:text-[var(--accent-link-hover)]"
            >
              read the code on GitHub
            </a>
            .
          </p>
        </Section>

        <Section title="About this website">
          <p>
            This marketing site (the page you&apos;re reading) uses privacy- friendly{" "}
            <a
              href="https://developers.cloudflare.com/web-analytics/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent-link)] transition-colors hover:text-[var(--accent-link-hover)]"
            >
              Cloudflare Web Analytics
            </a>{" "}
            for anonymous, aggregate visit counts. No cookies, no cross-site tracking, no selling of
            data.
          </p>
        </Section>

        <div className="mt-12 flex flex-col gap-4 border-t border-[var(--divide)] pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] text-[var(--text-tertiary)]">
            Last updated {LAST_UPDATED}. Questions?{" "}
            <a
              href="https://x.com/emanueledpt"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent-link)] transition-colors hover:text-[var(--accent-link-hover)]"
            >
              Reach out on X
            </a>
            .
          </p>
          <Link
            href="/install"
            className="inline-flex w-fit items-center gap-2 rounded-full bg-[var(--btn-primary-bg)] px-5 py-2.5 text-[13px] font-medium text-[var(--btn-primary-fg)] transition-opacity hover:opacity-90"
          >
            Download Synara
            <LuArrowDownToLine className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10 border-t border-[var(--divide)] pt-8">
      <h2 className="text-[1.05rem] font-medium tracking-[-0.02em] text-[var(--text-primary)]">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[14px] leading-[1.7] text-[var(--text-secondary)] [&_strong]:font-medium [&_strong]:text-[var(--text-primary)]">
        {children}
      </div>
    </section>
  );
}

function DataCard({
  tone,
  title,
  items,
}: {
  tone: "receive" | "never";
  title: string;
  items: string[];
}) {
  const isNever = tone === "never";
  return (
    <div className="rounded-2xl border border-[var(--divide)] bg-[var(--block-elevated)] p-5">
      <h3 className="text-[13px] font-medium text-[var(--text-primary)]">{title}</h3>
      <ul className="mt-3 space-y-2.5">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2.5 text-[13px] leading-snug">
            <span
              className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full ${
                isNever
                  ? "bg-[color-mix(in_oklab,var(--text-primary)_10%,transparent)] text-[var(--text-tertiary)]"
                  : "bg-[color-mix(in_oklab,var(--accent-link)_18%,transparent)] text-[var(--accent-link)]"
              }`}
            >
              {isNever ? (
                <LuX className="size-3" aria-hidden="true" />
              ) : (
                <LuCheck className="size-3" aria-hidden="true" />
              )}
            </span>
            <span className="text-[var(--text-secondary)]">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
