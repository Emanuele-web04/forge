// FILE: FeatureTourStep.tsx
// Purpose: "What Synara can do" tour built from TOUR_CARDS: a vertical list of topics on the
//          left, the selected topic's text on the right, with a docs link per topic and live
//          shortcut chips on the shortcuts topic.
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
    <dl className={cn("grid grid-cols-1 gap-x-10 gap-y-2.5 sm:grid-cols-2", props.className)}>
      {TOUR_SHORTCUT_COMMANDS.map((entry) => {
        const label = shortcutLabelForCommand(keybindings, entry.command);
        if (!label) return null;
        return (
          <div key={entry.command} className="flex items-center justify-between gap-3">
            <dt className="text-[length:var(--app-font-size-ui-lg,13px)] text-foreground/85">
              {entry.label}
            </dt>
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

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] gap-8">
      <div className="flex flex-col gap-0.5" role="tablist" aria-label="Synara capabilities">
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
                "flex h-[34px] items-center gap-2.5 rounded-lg px-2.5 text-start text-[length:var(--app-font-size-ui-lg,13px)] outline-none transition-colors motion-reduce:transition-none",
                "focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
                selected
                  ? "bg-foreground/4 text-foreground"
                  : "text-foreground/70 hover:bg-foreground/3 hover:text-foreground",
              )}
              onClick={() => setSelectedId(card.id)}
            >
              <Icon
                className={cn(
                  "size-[15px] shrink-0",
                  selected ? "text-foreground" : "text-muted-foreground/80",
                )}
                aria-hidden
              />
              <span className="truncate">{card.label}</span>
            </button>
          );
        })}
      </div>

      <div
        id="onboarding-tour-panel"
        role="tabpanel"
        aria-labelledby={`onboarding-tour-tab-${selectedCard.id}`}
        className="flex min-w-0 flex-col gap-3.5 pt-1.5"
      >
        <h3 className="text-base font-medium tracking-[-0.005em] text-foreground">
          {selectedCard.title}
        </h3>
        <p className="text-[length:var(--app-font-size-ui-lg,13px)] leading-relaxed text-muted-foreground">
          {selectedCard.description}
        </p>
        {selectedCard.id === "shortcuts" ? (
          <TourShortcutList className="mt-1 max-w-[440px]" />
        ) : (
          <ul className="mt-1 flex flex-col gap-2">
            {selectedCard.highlights.map((highlight) => (
              <li
                key={highlight}
                className="flex items-center gap-2.5 text-[length:var(--app-font-size-ui-lg,13px)] text-foreground/85"
              >
                <span aria-hidden className="size-1 shrink-0 rounded-full bg-foreground/40" />
                {highlight}
              </li>
            ))}
          </ul>
        )}
        <a
          href={selectedCard.docsHref}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 self-start text-[length:var(--app-font-size-ui,12px)] text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
        >
          Read the guide
          <ExternalLinkIcon className="size-3" aria-hidden />
        </a>
      </div>
    </div>
  );
}
