import { useRef, type RefObject } from "react";
import { CheckIcon, CopyIcon } from "~/lib/icons";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { anchoredToastManager } from "../ui/toast";
import { MessageActionButton, MESSAGE_ACTION_ICON_CLASS_NAME } from "./MessageActionButton";

const ANCHORED_TOAST_TIMEOUT_MS = 1000;

function showCopyToast(
  ref: RefObject<HTMLButtonElement | null>,
  title: string,
  description?: string,
): void {
  if (!ref.current) return;

  anchoredToastManager.add({
    data: {
      tooltipStyle: true,
    },
    positionerProps: {
      anchor: ref.current,
    },
    timeout: ANCHORED_TOAST_TIMEOUT_MS,
    title,
    ...(description ? { description } : {}),
  });
}

export function MessageCopyButton({
  text,
  className,
  label = "Copy message",
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showCopyToast(ref, "Copied!"),
    onError: (error: Error) => showCopyToast(ref, "Failed to copy", error.message),
    timeout: ANCHORED_TOAST_TIMEOUT_MS,
  });

  return (
    <MessageActionButton
      ref={ref}
      label={label}
      tooltip="Copy to clipboard"
      disabled={isCopied}
      className={className}
      onClick={() => copyToClipboard(text)}
    >
      {isCopied ? (
        <CheckIcon className={`${MESSAGE_ACTION_ICON_CLASS_NAME} text-success`} />
      ) : (
        <CopyIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
      )}
    </MessageActionButton>
  );
}
