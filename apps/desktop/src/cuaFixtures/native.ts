import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import {
  CuaActionError,
  type CuaComputerBackend,
} from "../../../server/src/computer/CuaComputerBackend";

interface FixtureState {
  event: "state";
  label: string;
  pid: number;
  windowId: number;
  title: string;
  clicks: number;
  edits: number;
  text: string;
}

/** The child reports its own controls. Native input is admitted only after
 * its PID, exact title and WindowServer id agree with that independent state. */
export async function runNativeFixture(
  backend: CuaComputerBackend,
  directory: string,
  binary: string,
  approveCapture: (windowId: string) => void,
) {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  const states = new Map<string, FixtureState>();
  const cases: Array<Record<string, unknown>> = [];
  const measurements: Array<{ name: string; milliseconds: number }> = [];
  let observedWindows: Array<{ id: string; title: string }> = [];
  let error: unknown;
  let ready = false;
  let stateResponses = 0;
  child.once("error", (failure) => {
    error = failure;
  });
  child.stderr.on("data", () => undefined);
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const value = JSON.parse(line);
      if (value.pid !== child.pid) throw new Error("Fixture process identity mismatch.");
      if (value.ready === true) ready = true;
      if (value.event === "state") {
        states.set(value.label, value);
        stateResponses += 1;
      }
    } catch (failure) {
      error = failure;
    }
  });
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      if (error) throw error;
      if (Date.now() > deadline) throw new Error("Native fixture response timed out.");
      await pause(25);
    }
  };
  const command = async (value: string) => {
    child.stdin.write(value + "\n");
    await pause(200);
  };
  const readState = async () => {
    const before = stateResponses;
    child.stdin.write("state\n");
    await until(() => stateResponses >= before + 2);
    return { ...states.get("A")! };
  };
  const measured = async <T>(name: string, run: () => Promise<T>) => {
    const start = performance.now();
    try {
      return await run();
    } finally {
      measurements.push({ name, milliseconds: performance.now() - start });
    }
  };
  try {
    await until(() => ready && states.has("A") && states.has("B"));
    let observedTarget: Awaited<ReturnType<CuaComputerBackend["listWindows"]>>[number] | undefined;
    // AppKit can announce its own window before WindowServer publishes its
    // title. Retry observations only; no input is admitted by this loop.
    for (let attempt = 0; attempt < 20 && !observedTarget; attempt += 1) {
      const declared = await readState();
      const candidates = await backend.listWindows();
      observedWindows = candidates
        .filter((window) => window.pid === child.pid)
        .map((window) => ({ id: window.id, title: window.title }));
      observedTarget = candidates.find(
        (window) =>
          window.pid === child.pid &&
          window.title === `Synara Native Fixture ${child.pid} A` &&
          window.id === `cua:${child.pid}:${declared.windowId}`,
      );
      if (!observedTarget) await pause(300);
    }
    const target = observedTarget;
    if (!target) throw new Error("Native fixture identity was not verified; no input sent.");
    const windowId = target.id;
    approveCapture(windowId);
    // Observe only after WindowServer has settled the owned window's opening
    // animation. An input is never retried after a stale-frame refusal.
    await pause(300);
    const observe = () =>
      backend.getState({ windowId, includeScreenshot: true, includeTree: true });
    const observation = await measured("observation", observe);
    if (observation.screenshot)
      await writeFile(
        join(directory, "native-before.png"),
        Buffer.from(observation.screenshot.bytesBase64, "base64"),
      );
    const button = observation.root?.children.find(
      (node) => node.role === "AXButton" && node.label === "Counter: 0",
    );
    if (!button?.activationPoint)
      throw new Error("Exact native fixture button is missing; no input sent.");
    try {
      const result = await measured("click", () =>
        backend.click(button.activationPoint!, target.id),
      );
      const actual = await readState();
      cases.push({
        name: "one-click-one-effect",
        result,
        actual,
        status: actual.clicks === 1 ? "passed" : "failed",
      });
    } catch (failure) {
      cases.push({ name: "one-click-one-effect", status: "refused", error: String(failure) });
    }

    await command("select-a");
    try {
      const result = await measured("same-pid-keyboard", () => backend.typeText("abc", target.id));
      cases.push({
        name: "same-pid-keyboard",
        status: "unexpected-admission",
        result,
        actual: await readState(),
      });
    } catch (failure) {
      cases.push({
        name: "same-pid-keyboard",
        status:
          failure instanceof CuaActionError && failure.effect === "not-dispatched"
            ? "passed-refusal"
            : "failed",
        error: String(failure),
      });
    }

    await command("close-b");
    await command("select-a");
    try {
      const result = await measured("identical-text", () => backend.typeText("abc", target.id));
      const actual = await readState();
      cases.push({
        name: "single-window-identical-text",
        result,
        actual,
        status: actual.text === "abc" && actual.edits > 0 ? "passed" : "failed",
      });
    } catch (failure) {
      cases.push({
        name: "single-window-identical-text",
        status: "refused",
        error: String(failure),
      });
    }

    const semantic = await observe();
    const field = semantic.root?.children.find(
      (node) => node.role === "AXTextField" && node.label === "Fixture text",
    );
    if (field?.activationPoint) {
      try {
        const result = await measured("set-value", () =>
          backend.setValue(
            {
              target: { windowId: target.id, label: "Fixture text" },
              node: field,
              point: field.activationPoint!,
            },
            "fixture-value",
          ),
        );
        const actual = await readState();
        cases.push({
          name: "ax-set-value",
          result,
          actual,
          status: actual.text === "fixture-value" ? "passed" : "failed",
        });
      } catch (failure) {
        cases.push({ name: "ax-set-value", status: "refused", error: String(failure) });
      }
    } else
      cases.push({
        name: "ax-set-value",
        status: "not-run",
        reason: "Exact field absent from native tree.",
      });

    const capture = await backend.captureScreenshot({ kind: "window", windowId: target.id });
    await writeFile(
      join(directory, "native-after.png"),
      Buffer.from(capture.bytesBase64, "base64"),
    );
    await command("minimize-a");
    try {
      await backend.click(button.activationPoint, target.id);
      cases.push({ name: "minimized-target", status: "failed", reason: "Input was admitted." });
    } catch (failure) {
      cases.push({
        name: "minimized-target",
        status:
          failure instanceof CuaActionError && failure.effect === "not-dispatched"
            ? "passed"
            : "failed",
        error: String(failure),
      });
    }
    return {
      target: { pid: child.pid, windowId: target.id, title: target.title },
      cases,
      measurements,
    };
  } catch (failure) {
    return {
      error: String(failure),
      declaredWindows: [...states.values()],
      observedWindows,
      cases,
      measurements,
    };
  } finally {
    child.stdin.end("quit\n");
    const force = setTimeout(() => child.kill("SIGTERM"), 1_000);
    await exited;
    clearTimeout(force);
    lines.close();
  }
}
