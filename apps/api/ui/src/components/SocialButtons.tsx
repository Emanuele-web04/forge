// FILE: ui/src/components/SocialButtons.tsx
// Purpose: Social sign-in buttons — one per provider the instance enables,
// with the provider's own mark inline so the page ships no icon dependency.
// Layer: Account UI presentation
// Depends on: React, authClient, instance types.

import { useState, type ReactNode } from "react";
import { authClient } from "../authClient";
import { errorMessage } from "../errors";
import type { SocialProvider } from "../instance";
import { Spinner } from "./Field";

const PROVIDER_LABEL: Record<SocialProvider, string> = {
  github: "GitHub",
  google: "Google",
  apple: "Apple",
  microsoft: "Microsoft",
};

function GitHubMark(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 fill-current">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function GoogleMark(): ReactNode {
  return (
    <svg viewBox="0 0 18 18" aria-hidden className="size-4">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

function AppleMark(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 fill-current">
      <path d="M11.18 8.48c-.02-1.72 1.4-2.55 1.47-2.59-.8-1.17-2.05-1.33-2.5-1.35-1.06-.11-2.07.62-2.61.62-.54 0-1.37-.6-2.25-.59-1.16.02-2.23.67-2.83 1.7-1.2 2.09-.31 5.18.86 6.87.58.83 1.27 1.76 2.17 1.72.87-.03 1.2-.56 2.25-.56 1.05 0 1.35.56 2.27.54.94-.02 1.53-.84 2.1-1.67.66-.96.93-1.89.95-1.94-.02-.01-1.82-.7-1.84-2.75ZM9.47 3.02c.48-.58.8-1.39.71-2.19-.69.03-1.52.46-2.01 1.03-.44.51-.83 1.33-.72 2.12.77.06 1.55-.39 2.02-.96Z" />
    </svg>
  );
}

function MicrosoftMark(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4">
      <path fill="#F25022" d="M1 1h6.5v6.5H1z" />
      <path fill="#7FBA00" d="M8.5 1H15v6.5H8.5z" />
      <path fill="#00A4EF" d="M1 8.5h6.5V15H1z" />
      <path fill="#FFB900" d="M8.5 8.5H15V15H8.5z" />
    </svg>
  );
}

const PROVIDER_MARK: Record<SocialProvider, () => ReactNode> = {
  github: GitHubMark,
  google: GoogleMark,
  apple: AppleMark,
  microsoft: MicrosoftMark,
};

export function SocialButtons({
  providers,
  callbackURL,
  verb,
  onError,
}: {
  providers: readonly SocialProvider[];
  callbackURL: string;
  verb: "Sign in" | "Sign up";
  onError: (message: string) => void;
}): ReactNode {
  const [pending, setPending] = useState<SocialProvider | undefined>(undefined);

  if (providers.length === 0) return null;

  async function start(provider: SocialProvider): Promise<void> {
    setPending(provider);
    onError("");
    const { error } = await authClient.signIn.social({ provider, callbackURL });
    // A successful call navigates away, so reaching here at all means the
    // redirect never happened and the button should become usable again.
    if (error) onError(errorMessage(error, `Could not start ${PROVIDER_LABEL[provider]} sign-in.`));
    setPending(undefined);
  }

  return (
    <div className="space-y-2">
      {providers.map((provider) => {
        const Mark = PROVIDER_MARK[provider];
        return (
          <button
            key={provider}
            type="button"
            disabled={pending !== undefined}
            onClick={() => void start(provider)}
            className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-line bg-canvas/40 px-3 py-2.5 text-[14px] font-medium text-ink transition-colors duration-150 hover:border-line/90 hover:bg-canvas/80 disabled:cursor-not-allowed disabled:opacity-55 motion-reduce:transition-none"
          >
            {pending === provider ? <Spinner /> : <Mark />}
            {verb} with {PROVIDER_LABEL[provider]}
          </button>
        );
      })}
    </div>
  );
}
