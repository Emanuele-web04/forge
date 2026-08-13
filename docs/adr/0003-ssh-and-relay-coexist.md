# SSH direct access and the relay coexist as transports

The relay does not replace the SSH/env-proxy path built in feat/remote-hosts-combined. SSH remains a first-class desktop-only transport (lower latency, zero cloud dependency — losing the cloud degrades to LAN/SSH, never breaks local use); the relay is the universal fallback for clients that cannot SSH (iOS, hosts without SSH access). We accept maintaining two remote data paths permanently in exchange for cloud-independence on desktop.
