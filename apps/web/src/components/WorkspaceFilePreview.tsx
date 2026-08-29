// FILE: WorkspaceFilePreview.tsx
// Purpose: Shared single-file preview (code with syntax highlighting, parsed
//          markdown, images, PDFs) for workspace files plus absolute local
//          file references reused by editor and right-dock panes.
// Layer: Web chat presentation component
// Exports: WorkspaceFilePreview, isMarkdownPreviewablePath

import type {
  ProjectFileEncoding,
  ProjectFileLineEnding,
  ProjectReadFileResult,
} from "@synara/contracts";
import {
  isSupportedLocalImagePath,
  isSupportedLocalPdfPath,
  lowerCaseExtensionOf,
} from "@synara/shared/localPreviewFiles";
import {
  isLocalAbsolutePath,
  isWorkspaceRelativePathSafe,
  joinWorkspaceRelativePath,
} from "@synara/shared/path";
import { isScratchWorkspacePath } from "@synara/shared/threadWorkspace";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Component,
  Suspense,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { basenameOfPath } from "~/file-icons";
import { useTheme } from "~/hooks/useTheme";
import { getSelectionWithin, type ChatFileReference } from "~/lib/chatReferences";
import { resolveDiffThemeName, type DiffThemeName } from "~/lib/diffRendering";
import { formatFileCommentRange, type FileCommentSelection } from "~/lib/fileComments";
import { showFileReferenceContextMenu } from "~/lib/fileReferenceContextMenu";
import { PlusIcon } from "~/lib/icons";
import { toggleMarkdownTaskMarker } from "~/lib/markdownTaskList";
import { isRpcCapacityExceededError } from "~/lib/expensiveReadRetry";
import {
  isLocalPreviewGrantUsable,
  projectLocalPreviewGrantQueryOptions,
  projectReadFileQueryOptions,
  projectResolveOutOfRootFileReferenceQueryOptions,
} from "~/lib/projectReactQuery";
import {
  MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS,
  cacheSyntaxHighlightedHtml,
  createSyntaxHighlightCacheKey,
  getCachedSyntaxHighlightedHtml,
  getSyntaxHighlighterPromise,
  getSyntaxLanguageForPath,
  highlightCodeToHtmlWithFallback,
} from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import ChatMarkdown from "./ChatMarkdown";
import { FileLineCommentBox } from "./chat/FileLineCommentBox";
import { PanelStateMessage } from "./chat/PanelStateMessage";
import { useFileLineCommenting } from "./chat/useFileLineCommenting";
import { WorkspaceFilePreviewHeader } from "./chat/WorkspaceFilePreviewHeader";
import { TranscriptSelectionAction } from "./chat/TranscriptSelectionAction";
import { useCodeSelectionAction } from "./chat/useCodeSelectionAction";
import { LocalImagePreview } from "./LocalImagePreview";
import { PdfFilePreview } from "./PdfFilePreview";
import { Skeleton } from "./ui/skeleton";

const MARKDOWN_PREVIEW_EXTENSIONS = new Set([".markdown", ".md", ".mdx"]);

export function isMarkdownPreviewablePath(filePath: string): boolean {
  const extension = lowerCaseExtensionOf(filePath);
  return extension !== null && MARKDOWN_PREVIEW_EXTENSIONS.has(extension);
}

function parentDirectoryFromPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return null;
  }
  return normalized.slice(0, separatorIndex);
}

function markdownPreviewCwd(workspaceRoot: string | null, filePath: string): string | undefined {
  const parentDirectory = parentDirectoryFromPath(filePath);
  if (isLocalAbsolutePath(filePath)) {
    return parentDirectory ?? undefined;
  }
  if (!workspaceRoot) {
    return undefined;
  }
  if (!parentDirectory) {
    return workspaceRoot;
  }
  return joinWorkspaceRelativePath(workspaceRoot, parentDirectory);
}

class FilePreviewHighlightErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

// Above this the plain fallback skips per-line spans (and therefore line
// numbers) to keep the DOM small for huge files.
const MAX_PLAIN_NUMBERED_LINES = 20_000;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function PlainFileContents(props: { contents: string }) {
  // Wrap each line in a .line span (mirroring Shiki output) so the CSS
  // counter gutter applies. Built as an HTML string to avoid per-line React
  // nodes; the trailing \n stays inside each span so selection math and
  // clipboard copies keep working.
  const lines = props.contents.split("\n");
  const numberedHtml =
    props.contents.length === 0 || lines.length > MAX_PLAIN_NUMBERED_LINES
      ? null
      : `<code>${lines
          .map((line, index) =>
            index === lines.length - 1
              ? `<span class="line">${escapeHtml(line)}</span>`
              : `<span class="line">${escapeHtml(line)}\n</span>`,
          )
          .join("")}</code>`;

  if (numberedHtml !== null) {
    return (
      <pre
        className="editor-file-viewer__plain"
        aria-readonly="true"
        dangerouslySetInnerHTML={{ __html: numberedHtml }}
      />
    );
  }

  return (
    <pre className="editor-file-viewer__plain" aria-readonly="true">
      {props.contents}
    </pre>
  );
}

