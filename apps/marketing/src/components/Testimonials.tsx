// FILE: Testimonials.tsx
// Purpose: Curated public posts from people using Synara.
// Layer: Marketing UI section (server component)

import { SiX } from "react-icons/si";
import { FiHeart, FiGlobe } from "react-icons/fi";
import { loadTestimonialCards, type TestimonialCard } from "@/lib/tweets";

const EXCLUDED_TESTIMONIAL_IDS = new Set([
  // Frames the product defensively around an earlier fork identity instead of
  // describing a durable user outcome.
  "2071916101924262377",
  // Compares short-lived model/version labels. The underlying experience may
  // be valid, but the homepage should not age with provider release names.
  "2065178684537888877",
]);

const LANGUAGE_NAMES: Record<string, string> = {
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  it: "Italian",
  ru: "Russian",
  ar: "Arabic",
  hi: "Hindi",
  tr: "Turkish",
};

function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

function renderTweetText(text: string) {
  const cleaned = text
    .replace(/https?:\/\/t\.co\/\S+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned.split(/(@\w{1,15})/g).map((part, index) =>
    /^@\w{1,15}$/.test(part) ? (
      <span key={index} className="text-[var(--accent-link)]">
        {part}
      </span>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

function VerifiedBadge() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-label="Verified account"
      className="size-[15px] shrink-0 text-[#1d9bf0]"
      fill="currentColor"
    >
      <path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z" />
    </svg>
  );
}

function TestimonialCardItem({ card }: { card: TestimonialCard }) {
  const initial = (card.name || card.handle).charAt(0).toUpperCase();
  const showTranslation = Boolean(card.translation && card.translationLang);
  const bodyText = showTranslation ? card.translation! : card.text;
  const showLikes = card.likes != null && card.likes > 0;

  return (
    <a
      href={card.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group mb-4 block break-inside-avoid rounded-2xl border border-[var(--divide)] bg-[var(--block-elevated)] p-5 transition duration-300 ease-out hover:-translate-y-0.5 hover:border-[var(--border-strong)] hover:shadow-[0_8px_30px_-12px_rgba(0,0,0,0.25)] motion-reduce:transition-none motion-reduce:hover:translate-y-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
    >
      <header className="flex items-center gap-3">
        {card.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.avatarUrl}
            alt={`${card.name} avatar`}
            width={36}
            height={36}
            loading="lazy"
            className="size-9 shrink-0 rounded-full object-cover ring-1 ring-black/5 dark:ring-white/10"
          />
        ) : (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--mock-row-strong)] text-[13px] font-medium text-[var(--text-secondary)]">
            {initial}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
              {card.name}
            </span>
            {card.verified && <VerifiedBadge />}
          </div>
          <span className="block truncate text-[12px] text-[var(--text-tertiary)]">
            @{card.handle}
          </span>
        </div>

        <SiX
          className="size-[15px] shrink-0 text-[var(--text-tertiary)] transition-colors duration-300 group-hover:text-[var(--text-primary)]"
          aria-hidden="true"
        />
      </header>

      <p className="mt-3.5 whitespace-pre-line text-[13.5px] leading-[1.6] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">
        {renderTweetText(bodyText)}
      </p>

      {card.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={card.image.src}
          alt={card.image.alt}
          width={1200}
          height={675}
          loading="lazy"
          className="mt-3.5 aspect-video max-h-72 w-full rounded-xl border border-[var(--divide)] object-cover"
        />
      )}

      {(showLikes || showTranslation) && (
        <div className="mt-4 flex items-center gap-3.5 text-[12px] text-[var(--text-tertiary)]">
          {showLikes && (
            <span className="inline-flex items-center gap-1.5">
              <FiHeart className="size-3.5" aria-hidden="true" />
              {card.likes!.toLocaleString()}
            </span>
          )}
          {showTranslation && (
            <span className="inline-flex items-center gap-1.5">
              <FiGlobe className="size-3.5" aria-hidden="true" />
              Translated from {languageName(card.translationLang!)}
            </span>
          )}
        </div>
      )}
    </a>
  );
}

export default async function Testimonials() {
  const cards = (await loadTestimonialCards()).filter(
    (card) => !EXCLUDED_TESTIMONIAL_IDS.has(card.id),
  );
  if (cards.length === 0) return null;

  return (
    <section id="testimonials" className="border-t border-[var(--divide)] py-14 sm:py-20">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
            From developers
          </p>
          <h2 className="mt-3 text-[1.65rem] font-medium leading-[1.12] tracking-[-0.035em] text-[var(--text-primary)] sm:text-[2rem]">
            What people notice when they use Synara.
          </h2>
          <p className="mt-5 text-[15px] leading-[1.7] text-[var(--text-secondary)] sm:text-[16px]">
            Public posts about the workspace, provider choice, local server, design, and day-to-day
            development experience.
          </p>
        </div>

        <div className="mt-10 columns-1 gap-4 sm:mt-14 sm:columns-2 lg:columns-3">
          {cards.map((card) => (
            <TestimonialCardItem key={card.id} card={card} />
          ))}
        </div>
      </div>
    </section>
  );
}
