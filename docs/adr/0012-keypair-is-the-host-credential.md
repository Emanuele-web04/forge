# The Ed25519 keypair is the host's only credential

The host keypair (ADR 0011) is not an addition alongside the `synhost_` bearer token — it replaces it. The host authenticates all API interaction by signature (directly, or by exchanging a signed proof for a short-lived token); revocation = deleting the public key from the directory; the one-live-bearer-token machinery and its rotation semantics are removed rather than maintained in parallel.

One identity, one revocation point, no two-credential consistency problem. Cost: host↔API auth changes shape, accepted because we are pre-launch and doing a hard cutover (no dual-path auth era).

Consequence for existing deployments: **hard cutover, no migration**. Deployed hosts against the current API are force re-linked — old host tokens are invalidated when the new schema ships, and every host runs the new link flow (signed challenge) on upgrade. We deliberately do not carry lazy-upgrade dual-auth code for a pre-launch product.
