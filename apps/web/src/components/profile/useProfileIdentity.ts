// FILE: useProfileIdentity.ts
// Purpose: The profile identity as one seam — account-aware when signed in
// (me.profile is the source of truth and edits write through
// account.updateProfile), localStorage-only when signed out. localStorage is
// always written too, as the offline cache. The avatar photo is deliberately
// local-only: there is no backend for it and it never appears on the public
// profile page.
// Layer: web profile feature.

import type { AccountProfile } from "@synara/contracts";
import { useAccount } from "~/hooks/useAccount";
import { useProfileAvatarColor } from "./useProfileAvatarColor";
import { useProfileAvatarImage } from "./useProfileAvatarImage";
import { useProfileHandle } from "./useProfileHandle";
import { useProfileName } from "./useProfileName";

export interface ProfileIdentityDraft {
  readonly name: string;
  readonly handle: string;
  readonly avatarColor: string;
  readonly avatarImage: string | null;
  /** Public-page visibility; only meaningful when signed in with a profile. */
  readonly isPublic?: boolean;
}

export function useProfileIdentity(defaults: { name: string; handle: string }) {
  const account = useAccount();
  const { name: localName, setName } = useProfileName(defaults.name);
  const { handle: localHandle, setHandle } = useProfileHandle(defaults.handle);
  const { color: localColor, setColor } = useProfileAvatarColor();
  const { image: avatarImage, setImage } = useProfileAvatarImage();

  // A signed-in user without a profile hasn't onboarded yet — treat exactly
  // like signed out (local identity) until onboarding writes the profile.
  const accountProfile: AccountProfile | null = account.me?.profile ?? null;

  const name = accountProfile?.displayName ?? localName;
  const handle = accountProfile ? `@${accountProfile.handle}` : localHandle;
  const avatarColor = accountProfile?.avatarColor ?? localColor;

  /**
   * Commits an edit. Signed in: write through the account first (the handle is
   * immutable server-side, so the stored handle is always sent), then mirror
   * into localStorage as the offline cache. Signed out: localStorage only.
   * Rejects when the account write fails, leaving the local cache untouched.
   */
  const save = async (next: ProfileIdentityDraft): Promise<void> => {
    if (accountProfile) {
      await account.updateProfile.mutateAsync({
        handle: accountProfile.handle,
        // The contract requires a non-empty display name; clearing the field
        // means "keep what I had", matching the local hook's default fallback.
        displayName: next.name.trim().length > 0 ? next.name.trim() : name,
        avatarColor: next.avatarColor,
        ...(next.isPublic !== undefined ? { public: next.isPublic } : {}),
        // Every save refreshes the stored offset so the PUBLIC profile
        // buckets days/hours in the owner's current timezone.
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
      });
    }
    setName(next.name);
    setHandle(accountProfile ? accountProfile.handle : next.handle);
    setColor(next.avatarColor);
    setImage(next.avatarImage);
  };

  return {
    name,
    handle,
    avatarColor,
    avatarImage,
    /** Non-null exactly when the identity is account-backed. */
    accountProfile,
    save,
  } as const;
}
