# Host enrollment paths and the Desktop host lifecycle

Three enrollment paths, all ending in the same signed link challenge (ADR 0011/0012):

1. **Desktop sign-in (primary)**: the bundled local host auto-registers when the user signs in — zero ceremony; hosts mostly come to exist this way. In a multi-member org, first sign-in prompts before making the host discoverable (ADR 0002).
2. **Desktop SSH bootstrap**: Desktop provisions a remote machine and seeds the link during provisioning.
3. **Device-code flow (headless)**: CLI on a browserless box prints a short code + URL; the owner approves from any signed-in browser (OAuth device-authorization shape). Covers raw VPSes without Desktop involvement.

Sign-out unlinks the Desktop's host: public key removed from the directory, other devices' sessions to it killed; the app keeps working fully local. Signing into another account re-links under the new owner with a fresh keypair — no orphan registrations, no signed-out machine serving an account.

Device removal (lost/stolen): the API refuses the device key and push-revokes its live sessions, and a surviving device rotates the Sync Key, re-encrypting Host Secrets so the removed device cannot decrypt future ciphertext.