function SyntaxHighlightedFileContents(props: {
  path: string;
  contents: string;
  themeName: DiffThemeName;
}) {
  const language = getSyntaxLanguageForPath(props.path);
  const cacheKey = createSyntaxHighlightCacheKey(props.contents, language, props.themeName);
  const cachedHighlightedHtml = getCachedSyntaxHighlightedHtml(cacheKey);

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="editor-file-viewer__highlight"
        data-syntax-highlighted="true"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  // The uncached path lives in its own component: an early return above must
  // not change this component's hook order once the cache fills.
  return (
    <UncachedSyntaxHighlightedFileContents
      cacheKey={cacheKey}
      contents={props.contents}
      language={language}
      themeName={props.themeName}
    />
  );
}

function UncachedSyntaxHighlightedFileContents(props: {
  cacheKey: string;
  contents: string;
  language: string;
  themeName: DiffThemeName;
}) {
  const highlighter = use(getSyntaxHighlighterPromise(props.language));
  const highlightedHtml = highlightCodeToHtmlWithFallback(
    highlighter,
    props.contents,
    props.language,
    props.themeName,
  );

  useEffect(() => {
    cacheSyntaxHighlightedHtml(props.cacheKey, highlightedHtml, props.contents);
  }, [props.cacheKey, highlightedHtml, props.contents]);

  return (
    <div
      className="editor-file-viewer__highlight"
      data-syntax-highlighted="true"
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
    />
  );
}

// The highlighted body (and its cache lookup) is skipped across selection and
// diff-warming re-renders because its inputs (path, contents, themeName) are
// stable unless the file changes — the React Compiler handles the memoization.
function FileContentsView(props: { path: string; contents: string; themeName: DiffThemeName }) {
  const plain = <PlainFileContents contents={props.contents} />;
  if (props.contents.length === 0 || props.contents.length > MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS) {
    return plain;
  }

  return (
    <FilePreviewHighlightErrorBoundary key={props.path} fallback={plain}>
      <Suspense fallback={plain}>
        <SyntaxHighlightedFileContents
          path={props.path}
          contents={props.contents}
          themeName={props.themeName}
        />
      </Suspense>
    </FilePreviewHighlightErrorBoundary>
  );
}

// Mimics indented code lines so the placeholder reads as a file body
// instead of a generic spinner block.
const FILE_PREVIEW_SKELETON_LINES = [
  { indent: 0, width: "w-5/12" },
  { indent: 0, width: "w-8/12" },
  { indent: 1, width: "w-10/12" },
  { indent: 1, width: "w-7/12" },
  { indent: 2, width: "w-9/12" },
  { indent: 2, width: "w-4/12" },
  { indent: 1, width: "w-6/12" },
  { indent: 0, width: "w-3/12" },
  { indent: 0, width: "w-7/12" },
  { indent: 1, width: "w-9/12" },
  { indent: 1, width: "w-5/12" },
  { indent: 0, width: "w-2/12" },
];

function FilePreviewLoadingState() {
  return (
    <div
      className="min-h-0 flex-1 space-y-2.5 overflow-hidden px-3 py-3"
      role="status"
      aria-label="Loading file..."
    >
      {FILE_PREVIEW_SKELETON_LINES.map((line) => (
        <div key={`${line.indent}-${line.width}`} className="flex h-3 items-center gap-2">
          <Skeleton className="h-2.5 w-5 shrink-0 rounded-full opacity-60" />
          <Skeleton
            className={cn("h-2.5 rounded-full", line.width)}
            style={{ marginLeft: `${line.indent * 1}rem` }}
          />
        </div>
      ))}
      <span className="sr-only">Loading file...</span>
    </div>
  );
}

export interface WorkspaceFilePreviewProps {
  workspaceRoot: string | null;
  /**
   * Workspace-relative path of the previewed file. Binary previews (images,
   * PDFs) may instead be absolute paths outside the workspace — e.g. a
   * session's scratch directory — served by the local-image route, which never
   * touch the workspace-relative file-read RPC.
   */
  filePath: string | null;
  /**
   * Initial markdown render mode per file: the dock opens markdown already
   * parsed, the editor surface stays source-first. The header toggle still
   * lets the user flip either way.
   */
  markdownPreviewDefault?: boolean;
  /** Enables guarded editing for complete, supported files inside the workspace. */
  editable?: boolean;
  /** Shown when no file is selected yet. */
  emptyState?: ReactNode;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
  onCommentInChat?: ((comment: FileCommentSelection) => void) | undefined;
}

