// FILE: ui/src/pages/NotFound.tsx
// Purpose: Catch-all for unknown ceremony paths.
// Layer: Account UI page
// Depends on: Shell.

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Shell } from "../components/Shell";

export function NotFound(): ReactNode {
  return (
    <Shell title="Page not found" subtitle="There is nothing at this address.">
      <Link
        to="/login"
        className="block w-full rounded-lg bg-accent px-3 py-2.5 text-center text-[14px] font-medium text-accent-ink transition-opacity duration-150 hover:opacity-90 motion-reduce:transition-none"
      >
        Go to sign in
      </Link>
    </Shell>
  );
}
