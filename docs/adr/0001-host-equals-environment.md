# Host = Environment, 1:1

A host (a user's machine on their account) and an environment (a running Synara server) are the same entity, identified by the environment id. We deliberately reject multi-environment-per-machine — container launchers notwithstanding, running several Synara environments on one device adds hierarchy to the account model, the transport selection, and the UI for a feature with no articulated user value. The account row stays keyed on the environment id; machine info (hostname, platform) is metadata on it.

If multi-env-per-machine ever becomes real, it appears as N host rows, not as a parent/child hierarchy.
