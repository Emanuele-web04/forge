// FILE: ui/src/pages/Device.tsx
// Purpose: /device — the OAuth device-authorization consent screen, where a
// signed-in user approves a code shown on another machine.
// Layer: Account UI page
// Depends on: authClient (device-authorization plugin), shared primitives.

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../authClient";
import { Field, Notice, Spinner, SubmitButton } from "../components/Field";
import { Shell } from "../components/Shell";
import { errorMessage } from "../errors";

type VerifyState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready" }
  | { status: "settled"; outcome: "approved" | "denied" }
  | { status: "error"; message: string };

/** Renders `ABCD1234` as `ABCD-1234`, matching how devices display the code. */
function formatUserCode(code: string): string {
  const clean = code.replaceAll("-", "").toUpperCase();
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

export function Device(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const session = authClient.useSession();

  const queryUserCode = searchParams.get("user_code") ?? "";
  const [codeInput, setCodeInput] = useState(queryUserCode);
  const [verify, setVerify] = useState<VerifyState>({ status: "idle" });
  const [pending, setPending] = useState<"approve" | "deny" | undefined>(undefined);

  const signedIn = Boolean(session.data);

  // Signed out: bounce to /login, carrying the code so the user lands back here
  // with the consent screen already populated.
  useEffect(() => {
    if (session.isPending || signedIn) return;
    const params = new URLSearchParams({ redirect: "device" });
    if (queryUserCode) params.set("user_code", queryUserCode);
    navigate(`/login?${params.toString()}`, { replace: true });
  }, [session.isPending, signedIn, queryUserCode, navigate]);

  // `GET /device` is not just a status read: it binds a pending code to the
  // current session. Approving without it fails as an unclaimed device code.
  const claimCode = useCallback(async (userCode: string): Promise<void> => {
    setVerify({ status: "checking" });
    const { data, error } = await authClient.device({ query: { user_code: userCode } });
    if (error) {
      setVerify({
        status: "error",
        message: errorMessage(error, "That code is not valid. Check the code on your device."),
      });
      return;
    }
    const status = data?.status;
    if (status === "approved" || status === "denied") {
      setVerify({ status: "settled", outcome: status });
      return;
    }
    setVerify({ status: "ready" });
  }, []);

  useEffect(() => {
    if (!signedIn || !queryUserCode) return;
    void claimCode(queryUserCode);
  }, [signedIn, queryUserCode, claimCode]);

  async function decide(outcome: "approve" | "deny"): Promise<void> {
    setPending(outcome);
    const call = outcome === "approve" ? authClient.device.approve : authClient.device.deny;
    const { error } = await call({ userCode: queryUserCode });
    setPending(undefined);
    if (error) {
      setVerify({
        status: "error",
        message: errorMessage(error, "Could not complete that action."),
      });
      return;
    }
    setVerify({ status: "settled", outcome: outcome === "approve" ? "approved" : "denied" });
  }

  function onCodeSubmit(event: FormEvent): void {
    event.preventDefault();
    const clean = codeInput.replaceAll("-", "").trim().toUpperCase();
    if (!clean) return;
    setSearchParams({ user_code: clean }, { replace: true });
  }

  if (session.isPending || (!signedIn && !session.error)) {
    return (
      <Shell title="Connect a device">
        <div className="flex justify-center py-6 text-ink-faint">
          <Spinner />
        </div>
      </Shell>
    );
  }

  if (verify.status === "settled") {
    const approved = verify.outcome === "approved";
    return (
      <Shell
        title={approved ? "Device connected" : "Request denied"}
        subtitle={
          approved
            ? "You can close this tab — the device is signing in now."
            : "That device was not granted access to your account."
        }
      >
        <Notice tone={approved ? "success" : "info"}>
          {approved
            ? "Device connected — you can close this tab."
            : "Nothing was shared with that device."}
        </Notice>
      </Shell>
    );
  }

  // No code in the URL: let the user type the one shown on their device.
  if (!queryUserCode) {
    return (
      <Shell
        title="Connect a device"
        subtitle="Enter the code shown on the device you want to connect."
      >
        <form onSubmit={onCodeSubmit} className="space-y-4">
          <Field
            label="Device code"
            name="user_code"
            required
            autoFocus
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            value={codeInput}
            placeholder="ABCD-1234"
            className="block w-full rounded-lg border border-line bg-canvas/60 px-3 py-2.5 text-center font-mono text-[18px] tracking-[0.25em] text-ink uppercase transition-colors duration-150 outline-none placeholder:tracking-[0.25em] placeholder:text-ink-faint focus:border-accent motion-reduce:transition-none"
            onChange={(e) => setCodeInput(e.target.value)}
          />
          <SubmitButton>Continue</SubmitButton>
        </form>
      </Shell>
    );
  }

  return (
    <Shell
      title="Connect a device"
      subtitle={
        session.data
          ? `Signed in as ${session.data.user.email}.`
          : "Confirm this code came from a device you own."
      }
      footer={
        <button
          type="button"
          onClick={() => {
            setVerify({ status: "idle" });
            setCodeInput("");
            setSearchParams({}, { replace: true });
          }}
          className="transition-colors duration-150 hover:text-ink-muted motion-reduce:transition-none"
        >
          Use a different code
        </button>
      }
    >
      <div className="space-y-5">
        <div className="rounded-xl border border-line bg-canvas/50 px-4 py-5 text-center">
          <p className="text-[11.5px] tracking-[0.14em] text-ink-faint uppercase">Device code</p>
          <p className="mt-2 font-mono text-[26px] tracking-[0.18em] text-ink">
            {formatUserCode(queryUserCode)}
          </p>
        </div>

        {verify.status === "checking" ? (
          <div className="flex justify-center py-2 text-ink-faint">
            <Spinner />
          </div>
        ) : null}

        {verify.status === "error" ? <Notice tone="error">{verify.message}</Notice> : null}

        {verify.status === "ready" ? (
          <>
            <p className="text-[13.5px] leading-relaxed text-ink-muted">
              Only continue if this code matches the one displayed on your device. Approving grants
              it access to your Synara account.
            </p>
            <div className="space-y-2">
              <SubmitButton
                type="button"
                pending={pending === "approve"}
                disabled={pending !== undefined}
                onClick={() => void decide("approve")}
              >
                Approve
              </SubmitButton>
              <button
                type="button"
                disabled={pending !== undefined}
                onClick={() => void decide("deny")}
                className="w-full rounded-lg border border-line px-3 py-2.5 text-[14px] font-medium text-ink-muted transition-colors duration-150 hover:border-danger/40 hover:text-danger disabled:cursor-not-allowed disabled:opacity-55 motion-reduce:transition-none"
              >
                Deny
              </button>
            </div>
          </>
        ) : null}
      </div>
    </Shell>
  );
}
