// FILE: ShareDialog.tsx
// Purpose: "Share your activity" dialog — previews the virality card and exports it to
// PNG fully on-device, then copies to clipboard + opens a social composer, or saves the
// file. Mirrors the reference share sheet (Copy / X / LinkedIn / Reddit / Save).
// Layer: web profile feature.

import { type ReactNode, useEffect, useRef, useState } from "react";
import { SiReddit, SiX } from "react-icons/si";
import { FaLinkedinIn } from "react-icons/fa6";
import type { AccountProfile } from "@synara/contracts";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { CopyIcon, DownloadIcon, LinkIcon } from "~/lib/icons";
import { profileShareUrl, publicProfileDisplayUrl } from "~/lib/accountLogic";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { localDayKey } from "~/lib/accountUsageAdapter";
import { cn } from "~/lib/utils";
import type { ShareCardStats } from "./profileSelectors";
import { SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH, ShareCard } from "./ShareCard";
import {
  copyImageToClipboard,
  downloadBlob,
  openExternalUrl,
  renderNodeToPngBlob,
  type ShareTarget,
  shareIntentUrl,
  shareLinkUrl,
} from "./shareCardExport";

const PREVIEW_WIDTH = 480;
const CARD_EXPORT_SIZE = { width: SHARE_CARD_WIDTH, height: SHARE_CARD_HEIGHT } as const;
type CopyResult = "copied" | "render-failed" | "clipboard-unavailable";

