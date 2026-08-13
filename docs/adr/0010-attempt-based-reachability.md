# Reachability is attempt-based; no presence store, no client push channel

Supersedes ADR 0005 and ADR 0009 after comparing against t3code, which shipped remote access in production with no presence infrastructure at all.

There is no stored or pushed online/offline state. Clients learn whether a host is reachable by attempting — the transport probe-race (ADR 0007) *is* the reachability check — plus an on-demand health call for explicit status. Host lists show reachability as-of-last-fetch/probe, not live dots. Clients hold no relay control socket; the client's only relay interaction is presenting a grant to open a session.

What survives from ADR 0005: the host still holds a supervisor-kept relay control socket, because splice signaling requires it — but it exists for signaling, not presence, and `lastSeenAt` remains historical metadata. If live presence dots become a wanted product feature later, the host socket already provides the signal; only the fan-out to clients would need building.
