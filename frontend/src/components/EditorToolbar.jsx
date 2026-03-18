function EditorToolbar({ onFormat }) {
  const buttons = [
    { label: 'B', title: 'Bold', action: 'bold' },
    { label: 'I', title: 'Italic', action: 'italic' },
    { label: 'S', title: 'Strikethrough', action: 'strike' },
    { label: 'H1', title: 'Heading 1', action: 'h1' },
    { label: 'H2', title: 'Heading 2', action: 'h2' },
    { label: 'H3', title: 'Heading 3', action: 'h3' },
    { label: '""', title: 'Quote', action: 'quote' },
    { label: '<>', title: 'Code', action: 'code' },
    { label: '```', title: 'Code block', action: 'codeblock' },
    { label: '\u2022', title: 'Bullet list', action: 'ul' },
    { label: '1.', title: 'Numbered list', action: 'ol' },
    { label: '\u2610', title: 'Task', action: 'task' },
    { label: '\u2014', title: 'Horizontal rule', action: 'hr' },
    { label: '\uD83D\uDD17', title: 'Link', action: 'link' },
    { label: '\uD83D\uDDBC', title: 'Image', action: 'image' },
    { label: '\u29EA', title: 'Mermaid diagram', action: 'mermaid' },
  ];

  return (
    <div className="editor-toolbar">
      {buttons.map((btn) => (
        <button
          key={btn.action}
          className="editor-toolbar-btn"
          title={btn.title}
          onMouseDown={(e) => {
            e.preventDefault(); // Don't steal focus from textarea
            onFormat(btn.action);
          }}
        >
          {btn.label}
        </button>
      ))}
    </div>
  );
}

export default EditorToolbar;