type EditableLineEnding = Exclude<ProjectFileLineEnding, "mixed">;

interface EditableFileDocument {
  key: string;
  relativePath: string;
  contents: string;
  version: string;
  encoding: ProjectFileEncoding;
  lineEnding: EditableLineEnding;
}

interface FileEditBuffer extends EditableFileDocument {
  savedContents: string;
  saving: boolean;
  error: string | null;
}

function makeFileEditBuffer(document: EditableFileDocument): FileEditBuffer {
  return {
    ...document,
    savedContents: document.contents,
    saving: false,
    error: null,
  };
}

function resolveFileEditBuffer(
  current: FileEditBuffer | null,
  document: EditableFileDocument,
): FileEditBuffer {
  if (current?.key !== document.key) {
    return makeFileEditBuffer(document);
  }
  const dirty = current.contents !== current.savedContents;
  const sourceChanged =
    current.version !== document.version || current.savedContents !== document.contents;
  return !dirty && sourceChanged ? makeFileEditBuffer(document) : current;
}

function readFileSaveError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Could not save this file.";
}

export function WorkspaceFilePreview(props: WorkspaceFilePreviewProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const contentsRef = useRef<HTMLDivElement>(null);
  const taskWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const latestTaskWriteVersionRef = useRef({ next: 0, byFile: new Map<string, number>() });
  const taskFileDiskVersionRef = useRef(new Map<string, string>());
  const [editBuffer, setEditBuffer] = useState<FileEditBuffer | null>(null);
  const {
    filePath: requestedFilePath,
    onAskWhyInChat,
    onCommentInChat,
    onReferenceInChat,
    workspaceRoot,
  } = props;
  const queryClient = useQueryClient();
  // A workspace-relative reference that fails to read may actually live under
  // an ancestor of the workspace root (agents sometimes emit paths relative to
  // a parent folder, e.g. `Claude/Outbox/note.md` for a thread rooted at
  // `.../Claude/Skills`). When the read errors, the server locates the real
  // file and the preview reopens it as an absolute path through the existing
  // preview-grant flow. The relocation is held in state keyed by the requested
  // reference so the swap cannot oscillate with the failed read it replaces.
  const [relocation, setRelocation] = useState<{
    requestedKey: string;
    fullPath: string;
  } | null>(null);
  const relocationRequestKey = `${workspaceRoot ?? ""}\0${requestedFilePath ?? ""}`;
  const relocatedFullPath =
    relocation?.requestedKey === relocationRequestKey ? relocation.fullPath : null;
  const [binaryPreviewErrorKey, setBinaryPreviewErrorKey] = useState<string | null>(null);
  const filePath = relocatedFullPath ?? requestedFilePath;
  const markdownPreviewDefault = props.markdownPreviewDefault ?? false;
  const fileIsImage = filePath !== null && isSupportedLocalImagePath(filePath);
  const fileIsPdf = filePath !== null && isSupportedLocalPdfPath(filePath);
  const fileIsLocalAbsolute = filePath !== null && isLocalAbsolutePath(filePath);
  const fileIsWorkspaceRelative = filePath !== null && isWorkspaceRelativePathSafe(filePath);
  const fileIsScratchBinaryPreview =
    filePath !== null && (fileIsImage || fileIsPdf) && isScratchWorkspacePath(filePath);
  const fileNeedsLocalPreviewGrant =
    filePath !== null && fileIsLocalAbsolute && !fileIsScratchBinaryPreview;
  const fileIsMarkdown = filePath !== null && isMarkdownPreviewablePath(filePath);
  // Per-file override of the markdown-preview default. Deriving (instead of
  // syncing state in an effect) means switching files applies the default in
  // the same render, with no stale-value flash, and the override dies with its
  // file automatically.
  const [markdownPreviewOverride, setMarkdownPreviewOverride] = useState<{
    filePath: string | null;
    rendered: boolean;
  } | null>(null);
  const markdownPreviewEnabled =
    markdownPreviewOverride !== null && markdownPreviewOverride.filePath === filePath
      ? markdownPreviewOverride.rendered
      : markdownPreviewDefault;
  const localPreviewGrantQuery = useQuery(
    projectLocalPreviewGrantQueryOptions({
      path: filePath,
      enabled: fileNeedsLocalPreviewGrant,
    }),
  );
  const localPreviewGrant =
    fileNeedsLocalPreviewGrant && isLocalPreviewGrantUsable(localPreviewGrantQuery.data)
      ? (localPreviewGrantQuery.data?.grant ?? null)
      : null;
  const binaryPreviewKey = `${props.workspaceRoot ?? ""}\0${filePath ?? ""}\0${localPreviewGrant ?? ""}`;
  const fileQuery = useQuery(
    projectReadFileQueryOptions({
      cwd: props.workspaceRoot,
      relativePath: filePath,
      previewGrant: localPreviewGrant,
      // Images and PDFs are binary: they stream through the local-image HTTP
      // route instead of the text file-read RPC.
      enabled:
        filePath !== null &&
        !fileIsImage &&
        !fileIsPdf &&
        (fileNeedsLocalPreviewGrant ? localPreviewGrant !== null : props.workspaceRoot !== null),
    }),
  );

  // Out-of-root relocation kicks in only after the workspace-relative text
  // read or binary preview has actually failed. A reference the read RPC or
  // local-preview route can still serve must always win over a same-named file
  // outside the root. Keeping the resolver active after relocation lets normal
  // workspace file invalidation restore that priority when the local file is
  // created later.
  const binaryPreviewFailed = binaryPreviewErrorKey === relocationRequestKey;
  const fileReadFailedWithoutContents =
    fileQuery.isError &&
    fileQuery.data === undefined &&
    !isRpcCapacityExceededError(fileQuery.error);
  const outOfRootResolutionEnabled =
    workspaceRoot !== null &&
    requestedFilePath !== null &&
    isWorkspaceRelativePathSafe(requestedFilePath) &&
    (fileReadFailedWithoutContents || binaryPreviewFailed || relocatedFullPath !== null);
  const outOfRootResolutionQuery = useQuery(
    projectResolveOutOfRootFileReferenceQueryOptions({
      cwd: workspaceRoot,
      relativePath: requestedFilePath,
      enabled: outOfRootResolutionEnabled,
    }),
  );
  const resolvedOutOfRootFullPath = outOfRootResolutionQuery.data?.fullPath ?? null;
  const locatingOutOfRootFile =
    outOfRootResolutionEnabled &&
    (outOfRootResolutionQuery.isPending || outOfRootResolutionQuery.isFetching);
  useEffect(() => {
    if (!outOfRootResolutionEnabled || !outOfRootResolutionQuery.isSuccess) {
      return;
    }
    if (resolvedOutOfRootFullPath !== null) {
      setRelocation((current) =>
        current?.requestedKey === relocationRequestKey &&
        current.fullPath === resolvedOutOfRootFullPath
          ? current
          : { requestedKey: relocationRequestKey, fullPath: resolvedOutOfRootFullPath },
      );
      return;
    }
    setRelocation((current) => (current?.requestedKey === relocationRequestKey ? null : current));
    setBinaryPreviewErrorKey((current) => (current === relocationRequestKey ? null : current));
  }, [
    outOfRootResolutionEnabled,
    outOfRootResolutionQuery.isSuccess,
    relocationRequestKey,
    resolvedOutOfRootFullPath,
  ]);
  const handleBinaryPreviewReady = useCallback(() => {
    setBinaryPreviewErrorKey((current) => (current === relocationRequestKey ? null : current));
  }, [relocationRequestKey]);
  const handleBinaryPreviewError = useCallback(() => {
    setBinaryPreviewErrorKey(relocationRequestKey);
  }, [relocationRequestKey]);

  const fileContents = fileQuery.data?.contents ?? "";
  const showMarkdownPreview = fileIsMarkdown && markdownPreviewEnabled;
  const editableDocument: EditableFileDocument | null =
    props.editable &&
    workspaceRoot !== null &&
    filePath !== null &&
    fileIsWorkspaceRelative &&
    fileQuery.data !== undefined &&
    !fileQuery.data.truncated &&
    fileQuery.data.version !== null &&
    fileQuery.data.encoding !== null &&
    fileQuery.data.lineEnding !== null &&
    fileQuery.data.lineEnding !== "mixed"
      ? {
          key: `${workspaceRoot}\0${fileQuery.data.relativePath}`,
          relativePath: fileQuery.data.relativePath,
          contents: fileQuery.data.contents,
          version: fileQuery.data.version,
          encoding: fileQuery.data.encoding,
          lineEnding: fileQuery.data.lineEnding,
        }
      : null;
  const activeEditBuffer = editableDocument
    ? resolveFileEditBuffer(editBuffer, editableDocument)
    : null;
  const editBufferDirty =
    activeEditBuffer !== null && activeEditBuffer.contents !== activeEditBuffer.savedContents;
  const displayedFileContents = activeEditBuffer?.contents ?? fileContents;
  const lineCount =
    displayedFileContents.length === 0 ? 0 : displayedFileContents.split("\n").length;
  const readOnlyReason =
    !props.editable || showMarkdownPreview || fileQuery.data === undefined
      ? null
      : !fileIsWorkspaceRelative
        ? "Only files inside the project can be edited."
        : fileQuery.data.truncated
          ? "Large files are read-only."
          : fileQuery.data.lineEnding === "mixed"
            ? "Files with mixed line endings are read-only to preserve their exact format."
            : fileQuery.data.version === null || fileQuery.data.encoding === null
              ? "This file format is read-only."
              : null;

  const handleEditBufferChange = (contents: string) => {
    if (!editableDocument) return;
    setEditBuffer((current) => ({
      ...resolveFileEditBuffer(current, editableDocument),
      contents,
      error: null,
    }));
  };

  const handleEditBufferSave = async () => {
    if (
      !workspaceRoot ||
      !editableDocument ||
      !activeEditBuffer ||
      !editBufferDirty ||
      activeEditBuffer.saving
    ) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      setEditBuffer((current) => ({
        ...resolveFileEditBuffer(current, editableDocument),
        error: "File saving is unavailable.",
      }));
      return;
    }

    const documentKey = activeEditBuffer.key;
    const contentsToSave = activeEditBuffer.contents;
    const expectedVersion = activeEditBuffer.version;
    setEditBuffer((current) => ({
      ...resolveFileEditBuffer(current, editableDocument),
      saving: true,
      error: null,
    }));

    try {
      const result = await api.projects.writeFile({
        cwd: workspaceRoot,
        relativePath: activeEditBuffer.relativePath,
        contents: contentsToSave,
        expectedVersion,
        encoding: activeEditBuffer.encoding,
        lineEnding: activeEditBuffer.lineEnding,
      });
      const options = projectReadFileQueryOptions({ cwd: workspaceRoot, relativePath: filePath });
      queryClient.setQueryData<ProjectReadFileResult>(options.queryKey, (current) =>
        current ? { ...current, contents: contentsToSave, version: result.version } : current,
      );
      taskFileDiskVersionRef.current.set(`${workspaceRoot}\0${filePath}`, result.version);
      setEditBuffer((current) =>
        current?.key === documentKey
          ? {
              ...current,
              savedContents: contentsToSave,
              version: result.version,
              saving: false,
              error: null,
            }
          : current,
      );
    } catch (error) {
      setEditBuffer((current) =>
        current?.key === documentKey
          ? { ...current, saving: false, error: readFileSaveError(error) }
          : current,
      );
    }
  };

  const handleEditBufferReload = () => {
    if (!editableDocument || !filePath) return;
    const documentKey = editableDocument.key;
    const options = projectReadFileQueryOptions({ cwd: workspaceRoot, relativePath: filePath });
    void queryClient
      .invalidateQueries({ queryKey: options.queryKey })
      .then(() => {
        setEditBuffer((current) => (current?.key === documentKey ? null : current));
      })
      .catch((error: unknown) => {
        setEditBuffer((current) =>
          current?.key === documentKey ? { ...current, error: readFileSaveError(error) } : current,
        );
      });
  };
  // Highlight -> floating "Add to chat" -> reference that points at exactly what
  // was selected, mirroring the transcript flow. This is offered only in the
  // source view, where the DOM mirrors the file's lines/columns 1:1 so a
  // selection resolves to an exact `line 12:5-12` span. The rendered-markdown
  // view restructures the source (paragraphs, lists, headings), so a selection
  // there cannot map back to an exact range — referencing a single word on a
  // 3000-word line would pull in the whole line. The rendered view therefore
  // stays read-only for references (browsing + task-list toggles only); use the
  // Source toggle in the header to get a precise selection reference.
  const readPreviewSelection = (container: HTMLElement): Omit<ChatFileReference, "path"> | null =>
    showMarkdownPreview ? null : getSelectionWithin(container);
  const commitPreviewSelection = (selection: Omit<ChatFileReference, "path">) => {
    if (filePath) {
      onReferenceInChat?.({ path: filePath, ...selection });
    }
  };
  const previewSelectionAction = useCodeSelectionAction({
    enabled: Boolean(onReferenceInChat && filePath) && !showMarkdownPreview && !editableDocument,
    readSelection: readPreviewSelection,
    onCommit: commitPreviewSelection,
  });
  // Hover "+" gutter affordance + inline "Local comment" box. Offered only in
  // the source view, where the DOM mirrors the file's lines 1:1 so the hovered
  // `.line` resolves to an exact line number (the rendered-markdown view
  // restructures the source and cannot map a row back to a file line).
  const lineCommentingEnabled =
    Boolean(onCommentInChat && filePath) && !showMarkdownPreview && !editableDocument;
  const lineCommenting = useFileLineCommenting({
    enabled: lineCommentingEnabled,
    resetKey: filePath,
  });
  const commitLineComment = (
    selection: Pick<FileCommentSelection, "startLine" | "endLine" | "text">,
  ) => {
    if (filePath) {
      onCommentInChat?.({ path: filePath, ...selection });
    }
  };
  // Right-click references the selected line range in the source view,
  // otherwise the whole file. The rendered-markdown view yields no selection
  // (readPreviewSelection returns null there), so it always falls back to the
  // whole-file reference.
  const handleContentsContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!filePath) {
      return;
    }
    event.preventDefault();
    const container = contentsRef.current;
    const selection = container ? readPreviewSelection(container) : null;
    void showFileReferenceContextMenu({
      path: filePath,
      position: { x: event.clientX, y: event.clientY },
      selection,
      onReferenceInChat,
      onAskWhyInChat,
    });
  };
  // Clicking a task checkbox in the markdown preview persists the toggle to
  // disk: optimistic cache update first, ordered write-through after, refetch
  // on failure so the preview never drifts from the file.
  const handleTaskToggle = ({ sourceLine, checked }: { sourceLine: number; checked: boolean }) => {
    if (!workspaceRoot || !filePath) {
      return;
    }
    const options = projectReadFileQueryOptions({ cwd: workspaceRoot, relativePath: filePath });
    const current = queryClient.getQueryData(options.queryKey);
    if (
      !current ||
      current.truncated ||
      current.version === null ||
      current.encoding === null ||
      current.lineEnding === null ||
      current.lineEnding === "mixed"
    ) {
      return;
    }
    // Capture the narrowed disk metadata in locals: the write below runs in a
    // deferred closure where TypeScript no longer sees the null guards above.
    const loadedVersion = current.version;
    const loadedEncoding = current.encoding;
    const loadedLineEnding = current.lineEnding;
    const nextContents = toggleMarkdownTaskMarker(current.contents, sourceLine, checked);
    if (nextContents === null) {
      return;
    }
    // No API means no write can happen — bail before the optimistic update
    // so the preview never shows a toggle that was silently dropped.
    const api = readNativeApi();
    if (!api) {
      return;
    }
    queryClient.setQueryData(options.queryKey, { ...current, contents: nextContents });
    // The read RPC may have resolved a bare/partial reference (e.g. a clicked
    // `notes.md`) to its real nested path. Write back to that resolved path,
    // not the opened reference, so the toggle lands on the file we read from
    // instead of creating a stray file at the workspace root.
    const writeRelativePath = current.relativePath;
    const writeVersionOnDisk = current.version;
    const writeEncoding = current.encoding;
    const writeLineEnding = current.lineEnding;
    // Writes carry the full file contents, so serialize them: a slower earlier
    // checkbox write must never land after a newer toggle and erase it.
    const fileKey = `${workspaceRoot}\0${filePath}`;
    if (!taskFileDiskVersionRef.current.has(fileKey)) {
      taskFileDiskVersionRef.current.set(fileKey, writeVersionOnDisk);
    }
    const writeVersion = latestTaskWriteVersionRef.current.next + 1;
    latestTaskWriteVersionRef.current.next = writeVersion;
    latestTaskWriteVersionRef.current.byFile.set(fileKey, writeVersion);
    taskWriteQueueRef.current = taskWriteQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const result = await api.projects.writeFile({
          cwd: workspaceRoot,
          relativePath: writeRelativePath,
          contents: nextContents,
          expectedVersion: taskFileDiskVersionRef.current.get(fileKey) ?? writeVersionOnDisk,
          encoding: writeEncoding,
          lineEnding: writeLineEnding,
        });
        taskFileDiskVersionRef.current.set(fileKey, result.version);
        queryClient.setQueryData<ProjectReadFileResult>(options.queryKey, (cached) =>
          cached ? { ...cached, version: result.version } : cached,
        );
      })
      .then(() => undefined)
      .catch(() => {
        if (latestTaskWriteVersionRef.current.byFile.get(fileKey) !== writeVersion) {
          return;
        }
        taskFileDiskVersionRef.current.delete(fileKey);
        void queryClient.invalidateQueries({ queryKey: options.queryKey });
      });
    void taskWriteQueueRef.current;
  };
  const handleMarkdownPreviewChange = (rendered: boolean) => {
    setMarkdownPreviewOverride({ filePath, rendered });
  };
  // Toggling a task rewrites the file, so only enable it when the preview
  // holds the complete contents (writing a truncated read would corrupt it).
  const canToggleTasks =
    props.workspaceRoot !== null &&
    fileIsWorkspaceRelative &&
    fileQuery.data !== undefined &&
    !fileQuery.data.truncated &&
    fileQuery.data.version !== null &&
    fileQuery.data.encoding !== null &&
    fileQuery.data.lineEnding !== null &&
    fileQuery.data.lineEnding !== "mixed" &&
    !editBufferDirty;

  if (!props.workspaceRoot && !fileIsLocalAbsolute && !fileIsScratchBinaryPreview) {
    return (
      <PanelStateMessage density="compact" fill="flex">
        <p>No workspace is attached to this chat.</p>
      </PanelStateMessage>
    );
  }

  if (!filePath) {
    return (
      props.emptyState ?? (
        <PanelStateMessage density="compact" fill="flex">
          <p>Select a file from the explorer.</p>
        </PanelStateMessage>
      )
    );
  }
  if (fileNeedsLocalPreviewGrant && !localPreviewGrant) {
    if (localPreviewGrantQuery.error) {
      return (
        <PanelStateMessage density="compact" fill="flex" className="items-start justify-start p-3">
          <p className="text-left text-[11px] text-destructive/85">
            {localPreviewGrantQuery.error instanceof Error
              ? localPreviewGrantQuery.error.message
              : "Could not create local file preview grant."}
          </p>
        </PanelStateMessage>
      );
    }
    return <FilePreviewLoadingState />;
  }

  if (fileIsPdf && locatingOutOfRootFile) {
    return <FilePreviewLoadingState />;
  }

  // PDFs own their full surface — toolbar (file name, page nav, zoom, Open) plus
  // the rendered page stack — so they skip the shared breadcrumb header here.
  if (fileIsPdf) {
    const openInTarget =
      props.workspaceRoot && isWorkspaceRelativePathSafe(filePath)
        ? joinWorkspaceRelativePath(props.workspaceRoot, filePath)
        : filePath;
    return (
      <PdfFilePreview
        key={binaryPreviewKey}
        filePath={filePath}
        cwd={props.workspaceRoot}
        previewGrant={localPreviewGrant}
        openInTarget={openInTarget}
        onPreviewReady={handleBinaryPreviewReady}
        onPreviewError={handleBinaryPreviewError}
      />
    );
  }

  const hoveredCommentLine = lineCommenting.hoveredLine;
  const activeCommentLine = lineCommenting.activeLine;
  const hasFileContents = fileQuery.data !== undefined;
  const fileReadError = fileQuery.error;
  const fileReadCapacityError = isRpcCapacityExceededError(fileReadError);
  const showFileReadErrorIndicator =
    hasFileContents && fileReadError !== null && !activeEditBuffer?.error;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-background-surface)]">
      <WorkspaceFilePreviewHeader
        workspaceRoot={props.workspaceRoot}
        filePath={filePath}
        isMarkdown={fileIsMarkdown}
        markdownPreviewEnabled={showMarkdownPreview}
        onMarkdownPreviewChange={handleMarkdownPreviewChange}
        onReferenceInChat={onReferenceInChat}
        onAskWhyInChat={onAskWhyInChat}
        contentsForCopy={fileIsImage || fileQuery.data === undefined ? null : displayedFileContents}
        truncated={fileQuery.data?.truncated ?? false}
        dirty={editBufferDirty}
        readOnlyReason={readOnlyReason}
      />
      {activeEditBuffer?.error ? (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b border-destructive/25 bg-destructive/5 px-3 py-2 text-[11px] text-destructive"
        >
          <span className="min-w-0 flex-1">{activeEditBuffer.error}</span>
          <button
            type="button"
            className="shrink-0 rounded-md px-2 py-1 font-medium text-foreground/80 hover:bg-foreground/8"
            onClick={handleEditBufferReload}
          >
            Reload from disk
          </button>
        </div>
      ) : showFileReadErrorIndicator ? (
        <div
          role={fileReadCapacityError ? "status" : "alert"}
          className={
            fileReadCapacityError
              ? "flex shrink-0 items-center border-b border-border/60 px-3 py-2 text-[11px] text-muted-foreground"
              : "flex shrink-0 items-center border-b border-destructive/25 bg-destructive/5 px-3 py-2 text-[11px] text-destructive"
          }
        >
          {fileReadCapacityError
            ? fileQuery.isFetching
              ? "Refreshing file..."
              : "File refresh delayed."
            : fileReadError instanceof Error
              ? fileReadError.message
              : "Could not refresh file."}
        </div>
      ) : null}
      {locatingOutOfRootFile ? (
        <FilePreviewLoadingState />
      ) : fileIsImage ? (
        <div
          className="editor-file-viewer min-h-0 flex-1 overflow-auto"
          onContextMenu={handleContentsContextMenu}
        >
          <LocalImagePreview
            key={binaryPreviewKey}
            src={filePath}
            cwd={props.workspaceRoot}
            previewGrant={localPreviewGrant}
            alt={basenameOfPath(filePath)}
            className="min-h-full"
            imageClassName="max-h-[calc(100vh-13rem)]"
            onPreviewReady={handleBinaryPreviewReady}
            onPreviewError={handleBinaryPreviewError}
          />
        </div>
      ) : fileQuery.isLoading ? (
        <FilePreviewLoadingState />
      ) : !hasFileContents && fileReadError ? (
        <PanelStateMessage density="compact" fill="flex" className="items-start justify-start p-3">
          <p className="text-left text-[11px] text-destructive/85">
            {fileReadError instanceof Error ? fileReadError.message : "Could not read file."}
          </p>
        </PanelStateMessage>
      ) : !hasFileContents ? (
        <FilePreviewLoadingState />
      ) : activeEditBuffer && editableDocument && !showMarkdownPreview ? (
        <textarea
          className="editor-file-editor"
          aria-label={`Edit ${filePath}`}
          aria-busy={activeEditBuffer.saving}
          aria-invalid={activeEditBuffer.error ? "true" : undefined}
          value={activeEditBuffer.contents}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => handleEditBufferChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void handleEditBufferSave();
            }
          }}
        />
      ) : (
        <div
          ref={contentsRef}
          className={cn(
            "editor-file-viewer min-h-0 flex-1 overflow-auto",
            showMarkdownPreview && "editor-file-viewer--markdown-preview",
          )}
          onContextMenu={handleContentsContextMenu}
          onMouseUp={previewSelectionAction.onContainerMouseUp}
          onMouseMove={lineCommenting.onContainerMouseMove}
          onMouseLeave={lineCommenting.onContainerMouseLeave}
        >
          {showMarkdownPreview ? (
            <div className="editor-markdown-preview">
              <ChatMarkdown
                text={displayedFileContents}
                cwd={markdownPreviewCwd(props.workspaceRoot, filePath)}
                isStreaming={false}
                className="editor-markdown-preview__body text-sm leading-relaxed"
                {...(canToggleTasks ? { onTaskToggle: handleTaskToggle } : {})}
              />
            </div>
          ) : (
            <FileContentsView path={filePath} contents={fileContents} themeName={diffThemeName} />
          )}
          {!showMarkdownPreview && lineCount > 0 ? (
            <span className="sr-only">{lineCount} lines</span>
          ) : null}
          {previewSelectionAction.pendingAction ? (
            <TranscriptSelectionAction
              left={previewSelectionAction.pendingAction.left}
              top={previewSelectionAction.pendingAction.top}
              placement={previewSelectionAction.pendingAction.placement}
              onAddToChat={previewSelectionAction.commit}
            />
          ) : null}
          {lineCommentingEnabled && hoveredCommentLine && !activeCommentLine ? (
            <button
              type="button"
              className="editor-file-viewer__comment-add"
              style={{
                top: hoveredCommentLine.top,
                left: hoveredCommentLine.left,
                height: hoveredCommentLine.height,
              }}
              aria-label={`Comment on line ${hoveredCommentLine.lineNumber}`}
              title="Comment"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                lineCommenting.openComment(hoveredCommentLine);
              }}
            >
              <span className="editor-file-viewer__comment-add-glyph">
                <PlusIcon className="size-3.5" />
              </span>
            </button>
          ) : null}
          {lineCommentingEnabled && activeCommentLine ? (
            <>
              <div
                className="editor-file-viewer__comment-line-highlight"
                style={{ top: activeCommentLine.top, height: activeCommentLine.height }}
                aria-hidden="true"
              />
              <FileLineCommentBox
                lineLabel={formatFileCommentRange({
                  startLine: activeCommentLine.lineNumber,
                  endLine: activeCommentLine.lineNumber,
                })}
                top={activeCommentLine.top + activeCommentLine.height}
                left={activeCommentLine.left}
                width={Math.max(
                  240,
                  Math.min(440, activeCommentLine.containerWidth - activeCommentLine.left - 16),
                )}
                onCancel={lineCommenting.closeComment}
                onSubmit={(text) => {
                  commitLineComment({
                    startLine: activeCommentLine.lineNumber,
                    endLine: activeCommentLine.lineNumber,
                    text,
                  });
                  lineCommenting.closeComment();
                }}
              />
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
