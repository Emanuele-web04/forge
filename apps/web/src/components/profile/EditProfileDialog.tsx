// FILE: EditProfileDialog.tsx
// Purpose: "Edit profile" modal — edits the display name, @handle, avatar photo, and
// accent color. The photo is compressed on-device before it's handed back. Drafts are held
// locally and only committed on Save.
// Layer: web profile feature. Signed out, changes persist to localStorage via the parent
// hooks; signed in, name/color/visibility write through the account (the parent's onSave
// does the RPC) and the handle is immutable. The avatar photo is always local-only.

import { type ReactNode, useRef, useState } from "react";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "~/components/ui/input-group";
import { Switch } from "~/components/ui/switch";
import { CentralIcon } from "~/lib/central-icons";
import { accountErrorMessage, publicProfileDisplayUrl } from "~/lib/accountLogic";
import { cn } from "~/lib/utils";
import { normalizeHandle } from "./profileFormatting";
import { PROFILE_AVATAR_COLORS } from "./useProfileAvatarColor";
import { AvatarImageError, compressAvatarImage } from "./avatarImage";
import { ProfileAvatar } from "./ProfileAvatar";

// Inputs and footer buttons share one fixed height + radius so every control in
// the dialog reads as the same size. The visible border keeps the fields legible
// even when unfocused (the default --input border is ~6% and reads as "no box").
const fieldControlClassName = "h-9 rounded-xl border-foreground/12";
const dialogButtonClassName = "h-11 rounded-lg px-4";

interface EditProfileDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initials: string;
  readonly name: string;
  readonly handle: string;
  readonly avatarColor: string;
  readonly avatarImage: string | null;
  /**
   * The account-backed profile, when signed in with one. Its presence locks
   * the handle (immutable server-side) and reveals the "Public profile"
   * visibility switch.
   */
  readonly accountProfile: {
    readonly handle: string;
    readonly public?: boolean | undefined;
  } | null;
  /** Commits the draft. May reject (account write failure) — the dialog stays open and shows the error. */
  readonly onSave: (next: {
    name: string;
    handle: string;
    avatarColor: string;
    avatarImage: string | null;
    isPublic?: boolean;
  }) => Promise<void>;
}

export function EditProfileDialog({
  open,
  onOpenChange,
  initials,
  name,
  handle,
  avatarColor,
  avatarImage,
  accountProfile,
  onSave,
}: EditProfileDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup showCloseButton={false} className="sm:max-w-[500px]">
        {/* Draft state lives below DialogPopup, which unmounts its children on
            close — every open re-seeds from the live values with no reset
            effect. */}
        <EditProfileDialogContent
          onOpenChange={onOpenChange}
          initials={initials}
          name={name}
          handle={handle}
          avatarColor={avatarColor}
          avatarImage={avatarImage}
          accountProfile={accountProfile}
          onSave={onSave}
        />
      </DialogPopup>
    </Dialog>
  );
}

