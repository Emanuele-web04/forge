# Remote hosts — what was actually observed

Every command below was run against real Docker containers over real ssh,
driving the shipped production modules. No mocks. Reproduce with `up.sh` and
`up-authed.sh` in this directory.

Recorded against branch `feat/remote-hosts-combined`, artifacts built by
`bun run scripts/cli.ts build && … pack` plus `scripts/fetch-node-runtime.ts`.

## What worked, verbatim

### 1. Probe over real ssh

```
{ "outcome": "ok", "message": "The host is ready.", "version": "v22.23.2" }
```

### 2. Bootstrap — all 8 stages, on BOTH hosts independently

```
preparing → uploading:server-tarball → verifying:server-tarball
→ uploading:node-runtime → verifying:node-runtime
→ extracting → activating → installing-supervisor
```

Each host ended with its own release and its own pinned runtime:

```
release: demo-bfc1cca1     node: v22.21.1
```

### 3. Separate filesystems

Wrote `~/proj-alpha` on host A only:

```
host A: proj-alpha
host B: ls: cannot access '/home/synara/proj-alpha': No such file or directory
```

### 4. Separate journals / sequence spaces

```
host A env-id: 11111111-1111-4111-8111-111111111111
host B env-id: 22222222-2222-4222-8222-222222222222
```

Separate state directories, each with its own `auth-token`.

### 5. Distinct minted credentials

```
host A token prefix: x6XWqPYZeUa7
host B token prefix: LExLaOn97wO4   → DISTINCT
```

### 6. NO provider credential crossed

Neither host has `~/.codex` or `~/.claude`. The only match for a key pattern
anywhere under the install root is the literal string `ANTHROPIC_API_KEY` —
the env-var NAME compiled into the server bundle, not key material. Checked
for `sk-…` on both hosts: none.

### 7. Unauthenticated state is real and detected

```
providers: NONE (unauthenticated)
```

Both containers have no provider CLI on PATH and no provider config, which is
the state the "sign in on this host" copy exists for.

### 8. Host-key classification, against REAL ssh output

```
UNKNOWN-KEY -> host-key-unknown | This host has not been seen before. Check its
   fingerprint matches your server, then trust it — Synara will not skip this check.
CHANGED-KEY -> host-key-changed | This host's key does not match the one Synara
   saw before. That can mean the server was rebuilt, or that something is
   impersonating it. Synara will not connect until you confirm which.
```

Only the first invites trust. Hit live: host B genuinely failed with
`Host key verification failed.` before it was trusted.

### 9. Fingerprint matches ground truth

Product code and `ssh-keygen -lf` agree exactly:

```
ed25519  SHA256:4stLyCaK1q0WgEKyaapBy2Q7JEaTRG0xPCNaaWIvz1M   (product)
         SHA256:4stLyCaK1q0WgEKyaapBy2Q7JEaTRG0xPCNaaWIvz1M   (ssh-keygen)
```

### 10. The security allowlist refused a real config

Passing `-o UserKnownHostsFile=…` through `sshArgs` was REFUSED, with the
guidance the design promises: put it under a `Host` alias in `~/.ssh/config`
and use the alias. Doing that worked.

## A real remote Mac over Tailscale

Not a container: a separate physical machine (`platos-mac-studio`, darwin-arm64)
reached over Tailscale, driven by the shipped broker.

**The probe diagnosed a real environment problem and said how to fix it.** Node
was not on the non-interactive PATH — the common macOS case. Rather than
failing, the probe retried through a login shell and reported:

```json
{
  "outcome": "ok",
  "message": "The host works through a login shell. Switch this host's launcher to login-shell.",
  "version": "v24.18.0",
  "suggestedLauncher": { "kind": "login-shell" }
}
```

Taking its advice produced `"The host is ready."` — and the probe SIGNATURE
changed (`b91bdef…` → `2764db0…`), so the freshness rule held: editing the
launcher invalidated the cached result instead of vouching for a command that
would no longer run.

**Real code ran on the real remote machine** via `broker.sessionInvocation`,
the only supported way to build a session command:

```
ARGV: ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 …
REMOTE SAYS: {"host":"Platos-Mac-Studio.local","arch":"arm64","node":"v24.18.0"}
```

The security posture is visible in that argv on a live connection, not only in
tests: batch mode, strict host-key checking, explicit timeout.

**Bootstrap was not attempted there, by design.** The artifact fetcher supports
`linux-x64` and `linux-arm64` only and refuses anything else by name, matching
`supervisorCapability`'s darwin refusal. Shipping a Linux runtime to a Mac
would have proven nothing.

**An honest aside that is itself evidence.** The first attempts failed because
the authorized key was passphrase-protected and not in the agent: ssh offered
it, the server ACCEPTED it, and the client then could not sign under
`BatchMode=yes`. That is exactly the failure Synara's `auth` copy describes —
"Add a key ssh can use without a passphrase prompt, or load it into your
agent." The message was accurate about a failure hit for real.

## What did NOT work, and why

### The supervisor step fails on these containers

```
ended: Remote command failed (exit 127): systemctl --user daemon-reload
```

`node:22-bookworm-slim` has no systemd. `supervisorCapability` is
linux/systemd-only by design, so this is the documented unsupported path, not
a regression. Everything BEFORE the supervisor completed on both hosts.

**This found a real bug.** The first-install rollback ran `systemctl stop`
BEFORE removing the `current` symlink, so on a host without systemd the
rollback aborted and left `current` pointing at a release that never passed
its handshake. Fixed (rm first, stop best-effort) and pinned with a test that
fails against the old ordering. Re-ran live: `current: ABSENT (rolled back)`.

### A systemd container was tried, and did not close the gap

`Dockerfile.systemd` + `up-systemd.sh` are included: Debian with systemd 252,
Node 22.21.1, privileged, host cgroups. systemd itself runs. But
`user@1000.service` fails inside Docker with `$XDG_RUNTIME_DIR is not set`
because `pam_systemd.so` is faulty in a container, and it still failed after
creating `/run/user/1000` by hand, setting `XDG_RUNTIME_DIR` via
`PermitUserEnvironment`, and starting dbus. `systemctl --user` needs a real
login session that Docker does not provide.

The scripts are left in place because they are most of the way there and a
maintainer on a real Linux VPS needs none of the workarounds — but ON DOCKER,
the supervisor step cannot be demonstrated. That is a container limitation,
not a product one.

### No tunnel/handshake leg in this demo

`probeHandshake` was deliberately stubbed to throw. The tunnel and handshake
have their own tests; proving them here needs a running remote server, which
needs the supervisor, which needs systemd. **A running session on a remote
host has NOT been demonstrated end to end.**

### ssh localhost

Not usable on this machine: sshd refuses pubkey auth for this account and
changing it needs sudo the agent does not have. The localhost leg would in any
case share this machine's filesystem, home directory and journal — which is
exactly what makes it unable to show items 3, 4 and 5 above. The Docker pair
is the stronger evidence and is what was run.

## Honest summary

Proven live: probe, upload, digest verification on the far side, extract,
activate, per-host isolation of filesystem/journal/credential, no credential
leakage, host-key classification and fingerprinting, and the rollback path
(including a bug it exposed).

Not proven live: supervisor install, tunnel, handshake, and a session actually
running remotely. Those need a systemd host. A maintainer with a real Linux
VPS can run the same script against it.
