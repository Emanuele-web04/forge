import { assert, describe, it } from "@effect/vitest";

import {
  renderSynaraHarnessPolicy,
  SYNARA_HARNESS_POLICY_MARKER,
  takeSynaraHarnessPolicyForProviderSession,
  takeSynaraHarnessPolicyTextPartForProviderSession,
  takeSynaraHarnessPolicyForSession,
} from "./harnessPolicy.ts";

describe("Synara harness policy", () => {
  it("identifies Synara and explains exact batch coordination when MCP is available", () => {
    const policy = renderSynaraHarnessPolicy({ gatewayControlAvailable: true });
    assert.include(policy, SYNARA_HARNESS_POLICY_MARKER);
    assert.include(policy, "Synara is the host and harness");
    assert.include(policy, "one exact synara_create_threads plan");
    assert.include(policy, "before returning an operationId");
    assert.include(policy, "synara_wait_for_threads");
    assert.include(policy, "synara_set_thread_pull_request");
    assert.include(policy, "current thread's own deliverable");
    assert.include(policy, "only reviews, references, or discusses");
    assert.include(policy, "Use the browser_* tools");
    assert.include(policy, "exact thread-scoped Electron page Synara surfaces to the user");
    assert.include(policy, "continue in the background");
    assert.include(policy, "must never change the user's active chat");
    assert.include(policy, "in any language");
    assert.include(policy, "canonical and complete control surface");
    assert.include(policy, "start with browser_open");
    assert.include(policy, "do not load or use a generic Browser");
    assert.include(policy, "workspace-relative paths");
    assert.include(policy, "BrowserInterruptedByHuman");
    assert.include(policy, "BrowserDownloadApprovalRequired");
    assert.include(policy, "OAuth popup requiring human action");
    assert.include(policy, "stop using tools and answer");
    assert.include(policy, "do not create Synara threads");
    assert.include(policy, "3–8 word outcome-oriented task label");
    assert.include(policy, "no assumed chat context");
    assert.include(policy, "notifying the user versus staying silent");
    assert.include(policy, 'later manual follow-up such as "continue"');
    assert.include(policy, "Never call this tool for a manual follow-up turn");
  });

  it("asks agents to emit known absolute file URLs instead of invented relative links", () => {
    const gateway = renderSynaraHarnessPolicy({ gatewayControlAvailable: true });
    const identityOnly = renderSynaraHarnessPolicy({ gatewayControlAvailable: false });

    for (const policy of [gateway, identityOnly]) {
      assert.include(policy, "[config.ts](file:///absolute/path/config.ts)");
      assert.include(
        policy,
        "Relative links are only for files inside the session working directory",
      );
      assert.include(policy, "If the absolute path is unknown, keep the name as plain text");
      assert.include(policy, "Do not invent a path");
    }
  });

  it("keeps final answers self-contained when intermediate progress is collapsed", () => {
    const gateway = renderSynaraHarnessPolicy({ gatewayControlAvailable: true });
    const identityOnly = renderSynaraHarnessPolicy({ gatewayControlAvailable: false });

    for (const policy of [gateway, identityOnly]) {
      assert.include(policy, 'under a "Worked for..." disclosure');
      assert.include(policy, "Make every final response self-contained");
      assert.include(policy, "restate the essential context concisely in the final response");
      assert.include(policy, 'Never ask them to approve "this", "that", "the above"');
      assert.include(policy, "structured user-input tool");
      assert.include(policy, "contain all context the user needs to decide");
    }
  });

  it("never advertises gateway mutation to providers without scoped MCP", () => {
    const policy = renderSynaraHarnessPolicy({ gatewayControlAvailable: false });
    assert.include(policy, "Synara MCP control is unavailable");
    assert.notInclude(policy, "one exact synara_create_threads plan");
  });

  it("delivers a private host-context block once per provider session", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    assert.include(
      takeSynaraHarnessPolicyForSession(state, { gatewayControlAvailable: true }) ?? "",
      "<synara_host_context>",
    );
    assert.isNull(takeSynaraHarnessPolicyForSession(state, { gatewayControlAvailable: true }));
  });

  it("delivers once on fresh/load/fork sessions for every scoped MCP provider", () => {
    for (const provider of [
      "antigravity",
      "cursor",
      "grok",
      "droid",
      "opencode",
      "kilo",
      "pi",
    ] as const) {
      for (const lifecycle of ["fresh", "load", "fork"] as const) {
        const state: { harnessPolicyDelivered?: boolean } = {};
        const first =
          takeSynaraHarnessPolicyTextPartForProviderSession(state, {
            provider,
            scopedGatewayConnectionAvailable: true,
          })?.text ?? "";
        assert.include(first, SYNARA_HARNESS_POLICY_MARKER, `${provider}/${lifecycle}`);
        assert.include(first, "Use the synara_* tools", `${provider}/${lifecycle}`);
        assert.isNull(
          takeSynaraHarnessPolicyForProviderSession(state, {
            provider,
            scopedGatewayConnectionAvailable: true,
          }),
          `${provider}/${lifecycle}`,
        );
      }
    }
  });

  it("keeps OpenCode, Kilo, and Pi identity-only until scoped setup succeeds", () => {
    for (const provider of ["opencode", "kilo", "pi"] as const) {
      const text =
        takeSynaraHarnessPolicyForProviderSession(
          {},
          { provider, scopedGatewayConnectionAvailable: false },
        ) ?? "";
      assert.include(text, SYNARA_HARNESS_POLICY_MARKER, provider);
      assert.include(text, "Synara MCP control is unavailable", provider);
      assert.notInclude(text, "one exact synara_create_threads plan", provider);
    }
  });

  it("teaches the device tools well enough for a plain prompt to work", () => {
    const policy = renderSynaraHarnessPolicy({ gatewayControlAvailable: true });

    // When to reach for them at all: the demo needed "using your device_* tools"
    // spelled out because the policy only triggered on the user naming a tool.
    assert.include(policy, "run, test, check, demo, debug, or interact with an iOS app");
    assert.include(policy, "whether or not the user names a tool");
    assert.include(policy, "never drive the simulator with xcrun simctl");
    // A rival agent-device skill on the host was read before the tools were
    // tried; the browser guidance names its competitors, so this does too.
    assert.include(policy, "do not load or use an agent-device");
    assert.include(policy, "rather than reading skill files first");

    // The workflow, so the agent does not have to guess an ordering.
    assert.include(policy, "device_list first");
    // Reusing a booted device rather than starting a second one: two live
    // simulators compete for the pane and the user watches the wrong screen.
    assert.include(policy, "already booted, use that one");
    assert.include(policy, "device_install and device_launch");
    assert.include(policy, "com.apple.Preferences");

    // Expo/RN CLI paths boot the sim through Simulator.app, which foregrounds
    // a window the user is not watching and leaves the Synara pane empty. A
    // real demo also stalled for minutes on a dev server holding the shell.
    assert.include(policy, "For Expo or React Native work");
    assert.include(policy, "expo start --ios");
    assert.include(policy, "npm run ios");
    assert.include(policy, "opens Simulator.app");
    assert.include(policy, "exp://127.0.0.1:8081");
    assert.include(policy, "start it detached in the background");

    // Interaction discipline: describe before tapping, verify after.
    assert.include(policy, "device points from device_describe_ui, never screenshot pixels");
    assert.include(policy, "again afterwards to confirm the screen changed");

    // Semantic targeting is the headline: making the model do the coordinate
    // arithmetic is where taps go wrong, so label targeting leads.
    assert.include(policy, "Tap by label rather than by coordinates");
    assert.include(policy, "device_tap {udid, label}");
    assert.include(policy, "device_tap {udid, label, role}");
    assert.include(policy, "only when nothing in the tree labels the target");

    // Why a row-centre tap does nothing, for the cases still using coordinates.
    assert.include(policy, "the row's frame centre is dead space");

    // Scrolling is motor control the server owns. A demo agent swiped three
    // times to reach Developer when one call should have done it.
    assert.include(policy, "Never write a swipe loop");
    assert.include(policy, "device_scroll_to_element {udid, label}");
    assert.include(policy, "device_tap with a label already scrolls");
    // device_swipe still has a job; this must not read as a blanket ban.
    assert.include(policy, "gestures that are the point in themselves");

    // Reading and verifying toggle state from the tree instead of pixels. The
    // same run took a screenshot purely to work out whether the switch moved.
    assert.include(policy, "A toggle reports its state in the node's value");
    assert.include(policy, "Never take a screenshot to check state");
    assert.include(policy, "device_screenshot is for showing the user a result");

    // The traps that made the demo agent report success it never observed.
    assert.include(policy, "an unchanged tree after a tap means the tap missed");
    assert.include(policy, "not delivered to the simulator");
    assert.include(policy, "Never report success you have not observed");
    assert.include(policy, "device_open_url always requires explicit user approval");
    assert.include(policy, "Airplane Mode");
  });

  it("withholds device guidance from sessions with no gateway control", () => {
    const policy = renderSynaraHarnessPolicy({ gatewayControlAvailable: false });

    // Promising tools this session cannot reach would be a lie.
    assert.notInclude(policy, "device_list");
    assert.notInclude(policy, "device_describe_ui");
  });
});
