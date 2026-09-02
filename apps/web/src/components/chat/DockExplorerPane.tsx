// FILE: DockExplorerPane.tsx
// Purpose: Right-dock pane that embeds the unified workspace explorer (a fixed
//          search box over the file tree, switching to file-name results as the
//          user types) alongside the shared file viewer.
// Layer: Chat right-dock UI
// Exports: DockExplorerPane

import { useEffect, useState } from "react";

import type { ThreadId } from "@synara/contracts";

import { directoryChain, useExplorerRevealRequestStore } from "~/explorerRevealRequestStore";
import type { ChatFileReference } from "~/lib/chatReferences";
import type { FileCommentSelection } from "~/lib/fileComments";
import { WorkspaceFilePreview } from "../WorkspaceFilePreview";
import { PanelStateMessage } from "./PanelStateMessage";
import { WorkspaceExplorerSidebar } from "./workspaceExplorer";

// The dock lays out as a fixed horizontal row, so the shared sidebar takes a
// full-height fixed-width column (the editor's responsive default would collapse
// to a stacked block here). With the activity rail gone, the search box sits at
// the top of this column and the freed width goes to the file viewer.
const DOCK_EXPLORER_SIDEBAR_CLASS =
  "flex h-full min-h-0 w-60 shrink-0 flex-col border-r border-border/65 bg-[var(--color-background-surface)]";

export const DockExplorerPane = function DockExplorerPane(props: {
  threadId: ThreadId;
  workspaceRoot: string | null;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
  onCommentInChat?: ((comment: FileCommentSelection) => void) | undefined;
}) {
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [searchQuery, setSearchQuery] = useState("");

  // Reveal requests (e.g. picking a folder in the Cmd+P palette) expand the
  // full ancestor chain and clear any name filter so the tree is what shows.
  const revealRequest = useExplorerRevealRequestStore(
    (state) => state.requestsByThreadId[props.threadId],
  );
  useEffect(() => {
    if (!revealRequest) return;
    setExpandedDirectories((current) => {
      const next = new Set(current);
      for (const directory of directoryChain(revealRequest.path)) {
        next.add(directory);
      }
      return next;
    });
    setSearchQuery("");
  }, [revealRequest]);

  const handleSelectFile = (path: string) => {
    setSelectedFilePath(path);
  };

  const handleToggleDirectory = (path: string) => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 w-full">
      <WorkspaceExplorerSidebar
        workspaceRoot={props.workspaceRoot}
        selectedFilePath={selectedFilePath}
        expandedDirectories={expandedDirectories}
        query={searchQuery}
        onQueryChange={setSearchQuery}
        containerClassName={DOCK_EXPLORER_SIDEBAR_CLASS}
        onSelectFile={handleSelectFile}
        onToggleDirectory={handleToggleDirectory}
        onReferenceInChat={props.onReferenceInChat}
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        <WorkspaceFilePreview
          workspaceRoot={props.workspaceRoot}
          filePath={selectedFilePath}
          editable
          emptyState={
            <PanelStateMessage density="compact" fill="flex">
              <p>Select a file from the tree to view it.</p>
            </PanelStateMessage>
          }
          onReferenceInChat={props.onReferenceInChat}
          onAskWhyInChat={props.onAskWhyInChat}
          onCommentInChat={props.onCommentInChat}
        />
      </div>
    </div>
  );
};
