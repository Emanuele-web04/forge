# CI quality gates

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`. It has four independent jobs so a platform-specific or release-specific regression is visible separately from the main Linux quality pipeline.

## Main quality job

`Format, Lint, Typecheck, Test, Browser Test, Build` runs on Ubuntu and blocks on:

- Synara identity/brand validation;
- `bun run fmt:check`;
- `bun run lint`;
- `bun run typecheck`;
- the full unit/integration test suite (`bun run test`);
- the stable Chromium browser-test suite;
- the desktop build pipeline;
- preload bundle output verification.

Linux geometry/pixel browser tests run in a separately named quarantine step with `continue-on-error` while the tracked rendering differences in `apps/web/BROWSER_TEST_QUARANTINE.md` are resolved. Untagged browser tests still run in the blocking stable suite.

CI installs Electron and Playwright explicitly and verifies the Linux `node-pty` native dependency before the quality commands run.

## Windows process regression job

`Windows Process Regression` runs on Windows Server 2022 and covers behavior that Linux cannot validate reliably, including:

- Bun/`node-pty` startup;
- Windows-safe process planning and Effect process spawning;
- desktop backend shutdown;
- migration recovery markers;
- desktop migration recovery;
- migration backup/restore and replay.

## Migration lineage

`Migration Lineage` fetches release history and verifies that released `(id, name)` migration pairs have not been renamed or renumbered. Those identifiers are persisted in user databases, so this is a compatibility gate rather than a formatting convention.

## Release smoke

`Release Smoke` exercises release-only scripts and policy checks on every PR without publishing artifacts. It also runs the identity check with a production-style dependency install.

## Desktop releases

`.github/workflows/release.yml` builds tagged desktop releases for macOS arm64/x64, Linux x64, and Windows x64 from one verified source commit. Publication uses platform signing/notarization credentials where required; build-only workflow runs may produce unsigned artifacts when publication is disabled.

The release workflow also verifies source and artifact provenance before publication. See `docs/release.md` for the current signing, provenance, and release checklist.
