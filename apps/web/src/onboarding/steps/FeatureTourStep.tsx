// FILE: FeatureTourStep.tsx
// Purpose: Tabbed "what Synara can do" tour built from TOUR_CARDS, with a docs link per card
//          and live shortcut chips on the shortcuts card.
// Layer: Web UI component

import type { ResolvedKeybindingsConfig } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ShortcutKbd } from "~/components/ui/shortcut-kbd";
import { shortcutLabelForCommand } from "~/keybindings";
import { ExternalLinkIcon } from "~/lib/icons";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { TOUR_CARDS, TOUR_SHORTCUT_COMMANDS } from "../tourContent";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

export function TourShortcutList(props: { className?: string }) {
  const keybindingsQuery = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const keybindings = keybindingsQuery.data ?? EMPTY_KEYBINDINGS;
  return (
    <dl className={cn("grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2", props.className)}>
      {TOUR_SHORTCUT_COMMANDS.map((entry) => {
        const label = shortcutLabelForCommand(keybindings, entry.command);
        if (!label) return null;
        return (
          <div key={entry.command} className="flex items-center justify-between gap-3">
            <dt className="text-sm text-muted-foreground">{entry.label}</dt>
            <dd>
              <ShortcutKbd shortcutLabel={label} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function FeatureTourStep() {
  const [selectedId, setSelectedId] = useState<string>(TOUR_CARDS[0]?.id ?? "");
  const selectedCard = TOUR_CARDS.find((card) => card.id === selectedId) ?? TOUR_CARDS[0];
  if (!selectedCard) return null;
  const SelectedIcon = selectedCard.icon;

  return (
    <section aria-labelledby="onboarding-tour-title" className="space-y-3">
      <p id="onboarding-tour-title" className="sr-only">
        Synara capabilities
      </p>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Synara capabilities">
        {TOUR_CARDS.map((card) => {
          const Icon = card.icon;
          const selected = card.id === selectedCard.id;
          return (
            <button
              key={card.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="onboarding-tour-panel"
              id={`onboarding-tour-tab-${card.id}`}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs outline-none transition-colors motion-reduce:transition-none",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
                selected
                  ? "border-foreground/20 bg-foreground/[0.07] text-foreground"
                  : "border-border/70 bg-muted/15 text-muted-foreground hover:border-border hover:bg-muted/40 hover:text-foreground",
              )}
              onClick={() => setSelectedId(card.id)}
            >
              <Icon className="size-3.5" aria-hidden />
              <span className="font-medium">{card.label}</span>
            </button>
          );
        })}
      </div>

      <div
        id="onboarding-tour-panel"
        role="tabpanel"
        aria-labelledby={`onboarding-tour-tab-${selectedCard.id}`}
        className="min-h-56 rounded-2xl border border-border/70 bg-muted/20 p-4"
      >
        <div className="flex gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-background">
            <SelectedIcon className="size-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-sm font-semibold text-foreground">{selectedCard.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {selectedCard.description}
            </p>
          </div>
        </div>
        {selectedCard.id === "shortcuts" ? (
          <TourShortcutList className="mt-4 pl-12" />
        ) : (
          <div className="mt-4 flex flex-wrap gap-1.5 pl-12">
            {selectedCard.highlights.map((highlight) => (
              <span
                key={highlight}
                className="rounded-full border border-border/70 bg-background/50 px-2.5 py-1 text-[11px] text-foreground/80"
              >
                {highlight}
              </span>
            ))}
          </div>
        )}
        <a
          href={selectedCard.docsHref}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center gap-1 pl-12 text-xs text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
        >
          Read the guide
          <ExternalLinkIcon className="size-3" aria-hidden />
        </a>
      </div>
    </section>
  );
}