function EditProfileDialogContent({
  onOpenChange,
  initials,
  name,
  handle,
  avatarColor,
  avatarImage,
  accountProfile,
  onSave,
}: Omit<EditProfileDialogProps, "open">) {
  const [draftName, setDraftName] = useState(name);
  const [draftHandle, setDraftHandle] = useState(handle.replace(/^@+/, ""));
  const [draftColor, setDraftColor] = useState(avatarColor);
  const [draftImage, setDraftImage] = useState<string | null>(avatarImage);
  const [draftPublic, setDraftPublic] = useState(accountProfile?.public === true);
  const [showEditor, setShowEditor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePickFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setError(null);
    setProcessing(true);
    try {
      setDraftImage(await compressAvatarImage(file));
    } catch (cause) {
      setError(cause instanceof AvatarImageError ? cause.message : "Could not process that image.");
    } finally {
      setProcessing(false);
    }
  };

  // Promise chain instead of async/try-catch: React Compiler does not yet
  // support try/catch|finally and would skip this component (same reason as
  // ShareDialog's handlers).
  const handleSave = () => {
    setSaving(true);
    setError(null);
    return onSave({
      name: draftName.trim(),
      handle: normalizeHandle(draftHandle),
      avatarColor: draftColor,
      avatarImage: draftImage,
      ...(accountProfile ? { isPublic: draftPublic } : {}),
    })
      .then(() => {
        onOpenChange(false);
      })
      .catch((cause: unknown) => {
        setError(accountErrorMessage(cause, "Could not save your profile. Try again."));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <>
      <DialogTitle className="px-4 pt-4 text-lg">Edit profile</DialogTitle>

      <div className="flex flex-col gap-4 px-4 pt-3">
        {/* Avatar */}
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <ProfileAvatar
              initials={initials}
              color={draftColor}
              image={draftImage}
              className="size-20"
              textClassName="text-2xl"
            />
            <button
              type="button"
              onClick={() => setShowEditor((value) => !value)}
              aria-label="Edit avatar"
              className={cn(
                "absolute bottom-0 end-0 flex size-7 items-center justify-center rounded-full",
                "bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/60",
              )}
            >
              <CentralIcon name="pencil" className="size-3 opacity-100" />
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              void handlePickFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />

          {showEditor && (
            <div className="flex flex-col items-center gap-3">
              <div className="flex items-center justify-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="gap-1.5"
                  disabled={processing}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <CentralIcon name="add-image" className="size-3.5" />
                  {processing ? "Processing…" : draftImage ? "Replace photo" : "Upload photo"}
                </Button>
                {draftImage && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="gap-1.5 text-muted-foreground"
                    onClick={() => {
                      setDraftImage(null);
                      setError(null);
                    }}
                  >
                    <CentralIcon name="trash-can-simple" className="size-3.5" />
                    Remove
                  </Button>
                )}
              </div>

              <div className="flex items-center justify-center gap-2">
                {PROFILE_AVATAR_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setDraftColor(color)}
                    aria-label={`Use ${color}`}
                    className={cn(
                      "size-5 rounded-full transition-transform hover:scale-110",
                      !draftImage &&
                        draftColor === color &&
                        "ring-2 ring-foreground/70 ring-offset-2 ring-offset-popover",
                    )}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>

              {draftImage && (
                <p className="text-center text-xs text-muted-foreground">
                  Colors apply when no photo is set.
                </p>
              )}
            </div>
          )}

          {error && <p className="text-center text-xs text-destructive">{error}</p>}
        </div>

        {/* Fields */}
        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
          <Field label="Display name">
            <InputGroup className={fieldControlClassName}>
              <InputGroupInput
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="Your name"
              />
            </InputGroup>
          </Field>
          <Field
            label="Username"
            hint={accountProfile ? "Handles can’t be changed once set." : undefined}
          >
            <InputGroup className={fieldControlClassName}>
              <InputGroupAddon>
                <InputGroupText>@</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                value={draftHandle}
                disabled={accountProfile !== null}
                onChange={(event) =>
                  setDraftHandle(event.target.value.replace(/^@+/, "").replace(/\s+/g, ""))
                }
                placeholder="username"
              />
            </InputGroup>
          </Field>
          {accountProfile && (
            <Field
              label="Public profile"
              hint={
                draftPublic
                  ? `Anyone can see your profile at ${publicProfileDisplayUrl(accountProfile.handle)}.`
                  : "Only you can see your profile."
              }
            >
              <div className="flex justify-end">
                <Switch
                  checked={draftPublic}
                  onCheckedChange={setDraftPublic}
                  aria-label="Public profile"
                />
              </div>
            </Field>
          )}
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 px-4 pb-4 pt-4 sm:flex-row sm:justify-end">
        <DialogClose
          render={<Button variant="ghost" size="default" className={dialogButtonClassName} />}
        >
          Cancel
        </DialogClose>
        <Button
          variant="default"
          size="default"
          className={dialogButtonClassName}
          onClick={() => void handleSave()}
          disabled={processing || saving}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 px-3.5 py-3">
      <div className="flex items-center justify-between gap-4">
        <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
        <div className="w-56 shrink-0">{children}</div>
      </div>
      {hint && <p className="text-xs leading-snug text-muted-foreground/80">{hint}</p>}
    </div>
  );
}
