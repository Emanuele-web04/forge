// FILE: ui/src/pages/Callback.tsx
// Purpose: /callback — where a completed social sign-in lands, then hands off
// to the device flow, the desktop app, or a plain confirmation.
// Layer: Account UI page
// Depends on: authClient session, nav intent helpers.

import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { authClient } from "../authClient";
import { Notice, Spinner } from "../components/Field";
import { Shell } from "../components/Shell";
import { deepLinkUrl } from "../nav";

export function Callback(): ReactNode {
  const { search } = useLocation();
  const navigate = useNavigate();
  const session = authClient.useSession();
  const [handedOff, setHandedOff] = useState(false);

  const params = new URLSearchParams(search);
  const userCode = params.get("user_code");
  const wantsDevice = params.get("redirect") === "device" || Boolean(userCode);
  const deepLink = deepLinkUrl(search);
  const signedIn = Boolean(session.data);

  useEffect(() => {
    if (!signedIn || !wantsDevice) return;
    navigate(userCode ? `/device?user_code=${encodeURIComponent(userCode)}` : "/device", {
      replace: true,
    });
  }, [signedIn, wantsDevice, userCode, navigate]);

  // The desktop hand-off is best-effort: the browser gives no signal about
  // whether the scheme resolved, so the visible fallback link always stays.
  useEffect(() => {
    if (!signedIn || wantsDevice || !deepLink || handedOff) return;
    setHandedOff(true);
    window.location.href = deepLink;
  }, [signedIn, wantsDevice, deepLink, handedOff]);

  if (session.isPending) {
    return (
      <Shell title="Finishing sign-in">
        <div className="flex justify-center py-6 text-ink-faint">
          <Spinner />
        </div>
      </Shell>
    );
  }

  if (!signedIn) {
    return (
      <Shell title="Sign-in did not complete" subtitle="The provider did not return a session.">
        <div className="space-y-4">
          <Notice tone="error">
            {session.error?.message ??
              "No active session was created. Please try signing in again."}
          </Notice>
          <Link
            to="/login"
            className="block w-full rounded-lg bg-accent px-3 py-2.5 text-center text-[14px] font-medium text-accent-ink transition-opacity duration-150 hover:opacity-90 motion-reduce:transition-none"
          >
            Back to sign in
          </Link>
        </div>
      </Shell>
    );
  }

  if (wantsDevice) {
    return (
      <Shell title="Signed in" subtitle="Taking you to the device approval screen.">
        <div className="flex justify-center py-6 text-ink-faint">
          <Spinner />
        </div>
      </Shell>
    );
  }

  if (deepLink) {
    return (
      <Shell
        title="Signed in"
        subtitle="Returning you to the Synara app. If nothing happens, use the link below."
      >
        <a
          href={deepLink}
          className="block w-full rounded-lg bg-accent px-3 py-2.5 text-center text-[14px] font-medium text-accent-ink transition-opacity duration-150 hover:opacity-90 motion-reduce:transition-none"
        >
          Return to Synara
        </a>
      </Shell>
    );
  }

  return (
    <Shell
      title="Signed in"
      subtitle={session.data ? `You are signed in as ${session.data.user.email}.` : undefined}
    >
      <Notice tone="success">Signed in — return to the app.</Notice>
    </Shell>
  );
}
