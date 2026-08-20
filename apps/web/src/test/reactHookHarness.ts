// FILE: reactHookHarness.ts
// Purpose: Minimal React hook runtime for unit-testing hooks in node without a renderer.
// Layer: Test helper
// Exports: reactHookHarness (render lifecycle controls), reactHookHarnessMock (the module
// shape for vi.mock("react")). One harness instance per test file (vitest isolates modules
// per file), so state never leaks across suites.
// Usage:
//   vi.mock("react", async () => (await import("../test/reactHookHarness")).reactHookHarnessMock);
//   import { reactHookHarness } from "../test/reactHookHarness";
//   Call beginRender() before each hook invocation, reset() in beforeEach, unmount() to run cleanups.

interface HookSlot {
  value?: unknown;
  deps?: readonly unknown[];
  cleanup?: (() => void) | undefined;
}

let slots: HookSlot[] = [];
let cursor = 0;

const nextSlot = () => {
  const index = cursor;
  cursor += 1;
  slots[index] ??= {};
  return slots[index]!;
};

const depsEqual = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
  left !== undefined &&
  left.length === right.length &&
  left.every((value, index) => Object.is(value, right[index]));

const useEffect = (effect: () => void | (() => void), deps: readonly unknown[]) => {
  const slot = nextSlot();
  if (depsEqual(slot.deps, deps)) return;
  slot.cleanup?.();
  slot.deps = deps;
  slot.cleanup = effect() ?? undefined;
};

export const reactHookHarness = {
  beginRender() {
    cursor = 0;
  },
  reset() {
    slots = [];
    cursor = 0;
  },
  unmount() {
    for (const slot of slots) slot.cleanup?.();
    slots = [];
    cursor = 0;
  },
};

export const reactHookHarnessMock = {
  useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T {
    const slot = nextSlot();
    if (!depsEqual(slot.deps, deps)) {
      slot.deps = deps;
      slot.value = callback;
    }
    return slot.value as T;
  },
  useEffect,
  useLayoutEffect: useEffect,
  useRef<T>(initialValue: T) {
    const slot = nextSlot();
    slot.value ??= { current: initialValue };
    return slot.value as { current: T };
  },
  useState<T>(initialValue: T | (() => T)) {
    const slot = nextSlot();
    if (!("value" in slot)) {
      slot.value = typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
    }
    const setValue = (next: T | ((current: T) => T)) => {
      slot.value = typeof next === "function" ? (next as (current: T) => T)(slot.value as T) : next;
    };
    return [slot.value as T, setValue] as const;
  },
};
