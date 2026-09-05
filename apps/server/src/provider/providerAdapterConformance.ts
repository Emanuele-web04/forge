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

type RequiredAdapterMethod =
  | "startSession"
  | "sendTurn"
  | "interruptTurn"
  | "respondToRequest"
  | "respondToUserInput"
  | "stopSession"
  | "listSessions"
  | "hasSession"
  | "readThread"
  | "rollbackThread"
  | "stopAll";

export interface ProviderAdapterConformanceIssue {
  readonly capability?: CapabilityFlag;
  readonly missingMethod: OptionalAdapterMethod | RequiredAdapterMethod;
}

export interface ProviderAdapterRegistrationIssue {
  readonly provider: ProviderAdapterShape<unknown>["provider"];
  readonly duplicateIndex: number;
}

const REQUIRED_ADAPTER_METHODS: ReadonlyArray<RequiredAdapterMethod> = [
  "startSession",
  "sendTurn",
  "interruptTurn",
  "respondToRequest",
  "respondToUserInput",
  "stopSession",
  "listSessions",
  "hasSession",
  "readThread",
  "rollbackThread",
  "stopAll",
];

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
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") {
      issues.push({ missingMethod: method });
    }
  }
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

export function providerAdapterRegistrationIssues(
  adapters: ReadonlyArray<ProviderAdapterShape<unknown>>,
): ProviderAdapterRegistrationIssue[] {
  const seen = new Set<ProviderAdapterShape<unknown>["provider"]>();
  const issues: ProviderAdapterRegistrationIssue[] = [];
  adapters.forEach((adapter, index) => {
    if (seen.has(adapter.provider)) {
      issues.push({ provider: adapter.provider, duplicateIndex: index });
    }
    seen.add(adapter.provider);
  });
  return issues;
}

export function assertProviderAdapterConformance(adapter: ProviderAdapterShape<unknown>): void {
  const issues = providerAdapterConformanceIssues(adapter);
  if (issues.length === 0) {
    return;
  }

  const detail = issues
    .map((issue) =>
      issue.capability
        ? `${issue.capability} requires ${issue.missingMethod}()`
        : `required method ${issue.missingMethod}() is missing`,
    )
    .join(", ");
  throw new Error(`Provider adapter "${adapter.provider}" has invalid capabilities: ${detail}.`);
}
