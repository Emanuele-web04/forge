// FILE: InlineMentionChip.tsx
// Purpose: Shared inline file/folder/plugin mention chip (icon + label) used by
//          the timeline user-message echo, the assistant markdown view, and
//          openable file links, so a referenced path reads identically to a
//          composer mention. Supports a static (span) and an interactive
//          (anchor) variant so the same UI can stay clickable. File-like chips
//          without an explicit handler become openable automatically when a
//          surface provides a workspace file opener (right-dock file pane).
// Layer: UI shared component
// Exports: InlineMentionChip

import { type MouseEvent, type ReactNode } from "react";
import type { ProviderMentionReference } from "@synara/contracts";
import { basenameOfPath, pathLooksLikeKnownFile } from "~/file-icons";
import { openWorkspaceFileReference, useWorkspaceFileOpener } from "~/lib/workspaceFileOpener";
import {
  COMPOSER_INLINE_MENTION_CHIP_CLASS_NAME,
  COMPOSER_INLINE_MENTION_CHIP_INTERACTIVE_CLASS_NAME,
} from "../composerInlineChip";
import { InlineChipContent } from "../InlineChip";
import { MentionChipIcon, type MentionChipKind } from "./MentionChipIcon";
import { resolveMentionChipKind } from "~/lib/composerMentions";

interface InlineMentionChipProps {
  path: string;
  theme: "light" | "dark";
  kind?: MentionChipKind;
  mentionReferences?: ReadonlyArray<ProviderMentionReference>;
  /** Defaults to the path basename (composer-style label). */
  label?: ReactNode;
  /** When set, the chip renders as an openable anchor instead of a static span. */
  href?: string;
  onActivate?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onContextMenu?: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** Warm-up hook fired on hover/focus so activating the chip feels instant. */
  onHoverPrefetch?: (() => void) | undefined;
}

export function InlineMentionChip(props: InlineMentionChipProps) {
  const opener = useWorkspaceFileOpener();
  const resolvedKind = resolveMentionChipKind(props.path, {
    ...(props.kind ? { kind: props.kind } : {}),
    ...(props.mentionReferences ? { mentionReferences: props.mentionReferences } : {}),
  });
  const label =
    props.label ?? (resolvedKind === "thread" ? props.path : basenameOfPath(props.path));
  const inner = (
    <InlineChipContent
      icon={
        <MentionChipIcon
          path={props.path}
          theme={props.theme}
          {...(props.kind ? { kind: props.kind } : {})}
          {...(props.mentionReferences ? { mentionReferences: props.mentionReferences } : {})}
        />
      }
      label={label}
    />
  );

  // A plain file chip (no explicit href/handler) still opens in the in-app
  // viewer when the hosting surface provides one, so every file reference in
  // the chat stays clickable. Plugin chips and non-file paths stay static.
  const contextOpenable =
    props.href === undefined &&
    props.onActivate === undefined &&
    opener !== null &&
    (props.kind === undefined || props.kind === "path") &&
    pathLooksLikeKnownFile(props.path);

  if (props.href !== undefined || props.onActivate || contextOpenable) {
    const href = props.href ?? (contextOpenable ? props.path : undefined);
    const handleActivate =
      props.onActivate ??
      (contextOpenable
        ? (event: MouseEvent<HTMLAnchorElement>) => {
            event.preventDefault();
            event.stopPropagation();
            openWorkspaceFileReference(opener, props.path);
          }
        : undefined);
    const handleHoverPrefetch =
      props.onHoverPrefetch ??
      (contextOpenable && opener?.prefetchFile
        ? () => opener.prefetchFile?.(props.path)
        : undefined);
    return (
      <a
        className={COMPOSER_INLINE_MENTION_CHIP_INTERACTIVE_CLASS_NAME}
        title={props.path}
        {...(href !== undefined ? { href } : {})}
        {...(handleActivate ? { onClick: handleActivate } : {})}
        {...(props.onContextMenu ? { onContextMenu: props.onContextMenu } : {})}
        {...(handleHoverPrefetch
          ? { onPointerEnter: handleHoverPrefetch, onFocus: handleHoverPrefetch }
          : {})}
      >
        {inner}
      </a>
    );
  }

  return (
    <span className={COMPOSER_INLINE_MENTION_CHIP_CLASS_NAME} title={props.path}>
      {inner}
    </span>
  );
}
