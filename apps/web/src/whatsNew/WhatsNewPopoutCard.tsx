// FILE: whatsNew/WhatsNewPopoutCard.tsx
// Purpose: Post-update "popout" card that lives in the bottom-left corner of
// the app after an upgrade. Clicking the card body opens the release-notes
// dialog; clicking the ✕ dismisses the update silently. Matches the
// IndieDevs `UpdateCard` pattern but themed for our dark-first surface.
// Layer: overlay — rendered once from the root route next to the dialog.

import { useEffect, useState, type KeyboardEvent } from "react";

import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SynaraLogo } from "~/components/SynaraLogo";

import type { WhatsNewEntry } from "./logic";

// The card anchors bottom-left over the thread sidebar, so it must fit inside
// the sidebar's live width (user-resizable via --sidebar-width) rather than
// assume a fixed size. We observe the sidebar-gap element because its width is
// the sidebar's real layout width and animates to 0/icon-width on collapse,
// which a ResizeObserver catches — the fixed container only translates.
const LEFT_SIDEBAR_GAP_SELECTOR =
  "[data-slot='sidebar'][data-side='left'] [data-slot='sidebar-gap']";
const CARD_EDGE_INSET_PX = 12; // matches the card's `left-3`; mirrored on the right
const CARD_MIN_WIDTH_PX = 176; // floor for readability (min sidebar is 13rem)
const CARD_MAX_WIDTH_PX = 288; // cap so a very wide sidebar doesn't grow a billboard
const CARD_FALLBACK_WIDTH_PX = 256; // no expanded left sidebar to fit (mobile, collapsed)

function useSidebarFittedWidth(): number {
  const [width, setWidth] = useState(CARD_FALLBACK_WIDTH_PX);

  useEffect(() => {
    const gap = document.querySelector<HTMLElement>(LEFT_SIDEBAR_GAP_SELECTOR);
    if (!gap) {
      return;
    }
    const update = () => {
      const sidebarWidth = gap.getBoundingClientRect().width;
      const fitted = sidebarWidth - CARD_EDGE_INSET_PX * 2;
      setWidth(
        fitted >= CARD_MIN_WIDTH_PX ? Math.min(fitted, CARD_MAX_WIDTH_PX) : CARD_FALLBACK_WIDTH_PX,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(gap);
    return () => observer.disconnect();
  }, []);

  return width;
}

export interface WhatsNewPopoutCardProps {
  readonly entry: WhatsNewEntry;
  readonly currentVersion: string;
  readonly onOpen: () => void;
  readonly onDismiss: () => void;
  readonly className?: string;
}

/**
 * A small attention-grabber card. Clicking the body acts as a "open release
 * notes" affordance; the ✕ in the corner is a deliberate "not interested" —
 * both paths mark the release as seen, so the card never nags twice.
 *
 * The card is keyboard-reachable (tab-stop with Enter/Space activating) to
 * match the mouse affordance, since base-ui's Dialog otherwise owns the only
 * trigger in the IndieDevs implementation (their `<DialogTrigger>` wraps the
 * whole card).
 */
export function WhatsNewPopoutCard({
  entry,
  currentVersion,
  onOpen,
  onDismiss,
  className,
}: WhatsNewPopoutCardProps) {
  const cardWidth = useSidebarFittedWidth();
  const heroAlt = entry.heroImageAlt ?? `What's new in v${currentVersion}`;
  const primaryFeature = entry.features[0];
  const primaryFeatureTitle = primaryFeature?.title;
  const primaryFeatureDescription = primaryFeature?.description;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <div
      className={cn(
        "fixed bottom-3 left-3 z-50 max-w-[calc(100vw-1.5rem)] select-none",
        "animate-[popout-in_200ms_ease-out]",
        className,
      )}
      style={{
        width: cardWidth,
        // Inline @keyframes so the popout doesn't need a tailwind plugin or
        // global stylesheet just for one 200ms fade-in.
        animationName: "whats-new-popout-in",
      }}
    >
      <style>{`@keyframes whats-new-popout-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}`}</style>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open What's new in v${currentVersion}`}
        onClick={onOpen}
        onKeyDown={onKeyDown}
        className={cn(
          "group relative flex cursor-pointer flex-col overflow-hidden rounded-xl",
          "border border-white/[0.08] bg-popover text-popover-foreground shadow-xl",
          "transition-[transform,box-shadow,border-color] duration-150",
          "hover:border-primary/40 hover:shadow-2xl hover:[transform:translateY(-1px)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        )}
      >
        {/* Close button. `stopPropagation` so dismissing doesn't also fire
            the card's onOpen handler. */}
        <button
          type="button"
          aria-label="Dismiss What's new"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
          className={cn(
            "absolute end-2.5 top-2.5 z-10 inline-flex size-7 items-center justify-center rounded-full",
            "text-muted-foreground/80 transition-colors",
            "hover:bg-[var(--sidebar-accent)] hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          )}
        >
          <XIcon className="size-3.5" />
        </button>

        {/* Hero band: screenshot when the entry supplies one, otherwise a
            branded gradient + icon so every release still gets a polished
            visual. */}
        <div className="relative h-24 w-full overflow-hidden">
          {entry.heroImage !== undefined ? (
            <img
              src={entry.heroImage}
              alt={heroAlt}
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex h-full w-full items-center justify-center bg-[radial-gradient(120%_140%_at_10%_0%,color-mix(in_srgb,var(--color-primary)_38%,transparent)_0%,transparent_60%),radial-gradient(100%_120%_at_100%_100%,color-mix(in_srgb,var(--color-primary)_22%,transparent)_0%,transparent_70%)]"
            >
              <SynaraLogo aria-hidden className="size-9 text-foreground" />
            </div>
          )}
          {/* Subtle bottom gradient so text below the band always reads. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-popover"
          />
        </div>

        <div className="flex flex-col px-4 pb-4 pt-2.5">
          <p className="text-xs font-medium text-primary">New · v{currentVersion}</p>
          <p className="mt-1 line-clamp-2 text-sm font-semibold leading-snug text-foreground">
            {primaryFeatureTitle ?? `What's new in v${currentVersion}`}
          </p>
          {primaryFeatureDescription !== undefined && (
            <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground/90">
              {primaryFeatureDescription}
            </p>
          )}
          <p className="mt-2.5 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
            Find out what&rsquo;s new <span aria-hidden="true">→</span>
          </p>
        </div>
      </div>
    </div>
  );
}
