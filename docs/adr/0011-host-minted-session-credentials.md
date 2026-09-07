# The host mints session credentials; the cloud can authorize but never fabricate access

Adopted from the production-proven model in the upstream project Synara was forked from (see README "Origins"). Each host holds an Ed25519 keypair generated at registration; the public key is stored in the directory at link time (the link itself is proven by a signed challenge with nonce replay protection).

A relay grant (ADR 0006) still authorizes the _splice_ — the API decides who may be connected to which host. But the session credential the client actually uses is minted by the **host**: on splice, the relay forwards a short-lived, client-bound mint request; the host verifies it against directory-published keys and mints the credential itself.

Precision on the threat model (sharpened during Slice A review, **corrected against the implementation after the epic-wide review**): the API is the authorization authority, so **API signing-key compromise can authorize sessions** to linked hosts — host minting does not prevent that.

What the design actually guarantees:

- **Relay compromise fabricates nothing.** The relay signs nothing and holds no key material; it can deny service or misroute, but cannot mint or authorize.
- **API compromise cannot impersonate a host.** Only the host holds its Ed25519 private key, so a compromised cloud cannot produce a session credential, decrypt Host Secrets, or answer as the host.
- **Access requires a live host.** Every session needs the host online and willing to mint; there is no offline path into a machine.

What it does **not** guarantee, contrary to an earlier draft of this ADR: the host does **not** enforce a locally cached policy. `HostMintService` calls `GET /hosts/:id/authorization` live at mint time (`apps/server/src/hostAuth/mintService.ts`), so under API compromise the same adversary answers both the grant and the authorization question. The value that check does provide is _revocation freshness_ against an honest API — a grant issued moments before discoverability-off is still refused. The link-time `hostOwnerUserId` is recorded but not consulted at mint, and there is no host-side session UI.

Pinning the owner short-circuit to the link-time record — so the owner's own access survives both cloud compromise and cloud outage without an API round trip — is a worthwhile follow-up, and is tracked in `docs/specs/remote-hosts-follow-ups.md`. It is deliberately not claimed here as shipped.

Rejected: trusting spliced connections outright (cloud fully trusted), and JWKS-only user verification at the host (cloud compromise could still bypass discoverability rules). We accept the extra keypair infrastructure; it also gives hosts a signing identity that E2E secrets sync (ADR 0004) and future integrity needs can reuse.
