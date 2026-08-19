from pathlib import Path


def replace_exact(path: str, old: str, new: str, *, count: int | None = None) -> None:
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    expected = 1 if count is None else count
    if actual != expected:
        raise SystemExit(f"{path}: expected {expected} occurrences of {old!r}, found {actual}")
    p.write_text(text.replace(old, new))


# Complete provider-indexed fixtures used by app settings/model helpers.
p = Path("apps/web/src/appSettings.test.ts")
s = p.read_text()
old = "          pi: [],\n        },"
if s.count(old) != 5:
    raise SystemExit(f"appSettings model maps: expected 5, found {s.count(old)}")
s = s.replace(old, "          pi: [],\n          copilot: [],\n        },")

# Binary path fixtures: preserve the same default/empty semantics as other CLI providers.
s = s.replace('        piBinaryPath: "pi",\n', '        piBinaryPath: "pi",\n        copilotBinaryPath: "copilot",\n')
s = s.replace('        piBinaryPath: "",\n', '        piBinaryPath: "",\n        copilotBinaryPath: "",\n')
s = s.replace('      piBinaryPath: "",\n    });', '      piBinaryPath: "",\n      copilotBinaryPath: "",\n    });')

s = s.replace(
    '    customPiModels: ["anthropic/custom-pi"],\n  } as const;',
    '    customPiModels: ["anthropic/custom-pi"],\n    customCopilotModels: ["copilot/custom-model"],\n  } as const;',
)
s = s.replace(
    '      "opencode",\n      "pi",\n    ]);',
    '      "opencode",\n      "pi",\n      "copilot",\n    ]);',
    1,
)
s = s.replace(
    '    expect(getCustomModelsForProvider(settings, "pi")).toEqual(["anthropic/custom-pi"]);',
    '    expect(getCustomModelsForProvider(settings, "pi")).toEqual(["anthropic/custom-pi"]);\n'
    '    expect(getCustomModelsForProvider(settings, "copilot")).toEqual(["copilot/custom-model"]);',
)
s = s.replace(
    '      customPiModels: ["anthropic/default-pi"],\n    } as const;',
    '      customPiModels: ["anthropic/default-pi"],\n      customCopilotModels: ["copilot/default-model"],\n    } as const;',
)
s = s.replace(
    '    expect(getDefaultCustomModelsForProvider(defaults, "pi")).toEqual(["anthropic/default-pi"]);',
    '    expect(getDefaultCustomModelsForProvider(defaults, "pi")).toEqual(["anthropic/default-pi"]);\n'
    '    expect(getDefaultCustomModelsForProvider(defaults, "copilot")).toEqual([\n'
    '      "copilot/default-model",\n'
    '    ]);',
)
needle = '''  it("patches custom models for pi", () => {\n    expect(patchCustomModels("pi", ["anthropic/custom-pi"])).toEqual({\n      customPiModels: ["anthropic/custom-pi"],\n    });\n  });\n'''
if needle not in s:
    raise SystemExit("appSettings: missing Pi patch test")
s = s.replace(
    needle,
    needle
    + '''\n  it("patches custom models for copilot", () => {\n    expect(patchCustomModels("copilot", ["copilot/custom-model"])).toEqual({\n      customCopilotModels: ["copilot/custom-model"],\n    });\n  });\n''',
)
s = s.replace(
    '      opencode: ["openrouter/gpt-oss-120b"],\n      pi: ["anthropic/custom-pi"],\n    });',
    '      opencode: ["openrouter/gpt-oss-120b"],\n      pi: ["anthropic/custom-pi"],\n      copilot: ["copilot/custom-model"],\n    });',
)
s = s.replace(
    '''      customPiModels: [\n        " anthropic/claude-sonnet-4-5 ",\n        "anthropic/custom-pi",\n        "anthropic/custom-pi",\n      ],\n    });''',
    '''      customPiModels: [\n        " anthropic/claude-sonnet-4-5 ",\n        "anthropic/custom-pi",\n        "anthropic/custom-pi",\n      ],\n      customCopilotModels: [" default ", "copilot/custom-model", "copilot/custom-model"],\n    });''',
)
s = s.replace(
    '''    expect(\n      modelOptionsByProvider.pi.filter((option) => option.slug === "anthropic/custom-pi"),\n    ).toHaveLength(1);''',
    '''    expect(\n      modelOptionsByProvider.pi.filter((option) => option.slug === "anthropic/custom-pi"),\n    ).toHaveLength(1);\n    expect(\n      modelOptionsByProvider.copilot.filter((option) => option.slug === "copilot/custom-model"),\n    ).toHaveLength(1);''',
)
s = s.replace('      customPiModels: [],\n    });', '      customPiModels: [],\n      customCopilotModels: [],\n    });')

