import { EventEmitter } from "node:events";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";

import type { BrowserCssSelector } from "@synara/contracts";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import {
  configureWorkspaceUploadForTests,
  resolveWorkspaceUploadFiles,
  uploadBrowserFiles,
} from "./workspaceUpload";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "test-must-inject-user-data") },
}));

const temporaryDirectories: string[] = [];

const workspaceFixture = async () => {
  const base = await mkdtemp(join(tmpdir(), "synara-browser-upload-"));
  temporaryDirectories.push(base);
  const workspaceRoot = join(base, "workspace");
  await mkdir(join(workspaceRoot, "fixtures"), { recursive: true });
  await writeFile(join(workspaceRoot, "fixtures", "avatar.txt"), "avatar");
  return { base, workspaceRoot };
};

const createRuntime = (
  onSetFiles?: (files: readonly string[]) => Promise<void> | void,
  uploadConfiguration?: {
    readonly userDataRoot: string;
    readonly maxInvocationBytes?: number;
    readonly maxStagedBytesPerWebContents?: number;
    readonly maxStagedDirectoriesPerWebContents?: number;
    readonly maxStagedFilesPerWebContents?: number;
  },
  multiple = false,
): {
  readonly lifecycle: EventEmitter;
  readonly runtime: BrowserAutomationVisibleRuntime;
  readonly sendCommand: ReturnType<typeof vi.fn>;
} => {
  const lifecycle = new EventEmitter();
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 12 };
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "");
      if (expression.includes("const matches = []")) {
        return { result: { value: { count: 1, generation: 1 } } };
      }
      if (expression.includes("globalThis.__synaraBrowserAutomationV1.currentTarget")) {
        return { result: { objectId: "file-input", subtype: "node" } };
      }
    }
    if (method === "Runtime.callFunctionOn") {
      const declaration = String(params?.functionDeclaration ?? "");
      if (declaration.includes("String(this.type)")) {
        return { result: { value: { ok: true, enabled: true, multiple } } };
      }
      return {
        result: {
          value: {
            attached: true,
            visible: false,
            enabled: true,
            editable: false,
            role: "textbox",
            name: "Avatar",
            point: { x: 0, y: 0 },
          },
        },
      };
    }
    if (method === "DOM.setFileInputFiles") {
      await onSetFiles?.(params?.files as readonly string[]);
    }
    return {};
  });
  const webContents = Object.assign(lifecycle, {
    id: 42,
    isDestroyed: () => false,
    debugger: { isAttached: () => true, attach: vi.fn(), sendCommand },
  }) as unknown as WebContents;
  const runtime = {
    threadId: "thread-upload" as BrowserAutomationVisibleRuntime["threadId"],
    tabId: "3cc23e3f-fb69-499a-8e0c-a74b0cd5330a",
    webContents,
  } satisfies BrowserAutomationVisibleRuntime;
  if (uploadConfiguration) {
    configureWorkspaceUploadForTests(webContents, uploadConfiguration);
  }
  return { lifecycle, runtime, sendCommand };
};

