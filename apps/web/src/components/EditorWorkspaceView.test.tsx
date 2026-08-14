// FILE: EditorWorkspaceView.test.tsx
// Purpose: Guards the editor-style shell layout around file/diff sidebars.
// Layer: Component rendering tests
// Depends on: EditorWorkspaceView and React server rendering.

import type { FileDiffMetadata } from "@pierre/diffs/react";
import { ProjectId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { EditorWorkspaceView } from "./EditorWorkspaceView";
import { WorkspaceSearchSidebar } from "./chat/workspaceExplorer";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("~/hooks/useDesktopTopBarGutter", () => ({
  useDesktopTopBarTrafficLightGutterClassName: () => "traffic-light-gutter",
  useDesktopTopBarWindowControlsGutterClassName: () => "windows-caption-gutter",
}));

function createFileDiff(path: string, additions: number, deletions: number): FileDiffMetadata {
  return {
    cacheKey: path,
    name: path,
    prevName: path,
    hunks: [
      {
        additionLines: additions,
        deletionLines: deletions,
      },
    ],
  } as FileDiffMetadata;
}

describe("EditorWorkspaceView", () => {
  it("renders a project switcher arrow beside the project title", () => {
    const markup = renderToStaticMarkup(
      <EditorWorkspaceView
        workspaceRoot="/Users/tester/project"
        projectName="project"
        currentProjectId={ProjectId.makeUnsafe("project-current")}
        projectOptions={[{ id: ProjectId.makeUnsafe("project-current"), name: "project" }]}
        selectedFilePath={null}
        expandedDirectories={new Set()}
        centerMode="diff"
        diffFiles={[]}
        selectedDiffFilePath={null}
        diffPanel={<div>Diff panel</div>}
        chatPanel={<div>Chat panel</div>}
        onSelectFile={vi.fn()}
        onSelectDiffFile={vi.fn()}
        onToggleDirectory={vi.fn()}
        onCenterModeChange={vi.fn()}
        onExitEditorView={vi.fn()}
        onSelectProject={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Switch project"');
    expect(markup).toContain("project");
  });

  it("reserves a top-bar gutter for Windows caption controls", () => {
    const markup = renderToStaticMarkup(
      <EditorWorkspaceView
        workspaceRoot="/Users/tester/project"
        projectName="project"
        selectedFilePath={null}
        expandedDirectories={new Set()}
        centerMode="diff"
        diffFiles={[]}
        selectedDiffFilePath={null}
        diffPanel={<div>Diff panel</div>}
        chatPanel={<div>Chat panel</div>}
        onSelectFile={vi.fn()}
        onSelectDiffFile={vi.fn()}
        onToggleDirectory={vi.fn()}
        onCenterModeChange={vi.fn()}
        onExitEditorView={vi.fn()}
      />,
    );

    expect(markup).toContain("windows-caption-gutter");
  });

  it("renders diff options beside the changed-file line totals", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider>
        <EditorWorkspaceView
          workspaceRoot="/Users/tester/project"
          projectName="project"
          selectedFilePath={null}
          expandedDirectories={new Set()}
          centerMode="diff"
          diffFiles={[createFileDiff("apps/web/src/components/EditorWorkspaceView.tsx", 3, 1)]}
          selectedDiffFilePath={null}
          diffOptionsControl={
            <button type="button" aria-label="Diff options">
              Options
            </button>
          }
          diffPanel={<div>Diff panel</div>}
          chatPanel={<div>Chat panel</div>}
          onSelectFile={vi.fn()}
          onSelectDiffFile={vi.fn()}
          onToggleDirectory={vi.fn()}
          onCenterModeChange={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </SidebarProvider>,
    );

    expect(markup).toContain("Changed files");
    expect(markup).toContain("+3");
    expect(markup).toContain("-1");
    expect(markup).toContain('aria-label="Diff options"');

    // Options sit in the "Changed files" header row; the +/- totals render in
    // the stats row below it.
    const changedFilesIndex = markup.indexOf("Changed files");
    const optionsIndex = markup.indexOf('aria-label="Diff options"', changedFilesIndex);
    const additionsIndex = markup.indexOf(">+3<", optionsIndex);
    const deletionsIndex = markup.indexOf(">-1<", additionsIndex);

    expect(optionsIndex).toBeGreaterThan(changedFilesIndex);
    expect(additionsIndex).toBeGreaterThan(optionsIndex);
    expect(deletionsIndex).toBeGreaterThan(additionsIndex);
  });

  it("shows skeleton rows instead of the empty message while the diff loads", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider>
        <EditorWorkspaceView
          workspaceRoot="/Users/tester/project"
          projectName="project"
          selectedFilePath={null}
          expandedDirectories={new Set()}
          centerMode="diff"
          diffFiles={[]}
          diffFilesLoading={true}
          selectedDiffFilePath={null}
          diffPanel={<div>Diff panel</div>}
          chatPanel={<div>Chat panel</div>}
          onSelectFile={vi.fn()}
          onSelectDiffFile={vi.fn()}
          onToggleDirectory={vi.fn()}
          onCenterModeChange={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </SidebarProvider>,
    );

    expect(markup).toContain('aria-label="Loading changed files..."');
    expect(markup).not.toContain("No files in this diff.");
  });

  it("keeps the diff panel mounted but hidden while browsing files", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <EditorWorkspaceView
            workspaceRoot={null}
            projectName="project"
            selectedFilePath={null}
            expandedDirectories={new Set()}
            centerMode="file"
            diffFiles={[]}
            selectedDiffFilePath={null}
            diffPanel={<div>Diff panel body</div>}
            chatPanel={<div>Chat panel</div>}
            onSelectFile={vi.fn()}
            onSelectDiffFile={vi.fn()}
            onToggleDirectory={vi.fn()}
            onCenterModeChange={vi.fn()}
            onExitEditorView={vi.fn()}
          />
        </SidebarProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain("Diff panel body");
    const diffWrapperIndex = markup.indexOf("Diff panel body");
    const hiddenIndex = markup.lastIndexOf("hidden", diffWrapperIndex);
    expect(hiddenIndex).toBeGreaterThan(-1);
  });

  it("renders image files through the local image preview instead of text preview", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EditorWorkspaceView
          workspaceRoot="/Users/tester/project"
          projectName="project"
          selectedFilePath="assets/screenshot.png"
          expandedDirectories={new Set()}
          centerMode="file"
          diffFiles={[]}
          selectedDiffFilePath={null}
          diffPanel={<div>Diff panel</div>}
          chatPanel={<div>Chat panel</div>}
          onSelectFile={vi.fn()}
          onSelectDiffFile={vi.fn()}
          onToggleDirectory={vi.fn()}
          onCenterModeChange={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("local-image-preview");
    expect(markup).toContain(
      "/api/local-image?path=assets%2Fscreenshot.png&amp;cwd=%2FUsers%2Ftester%2Fproject",
    );
    expect(markup).not.toContain("editor-file-viewer__plain");
    expect(markup).not.toContain("editor-file-viewer__highlight");
  });

  it("renders PDF files through the in-app PDF viewer instead of the text preview", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EditorWorkspaceView
          workspaceRoot="/Users/tester/project"
          projectName="project"
          selectedFilePath="docs/spec.pdf"
          expandedDirectories={new Set()}
          centerMode="file"
          diffFiles={[]}
          selectedDiffFilePath={null}
          diffPanel={<div>Diff panel</div>}
          chatPanel={<div>Chat panel</div>}
          onSelectFile={vi.fn()}
          onSelectDiffFile={vi.fn()}
          onToggleDirectory={vi.fn()}
          onCenterModeChange={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </QueryClientProvider>,
    );

    // The custom viewer renders its own surface (here the initial loading state
    // since document fetch runs in an effect) rather than the browser iframe or
    // the text preview.
    expect(markup).toContain('aria-label="Loading PDF..."');
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("editor-file-viewer__plain");
    expect(markup).not.toContain("editor-file-viewer__highlight");
  });

  it("renders scratch-workspace PDF previews without an attached workspace", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EditorWorkspaceView
          workspaceRoot={null}
          projectName="project"
          selectedFilePath="/tmp/synara-codex-workspaces/thread-1/report.pdf"
          expandedDirectories={new Set()}
          centerMode="file"
          diffFiles={[]}
          selectedDiffFilePath={null}
          diffPanel={<div>Diff panel</div>}
          chatPanel={<div>Chat panel</div>}
          onSelectFile={vi.fn()}
          onSelectDiffFile={vi.fn()}
          onToggleDirectory={vi.fn()}
          onCenterModeChange={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('aria-label="Loading PDF..."');
    expect(markup).not.toContain("No workspace is attached");
  });

  it("renders scratch-workspace image previews without an attached workspace", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EditorWorkspaceView
          workspaceRoot={null}
          projectName="project"
          selectedFilePath="/tmp/synara-codex-workspaces/thread-1/shot.png"
          expandedDirectories={new Set()}
          centerMode="file"
          diffFiles={[]}
          selectedDiffFilePath={null}
          diffPanel={<div>Diff panel</div>}
          chatPanel={<div>Chat panel</div>}
          onSelectFile={vi.fn()}
          onSelectDiffFile={vi.fn()}
          onToggleDirectory={vi.fn()}
          onCenterModeChange={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("local-image-preview");
    expect(markup).toContain(
      "/api/local-image?path=%2Ftmp%2Fsynara-codex-workspaces%2Fthread-1%2Fshot.png",
    );
    expect(markup).not.toContain("No workspace is attached");
    expect(markup).not.toContain("cwd=");
  });

  it("renders absolute local image previews without an attached workspace", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EditorWorkspaceView
          workspaceRoot={null}
          projectName="project"
          selectedFilePath="/Users/tester/Downloads/shot.png"
          expandedDirectories={new Set()}
          centerMode="file"
          diffFiles={[]}
          selectedDiffFilePath={null}
          diffPanel={<div>Diff panel</div>}
          chatPanel={<div>Chat panel</div>}
          onSelectFile={vi.fn()}
          onSelectDiffFile={vi.fn()}
          onToggleDirectory={vi.fn()}
          onCenterModeChange={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('aria-label="Loading file..."');
    expect(markup).not.toContain("/api/local-image?path=%2FUsers%2Ftester%2FDownloads%2Fshot.png");
    expect(markup).not.toContain("No workspace is attached");
    expect(markup).not.toContain("cwd=");
  });

  it("shows the file-preview path breadcrumb and overflow menu for Markdown files", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EditorWorkspaceView
          workspaceRoot="/Users/tester/project"
          projectName="project"
          selectedFilePath="docs/README.md"
          expandedDirectories={new Set()}
          centerMode="file"
          diffFiles={[]}
          selectedDiffFilePath={null}
          diffPanel={<div>Diff panel</div>}
          chatPanel={<div>Chat panel</div>}
          onSelectFile={vi.fn()}
          onSelectDiffFile={vi.fn()}
          onToggleDirectory={vi.fn()}
          onCenterModeChange={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </QueryClientProvider>,
    );

    // The header renders a path breadcrumb (project › …dirs › file).
    expect(markup).toContain('aria-label="File path"');
    expect(markup).toContain("README.md");
    // Markdown files surface their source/rendered toggle in the header next
    // to the Open-in picker, whose editor menu trigger is always rendered.
    expect(markup).toContain('aria-label="Markdown view"');
    expect(markup).toContain('aria-label="Editor options"');
  });

  it("shows the HTML source/preview toggle when an HTML file is selected", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EditorWorkspaceView
          workspaceRoot="/Users/tester/project"
          projectName="project"
          selectedFilePath="decks/finance_deck.html"
          expandedDirectories={new Set()}
          centerMode="file"
          diffFiles={[]}
          selectedDiffFilePath={null}
          diffPanel={<div>Diff panel</div>}
          chatPanel={<div>Chat panel</div>}
          onSelectFile={vi.fn()}
          onSelectDiffFile={vi.fn()}
          onToggleDirectory={vi.fn()}
          onCenterModeChange={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('aria-label="File path"');
    expect(markup).toContain("finance_deck.html");
    expect(markup).toContain('aria-label="HTML view"');
    expect(markup).not.toContain('aria-label="Markdown view"');
  });

  it("renders HTML files as a page preview instead of source", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      projectQueryKeys.readFile("/Users/tester/project", "decks/finance_deck.html"),
      {
        relativePath: "decks/finance_deck.html",
        contents: "<html><body><h1>Quarterly review</h1></body></html>",
        truncated: false,
        version: "1",
        encoding: "utf8",
        lineEnding: "lf",
      },
    );
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EditorWorkspaceView
          workspaceRoot="/Users/tester/project"
          projectName="project"
          selectedFilePath="decks/finance_deck.html"
          expandedDirectories={new Set()}
          centerMode="file"
          diffFiles={[]}
          selectedDiffFilePath={null}
          diffPanel={<div>Diff panel</div>}
          chatPanel={<div>Chat panel</div>}
          onSelectFile={vi.fn()}
          onSelectDiffFile={vi.fn()}
          onToggleDirectory={vi.fn()}
          onCenterModeChange={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("<iframe");
    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).toContain("Quarterly review");
    expect(markup).toContain("editor-html-preview");
    expect(markup).not.toContain("editor-file-viewer__plain");
    expect(markup).not.toContain("editor-file-viewer__highlight");
    expect(markup).not.toContain('aria-label="Edit decks/finance_deck.html"');
  });

  it("renders a search item in the activity bar below files and diff", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <EditorWorkspaceView
            workspaceRoot="/Users/tester/project"
            projectName="project"
            selectedFilePath={null}
            expandedDirectories={new Set()}
            centerMode="file"
            diffFiles={[]}
            selectedDiffFilePath={null}
            diffPanel={<div>Diff panel</div>}
            chatPanel={<div>Chat panel</div>}
            onSelectFile={vi.fn()}
            onSelectDiffFile={vi.fn()}
            onToggleDirectory={vi.fn()}
            onCenterModeChange={vi.fn()}
            onExitEditorView={vi.fn()}
          />
        </SidebarProvider>
      </QueryClientProvider>,
    );

    const filesIndex = markup.indexOf('aria-label="Hide files sidebar"');
    const diffIndex = markup.indexOf('aria-label="Diff"');
    const searchIndex = markup.indexOf('aria-label="Search files"');
    expect(filesIndex).toBeGreaterThan(-1);
    expect(diffIndex).toBeGreaterThan(filesIndex);
    expect(searchIndex).toBeGreaterThan(diffIndex);
  });

  it("prompts for a query in the search sidebar before searching", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSearchSidebar
          workspaceRoot="/Users/tester/project"
          query=""
          onQueryChange={vi.fn()}
          selectedFilePath={null}
          onSelectFile={vi.fn()}
          onReferenceInChat={undefined}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('placeholder="Search files..."');
    expect(markup).toContain("Search files by name or path.");
  });

  it("lists only matching files from the workspace search results", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      projectQueryKeys.searchEntries("/Users/tester/project", "editor", 80, "file"),
      {
        entries: [{ path: "apps/web/src/components/EditorWorkspaceView.tsx", kind: "file" }],
        truncated: false,
      },
    );
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSearchSidebar
          workspaceRoot="/Users/tester/project"
          query="editor"
          onQueryChange={vi.fn()}
          selectedFilePath="apps/web/src/components/EditorWorkspaceView.tsx"
          onSelectFile={vi.fn()}
          onReferenceInChat={undefined}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('title="apps/web/src/components/EditorWorkspaceView.tsx"');
    expect(markup).toContain("EditorWorkspaceView.tsx");
    expect(markup).not.toContain("No matching files.");
  });

  it("shows pointer cursor on activity buttons that switch files and diff", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <EditorWorkspaceView
            workspaceRoot="/Users/tester/project"
            projectName="project"
            selectedFilePath={null}
            expandedDirectories={new Set()}
            centerMode="file"
            diffFiles={[]}
            selectedDiffFilePath={null}
            diffPanel={<div>Diff panel</div>}
            chatPanel={<div>Chat panel</div>}
            onSelectFile={vi.fn()}
            onSelectDiffFile={vi.fn()}
            onToggleDirectory={vi.fn()}
            onCenterModeChange={vi.fn()}
            onExitEditorView={vi.fn()}
          />
        </SidebarProvider>
      </QueryClientProvider>,
    );

    // Files is the active mode with a visible sidebar, so its button reads as
    // a sidebar collapse toggle; Diff stays a plain mode switch.
    expect(markup).toContain('aria-label="Hide files sidebar"');
    expect(markup).toContain('aria-label="Diff"');
    expect(markup.match(/cursor-pointer/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
