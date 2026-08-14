// FILE: HtmlFilePreview.tsx
// Purpose: Sandboxed in-pane rendering of workspace HTML files so clicking a
//          `.html` / `.htm` file shows the page instead of source.
// Layer: Web chat/editor file-preview component
// Exports: HtmlFilePreview

export function HtmlFilePreview(props: { contents: string; title: string }) {
  return (
    <iframe
      className="editor-html-preview"
      title={props.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={props.contents}
    />
  );
}
