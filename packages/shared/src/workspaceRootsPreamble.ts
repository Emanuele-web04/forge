import type { RootBinding } from "./threadRoots";

export function buildWorkspaceRootsPreamble(roots: ReadonlyArray<RootBinding>): string | null {
  if (roots.length <= 1) return null;
  const lines = roots.map((root, index) => {
    const role = index === 0 ? "primary, your working directory" : "additional";
    const isolation = root.isIsolated
      ? ", isolated worktree"
      : index === 0
        ? ""
        : ", live checkout";
    return `- ${root.label}: ${root.effectivePath} (${role}${isolation})`;
  });
  return [
    "This project spans several source folders. You have direct access to all of them:",
    ...lines,
    "Use absolute paths when working outside the primary folder.",
  ].join("\n");
}
