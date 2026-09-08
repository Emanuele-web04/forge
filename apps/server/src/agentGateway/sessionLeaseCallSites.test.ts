import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { agentGatewayCapabilitiesFor, captureAgentGatewayCapabilityInput } from "./sessionLease.ts";

/**
 * Every provider leases its gateway credential from the same helper, and a lease
 * that hands over the wrong object fails silently: the credential is issued, the
 * capability is simply absent, and the tools are missing with no error anywhere.
 * `acquireAgentGatewaySessionLease` requires the capability input, so the type
 * checker catches an omission — but not a site that passes an empty stand-in.
 *
 * This table pins what each site actually hands over. Adding a lease site (or
 * changing one to something that cannot carry the session-start flags) fails
 * here and forces the choice to be deliberate.
 */
const SESSION_START_INPUT = "input";

interface LeaseSiteExpectation {
  readonly file: string;
  /**
   * The fourth argument at each `acquireAgentGatewaySessionLease` call, in
   * source order. `input` is the provider start input; `context.<field>` is a
   * captured projection of it (asserted below); the Codex forward carries the
   * manager's stored capability input.
   */
  readonly capabilityArguments: readonly string[];
}

const LEASE_SITES: readonly LeaseSiteExpectation[] = [
  { file: "AntigravityAdapter.ts", capabilityArguments: ["context.gatewayCapabilityInput"] },
  { file: "ClaudeAdapter.ts", capabilityArguments: [SESSION_START_INPUT] },
  {
    file: "CodexAdapter.ts",
    capabilityArguments: ["capabilityInput ?? AGENT_GATEWAY_NO_CAPABILITIES"],
  },
  { file: "CursorAdapter.ts", capabilityArguments: [SESSION_START_INPUT] },
  { file: "DevinAdapter.ts", capabilityArguments: [SESSION_START_INPUT] },
  { file: "DroidAdapter.ts", capabilityArguments: [SESSION_START_INPUT] },
  { file: "GrokAdapter.ts", capabilityArguments: [SESSION_START_INPUT] },
  { file: "OpenCodeAdapter.ts", capabilityArguments: [SESSION_START_INPUT] },
  {
    file: "PiAdapter.ts",
    capabilityArguments: ["context.gatewayCapabilityInput", SESSION_START_INPUT],
  },
];

const ADAPTER_SOURCE_ROOT = new URL("../provider/Layers/", import.meta.url);

function readAdapterSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(file, ADAPTER_SOURCE_ROOT)), "utf8");
}

function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** Split one argument list on its top-level commas. */
function splitArguments(argumentList: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (const character of argumentList) {
    if (quote !== undefined) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") depth -= 1;
    if (character === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

/** The fourth argument of every `acquireAgentGatewaySessionLease` call, in source order. */
function capabilityArgumentsIn(source: string): string[] {
  const withoutComments = stripLineComments(source);
  const call = "acquireAgentGatewaySessionLease(";
  const capabilityArguments: string[] = [];
  let cursor = withoutComments.indexOf(call);
  while (cursor !== -1) {
    let depth = 1;
    let index = cursor + call.length;
    const start = index;
    while (index < withoutComments.length && depth > 0) {
      const character = withoutComments[index];
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      index += 1;
    }
    expect(depth, `unbalanced ${call} call`).toBe(0);
    const args = splitArguments(withoutComments.slice(start, index - 1));
    expect(args.length, `expected four arguments, got: ${args.join(" | ")}`).toBe(4);
    capabilityArguments.push(args[3]!.replace(/\s+/g, " "));
    cursor = withoutComments.indexOf(call, index);
  }
  return capabilityArguments;
}

describe("agent gateway lease call sites", () => {
  it("covers every provider adapter that acquires a gateway lease", () => {
    const adapters = readdirSync(ADAPTER_SOURCE_ROOT).filter(
      (file) =>
        file.endsWith("Adapter.ts") &&
        readAdapterSource(file).includes("acquireAgentGatewaySessionLease("),
    );
    expect(LEASE_SITES.map((site) => site.file).toSorted()).toEqual(adapters.toSorted());
  });

  it.each(LEASE_SITES)("$file passes the session-start capability facts", (site) => {
    const source = readAdapterSource(site.file);
    expect(capabilityArgumentsIn(source)).toEqual(site.capabilityArguments);
  });

  it.each(LEASE_SITES)("$file never assembles capabilities itself", (site) => {
    // Derivation lives in sessionLease.ts alone; an adapter naming a capability
    // means a second home for the decision.
    const source = readAdapterSource(site.file);
    expect(source).not.toContain("additionalCapabilities");
    expect(source).not.toContain("computer:control");
  });

  it.each(
    LEASE_SITES.flatMap((site) =>
      site.capabilityArguments
        .filter((argument) => argument.startsWith("context."))
        .map((argument) => ({ file: site.file, field: argument.slice("context.".length) })),
    ),
  )("$file captures $field from the start input for its re-lease", ({ file, field }) => {
    // A re-lease that reads a stale or hand-picked field would silently drop the
    // capability; the stored value has to be the shared projection.
    expect(readAdapterSource(file)).toContain(
      `${field}: captureAgentGatewayCapabilityInput(input)`,
    );
  });

  it("hands the Codex app-server manager the same captured facts", () => {
    // Codex leases inside the manager, which owns session restarts, so its
    // start input reaches the lease through one stored capability input.
    expect(readAdapterSource("CodexAdapter.ts")).toContain(
      "agentGatewayCapabilityInput: captureAgentGatewayCapabilityInput(input)",
    );
  });

  it("grants computer control through every carrier a site uses", () => {
    const enabled = { enableComputerControl: true, cwd: "/tmp/project" };
    // The start input passed straight through.
    expect(agentGatewayCapabilitiesFor(enabled)).toContain("computer:control");
    // The projection Antigravity, Pi, and the Codex manager store instead.
    expect(agentGatewayCapabilitiesFor(captureAgentGatewayCapabilityInput(enabled))).toContain(
      "computer:control",
    );

    const disabled = { enableComputerControl: false, cwd: "/tmp/project" };
    expect(agentGatewayCapabilitiesFor(disabled)).toEqual([]);
    expect(agentGatewayCapabilitiesFor(captureAgentGatewayCapabilityInput(disabled))).toEqual([]);
  });
});
