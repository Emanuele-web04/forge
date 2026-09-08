// FILE: ComputerSetupRequiredCard.test.tsx
// Purpose: Locks the setup card to the present tense — the OS dialog is already on
//          screen by the time this card renders, and Set up is how it comes back.
// Layer: Chat transcript UI regression test

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComputerSetupRequiredCard } from "./ComputerSetupRequiredCard";

describe("ComputerSetupRequiredCard", () => {
  it("says macOS is asking, and that Set up asks again", () => {
    const markup = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility", "screenRecording"]}
        onSetUp={() => undefined}
      />,
    );

    expect(markup).toContain("Computer control needs Accessibility and Screen Recording");
    expect(markup).toContain(
      "macOS is asking for Accessibility and Screen Recording. If you dismissed the dialog, Set up asks again.",
    );
    // The old copy described a failure in the past tense and sent the user
    // hunting through System Settings while a dialog was waiting for them.
    expect(markup).not.toContain("The agent tried to act on the desktop");
    expect(markup).toContain("Set up");
  });

  it("falls back to the unnamed grant when the backend refused without naming one", () => {
    const markup = renderToStaticMarkup(<ComputerSetupRequiredCard onSetUp={() => undefined} />);

    expect(markup).toContain("Computer control needs setup");
    expect(markup).toContain("macOS is asking for the permission Synara needs");
  });

  it("explains a locally built copy's stale grant, and says nothing of it on a signed build", () => {
    // The case that looks like a Synara bug: System Settings shows Synara
    // switched on, because the grant it lists belongs to a binary a rebuild
    // replaced. Without this the card tells the user to flip a switch that is
    // already flipped.
    const adhoc = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility"]}
        buildSignature="adhoc"
        onSetUp={() => undefined}
      />,
    );
    expect(adhoc).toContain("locally built copy");
    expect(adhoc).toContain("allow the dialog when it appears");

    const signed = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility"]}
        buildSignature="signed"
        onSetUp={() => undefined}
      />,
    );
    // On a Developer ID build the switch means what it says, so this advice
    // would send the user off resetting a database for nothing.
    expect(signed).not.toContain("locally built copy");
    expect(signed).not.toContain("tccutil");
  });

  it("names the responsible app in the tccutil fallback, and withholds it when unknown", () => {
    // The command has to repair *this* Synara's TCC row. `.dev` and `.canary`
    // are separate bundle identifiers, so a guessed production id would revoke a
    // separately installed release build's working grants and fix nothing here.
    const known = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility"]}
        buildSignature="adhoc"
        bundleId="com.emanueledipietro.synara.dev"
        onSetUp={() => undefined}
      />,
    );
    expect(known).toContain("tccutil reset Accessibility com.emanueledipietro.synara.dev");

    // A server with no desktop shell behind it has no responsible app, and the
    // card must say nothing rather than guess.
    const unknown = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility"]}
        buildSignature="adhoc"
        onSetUp={() => undefined}
      />,
    );
    expect(unknown).toContain("allow the dialog when it appears");
    expect(unknown).not.toContain("tccutil");
  });

  it("drops the button once the grants have landed", () => {
    const markup = renderToStaticMarkup(
      <ComputerSetupRequiredCard
        missing={["accessibility"]}
        computerControlReady
        onSetUp={() => undefined}
      />,
    );

    expect(markup).toContain("Computer control is ready");
    expect(markup).not.toContain("macOS is asking");
    expect(markup).not.toContain(">Set up<");
  });
});
