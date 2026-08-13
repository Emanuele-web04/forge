# The host mints session credentials; the cloud can authorize but never fabricate access

Adopted from t3code's production-proven model. Each host holds an Ed25519 keypair generated at registration; the public key is stored in the directory at link time (the link itself is proven by a signed challenge with nonce replay protection).

A relay grant (ADR 0006) still authorizes the *splice* — the API decides who may be connected to which host. But the session credential the client actually uses is minted by the **host**: on splice, the relay forwards a short-lived, client-bound mint request; the host verifies it against directory-published keys and mints the credential itself. Consequence: a compromised relay or API cannot fabricate access to anyone's machine — for a product that hands out code execution, the cloud must not be able to let itself in.

Rejected: trusting spliced connections outright (cloud fully trusted), and JWKS-only user verification at the host (cloud compromise could still bypass discoverability rules). We accept the extra keypair infrastructure; it also gives hosts a signing identity that E2E secrets sync (ADR 0004) and future integrity needs can reuse.
