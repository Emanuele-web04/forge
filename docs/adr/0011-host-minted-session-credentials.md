# The host mints session credentials; the cloud can authorize but never fabricate access

Adopted from t3code's production-proven model. Each host holds an Ed25519 keypair generated at registration; the public key is stored in the directory at link time (the link itself is proven by a signed challenge with nonce replay protection).

A relay grant (ADR 0006) still authorizes the _splice_ — the API decides who may be connected to which host. But the session credential the client actually uses is minted by the **host**: on splice, the relay forwards a short-lived, client-bound mint request; the host verifies it against directory-published keys and mints the credential itself.

Precision on the threat model (sharpened during Slice A review): the API is the authorization authority, so **API signing-key compromise can authorize sessions** to linked hosts — host minting does not prevent that. What the design does guarantee: relay compromise fabricates nothing (the relay signs nothing); API compromise cannot impersonate a host, cannot decrypt Host Secrets, and cannot obtain _silent_ access — every session requires the host to be online and to mint, hosts enforce their last-known owner/discoverability policy at mint time, and sessions are visible in the host's UI. The cloud can lie about _who may enter_, but never _as_ a host, and never invisibly.

Rejected: trusting spliced connections outright (cloud fully trusted), and JWKS-only user verification at the host (cloud compromise could still bypass discoverability rules). We accept the extra keypair infrastructure; it also gives hosts a signing identity that E2E secrets sync (ADR 0004) and future integrity needs can reuse.
