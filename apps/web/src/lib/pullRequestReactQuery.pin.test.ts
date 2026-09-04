import type { ProjectId } from "@synara/contracts";
import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as nativeApi from "../nativeApi";
import {
  pullRequestQueryKeys,
  pullRequestsExactInvolvementQueryOptions,
  pullRequestSetPinnedMutationOptions,
} from "./pullRequestReactQuery";
import { deferred } from "./pullRequestReactQuery.testUtils";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pullRequestSetPinnedMutationOptions", () => {
  it("serializes rapid toggles per provider identity", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const githubGate = deferred<Record<string, unknown>>();
    const githubSecondGate = deferred<Record<string, unknown>>();
    const bitbucketGate = deferred<Record<string, unknown>>();
    const calls: string[] = [];
    const setPinned = vi.fn(
      (input: {
        provider: "github" | "bitbucket";
        number: number;
        isPinned: boolean;
      }): Promise<Record<string, unknown>> => {
        calls.push(`${input.provider}:${input.number}:${input.isPinned}`);
        if (input.provider === "github" && input.isPinned) return githubGate.promise;
        if (input.provider === "github") return githubSecondGate.promise;
        return bitbucketGate.promise;
      },
    );
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      pullRequests: { setPinned },
    } as never);
    const options = pullRequestSetPinnedMutationOptions(queryClient);
    const mutationCache = queryClient.getMutationCache();
    const firstGithub = mutationCache.build(queryClient, options);
    const secondGithub = mutationCache.build(queryClient, options);
    const bitbucket = mutationCache.build(queryClient, options);
    const githubInput = {
      projectId,
      provider: "github",
      repository: "acme/widgets",
      number: 42,
      isPinned: true,
    } as const;
    const githubUnpinInput = { ...githubInput, isPinned: false } as const;
    const bitbucketInput = { ...githubInput, provider: "bitbucket" } as const;

    const firstGithubPromise = firstGithub.execute(githubInput);
    await vi.waitFor(() => expect(calls).toEqual(["github:42:true"]));
    const secondGithubPromise = secondGithub.execute(githubUnpinInput);
    const bitbucketPromise = bitbucket.execute(bitbucketInput);
    await vi.waitFor(() =>
      expect(calls).toEqual(["github:42:true", "bitbucket:42:true"]),
    );

    bitbucketGate.resolve(bitbucketInput);
    await bitbucketPromise;
    githubGate.resolve(githubInput);
    await firstGithubPromise;
    await vi.waitFor(() =>
      expect(calls).toEqual(["github:42:true", "bitbucket:42:true", "github:42:false"]),
    );
    githubSecondGate.resolve(githubUnpinInput);
    await secondGithubPromise;
  });

  it("serializes rapid toggles per identity without blocking a different pull request", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const firstGate = deferred<Record<string, unknown>>();
    const secondGate = deferred<Record<string, unknown>>();
    const otherGate = deferred<Record<string, unknown>>();
    const calls: string[] = [];
    const setPinned = vi.fn(
      (input: { number: number; isPinned: boolean }): Promise<Record<string, unknown>> => {
        calls.push(`${input.number}:${input.isPinned}`);
        if (input.number === 42 && input.isPinned) return firstGate.promise;
        if (input.number === 42) return secondGate.promise;
        return otherGate.promise;
      },
    );
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      pullRequests: { setPinned },
    } as never);
    const options = pullRequestSetPinnedMutationOptions(queryClient);
    const mutationCache = queryClient.getMutationCache();
    const first = mutationCache.build(queryClient, options);
    const second = mutationCache.build(queryClient, options);
    const other = mutationCache.build(queryClient, options);
    const firstInput = {
      projectId,
      repository: "acme/widgets",
      number: 42,
      isPinned: true,
    } as const;
    const secondInput = { ...firstInput, isPinned: false } as const;
    const otherInput = { ...firstInput, number: 7 } as const;

    const firstPromise = first.execute(firstInput);
    await vi.waitFor(() => expect(calls).toEqual(["42:true"]));
    const secondPromise = second.execute(secondInput);
    const otherPromise = other.execute(otherInput);
    await vi.waitFor(() => expect(calls).toEqual(["42:true", "7:true"]));

    otherGate.resolve(otherInput);
    await otherPromise;
    firstGate.resolve(firstInput);
    await firstPromise;
    await vi.waitFor(() => expect(calls).toEqual(["42:true", "7:true", "42:false"]));
    secondGate.resolve(secondInput);
    await secondPromise;
  });

  it.each([
    { label: "pin", previous: false, next: true },
    { label: "unpin", previous: true, next: false },
  ])(
    "reconciles All and exact membership when an exact-only row is $label ned",
    async ({ previous, next }) => {
      const queryClient = new QueryClient();
      const projectId = "project-a" as ProjectId;
      const listKey = pullRequestQueryKeys.list({ state: "open", projectId });
      const exactKey = pullRequestsExactInvolvementQueryOptions({
        involvement: "authored",
        state: "open",
        projectId,
      }).queryKey;
      const identity = { projectId, repository: "acme/widgets", number: 42 } as const;
      queryClient.setQueryData(listKey, { entries: [] });
      queryClient.setQueryData(exactKey as QueryKey, {
        entries: [{ ...identity, isPinned: previous }],
      });
      const input = { ...identity, isPinned: next };
      const options = pullRequestSetPinnedMutationOptions(queryClient);
      if (!options.onMutate || !options.onSuccess || !options.onSettled) {
        throw new Error("Pin mutation hooks are missing.");
      }

      const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
      await Reflect.apply(options.onSuccess, undefined, [input, input, context, undefined]);
      await Reflect.apply(options.onSettled, undefined, [input, null, input, context, undefined]);

      expect(queryClient.getQueryData(exactKey)).toEqual({
        entries: [{ ...identity, isPinned: next }],
      });
      expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(exactKey)?.isInvalidated).toBe(true);
    },
  );

  it("patches one project context inside a repository-level global row", async () => {
    const queryClient = new QueryClient();
    const projectA = "project-a" as ProjectId;
    const projectB = "project-b" as ProjectId;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId: null });
    queryClient.setQueryData(listKey, {
      entries: [
        {
          projectId: projectB,
          projectTitle: "Project B",
          headBranch: "feature",
          repository: "Acme/Widgets",
          number: 42,
          isPinned: false,
          projectContexts: [
            { projectId: projectA, projectTitle: "Project A", isPinned: false },
            { projectId: projectB, projectTitle: "Project B", isPinned: false },
          ],
        },
      ],
    });
    const input = {
      projectId: projectA,
      repository: "acme/widgets",
      number: 42,
      isPinned: true,
    } as const;
    const options = pullRequestSetPinnedMutationOptions(queryClient);
    if (!options.onMutate || !options.onSuccess) {
      throw new Error("Pin mutation hooks are missing.");
    }

    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    expect(queryClient.getQueryData(listKey)).toEqual({
      entries: [
        {
          projectId: projectB,
          projectTitle: "Project B",
          headBranch: "feature",
          repository: "Acme/Widgets",
          number: 42,
          isPinned: true,
          projectContexts: [
            { projectId: projectA, projectTitle: "Project A", isPinned: true },
            { projectId: projectB, projectTitle: "Project B", isPinned: false },
          ],
        },
      ],
    });

    await Reflect.apply(options.onSuccess, undefined, [input, input, context, undefined]);
    expect(queryClient.getQueryData(listKey)).toEqual({
      entries: [
        {
          projectId: projectB,
          projectTitle: "Project B",
          headBranch: "feature",
          repository: "Acme/Widgets",
          number: 42,
          isPinned: true,
          projectContexts: [
            { projectId: projectA, projectTitle: "Project A", isPinned: true },
            { projectId: projectB, projectTitle: "Project B", isPinned: false },
          ],
        },
      ],
    });
  });

  it("rolls each cache key back to its own divergent previous pin value", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId });
    const exactKey = pullRequestsExactInvolvementQueryOptions({
      involvement: "reviewing",
      state: "open",
      projectId,
    }).queryKey;
    const identity = { projectId, repository: "acme/widgets", number: 42 } as const;
    queryClient.setQueryData(listKey, {
      entries: [{ ...identity, isPinned: false }],
    });
    queryClient.setQueryData(exactKey as QueryKey, {
      entries: [{ ...identity, isPinned: true }],
    });
    const input = { ...identity, isPinned: true } as const;
    const options = pullRequestSetPinnedMutationOptions(queryClient);
    if (!options.onMutate || !options.onError) {
      throw new Error("Pin mutation hooks are missing.");
    }

    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    expect(queryClient.getQueryData(listKey)).toEqual({
      entries: [{ ...identity, isPinned: true }],
    });
    expect(queryClient.getQueryData(exactKey)).toEqual({
      entries: [{ ...identity, isPinned: true }],
    });

    Reflect.apply(options.onError, undefined, [
      new Error("save failed"),
      input,
      context,
      undefined,
    ]);
    expect(queryClient.getQueryData(listKey)).toEqual({
      entries: [{ ...identity, isPinned: false }],
    });
    expect(queryClient.getQueryData(exactKey)).toEqual({
      entries: [{ ...identity, isPinned: true }],
    });
  });

  it("does not let older callbacks overwrite a newer toggle for the same PR", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId });
    const identity = { projectId, repository: "acme/widgets", number: 42 } as const;
    queryClient.setQueryData(listKey, {
      entries: [{ ...identity, isPinned: false }],
    });
    const pin = { ...identity, isPinned: true } as const;
    const unpin = { ...identity, isPinned: false } as const;
    const options = pullRequestSetPinnedMutationOptions(queryClient);
    if (!options.onMutate || !options.onSuccess || !options.onError) {
      throw new Error("Pin mutation hooks are missing.");
    }

    const pinContext = await Reflect.apply(options.onMutate, undefined, [pin, undefined]);
    await Reflect.apply(options.onMutate, undefined, [unpin, undefined]);
    await Reflect.apply(options.onSuccess, undefined, [pin, pin, pinContext, undefined]);
    Reflect.apply(options.onError, undefined, [
      new Error("older write failed"),
      pin,
      pinContext,
      undefined,
    ]);

    expect(queryClient.getQueryData(listKey)).toEqual({
      entries: [{ ...identity, isPinned: false }],
    });
  });

  it("restores each first-writer baseline when two rapid toggles both fail", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId });
    const exactKey = pullRequestsExactInvolvementQueryOptions({
      involvement: "reviewing",
      state: "open",
      projectId,
    }).queryKey;
    const identity = { projectId, repository: "acme/widgets", number: 42 } as const;
    queryClient.setQueryData(listKey, {
      entries: [{ ...identity, isPinned: false }],
    });
    queryClient.setQueryData(exactKey as QueryKey, {
      entries: [{ ...identity, isPinned: true }],
    });
    const pin = { ...identity, isPinned: true } as const;
    const unpin = { ...identity, isPinned: false } as const;
    const options = pullRequestSetPinnedMutationOptions(queryClient);
    if (!options.onMutate || !options.onError || !options.onSettled) {
      throw new Error("Pin mutation hooks are missing.");
    }

    const pinContext = await Reflect.apply(options.onMutate, undefined, [pin, undefined]);
    const unpinContext = await Reflect.apply(options.onMutate, undefined, [unpin, undefined]);
    Reflect.apply(options.onError, undefined, [
      new Error("pin failed"),
      pin,
      pinContext,
      undefined,
    ]);
    Reflect.apply(options.onSettled, undefined, [
      undefined,
      new Error("pin failed"),
      pin,
      pinContext,
      undefined,
    ]);
    Reflect.apply(options.onError, undefined, [
      new Error("unpin failed"),
      unpin,
      unpinContext,
      undefined,
    ]);

    expect(queryClient.getQueryData(listKey)).toEqual({
      entries: [{ ...identity, isPinned: false }],
    });
    expect(queryClient.getQueryData(exactKey)).toEqual({
      entries: [{ ...identity, isPinned: true }],
    });
    Reflect.apply(options.onSettled, undefined, [
      undefined,
      new Error("unpin failed"),
      unpin,
      unpinContext,
      undefined,
    ]);
  });

  it("restores the last acknowledged pin when only the newer rapid toggle fails", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId });
    const exactKey = pullRequestsExactInvolvementQueryOptions({
      involvement: "authored",
      state: "open",
      projectId,
    }).queryKey;
    const identity = { projectId, repository: "acme/widgets", number: 42 } as const;
    queryClient.setQueryData(listKey, {
      entries: [{ ...identity, isPinned: false }],
    });
    queryClient.setQueryData(exactKey as QueryKey, {
      entries: [{ ...identity, isPinned: true }],
    });
    const pin = { ...identity, isPinned: true } as const;
    const unpin = { ...identity, isPinned: false } as const;
    const options = pullRequestSetPinnedMutationOptions(queryClient);
    if (!options.onMutate || !options.onSuccess || !options.onError || !options.onSettled) {
      throw new Error("Pin mutation hooks are missing.");
    }

    const pinContext = await Reflect.apply(options.onMutate, undefined, [pin, undefined]);
    const unpinContext = await Reflect.apply(options.onMutate, undefined, [unpin, undefined]);
    await Reflect.apply(options.onSuccess, undefined, [pin, pin, pinContext, undefined]);
    // The earlier acknowledgement advances server truth without repainting over the newer
    // optimistic unpin.
    expect(queryClient.getQueryData(listKey)).toEqual({
      entries: [{ ...identity, isPinned: false }],
    });
    Reflect.apply(options.onSettled, undefined, [pin, null, pin, pinContext, undefined]);
    Reflect.apply(options.onError, undefined, [
      new Error("unpin failed"),
      unpin,
      unpinContext,
      undefined,
    ]);

    expect(queryClient.getQueryData(listKey)).toEqual({
      entries: [{ ...identity, isPinned: true }],
    });
    expect(queryClient.getQueryData(exactKey)).toEqual({
      entries: [{ ...identity, isPinned: true }],
    });
    Reflect.apply(options.onSettled, undefined, [
      undefined,
      new Error("unpin failed"),
      unpin,
      unpinContext,
      undefined,
    ]);
  });

  it("does not roll back a pin value replaced after its optimistic write", async () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId });
    const identity = { projectId, repository: "acme/widgets", number: 42 } as const;
    const input = { ...identity, isPinned: true } as const;
    queryClient.setQueryData(listKey, { entries: [input] });
    const options = pullRequestSetPinnedMutationOptions(queryClient);
    if (!options.onMutate || !options.onError) {
      throw new Error("Pin mutation hooks are missing.");
    }

    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    // Simulate a cache source replacing the owned field before this mutation fails. Because
    // the current value is no longer this mutation's optimistic value, it must be left alone.
    queryClient.setQueryData(listKey, {
      entries: [{ ...identity, isPinned: false }],
    });
    Reflect.apply(options.onError, undefined, [
      new Error("save failed"),
      input,
      context,
      undefined,
    ]);

    expect(queryClient.getQueryData(listKey)).toEqual({
      entries: [{ ...identity, isPinned: false }],
    });
  });

  it("leaves unrelated project refetches running while a pin is reconciled", async () => {
    const queryClient = new QueryClient();
    const projectA = "project-pin-scope-a" as ProjectId;
    const projectB = "project-pin-scope-b" as ProjectId;
    const identity = { projectId: projectA, repository: "acme/widgets", number: 42 } as const;
    const listA = pullRequestQueryKeys.list({ state: "open", projectId: projectA });
    const listB = pullRequestQueryKeys.list({ state: "open", projectId: projectB });
    queryClient.setQueryData(listA, { entries: [{ ...identity, isPinned: false }] });
    queryClient.setQueryData(listB, {
      entries: [
        {
          projectId: projectB,
          repository: "other/repository",
          number: 7,
          isPinned: false,
        },
      ],
    });
    const gateA = deferred<{ entries: never[] }>();
    const gateB = deferred<{ entries: never[] }>();
    let projectAAborted = false;
    let projectBAborted = false;
    const refetchA = queryClient
      .fetchQuery({
        queryKey: listA,
        queryFn: ({ signal }) =>
          new Promise<{ entries: never[] }>((resolve, reject) => {
            gateA.promise.then(resolve, reject);
            signal.addEventListener("abort", () => {
              projectAAborted = true;
              reject(new Error("aborted"));
            });
          }),
      })
      .catch(() => undefined);
    const refetchB = queryClient
      .fetchQuery({
        queryKey: listB,
        queryFn: ({ signal }) =>
          new Promise<{ entries: never[] }>((resolve, reject) => {
            gateB.promise.then(resolve, reject);
            signal.addEventListener("abort", () => {
              projectBAborted = true;
              reject(new Error("aborted"));
            });
          }),
      })
      .catch(() => undefined);
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(2));

    const input = { ...identity, isPinned: true } as const;
    const options = pullRequestSetPinnedMutationOptions(queryClient);
    if (!options.onMutate || !options.onSuccess || !options.onSettled) {
      throw new Error("Pin mutation hooks are missing.");
    }
    const context = await Reflect.apply(options.onMutate, undefined, [input, undefined]);
    await Reflect.apply(options.onSuccess, undefined, [input, input, context, undefined]);

    expect(projectAAborted).toBe(true);
    expect(projectBAborted).toBe(false);
    expect(queryClient.isFetching({ queryKey: listB })).toBe(1);

    await Reflect.apply(options.onSettled, undefined, [input, null, input, context, undefined]);
    gateB.resolve({ entries: [] });
    await Promise.all([refetchA, refetchB]);
  });
});
