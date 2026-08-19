from pathlib import Path


def replace_exact(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} occurrences of {old!r}, found {actual}")
    p.write_text(text.replace(old, new))


# exactOptionalPropertyTypes: omit binaryPath instead of explicitly passing undefined.
replace_exact(
    "apps/server/src/provider/Layers/CopilotAdapter.ts",
    '''          const effectiveSettings: CopilotAcpRuntimeSettings = {\n            binaryPath: configured?.binaryPath ?? settings.binaryPath,\n          };''',
    '''          const binaryPath = configured?.binaryPath ?? settings.binaryPath;\n          const effectiveSettings: CopilotAcpRuntimeSettings = binaryPath ? { binaryPath } : {};''',
)
replace_exact(
    "apps/server/src/provider/Layers/CopilotAdapter.ts",
    '''          const runtime = yield* makeCopilotAcpRuntime({\n            copilotSettings: { binaryPath: input.binaryPath ?? settings.binaryPath },''',
    '''          const binaryPath = input.binaryPath ?? settings.binaryPath;\n          const runtime = yield* makeCopilotAcpRuntime({\n            copilotSettings: binaryPath ? { binaryPath } : {},''',
)

# Registry test must provide and assert the newly-required adapter service.
p = Path("apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts")
s = p.read_text()
old_import = 'import { PiAdapter, PiAdapterShape } from "../Services/PiAdapter.ts";\n'
if old_import not in s:
    raise SystemExit("registry: Pi import anchor missing")
s = s.replace(
    old_import,
    old_import + 'import { CopilotAdapter, CopilotAdapterShape } from "../Services/CopilotAdapter.ts";\n',
    1,
)
anchor = '''const fakeAntigravityAdapter: AntigravityAdapterShape = {\n  provider: "antigravity",'''
if anchor not in s:
    raise SystemExit("registry: antigravity fake anchor missing")
fake = '''const fakeCopilotAdapter: CopilotAdapterShape = {\n  provider: "copilot",\n  capabilities: { sessionModelSwitch: "in-session" },\n  startSession: vi.fn(),\n  sendTurn: vi.fn(),\n  interruptTurn: vi.fn(),\n  respondToRequest: vi.fn(),\n  respondToUserInput: vi.fn(),\n  stopSession: vi.fn(),\n  listSessions: vi.fn(),\n  hasSession: vi.fn(),\n  readThread: vi.fn(),\n  rollbackThread: vi.fn(),\n  stopAll: vi.fn(),\n  streamEvents: Stream.empty,\n};\n\n'''
s = s.replace(anchor, fake + anchor, 1)
s = s.replace(
    '        Layer.succeed(PiAdapter, fakePiAdapter),\n',
    '        Layer.succeed(PiAdapter, fakePiAdapter),\n        Layer.succeed(CopilotAdapter, fakeCopilotAdapter),\n',
    1,
)
s = s.replace(
    '      const pi = yield* registry.getByProvider("pi");\n',
    '      const pi = yield* registry.getByProvider("pi");\n      const copilot = yield* registry.getByProvider("copilot");\n',
    1,
)
s = s.replace(
    '      assert.equal(pi, fakePiAdapter);\n',
    '      assert.equal(pi, fakePiAdapter);\n      assert.equal(copilot, fakeCopilotAdapter);\n',
    1,
)
s = s.replace(
    '        "opencode",\n        "pi",\n      ]);',
    '        "opencode",\n        "pi",\n        "copilot",\n      ]);',
    1,
)
p.write_text(s)

# Disabled-settings fixtures are reused by multiple health tests.
p = Path("apps/server/src/provider/Layers/ProviderHealth.test.ts")
s = p.read_text()
if s.count('    pi: { enabled: false },\n') != 1:
    raise SystemExit("health: simple disabled-provider fixture anchor mismatch")
s = s.replace(
    '    pi: { enabled: false },\n',
    '    pi: { enabled: false },\n    copilot: { enabled: false },\n',
    1,
)
if s.count('    pi: { ...DEFAULT_SERVER_SETTINGS.providers.pi, enabled: false },\n') != 1:
    raise SystemExit("health: full disabled-provider fixture anchor mismatch")
s = s.replace(
    '    pi: { ...DEFAULT_SERVER_SETTINGS.providers.pi, enabled: false },\n',
    '    pi: { ...DEFAULT_SERVER_SETTINGS.providers.pi, enabled: false },\n    copilot: { ...DEFAULT_SERVER_SETTINGS.providers.copilot, enabled: false },\n',
    1,
)
# Ten providers now project disabled statuses.
s = s.replace('      assert.strictEqual(statuses.length, 9);', '      assert.strictEqual(statuses.length, 10);', 1)
p.write_text(s)

# Copilot intentionally uses the shared ACP credential/environment profile.
replace_exact(
    "apps/server/src/providerUsage/index.ts",
    'const providerChildKind = (provider: ProviderKind): ProviderChildKind =>\n  provider === "claudeAgent" ? "claude" : provider;',
    'const providerChildKind = (provider: ProviderKind): ProviderChildKind =>\n  provider === "claudeAgent" ? "claude" : provider === "copilot" ? "acp" : provider;',
)
