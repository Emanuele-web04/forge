import type {
  ProviderAdapterCapabilities,
  ProviderAdapterShape,
} from "./Services/ProviderAdapter.ts";

type CapabilityFlag = Exclude<
  keyof ProviderAdapterCapabilities,
  | "sessionModelSwitch"
  | "conversationRollback"
  | "supportsSkillMentions"
  | "supportsPluginMentions"
  | "supportsLiveTurnDiffPatch"
>;

type OptionalAdapterMethod =
  | "steerTurn"
  | "listSkills"
  | "listCommands"
  | "listPlugins"
  | "readPlugin"
  | "listModels";

export interface ProviderAdapterConformanceIssue {
  readonly capability: CapabilityFlag;
  readonly missingMethod: OptionalAdapterMethod;
}

const CAPABILITY_METHOD_REQUIREMENTS: ReadonlyArray<{
  readonly capability: CapabilityFlag;
  readonly methods: ReadonlyArray<OptionalAdapterMethod>;
}> = [
  { capability: "supportsTurnSteering", methods: ["steerTurn"] },
  { capability: "supportsSkillDiscovery", methods: ["listSkills"] },
  { capability: "supportsNativeSlashCommandDiscovery", methods: ["listCommands"] },
  { capability: "supportsPluginDiscovery", methods: ["listPlugins", "readPlugin"] },
  { capability: "supportsRuntimeModelList", methods: ["listModels"] },
];

export function providerAdapterConformanceIssues(
  adapter: ProviderAdapterShape<unknown>,
): ProviderAdapterConformanceIssue[] {
  const issues: ProviderAdapterConformanceIssue[] = [];
  for (const requirement of CAPABILITY_METHOD_REQUIREMENTS) {
    if (adapter.capabilities[requirement.capability] !== true) {
      continue;
    }
    for (const method of requirement.methods) {
      if (typeof adapter[method] !== "function") {
        issues.push({
          capability: requirement.capability,
          missingMethod: method,
        });
      }
    }
  }
  return issues;
}

export function assertProviderAdapterConformance(adapter: ProviderAdapterShape<unknown>): void {
  const issues = providerAdapterConformanceIssues(adapter);
  if (issues.length === 0) {
    return;
  }

  const detail = issues
    .map((issue) => `${issue.capability} requires ${issue.missingMethod}()`)
    .join(", ");
  throw new Error(`Provider adapter "${adapter.provider}" has invalid capabilities: ${detail}.`);
}
