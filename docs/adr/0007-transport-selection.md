# Transport selection: client probes, fixed preference order

Each client selects the path to a host by concurrently probing candidates and picking by fixed preference order — loopback > LAN > Tailscale > SSH (desktop only) > relay — racing with short timeouts. No cloud involvement in the choice; selection degrades gracefully when the cloud is unreachable.

Rejected: latency-based selection (adapts to odd networks but unpredictable) and per-network stickiness caching (faster reconnects but adds cache/invalidation state). Either can be layered on later without changing the model: candidates are still one list per host.
