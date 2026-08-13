# Relay authorization via API-issued grant tokens

To connect to a host through the relay, a client first asks the API for a Relay Grant: a short-lived, host-scoped signed token. The API applies the authorization rule (connecting user owns the host, or the host is discoverable and the user is in the owner's org); the relay only verifies the grant's signature, host id, and expiry — statelessly, with no database access.

Rejected: relay validating the session JWT against the DB (relay stops being dumb and embeds authorization rules), and host-side authorization (burns a host round-trip per unauthorized attempt). This keeps the relay a horizontally scalable pipe and authorization logic in exactly one place.
