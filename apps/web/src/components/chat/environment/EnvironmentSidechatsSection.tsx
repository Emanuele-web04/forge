import type { ThreadId } from "@synara/contracts";

import { IconButton } from "~/components/ui/icon-button";
import { ChatBubbleIcon, PlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import {
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRow,
  EnvironmentSectionDivider,
  EnvironmentSectionLabel,
} from "./EnvironmentRow";

export interface EnvironmentSidechatPanelItem {
  readonly id: ThreadId;
  readonly title: string;
  readonly expiredAt: string | null;
}

export function EnvironmentSidechatsSection({
  sidechats,
  onCreate,
  onOpen,
}: {
  readonly sidechats: readonly EnvironmentSidechatPanelItem[];
  readonly onCreate: () => void;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  return (
    <>
      <EnvironmentSectionDivider />
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between gap-2 pr-2">
          <EnvironmentSectionLabel>Side chats</EnvironmentSectionLabel>
          <IconButton label="Start side chat" tooltip="Start side chat" onClick={onCreate}>
            <PlusIcon className="size-3.5" />
          </IconButton>
        </div>
        {sidechats.map((sidechat) => {
          const expired = sidechat.expiredAt !== null;
          return (
            <EnvironmentRow
              key={sidechat.id}
              icon={<ChatBubbleIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
              label={<span className="truncate">{sidechat.title}</span>}
              trailing={
                expired ? (
                  <span className="text-[var(--color-text-foreground-secondary)]">Expired</span>
                ) : null
              }
              className={cn(expired && "opacity-60")}
              aria-label={`Open side chat ${sidechat.title}${expired ? " (expired)" : ""}`}
              onClick={() => onOpen(sidechat.id)}
            />
          );
        })}
      </div>
    </>
  );
}
