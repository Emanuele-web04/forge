---
status: superseded by ADR-0010
---

# The relay carries the client control channel (presence & directory push)

Clients hold exactly one relay control socket, which delivers presence and directory-change events for hosts they can see; the API publishes changes to the relay internally. Rejected: a second push-WS infrastructure on the API — it would mean two persistent sockets per client and socket machinery in a request/response service.

This refines the "relay is a dumb pipe" invariant: the invariant applies to _spliced session traffic_ (opaque frames, never parsed). The _control_ sockets — host dial, client control — do speak a small relay protocol (presence, grant presentation, splice signaling). Data sockets remain opaque end-to-end.
