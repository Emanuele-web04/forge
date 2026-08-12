// FILE: OnboardingDialog.tsx
// Purpose: Required onboarding modal shown after the first sign-in — picks the
// public @handle, display name, avatar color, and workspace name, then writes
// the profile through account.updateProfile. Not dismissable: a signed-in user
// without a profile has nowhere else to go.
// Layer: Web account feature.

import type { AccountMe } from "@synara/contracts";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "~/components/ui/input-group";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { dialogFieldLabelClassName } from "~/components/ui/dialog";
import { ProfileAvatar } from "@synara/profile-ui/avatar";
import { PROFILE_AVATAR_COLORS } from "~/components/profile/useProfileAvatarColor";
import { useAccount } from "~/hooks/useAccount";
import {
  accountErrorMessage,
  accountInitial,
  handleFormatError,
  publicProfileDisplayUrl,
  readAccountErrorCode,
  sanitizeHandleInput,
} from "~/lib/accountLogic";
import { cn } from "~/lib/utils";

interface OnboardingDialogProps {
  readonly open: boolean;
  readonly me: AccountMe;
  /** Called after the profile is saved; the dialog cannot close any other way. */
  readonly onFinished: () => void;
}

export function OnboardingDialog({ open, me, onFinished }: OnboardingDialogProps) {
  return (
    // Required: no open/close control is handed to the dialog, so Esc and
    // backdrop presses have nothing to call, and the close X is hidden.
    <Dialog open={open}>
      <DialogPopup showCloseButton={false} className="sm:max-w-[380px]">
        <OnboardingDialogContent me={me} onFinished={onFinished} />
      </DialogPopup>
    </Dialog>
  );
}

function OnboardingDialogContent({ me, onFinished }: Omit<OnboardingDialogProps, "open">) {
  const account = useAccount();
  const [name, setName] = useState(me.name);
  const [handle, setHandle] = useState(sanitizeHandleInput(me.name.replace(/\s+/g, "-")));
  const [workspaceName, setWorkspaceName] = useState(me.organization.name);
  const [avatarColor, setAvatarColor] = useState(PROFILE_AVATAR_COLORS[0] ?? "#22c55e");
  const [handleTouched, setHandleTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable ids linking the handle input to its help/error text and the save
  // failure to the form, for assistive tech.
  const handleHelpId = useId();
  const saveErrorId = useId();

  const formatError = handleTouched ? handleFormatError(handle) : null;
  const saving = account.updateProfile.isPending;

  const handleFinish = async () => {
    setHandleTouched(true);
    setError(null);
    if (handleFormatError(handle) !== null || name.trim().length === 0) return;
    try {
      await account.updateProfile.mutateAsync({
        handle,
        displayName: name.trim(),
        avatarColor,
        ...(workspaceName.trim().length > 0 && workspaceName.trim() !== me.organization.name
          ? { workspaceName: workspaceName.trim() }
          : {}),
      });
      toastManager.add({
        type: "success",
        title: "You're all set",
        description: `Your public profile is ${publicProfileDisplayUrl(handle)}.`,
      });
      onFinished();
    } catch (cause) {
      setError(
        readAccountErrorCode(cause) === "handle_taken"
          ? "That handle is already taken — pick another."
          : accountErrorMessage(cause, "Could not save your profile. Try again."),
      );
    }
  };

  return (
    <div className="flex flex-col gap-4 px-6 pt-8 pb-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <ProfileAvatar
          initials={accountInitial(name)}
          color={avatarColor}
          image={me.image ?? null}
          className="size-16"
          textClassName="text-xl"
        />
        {!me.image && (
          <div className="flex items-center justify-center gap-2">
            {PROFILE_AVATAR_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setAvatarColor(color)}
                aria-label={`Use ${color}`}
                className={cn(
                  "size-4 rounded-full transition-transform hover:scale-110",
                  avatarColor === color &&
                    "ring-2 ring-foreground/70 ring-offset-2 ring-offset-popover",
                )}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        )}
        <DialogTitle className="font-system-ui text-lg font-semibold">
          Set up your profile
        </DialogTitle>
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void handleFinish();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className={dialogFieldLabelClassName}>Name</span>
          <Input
            value={name}
            autoComplete="name"
            placeholder="Your name"
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={dialogFieldLabelClassName}>Handle</span>
          <InputGroup>
            <InputGroupAddon>
              <InputGroupText>@</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              value={handle}
              placeholder="handle"
              disabled={saving}
              aria-invalid={formatError !== null || undefined}
              aria-describedby={handleHelpId}
              onChange={(event) => {
                setHandle(sanitizeHandleInput(event.target.value));
                setHandleTouched(true);
              }}
            />
          </InputGroup>
          {/* One stable region, always described-by the input: help text
              normally, role="alert" when it flips to a format error so the
              change is announced. */}
          {formatError ? (
            <span
              id={handleHelpId}
              role="alert"
              className="text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-destructive"
            >
              {formatError}
            </span>
          ) : (
            <span
              id={handleHelpId}
              className="text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-muted-foreground"
            >
              Your public profile: {publicProfileDisplayUrl(handle || "handle")}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={dialogFieldLabelClassName}>Workspace name</span>
          <Input
            value={workspaceName}
            placeholder="Workspace"
            disabled={saving}
            onChange={(event) => setWorkspaceName(event.target.value)}
          />
        </label>

        {/* Announces a save failure (handle conflict, network) on arrival. */}
        {error ? (
          <p
            id={saveErrorId}
            role="alert"
            className="text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-destructive"
          >
            {error}
          </p>
        ) : null}

        <Button type="submit" className="mt-1 w-full" disabled={saving}>
          {saving ? <Spinner className="size-3.5" /> : null}
          Finish
        </Button>
      </form>
    </div>
  );
}
