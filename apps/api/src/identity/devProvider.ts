// FILE: identity/devProvider.ts
// Purpose: The "dev" identity provider — a second, offline implementation of
// the adapter seam so contributors can hack on Synara accounts with no hosted
// identity tenancy. It runs the same in-process identity double the test
// suite uses (testing/fakeWorkos.ts) on an ephemeral port and points the
// hosted-provider adapter at it, so there is exactly one implementation of
// the grant mechanics and the double stays the single source of fake
// behavior. One-time sign-in codes are printed to stdout instead of emailed;
// SSO device authorizations self-approve after a short delay.
// Layer: API identity (implementation, development only)
// Depends on: config (the safety gate), testing/fakeWorkos.ts, workos.ts.

import { assertDevIdentityAllowed } from "../config";
import { startFakeWorkos } from "../testing/fakeWorkos";
import type { AccountIdentityVerifier, EnvironmentGrantIssuer } from "./interfaces";
import { createWorkosIdentityProvider } from "./workos";

/**
 * How long a device authorization waits before self-approving — long enough
 * that the client demonstrably polls at least once, short enough not to feel
 * broken. Stands in for the human clicking through the hosted approval page.
 */
const DEVICE_APPROVE_DELAY_MS = 3_000;

/**
 * Builds the dev provider. Re-checks the safety gate on its own (not only in
 * config loading) so a hand-built config cannot reach it in production or on
 * a machine holding a real identity-provider secret.
 */
export async function createDevIdentityProvider(): Promise<{
  verifier: AccountIdentityVerifier;
  grants: EnvironmentGrantIssuer;
  close(): Promise<void>;
}> {
  assertDevIdentityAllowed(process.env);

  const fake = await startFakeWorkos({
    // DELIBERATE, GATED EXCEPTION to the no-leak rules: the emailed one-time
    // code goes to stdout, because there is no email here and the operator at
    // this terminal IS the intended recipient. The gate above is what makes
    // this printable — the dev provider cannot start anywhere a real user's
    // code could end up in a production log.
    onMagicAuth(email, code) {
      console.log(`[dev-identity] OTP for ${email}: ${code}`);
    },
    // The PKCE authorize page self-approves as the dev user: the browser hits
    // the fake's authorize endpoint and is 302'd straight back to the app's
    // loopback listener with a code — the offline stand-in for the human
    // finishing the hosted provider page.
    autoApproveAuthorizeAs: "dev-user@example.com",
    onDeviceAuthorization(deviceCode) {
      console.log(
        `[dev-identity] device authorization requested; approving in ${DEVICE_APPROVE_DELAY_MS / 1000}s`,
      );
      const timer = setTimeout(() => {
        const user = fake.approveDevice(deviceCode, { first_name: "Dev", last_name: "User" });
        console.log(`[dev-identity] device authorization approved as ${user.email}`);
      }, DEVICE_APPROVE_DELAY_MS);
      // Never keep the process alive just to approve a device code.
      timer.unref();
    },
  });

  // The provider adapter pointed at the in-process double: same verification,
  // same grants, same classification — proving the seam seals with a second
  // deployment shape rather than forking the logic.
  const { verifier, grants } = createWorkosIdentityProvider({
    identityProvider: "workos",
    // The db and server wiring never read these three through the provider;
    // they exist because the adapter's config shape requires them.
    databaseUrl: "unused://dev-identity",
    baseUrl: "http://localhost",
    port: 0,
    trustedProxyHops: 0,
    workosApiKey: fake.apiKey,
    workosClientId: fake.clientId,
    workosApiUrl: fake.origin,
  });

  return {
    verifier,
    grants,
    close: () => fake.close(),
  };
}
