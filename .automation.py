from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old!r}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "apps/web/src/session-logic.test.ts",
    '      { value: "pi", label: "Pi", available: true },\n    ]);',
    '      { value: "pi", label: "Pi", available: true },\n      { value: "copilot", label: "GitHub Copilot", available: true },\n    ]);',
)

p = Path("apps/web/src/lib/providerModelPrefetch.test.ts")
s = p.read_text()
replacements = [
    (
        '    expect(modelKeys).toHaveLength(8);\n    expect(modelKeys).not.toContainEqual(\n      providerDiscoveryQueryKeys.models("droid", null, null, null, "/tmp/project"),',
        '    expect(modelKeys).toHaveLength(9);\n    expect(modelKeys).not.toContainEqual(\n      providerDiscoveryQueryKeys.models("droid", null, null, null, "/tmp/project"),',
    ),
    ('    expect(modelKeys).toHaveLength(6);', '    expect(modelKeys).toHaveLength(7);'),
    (
        '    // Reconciled + confirmed-unavailable cursor → skipped (8 - 1 = 7).\n',
        '    // Reconciled + confirmed-unavailable cursor → skipped (9 - 1 = 8).\n',
    ),
    (
        '    expect(modelKeys).toHaveLength(7);\n    expect(modelKeys).not.toContainEqual(\n      providerDiscoveryQueryKeys.models("cursor", null, null, null, null),',
        '    expect(modelKeys).toHaveLength(8);\n    expect(modelKeys).not.toContainEqual(\n      providerDiscoveryQueryKeys.models("cursor", null, null, null, null),',
    ),
    (
        '    // Unreconciled → safe default: warm everything (8), even confirmed-unavailable.\n',
        '    // Unreconciled → safe default: warm everything (9), even confirmed-unavailable.\n',
    ),
    (
        '    modelKeys = modelKeysFromCalls(prefetchQuery);\n    expect(modelKeys).toHaveLength(8);\n\n    // Preferred provider unavailable',
        '    modelKeys = modelKeysFromCalls(prefetchQuery);\n    expect(modelKeys).toHaveLength(9);\n\n    // Preferred provider unavailable',
    ),
    (
        '    // 8 models + 8 capabilities + 4 agents (claudeAgent, codex, kilo, opencode).\n    expect(calls).toHaveLength(8 + 8 + 4);',
        '    // 9 models + 9 capabilities + 4 agents (claudeAgent, codex, kilo, opencode).\n    expect(calls).toHaveLength(9 + 9 + 4);',
    ),
]
for old, new in replacements:
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"providerModelPrefetch.test.ts: expected one match, found {count}: {old!r}")
    s = s.replace(old, new, 1)
p.write_text(s)

replace_once(
    "apps/web/src/components/settings/ProvidersSettingsPanel.test.ts",
    '        "codexHomePath",\n        "cursorApiEndpoint",',
    '        "codexHomePath",\n        "copilotBinaryPath",\n        "cursorApiEndpoint",',
)
