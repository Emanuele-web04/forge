// FILE: useProfileIdentity.ts
// Purpose: The profile identity as one seam — account-aware when signed in
// (me.profile is the source of truth and edits write through
// account.updateProfile / account.uploadAvatar), localStorage-only when
// signed out. Name/handle/color are always mirrored into localStorage as the
// offline cache; the avatar photo is NOT — signed in it lives on the account
// (profile.avatarUrl), and the localStorage photo remains purely the
// signed-out experience, neither migrated nor deleted.
// Layer: web profile feature.

import type { AccountProfile, UpdatableAvatarSource } from "@synara/contracts";
import { deriveInitials } from "@synara/profile-ui/formatting";
import { useAccount } from "~/hooks/useAccount";
import { avatarDataUrlToUpload } from "./avatarImage";
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
  /**
   * Switches the account avatar to the provider picture or the initials
   * placeholder. Only meaningful when signed in; "uploaded" is never sent
   * here — uploads go through {@link useProfileIdentity}'s `uploadAvatarPhoto`,
   * which is the only path that can claim it.
   */
  readonly avatarSource?: UpdatableAvatarSource;
}

export function useProfileIdentity(defaults: { name: string; handle: string }) {
  const account = useAccount();
  const { name: localName, setName } = useProfileName(defaults.name);
  const { handle: localHandle, setHandle } = useProfileHandle(defaults.handle);
  const { color: localColor, setColor } = useProfileAvatarColor();
  const { image: localImage, setImage } = useProfileAvatarImage();

  // A signed-in user without a profile hasn't onboarded yet — treat exactly
  // like signed out (local identity) until onboarding writes the profile.
  const accountProfile: AccountProfile | null = account.me?.profile ?? null;

  const name = accountProfile?.displayName ?? localName;
  // Placeholder-avatar initials from the RESOLVED name — the account display
  // name may differ from the machine-local default, and initials derived from
  // the home-dir identity would not match it. deriveInitials is the canonical
  // algorithm (shared with the server and the public page), so the local-only
  // case yields the same glyphs as stats.identity.initials.
  const initials = deriveInitials(name);
  const handle = accountProfile ? `@${accountProfile.handle}` : localHandle;
  const avatarColor = accountProfile?.avatarColor ?? localColor;
  // Signed in, every avatar render uses the account's resolved URL (uploaded
  // object, cached sso picture, or null for the placeholder); the localStorage
  // photo is only ever the signed-out avatar.
  const avatarImage = accountProfile ? (accountProfile.avatarUrl ?? null) : localImage;
  /** The identity provider's picture, offered as an avatar choice when set. */
  const ssoImage = account.me?.image ?? null;

  /**
   * Commits an edit. Signed in: write through the account first (the handle is
   * immutable server-side, so the stored handle is always sent), then mirror
   * name/handle/color into localStorage as the offline cache — never the
   * photo, which is account state. Signed out: localStorage only. Rejects
   * when the account write fails, leaving the local cache untouched.
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
        ...(next.avatarSource !== undefined ? { avatarSource: next.avatarSource } : {}),
        // Every save refreshes the stored offset so the PUBLIC profile
        // buckets days/hours in the owner's current timezone.
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
      });
    }
    setName(next.name);
    setHandle(accountProfile ? accountProfile.handle : next.handle);
    setColor(next.avatarColor);
    // The stored photo belongs to the signed-out identity; a signed-in save
    // must not overwrite or clear it.
    if (!accountProfile) {
      setImage(next.avatarImage);
    }
  };

  /**
   * Uploads a compressed avatar (a `compressAvatarImage` data URL) to the
   * account, which stores it and flips the avatar source to "uploaded". The
   * refreshed `me` lands in the status cache, so every avatar render updates
   * on resolution. Signed-in only — the signed-out photo stays local.
   */
  const uploadAvatarPhoto = async (dataUrl: string): Promise<void> => {
    const { bytes, contentType } = avatarDataUrlToUpload(dataUrl);
    await account.uploadAvatar.mutateAsync({ bytes, contentType });
  };

  /** Deletes the uploaded avatar object; the source reverts to "sso". */
  const removeUploadedAvatar = async (): Promise<void> => {
    await account.deleteAvatar.mutateAsync();
  };

  return {
    name,
    /** Placeholder-avatar glyphs derived from the resolved `name`. */
    initials,
    handle,
    avatarColor,
    avatarImage,
    ssoImage,
    /** Non-null exactly when the identity is account-backed. */
    accountProfile,
    save,
    uploadAvatarPhoto,
    removeUploadedAvatar,
  } as const;
}
