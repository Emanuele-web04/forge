# Remote access

Use an HTTPS reverse proxy in front of Synara's loopback listener. For a private
Android/desktop setup, Tailscale Serve is the simplest supported path: Synara
stays reachable only from the local machine, while Tailscale supplies the
tailnet-only HTTPS endpoint and certificate.

Do not bind Synara directly to a LAN or Tailnet interface unless you explicitly
need plaintext remote access. Synara rejects unsafe remote binds by default.

## Configuration map

The server CLI accepts these flags and equivalent environment variables:

| CLI flag                     | Environment variable              | Purpose                                                |
| ---------------------------- | --------------------------------- | ------------------------------------------------------ |
| `--mode <web\|desktop>`      | `SYNARA_MODE`                     | Runtime mode.                                          |
| `--port <number>`            | `SYNARA_PORT`                     | HTTP/WebSocket port.                                   |
| `--host <address>`           | `SYNARA_HOST`                     | Bind address. Keep this loopback for Tailscale Serve.  |
| `--public-url <https-origin>` | `SYNARA_PUBLIC_URL`               | HTTPS origin presented by the reverse proxy.           |
| `--home-dir <path>`          | `SYNARA_HOME`                     | Base directory.                                        |
| `--dev-url <url>`            | `VITE_DEV_SERVER_URL`             | Development web URL redirect/proxy target.             |
| `--no-browser`               | `SYNARA_NO_BROWSER`               | Disable automatic browser launch.                      |
| `--auth-token <token>`       | `SYNARA_AUTH_TOKEN`               | Bootstrap authentication secret.                       |
| `--allow-insecure-remote`    | `SYNARA_ALLOW_INSECURE_REMOTE`    | Explicitly allow an unencrypted non-loopback listener. |
| Desktop only                 | `SYNARA_KEEP_RUNNING_AFTER_CLOSE` | Set to `1` to keep the packaged backend running.       |

Run the server with `--help` for the current full option list.

## Packaged Windows desktop with Tailscale Serve

Choose a fixed local port, such as `3773`, and find the HTTPS MagicDNS URL that
Tailscale assigns to this Windows device, for example
`https://workstation.example-tailnet.ts.net`.

Configure these environment variables for the packaged Synara process:

```powershell
$env:SYNARA_PORT = "3773"
$env:SYNARA_HOST = "127.0.0.1"
$env:SYNARA_PUBLIC_URL = "https://workstation.example-tailnet.ts.net"
$env:SYNARA_KEEP_RUNNING_AFTER_CLOSE = "1"
```

Then start Synara and configure the persistent HTTPS proxy:

```powershell
tailscale serve --bg 3773
tailscale serve status
```

Synara writes a one-time owner pairing URL when a public URL is configured. For
the default packaged installation, retrieve the newest one from the child log:

```powershell
Select-String `
  -Path "$HOME\.synara\userdata\logs\server-child.log" `
  -Pattern 'pairingUrl' |
  Select-Object -Last 1
```

If `SYNARA_HOME` points elsewhere, use its `userdata\logs\server-child.log`.
Open the complete pairing URL on Android while signed in to the same
tailnet. Prefer Chrome; Brave shields can block the session cookie. Copy the
whole URL including `?token=`. Owner startup links expire after 24 hours and
are exchanged by the server on navigation, which sets a persistent owner
session cookie. Later visits can use the plain HTTPS URL reported by
`tailscale serve status`. Treat the complete pairing URL like a password
until it has been consumed.

The packaged desktop behavior is intentional:

- With `SYNARA_PORT` unset, Electron continues to choose a random loopback port.
- With `SYNARA_PORT` set, Electron validates `1` through `65535`, checks that the
  port is free on loopback, and stops with a clear error if another process owns
  it. It never silently changes an explicit port.
- `SYNARA_HOST` and `SYNARA_PUBLIC_URL` pass through to the backend unchanged.
- With `SYNARA_KEEP_RUNNING_AFTER_CLOSE=1`, closing the packaged Windows or
  Linux window hides it but leaves the backend running. Launch Synara again to
  show the same window. An application quit or updater restart still exits.

Set the variables through the startup mechanism that launches Synara so they
exist before Electron starts. A normal interactive `$env:` assignment applies
only to Synara launched from that PowerShell session.

[Tailscale's Serve CLI documentation](https://tailscale.com/docs/reference/tailscale-cli/serve)
defines `tailscale serve <port>` as an HTTPS reverse proxy to
`http://127.0.0.1:<port>`. `--bg` stores the Serve configuration in the local
Tailscale daemon, so no foreground proxy command is needed after setup.

## Standalone web server

For a server-only deployment, build the web app and keep the listener on
loopback behind the same HTTPS proxy:

```powershell
bun run build
$env:SYNARA_PORT = "3773"
$env:SYNARA_HOST = "127.0.0.1"
$env:SYNARA_PUBLIC_URL = "https://workstation.example-tailnet.ts.net"
$env:SYNARA_AUTH_TOKEN = (New-Guid).Guid.Replace("-", "")
$env:SYNARA_NO_BROWSER = "1"
bun run --cwd apps/server start
tailscale serve --bg 3773
```

Treat `SYNARA_AUTH_TOKEN` like a password. Do not use Tailscale Funnel for this
private control plane; Funnel publishes the endpoint to the public internet.

## Checks

```powershell
# Backend remains loopback-only.
Get-NetTCPConnection -State Listen -LocalPort 3773

# Tailscale owns the HTTPS endpoint.
tailscale serve status

# Local backend health.
Invoke-RestMethod http://127.0.0.1:3773/health
```

Expected results:

- The Synara listener uses `127.0.0.1`, not `0.0.0.0` or a LAN/Tailnet address.
- `tailscale serve status` shows the tailnet HTTPS URL proxying to
  `http://127.0.0.1:3773`.
- `/health` reports the local backend as ready.