const eventuallyMissing = async (path: string): Promise<void> => {
  await vi.waitFor(async () => {
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("workspace-confined browser upload", () => {
  it("resolves regular files to canonical paths inside the canonical workspace", async () => {
    const { workspaceRoot } = await workspaceFixture();
    const canonicalRoot = await realpath(workspaceRoot);

    await expect(
      resolveWorkspaceUploadFiles(workspaceRoot, ["fixtures/avatar.txt"]),
    ).resolves.toEqual([
      {
        path: join(canonicalRoot, "fixtures", "avatar.txt"),
        name: "avatar.txt",
        byteLength: 6,
      },
    ]);
  });

  it("rejects traversal and symlinks whose final target leaves the workspace", async () => {
    const { base, workspaceRoot } = await workspaceFixture();
    const outsideDirectory = join(base, "outside");
    await mkdir(outsideDirectory);
    await writeFile(join(outsideDirectory, "outside.txt"), "secret");
    await symlink(
      outsideDirectory,
      join(workspaceRoot, "fixtures", "outside-link"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      resolveWorkspaceUploadFiles(workspaceRoot, ["../outside/outside.txt"]),
    ).rejects.toMatchObject({ browserError: { code: "BrowserUploadPathOutsideWorkspace" } });
    await expect(
      resolveWorkspaceUploadFiles(workspaceRoot, ["fixtures/outside-link/outside.txt"]),
    ).rejects.toMatchObject({ browserError: { code: "BrowserUploadPathOutsideWorkspace" } });
  });

  it("replaces stale staging state under the injected private userData root", async () => {
    const { base, workspaceRoot } = await workspaceFixture();
    const userDataRoot = join(base, "user-data");
    const stagingBase = join(userDataRoot, "private-runtime", "browser-upload-staging");
    const stalePath = join(stagingBase, "stale-from-crashed-process.txt");
    await mkdir(stagingBase, { recursive: true });
    await writeFile(stalePath, "stale");
    let stagedPath = "";
    const { lifecycle, runtime } = createRuntime(
      (files) => {
        stagedPath = files[0] ?? "";
      },
      { userDataRoot },
    );

    await uploadBrowserFiles(
      runtime,
      {
        target: { selector: 'input[type="file"]' as BrowserCssSelector },
        paths: ["fixtures/avatar.txt"],
      },
      undefined,
      workspaceRoot,
    );

    await expect(stat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(relative(await realpath(stagingBase), stagedPath)).not.toMatch(/^\.\.(?:\/|$)/);
    if (process.platform !== "win32") {
      expect((await stat(stagingBase)).mode & 0o777).toBe(0o700);
      expect((await stat(stagedPath)).mode & 0o777).toBe(0o600);
    }

    lifecycle.emit("destroyed");
    await eventuallyMissing(stagedPath);
  });

  it("hands Chromium a private staged copy and releases it after navigation", async () => {
    const { base, workspaceRoot } = await workspaceFixture();
    let stagedPath = "";
    const { lifecycle, runtime, sendCommand } = createRuntime(
      (files) => {
        stagedPath = files[0] ?? "";
      },
      { userDataRoot: join(base, "user-data") },
    );

    await expect(
      uploadBrowserFiles(
        runtime,
        {
          target: { selector: 'input[type="file"]' as BrowserCssSelector },
          paths: ["fixtures/avatar.txt"],
        },
        undefined,
        workspaceRoot,
      ),
    ).resolves.toMatchObject({
      tabId: runtime.tabId,
      files: [{ name: "avatar.txt", byteLength: 6 }],
    });

    expect(sendCommand).toHaveBeenCalledWith("DOM.setFileInputFiles", {
      objectId: "file-input",
      files: [stagedPath],
    });
    expect(stagedPath).not.toBe("");
    expect(basename(stagedPath)).toBe("avatar.txt");
    const pathFromWorkspace = relative(workspaceRoot, stagedPath);
    expect(isAbsolute(pathFromWorkspace) || pathFromWorkspace.startsWith("..")).toBe(true);
    await expect(readFile(stagedPath, "utf8")).resolves.toBe("avatar");

    lifecycle.emit("did-navigate");
    await eventuallyMissing(stagedPath);
  });

  it("is unaffected by a workspace path swap after validation", async () => {
    const { base, workspaceRoot } = await workspaceFixture();
    const workspaceFile = join(workspaceRoot, "fixtures", "avatar.txt");
    const outside = join(base, "outside.txt");
    await writeFile(outside, "secret");
    let stagedPath = "";
    let bytesSeenByChromium = "";
    const { lifecycle, runtime } = createRuntime(
      async (files) => {
        stagedPath = files[0] ?? "";
        // This callback is the deterministic hand-off boundary: resolution and
        // staging have completed, but the fake Chromium consumer has not opened
        // the path yet.
        await rm(workspaceFile);
        await link(outside, workspaceFile);
        bytesSeenByChromium = await readFile(stagedPath, "utf8");
      },
      { userDataRoot: join(base, "user-data") },
    );

    await uploadBrowserFiles(
      runtime,
      {
        target: { selector: 'input[type="file"]' as BrowserCssSelector },
        paths: ["fixtures/avatar.txt"],
      },
      undefined,
      workspaceRoot,
    );

    expect(bytesSeenByChromium).toBe("avatar");
    await expect(readFile(workspaceFile, "utf8")).resolves.toBe("secret");
    lifecycle.emit("destroyed");
    await eventuallyMissing(stagedPath);
  });

  it("retains a possibly committed copy after a CDP error until the tab is destroyed", async () => {
    const { base, workspaceRoot } = await workspaceFixture();
    let stagedPath = "";
    const { lifecycle, runtime } = createRuntime(
      (files) => {
        stagedPath = files[0] ?? "";
        throw new Error("CDP response was lost");
      },
      { userDataRoot: join(base, "user-data") },
    );

    await expect(
      uploadBrowserFiles(
        runtime,
        {
          target: { selector: 'input[type="file"]' as BrowserCssSelector },
          paths: ["fixtures/avatar.txt"],
        },
        undefined,
        workspaceRoot,
      ),
    ).rejects.toBeDefined();
    await expect(readFile(stagedPath, "utf8")).resolves.toBe("avatar");

    lifecycle.emit("destroyed");
    await eventuallyMissing(stagedPath);
  });

  it("rejects uploads above the cumulative per-invocation quota before staging", async () => {
    const { base, workspaceRoot } = await workspaceFixture();
    const { runtime, sendCommand } = createRuntime(undefined, {
      userDataRoot: join(base, "user-data"),
      maxInvocationBytes: 5,
      maxStagedBytesPerWebContents: 10,
    });

    await expect(
      uploadBrowserFiles(
        runtime,
        {
          target: { selector: 'input[type="file"]' as BrowserCssSelector },
          paths: ["fixtures/avatar.txt"],
        },
        undefined,
        workspaceRoot,
      ),
    ).rejects.toMatchObject({ browserError: { code: "BrowserUploadFileUnsupported" } });
    expect(sendCommand).not.toHaveBeenCalledWith("DOM.setFileInputFiles", expect.anything());
  });

  it("limits retained zero-byte upload directories until navigation cleanup succeeds", async () => {
    const { base, workspaceRoot } = await workspaceFixture();
    await writeFile(join(workspaceRoot, "fixtures", "empty.txt"), "");
    const stagedPaths: string[] = [];
    const { lifecycle, runtime, sendCommand } = createRuntime(
      (files) => {
        stagedPaths.push(files[0] ?? "");
      },
      {
        userDataRoot: join(base, "user-data"),
        maxInvocationBytes: 0,
        maxStagedBytesPerWebContents: 0,
        maxStagedDirectoriesPerWebContents: 2,
        maxStagedFilesPerWebContents: 10,
      },
    );
    const upload = () =>
      uploadBrowserFiles(
        runtime,
        {
          target: { selector: 'input[type="file"]' as BrowserCssSelector },
          paths: ["fixtures/empty.txt"],
        },
        undefined,
        workspaceRoot,
      );

    await expect(upload()).resolves.toBeDefined();
    await expect(upload()).resolves.toBeDefined();
    await expect(upload()).rejects.toMatchObject({
      browserError: { code: "BrowserUploadFileUnsupported" },
    });
    expect(
      sendCommand.mock.calls.filter(([method]) => method === "DOM.setFileInputFiles"),
    ).toHaveLength(2);

    lifecycle.emit("did-navigate");
    await Promise.all(stagedPaths.map(eventuallyMissing));
    await expect(upload()).resolves.toBeDefined();

    lifecycle.emit("destroyed");
    await eventuallyMissing(stagedPaths[2] ?? "");
  });

  it("limits retained zero-byte files and removes them when the tab is destroyed", async () => {
    const { base, workspaceRoot } = await workspaceFixture();
    await writeFile(join(workspaceRoot, "fixtures", "empty-a.txt"), "");
    await writeFile(join(workspaceRoot, "fixtures", "empty-b.txt"), "");
    const userDataRoot = join(base, "user-data");
    const stagedPaths: string[] = [];
    const configuration = {
      userDataRoot,
      maxInvocationBytes: 0,
      maxStagedBytesPerWebContents: 0,
      maxStagedDirectoriesPerWebContents: 10,
      maxStagedFilesPerWebContents: 2,
    } as const;
    const { lifecycle, runtime, sendCommand } = createRuntime(
      (files) => {
        stagedPaths.push(...files);
      },
      configuration,
      true,
    );
    const upload = (paths: readonly string[]) =>
      uploadBrowserFiles(
        runtime,
        {
          target: { selector: 'input[type="file"]' as BrowserCssSelector },
          paths: [...paths],
        },
        undefined,
        workspaceRoot,
      );

    await expect(upload(["fixtures/empty-a.txt", "fixtures/empty-b.txt"])).resolves.toBeDefined();
    await expect(upload(["fixtures/empty-a.txt"])).rejects.toMatchObject({
      browserError: { code: "BrowserUploadFileUnsupported" },
    });
    expect(
      sendCommand.mock.calls.filter(([method]) => method === "DOM.setFileInputFiles"),
    ).toHaveLength(1);

    lifecycle.emit("destroyed");
    await Promise.all(stagedPaths.map(eventuallyMissing));

    const nextRuntime = createRuntime(undefined, configuration, true);
    await expect(
      uploadBrowserFiles(
        nextRuntime.runtime,
        {
          target: { selector: 'input[type="file"]' as BrowserCssSelector },
          paths: ["fixtures/empty-a.txt", "fixtures/empty-b.txt"],
        },
        undefined,
        workspaceRoot,
      ),
    ).resolves.toBeDefined();
    nextRuntime.lifecycle.emit("destroyed");
  });

  it("charges retained copies to the WebContents quota until navigation cleanup finishes", async () => {
    const { base, workspaceRoot } = await workspaceFixture();
    const stagedPaths: string[] = [];
    const { lifecycle, runtime, sendCommand } = createRuntime(
      (files) => {
        stagedPaths.push(files[0] ?? "");
      },
      {
        userDataRoot: join(base, "user-data"),
        maxInvocationBytes: 6,
        maxStagedBytesPerWebContents: 10,
      },
    );
    const upload = () =>
      uploadBrowserFiles(
        runtime,
        {
          target: { selector: 'input[type="file"]' as BrowserCssSelector },
          paths: ["fixtures/avatar.txt"],
        },
        undefined,
        workspaceRoot,
      );

    await expect(upload()).resolves.toBeDefined();
    await expect(upload()).rejects.toMatchObject({
      browserError: { code: "BrowserUploadFileUnsupported" },
    });
    expect(
      sendCommand.mock.calls.filter(([method]) => method === "DOM.setFileInputFiles"),
    ).toHaveLength(1);

    lifecycle.emit("did-navigate");
    await eventuallyMissing(stagedPaths[0] ?? "");
    await expect(upload()).resolves.toBeDefined();
    expect(
      sendCommand.mock.calls.filter(([method]) => method === "DOM.setFileInputFiles"),
    ).toHaveLength(2);

    lifecycle.emit("destroyed");
    await eventuallyMissing(stagedPaths[1] ?? "");
  });

  it("keeps an ambiguous CDP result charged until lifecycle cleanup", async () => {
    const { base, workspaceRoot } = await workspaceFixture();
    let rejectCdp = true;
    const stagedPaths: string[] = [];
    const { lifecycle, runtime, sendCommand } = createRuntime(
      (files) => {
        stagedPaths.push(files[0] ?? "");
        if (rejectCdp) throw new Error("CDP response was lost");
      },
      {
        userDataRoot: join(base, "user-data"),
        maxInvocationBytes: 6,
        maxStagedBytesPerWebContents: 10,
      },
    );
    const upload = () =>
      uploadBrowserFiles(
        runtime,
        {
          target: { selector: 'input[type="file"]' as BrowserCssSelector },
          paths: ["fixtures/avatar.txt"],
        },
        undefined,
        workspaceRoot,
      );

    await expect(upload()).rejects.toBeDefined();
    await expect(upload()).rejects.toMatchObject({
      browserError: { code: "BrowserUploadFileUnsupported" },
    });
    expect(
      sendCommand.mock.calls.filter(([method]) => method === "DOM.setFileInputFiles"),
    ).toHaveLength(1);

    lifecycle.emit("did-navigate");
    await eventuallyMissing(stagedPaths[0] ?? "");
    rejectCdp = false;
    await expect(upload()).resolves.toBeDefined();

    lifecycle.emit("destroyed");
    await eventuallyMissing(stagedPaths[1] ?? "");
  });
});
