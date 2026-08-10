// FILE: AccountFooterControl.tsx
// Purpose: The sidebar footer's account entry point — a signed-in row (avatar,
// first name, chevron) opening the account menu, or a signed-out row opening
// the local-mode menu. Replaces the old standalone Settings row; Settings
// lives inside both menus.
// Layer: Web account feature (sidebar footer).

import { useNavigate } from "@tanstack/react-router";
import { toastManager } from "~/components/ui/toast";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "~/components/ui/menu";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import {
  SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME,
  SidebarContextMenuIcon,
} from "~/components/sidebarContextMenuStyles";
import { SidebarMenuButton } from "~/components/ui/sidebar";
import { ProfileAvatar } from "~/components/profile/ProfileAvatar";
import { CheckIcon, ChevronUpIcon, ExternalLinkIcon, SettingsIcon } from "~/lib/icons";
import { openExternalLink } from "~/lib/linkChips";
import { cn, isMacPlatform } from "~/lib/utils";
import { useAccount } from "~/hooks/useAccount";
import {
  accountErrorMessage,
  accountFirstName,
  accountInitial,
  publicProfileUrl,
} from "~/lib/accountLogic";
import { PROFILE_AVATAR_COLORS } from "~/components/profile/useProfileAvatarColor";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "~/sidebarRowStyles";
import { useAccountDialogStore } from "./accountDialogStore";

const DEFAULT_MENU_AVATAR_COLOR = PROFILE_AVATAR_COLORS[0] ?? "#22c55e";

function settingsShortcutLabel(): string {
  return isMacPlatform(navigator.platform) ? "⌘," : "Ctrl+,";
}

export function AccountFooterControl() {
  const account = useAccount();
  return account.me ? <SignedInFooter /> : <SignedOutFooter />;
}

function SignedInFooter() {
  const account = useAccount();
  const navigate = useNavigate();
  const openSignIn = useAccountDialogStore((state) => state.openSignIn);
  const me = account.me;
  if (!me) return null;

  const profile = me.profile ?? null;
  const displayName = profile?.displayName ?? me.name;
  const avatarColor = profile?.avatarColor ?? DEFAULT_MENU_AVATAR_COLOR;

  const handleSignOut = async () => {
    try {
      await account.signOut.mutateAsync();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not sign out",
        description: accountErrorMessage(cause, "Try again in a moment."),
      });
    }
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarMenuButton
            size="sm"
            className={cn(
              SIDEBAR_HEADER_ROW_CLASS_NAME,
              SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
              SIDEBAR_ROW_HOVER_CLASS_NAME,
              "flex-1",
            )}
          />
        }
      >
        <ProfileAvatar
          initials={accountInitial(displayName)}
          color={avatarColor}
          image={me.image ?? null}
          className="size-5 shrink-0"
          textClassName="text-[10px]"
        />
        <span className="min-w-0 flex-1 truncate">{accountFirstName(me)}</span>
        <ChevronUpIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <ComposerPickerMenuPopup side="top" align="start" className="w-60 min-w-60">
        <MenuGroup>
          <div className="flex flex-col gap-0.5 px-2 py-1.5">
            <span className="truncate text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground">
              {displayName}
            </span>
            <span className="truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
              {profile ? `@${profile.handle} · ${me.email}` : me.email}
            </span>
          </div>
          <MenuItem className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME} closeOnClick={false}>
            <span className="min-w-0 flex-1 truncate">{me.organization.name}</span>
            <CheckIcon className="size-3 shrink-0" />
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          {profile ? (
            <MenuItem
              className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
              onClick={() => openExternalLink(publicProfileUrl(profile.handle))}
            >
              <SidebarContextMenuIcon icon={ExternalLinkIcon} />
              <span>View public profile</span>
            </MenuItem>
          ) : (
            <MenuItem className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME} onClick={openSignIn}>
              <SidebarContextMenuIcon icon={ExternalLinkIcon} />
              <span>Finish setting up</span>
            </MenuItem>
          )}
          <MenuItem
            className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
            onClick={() => void navigate({ to: "/settings" })}
          >
            <SidebarContextMenuIcon icon={SettingsIcon} />
            <span>Settings</span>
            <MenuShortcut>{settingsShortcutLabel()}</MenuShortcut>
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuItem variant="destructive" onClick={() => void handleSignOut()}>
            <span>Sign out</span>
          </MenuItem>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function SignedOutFooter() {
  const navigate = useNavigate();
  const openSignIn = useAccountDialogStore((state) => state.openSignIn);

  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarMenuButton
            size="sm"
            className={cn(
              SIDEBAR_HEADER_ROW_CLASS_NAME,
              SIDEBAR_ROW_HOVER_CLASS_NAME,
              "flex-1 text-muted-foreground",
            )}
          />
        }
      >
        <span
          aria-hidden="true"
          className="flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/48 text-[10px] text-muted-foreground"
        >
          ?
        </span>
        <span className="min-w-0 flex-1 truncate">Sign in</span>
        <ChevronUpIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <ComposerPickerMenuPopup side="top" align="start" className="w-60 min-w-60">
        <MenuGroup>
          <div className="flex flex-col gap-0.5 px-2 py-1.5">
            <span className="text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground">
              You&rsquo;re in local mode
            </span>
            <span className="text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-muted-foreground">
              Sign in to sync your profile and workspace across devices.
            </span>
          </div>
          <div className="px-2 pt-1 pb-1.5">
            <MenuItem
              className="w-full justify-center rounded-lg border border-transparent bg-primary text-primary-foreground data-highlighted:bg-primary/90 data-highlighted:text-primary-foreground"
              onClick={openSignIn}
            >
              Sign in
            </MenuItem>
          </div>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuItem
            className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
            onClick={() => void navigate({ to: "/settings" })}
          >
            <SidebarContextMenuIcon icon={SettingsIcon} />
            <span>Settings</span>
            <MenuShortcut>{settingsShortcutLabel()}</MenuShortcut>
          </MenuItem>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
