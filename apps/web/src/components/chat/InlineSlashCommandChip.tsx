// FILE: InlineSlashCommandChip.tsx
// Purpose: Inline chip for app-level slash commands (`/goal`, `/automation`), so a
//          sent message echoes the exact token the composer showed while typing.
//          Mirrors InlineSkillChip, swapping the skill cube for the command glyph.
// Layer: Shared UI component
// Exports: InlineSlashCommandChip

import type { ComposerSlashCommand } from "~/composerSlashCommands";
import { MessageCircleIcon } from "~/lib/icons";
import { slashCommandIcon } from "~/lib/slashCommandIcons";
import {
  COMPOSER_INLINE_CHIP_INLINE_ICON_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  formatComposerSlashCommandChipLabel,
} from "../composerInlineChip";
import { InlineChipContent } from "../InlineChip";

export function InlineSlashCommandChip(props: { command: ComposerSlashCommand }) {
  const Icon = slashCommandIcon(props.command, MessageCircleIcon);
  return (
    <span className={COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME}>
      <InlineChipContent
        icon={<Icon aria-hidden="true" className={COMPOSER_INLINE_CHIP_INLINE_ICON_CLASS_NAME} />}
        label={formatComposerSlashCommandChipLabel(props.command)}
      />
    </span>
  );
}
