// FILE: SponsorRow.tsx
// Purpose: The one sponsor list row — avatar, name, quiet meta line — shared by
//          /sponsors and the preview strip on /sponsor.
// Layer: Presentational component
// Depends on: next/image, data/sponsors, lib/sponsors, design tokens in globals.css
//
// Why one row and not a set of tiles:
//   The wall used to render two different shapes (a bordered chip and a large
//   featured card), which turned a short list of names into a heavy grid of
//   boxes. A sponsor list reads better as a list — no card chrome, no borders,
//   just the avatar and the name, with hover as the only affordance. Tier
//   recognition is carried by ORDER and by the logo swap below, not by making
//   some names physically larger than others.

import Image from "next/image";
import type { Sponsor } from "@/data/sponsors";
import { sponsorLink, sponsorMetaLabel } from "@/lib/sponsors";

export function SponsorRow({ sponsor }: { sponsor: Sponsor }) {
  const meta = sponsorMetaLabel(sponsor);

  return (
    <a
      href={sponsorLink(sponsor)}
      target="_blank"
      rel="noopener noreferrer"
      // The negative inset lets the hover tint bleed past the text column so the
      // row reads as a list item rather than a re-introduced card.
      className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-[var(--mock-row)]"
    >
      {sponsor.logoUrl ? (
        // The $149+ tiers are sold on logo placement, so a sponsor who has sent
        // a logo gets it shown in place of the avatar — same row, same height.
        <Image
          src={sponsor.logoUrl}
          alt={`${sponsor.name} logo`}
          width={132}
          height={36}
          className="h-9 w-auto max-w-[132px] shrink-0 object-contain object-left"
        />
      ) : (
        <Image
          src={sponsor.avatarUrl}
          alt=""
          width={36}
          height={36}
          className="size-9 shrink-0 rounded-full object-cover ring-1 ring-[var(--divide)]"
        />
      )}

      <span className="min-w-0">
        <span className="block truncate text-[14px] leading-[1.35] font-medium text-[var(--text-primary)]">
          {sponsor.name}
        </span>
        {meta ? (
          <span className="block truncate text-[12px] leading-[1.35] text-[var(--text-tertiary)]">
            {meta}
          </span>
        ) : null}
      </span>
    </a>
  );
}
