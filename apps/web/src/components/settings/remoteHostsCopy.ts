// FILE: remoteHostsCopy.ts
// Purpose: The user-approved strings for the remote-hosts settings surface, in
//          one place so a component cannot quietly reword them.
// Layer: Web / settings
//
// Every string here was signed off verbatim. Two of them are CONDITIONAL on
// facts about what the code actually does, and are commented where they appear:
// approval does not make a claim true, so each is only used on the branch where
// it is true.

import type { RemoteHostConnectivityState } from "@synara/contracts";

export const REMOTE_HOSTS_SECTION_TITLE = "Remote hosts";
export const ADD_HOST_BUTTON = "Add host";

export const EMPTY_STATE_TITLE = "No remote hosts yet";
export const EMPTY_STATE_BODY = "Add a host to run sessions on another machine over SSH.";

export const ADD_DIALOG_TITLE = "Add a remote host";
export const ADD_DIALOG_DESCRIPTION = "Run sessions on another machine over SSH.";

export const HOST_FIELD_LABEL = "Host";
export const HOST_FIELD_PLACEHOLDER = "devbox or user@host.example.com";
export const HOST_FIELD_HELPER = "Any name from your ~/.ssh/config works.";

export const NAME_FIELD_LABEL = "Name";
export const NAME_FIELD_HELPER = "What this host is called in Synara.";

export const SUBMIT_IDLE = "Add host";
export const SUBMIT_IN_FLIGHT = "Adding…";

/**
 * Host-key trust prompt, offered ONLY on first contact.
 *
 * The fingerprint is shown because the user comparing it against a machine they
 * own is the entire security value of the prompt.
 */
export const HOST_KEY_UNKNOWN_TITLE = "This host hasn't been seen before";
export const HOST_KEY_UNKNOWN_BODY =
  "Synara can't tell a new host from an impostor on its own. Check this fingerprint matches your server before you continue.";
export const HOST_KEY_UNKNOWN_HINT =
  "On the host, run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` to see its fingerprint.";
export const HOST_KEY_TRUST_BUTTON = "Trust and connect";
export const CANCEL_BUTTON = "Cancel";

/** Changed key. There is no trust button here — Close is the only action. */
export const HOST_KEY_CHANGED_TITLE = "This host's identity changed";
export const HOST_KEY_CHANGED_BODY =
  "The key doesn't match the one Synara saw before. This can mean the server was rebuilt — or that something is impersonating it. Synara won't connect until you confirm which.";
export const HOST_KEY_CHANGED_HINT =
  "If you rebuilt the host, remove its old entry from ~/.ssh/known_hosts and add it again.";
export const CLOSE_BUTTON = "Close";

export const CONNECTIVITY_LABEL: Readonly<Record<RemoteHostConnectivityState, string>> = {
  connected: "Ready",
  degraded: "Unstable connection",
  reconnecting: "Reconnecting…",
  down: "Not connected",
};

export const DISCONNECT_BUTTON = "Disconnect";
export const CONNECT_BUTTON = "Connect";
export const REMOVE_BUTTON = "Remove";

export function removeConfirmTitle(label: string): string {
  return `Remove ${label}?`;
}

/**
 * CONDITIONAL STRING — verified true for this implementation.
 *
 * The claim "threads stay on the host" is only honest because Remove is a LOCAL
 * forget: it drops the entry from `ServerSettings.remoteHosts` and does nothing
 * over SSH. It deliberately does NOT call `uninstallRemoteServer`, which runs
 * `rm -rf -- <installRoot>` — and because the supervisor sets
 * `SYNARA_HOME=<installRoot>/state`, the remote thread database lives at
 * `<installRoot>/state/userdata/state.sqlite`, INSIDE the tree that command
 * deletes. Wiring Remove to uninstall would make this sentence a lie and
 * silently destroy the user's remote threads.
 *
 * If a "remove and wipe the host" action is ever added, it needs its own,
 * separately approved copy — it must not reuse this string.
 */
export const REMOVE_CONFIRM_BODY =
  "Threads that ran on this host stay on the host itself — they'll come back if you add it again. Synara stops showing them here.";

/**
 * Provider readiness. Previously signed off; unchanged. Readiness never gates
 * ADDING a host — a host with nothing installed is still worth adding.
 */
export const READINESS_UNAVAILABLE = "No coding agents are installed on this host yet.";
export const READINESS_UNKNOWN = "Checking what this host can run…";
export const READINESS_NOT_AUTHENTICATED_GENERIC =
  "No providers are signed in on this host yet — sign in there to start chats.";

export function readinessNotAuthenticated(providerName: string): string {
  return `Sign in to ${providerName} on this host to start chats here.`;
}
