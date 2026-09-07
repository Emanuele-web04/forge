# Remote clients are native shells; the relay never serves the UI

Remote access clients are Desktop (bundles the web UI) and iOS (native). The relay carries WebSocket sessions only — no HTTP asset serving, no hosted web app, no HTTP proxying. A plain browser reaching a remote host is explicitly out of scope for now.

Rejected: a cloud-hosted web client (new deployable, browser-keystore and origin work) and upstream-style tunnel HTTP forwarding through the relay (grant semantics would have to cover HTTP; the relay stops being WS-only). Either can be added later without changing the host model — the host already serves its own UI locally.
