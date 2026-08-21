// FILE: bootstrap.ts
// Purpose: Completes synchronous renderer storage migration before any app store can hydrate.

import "./storageOriginMigration";

import { bootstrapSignedOutScreen } from "./authSignedOut";
import { bootstrapPairingSession } from "./pairingBootstrap";
import { registerPwaServiceWorker } from "./pwaRegistration";
import { bootstrapRemoteAuthGate } from "./remoteAuthGate";
import { claimSessionBearerFromLocation } from "./sessionBearer";

registerPwaServiceWorker();

if (typeof window !== "undefined") {
  claimSessionBearerFromLocation(window.location, window.history);
}

if (!bootstrapSignedOutScreen()) {
  void bootstrapPairingSession().then(async (result) => {
    if (result !== "not-pairing") {
      return;
    }
    if ((await bootstrapRemoteAuthGate()) === "blocked") {
      return;
    }
    await import("./main");
  });
}
