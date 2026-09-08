# Host Secrets sync end-to-end encrypted with a device-chain key

Per-host configuration (SSH destination, launcher config, key-verification policy) syncs across the owner's devices so a second desktop works without re-setup. It is end-to-end encrypted: the cloud stores ciphertext only, keeping the "cloud is a directory + pipe" invariant even though we sync everything.

Key model: the owner's first device generates a random Sync Key; each new device receives it during device pairing. No passphrase (forgettable, phishable), no platform-keychain wrapping (murky cross-platform). Consequence: losing all devices loses the synced Host Secrets — the user re-enters host configs; the hosts themselves stay registered and reachable via relay.
