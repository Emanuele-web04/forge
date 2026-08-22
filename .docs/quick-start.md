# Quick start

## Local development

```bash
bun install --frozen-lockfile

# Full development stack with hot reload
bun run dev

# Desktop development
bun run dev:desktop

# Desktop development on an isolated port set
SYNARA_DEV_INSTANCE=feature-xyz bun run dev:desktop
```

## Production-style local run

```bash
bun run build
bun run start
```

## Desktop artifacts

```bash
# Shareable macOS DMG (arm64 by default)
bun run dist:desktop:dmg

# Linux AppImage
bun run dist:desktop:linux

# Windows NSIS installer
bun run dist:desktop:win
```

## Published CLI package

The server package is published as `@synara/cli` and exposes the `synara` executable. To run an npm-published version without installing it globally:

```bash
npx --yes --package=@synara/cli synara --help
```

For repository scripts, release packaging, and multi-instance development details, see [scripts.md](./scripts.md).
