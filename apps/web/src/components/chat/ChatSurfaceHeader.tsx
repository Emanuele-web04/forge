import type { ReactNode } from "react";

export function ChatSurfaceHeader(props: {
  readonly hidden?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  if (props.hidden) return null;
  return <header className={props.className}>{props.children}</header>;
}
