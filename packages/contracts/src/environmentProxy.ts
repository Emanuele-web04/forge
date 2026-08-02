// FILE: environmentProxy.ts
// Purpose: Wire constants for the single-origin `/env/:envId/*` proxy — the path
//          prefix and the close codes the proxy uses to say "resync" out loud.
// Layer: Shared contracts (constants only)
//
// The proxy is deliberately NOT a method-aware RPC relay. The WS surface is one
// flat RpcGroup with no environment routing key, and event sequences are
// per-server SQLite autoincrement values, so protocol-level relaying would break
// on every release and collide two sequence spaces. Everything below therefore
// describes the *envelope* — where a request is addressed and how the proxy
// reports its own failure — and never the payload.

/**
 * Prefix owned by the proxy. A browser stays on ONE origin: the local server
 * serves the app and forwards `/env/<id>/...` to the environment's own server.
 */
export const ENV_PROXY_PATH_PREFIX = "/env";

/**
 * Maximum length of the environment id segment in a proxied path.
 *
 * Ids are opaque to the proxy — it never decodes them, it only matches them
 * against a registry — so the bound exists to keep a hostile URL from forcing
 * long-string work before the registry lookup rejects it.
 */
export const ENV_PROXY_ID_MAX_LENGTH = 64;

/**
 * Where a server states which environment it is and which release it runs.
 *
 * Defined here, in the contracts package, because BOTH sides depend on it being
 * the same string: the remote server registers the route, and the broker's
 * handshake requests it through the tunnel. Two independent spellings would
 * produce a 404 that reads exactly like "the server is not up yet".
 *
 * Under `/api/`, so it lands inside the surface the auth layer already covers
 * rather than beside it.
 */
export const PROVISIONING_IDENTITY_ROUTE_PATH = "/api/provisioning/identity";

/**
 * Close code: the proxy could not keep up with one direction and dropped the
 * connection rather than buffering without bound or silently discarding frames.
 *
 * This is the EXPLICIT resync signal. A client that sees it must not treat the
 * stream as merely interrupted: whatever it holds may be missing frames that
 * were never sent, so it must reconnect and resume from its cursor (or take a
 * fresh snapshot) instead of continuing from local state.
 *
 * 4000-4999 is the application-private range (RFC 6455 §7.4.2), so no
 * intermediary or library assigns meaning to it.
 */
export const WS_CLOSE_PROXY_RESYNC_REQUIRED = 4002;

/** Human-readable close reason paired with the code above. Must stay < 123 bytes. */
export const WS_CLOSE_PROXY_RESYNC_REASON = "proxy backlog exceeded; resync required";

/**
 * Close code: the tunnel to the environment went away.
 *
 * Distinct from a resync because nothing was dropped — the remote session is
 * still running and its journal is intact, so a client should reattach and
 * resume rather than assume it lost events. Surviving a tunnel bounce without
 * disturbing the remote session is the entire reason for this architecture.
 */
export const WS_CLOSE_PROXY_TUNNEL_LOST = 4003;

export const WS_CLOSE_PROXY_TUNNEL_LOST_REASON = "environment tunnel lost; reattach";