interface ShareDialogProps {
  /** The selected scope's card numbers (device or account) — see profileSelectors. */
  readonly cardStats: ShareCardStats;
  readonly initials: string;
  readonly displayName: string;
  readonly handle: string;
  readonly avatarColor: string;
  readonly avatarImage: string | null;
  /** The account profile, when signed in with one — a PUBLIC profile makes shares link to its page. */
  readonly accountProfile: Pick<AccountProfile, "handle" | "public"> | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ShareDialog({
  cardStats,
  initials,
  displayName,
  handle,
  avatarColor,
  avatarImage,
  accountProfile,
  open,
  onOpenChange,
}: ShareDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<ShareTarget | "copy" | "save" | null>(null);
  const [previewWidth, setPreviewWidth] = useState(PREVIEW_WIDTH);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const node = previewRef.current;
    if (!node) {
      return;
    }

    const updatePreviewWidth = (width: number) => {
      setPreviewWidth(Math.max(1, Math.min(PREVIEW_WIDTH, Math.floor(width))));
    };
    updatePreviewWidth(node.clientWidth || PREVIEW_WIDTH);

    if (typeof ResizeObserver === "undefined") {
      const handleResize = () => updatePreviewWidth(node.clientWidth || PREVIEW_WIDTH);
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }

    const observer = new ResizeObserver((entries) => {
      updatePreviewWidth(entries[0]?.contentRect.width ?? node.clientWidth ?? PREVIEW_WIDTH);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [open]);

  const copyCardToClipboard = async (): Promise<CopyResult> => {
    const node = cardRef.current;
    if (!node) {
      return "render-failed";
    }

    const blob = await renderNodeToPngBlob(node, CARD_EXPORT_SIZE);
    if (!blob) {
      return "render-failed";
    }

    return (await copyImageToClipboard(blob)) ? "copied" : "clipboard-unavailable";
  };

  // Promise chains instead of async/try-finally in these handlers: React
  // Compiler does not yet support try/finally and would skip this component.
  const handleCopy = () => {
    setBusy("copy");
    setStatus(null);
    return copyCardToClipboard()
      .then((copyResult) => {
        setStatus(copyStatusMessage(copyResult));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const handleShare = (target: ShareTarget) => {
    setBusy(target);
    setStatus(null);
    return copyCardToClipboard()
      .then((copyResult) => {
        openExternalUrl(shareIntentUrl(target, shareLinkUrl(profileShareUrl(accountProfile))));
        setStatus(shareStatusMessage(copyResult));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const handleSave = () => {
    const node = cardRef.current;
    if (!node) {
      return Promise.resolve();
    }
    setBusy("save");
    setStatus(null);
    return renderNodeToPngBlob(node, CARD_EXPORT_SIZE)
      .then((blob) => {
        if (blob) {
          downloadBlob(blob, `synara-stats-${localDayKey()}.png`);
          setStatus("Saved PNG to your downloads.");
        } else {
          setStatus("Could not render the image.");
        }
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const handleCopyProfileLink = (url: string) => {
    setStatus(null);
    return copyTextToClipboard(url)
      .then(() => {
        setStatus("Profile link copied to clipboard.");
      })
      .catch(() => {
        setStatus("Could not copy the profile link.");
      });
  };

  const previewScale = previewWidth / SHARE_CARD_WIDTH;
  const actionsDisabled = busy !== null;
  const publicUrl = profileShareUrl(accountProfile);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-[560px]">
        <DialogTitle className="text-center text-xl">Share your activity</DialogTitle>
        <div className="mt-5 flex flex-col items-center gap-7 px-2 pb-3">
          <div
            ref={previewRef}
            className="w-full max-w-[480px] overflow-hidden rounded-2xl border bg-white shadow-sm"
            style={{ aspectRatio: `${SHARE_CARD_WIDTH} / ${SHARE_CARD_HEIGHT}` }}
          >
            <div
              style={{
                width: SHARE_CARD_WIDTH,
                transform: `scale(${previewScale})`,
                transformOrigin: "top left",
              }}
            >
              <ShareCard
                ref={cardRef}
                cardStats={cardStats}
                initials={initials}
                displayName={displayName}
                handle={handle}
                avatarColor={avatarColor}
                avatarImage={avatarImage}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-start justify-center gap-x-6 gap-y-4">
            <ShareButton
              label="Copy"
              ariaLabel="Copy stat card"
              busy={busy === "copy"}
              disabled={actionsDisabled}
              onClick={() => void handleCopy()}
            >
              <CopyIcon className="size-5" />
            </ShareButton>
            <ShareButton
              label="X"
              busy={busy === "x"}
              disabled={actionsDisabled}
              onClick={() => void handleShare("x")}
            >
              <SiX className="size-5" />
            </ShareButton>
            <ShareButton
              label="LinkedIn"
              busy={busy === "linkedin"}
              disabled={actionsDisabled}
              onClick={() => void handleShare("linkedin")}
            >
              <FaLinkedinIn className="size-5" />
            </ShareButton>
            <ShareButton
              label="Reddit"
              busy={busy === "reddit"}
              disabled={actionsDisabled}
              onClick={() => void handleShare("reddit")}
            >
              <SiReddit className="size-5" />
            </ShareButton>
            <ShareButton
              label="Save"
              ariaLabel="Save stat card"
              busy={busy === "save"}
              disabled={actionsDisabled}
              onClick={() => void handleSave()}
            >
              <DownloadIcon className="size-5" />
            </ShareButton>
          </div>

          {accountProfile &&
            (publicUrl ? (
              <button
                type="button"
                onClick={() => void handleCopyProfileLink(publicUrl)}
                className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <LinkIcon className="size-3.5" />
                {publicProfileDisplayUrl(accountProfile.handle)}
              </button>
            ) : (
              <p className="text-center text-xs leading-snug text-muted-foreground">
                Your profile is private. Make it public in Edit profile to share a link to it.
              </p>
            ))}

          <p className="min-h-4 text-center text-xs leading-snug text-muted-foreground">
            {status ?? ""}
          </p>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function copyStatusMessage(result: CopyResult): string {
  switch (result) {
    case "copied":
      return "Copied image to clipboard.";
    case "render-failed":
      return "Could not render the image.";
    case "clipboard-unavailable":
      return "Image copy unavailable. Use Save instead.";
  }
}

function shareStatusMessage(result: CopyResult): string {
  switch (result) {
    case "copied":
      return "Image copied to clipboard — paste it into your post.";
    case "render-failed":
      return "Composer opened. Use Save to attach the image.";
    case "clipboard-unavailable":
      return "Composer opened. Image copy unavailable; use Save to attach.";
  }
}

interface ShareButtonProps {
  readonly label: string;
  readonly ariaLabel?: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

function ShareButton({ label, ariaLabel, busy, disabled, onClick, children }: ShareButtonProps) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel ?? `Share to ${label}`}
        className={cn(
          "flex size-14 items-center justify-center rounded-full bg-foreground text-background transition-opacity",
          disabled ? (busy ? "opacity-70" : "opacity-35") : "hover:opacity-90",
        )}
      >
        {children}
      </button>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
