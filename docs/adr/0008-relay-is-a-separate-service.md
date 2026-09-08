# The relay is a separate deployable service

The relay runs as its own Railway service under its own hostname (relay.\*), not inside the API app. It is stateless by design (ADR 0006 grants verified by signature, no DB), so it scales independently of the API, and a relay deploy or overload cannot take down auth or the host registry. Long-lived, high-throughput sockets have a different operational profile than request/response API traffic. Shared token/schema code lives in a monorepo package consumed by both.

Considered and rejected (2026-08-13, after studying the upstream project Synara was forked from — see README "Origins"): a control-plane-only relay that provisions per-host Cloudflare Tunnels so data never touches our service. Proven in their production, but it hard-couples the data path to Cloudflare and per-user tunnel limits; we keep the data plane on infrastructure we own, accepting the bandwidth cost and splice/backpressure work.