# Ensure every expected family was actually inserted.
for marker in ("copilotBinaryPath", "customCopilotModels", 'getCustomModelsForProvider(settings, "copilot")'):
    if marker not in s:
        raise SystemExit(f"appSettings: missing inserted marker {marker}")
p.write_text(s)

# Browser-test provider maps.
replace_exact(
    "apps/web/src/components/chat/ComposerModelEffortPicker.browser.tsx",
    "          pi: [],\n        }}",
    "          pi: [],\n          copilot: [],\n        }}",
)

p = Path("apps/web/src/components/chat/TraitsPicker.browser.tsx")
s = p.read_text()
old = "      pi: [],\n    },"
if s.count(old) != 2:
    raise SystemExit(f"TraitsPicker maps: expected 2, found {s.count(old)}")
p.write_text(s.replace(old, "      pi: [],\n      copilot: [],\n    },"))

replace_exact(
    "apps/web/src/components/chat/ProviderModelPicker.browser.tsx",
    '''  antigravity: [\n    {\n      slug: "Gemini 3.5 Flash",\n      name: "Gemini 3.5 Flash",\n    },\n  ],\n} as const satisfies Record<ProviderKind, ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>>;''',
    '''  antigravity: [\n    {\n      slug: "Gemini 3.5 Flash",\n      name: "Gemini 3.5 Flash",\n    },\n  ],\n  copilot: [],\n} as const satisfies Record<ProviderKind, ReadonlyArray<ProviderModelOption & { slug: ModelSlug }>>;''',
)

p = Path("apps/web/src/composerDraftStore.models.test.ts")
s = p.read_text()
old = "        pi: [],\n      },"
if s.count(old) != 4:
    raise SystemExit(f"composerDraftStore model maps: expected 4, found {s.count(old)}")
p.write_text(s.replace(old, "        pi: [],\n        copilot: [],\n      },"))

# Complete the ProviderKind switch. Copilot has no static model option object.
replace_exact(
    "apps/web/src/composerDraftModels.ts",
    '''    case "pi":\n      return {\n        provider,\n        model,\n        ...(options\n          ? { options: options as Extract<ModelSelection, { provider: "pi" }>["options"] }\n          : {}),\n      };\n  }''',
    '''    case "pi":\n      return {\n        provider,\n        model,\n        ...(options\n          ? { options: options as Extract<ModelSelection, { provider: "pi" }>["options"] }\n          : {}),\n      };\n    case "copilot":\n      return { provider, model };\n  }''',
)

replace_exact(
    "apps/web/src/lib/providerModelPrefetch.test.ts",
    '    piAgentDir: "",\n    ...overrides,',
    '    piAgentDir: "",\n    copilotBinaryPath: "",\n    ...overrides,',
)

replace_exact(
    "apps/web/src/providerUpdates.test.ts",
    '      pi: { ...provider, binaryPath: "pi", agentDir: "" },\n      ...overrides,',
    '      pi: { ...provider, binaryPath: "pi", agentDir: "" },\n      copilot: { ...provider, binaryPath: "copilot" },\n      ...overrides,',
)

replace_exact(
    "apps/web/src/wsNativeApi.test.ts",
    '          pi: { enabled: true, binaryPath: "pi", agentDir: "", customModels: [] },\n        },',
    '          pi: { enabled: true, binaryPath: "pi", agentDir: "", customModels: [] },\n          copilot: { enabled: true, binaryPath: "copilot", customModels: [] },\n        },',
)
