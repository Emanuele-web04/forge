// FILE: avatar.tsx
// Purpose: Single source of truth for the profile avatar — renders the user's photo when
// set, otherwise the accent-colored circle with initials. Shared by the Profile header,
// the Edit dialog, the shareable card, and the public profile page so they never drift.
// Layer: profile-ui shared component.

import { cn } from "./cn";

interface ProfileAvatarProps {
  readonly initials: string;
  readonly color: string;
  readonly image?: string | null;
  /** Sizing/shape utility classes for the circle, e.g. "size-16". */
  readonly className?: string;
  /** Type scale for the initials fallback, e.g. "text-xl". */
  readonly textClassName?: string;
}

export function ProfileAvatar({
  initials,
  color,
  image,
  className,
  textClassName,
}: ProfileAvatarProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-center overflow-hidden rounded-full text-white",
        className,
      )}
      style={image ? undefined : { backgroundColor: color }}
    >
      {image ? (
        <img src={image} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <span className={cn("font-semibold tracking-tight", textClassName)}>{initials}</span>
      )}
    </div>
  );
}
