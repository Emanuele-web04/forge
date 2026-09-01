# Windows runtime architecture

Synara treats Windows support as a platform boundary, not as provider-specific command handling.

```text
Providers / Git / Desktop / Server
                 |
                 v
        shared process runtime
                 |
                 v
       platform launch planning
        /          |          \
 Windows native   POSIX       WSL
```

## Executable resolution

Use `@synara/shared/executable` when code needs to identify the concrete executable that a launch would use. It owns PATH splitting, Windows PATHEXT ordering, manual paths, extensionless command names, and executable validation.

A configured provider executable must be resolved once against the effective child environment and then reused consistently for health checks, discovery, startup, and updates. Do not add provider-local `where.exe` calls or a second PATH walker.

## Process launch planning

Use `prepareProcess` from `@synara/shared/platformProcess` when a launch plan must be inspected or logged before execution. It owns:

- native `.exe` and `.com` execution;
- `.cmd` and `.bat` routing through a shell-free `cmd.exe` plan;
- Windows argument serialization and `windowsVerbatimArguments`;
- WSL UNC detection and `wsl.exe` dispatch;
- fail-fast `ExecutableNotFoundError` when `requireExecutable` is enabled (Node runtime only);
- qualified relative commands such as `./bin/tool` resolved against the launch `cwd`, exactly as the child would see them.

Node callers should normally use `spawnProcess`, `spawnProcessSync`, or `execProcessFile` from `@synara/shared/processRuntime`. Effect callers use `makeEffectProcessCommand` from `apps/server/src/platform/effectProcessRuntime.ts`; it has no `requireExecutable` because the Effect spawner is injectable and a missing executable surfaces as the spawner's own ENOENT error.

Bounded one-shot helpers (`processRunner`, provider probes) stop their child with `signalOwnedChildProcess`: Node's direct `child.kill` on POSIX, `taskkill /T` through the tree boundary on Windows where a `.cmd` shim hides the real command behind cmd.exe.

Application and provider code must not set `shell`, `windowsHide`, or `windowsVerbatimArguments`, and must not invoke `cmd.exe`, `where.exe`, or `taskkill` directly.

## Environment

The desktop hydrates the GUI process environment before starting the backend. Windows uses the persisted machine and user environment; macOS and Linux use their existing login-shell or launchctl paths.

Provider launch code receives an already resolved environment. Provider-specific environment builders may filter credentials or set supported provider variables, but they must not rediscover the host PATH.

## Provider startup lifecycle

`ProviderStartupLifecycle` records deterministic internal phases:

```text
discovering -> starting -> handshaking -> authenticating -> ready -> running
                                      \-> failed
                         any phase ----> stopped
```

Failures retain a typed reason such as `ExecutableNotFound`, `SpawnFailed`, `ExitedDuringStartup`, `HandshakeTimeout`, `AuthenticationFailed`, `ProtocolFailure`, `Cancelled`, or `ExitUnproven`. Every provider start remains bounded by the orchestration deadline, produces structured diagnostics, and performs adapter cleanup before the lifecycle lock is released.

## Process-tree teardown

Use `teardownChildProcessTree`, `teardownEffectProcessTree`, or `teardownProviderProcessTree` from the server platform runtime. Success requires both:

1. the owned root process emitted its terminal exit; and
2. every captured descendant identity disappeared.

Windows process snapshots include CIM creation identity so delayed escalation does not target a reused PID. Snapshot failure is `unknown`, never an empty successful capture, and produces `ProviderProcessExitUnprovenError` when exit cannot be proven.

On Windows every supervised teardown therefore depends on `powershell.exe` and `Get-CimInstance Win32_Process` being available and answering within the observer's probe timeout. Where PowerShell is blocked by policy the stop fails closed instead of reporting a false success.

The current boundary deliberately fails closed but does not yet establish creation-time Windows Job Object ownership. A Job Object backend can be added behind the same controller without changing provider code.

## Terminal and ConPTY

Terminal sessions continue to use the PTY service. On Windows, runtime selection intentionally loads node-pty's ConPTY implementation even when the backend runs under Bun. ConPTY details stay inside the terminal runtime; providers and generic process callers must not depend on them.

## Filesystem semantics

Use `@synara/shared/filesystemPlatform` for platform-sensitive durability and identity operations. It centralizes writable-handle fsync on Windows, POSIX directory fsync/no-follow behavior, and the documented Windows file-identity fallback used by guarded recovery code.

Migration, backup, restore, and lifecycle-lock code may own their recovery protocol, but they must not reproduce platform-specific fsync rules locally.

## WSL boundary

Native Windows remains the default execution backend. A working directory under `\\wsl$` or `\\wsl.localhost` is translated by the shared WSL bridge into an explicit `wsl.exe --distribution ... --cd ... --exec ...` plan.

WSL session discovery, distribution policy, and first-class settings remain follow-up work. New WSL behavior belongs behind `wslBridge`/`platformProcess`, not in providers.

## Adding a provider

A new CLI provider should:

1. build its provider-specific environment;
2. pass its logical command, arguments, cwd, and environment to the shared process runtime;
3. observe its protocol handshake with a bounded startup path;
4. publish ready or a typed failure;
5. stop through supervised process-tree teardown.

It should contain no code for `.cmd`, `.bat`, `cmd.exe`, PATHEXT, `where.exe`, Windows quoting, `taskkill`, WSL UNC conversion, or ConPTY.

`bun run windows-runtime:check` enforces the application-facing boundary in CI.
