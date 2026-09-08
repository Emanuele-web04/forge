import type { Root, RootContent, Text } from "mdast";

/** Obsidian links are vault-relative; ordinary Markdown links remain file-relative. */
export function remarkWikiLinks(options: { root?: string | undefined } = {}) {
  return (tree: Root) => {
    function walk(parent: { children: RootContent[] }) {
      parent.children = parent.children.flatMap((node): RootContent[] => {
        if (["link", "linkReference", "code", "inlineCode", "html"].includes(node.type))
          return [node];
        if (node.type !== "text") {
          if ("children" in node) walk(node as { children: RootContent[] });
          return [node];
        }
        const parts: RootContent[] = [];
        const pattern = /(?<!!)\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;
        let offset = 0;
        for (const match of node.value.matchAll(pattern)) {
          const target = match[1]?.trim();
          if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
          const [file, fragment] = target.split("#", 2);
          if (!file) continue;
          const path = /\.[^/]+$/.test(file) ? file : `${file}.md`;
          const url =
            path.startsWith("/") || !options.root
              ? path
              : `${options.root.replace(/\/$/, "")}/${path}`;
          if (match.index > offset)
            parts.push({ type: "text", value: node.value.slice(offset, match.index) });
          parts.push({
            type: "link",
            url: url + (fragment ? `#${fragment}` : ""),
            children: [{ type: "text", value: match[2]?.trim() || target } as Text],
          });
          offset = match.index + match[0].length;
        }
        if (!parts.length) return [node];
        if (offset < node.value.length)
          parts.push({ type: "text", value: node.value.slice(offset) });
        return parts;
      });
    }
    walk(tree);
  };
}
