// FILE: EditProfileDialog.tsx
// Purpose: "Edit profile" modal — edits the display name, @handle, avatar, and accent
// color. Drafts are held locally and only committed on Save, with one exception: a photo
// upload while signed in writes through the account immediately (the bytes have to land
// somewhere), and only the source *selection* stays a draft.
// Layer: web profile feature. Signed out, changes persist to localStorage via the parent
// hooks and the photo is compressed on-device and stored locally. Signed in, the avatar is
// account state: three choices — the identity provider's picture, an uploaded photo, or
// the initials placeholder — where sso/placeholder commit through updateProfile on Save
// and uploads go through account.uploadAvatar.

import { type ReactNode, useRef, useState } from "react";
import type { AccountProfileAvatarSource } from "@synara/contracts";
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
import { normalizeHandle } from "@synara/profile-ui/formatting";
import { PROFILE_AVATAR_COLORS } from "./useProfileAvatarColor";
import { AvatarImageError, compressAvatarImage } from "./avatarImage";
import { ProfileAvatar } from "@synara/profile-ui/avatar";

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
   * The identity provider's picture (me.image), offered as the "Provider
   * picture" avatar choice while signed in. Null when the provider has none
   * (email OTP accounts), which hides that choice.
   */
  readonly ssoImage?: string | null | undefined;
  /**
   * The account-backed profile, when signed in with one. Its presence locks
   * the handle (immutable server-side), reveals the "Public profile"
   * visibility switch, and switches the avatar section from the local photo
   * to the account's three-way source choice.
   */
  readonly accountProfile: {
    readonly handle: string;
    readonly public?: boolean | undefined;
    readonly avatarSource?: AccountProfileAvatarSource | undefined;
    readonly avatarUrl?: string | null | undefined;
  } | null;
  /**
   * Uploads a compressed photo (a `compressAvatarImage` data URL) to the
   * account, flipping the avatar source to "uploaded" server-side. Required
   * whenever `accountProfile` is set; unused signed out.
   */
  readonly onUploadPhoto?: ((dataUrl: string) => Promise<void>) | undefined;
  /** Removes the uploaded photo from the account (the source reverts to "sso"). */
  readonly onRemoveUploadedPhoto?: (() => Promise<void>) | undefined;
  /** Commits the draft. May reject (account write failure) — the dialog stays open and shows the error. */
  readonly onSave: (next: {
    name: string;
    handle: string;
    avatarColor: string;
    avatarImage: string | null;
    isPublic?: boolean;
    avatarSource?: "sso" | "placeholder";
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
  ssoImage,
  accountProfile,
  onUploadPhoto,
  onRemoveUploadedPhoto,
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
          ssoImage={ssoImage}
          accountProfile={accountProfile}
          onUploadPhoto={onUploadPhoto}
          onRemoveUploadedPhoto={onRemoveUploadedPhoto}
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
  ssoImage,
  accountProfile,
  onUploadPhoto,
  onRemoveUploadedPhoto,
  onSave,
}: Omit<EditProfileDialogProps, "open">) {
  const [draftName, setDraftName] = useState(name);
  const [draftHandle, setDraftHandle] = useState(handle.replace(/^@+/, ""));
  const [draftColor, setDraftColor] = useState(avatarColor);
  const [draftImage, setDraftImage] = useState<string | null>(accountProfile ? null : avatarImage);
  const [draftPublic, setDraftPublic] = useState(accountProfile?.public === true);
  // The avatar source selection while signed in. "sso" and "placeholder" are
  // drafts committed on Save; "uploaded" is only ever entered by a completed
  // upload, which has already written the account.
  const [draftSource, setDraftSource] = useState<AccountProfileAvatarSource>(
    accountProfile?.avatarSource ?? "sso",
  );
  const [showEditor, setShowEditor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const signedIn = accountProfile !== null;

  // What the big preview circle shows for the current draft. Signed in, the
  // sso choice previews from me.image (avatarUrl may still point at an
  // uploaded object the user is drafting away from); the uploaded choice
  // shows the account's resolved URL, which refreshes when an upload lands.
  const previewImage = signedIn
    ? draftSource === "placeholder"
      ? null
      : draftSource === "sso"
        ? (ssoImage ?? null)
        : (accountProfile.avatarUrl ?? null)
    : draftImage;

  // Promise chains instead of async/try-catch in the handlers below: React
  // Compiler does not yet support try/catch|finally and would skip this
  // component (same reason as ShareDialog's handlers).
  const handlePickFile = (file: File | undefined) => {
    if (!file) {
      return Promise.resolve();
    }
    setError(null);
    setProcessing(true);
    return compressAvatarImage(file)
      .then((dataUrl) => {
        if (!signedIn) {
          setDraftImage(dataUrl);
          return;
        }
        // Signed in, the bytes go to the account right away — an upload is
        // not draftable — and only then does the selection flip to
        // "uploaded", so a failed upload leaves the previous choice intact.
        if (!onUploadPhoto) {
          throw new Error("Avatar upload is not wired for this dialog");
        }
        return onUploadPhoto(dataUrl).then(() => {
          setDraftSource("uploaded");
        });
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof AvatarImageError
            ? cause.message
            : accountErrorMessage(cause, "Could not upload that image. Try again."),
        );
      })
      .finally(() => {
        setProcessing(false);
      });
  };

  const handleRemoveUploaded = () => {
    if (!onRemoveUploadedPhoto) {
      return Promise.resolve();
    }
    setError(null);
    setProcessing(true);
    return onRemoveUploadedPhoto()
      .then(() => {
        // The service reverts the source to "sso"; mirror that here so the
        // selection matches what a reopened dialog would seed.
        setDraftSource("sso");
      })
      .catch((cause: unknown) => {
        setError(accountErrorMessage(cause, "Could not remove the photo. Try again."));
      })
      .finally(() => {
        setProcessing(false);
      });
  };

  const handleSave = () => {
    setSaving(true);
    setError(null);
    return onSave({
      name: draftName.trim(),
      handle: normalizeHandle(draftHandle),
      avatarColor: draftColor,
      avatarImage: draftImage,
      ...(accountProfile ? { isPublic: draftPublic } : {}),
      // "uploaded" is never sent: the upload already claimed it server-side,
      // and PUT /profile deliberately refuses to.
      ...(accountProfile && draftSource !== "uploaded" ? { avatarSource: draftSource } : {}),
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
              image={previewImage}
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

          {showEditor &&
            (signedIn ? (
              <AccountAvatarEditor
                draftSource={draftSource}
                hasSsoImage={ssoImage != null}
                hasUpload={draftSource === "uploaded"}
                processing={processing}
                draftColor={draftColor}
                onSelectSso={() => {
                  setError(null);
                  setDraftSource("sso");
                }}
                onSelectPlaceholder={() => {
                  setError(null);
                  setDraftSource("placeholder");
                }}
                onPickFile={() => fileInputRef.current?.click()}
                onRemoveUploaded={() => void handleRemoveUploaded()}
                onPickColor={setDraftColor}
              />
            ) : (
              <LocalAvatarEditor
                draftImage={draftImage}
                processing={processing}
                draftColor={draftColor}
                onPickFile={() => fileInputRef.current?.click()}
                onRemoveImage={() => {
                  setDraftImage(null);
                  setError(null);
                }}
                onPickColor={setDraftColor}
              />
            ))}

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

/**
 * The signed-in avatar editor: a three-way source choice — provider picture
 * (only offered when the identity provider supplied one), an uploaded photo,
 * and the initials placeholder — plus the accent swatches, which color the
 * placeholder. Sso/placeholder are draft selections committed on Save;
 * "Upload photo" writes through the account immediately.
 */
function AccountAvatarEditor({
  draftSource,
  hasSsoImage,
  hasUpload,
  processing,
  draftColor,
  onSelectSso,
  onSelectPlaceholder,
  onPickFile,
  onRemoveUploaded,
  onPickColor,
}: {
  draftSource: AccountProfileAvatarSource;
  hasSsoImage: boolean;
  hasUpload: boolean;
  processing: boolean;
  draftColor: string;
  onSelectSso: () => void;
  onSelectPlaceholder: () => void;
  onPickFile: () => void;
  onRemoveUploaded: () => void;
  onPickColor: (color: string) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {hasSsoImage && (
          <AvatarChoiceButton selected={draftSource === "sso"} onClick={onSelectSso}>
            <CentralIcon name="circle-person" className="size-3.5" />
            Provider picture
          </AvatarChoiceButton>
        )}
        <AvatarChoiceButton
          selected={draftSource === "uploaded"}
          disabled={processing}
          onClick={onPickFile}
        >
          <CentralIcon name="add-image" className="size-3.5" />
          {processing ? "Uploading…" : hasUpload ? "Replace photo" : "Upload photo"}
        </AvatarChoiceButton>
        <AvatarChoiceButton selected={draftSource === "placeholder"} onClick={onSelectPlaceholder}>
          <CentralIcon name="letter-a-circle" className="size-3.5" />
          Initials
        </AvatarChoiceButton>
        {hasUpload && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-1.5 text-muted-foreground"
            disabled={processing}
            onClick={onRemoveUploaded}
          >
            <CentralIcon name="trash-can-simple" className="size-3.5" />
            Remove
          </Button>
        )}
      </div>

      <ColorSwatches
        draftColor={draftColor}
        selectable={draftSource === "placeholder"}
        onPickColor={onPickColor}
      />

      {draftSource !== "placeholder" && (
        <p className="text-center text-xs text-muted-foreground">
          Colors apply to the initials avatar.
        </p>
      )}
    </div>
  );
}

/** The signed-out avatar editor: the local photo + accent swatches, unchanged. */
function LocalAvatarEditor({
  draftImage,
  processing,
  draftColor,
  onPickFile,
  onRemoveImage,
  onPickColor,
}: {
  draftImage: string | null;
  processing: boolean;
  draftColor: string;
  onPickFile: () => void;
  onRemoveImage: () => void;
  onPickColor: (color: string) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="gap-1.5"
          disabled={processing}
          onClick={onPickFile}
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
            onClick={onRemoveImage}
          >
            <CentralIcon name="trash-can-simple" className="size-3.5" />
            Remove
          </Button>
        )}
      </div>

      <ColorSwatches
        draftColor={draftColor}
        selectable={draftImage === null}
        onPickColor={onPickColor}
      />

      {draftImage && (
        <p className="text-center text-xs text-muted-foreground">
          Colors apply when no photo is set.
        </p>
      )}
    </div>
  );
}

function AvatarChoiceButton({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={disabled}
      aria-pressed={selected}
      className={cn("gap-1.5", selected && "border-foreground/60 bg-accent")}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function ColorSwatches({
  draftColor,
  selectable,
  onPickColor,
}: {
  draftColor: string;
  selectable: boolean;
  onPickColor: (color: string) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2">
      {PROFILE_AVATAR_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onPickColor(color)}
          aria-label={`Use ${color}`}
          className={cn(
            "size-5 rounded-full transition-transform hover:scale-110",
            selectable &&
              draftColor === color &&
              "ring-2 ring-foreground/70 ring-offset-2 ring-offset-popover",
          )}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
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
